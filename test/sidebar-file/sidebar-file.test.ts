import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import {
  LockContentionError,
  LockOwnershipError,
  lockPathFor,
} from '../../src/fs/index.js'
import { createSidebarFile } from '../../src/sidebar-file/index.js'
import { makeTempDir } from '../fixtures/scratch.js'

let dir: string
let target: string
beforeEach(async () => {
  dir = await makeTempDir()
  target = join(dir, 'state.json')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})
const writer = (timeoutMs?: number) =>
  createSidebarFile({
    path: target,
    defaultValue: 0,
    normalize: (value) => {
      if (typeof value !== 'number') throw new Error('not a number')
      return value
    },
    timeoutMs,
  })
const lockPath = () => lockPathFor(target, 'sidebar-write')
const payload = async () =>
  JSON.parse(await fs.readFile(lockPath(), 'utf8')) as {
    ownerId: string
    expiresAt: number
  }

test('tolerant reads hand parsed JSON to the supplied normalizer', async () => {
  const seen: unknown[] = []
  const file = createSidebarFile({
    path: target,
    defaultValue: 'default',
    normalize: (value) => {
      seen.push(value)
      if (value === null) throw new Error('invalid')
      return 'normalized'
    },
  })
  expect(await file.read()).toBe('default')
  await fs.writeFile(target, '{broken')
  expect(await file.read()).toBe('default')
  await fs.writeFile(target, 'null')
  expect(await file.read()).toBe('default')
  await fs.writeFile(target, '{"opaque":true}')
  expect(await file.read()).toBe('normalized')
  expect(seen).toEqual([null, { opaque: true }])
})

test('writes state atomically and cleans up temp files', async () => {
  const value = { nested: { answer: 42 } }
  const file = createSidebarFile({
    path: target,
    defaultValue: {},
    normalize: (value) => value,
  })
  await file.write(value)
  const bytes = await fs.readFile(target, 'utf8')
  expect(bytes).toBe('{"nested":{"answer":42}}')
  expect(JSON.parse(bytes)).toEqual(value)
  expect((await fs.stat(target)).mode & 0o777).toBe(0o600)
  expect(await fs.readdir(dir)).toEqual(['state.json'])
})

test('5 concurrent writes with different lastUpdated values — last-chained state wins', async () => {
  const file = createSidebarFile({
    path: target,
    defaultValue: {},
    normalize: (value) => value,
  })
  await Promise.all(
    Array.from({ length: 5 }, (_, lastUpdated) => file.write({ lastUpdated })),
  )
  expect(JSON.parse(await fs.readFile(target, 'utf8'))).toEqual({
    lastUpdated: 4,
  })
})

test('rejects the failed operation but keeps the write queue usable', async () => {
  const file = writer()
  const failure = new Error('failed commit')
  const first = file.write(1, {
    beforeCommit: async () => {
      throw failure
    },
  })
  const second = file.write(2)
  await expect(first).rejects.toBe(failure)
  await second
  expect(await file.read()).toBe(2)
})

test('merge rechecks new bytes and never writes the first result', async () => {
  const seen: number[] = []
  const commits: string[] = []
  await fs.writeFile(target, '1')
  await writer().update(
    (latest) => {
      seen.push(latest)
      return latest + 10
    },
    {
      beforeRecheck: async () => {
        await fs.writeFile(target, '2')
      },
      beforeCommit: async () => {
        expect(await fs.readFile(target, 'utf8')).toBe('2')
        const staging = (await fs.readdir(dir)).find((name) =>
          name.endsWith('.tmp'),
        )!
        commits.push(await fs.readFile(join(dir, staging), 'utf8'))
      },
    },
  )
  expect(seen).toEqual([1, 2])
  expect(commits).toEqual(['12'])
  expect(await fs.readFile(target, 'utf8')).toBe('12')
})

test('merge retries three times then performs one final merge and write', async () => {
  await fs.writeFile(target, '1')
  const original = fs.readFile
  let reads = 0
  const spy = spyOn(fs, 'readFile').mockImplementation((async (
    ...args: Parameters<typeof fs.readFile>
  ) => {
    if (args[0] === target) {
      reads += 1
      if (reads <= 7) return String(reads)
    }
    return original(...args)
  }) as typeof fs.readFile)
  const seen: number[] = []
  try {
    await writer().update((latest) => {
      seen.push(latest)
      return latest + 10
    })
  } finally {
    spy.mockRestore()
  }
  expect(seen).toEqual([1, 3, 5, 7])
  expect(await fs.readFile(target, 'utf8')).toBe('17')
})

