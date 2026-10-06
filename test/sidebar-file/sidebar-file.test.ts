import { beforeEach, describe, expect, spyOn } from 'bun:test'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import {
  LockContentionError,
  LockOwnershipError,
  lockPathFor,
} from '../../src/fs/index.js'
import {
  createSidebarFile,
  type SidebarWriteResult,
} from '../../src/sidebar-file/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { makeTempDir } from '../fixtures/scratch.js'

const hooks = lifetimeHooks()
const { afterEach, test } = hooks

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
      // Two renewal intervals (10 s lease / 3) plus margin: a 0.8.0 renewal can
      // defer one beat while it takes its eviction marker, and a single
      // interval is too tight on a loaded machine.
      await Bun.sleep(7200)
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

/** Captures the result a write reports through `onResult`. */
const reporting = () => {
  const seen: SidebarWriteResult[] = []
  return {
    onResult: (result: SidebarWriteResult) => {
      seen.push(result)
    },
    seen,
  }
}

test('reports a write that kept its lock as written and a declined merge as skipped', async () => {
  const written = reporting()
  const skipped = reporting()
  await writer().write(1, written)
  await writer().update(() => undefined, skipped)
  expect(written.seen).toEqual([{ status: 'written' }])
  expect(skipped.seen).toEqual([{ status: 'skipped' }])
  expect(await fs.readFile(target, 'utf8')).toBe('1')
})

describe('lock lost during the rename', () => {
  interface Frame {
    route: string
    quota: number
  }
  const successor: Frame = { route: 'successor-route', quota: 80 }
  const stale: Frame = { route: 'writer-route', quota: 10 }
  const frames = (
    options: {
      repair?: (current: Frame, written: Frame) => Frame | undefined
      timeoutMs?: number
    } = {},
  ) =>
    createSidebarFile<Frame>({
      path: target,
      defaultValue: { route: 'none', quota: 0 },
      normalize: (value) => value as Frame,
      ...options,
    })
  const onDisk = async () =>
    JSON.parse(await fs.readFile(target, 'utf8')) as Frame
  /**
   * After the first rename, a successor that took over the lapsed lease writes
   * its own state. `holdLock` leaves its live lock in place, as if it were
   * still writing; otherwise it releases the lock when done.
   */
  const successorTakesOver = (holdLock = false) => {
    let fired = 0
    return {
      afterRename: async () => {
        fired += 1
        if (fired > 1) return
        await fs.writeFile(
          lockPath(),
          JSON.stringify({
            ownerId: 'successor',
            expiresAt: Date.now() + 30000,
          }),
        )
        await fs.writeFile(target, JSON.stringify(successor))
        if (!holdLock) await fs.rm(lockPath())
      },
    }
  }
  /**
   * Keep everything the successor wrote and put back only the route, the one
   * field the stale writer is the authority on.
   */
  const republishRoute = (current: Frame, written: Frame) => ({
    ...current,
    route: written.route,
  })

  test('repairs an authoritative write after losing ownership post-rename', async () => {
    const repairs: Array<[Frame, Frame]> = []
    const report = reporting()
    await frames({
      repair: (current, written) => {
        repairs.push([current, written])
        return republishRoute(current, written)
      },
    }).write(stale, { ...successorTakesOver(), onResult: report.onResult })
    expect(report.seen).toEqual([
      { status: 'lost-after-rename', repair: 'written' },
    ])
    expect(repairs).toEqual([[successor, stale]])
    expect(await onDisk()).toEqual({ route: 'writer-route', quota: 80 })
    expect(
      (await fs.readdir(dir)).filter((name) => name !== 'state.json'),
    ).toEqual([])
  })

  test('without a repair a write that lost its lock at the rename is reported and left', async () => {
    const report = reporting()
    // Resolves, as it always has: the plugin learns of the loss from the report.
    await frames().write(stale, {
      ...successorTakesOver(),
      onResult: report.onResult,
    })
    expect(report.seen).toEqual([
      { status: 'lost-after-rename', repair: 'none' },
    ])
    expect(await onDisk()).toEqual(successor)
  })

  test('a repair that returns undefined leaves the successor state', async () => {
    const report = reporting()
    await frames({ repair: () => undefined }).write(stale, {
      ...successorTakesOver(),
      onResult: report.onResult,
    })
    expect(report.seen).toEqual([
      { status: 'lost-after-rename', repair: 'skipped' },
    ])
    expect(await onDisk()).toEqual(successor)
  })

  test('a per-write repair overrides the file repair', async () => {
    const report = reporting()
    await frames({ repair: () => undefined }).update(() => stale, {
      ...successorTakesOver(),
      repair: republishRoute,
      onResult: report.onResult,
    })
    expect(report.seen).toEqual([
      { status: 'lost-after-rename', repair: 'written' },
    ])
    expect(await onDisk()).toEqual({ route: 'writer-route', quota: 80 })
  })

  test('a repair that loses its lock again is not repaired a second time', async () => {
    let repairs = 0
    let renames = 0
    const report = reporting()
    await frames({
      repair: (current, written) => {
        repairs += 1
        return republishRoute(current, written)
      },
    }).write(stale, {
      onResult: report.onResult,
      afterRename: async () => {
        renames += 1
        await fs.writeFile(
          lockPath(),
          JSON.stringify({
            ownerId: 'successor',
            expiresAt: Date.now() + 30000,
          }),
        )
        if (renames === 1) {
          await fs.writeFile(target, JSON.stringify(successor))
          await fs.rm(lockPath())
        }
      },
    })
    expect(report.seen).toEqual([
      { status: 'lost-after-rename', repair: 'lost-again' },
    ])
    expect(repairs).toBe(1)
    expect(renames).toBe(2)
  })

  test('a repair that cannot retake the lock is skipped without rejecting', async () => {
    let repairs = 0
    const report = reporting()
    await frames({
      timeoutMs: 50,
      repair: (current, written) => {
        repairs += 1
        return republishRoute(current, written)
      },
    }).write(stale, {
      ...successorTakesOver(true),
      onResult: report.onResult,
    })
    expect(report.seen).toEqual([
      { status: 'lost-after-rename', repair: 'lock-unavailable' },
    ])
    expect(repairs).toBe(0)
    expect(await onDisk()).toEqual(successor)
  })
})
