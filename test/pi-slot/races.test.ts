import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import type { Stats } from 'node:fs'
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { acquirePiLock } from '../../src/pi-slot/lock.js'
import { createPiSlot, PiSlotError } from '../../src/pi-slot/slot.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-slot-race-'))
  roots.push(root)
  const authPath = join(root, 'auth.json')
  const stashPath = join(root, 'private', 'stash.json')
  const options = {
    authPath,
    stashPath,
    provider: 'openai-codex',
    placeholderKey: 'pi-vault-disabled',
  }
  await writeFile(
    authPath,
    '{"openai-codex":{"type":"api_key","key":"original"}}',
    {
      mode: 0o600,
    },
  )
  return { authPath, stashPath, options, lockPath: `${authPath}.lock` }
}
async function age(path: string) {
  // Model a holder paused past the stale timeout without a wall-clock wait.
  const stale = new Date(Date.now() - 31_000)
  await utimes(path, stale, stale)
}
async function successor(authPath: string, lockPath: string) {
  await age(lockPath)
  // Distinguish successive mtimes even when the filesystem rounds to seconds.
  await sleep(1_010)
  const lease = await acquirePiLock(authPath, () => {})
  return lease
}

describe('pi slot races', () => {
  for (const replacement of ['symlink', 'file'] as const) {
    test(`refuses ${replacement} substituted after descriptor check`, async () => {
      const f = await fixture()
      await createPiSlot(f.options).enterVault()
      const auth = await readFile(f.authPath)
      const stash = await readFile(f.stashPath)
      for (const target of [f.authPath, f.stashPath]) {
        const saved = `${target}.saved`
        const slot = createPiSlot(f.options, undefined, {
          afterReadCheck: async (path) => {
            if (path !== target) return
            await rename(path, saved)
            if (replacement === 'symlink') await symlink(saved, path)
            else await writeFile(path, await readFile(saved), { mode: 0o600 })
          },
        })
        try {
          await expect(slot.exitVault()).rejects.toEqual(
            new PiSlotError('unsafe-path'),
          )
          expect(await readFile(f.authPath)).toEqual(auth)
          expect(await readFile(f.stashPath)).toEqual(stash)
        } finally {
          await rm(target)
          await rename(saved, target)
        }
      }
    })
  }

  test('paused release preserves successor directory and reports compromise', async () => {
    const f = await fixture()
    let compromised = 0
    const lease = await acquirePiLock(f.authPath, () => compromised++)
    const next = await successor(f.authPath, f.lockPath)
    const before = await stat(f.lockPath)
    try {
      await lease.release()
      expect(compromised).toBe(1)
      const after = await stat(f.lockPath)
      expect(after.ino).toBe(before.ino)
      expect(after.mtimeMs).toBe(before.mtimeMs)
      await lease.release()
      expect(compromised).toBe(1)
    } finally {
      await lease.release()
      await next.release()
    }
  })

  test('paused renewal preserves successor directory after compromise', async () => {
    const f = await fixture()
    let compromised = 0
    let renew: () => Promise<void> = async () => {
      throw new Error('Missing renew hook')
    }
    const lease = await acquirePiLock(
      f.authPath,
      () => compromised++,
      (resume) => {
        renew = resume
      },
    )
    const next = await successor(f.authPath, f.lockPath)
    const before = await stat(f.lockPath)
    try {
      await renew()
      const after = await stat(f.lockPath)
      expect(after.mtimeMs).toBe(before.mtimeMs)
      expect(after.ino).toBe(before.ino)
      expect(compromised).toBe(1)
      await renew()
      await lease.release()
      expect((await stat(f.lockPath)).mtimeMs).toBe(before.mtimeMs)
      expect(compromised).toBe(1)
    } finally {
      await lease.release()
      await next.release()
    }
  })
})

for (const target of ['auth', 'stash'] as const) {
  test(`pi slot races compromised lease refuses ${target} rename without changing files`, async () => {
    const f = await fixture()
    const original = await readFile(f.authPath)
    if (target === 'auth') {
      await createPiSlot(f.options).enterVault()
      await writeFile(f.authPath, original)
    }
    const stash = target === 'auth' ? await readFile(f.stashPath) : undefined
    let renew: () => Promise<void> = async () => {
      throw new Error('Missing renew hook')
    }
    let next: Awaited<ReturnType<typeof acquirePiLock>> | undefined
    let successorMtime = -1
    const slot = createPiSlot(f.options, undefined, {
      onRenew: (resume) => {
        renew = resume
      },
      beforeRename: async (path) => {
        expect(path).toBe(target === 'auth' ? f.authPath : f.stashPath)
        next = await successor(f.authPath, f.lockPath)
        successorMtime = (await stat(f.lockPath)).mtimeMs
        await renew()
      },
    })
    try {
      await expect(slot.enterVault()).rejects.toEqual(
        new PiSlotError('lock-compromised'),
      )
      expect(await readFile(f.authPath)).toEqual(original)
      if (stash) expect(await readFile(f.stashPath)).toEqual(stash)
      else
        await expect(stat(f.stashPath)).rejects.toMatchObject({
          code: 'ENOENT',
        })
      expect((await stat(f.lockPath)).mtimeMs).toBe(successorMtime)
    } finally {
      await next?.release()
    }
  })
}

