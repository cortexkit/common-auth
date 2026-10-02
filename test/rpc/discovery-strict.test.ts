import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import http, * as httpNamed from 'node:http'
import { createServer } from 'node:http'
import { join } from 'node:path'
import {
  createRpcClient,
  discoverPortFile,
  isManagedRpcStateDir,
  type PortFileEntry,
  startRpcServer,
  sweepRpcState,
  writePortFile,
} from '../../src/rpc/index.js'
import { makeTempDir } from '../fixtures/scratch'

const TOKEN = 'f'.repeat(64)
let dir: string | undefined
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** A positive PID with no live process behind it. */
function absentPid(): number {
  for (let pid = 4_000_000; pid < 4_000_100; pid += 1)
    if (!isAlive(pid)) return pid
  throw new Error('no free pid for the absent-pid fixture')
}

async function writeEntry(
  target: string,
  filenamePid: number | string,
  body: Record<string, unknown>,
) {
  await writeFile(
    join(target, `port-${filenamePid}.json`),
    JSON.stringify({ startedAt: Date.now(), ...body }),
    { mode: 0o600 },
  )
}

/** Discovery must reject the entry whether or not its PID is requested. */
async function expectUnusable(
  body: Record<string, unknown>,
  filenamePid: number = process.pid,
) {
  dir = await makeTempDir('fixture-discover-')
  await writeEntry(dir, filenamePid, body)
  expect(await discoverPortFile(dir, process.pid)).toBeNull()
  expect(await discoverPortFile(dir)).toBeNull()
  await rm(dir, { recursive: true, force: true })
  dir = undefined
}

test('discovery rejects a port file whose body pid differs from its filename pid', async () => {
  await expectUnusable(
    { pid: process.pid, port: 41_001, token: TOKEN },
    process.ppid,
  )
})

test('discovery rejects a port that is not an integer in 1..65535', async () => {
  for (const port of [70_000, 0, 4242.5, '4242', -1])
    await expectUnusable({ pid: process.pid, port, token: TOKEN })
})

test('discovery rejects a missing or empty token', async () => {
  await expectUnusable({ pid: process.pid, port: 41_002 })
  await expectUnusable({ pid: process.pid, port: 41_003, token: '' })
})

test('discovery still accepts a well-formed live entry', async () => {
  dir = await makeTempDir('fixture-discover-')
  await writeEntry(dir, process.pid, {
    pid: process.pid,
    port: 41_004,
    token: TOKEN,
  })
  expect((await discoverPortFile(dir, process.pid))?.port).toBe(41_004)
  expect((await discoverPortFile(dir))?.port).toBe(41_004)
})

test('discovery and sweep never probe a pid that is not a positive safe integer', async () => {
  dir = await makeTempDir('fixture-discover-')
  const project = join(dir, 'fixture-0123456789abcdef')
  await mkdir(project)
  // process.kill(0 | negative, 0) addresses a process group, so such an
  // entry must be judged unusable before any liveness probe.
  await writeEntry(project, 0, { pid: 0, port: 41_005, token: TOKEN })
  await writeEntry(project, -1, { pid: -1, port: 41_006, token: TOKEN })
  const unsafe = Number.MAX_SAFE_INTEGER + 3
  await writeEntry(project, unsafe, {
    pid: unsafe,
    port: 41_007,
    token: TOKEN,
  })
  const kill = spyOn(process, 'kill')
  try {
    expect(await discoverPortFile(project)).toBeNull()
    expect(await discoverPortFile(project, 0)).toBeNull()
    await sweepRpcState(dir, project, (name) =>
      isManagedRpcStateDir(name, 'fixture-'),
    )
    const probed = kill.mock.calls.map(([pid]) => pid)
    expect(
      probed.filter(
        (pid) =>
          typeof pid !== 'number' || pid <= 0 || !Number.isSafeInteger(pid),
      ),
    ).toEqual([])
  } finally {
    kill.mockRestore()
  }
})

test('exactPid discovery returns null when the expected pid has no entry', async () => {
  dir = await makeTempDir('fixture-discover-')
  await writeEntry(dir, process.pid, {
    pid: process.pid,
    port: 41_010,
    token: TOKEN,
  })
  const missing = absentPid()
  expect(await discoverPortFile(dir, missing, { exactPid: true })).toBeNull()
  expect(await discoverPortFile(dir, undefined, { exactPid: true })).toBeNull()
  // The default keeps falling back to the newest live entry.
  expect((await discoverPortFile(dir, missing))?.pid).toBe(process.pid)
})

