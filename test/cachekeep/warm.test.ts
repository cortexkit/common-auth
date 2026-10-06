import { beforeEach, describe, expect, mock } from 'bun:test'
import type { CacheKeepProfile } from '../../src/cachekeep/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import {
  body,
  DUE_MS,
  delay,
  fakeNow,
  LEAD_MS,
  makeManager,
  sessions,
  TTL_MS,
} from './helpers.js'

const hooks = lifetimeHooks()
const { test } = hooks

const BACKOFF_MS = 10 * 60_000
const LONG_TTL = 30 * 60_000
const LONG_DUE = LONG_TTL - LEAD_MS + 1000

/**
 * A plugin profile for a model whose provider cache lives 30 minutes: that
 * TTL for every session, and for subagents a two-warm cap with an idle bound
 * long enough for both warms (openai-auth's policy for such a model).
 */
function longCacheProfile(input: {
  bodyText: string
  isSubagent: boolean
}): CacheKeepProfile | undefined {
  let model: unknown
  try {
    model = JSON.parse(input.bodyText).model
  } catch {
    return undefined
  }
  if (model !== 'long-cache') return undefined
  return input.isSubagent
    ? { ttlMs: LONG_TTL, maxWarms: 2, maxIdleMs: 2 * LONG_TTL + 15 * 60_000 }
    : { ttlMs: LONG_TTL }
}

const longBody = (input: string) => body(input, { model: 'long-cache' })

let clock: ReturnType<typeof fakeNow>
beforeEach(() => {
  clock = fakeNow()
})

