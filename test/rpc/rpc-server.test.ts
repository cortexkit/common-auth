import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import http, * as httpNamed from 'node:http'
import net from 'node:net'
import { join } from 'node:path'
import {
  createCaptureSink,
  createLogger,
  flushForTest,
  initLogger,
} from '../../src/logger/index.js'
import {
  drainNotifications as drainScoped,
  pushNotification as pushScoped,
  type RpcNotification,
  resetNotificationsForTest,
} from '../../src/rpc/index.js'
import {
  discoverPortFile,
  isManagedRpcStateDir,
  writePortFile,
} from '../../src/rpc/port-file.js'
import {
  createRpcClient,
  DEFAULT_RPC_TIMEOUT_MS,
} from '../../src/rpc/rpc-client.js'
import { startRpcServer as start } from '../../src/rpc/rpc-server.js'
import { makeTempDir } from '../fixtures/scratch'

const scope = {
  rpcRoot: '/fixture',
  directoryPrefix: 'fixture-',
  registrationSessionId: 'registration',
}
const drainNotifications = (id = 0, sessionId?: string) =>
  drainScoped(scope, id, sessionId)
const pushNotification = (
  payload: Parameters<typeof pushScoped>[1],
  sessionId?: string,
) => pushScoped(scope, payload, sessionId)
const startRpcServer = (
  options: Omit<Parameters<typeof start>[0], 'isManagedDir'>,
) =>
  start({
    ...options,
    isManagedDir: (name) => isManagedRpcStateDir(name, 'fixture-'),
  })
