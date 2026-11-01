import { beforeEach, describe, expect } from 'bun:test'
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import {
  discoverPortFile,
  isManagedRpcStateDir,
  portFileIdentity,
  sweepRpcState,
} from '../../src/rpc/port-file.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { makeTempDir } from '../fixtures/scratch'

const { afterEach, test } = lifetimeHooks()
const now = 1_800_000_000_000
const uptime = 60 * 60
const boot = now - uptime * 1000
const cutoff = boot - 5 * 60 * 1000
const clock = { now: () => now, uptime: () => uptime }
let root: string
let dir: string
let path: string

beforeEach(async () => {
  root = await makeTempDir('rpc-boot-')
  dir = join(root, 'fixture-deadbeefdeadbeef')
  await mkdir(dir)
  path = join(dir, `port-${process.pid}.json`)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function entry(startedAt = now) {
  return { pid: process.pid, port: 5123, token: 'fixture', startedAt }
}

const sweep = () =>
  sweepRpcState(
    root,
    dir,
    (name) => isManagedRpcStateDir(name, 'fixture-'),
    undefined,
    clock,
  )

describe('port-file boot time', () => {
  test('sweeps a live unrelated PID with a pre-boot startedAt', async () => {
    await writeFile(path, JSON.stringify(entry(cutoff - 1)))
    await utimes(path, new Date(now), new Date(now))
    await sweep()
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('does not discover a live unrelated PID with a pre-boot startedAt', async () => {
    await writeFile(path, JSON.stringify(entry(cutoff - 1)))
    await utimes(path, new Date(now), new Date(now))
    expect(await discoverPortFile(dir, process.pid, clock)).toBeNull()
    expect(
      await discoverPortFile(dir, process.pid, { ...clock, exactPid: true }),
    ).toBeNull()
  })

  test('does not validate a cached live PID with a pre-boot startedAt', async () => {
    const stale = entry(cutoff - 1)
    await writeFile(path, JSON.stringify(stale))
    expect(await portFileIdentity(dir, stale, clock)).toBeNull()
  })

  test('keeps and discovers a live PID with a current-boot startedAt', async () => {
    const current = entry(boot + 1)
    await writeFile(path, JSON.stringify(current))
    // startedAt, not an older mtime, describes a timestamped record's age.
    await utimes(path, new Date(cutoff - 1000), new Date(cutoff - 1000))
    await sweep()
    expect(await discoverPortFile(dir, process.pid, clock)).toEqual(current)
    expect(await portFileIdentity(dir, current, clock)).not.toBeNull()
  })

  test('keeps records inside the five-minute clock uncertainty margin', async () => {
    for (const startedAt of [cutoff, boot - 1]) {
      const current = entry(startedAt)
      await writeFile(path, JSON.stringify(current))
      await sweep()
      expect(await discoverPortFile(dir, process.pid, clock)).toEqual(current)
      expect(await portFileIdentity(dir, current, clock)).not.toBeNull()
    }
  })

  test('uses an old mtime when startedAt is absent', async () => {
    await writeFile(path, JSON.stringify({ ...entry(), startedAt: undefined }))
    await utimes(path, new Date(cutoff - 1000), new Date(cutoff - 1000))
    expect(await discoverPortFile(dir, process.pid, clock)).toBeNull()
    await sweep()
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('keeps and discovers a current-boot mtime when startedAt is absent', async () => {
    await writeFile(path, JSON.stringify({ ...entry(), startedAt: undefined }))
    await utimes(path, new Date(boot + 1000), new Date(boot + 1000))
    await sweep()
    const discovered = await discoverPortFile(dir, process.pid, clock)
    expect(discovered as unknown).toEqual({
      pid: process.pid,
      port: 5123,
      token: 'fixture',
    })
    if (!discovered) throw new Error('legacy fixture was not discovered')
    expect(await portFileIdentity(dir, discovered, clock)).not.toBeNull()
    expect(JSON.parse(await readFile(path, 'utf8'))).not.toHaveProperty(
      'startedAt',
    )
  })

  test('does not validate a cached legacy record with an old mtime', async () => {
    const legacy = { ...entry(), startedAt: undefined }
    await writeFile(path, JSON.stringify(legacy))
    await utimes(path, new Date(cutoff - 1000), new Date(cutoff - 1000))
    const discovered = await discoverPortFile(dir, process.pid, {
      ...clock,
      now: () => cutoff - 2000,
    })
    expect(discovered).not.toBeNull()
    if (!discovered) throw new Error('legacy fixture was not discovered')
    expect(await portFileIdentity(dir, discovered, clock)).toBeNull()
  })

  test('keeps a record whose startedAt is unknown even with an old mtime', async () => {
    for (const startedAt of [null, 'unknown']) {
      const unknown = { ...entry(), startedAt }
      await writeFile(path, JSON.stringify(unknown))
      await utimes(path, new Date(cutoff - 1000), new Date(cutoff - 1000))
      await sweep()
      expect(
        (await discoverPortFile(dir, process.pid, clock)) as unknown,
      ).toEqual(unknown)
    }
  })

  test('does not remove a successor that replaced a stale record', async () => {
    await writeFile(path, JSON.stringify(entry(cutoff - 1)))
    const successor = { ...entry(boot + 1), token: 'successor' }
    let replaced = false
    await sweepRpcState(
      root,
      dir,
      (name) => isManagedRpcStateDir(name, 'fixture-'),
      undefined,
      {
        ...clock,
        beforeRemove: async (target) => {
          expect(target).toBe(path)
          await writeFile(`${path}.tmp`, JSON.stringify(successor))
          await rename(`${path}.tmp`, path)
          replaced = true
        },
      },
    )
    expect(replaced).toBe(true)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(successor)
    expect(await discoverPortFile(dir, process.pid, clock)).toEqual(successor)
  })

  test('does not remove a replacement with identical contents and mtime', async () => {
    const raw = JSON.stringify(entry(cutoff - 1))
    await writeFile(path, raw)
    const time = new Date(now)
    await utimes(path, time, time)
    const original = await stat(path)
    let replaced = false
    await sweepRpcState(
      root,
      dir,
      (name) => isManagedRpcStateDir(name, 'fixture-'),
      undefined,
      {
        ...clock,
        beforeRemove: async () => {
          await writeFile(`${path}.tmp`, raw)
          await utimes(`${path}.tmp`, time, time)
          await rename(`${path}.tmp`, path)
          replaced = true
        },
      },
    )
    expect(replaced).toBe(true)
    expect(await readFile(path, 'utf8')).toBe(raw)
    const replacement = await stat(path)
    expect(replacement.ino).not.toBe(original.ino)
    expect(replacement.mtimeMs).toBe(original.mtimeMs)
  })

  test('does not remove an in-place successor with unchanged file identity', async () => {
    await writeFile(path, JSON.stringify(entry(cutoff - 1)))
    const time = new Date(now)
    await utimes(path, time, time)
    const original = await stat(path)
    const successor = { ...entry(boot + 1), token: 'renewed' }
    let replaced = false
    await sweepRpcState(
      root,
      dir,
      (name) => isManagedRpcStateDir(name, 'fixture-'),
      undefined,
      {
        ...clock,
        beforeRemove: async () => {
          await writeFile(path, JSON.stringify(successor))
          await utimes(path, time, time)
          replaced = true
        },
      },
    )
    expect(replaced).toBe(true)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(successor)
    const replacement = await stat(path)
    expect([replacement.ino, replacement.mtimeMs, replacement.size]).toEqual([
      original.ino,
      original.mtimeMs,
      original.size,
    ])
  })

  test('computes boot time once per sweep, discovery and identity check', async () => {
    await writeFile(path, JSON.stringify(entry(boot + 1)))
    await writeFile(
      join(dir, 'port-99999999.json'),
      JSON.stringify({
        ...entry(),
        pid: 99999999,
      }),
    )
    let nowCalls = 0
    let uptimeCalls = 0
    const countedClock = {
      now: () => {
        nowCalls += 1
        return now
      },
      uptime: () => {
        uptimeCalls += 1
        return uptime
      },
    }
    await sweepRpcState(
      root,
      dir,
      (name) => isManagedRpcStateDir(name, 'fixture-'),
      undefined,
      countedClock,
    )
    expect([nowCalls, uptimeCalls]).toEqual([1, 1])
    await discoverPortFile(dir, process.pid, countedClock)
    expect([nowCalls, uptimeCalls]).toEqual([2, 2])
    await portFileIdentity(dir, entry(boot + 1), countedClock)
    expect([nowCalls, uptimeCalls]).toEqual([3, 3])
  })
})