describe('CacheKeepManager tick/prewarm', () => {
  test('idle cap prunes targets even when active backoff would otherwise skip pruning', async () => {
    const { mgr } = makeManager(
      clock,
      { ttlMs: 100, leadMs: 90, maxIdleWarmMs: 1000 },
      { send: async () => new Response('{}', { status: 500 }) },
    )
    mgr.track({ sessionKey: 'sess-backoff', bodyText: body('test') })
    clock.advance(20)
    await mgr.tick()
    expect(mgr.status().targets[0]!.backoffUntil).toBeDefined()

    clock.advance(1001)
    await mgr.tick()
    expect(mgr.status().tracked).toBe(0)
  })

  test('idle cap prunes expired-backoff targets before retrying warm', async () => {
    let calls = 0
    const { mgr, send } = makeManager(
      clock,
      { ttlMs: 100, leadMs: 90, maxIdleWarmMs: 1000 },
      {
        send: async () => {
          calls++
          return new Response('{}', { status: calls === 1 ? 500 : 200 })
        },
      },
    )
    mgr.track({ sessionKey: 'sess-backoff', bodyText: body('test') })
    clock.advance(20)
    await mgr.tick()
    expect(send).toHaveBeenCalledTimes(1)

    clock.advance(BACKOFF_MS + 1)
    await mgr.tick()
    expect(send).toHaveBeenCalledTimes(1)
    expect(mgr.status().tracked).toBe(0)
  })

  test('track self-arms an unstarted manager and the timer fires a due target', async () => {
    const { mgr, send } = makeManager(clock, {
      ttlMs: 100,
      leadMs: 90,
      tickIntervalMs: 5,
    })
    try {
      mgr.track({ sessionKey: 'sess-self-arm', bodyText: body('test') })
      expect(mgr.status().running).toBe(true)
      clock.advance(20)
      await delay(30)
      expect(send).toHaveBeenCalledTimes(1)
    } finally {
      mgr.stop()
    }
  })

  test('track-driven start is idempotent and does not bump startedAt', () => {
    const intervals: unknown[] = []
    const { mgr } = makeManager(clock, {
      setIntervalImpl: ((handler: () => void, ms: number) => {
        intervals.push(ms)
        return setInterval(handler, 1_000_000)
      }) as typeof setInterval,
    })
    try {
      mgr.track({ sessionKey: 'sess-1', bodyText: body('first') })
      const startedAt = mgr.status().startedAt
      expect(startedAt).toBe(clock.now())
      clock.advance(60_000)
      mgr.track({ sessionKey: 'sess-2', bodyText: body('second') })
      mgr.start()
      expect(mgr.status().startedAt).toBe(startedAt)
      expect(intervals).toEqual([60_000])
    } finally {
      mgr.stop()
    }
  })

  test('status running reflects the actual timer presence', () => {
    const { mgr } = makeManager(clock)
    expect(mgr.status().running).toBe(false)
    mgr.track({ sessionKey: 'sess-1', bodyText: body('test') })
    expect(mgr.status().running).toBe(true)
    mgr.stop()
    expect(mgr.status().running).toBe(false)
  })

  test('fires prewarm only within LEAD window of cacheExpiresAt', async () => {
    const { mgr, send } = makeManager(clock)
    mgr.track({ sessionKey: 'sess-1', bodyText: body('test') })
    clock.advance(TTL_MS - LEAD_MS - 1000)
    await mgr.tick()
    expect(send).not.toHaveBeenCalled()

    clock.advance(2000)
    await mgr.tick()
    expect(send).toHaveBeenCalledTimes(1)
    expect(JSON.parse(send.mock.calls[0]![0].body)).toEqual({
      input: 'test',
      warm: true,
    })
  })

  test('backoff suppresses prewarm after failure', async () => {
    const { mgr, send } = makeManager(
      clock,
      {},
      {
        send: async () => {
          throw new Error('network error')
        },
      },
    )
    mgr.track({ sessionKey: 'sess-1', bodyText: body('test') })
    clock.advance(DUE_MS)
    await mgr.tick()
    expect(send).toHaveBeenCalledTimes(1)
    expect(mgr.status().targets[0]!.backoffUntil).toBe(clock.now() + BACKOFF_MS)

    clock.advance(1000)
    await mgr.tick()
    expect(send).toHaveBeenCalledTimes(1)
  })

  test('prewarm fires again after backoff expires', async () => {
    // The backoff ends inside the cache lifetime, so the retry still keeps
    // a warm cache alive.
    let calls = 0
    const { mgr, send } = makeManager(
      clock,
      { backoffMs: 2000 },
      {
        send: async () => {
          calls++
          if (calls === 1) throw new Error('fail')
          return new Response('{}')
        },
      },
    )
    mgr.track({ sessionKey: 'sess-1', bodyText: body('test') })
    clock.advance(DUE_MS)
    await mgr.tick()
    expect(send).toHaveBeenCalledTimes(1)

    clock.advance(1000)
    await mgr.tick()
    expect(send).toHaveBeenCalledTimes(1)

    clock.advance(1500)
    await mgr.tick()
    expect(send).toHaveBeenCalledTimes(2)
    expect(mgr.status().targets[0]!.backoffUntil).toBeUndefined()
  })

  test('a failed warm is never retried after the confirmed cache lifetime ends, even with sustain', async () => {
    const start = clock.now()
    const { mgr, send, log } = makeManager(
      clock,
      { ttlMs: 1000, leadMs: 150, getSustain: () => true },
      {
        send: async () => {
          throw new Error('network error')
        },
      },
    )
    mgr.track({ sessionKey: 'sess-1', bodyText: body('test') })
    expect(mgr.status().targets[0]!.cacheExpiresAt).toBe(start + 1000)

    clock.advance(900)
    await mgr.tick()
    expect(send).toHaveBeenCalledTimes(1)
    // The default backoff (10 minutes) ends long after the cache expires.
    clock.advance(BACKOFF_MS + 100)
    await mgr.tick()
    clock.advance(BACKOFF_MS)
    await mgr.tick()
    expect(send).toHaveBeenCalledTimes(1)
    expect(mgr.status().tracked).toBe(0)
    expect(mgr.status().totalBytes).toBe(0)
    expect(log.debug.mock.calls.map((call) => call[0])).toContain(
      'cachekeep retired target (cache lifetime ended)',
    )
  })

  test('a retry due exactly at the cache expiry is not sent', async () => {
    const start = clock.now()
    const { mgr, send } = makeManager(
      clock,
      { ttlMs: 1000, leadMs: 150, backoffMs: 100 },
      { send: async () => new Response('{}', { status: 503 }) },
    )
    mgr.track({ sessionKey: 'sess-1', bodyText: body('test') })
    clock.advance(900)
    await mgr.tick()
    expect(send).toHaveBeenCalledTimes(1)
    clock.advance(100)
    expect(clock.now()).toBe(start + 1000)
    await mgr.tick()
    expect(send).toHaveBeenCalledTimes(1)
    expect(mgr.status().tracked).toBe(0)
  })

  test('a target whose lifetime ended during an earlier warm in the same tick is retired without building its body', async () => {
    const built: string[] = []
    const { mgr, send } = makeManager(
      clock,
      { ttlMs: 1000, leadMs: 300 },
      {
        buildBody: async (target) => {
          built.push(target.sessionKey)
          clock.advance(200)
          return target.bodyText
        },
      },
    )
    mgr.track({ sessionKey: 'first', bodyText: body('a') })
    clock.advance(50)
    mgr.track({ sessionKey: 'second', bodyText: body('b') })
    // At 850 both are due (expiries 1000 and 1050). Building the first body
    // takes until 1050, which ends both lifetimes: the first is not sent and
    // the second is retired before its body is built.
    clock.advance(800)
    await mgr.tick()
    expect(built).toEqual(['first'])
    expect(send).not.toHaveBeenCalled()
    expect(mgr.status().tracked).toBe(0)
  })

  test('a lifetime that ends while the replay body is being built sends nothing', async () => {
    const { mgr, send } = makeManager(
      clock,
      { ttlMs: 1000, leadMs: 150 },
      {
        buildBody: async (target) => {
          clock.advance(200)
          return target.bodyText
        },
      },
    )
    mgr.track({ sessionKey: 'sess-1', bodyText: body('test') })
    clock.advance(900)
    await mgr.tick()
    expect(send).not.toHaveBeenCalled()
    expect(mgr.status().tracked).toBe(0)
  })

  test('does not reenter tick while a previous prewarm is still in flight', async () => {
    let resolveSend!: (response: Response) => void
    const { mgr, send } = makeManager(
      clock,
      {},
      {
        send: () =>
          new Promise<Response>((resolve) => {
            resolveSend = resolve
          }),
      },
    )
    mgr.track({ sessionKey: 'sess-1', bodyText: body('test') })
    clock.advance(DUE_MS)

    const firstTick = mgr.tick()
    await delay(0)
    const secondTick = mgr.tick()
    await delay(0)
    expect(send).toHaveBeenCalledTimes(1)
    resolveSend(new Response('{}'))
    await Promise.all([firstTick, secondTick])
    expect(send).toHaveBeenCalledTimes(1)
  })

  test('sets backoff for malformed captured bodies and continues warming other targets', async () => {
    const { mgr, send } = makeManager(clock)
    mgr.track({ sessionKey: 'bad', bodyText: '{not-json' })
    mgr.track({ sessionKey: 'good', bodyText: body('test') })
    clock.advance(DUE_MS)
    await mgr.tick()

    const status = mgr.status()
    expect(send).toHaveBeenCalledTimes(1)
    expect(
      status.targets.find((t) => t.sessionKey === 'bad')!.backoffUntil,
    ).toBe(clock.now() + BACKOFF_MS)
    expect(
      status.targets.find((t) => t.sessionKey === 'good')!.lastWarmedAt,
    ).toBe(clock.now())
  })

  test('stays armed across an idle tick and later warms a captured request', async () => {
    const { mgr, send } = makeManager(clock)
    mgr.start()
    try {
      await mgr.tick()
      expect(mgr.status().running).toBe(true)
      mgr.track({ sessionKey: 'sess-1', bodyText: body('test') })
      clock.advance(DUE_MS)
      await mgr.tick()
      expect(send).toHaveBeenCalledTimes(1)
      expect(mgr.status().running).toBe(true)
    } finally {
      mgr.stop()
    }
  })

  test('tick prunes expired targets without disarming cachekeep', async () => {
    const { mgr } = makeManager(clock, { maxIdleWarmMs: 60_000 })
    mgr.start()
    try {
      mgr.track({ sessionKey: 'sess-1', bodyText: body('test') })
      clock.advance(60_001)
      await mgr.tick()
      expect(mgr.status().tracked).toBe(0)
      expect(mgr.status().running).toBe(true)
    } finally {
      mgr.stop()
    }
  })

  test('per-target idle cap prunes old captures while cachekeep stays enabled', async () => {
    const { mgr } = makeManager(clock, { maxIdleWarmMs: 1000 })
    try {
      mgr.track({ sessionKey: 'sess-1', bodyText: body('test') })
      expect(mgr.status().running).toBe(true)
      clock.advance(1001)
      await mgr.tick()
      expect(mgr.status().running).toBe(true)
      expect(mgr.status().tracked).toBe(0)
    } finally {
      mgr.stop()
    }
  })

  test('a real request after the idle cap resumes warming', async () => {
    const { mgr, send } = makeManager(clock, {
      ttlMs: 100,
      leadMs: 90,
      maxIdleWarmMs: 1000,
    })
    mgr.track({ sessionKey: 'sess-1', bodyText: body('old') })
    clock.advance(1001)
    await mgr.tick()
    expect(mgr.status().tracked).toBe(0)

    mgr.track({ sessionKey: 'sess-1', bodyText: body('new') })
    clock.advance(20)
    await mgr.tick()
    expect(send).toHaveBeenCalledTimes(1)
  })

  test('on success: resets cacheExpiresAt and lastWarmedAt', async () => {
    const { mgr } = makeManager(clock)
    mgr.track({ sessionKey: 'sess-1', bodyText: body('test') })
    const originalExpiry = clock.now() + TTL_MS
    clock.advance(DUE_MS)
    await mgr.tick()

    const target = mgr.status().targets[0]!
    expect(target.cacheExpiresAt).toBe(clock.now() + TTL_MS)
    expect(target.cacheExpiresAt).toBeGreaterThan(originalExpiry)
    expect(target.lastWarmedAt).toBe(clock.now())
    expect(target.warmCount).toBe(1)
  })

  test('backs off on non-2xx responses without resetting expiry', async () => {
    const { mgr, log } = makeManager(
      clock,
      {},
      { send: async () => new Response('bad', { status: 500 }) },
    )
    mgr.track({ sessionKey: 'sess-1', bodyText: body('test') })
    const originalExpiry = mgr.status().targets[0]!.cacheExpiresAt
    clock.advance(DUE_MS)
    await mgr.tick()

    const target = mgr.status().targets[0]!
    expect(target.cacheExpiresAt).toBe(originalExpiry)
    expect(target.backoffUntil).toBe(clock.now() + BACKOFF_MS)
    expect(target.warmCount).toBe(0)
    expect(log.warn).toHaveBeenCalledWith(
      'cachekeep failed',
      expect.objectContaining({ status: 500, responseBody: 'bad' }),
    )
  })

  test('logs cost from mock usage', async () => {
    const readUsage = mock(({ text }: { text: string }) => {
      const usage = JSON.parse(text).usage
      return {
        input_tokens: usage.input_tokens,
        cached_tokens: usage.cached,
        hit_rate: usage.cached / usage.input_tokens,
      }
    })
    const { mgr, log } = makeManager(
      clock,
      {},
      {
        send: async () =>
          new Response(
            JSON.stringify({ usage: { input_tokens: 5000, cached: 4900 } }),
          ),
        readUsage,
      },
    )
    mgr.track({ sessionKey: 'sess-1', bodyText: body('test') })
    clock.advance(DUE_MS)
    await mgr.tick()

    expect(readUsage).toHaveBeenCalledTimes(1)
    expect(log.debug).toHaveBeenCalledWith(
      'cachekeep fired',
      expect.objectContaining({
        sessionKey: 'sess-1',
        input_tokens: 5000,
        cached_tokens: 4900,
        hit_rate: 0.98,
      }),
    )
  })

  test('a usage reader that throws never fails a warm that worked', async () => {
    const { mgr } = makeManager(
      clock,
      {},
      {
        readUsage: () => {
          throw new Error('unparseable usage')
        },
      },
    )
    mgr.track({ sessionKey: 'sess-1', bodyText: body('test') })
    clock.advance(DUE_MS)
    await mgr.tick()
    const target = mgr.status().targets[0]!
    expect(target.backoffUntil).toBeUndefined()
    expect(target.lastWarmedAt).toBe(clock.now())
  })

  test('sends cache-relevant captured headers on warm requests', async () => {
    const { mgr, send } = makeManager(clock)
    mgr.track({
      sessionKey: 'sess-1',
      bodyText: body('test'),
      accountId: 'acct-1',
      meta: { headers: { 'session-id': 'sess-1', version: '1.2.3' } },
    })
    clock.advance(DUE_MS)
    await mgr.tick()

    const input = send.mock.calls[0]![0]
    expect(input.signal).toBeInstanceOf(AbortSignal)
    expect(input.target).toMatchObject({
      sessionKey: 'sess-1',
      accountId: 'acct-1',
      isSubagent: false,
      meta: { headers: { 'session-id': 'sess-1', version: '1.2.3' } },
    })
  })

  test('prewarm drains the response body without canceling a locked body', async () => {
    let drained = false
    const { mgr } = makeManager(
      clock,
      {},
      {
        send: async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.enqueue(new TextEncoder().encode('{}'))
                controller.close()
                drained = true
              },
              cancel() {
                throw new Error('cancel must not be called')
              },
            }),
          ),
      },
    )
    mgr.track({ sessionKey: 'sess-1', bodyText: body('test') })
    clock.advance(DUE_MS)
    await mgr.tick()
    expect(drained).toBe(true)
    expect(mgr.status().targets[0]!.lastWarmedAt).toBe(clock.now())
  })

  test('a backoff function receives the consecutive failure count and success resets it', async () => {
    let fail = true
    const seen: number[] = []
    const { mgr } = makeManager(
      clock,
      {
        leadMs: 60_000,
        backoffMs: ({ failures }) => {
          seen.push(failures)
          return 1000 * 2 ** failures
        },
      },
      {
        send: async () => new Response('{}', { status: fail ? 503 : 200 }),
      },
    )
    mgr.track({ sessionKey: 'sess-1', bodyText: body('test') })
    // Due early enough that both retries fall inside the cache lifetime.
    clock.advance(TTL_MS - 30_000)
    await mgr.tick()
    expect(mgr.status().targets[0]!.backoffUntil).toBe(clock.now() + 2000)
    clock.advance(2000)
    await mgr.tick()
    expect(mgr.status().targets[0]!.backoffUntil).toBe(clock.now() + 4000)
    expect(seen).toEqual([1, 2])

    fail = false
    clock.advance(4000)
    await mgr.tick()
    expect(mgr.status().targets[0]!.failures).toBe(0)
  })
})