let stop: (() => Promise<void>) | null = null
let dir: string
const capture = createCaptureSink()
afterEach(async () => {
  await stop?.()
  stop = null
  await flushForTest()
  if (dir) await rm(dir, { recursive: true, force: true })
  resetNotificationsForTest(scope)
  capture.clear()
})
describe('rpc-server', () => {
  test('apply callback receives sessionId unchanged; health is open and pending-notifications drains', async () => {
    resetNotificationsForTest(scope)
    dir = await makeTempDir('fixture-rpcsrv-')
    let receivedApply: unknown
    const server = await startRpcServer({
      dir,
      drain: drainNotifications,
      apply: async (request) => {
        receivedApply = request
        return { text: 'ok', knobs: {} }
      },
    })
    stop = server.stop
    const base = `http://127.0.0.1:${server.port}`

    expect((await fetch(`${base}/health`)).status).toBe(200)

    const noAuth = await fetch(`${base}/rpc/pending-notifications`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lastReceivedId: 0 }),
    })
    expect(noAuth.status).toBe(401)

    pushNotification({ command: 'fixture-quota', text: 'x', knobs: {} }, 's1')
    const ok = await fetch(`${base}/rpc/pending-notifications`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${server.token}`,
      },
      body: JSON.stringify({ lastReceivedId: 0, sessionId: 's1' }),
    })
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as {
      messages: Array<{ payload: { command: string } }>
    }
    expect(body.messages[0]?.payload.command).toBe('fixture-quota')

    const applyNoAuth = await fetch(`${base}/rpc/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'fixture-quota', arguments: '' }),
    })
    expect(applyNoAuth.status).toBe(401)

    const applyOk = await fetch(`${base}/rpc/apply`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${server.token}`,
      },
      body: JSON.stringify({
        command: 'fixture-routing',
        arguments: 'reset',
        sessionId: 'session-a',
      }),
    })
    expect(applyOk.status).toBe(200)
    expect(await applyOk.json()).toEqual({ text: 'ok', knobs: {} })
    expect(receivedApply).toEqual({
      command: 'fixture-routing',
      arguments: 'reset',
      sessionId: 'session-a',
    })
  })

  test('a session-less notification drain delivers every notice but cannot prune another session', async () => {
    dir = await makeTempDir('fixture-rpcsrv-')
    const server = await startRpcServer({
      dir,
      drain: drainNotifications,
      apply: async () => ({ text: 'ok', knobs: {} }),
    })
    stop = server.stop
    const base = `http://127.0.0.1:${server.port}`
    pushNotification({ command: 'fixture-quota', text: 's1', knobs: {} }, 's1')
    pushNotification(
      { command: 'fixture-account', text: 's2', knobs: {} },
      's2',
    )

    const noSession = await fetch(`${base}/rpc/pending-notifications`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${server.token}`,
      },
      body: JSON.stringify({ lastReceivedId: 0 }),
    })
    expect(noSession.status).toBe(200)
    const all = ((await noSession.json()) as { messages: RpcNotification[] })
      .messages as Array<{
      id: number
      payload: { command: string }
    }>
    expect(all.map((message) => message.payload.command)).toEqual([
      'fixture-quota',
      'fixture-account',
    ])

    const noSessionAck = await fetch(`${base}/rpc/pending-notifications`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${server.token}`,
      },
      body: JSON.stringify({ lastReceivedId: all[0]?.id }),
    })
    expect(noSessionAck.status).toBe(200)
    expect(
      ((await noSessionAck.json()) as { messages: RpcNotification[] }).messages,
    ).toEqual([
      expect.objectContaining({
        payload: { command: 'fixture-account', text: 's2', knobs: {} },
      }),
    ])

    const s1 = await fetch(`${base}/rpc/pending-notifications`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${server.token}`,
      },
      body: JSON.stringify({ lastReceivedId: 0, sessionId: 's1' }),
    })
    expect(s1.status).toBe(200)
    expect(
      ((await s1.json()) as { messages: RpcNotification[] }).messages,
    ).toEqual([
      expect.objectContaining({
        payload: { command: 'fixture-quota', text: 's1', knobs: {} },
      }),
    ])

    const s1Ack = await fetch(`${base}/rpc/pending-notifications`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${server.token}`,
      },
      body: JSON.stringify({ lastReceivedId: all[0]?.id, sessionId: 's1' }),
    })
    expect(s1Ack.status).toBe(200)

    const s2 = await fetch(`${base}/rpc/pending-notifications`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${server.token}`,
      },
      body: JSON.stringify({ lastReceivedId: 0, sessionId: 's2' }),
    })
    expect(s2.status).toBe(200)
    expect(
      ((await s2.json()) as { messages: RpcNotification[] }).messages,
    ).toEqual([
      expect.objectContaining({
        payload: { command: 'fixture-account', text: 's2', knobs: {} },
      }),
    ])
  })

  test('stopping a stale server leaves its successor port file and health endpoint live', async () => {
    dir = await makeTempDir('fixture-rpcsrv-')
    const first = await startRpcServer({
      dir,
      drain: drainNotifications,
      apply: async () => ({ text: 'first', knobs: {} }),
    })
    const second = await startRpcServer({
      dir,
      drain: drainNotifications,
      apply: async () => ({ text: 'second', knobs: {} }),
    })
    try {
      await first.stop()
      const entry = await discoverPortFile(dir, process.pid)
      expect(entry?.port).toBe(second.port)
      expect(
        (await fetch(`http://127.0.0.1:${second.port}/health`)).status,
      ).toBe(200)
    } finally {
      await second.stop()
    }
  })

  test('rejects body exceeding 1 MB byte limit', async () => {
    dir = await makeTempDir('fixture-rpcsrv-')
    const server = await startRpcServer({
      dir,
      drain: drainNotifications,
      apply: async () => ({ text: 'ok', knobs: {} }),
    })
    stop = server.stop
    const base = `http://127.0.0.1:${server.port}`

    // ASCII body > 1 MB bytes. The server answers 413 rather than dropping
    // the connection, so the client can tell an oversized request apart
    // from a dead server.
    const huge = 'x'.repeat(1_000_001)
    const res = await fetch(`${base}/rpc/apply`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${server.token}`,
      },
      body: JSON.stringify({ command: 'test', arguments: huge }),
    })
    expect(res.status).toBe(413)
  })

  test('rejects multibyte body where byte length exceeds limit but string length does not', async () => {
    dir = await makeTempDir('fixture-rpcsrv-')
    const server = await startRpcServer({
      dir,
      drain: drainNotifications,
      apply: async () => ({ text: 'ok', knobs: {} }),
    })
    stop = server.stop
    const base = `http://127.0.0.1:${server.port}`

    // Each CJK char is 3 bytes in UTF-8 but 1 UTF-16 code unit
    const cjk = '好'.repeat(400_000)
    // String length (UTF-16) is ~400k — below the old 1M limit
    expect(cjk.length).toBeLessThan(1_000_000)
    // Byte length (UTF-8) is ~1.2M — above the 1M limit
    expect(Buffer.byteLength(cjk, 'utf8')).toBeGreaterThan(1_000_000)

    const body = JSON.stringify({ command: 'test', arguments: cjk })
    // The full JSON payload byte length must also exceed 1 MB
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(1_000_000)

    const res = await fetch(`${base}/rpc/apply`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${server.token}`,
      },
      body,
    })
    expect(res.status).toBe(413)
  })

  test('destroys a socket that stalls part-way through sending a request', async () => {
    dir = await makeTempDir('fixture-rpcsrv-')
    const server = await startRpcServer({
      dir,
      drain: drainNotifications,
      apply: async () => ({ text: 'ok', knobs: {} }),
      // The socket inactivity timer is what reclaims a stalled connection.
      // requestTimeout cannot: Node only samples it on the
      // connectionsCheckingInterval tick (30s by default), so it is a coarse
      // ceiling rather than the mechanism that frees this socket.
      timeoutMs: 100,
    })
    stop = server.stop

    const reqPromise = new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: server.port,
          path: '/rpc/apply',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${server.token}`,
          },
        },
        (res) => {
          res.on('data', () => {})
          res.on('end', () => {
            reject(
              new Error(
                `should have timed out (end), status: ${res.statusCode}`,
              ),
            )
          })
        },
      )
      req.on('error', () => {
        resolve()
      })
      req.write('{"command":')
    })

    await expect(reqPromise).resolves.toBeUndefined()
  })

  test('starts when the state sweep fails', async () => {
    dir = await makeTempDir('fixture-rpcsrv-')
    const badSweepRoot = join(dir, 'not-a-directory')
    initLogger({ file: join(dir, 'rpc.log'), captureSink: capture.sink })
    await writeFile(badSweepRoot, 'x')
    const server = await startRpcServer({
      dir: join(dir, 'rpc'),
      sweepRoot: badSweepRoot,
      drain: drainNotifications,
      apply: async () => ({ text: 'ok', knobs: {} }),
      log: createLogger('rpc'),
    })
    stop = server.stop
    expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(
      200,
    )
    expect(
      capture.records.filter((r) => r.message === 'rpc state sweep failed'),
    ).toHaveLength(1)
  })

  test('startup sweeps stale project state outside the active directory', async () => {
    dir = await makeTempDir('fixture-rpcsrv-')
    const root = join(dir, 'state')
    const staleDir = join(root, 'fixture-deadbeefdeadbeef')
    await mkdir(staleDir, { recursive: true })
    await writeFile(
      join(staleDir, 'port-99999999.json'),
      JSON.stringify({ port: 1, token: 'dead', pid: 99999999, startedAt: 1 }),
      { encoding: 'utf8', mode: 0o600 },
    )

    const server = await startRpcServer({
      dir: join(root, 'fixture-cafebabecafebabe'),
      sweepRoot: root,
      drain: drainNotifications,
      apply: async () => ({ text: 'ok', knobs: {} }),
    })
    stop = server.stop

    expect(await readdir(root)).toEqual(['fixture-cafebabecafebabe'])
  })

  test('creates a managed RPC directory with 0700 permissions', async () => {
    dir = await makeTempDir('fixture-rpcsrv-')
    const managedDir = join(dir, 'managed', 'rpc')
    await mkdir(managedDir, { recursive: true, mode: 0o755 })
    await chmod(managedDir, 0o755)

    const server = await startRpcServer({
      dir: managedDir,
      secureDir: true,
      drain: drainNotifications,
      apply: async () => ({ text: 'ok', knobs: {} }),
    })
    stop = server.stop

    expect((await stat(managedDir)).mode & 0o777).toBe(0o700)
  })

  test('does not chmod a foreign RPC override directory', async () => {
    dir = await makeTempDir('fixture-rpcsrv-')
    await chmod(dir, 0o755)

    const server = await startRpcServer({
      dir,
      secureDir: false,
      drain: drainNotifications,
      apply: async () => ({ text: 'ok', knobs: {} }),
    })
    stop = server.stop

    expect((await stat(dir)).mode & 0o777).toBe(0o755)
  })

  test('default timeout lets a slow apply handler respond before the socket is destroyed', async () => {
    dir = await makeTempDir('fixture-rpcsrv-')
    // The handler below waits three seconds; the default socket timeout must
    // let it respond without an explicit timeout override.
    const server = await startRpcServer({
      dir,
      drain: drainNotifications,
      apply: async () => {
        await Bun.sleep(3_000)
        return { text: 'slow-ok', knobs: {} }
      },
    })
    stop = server.stop

    const res = await fetch(`http://127.0.0.1:${server.port}/rpc/apply`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${server.token}`,
      },
      body: JSON.stringify({ command: 'fixture-reset', arguments: '' }),
      signal: AbortSignal.timeout(15_000),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ text: 'slow-ok', knobs: {} })
  })
})

test('sessionless HTTP oracle retains every notice, filters acknowledged IDs and warns once', async () => {
  dir = await makeTempDir('fixture-rpc-')
  initLogger({ file: join(dir, 'rpc.log'), captureSink: capture.sink })
  const server = await startRpcServer({
    dir,
    drain: drainNotifications,
    apply: async () => ({ text: 'ok', knobs: {} }),
    log: createLogger('rpc'),
  })
  stop = server.stop
  pushNotification({ command: 'global', text: 'global', knobs: {} })
  pushNotification(
    { command: 'session', text: 'session', knobs: {} },
    'wire-session',
  )
  const request = async (lastReceivedId: number) => {
    const response = await fetch(
      `http://127.0.0.1:${server.port}/rpc/pending-notifications`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${server.token}` },
        body: JSON.stringify({ lastReceivedId }),
      },
    )
    expect(response.status).toBe(200)
    return ((await response.json()) as { messages: RpcNotification[] })
      .messages as Array<{ id: number; payload: { command: string } }>
  }
  const first = await request(0)
  expect(first.map((n) => n.payload.command)).toEqual(['global', 'session'])
  expect(await request(Math.max(...first.map((n) => n.id)))).toEqual([])
  expect(
    capture.records.filter(
      (r) =>
        r.level === 'warn' &&
        r.message === 'rpc notification drain missing session id',
    ),
  ).toHaveLength(1)
  expect(await request(0)).toEqual(first)
})

