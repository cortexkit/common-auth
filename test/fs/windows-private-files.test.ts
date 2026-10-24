import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as api from '@cortexkit/private-files'
import {
  PrivateFileError,
  replaceWindowsFile,
  setPrivateFilesBackendForTest,
  verifyPrivate,
  writePrivateAtomic,
} from '../../src/fs/private-files.js'

let root: string
beforeEach(async () => {
  if (process.platform === 'win32') {
    root = join(
      process.env.LOCALAPPDATA ?? tmpdir(),
      `common-private-${randomUUID()}`,
    )
    await api.createOwnerOnly(root, { kind: 'dir' })
  } else root = await mkdtemp(join(tmpdir(), 'common-private-'))
  setPrivateFilesBackendForTest(api)
})
afterEach(async () => {
  setPrivateFilesBackendForTest()
  await rm(root, { recursive: true, force: true })
})
const io = (code: string, win32Code?: number) =>
  Object.assign(new Error(code), {
    code,
    ...(win32Code === undefined ? {} : { win32Code }),
  })

describe('Windows private IO logic', () => {
  test('refusal predicates prevent writes and name path and stage', async () => {
    let writes = 0
    for (const reason of [
      api.WRONG_OWNER,
      api.REPARSE_POINT,
      api.UNSUPPORTED_FILESYSTEM,
      'unsafe-ancestor',
      api.EXTRA_ACE,
      api.NULL_DACL,
      api.EMPTY_DACL,
      api.NOT_PROTECTED,
    ] as const) {
      setPrivateFilesBackendForTest({
        ...api,
        createPrivateFile: async () => {
          writes++
        },
        verifyPrivatePath: async () => {},
        verifyOwnerOnly: async () => ({
          ok: false,
          refusal: {
            reason,
            message: 'refused',
            ownerSid: 'foreign',
            sid: 'foreign',
            mask: 1,
          },
        }),
      })
      const path = join(root, 'state.json')
      try {
        await verifyPrivate(path, 'file')
        await writePrivateAtomic(path, 'DO-NOT-WRITE')
        throw new Error('verification did not refuse')
      } catch (error) {
        expect(error).toBeInstanceOf(PrivateFileError)
        expect((error as PrivateFileError).path).toBe(path)
        expect((error as PrivateFileError).stage).toBe('verify')
        expect((error as Error).message).not.toContain('DO-NOT-WRITE')
      }
    }
    expect(writes).toBe(0)
  })

  test('migration is explicit and verifies after permission replacement', async () => {
    const calls: string[] = []
    setPrivateFilesBackendForTest({
      ...api,
      verifyOwnerOnly: async () => ({
        ok: false,
        refusal: { reason: api.NOT_PROTECTED, message: 'legacy' },
      }),
      securePrivatePath: async () => {
        calls.push('secure')
      },
      verifyPrivatePath: async () => {
        calls.push('verify-handle')
      },
    })
    const path = join(root, 'legacy.json')
    await expect(verifyPrivate(path, 'file')).rejects.toBeInstanceOf(
      PrivateFileError,
    )
    expect(calls).toEqual([])
    await verifyPrivate(path, 'file', true)
    expect(calls).toEqual(['secure', 'verify-handle'])
  })

  test('foreign ownership and reparse points are never migrated', async () => {
    let repairs = 0
    for (const reason of [
      api.WRONG_OWNER,
      api.REPARSE_POINT,
      'unsafe-ancestor',
      api.UNSUPPORTED_FILESYSTEM,
    ] as const) {
      setPrivateFilesBackendForTest({
        ...api,
        verifyOwnerOnly: async () => ({
          ok: false,
          refusal: { reason, ownerSid: 'other', message: 'refused' },
        }),
        securePrivatePath: async () => {
          repairs++
        },
      })
      await expect(
        verifyPrivate(join(root, 'legacy.json'), 'file', true),
      ).rejects.toBeInstanceOf(PrivateFileError)
    }
    expect(repairs).toBe(0)
  })

  test('in-place securing refuses writable parents before backend repair', async () => {
    const path = join(root, 'legacy.json')
    let repairs = 0
    setPrivateFilesBackendForTest({
      ...api,
      verifyOwnerOnly: async () => ({
        ok: false,
        refusal: { reason: api.NOT_PROTECTED, message: 'inherited ACL' },
      }),
      verifySafeParent: async (parent) => ({
        ok: false,
        reason: api.WRITABLE_BY_OTHERS,
        path: parent,
        level: parent,
      }),
      securePrivatePath: async () => {
        repairs++
      },
      verifyPrivatePath: async () => {},
    })
    await expect(verifyPrivate(path, 'file', true)).rejects.toMatchObject({
      reason: 'writable-by-others',
      path: root,
      stage: 'safe-parent',
    })
    expect(repairs).toBe(0)
  })

  test('safe existing parents do not require owner-only permissions or repair', async () => {
    let repairs = 0
    setPrivateFilesBackendForTest({
      ...api,
      verifySafeParent: async () => ({ ok: true }),
      verifyOwnerOnly: async () => ({
        ok: false,
        refusal: { reason: api.EXTRA_ACE, sid: 'SYSTEM', mask: 0x1f01ff },
      }),
      securePrivatePath: async () => {
        repairs++
      },
    })
    await verifyPrivate(root, 'directory', true)
    expect(repairs).toBe(0)
  })

  test('retry uses six attempts and preserves original rename failure', async () => {
    let time = 0
    let attempts = 0
    let fences = 0
    const sleeps: number[] = []
    const original = io('EBUSY')
    const path = join(root, 'target')
    try {
      await replaceWindowsFile('stage', path, {
        now: () => time,
        sleep: async (ms) => {
          sleeps.push(ms)
          time += ms
        },
        beforeRename: async () => {
          fences++
        },
        rename: async () => {
          attempts++
          throw attempts === 1 ? original : io('EPERM')
        },
      })
      throw new Error('retry did not refuse')
    } catch (error) {
      expect((error as PrivateFileError).cause).toBe(original)
      expect((error as PrivateFileError).published).toBe(false)
      expect((error as PrivateFileError).attempts).toBe(6)
      expect((error as PrivateFileError).elapsedMs).toBe(250)
    }
    expect(sleeps).toEqual([10, 20, 40, 80, 100])
    expect(attempts).toBe(6)
    expect(fences).toBe(6)
  })

  test('slow ownership checks do not prevent the first rename attempt', async () => {
    let time = 0
    let attempts = 0
    const sleeps: number[] = []
    const result = await replaceWindowsFile('stage', 'target', {
      now: () => time,
      sleep: async (ms) => {
        sleeps.push(ms)
        time += ms
      },
      beforeRename: async () => {
        time += 600
      },
      rename: async () => {
        attempts++
      },
    })
    expect(attempts).toBe(1)
    expect(sleeps).toEqual([])
    expect(result).toEqual({ attempts: 1, elapsedMs: 600 })
  })

  test('retry budget starts at the first failed rename and excludes ownership checks', async () => {
    let time = 0
    const attemptTimes: number[] = []
    const sleeps: number[] = []
    const original = io('EBUSY', 32)
    await expect(
      replaceWindowsFile('stage', 'target', {
        now: () => time,
        sleep: async (ms) => {
          sleeps.push(ms)
          time += ms
        },
        beforeRename: async () => {
          time += 600
        },
        rename: async () => {
          attemptTimes.push(time)
          time +=
            attemptTimes.length === 1
              ? 200
              : attemptTimes.length === 2
                ? 450
                : 0
          throw original
        },
      }),
    ).rejects.toMatchObject({
      cause: original,
      code: 'EBUSY',
      attempts: 3,
      elapsedMs: 2500,
    })
    expect(attemptTimes).toEqual([600, 1410, 2480])
    expect(sleeps).toEqual([10, 20, 20])
  })

  test('lease expiry stops before ownership checks and after a slow check', async () => {
    for (const initialTime of [100, 0]) {
      let time = initialTime
      let fences = 0
      let attempts = 0
      await expect(
        replaceWindowsFile('stage', 'target', {
          now: () => time,
          deadline: 100,
          beforeRename: async () => {
            fences++
            time = 100
          },
          rename: async () => {
            attempts++
          },
        }),
      ).rejects.toMatchObject({ code: 'ETIMEDOUT', attempts: 0 })
      expect(attempts).toBe(0)
      expect(fences).toBe(initialTime === 100 ? 0 : 1)
    }
  })

  test('elapsed deadline includes IO and lease cap prevents a new attempt', async () => {
    for (const deadline of [500, 45]) {
      let time = 0
      let attempts = 0
      await expect(
        replaceWindowsFile('stage', 'target', {
          now: () => time,
          deadline,
          sleep: async (ms) => {
            time += ms
          },
          rename: async () => {
            attempts++
            time += 600
            throw io('EBUSY')
          },
        }),
      ).rejects.toBeInstanceOf(PrivateFileError)
      expect(attempts).toBe(1)
    }
  })

  test('native ACL errors and nonsharing codes are terminal', async () => {
    for (const error of [
      io('EPERM', 5),
      io('EACCES', 740),
      io('ENOENT'),
      Object.assign(io('EPERM'), { reason: api.EXTRA_ACE }),
    ]) {
      let attempts = 0
      await expect(
        replaceWindowsFile('stage', 'target', {
          rename: async () => {
            attempts++
            throw error
          },
        }),
      ).rejects.toMatchObject({ cause: error, attempts: 1 })
      expect(attempts).toBe(1)
    }
  })

  test('fencing reruns before retry and stops publication', async () => {
    let fences = 0
    let attempts = 0
    const lost = new Error('lease expired')
    await expect(
      replaceWindowsFile('stage', 'target', {
        beforeRename: async () => {
          if (++fences === 2) throw lost
        },
        rename: async () => {
          attempts++
          throw io('EBUSY')
        },
        sleep: async () => {},
      }),
    ).rejects.toBe(lost)
    expect(attempts).toBe(1)
  })

  test('failure before publication keeps old bytes and cleans only its own stage', async () => {
    const path = join(root, 'state')
    await writeFile(path, 'old', { mode: 0o600 })
    await expect(
      writePrivateAtomic(path, 'new', {
        beforeRename: async () => {
          throw io('EACCES')
        },
      }),
    ).rejects.toMatchObject({ published: false })
    expect(await readFile(path, 'utf8')).toBe('old')
    expect(await readdir(root)).toEqual(['state'])
    const stage = join(root, 'collision')
    await writeFile(stage, 'not ours', { mode: 0o600 })
    await expect(
      writePrivateAtomic(path, 'new', { stagePath: stage }),
    ).rejects.toMatchObject({ code: 'EEXIST', published: false })
    expect(await readFile(stage, 'utf8')).toBe('not ours')
  })

  test('file-only opt-in reports file durability not directory durability', async () => {
    const outcomes: unknown[] = []
    await writePrivateAtomic(join(root, 'state'), 'new', {
      durable: true,
      durability: 'file-only-on-windows',
      onOutcome: (outcome) => outcomes.push(outcome),
    })
    expect(outcomes).toEqual([
      expect.objectContaining({
        published: true,
        fileDurable: true,
        durabilityConfirmed: false,
        stage: 'published',
        attempts: 1,
        elapsedMs: expect.any(Number),
      }),
    ])
  })

  test('durable without opt-in refuses after publication exactly once', async () => {
    let callbacks = 0
    const path = join(root, 'state')
    await expect(
      writePrivateAtomic(path, 'new', {
        durable: true,
        onRenamed: () => {
          callbacks++
        },
      }),
    ).rejects.toMatchObject({
      published: true,
      fileDurable: true,
      durabilityConfirmed: false,
      stage: 'directory-sync-unsupported',
    })
    expect(await readFile(path, 'utf8')).toBe('new')
    expect(callbacks).toBe(1)
  })

  test('postpublication verify refusal never reports not published', async () => {
    const path = join(root, 'state')
    let published = false
    setPrivateFilesBackendForTest({
      ...api,
      verifyPrivatePath: async (p, kind) => {
        if (p === path && published) throw io('EACCES')
        return api.verifyPrivatePath(p, kind)
      },
    })
    await expect(
      writePrivateAtomic(path, 'new', {
        onRenamed: () => {
          published = true
        },
      }),
    ).rejects.toMatchObject({ published: true, stage: 'verify' })
    expect(await readFile(path, 'utf8')).toBe('new')
  })
})