test('undefined merge skips the write', async () => {
  await fs.writeFile(target, '1')
  await writer().update(() => undefined)
  expect(await fs.readFile(target, 'utf8')).toBe('1')
})

test('supplied parent is hardened from 0755 to 0700', async () => {
  await fs.chmod(dir, 0o755)
  await writer().write(1)
  expect((await fs.stat(dir)).mode & 0o777).toBe(0o700)
})

test('secureDir false leaves a user-chosen parent at its own mode', async () => {
  await fs.chmod(dir, 0o755)
  const file = createSidebarFile({
    path: target,
    defaultValue: 0,
    normalize: Number,
    secureDir: false,
  })
  await file.write(1)
  expect((await fs.stat(dir)).mode & 0o777).toBe(0o755)
  expect(await fs.readFile(target, 'utf8')).toBe('1')
})

test('secureDir false still creates a missing parent private', async () => {
  const nested = join(dir, 'chosen', 'state.json')
  const file = createSidebarFile({
    path: nested,
    defaultValue: 0,
    normalize: Number,
    secureDir: false,
  })
  await file.write(1)
  expect((await fs.stat(join(dir, 'chosen'))).mode & 0o777).toBe(0o700)
})

test('EPERM chmod warns once and still resolves the queued write', async () => {
  const warnings: unknown[] = []
  const file = createSidebarFile({
    path: target,
    defaultValue: 0,
    normalize: Number,
    logger: {
      warn: (message, data) => {
        warnings.push({ message, data })
      },
      debug: () => {},
    },
  })
  const spy = spyOn(fs, 'chmod').mockRejectedValue(
    Object.assign(new Error('denied'), { code: 'EPERM' }),
  )
  try {
    await file.write(42)
  } finally {
    spy.mockRestore()
  }
  expect(await fs.readFile(target, 'utf8')).toBe('42')
  expect(warnings).toEqual([
    {
      message: 'sidebar directory permission remediation failed',
      data: { error: 'denied' },
    },
  ])
})

test('sidebar lock TTL is observed before commit', async () => {
  let called = false
  await writer().write(1, {
    beforeCommit: async () => {
      called = true
      expect(
        Math.abs((await payload()).expiresAt - (Date.now() + 10000)),
      ).toBeLessThan(1000)
    },
  })
  expect(called).toBe(true)
})

test('sidebar lock renews with unchanged owner and private mode', async () => {
  await writer().write(1, {
    beforeCommit: async () => {
      const first = await payload()
      await Bun.sleep(5000)
      const second = await payload()
      expect(second.expiresAt - first.expiresAt).toBeGreaterThanOrEqual(3000)
      expect(second.ownerId).toBe(first.ownerId)
      expect((await fs.stat(lockPath())).mode & 0o777).toBe(0o600)
    },
  })
}, 15000)

test('lost ownership before commit rejects the queue and leaves target and staging unchanged', async () => {
  await fs.writeFile(target, '1')
  await expect(
    writer().write(2, {
      beforeCommit: async () => {
        expect(
          (await fs.readdir(dir)).filter((name) => name.endsWith('.tmp')),
        ).toHaveLength(1)
        await fs.writeFile(
          lockPath(),
          JSON.stringify({ ownerId: 'foreign', expiresAt: Date.now() + 30000 }),
        )
      },
    }),
  ).rejects.toBeInstanceOf(LockOwnershipError)
  expect(await fs.readFile(target, 'utf8')).toBe('1')
  expect(
    (await fs.readdir(dir)).filter((name) => name.endsWith('.tmp')),
  ).toEqual([])
})

for (const timeoutMs of [50, undefined]) {
  test(timeoutMs === undefined
    ? 'sidebar default contention waits 15000 ms'
    : 'sidebar contention override rejects and queue recovers', async () => {
    const timeout = timeoutMs ?? 15000
    await fs.writeFile(
      lockPath(),
      JSON.stringify({
        ownerId: 'foreign',
        expiresAt: Date.now() + timeout + 10000,
      }),
    )
    const file = writer(timeoutMs)
    const start = performance.now()
    let failure: unknown
    try {
      await file.write(1)
    } catch (error) {
      failure = error
    }
    const elapsed = performance.now() - start
    expect(failure).toBeInstanceOf(LockContentionError)
    expect((failure as LockContentionError).details).toEqual({
      target,
      name: 'sidebar-write',
      timeoutMs: timeout,
    })
    expect(elapsed).toBeGreaterThanOrEqual(timeout)
    expect(elapsed).toBeLessThan(timeout + 5000)
    await fs.rm(lockPath())
    await file.write(2)
    expect(await file.read()).toBe(2)
  }, 25000)
}
