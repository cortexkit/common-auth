import { expect } from 'bun:test'
import { rm } from 'node:fs/promises'
import { request } from 'node:http'
import { connect } from 'node:net'
import { join } from 'node:path'
import {
  RpcRequestError,
  type RpcServerHandle,
  type RpcServerOptions,
  startRpcServer,
} from '../../src/rpc/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { makeTempDir } from '../fixtures/scratch'
import { requestPhaseClock } from './request-phase-clock.js'

const hooks = lifetimeHooks()
const { afterEach, test } = hooks

let dir: string | undefined
let handle: RpcServerHandle | undefined
let clock: ReturnType<typeof requestPhaseClock> | undefined
afterEach(async () => {
  try {
    clock?.mark('teardown-stop')
    await handle?.stop()
    handle = undefined
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
  } finally {
    clock?.finish()
    clock = undefined
  }
})

async function start(overrides: Partial<RpcServerOptions> = {}) {
  dir = await makeTempDir('fixture-rpcerr-')
  handle = await startRpcServer({
    dir: join(dir, 'rpc'),
    isManagedDir: () => false,
    drain: () => [],
    apply: async () => ({ text: 'ok', knobs: {} }),
    ...overrides,
  })
  return handle
}

async function post(
  server: RpcServerHandle,
  path: string,
  body: string,
  phases?: ReturnType<typeof requestPhaseClock>,
  request = 'oversized',
) {
  const started = performance.now()
  const mark = (phase: string, detail: Record<string, unknown> = {}) =>
    phases?.mark(phase, { request, ...detail })
  mark('fetch-start')
  let phase = 'fetch'
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${server.token}`,
        'content-type': 'application/json',
      },
      body,
      signal: AbortSignal.any([
        AbortSignal.timeout(5_000),
        hooks.lifetime.signal,
      ]),
    })
    mark('fetch-settled', { outcome: 'resolved' })
    mark('client-headers', {
      status: response.status,
      connection: response.headers.get('connection'),
    })
    phase = 'json'
    const decoded: unknown = await response.json()
    mark('json-settled', { outcome: 'resolved' })
    return {
      status: response.status,
      body: decoded,
      ms: performance.now() - started,
    }
  } catch (error) {
    mark(`${phase}-settled`, {
      outcome: 'rejected',
      error: String(error),
    })
    throw error
  }
}

test('a request body that is not JSON answers 400', async () => {
  const server = await start()
  const out = await post(server, '/rpc/apply', '{nope')
  expect(out.status).toBe(400)
  expect(out.body).toEqual({ error: 'invalid json' })
})

test('a request body over the 1 MiB cap answers 413', async () => {
  clock = requestPhaseClock()
  const server = await start()
  const out = await post(
    server,
    '/rpc/apply',
    JSON.stringify({ value: 'x'.repeat(1024 * 1024) }),
    clock,
  )
  expect(out.status).toBe(413)
  expect(out.body).toEqual({ error: 'body too large' })
  // A close header alone did not stop Bun 1.3.14 reusing this connection.
  expect(clock.events.some((event) => event.phase === 'socket-local-end')).toBe(
    true,
  )
  // Use the same fetch client without forcing a fresh connection.
  expect(
    (await post(server, '/rpc/apply', '{}', clock, 'follow-up')).status,
  ).toBe(200)
  expect(
    clock.events.find(
      (event) =>
        event.request === 'follow-up' && event.phase === 'server-request',
    )?.reused413Connection,
  ).toBe(false)
  await clock.closed
  expect(clock.events.some((event) => event.phase === 'socket-close')).toBe(
    true,
  )
  expect(clock.refusedSocket?.destroyed).toBe(true)
  if (!hooks.lifetime.signal.aborted) clock.succeeded()
})

test('a chunked request body that grows past the cap answers 413', async () => {
  const server = await start()
  // No content-length: the cap is enforced while the body streams in.
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: server.port,
        path: '/rpc/apply',
        method: 'POST',
        headers: {
          authorization: `Bearer ${server.token}`,
          'transfer-encoding': 'chunked',
        },
      },
      (res) => {
        let body = ''
        res.on('data', (chunk) => {
          body += chunk.toString()
        })
        res.on('end', () => {
          try {
            expect(JSON.parse(body)).toEqual({ error: 'body too large' })
            resolve(res.statusCode)
          } catch (error) {
            reject(error)
          }
        })
      },
    )
    req.on('error', reject)
    const chunk = 'x'.repeat(256 * 1024)
    for (let i = 0; i < 5; i += 1) req.write(chunk)
    req.end()
  })
  expect(status).toBe(413)
})

test('streamed overflow keeps the socket open until the client finishes sending', async () => {
  const server = await start()
  clock = requestPhaseClock(server.port)
  const phases = clock
  // A raw half-open client can hold back the final chunk even after reading
  // the response; Bun's node:http client cancels its writer on response end.
  const socket = connect({
    host: '127.0.0.1',
    port: server.port,
    allowHalfOpen: true,
  })
  hooks.lifetime.signal.addEventListener('abort', () => socket.destroy(), {
    once: true,
  })
  try {
    const response = new Promise<string>((resolve, reject) => {
      let wire = ''
      socket.on('error', reject)
      socket.on('data', (chunk) => {
        wire += chunk.toString()
        const split = wire.indexOf('\r\n\r\n')
        if (split === -1) return
        const length = Number(
          /content-length: (\d+)/i.exec(wire.slice(0, split))?.[1],
        )
        if (
          wire.endsWith('\r\n0\r\n\r\n') ||
          (Number.isFinite(length) && wire.length >= split + 4 + length)
        )
          resolve(wire)
      })
    })
    socket.write(
      `POST /rpc/apply HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${server.token}\r\nTransfer-Encoding: chunked\r\n\r\n`,
    )
    const chunk = 'x'.repeat(256 * 1024)
    for (let i = 0; i < 4; i += 1) socket.write(`40000\r\n${chunk}\r\n`)
    const wire = await response
    expect(wire.startsWith('HTTP/1.1 413')).toBe(true)
    const payload = wire.slice(wire.indexOf('\r\n\r\n') + 4)
    const body = /transfer-encoding: chunked/i.test(wire)
      ? payload.split('\r\n')[1]
      : payload
    expect(JSON.parse(body ?? '')).toEqual({ error: 'body too large' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(phases.refusedSocket).toBeDefined()
    expect(phases.refusedSocket?.destroyed).toBe(false)
    expect(
      phases.events.some((event) => event.phase === 'socket-local-destroy'),
    ).toBe(false)
    await new Promise<void>((resolve) =>
      socket.end(`40000\r\n${chunk}\r\n0\r\n\r\n`, resolve),
    )
    phases.succeeded()
  } finally {
    socket.destroy()
  }
})

test('an apply handler throwing RpcRequestError answers its status and message', async () => {
  const server = await start({
    apply: async (request) => {
      if (request.command !== 'fixture-quota')
        throw new RpcRequestError(400, 'invalid apply request')
      return { text: 'ok', knobs: {} }
    },
  })
  const out = await post(
    server,
    '/rpc/apply',
    JSON.stringify({ command: 'not-a-command', arguments: '' }),
  )
  expect(out).toMatchObject({
    status: 400,
    body: { error: 'invalid apply request' },
  })
})

test('a handler error that only carries a status field still answers 500', async () => {
  const server = await start({
    apply: async () => {
      throw Object.assign(new Error('secret detail'), { status: 400 })
    },
  })
  const out = await post(server, '/rpc/apply', '{}')
  expect(out).toMatchObject({ status: 500, body: { error: 'internal error' } })
})

test('RpcRequestError accepts only a 4xx status', () => {
  expect(new RpcRequestError(404, 'gone').status).toBe(404)
  for (const status of [399, 500, 504, 400.5])
    expect(() => new RpcRequestError(status, 'x')).toThrow(RangeError)
})

test('routing uses the URL pathname, so a query string still reaches the method', async () => {
  const server = await start()
  const out = await post(
    server,
    '/rpc/pending-notifications?probe=1',
    JSON.stringify({ lastReceivedId: 0 }),
  )
  expect(out).toMatchObject({ status: 200, body: { messages: [] } })
  const health = await fetch(`http://127.0.0.1:${server.port}/health?x=1`)
  expect(health.status).toBe(200)
})