for (const mode of ['acquire', 'release', 'renew'] as const) {
  test(`Windows lease ${mode} does not convert access or sharing errors into success`, async () => {
    for (const errno of ['EBUSY', 'EPERM', 'EACCES']) {
      const child = Bun.spawn(
        [process.execPath, 'test/fs/windows-lease-probe.mjs', mode, errno],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(stderr).toBe('')
      expect(exit).toBe(0)
      expect(JSON.parse(stdout)).toEqual({ mode, errno, checked: true })
    }
  })
}

test('Windows lease retries when the contention owner read finds a vanished lock', async () => {
  const child = Bun.spawn(
    [process.execPath, 'test/fs/windows-lease-probe.mjs', 'vanishing-acquire'],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exit !== 0)
    throw new Error(`vanished contention lock must be retried\n${stderr}`)
  expect(stderr).toBe('')
  expect(JSON.parse(stdout)).toEqual({
    mode: 'vanishing-acquire',
    errno: 'EBUSY',
    checked: true,
  })
})

test('Windows contention owner reads still refuse access sharing and wrong ownership', async () => {
  for (const errno of ['EACCES', 'EBUSY', 'wrong-owner']) {
    const child = Bun.spawn(
      [
        process.execPath,
        'test/fs/windows-lease-probe.mjs',
        'contention-refusal',
        errno,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(stderr).toBe('')
    expect(exit).toBe(0)
    expect(JSON.parse(stdout)).toEqual({
      mode: 'contention-refusal',
      errno,
      checked: true,
    })
  }
})

for (const state of ['missing', 'replaced']) {
  for (const operation of ['assert', 'renew']) {
    test(`Windows lease ${operation} reports lost ownership for a ${state} lock while release stays idempotent`, async () => {
      const mode = `${state}-${operation}`
      const child = Bun.spawn(
        [process.execPath, 'test/fs/windows-lease-probe.mjs', mode],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(stderr).toBe('')
      expect(exit).toBe(0)
      expect(JSON.parse(stdout)).toEqual({
        mode,
        errno: 'EBUSY',
        checked: true,
      })
    })
  }
}

test('Windows atomic stage stays in the verified destination directory', async () => {
  let writes = 0
  setPrivateFilesBackendForTest({
    ...api,
    createPrivateFile: async () => {
      writes++
    },
  })
  await expect(
    writePrivateAtomic(join(root, 'state'), 'secret fixture', {
      stagePath: join(root, 'other', 'stage'),
    }),
  ).rejects.toMatchObject({
    code: 'EXDEV',
    stage: 'stage-directory',
    published: false,
  })
  expect(writes).toBe(0)
})