for (const fixture of [
  'different token',
  'different port',
  'matching identity',
] as const) {
  test(`stop port-file identity fence: ${fixture}`, async () => {
    dir = await makeTempDir('fixture-rpc-')
    const server = await startRpcServer({
      dir,
      drain: drainNotifications,
      apply: async () => ({ text: 'ok', knobs: {} }),
    })
    stop = server.stop
    const path = join(dir, `port-${process.pid}.json`)
    const entry = {
      pid: process.pid,
      port: fixture === 'different port' ? server.port + 1 : server.port,
      token: fixture === 'different token' ? 'successor' : server.token,
    }
    await writeFile(path, JSON.stringify(entry))
    await server.stop()
    stop = null
    if (fixture === 'matching identity')
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    else expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(entry)
  })
}

test('two servers isolate notification queue scope', async () => {
  dir = await makeTempDir('fixture-rpc-')
  const otherScope = { ...scope, registrationSessionId: 'other-registration' }
  const first = await startRpcServer({
    dir: join(dir, 'a'),
    drain: drainNotifications,
    apply: async () => ({ text: 'a', knobs: {} }),
  })
  const second = await startRpcServer({
    dir: join(dir, 'b'),
    drain: (id, session) => drainScoped(otherScope, id, session),
    apply: async () => ({ text: 'b', knobs: {} }),
  })
  try {
    pushNotification({ command: 'a', text: 'a', knobs: {} }, 'same-wire')
    pushScoped(otherScope, { command: 'b', text: 'b', knobs: {} }, 'same-wire')
    for (const [server, command] of [
      [first, 'a'],
      [second, 'b'],
    ] as const) {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/rpc/pending-notifications`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${server.token}` },
          body: JSON.stringify({ lastReceivedId: 0, sessionId: 'same-wire' }),
        },
      )
      expect(response.status).toBe(200)
      expect(
        (
          (await response.json()) as { messages: RpcNotification[] }
        ).messages.map(
          (n: { payload: { command: string } }) => n.payload.command,
        ),
      ).toEqual([command])
    }
  } finally {
    await first.stop()
    await second.stop()
    resetNotificationsForTest(otherScope)
  }
})

