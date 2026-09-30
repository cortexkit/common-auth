import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import {
  LockContentionError,
  LockOwnershipError,
  lockPathFor,
  WRITER_LOCK_CONSTANTS,
  withLock,
} from '../../src/fs/index.js'
import {
  acquireRefreshFileLock,
  isLostMarkerRaceError,
} from '../../src/fs/refresh-file-lock.js'
import { makeTempDir } from '../fixtures/scratch.js'

let dir: string
let target: string
const name = 'preferences'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
beforeEach(async () => {
  dir = await makeTempDir()
  target = join(dir, 'state.json')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

test('lock paths and frozen writer constants preserve writer defaults', () => {
  expect(lockPathFor(target, name)).toBe(`${target}.preferences.lock`)
  expect(WRITER_LOCK_CONSTANTS).toEqual({
    sidebar: {
      name: 'sidebar-write',
      ttlMs: 10000,
      timeoutMs: 15000,
      renew: true,
    },
    preferences: { name, ttlMs: 10000, timeoutMs: 2000, renew: true },
  })
  expect(Object.isFrozen(WRITER_LOCK_CONSTANTS)).toBe(true)
  expect(Object.isFrozen(WRITER_LOCK_CONSTANTS.sidebar)).toBe(true)
  expect(Object.isFrozen(WRITER_LOCK_CONSTANTS.preferences)).toBe(true)
})

test('classifies ENOENT EINVAL and ENOTDIR as lost marker races', () => {
  for (const code of ['ENOENT', 'EINVAL', 'ENOTDIR'])
    expect(isLostMarkerRaceError({ code })).toBe(true)
  expect(isLostMarkerRaceError({ code: 'EPERM' })).toBe(false)
})

test('acquisition writes private newline-terminated owner bytes', async () => {
  const lock = await acquireRefreshFileLock({
    path: target,
    name,
    ttlMs: 10000,
    now: () => 100,
  })
  try {
    const bytes = await fs.readFile(lockPathFor(target, name), 'utf8')
    const owner = JSON.parse(bytes)
    expect(Object.keys(owner)).toEqual(['ownerId', 'expiresAt'])
    expect(typeof owner.ownerId).toBe('string')
    expect(owner.expiresAt).toBe(10100)
    expect(bytes).toBe(`${JSON.stringify(owner)}\n`)
    expect((await fs.stat(lockPathFor(target, name))).mode & 0o777).toBe(0o600)
  } finally {
    await lock?.release()
  }
})

test('eviction marker has a private distinct evicter identity', async () => {
  const path = lockPathFor(target, name)
  const ownerId = 'expired-holder'
  await fs.writeFile(path, JSON.stringify({ ownerId, expiresAt: 0 }))
  let observed = false
  const lock = await acquireRefreshFileLock({
    path: target,
    name,
    ttlMs: 10000,
    onStep: async (step) => {
      if (step !== 'eviction-marker-acquired') return
      observed = true
      expect((await fs.stat(`${path}.evicting`)).isDirectory()).toBe(true)
      const markerPath = join(`${path}.evicting`, 'owner.json')
      const bytes = await fs.readFile(markerPath, 'utf8')
      const marker = JSON.parse(bytes)
      expect(Object.keys(marker)).toEqual(['ownerId', 'createdAt'])
      expect(typeof marker.ownerId).toBe('string')
      expect(marker.ownerId).not.toBe(ownerId)
      expect(Number.isFinite(marker.createdAt)).toBe(true)
      expect(bytes).toBe(`${JSON.stringify(marker)}\n`)
      expect((await fs.stat(markerPath)).mode & 0o777).toBe(0o600)
    },
  })
  try {
    expect(observed).toBe(true)
    expect(lock).not.toBeNull()
  } finally {
    await lock?.release()
  }
})

test('reads expired legacy owner.json despite a fresh directory mtime', async () => {
  const path = lockPathFor(target, name)
  await fs.mkdir(path)
  await fs.writeFile(
    join(path, 'owner.json'),
    JSON.stringify({ ownerId: 'legacy', expiresAt: 0 }),
  )
  let ran = false
  await withLock(target, { name, ttlMs: 10000, timeoutMs: 50 }, async () => {
    ran = true
  })
  expect(ran).toBe(true)
})

for (const newline of [true, false]) {
  test(
    newline
      ? 'contention waits and reports lock identity'
      : 'newline-free live payload beats backdated mtime',
    async () => {
      const timeoutMs = 50
      const path = lockPathFor(target, name)
      await fs.writeFile(
        path,
        JSON.stringify({
          ownerId: 'live',
          expiresAt: Date.now() + timeoutMs + 6000,
        }) + (newline ? '\n' : ''),
      )
      if (!newline) await fs.utimes(path, new Date(0), new Date(0))
      let ran = false
      const start = performance.now()
      let caught: unknown
      try {
        await withLock(target, { name, ttlMs: 3000, timeoutMs }, async () => {
          ran = true
        })
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(LockContentionError)
      expect((caught as LockContentionError).name).toBe('LockContentionError')
      expect((caught as LockContentionError).details).toEqual({
        target,
        name,
        timeoutMs,
      })
      expect(performance.now() - start).toBeGreaterThanOrEqual(timeoutMs)
      expect(performance.now() - start).toBeLessThan(timeoutMs + 5000)
      expect(ran).toBe(false)
    },
  )
}

for (const rejects of [false, true]) {
  test(
    rejects
      ? 'withLock releases and stops renewal after rejection'
      : 'withLock releases and stops renewal after fulfilment',
    async () => {
      const options = { name, ttlMs: 3000, timeoutMs: 50, renew: true }
      const ordinary = new Error('ordinary')
      try {
        await withLock(target, options, async () => {
          if (rejects) throw ordinary
        })
      } catch (error) {
        expect(error).toBe(ordinary)
      }
      let ran = false
      await withLock(target, options, async () => {
        ran = true
      })
      expect(ran).toBe(true)
      await sleep(1100)
      expect(
        await fs.access(lockPathFor(target, name)).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
    },
  )
}

test('withLock defaults to no renewal', async () => {
  await withLock(target, { name, ttlMs: 3000, timeoutMs: 50 }, async () => {
    const before = await fs.readFile(lockPathFor(target, name), 'utf8')
    await sleep(1500)
    expect(await fs.readFile(lockPathFor(target, name), 'utf8')).toBe(before)
  })
})

for (const invalidation of ['foreign', 'expired', 'unreadable']) {
  test(`assertOwned rejects ${invalidation} ownership`, async () => {
    const lock = await acquireRefreshFileLock({
      path: target,
      name,
      ttlMs: 10000,
    })
    expect(lock).not.toBeNull()
    const path = lockPathFor(target, name)
    const owner = JSON.parse(await fs.readFile(path, 'utf8'))
    if (invalidation === 'unreadable') await fs.rm(path)
    else
      await fs.writeFile(
        path,
        JSON.stringify({
          ownerId: invalidation === 'foreign' ? 'foreign' : owner.ownerId,
          expiresAt: invalidation === 'expired' ? 0 : Date.now() + 10000,
        }),
      )
    try {
      let caught: unknown
      try {
        await lock!.assertOwned()
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(LockOwnershipError)
      expect((caught as LockOwnershipError).details).toEqual({ target, name })
    } finally {
      await lock?.release()
    }
  })
}

test('renewal stages private owner bytes and atomically renames while assertOwned remains valid', async () => {
  const path = lockPathFor(target, name)
  const lock = await acquireRefreshFileLock({
    path: target,
    name,
    ttlMs: 10000,
    renew: true,
    renewIntervalMs: 100,
  })
  const before = JSON.parse(await fs.readFile(path, 'utf8'))
  const originalWrite = fs.writeFile
  const originalRename = fs.rename
  let writes = 0
  let renames = 0
  let observedError: unknown
  let finish!: () => void
  const observed = new Promise<void>((resolve) => {
    finish = resolve
  })
  const writeSpy = spyOn(fs, 'writeFile').mockImplementation(
    async (...args: Parameters<typeof fs.writeFile>) => {
      if (
        String(args[0]).startsWith(`${path}.`) &&
        String(args[0]).endsWith('.tmp')
      ) {
        writes++
        try {
          await lock!.assertOwned()
        } catch (error) {
          observedError = error
        }
        expect(args[2]).toMatchObject({ mode: 0o600 })
      }
      return originalWrite(...args)
    },
  )
  const renameSpy = spyOn(fs, 'rename').mockImplementation(
    async (...args: Parameters<typeof fs.rename>) => {
      if (String(args[1]) === path) {
        renames++
        expect(String(args[0])).not.toBe(path)
        await originalRename(...args)
        finish()
        return
      }
      return originalRename(...args)
    },
  )
  try {
    await Promise.race([observed, sleep(1000)])
    expect(writes).toBeGreaterThan(0)
    expect(renames).toBeGreaterThan(0)
    expect(observedError).toBeUndefined()
    const bytes = await fs.readFile(path, 'utf8')
    const after = JSON.parse(bytes)
    expect(after.ownerId).toBe(before.ownerId)
    expect(after.expiresAt).toBeGreaterThan(before.expiresAt)
    expect(bytes).toBe(`${JSON.stringify(after)}\n`)
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600)
    await lock!.assertOwned()
  } finally {
    writeSpy.mockRestore()
    renameSpy.mockRestore()
    await lock?.release()
  }
})