test('pi slot races missing directory compromises release', async () => {
  const f = await fixture()
  let compromised = 0
  const lease = await acquirePiLock(f.authPath, () => compromised++)
  await rm(f.lockPath, { recursive: true })
  await lease.release()
  expect(compromised).toBe(1)
  await lease.release()
  expect(compromised).toBe(1)
})

for (const operation of ['release', 'renewal'] as const) {
  test(`pi slot races ${operation} refuses successor with colliding mtime`, async () => {
    const f = await fixture()
    let compromised = 0
    let renew: () => Promise<void> = async () => {
      throw new Error('Missing renew hook')
    }
    const lease = await acquirePiLock(
      f.authPath,
      () => compromised++,
      (resume) => {
        renew = resume
      },
    )
    const initial = await stat(f.lockPath)
    // Keep the old inode allocated so the filesystem cannot immediately reuse it.
    await rename(f.lockPath, `${f.lockPath}.superseded`)
    const next = await acquirePiLock(f.authPath, () => {})
    await utimes(f.lockPath, initial.mtime, initial.mtime)
    const before = await stat(f.lockPath)
    expect(before.ino).not.toBe(initial.ino)
    expect(before.mtime.getTime()).toBe(initial.mtime.getTime())
    try {
      if (operation === 'release') await lease.release()
      else await renew()
      expect(compromised).toBe(1)
      const after = await stat(f.lockPath)
      expect(after.ino).toBe(before.ino)
      expect(after.mtimeMs).toBe(before.mtimeMs)
      await renew()
      await lease.release()
      expect((await stat(f.lockPath)).ino).toBe(before.ino)
      expect(compromised).toBe(1)
    } finally {
      await lease.release()
      await next.release()
    }
  })
}

// Advance only the lease clock: no timers run during the simulated owner pause.
test('pi slot races expired release leaves matching directory untouched', async () => {
  const f = await fixture()
  let compromised = 0
  const lease = await acquirePiLock(f.authPath, () => compromised++)
  const before = await stat(f.lockPath)
  const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 10_001)
  try {
    await lease.release()
    expect(compromised).toBe(1)
    const after = await stat(f.lockPath)
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  } finally {
    clock.mockRestore()
  }
})

test('pi slot races expired exit cleanup leaves matching directory untouched', async () => {
  const f = await fixture()
  const lockModule = join(import.meta.dir, '../../src/pi-slot/lock.ts')
  // The child takes the lock, ages its lease past the 10s sync threshold
  // without renewing, and exits; its exit cleanup must not remove the lock.
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `const { acquirePiLock } = await import(${JSON.stringify(lockModule)});
       await acquirePiLock(${JSON.stringify(f.authPath)}, () => {});
       const real = Date.now();
       Date.now = () => real + 10_001;
       process.exit(0);`,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  expect(await child.exited).toBe(0)
  expect((await stat(f.lockPath)).isDirectory()).toBe(true)
})

test('pi slot races fresh exit cleanup removes its own directory', async () => {
  const f = await fixture()
  const lockModule = join(import.meta.dir, '../../src/pi-slot/lock.ts')
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `const { acquirePiLock } = await import(${JSON.stringify(lockModule)});
       await acquirePiLock(${JSON.stringify(f.authPath)}, () => {});
       process.exit(0);`,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  expect(await child.exited).toBe(0)
  await expect(stat(f.lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('pi slot races expired renewal leaves matching directory untouched', async () => {
  const f = await fixture()
  let compromised = 0
  let renew: () => Promise<void> = async () => {
    throw new Error('Missing renew hook')
  }
  const lease = await acquirePiLock(
    f.authPath,
    () => compromised++,
    (resume) => {
      renew = resume
    },
  )
  const before = await stat(f.lockPath)
  const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 10_001)
  try {
    await renew()
    expect(compromised).toBe(1)
    const after = await stat(f.lockPath)
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    await renew()
    expect(compromised).toBe(1)
  } finally {
    clock.mockRestore()
    await lease.release()
  }
})

for (const target of ['auth', 'stash'] as const) {
  test(`pi slot races expired lease refuses ${target} rename with matching directory`, async () => {
    const f = await fixture()
    const auth = await readFile(f.authPath)
    if (target === 'auth') {
      await createPiSlot(f.options).enterVault()
      await writeFile(f.authPath, auth)
    }
    const stash = target === 'auth' ? await readFile(f.stashPath) : undefined
    let before: Stats | undefined
    let clock: ReturnType<typeof spyOn<typeof Date, 'now'>> | undefined
    const slot = createPiSlot(f.options, undefined, {
      beforeRename: async (path) => {
        if (path !== (target === 'auth' ? f.authPath : f.stashPath)) return
        before = await stat(f.lockPath)
        clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 10_001)
      },
    })
    try {
      await expect(slot.enterVault()).rejects.toEqual(
        new PiSlotError('lock-compromised'),
      )
      expect(await readFile(f.authPath)).toEqual(auth)
      if (stash) expect(await readFile(f.stashPath)).toEqual(stash)
      else
        await expect(stat(f.stashPath)).rejects.toMatchObject({
          code: 'ENOENT',
        })
      if (!before) throw new Error('Missing paused lock snapshot')
      const after = await stat(f.lockPath)
      expect(after.ino).toBe(before.ino)
      expect(after.mtimeMs).toBe(before.mtimeMs)
    } finally {
      clock?.mockRestore()
    }
  })
}
