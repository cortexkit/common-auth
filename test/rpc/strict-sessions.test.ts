import { describe, expect } from 'bun:test'
import { rm } from 'node:fs/promises'
import {
  drainNotifications,
  isManagedRpcStateDir,
  pushNotification,
  type RpcNotification,
  RpcSessionRequiredError,
  resetNotificationsForTest,
  startRpcServer,
} from '../../src/rpc/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { makeTempDir } from '../fixtures/scratch'

const hooks = lifetimeHooks()
const { afterEach, test } = hooks

const strict = {
  rpcRoot: '/fixture-strict',
  directoryPrefix: 'fixture-',
  registrationSessionId: 'registration',
  requireSession: true,
}
const lenient = { ...strict, requireSession: false }
const payload = (text: string) => ({
  command: 'fixture-quota',
  text,
  knobs: {},
})

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
  resetNotificationsForTest(strict)
  resetNotificationsForTest(lenient)
})

async function strictServer() {
  const dir = await makeTempDir('fixture-strict-')
  const drained: Array<string | undefined> = []
  const server = await startRpcServer({
    dir,
    isManagedDir: (name) => isManagedRpcStateDir(name, 'fixture-'),
    requireSession: true,
    drain: (id, sessionId) => {
      drained.push(sessionId)
      return drainNotifications(strict, id, sessionId)
    },
    apply: async () => ({ text: 'ok', knobs: {} }),
  })
  cleanups.push(async () => {
    await server.stop()
    await rm(dir, { recursive: true, force: true })
  })
  const drain = async (body: Record<string, unknown>) => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/rpc/pending-notifications`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${server.token}`,
        },
        body: JSON.stringify(body),
      },
    )
    return {
      status: res.status,
      body: (await res.json()) as {
        messages?: RpcNotification[]
        error?: string
      },
    }
  }
  return { drain, drained }
}

const texts = (messages: RpcNotification[] | undefined) =>
  (messages ?? []).map((n) => n.payload.text)

describe('strict notification sessions', () => {
  test('a strict scope refuses a push or drain with an absent or empty session', () => {
    for (const session of [undefined, ''])
      expect(() => pushNotification(strict, payload('x'), session)).toThrow(
        RpcSessionRequiredError,
      )
    for (const session of [undefined, ''])
      expect(() => drainNotifications(strict, 0, session)).toThrow(
        RpcSessionRequiredError,
      )
  })

  test('in one process, a strict drain returns only its own session, never another or a lenient push', () => {
    pushNotification(strict, payload('a1'), 'session-a')
    pushNotification(strict, payload('b1'), 'session-b')
    // The same scope without the flag is a different queue: an unscoped
    // push there cannot reach a strict session.
    pushNotification(lenient, payload('everyone'))
    expect(texts(drainNotifications(strict, 0, 'session-a'))).toEqual(['a1'])
    expect(texts(drainNotifications(strict, 0, 'session-b'))).toEqual(['b1'])
    expect(texts(drainNotifications(lenient, 0))).toEqual(['everyone'])
  })

  test('across two strict servers, each session drains only its own notifications and a session-less drain is refused before reaching the queue', async () => {
    const one = await strictServer()
    const two = await strictServer()
    pushNotification(strict, payload('a1'), 'session-a')
    pushNotification(strict, payload('b1'), 'session-b')

    for (const server of [one, two])
      for (const body of [
        { lastReceivedId: 0 },
        { lastReceivedId: 0, sessionId: '' },
        { lastReceivedId: 0, sessionId: 7 },
      ]) {
        const refused = await server.drain(body)
        expect(refused.status).toBe(400)
        expect(refused.body).toEqual({ error: 'session required' })
      }
    expect(one.drained).toEqual([])
    expect(two.drained).toEqual([])

    const a = await one.drain({ lastReceivedId: 0, sessionId: 'session-a' })
    const b = await two.drain({ lastReceivedId: 0, sessionId: 'session-b' })
    expect(texts(a.body.messages)).toEqual(['a1'])
    expect(texts(b.body.messages)).toEqual(['b1'])
    // session-a acknowledging up to session-b's notice id, through server
    // two, prunes only session-a's notices: session-b still gets its own.
    const lastB = b.body.messages?.[0]?.id ?? 0
    await two.drain({ lastReceivedId: lastB, sessionId: 'session-a' })
    expect(
      texts(
        (await one.drain({ lastReceivedId: 0, sessionId: 'session-b' })).body
          .messages,
      ),
    ).toEqual(['b1'])
  })

  test('a handler failure answers 500 with a fixed code, not the exception text', async () => {
    const dir = await makeTempDir('fixture-strict-')
    const warned: unknown[] = []
    const server = await startRpcServer({
      dir,
      isManagedDir: (name) => isManagedRpcStateDir(name, 'fixture-'),
      log: { warn: (_message, data) => void warned.push(data), debug() {} },
      drain: () => [],
      apply: async () => {
        throw new Error('upstream refused Bearer synthetic-rpc-secret')
      },
    })
    cleanups.push(async () => {
      await server.stop()
      await rm(dir, { recursive: true, force: true })
    })
    const res = await fetch(`http://127.0.0.1:${server.port}/rpc/apply`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${server.token}`,
      },
      body: JSON.stringify({ command: 'fixture-quota', arguments: '' }),
    })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal error' })
    expect(JSON.stringify(warned)).toContain('upstream refused')
  })
})
