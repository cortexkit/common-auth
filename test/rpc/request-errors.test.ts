import { afterEach, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { request } from 'node:http'
import { join } from 'node:path'
import {
  RpcRequestError,
  type RpcServerHandle,
  type RpcServerOptions,
  startRpcServer,
} from '../../src/rpc/index.js'
import { makeTempDir } from '../fixtures/scratch'

let dir: string | undefined
let handle: RpcServerHandle | undefined
afterEach(async () => {
  await handle?.stop()
  handle = undefined
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
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

async function post(server: RpcServerHandle, path: string, body: string) {
  const started = performance.now()
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${server.token}`,
      'content-type': 'application/json',
    },
    body,
    signal: AbortSignal.timeout(5_000),
  })
  return {
    status: response.status,
    body: (await response.json()) as unknown,
    ms: performance.now() - started,
  }
}

test('a request body that is not JSON answers 400', async () => {
  const server = await start()
  const out = await post(server, '/rpc/apply', '{nope')
  expect(out.status).toBe(400)
  expect(out.body).toEqual({ error: 'invalid json' })
})

test('a request body over the 1 MiB cap answers 413', async () => {
  const server = await start()
  const out = await post(
    server,
    '/rpc/apply',
    JSON.stringify({ value: 'x'.repeat(1024 * 1024) }),
  )
  expect(out.status).toBe(413)
  expect(out.body).toEqual({ error: 'body too large' })
  // The server stays usable after refusing an oversized body.
  expect((await post(server, '/rpc/apply', '{}')).status).toBe(200)
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
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      },
    )
    req.on('error', reject)
    const chunk = 'x'.repeat(256 * 1024)
    for (let i = 0; i < 5; i += 1) req.write(chunk)
    req.end()
  })
  expect(status).toBe(413)
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