test('RPC client preserves sessionId through the server apply callback', async () => {
  dir = await makeTempDir('fixture-rpcclient-')
  const received: Array<{ sessionId?: string }> = []
  const server = await startRpcServer({
    dir,
    drain: drainNotifications,
    apply: async (request) => {
      received.push(request)
      return { text: 'ok', knobs: {} }
    },
  })

  stop = server.stop
  const client = createRpcClient(dir, process.pid)
  await Promise.all([
    client.apply({
      command: 'fixture-routing',
      arguments: 'reset',
      sessionId: 'session-a',
    }),
    client.apply({
      command: 'fixture-routing',
      arguments: 'reset',
      sessionId: 'session-b',
    }),
  ])

  expect(received.map((request) => request.sessionId).sort()).toEqual([
    'session-a',
    'session-b',
  ])
})

describe('rpc-client', () => {
  test('keeps the default call timeout at two seconds', () => {
    expect(DEFAULT_RPC_TIMEOUT_MS).toBe(2_000)
  })

  test('apply honors a per-call timeout override', async () => {
    dir = await makeTempDir('fixture-rpcclient-')
    const localServer = await startRpcServer({
      dir,
      timeoutMs: 2_000,
      drain: () => [],
      apply: async () => {
        await Bun.sleep(300)
        return { text: 'completed', knobs: { stage: 'result' } }
      },
    })
    stop = localServer.stop
    const client = createRpcClient(dir, process.pid)
    const request = {
      command: 'fixture-reset',
      arguments: 'confirm account id',
    } as const

    expect(await client.apply(request, 100)).toEqual({
      text: 'apply failed',
      knobs: {},
    })
    expect(await client.apply(request, 1_000)).toEqual({
      text: 'completed',
      knobs: { stage: 'result' },
    })
  })

  test('pending honors a per-call timeout override', async () => {
    dir = await makeTempDir('fixture-rpcclient-')
    const notification: RpcNotification = {
      id: 1,
      type: 'open-dialog',
      payload: { command: 'fixture', text: 'late', knobs: {} },
    }
    // A server that accepts the connection and answers only after 300 ms.
    const slow = net.createServer((socket) => {
      socket.once('data', () => {
        setTimeout(() => {
          const body = JSON.stringify({ messages: [notification] })
          socket.end(
            `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
          )
        }, 300)
      })
    })
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve))
    const port = (slow.address() as net.AddressInfo).port
    stop = async () => {
      await new Promise<void>((resolve) => slow.close(() => resolve()))
    }
    await writePortFile(dir, { pid: process.pid, port, token: 'fixture-token' })
    const client = createRpcClient(dir, process.pid)

    expect(await client.pending(0, undefined, 100)).toEqual([])
    expect(await client.pending(0, undefined, 1_000)).toEqual([notification])
  })
})

test('server wires 90 second inactivity and separate 2 second receipt defaults', async () => {
  dir = await makeTempDir('fixture-rpc-')
  const originalCreate = http.createServer
  let observed: http.Server | undefined
  const createSpy = spyOn(httpNamed, 'createServer').mockImplementation(((
    ...args: Parameters<typeof http.createServer>
  ) => {
    observed = originalCreate(...args)
    return observed
  }) as typeof http.createServer)
  const timeoutSpy = spyOn(http.IncomingMessage.prototype, 'setTimeout')
  try {
    const server = await startRpcServer({
      dir,
      drain: drainNotifications,
      apply: async () => ({ text: 'ok', knobs: {} }),
    })
    stop = server.stop
    expect(observed?.requestTimeout).toBe(2_000)
    expect(observed?.headersTimeout).toBe(2_000)
    expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(
      200,
    )
    expect(timeoutSpy).toHaveBeenCalledWith(90_000, expect.any(Function))
  } finally {
    createSpy.mockRestore()
    timeoutSpy.mockRestore()
  }
})