describe('CacheKeepManager per-model profile', () => {
  test('profile ttlMs sets a per-target cacheExpiresAt; other bodies keep the default', () => {
    const { mgr } = makeManager(clock, {}, { profile: longCacheProfile })
    mgr.track({ sessionKey: 'long', bodyText: longBody('a') })
    mgr.track({ sessionKey: 'short', bodyText: body('b', { model: 'other' }) })
    const [long, short] = mgr.status().targets
    expect(long!.cacheExpiresAt).toBe(clock.now() + LONG_TTL)
    expect(short!.cacheExpiresAt).toBe(clock.now() + TTL_MS)
  })

  test('profile is evaluated once at track() and kept on the target', async () => {
    const profile = mock(longCacheProfile)
    const { mgr } = makeManager(clock, {}, { profile })
    mgr.track({ sessionKey: 'long', bodyText: longBody('a') })
    mgr.track({ sessionKey: 'malformed', bodyText: '{not-json' })
    expect(profile).toHaveBeenCalledTimes(2)
    // A tick that tries to warm the default-lifetime target, inside both
    // targets' lifetimes.
    clock.advance(DUE_MS)
    await mgr.tick()
    expect(profile).toHaveBeenCalledTimes(2)
    expect(mgr.status().targets.map((t) => t.ttlMs)).toEqual([LONG_TTL, TTL_MS])
  })

  test('post-warm reset uses the per-target TTL', async () => {
    const { mgr } = makeManager(clock, {}, { profile: longCacheProfile })
    mgr.track({ sessionKey: 'long', bodyText: longBody('a') })
    clock.advance(LONG_DUE)
    await mgr.tick()
    expect(mgr.status().targets[0]!.cacheExpiresAt).toBe(clock.now() + LONG_TTL)
  })

  test('a capped subagent warms exactly maxWarms times then is dropped from the map', async () => {
    const { mgr, send } = makeManager(
      clock,
      { maxSubagentIdleMs: 60 * 60_000, getSustain: () => true },
      { profile: longCacheProfile },
    )
    mgr.track({ sessionKey: 'sub', bodyText: longBody('s'), isSubagent: true })

    clock.advance(LONG_DUE)
    await mgr.tick()
    expect(send).toHaveBeenCalledTimes(1)
    expect(mgr.status().tracked).toBe(1)

    clock.advance(LONG_DUE)
    await mgr.tick()
    expect(send).toHaveBeenCalledTimes(2)
    expect(mgr.status().tracked).toBe(0)
    expect(mgr.status().totalBytes).toBe(0)

    clock.advance(LONG_DUE)
    await mgr.tick()
    expect(send).toHaveBeenCalledTimes(2)
  })

  test('a profile idle bound outlives the subagent default so the warm cap governs', async () => {
    const { mgr, send } = makeManager(
      clock,
      { maxSubagentIdleMs: 30 * 60_000 },
      { profile: longCacheProfile },
    )
    mgr.track({ sessionKey: 'sub', bodyText: longBody('s'), isSubagent: true })
    // Warmed inside its 30-minute lifetime, then past the 30-minute subagent
    // default idle cap: the profile's longer idle bound keeps it.
    clock.advance(LONG_DUE)
    await mgr.tick()
    clock.advance(31 * 60_000 - LONG_DUE)
    await mgr.tick()
    expect(mgr.status().tracked).toBe(1)
    expect(send).toHaveBeenCalledTimes(1)
  })

  test('a capped subagent stuck on failing warms is reclaimed when its cache lifetime ends, before its profile idle bound', async () => {
    const { mgr, send } = makeManager(
      clock,
      { maxSubagentIdleMs: 30 * 60_000 },
      {
        profile: longCacheProfile,
        send: async () => new Response('fail', { status: 500 }),
      },
    )
    mgr.track({
      sessionKey: 'stuck',
      bodyText: longBody('s'),
      isSubagent: true,
    })
    clock.advance(LONG_DUE)
    await mgr.tick()
    expect(send).toHaveBeenCalledTimes(1)
    clock.advance(LONG_TTL - LONG_DUE - 1)
    mgr.track({ sessionKey: 'trigger', bodyText: body('t') })
    expect(sessions(mgr)).toEqual(['stuck', 'trigger'])

    // Its 75-minute idle bound is far off, but its cache has expired.
    clock.advance(1)
    mgr.track({ sessionKey: 'trigger', bodyText: body('t') })
    expect(sessions(mgr)).toEqual(['trigger'])
    expect(send).toHaveBeenCalledTimes(1)
  })

  test('a subagent without a profile idle bound is idle-pruned at maxSubagentIdleMs', () => {
    const { mgr } = makeManager(
      clock,
      { maxSubagentIdleMs: 30 * 60_000 },
      { profile: longCacheProfile },
    )
    mgr.track({
      sessionKey: 'sub',
      bodyText: body('s', { model: 'other' }),
      isSubagent: true,
    })
    clock.advance(31 * 60_000)
    mgr.track({ sessionKey: 'other', bodyText: body('o') })
    expect(sessions(mgr)).toEqual(['other'])
  })

  test('a main target without a warm cap is not dropped after repeated warms', async () => {
    const { mgr, send } = makeManager(
      clock,
      { maxIdleWarmMs: 60 * 60_000 },
      { profile: longCacheProfile },
    )
    mgr.track({ sessionKey: 'main', bodyText: longBody('m') })
    clock.advance(LONG_DUE)
    await mgr.tick()
    clock.advance(LONG_DUE)
    await mgr.tick()
    expect(send).toHaveBeenCalledTimes(2)
    expect(sessions(mgr)).toEqual(['main'])
  })

  test('warmCount resets when track() re-captures the same subagent session', async () => {
    const { mgr, send } = makeManager(
      clock,
      { maxSubagentIdleMs: 60 * 60_000 },
      { profile: longCacheProfile },
    )
    const sub = longBody('s')
    mgr.track({ sessionKey: 'sub', bodyText: sub, isSubagent: true })
    clock.advance(LONG_DUE)
    await mgr.tick()
    expect(send).toHaveBeenCalledTimes(1)

    mgr.track({ sessionKey: 'sub', bodyText: sub, isSubagent: true })
    expect(mgr.status().targets[0]!.warmCount).toBe(0)
    clock.advance(LONG_DUE)
    await mgr.tick()
    expect(send).toHaveBeenCalledTimes(2)
    expect(mgr.status().tracked).toBe(1)
  })
})

