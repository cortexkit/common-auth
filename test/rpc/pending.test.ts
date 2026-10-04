import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RpcRequestError, startRpcServer } from '../../src/rpc/index.js'

async function fixture(
  options: Record<string, unknown>,
  check: (
    post: (params: unknown, rawBody?: string) => Promise<Response>,
  ) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'rpc-pending-'))
  const server = await startRpcServer({
    dir,
    isManagedDir: () => false,
    apply: async () => ({ text: '', knobs: {} }),
    ...options,
  } as unknown as Parameters<typeof startRpcServer>[0])
  try {
    await check((params, rawBody) =>
      fetch(`http://127.0.0.1:${server.port}/rpc/pending-notifications`, {
        method: 'POST',
        headers: { authorization: `Bearer ${server.token}` },
        body: rawBody ?? JSON.stringify(params),
      }),
    )
  } finally {
    await server.stop()
    await rm(dir, { recursive: true, force: true })
  }
}

test('pending rejects malformed default cursors and sessions without draining', async () => {
  let calls = 0
  await fixture(
    {
      drain: () => {
        calls++
        return []
      },
    },
    async (post) => {
      for (const params of [
        { lastReceivedId: '1' },
        { lastReceivedId: -1 },
        { lastReceivedId: 0.5 },
        { sessionId: 123 },
        { lastReceivedId: null },
        { lastReceivedId: Number.MAX_SAFE_INTEGER + 1 },
        { sessionId: null },
        null,
        [],
        1,
      ]) {
        const res = await post(params)
        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({ error: 'invalid params' })
      }
      const nonFinite = await post(undefined, '{"lastReceivedId":1e400}')
      expect(nonFinite.status).toBe(400)
      expect(await nonFinite.json()).toEqual({ error: 'invalid params' })
      expect(calls).toBe(0)
    },
  )
})

test('pending defaults preserve absent cursor and empty string session', async () => {
  const calls: unknown[][] = []
  await fixture(
    {
      drain: (...args: unknown[]) => {
        calls.push(args)
        return []
      },
    },
    async (post) => {
      for (const params of [
        {},
        { sessionId: '' },
        { lastReceivedId: 3, sessionId: 's' },
      ]) {
        const res = await post(params)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ messages: [] })
      }
      expect(calls).toEqual([
        [0, undefined],
        [0, ''],
        [3, 's'],
      ])
    },
  )
})

test('pending custom parser sees raw params and controls refusal status', async () => {
  const seen: unknown[] = []
  const calls: unknown[][] = []
  await fixture(
    {
      parsePending: (body: unknown) => {
        seen.push(body)
        if (!body || typeof body !== 'object' || Array.isArray(body))
          throw new Error('invalid params')
        const params = body as Record<string, unknown>
        if (!('lastReceivedId' in params))
          throw new RpcRequestError(422, 'cursor required')
        if (params.lastReceivedId === 'bad')
          throw new Error('private parser detail')
        return {
          lastReceivedId: Number(params.lastReceivedId),
          sessionId: 'custom',
        }
      },
      drain: (...args: unknown[]) => {
        calls.push(args)
        return []
      },
    },
    async (post) => {
      const missing = await post({})
      expect(missing.status).toBe(422)
      expect(await missing.json()).toEqual({ error: 'cursor required' })
      const bad = await post({ lastReceivedId: 'bad' })
      expect(bad.status).toBe(400)
      expect(await bad.json()).toEqual({ error: 'invalid params' })
      expect((await post({ lastReceivedId: '7' })).status).toBe(200)
      expect(seen).toEqual([
        {},
        { lastReceivedId: 'bad' },
        { lastReceivedId: '7' },
      ])
      expect(calls).toEqual([[7, 'custom']])
    },
  )
})

test('pending async drain returns resolved messages', async () => {
  const messages = [
    { id: 1, payload: { command: 'notice', text: 'hello', knobs: {} } },
  ]
  const calls: unknown[][] = []
  await fixture(
    {
      drainAsync: async (...args: unknown[]) => {
        calls.push(args)
        return messages
      },
    },
    async (post) => {
      const res = await post({ lastReceivedId: 4, sessionId: 's' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ messages })
      expect(calls).toEqual([[4, 's']])
    },
  )
})

test('pending async rejection is sanitized and logged at warn', async () => {
  const warnings: string[] = []
  await fixture(
    {
      drainAsync: async () => {
        throw new RpcRequestError(409, 'secret drain detail')
      },
      log: { warn: (message: string) => warnings.push(message), debug() {} },
    },
    async (post) => {
      const res = await post({ sessionId: 's' })
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'drain failed' })
      expect(warnings).toEqual(['rpc notification drain failed'])
    },
  )
})

test('RPC server requires exactly one synchronous or asynchronous drain', async () => {
  const base = {
    dir: '/unused',
    isManagedDir: () => false,
    apply: async () => ({ text: '', knobs: {} }),
  }
  for (const extra of [{}, { drain: () => [], drainAsync: async () => [] }]) {
    await expect(
      startRpcServer({ ...base, ...extra } as unknown as Parameters<
        typeof startRpcServer
      >[0]),
    ).rejects.toThrow('exactly one of drain or drainAsync')
  }
})

test('pending custom parser receives non-object bodies before session checks', async () => {
  for (const handler of ['drain', 'drainAsync']) {
    const seen: unknown[] = []
    let calls = 0
    const drain = () => {
      calls++
      return []
    }
    await fixture(
      {
        requireSession: true,
        parsePending: (params: unknown) => {
          seen.push(params)
          throw new Error('private')
        },
        [handler]: handler === 'drain' ? drain : async () => drain(),
      },
      async (post) => {
        for (const params of [null, [], 1]) {
          const res = await post(params)
          expect(res.status).toBe(400)
          expect(await res.json()).toEqual({ error: 'invalid params' })
        }
        expect(seen).toEqual([null, [], 1])
        expect(calls).toBe(0)
      },
    )
  }
})