test('exactPid discovery returns the expected pid entry over a newer one', async () => {
  dir = await makeTempDir('fixture-discover-')
  await writeEntry(dir, process.pid, {
    pid: process.pid,
    port: 41_011,
    token: TOKEN,
    startedAt: 1,
  })
  await writeEntry(dir, process.ppid, {
    pid: process.ppid,
    port: 41_012,
    token: TOKEN,
    startedAt: 2,
  })
  expect(
    (await discoverPortFile(dir, process.pid, { exactPid: true }))?.port,
  ).toBe(41_011)
})

/** A loopback HTTP server that only counts the requests reaching it. */
async function startDecoy() {
  let hits = 0
  const server = createServer((req, res) => {
    hits += 1
    req.resume()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ messages: [], text: 'decoy', knobs: {} }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address !== 'object') throw new Error('no address')
  return {
    port: address.port,
    hits: () => hits,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

test('an exactPid client bound to an absent pid never sends a request to another server', async () => {
  dir = await makeTempDir('fixture-client-')
  const decoy = await startDecoy()
  try {
    await writeEntry(dir, process.pid, {
      pid: process.pid,
      port: decoy.port,
      token: TOKEN,
    })
    const selected: Array<PortFileEntry | null> = []
    const client = createRpcClient(
      dir,
      absentPid(),
      (entry) => {
        selected.push(entry)
      },
      { exactPid: true },
    )
    expect(await client.pending(0, 'session-a')).toEqual([])
    expect(await client.pending(0, 'session-a')).toEqual([])
    expect(await client.apply({ command: 'x', arguments: '' })).toEqual({
      text: 'apply failed',
      knobs: {},
    })
    expect(decoy.hits()).toBe(0)
    expect(selected).toEqual([null])
  } finally {
    await decoy.stop()
  }
})

test('a throwing onSelected observer is not counted as reported and runs again on the next call', async () => {
  dir = await makeTempDir('fixture-client-')
  const decoy = await startDecoy()
  try {
    await writeEntry(dir, process.pid, {
      pid: process.pid,
      port: decoy.port,
      token: TOKEN,
    })
    const expected = absentPid()
    let calls = 0
    const client = createRpcClient(dir, expected, (entry) => {
      calls += 1
      if (entry && entry.pid !== expected) throw new Error('wrong server pid')
    })
    for (let attempt = 0; attempt < 2; attempt += 1)
      await expect(client.pending(0, 'session-a')).rejects.toThrow(
        'wrong server pid',
      )
    expect(calls).toBe(2)
    expect(decoy.hits()).toBe(0)
  } finally {
    await decoy.stop()
  }
})

test('onSelected that returns normally is reported once', async () => {
  dir = await makeTempDir('fixture-client-')
  const decoy = await startDecoy()
  try {
    await writeEntry(dir, process.pid, {
      pid: process.pid,
      port: decoy.port,
      token: TOKEN,
    })
    let calls = 0
    const client = createRpcClient(dir, process.pid, () => {
      calls += 1
    })
    await client.pending(0, 'session-a')
    await client.pending(0, 'session-a')
    expect(calls).toBe(1)
    expect(decoy.hits()).toBe(2)
  } finally {
    await decoy.stop()
  }
})

test('a failed port-file write removes its temp file', async () => {
  dir = await makeTempDir('fixture-portwrite-')
  const target = join(dir, 'rpc')
  // A non-empty directory at the target name makes the final rename fail.
  await mkdir(join(target, `port-${process.pid}.json`), { recursive: true })
  await writeFile(join(target, `port-${process.pid}.json`, 'keep'), 'x')
  await expect(
    writePortFile(
      target,
      { pid: process.pid, port: 41_020, token: TOKEN },
      { secureDir: true },
    ),
  ).rejects.toThrow()
  expect((await readdir(target)).filter((n) => n.endsWith('.tmp'))).toEqual([])
})

test('a server whose port-file write fails closes its listener and leaves no temp file', async () => {
  dir = await makeTempDir('fixture-startfail-')
  const target = join(dir, 'rpc')
  await mkdir(join(target, `port-${process.pid}.json`), { recursive: true })
  await writeFile(join(target, `port-${process.pid}.json`, 'keep'), 'x')
  const originalCreate = http.createServer
  let observed: http.Server | undefined
  const createSpy = spyOn(httpNamed, 'createServer').mockImplementation(((
    ...args: Parameters<typeof http.createServer>
  ) => {
    observed = originalCreate(...args)
    return observed
  }) as typeof http.createServer)
  try {
    await expect(
      startRpcServer({
        dir: target,
        isManagedDir: () => false,
        drain: () => [],
        apply: async () => ({ text: 'ok', knobs: {} }),
      }),
    ).rejects.toThrow()
  } finally {
    createSpy.mockRestore()
  }
  expect(observed?.listening).toBe(false)
  expect((await readdir(target)).filter((n) => n.endsWith('.tmp'))).toEqual([])
})