describe('CacheKeepManager token resolution', () => {
  test('skips warm and sets backoff if no token resolves', async () => {
    // A plugin resolves the credential inside send; failing to find one is a
    // throw before any request leaves.
    const network = mock(async () => new Response('{}'))
    const { mgr } = makeManager(
      clock,
      {},
      {
        send: async () => {
          throw new Error('no token')
          // biome-ignore lint/correctness/noUnreachable: documents the skipped request
          return network()
        },
      },
    )
    mgr.track({ sessionKey: 'sess-1', bodyText: body('test') })
    clock.advance(DUE_MS)
    await mgr.tick()
    expect(network).not.toHaveBeenCalled()
    expect(mgr.status().targets[0]!.backoffUntil).toBe(clock.now() + BACKOFF_MS)
  })

  test('stop/dispose aborts in-flight warm and prevents mutating removed targets', async () => {
    let resolveSend!: (response: Response) => void
    let signal!: AbortSignal
    let sendCalled!: () => void
    const called = new Promise<void>((resolve) => {
      sendCalled = resolve
    })
    const { mgr, log } = makeManager(
      clock,
      {},
      {
        send: (input) =>
          new Promise<Response>((resolve) => {
            signal = input.signal
            resolveSend = resolve
            sendCalled()
          }),
      },
    )
    mgr.track({ sessionKey: 'sess-1', bodyText: body('test') })
    clock.advance(DUE_MS)
    const tickPromise = mgr.tick()
    await called
    mgr.stop()
    expect(signal.aborted).toBe(true)

    resolveSend(new Response('{}'))
    await tickPromise
    expect(mgr.status().tracked).toBe(0)
    expect(log.debug).not.toHaveBeenCalledWith(
      'cachekeep fired',
      expect.anything(),
    )
  })
})