test('with applyDeadlineMs a handler still running at the deadline answers 504 at about the deadline', async () => {
  let release: () => void = () => {}
  const finished = new Promise<void>((resolve) => {
    release = resolve
  })
  const server = await start({
    applyDeadlineMs: 150,
    apply: async () => {
      await Bun.sleep(900)
      release()
      return { text: 'late', knobs: {} }
    },
  })
  const out = await post(server, '/rpc/apply', '{}')
  await finished
  expect(out.status).toBe(504)
  expect(out.body).toEqual({ error: 'handler deadline exceeded' })
  expect(out.ms).toBeGreaterThanOrEqual(140)
  expect(out.ms).toBeLessThan(900)
})

test('a handler that finishes before applyDeadlineMs answers normally', async () => {
  const server = await start({
    applyDeadlineMs: 1_000,
    apply: async () => {
      await Bun.sleep(20)
      return { text: 'in time', knobs: {} }
    },
  })
  const out = await post(server, '/rpc/apply', '{}')
  expect(out).toMatchObject({ status: 200, body: { text: 'in time' } })
})

test('a slow declared oversized upload receives complete 413 JSON', async () => {
  const server = await start()
  let finishUpload: () => void = () => {}
  const uploadFinished = new Promise<void>((resolve) => {
    finishUpload = resolve
  })
  const response = new Promise<{ status: number | undefined; body: string }>(
    (resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: server.port,
          path: '/rpc/apply',
          method: 'POST',
          headers: {
            authorization: `Bearer ${server.token}`,
            'content-length': String(5 * 256 * 1024),
          },
        },
        (res) => {
          let body = ''
          res.on('data', (chunk) => {
            body += chunk.toString()
          })
          res.on('error', reject)
          res.on('end', () => resolve({ status: res.statusCode, body }))
        },
      )
      req.on('error', reject)
      req.write('x'.repeat(256 * 1024))
      let writes = 1
      const timer = setInterval(() => {
        writes++
        // Bun 1.4.2 cancels node:http's writer on an early response. The response
        // must still arrive intact; post-response write callbacks are diagnostic.
        req.write('x'.repeat(256 * 1024), () => {})
        if (writes === 5) {
          clearInterval(timer)
          req.end()
          hooks.lifetime.signal.removeEventListener('abort', abort)
          finishUpload()
        }
      }, 30)
      const abort = () => {
        clearInterval(timer)
        req.destroy()
      }
      hooks.lifetime.signal.addEventListener('abort', abort, { once: true })
    },
  )
  const out = await response
  expect(out.status).toBe(413)
  expect(JSON.parse(out.body)).toEqual({ error: 'body too large' })
  expect((await post(server, '/rpc/apply', '{}')).status).toBe(200)
  await uploadFinished
})