describe('CacheKeepManager active account', () => {
  test('skips the warm and drops the target when the session now routes to another account', async () => {
    const { mgr, send } = makeManager(
      clock,
      {},
      { activeAccount: () => 'acct-new' },
    )
    mgr.track({
      sessionKey: 'moved',
      bodyText: body('m'),
      accountId: 'acct-old',
    })
    clock.advance(DUE_MS)
    await mgr.tick()
    expect(send).not.toHaveBeenCalled()
    expect(mgr.status().tracked).toBe(0)
  })

  test('warms when the active account matches or the plugin reports none', async () => {
    const active = new Map([['same', 'acct-1']])
    const activeAccount = mock((sessionKey: string) => active.get(sessionKey))
    const { mgr, send } = makeManager(clock, {}, { activeAccount })
    mgr.track({ sessionKey: 'same', bodyText: body('s'), accountId: 'acct-1' })
    mgr.track({
      sessionKey: 'unbound',
      bodyText: body('u'),
      accountId: 'acct-2',
    })
    clock.advance(DUE_MS)
    await mgr.tick()
    expect(activeAccount).toHaveBeenCalledTimes(2)
    expect(send.mock.calls.map(([input]) => input.target.accountId)).toEqual([
      'acct-1',
      'acct-2',
    ])
  })

  test('backs off when the active account cannot be resolved', async () => {
    const { mgr, send } = makeManager(
      clock,
      {},
      {
        activeAccount: async () => {
          throw new Error('routing state unavailable')
        },
      },
    )
    mgr.track({
      sessionKey: 'sess-1',
      bodyText: body('s'),
      accountId: 'acct-1',
    })
    clock.advance(DUE_MS)
    await mgr.tick()
    expect(send).not.toHaveBeenCalled()
    expect(mgr.status().targets[0]!.backoffUntil).toBe(clock.now() + BACKOFF_MS)
  })
})
