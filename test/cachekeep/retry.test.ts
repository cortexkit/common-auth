import { describe, expect, mock } from 'bun:test'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { body, fakeNow, makeManager } from './helpers.js'

const hooks = lifetimeHooks()
const { test } = hooks
const LONG_BACKOFF = 600_000
const managers = new Set<ReturnType<typeof makeManager>['mgr']>()
hooks.afterEach(() => {
  for (const manager of managers) manager.stop()
  managers.clear()
})

function harness(
  options: Parameters<typeof makeManager>[1] = {},
  adapter: Parameters<typeof makeManager>[2] = {},
) {
  const clock = fakeNow()
  const timers = new Map<
    ReturnType<typeof setInterval>,
    { callback: () => unknown; due: number; interval: number }
  >()
  const handles: { unref: ReturnType<typeof mock> }[] = []
  const result = makeManager(
    clock,
    {
      leadMs: undefined,
      setIntervalImpl: ((callback: () => unknown, interval: number) => {
        const handle = { unref: mock(() => {}) }
        handles.push(handle)
        const id = handle as unknown as ReturnType<typeof setInterval>
        timers.set(id, { callback, due: clock.now() + interval, interval })
        return id
      }) as typeof setInterval,
      clearIntervalImpl: ((id: ReturnType<typeof setInterval>) => {
        timers.delete(id)
      }) as typeof clearInterval,
      ...options,
    },
    adapter,
  )
  managers.add(result.mgr)
  async function advance(ms: number) {
    const until = clock.now() + ms
    for (;;) {
      const next = [...timers.values()]
        .filter((timer) => timer.due <= until)
        .sort((a, b) => a.due - b.due)[0]
      if (!next) break
      clock.advance(Math.max(0, next.due - clock.now()))
      next.due = clock.now() + next.interval
      await next.callback()
      await result.mgr.tick()
    }
    clock.advance(Math.max(0, until - clock.now()))
  }
  return { ...result, clock, timers, handles, advance }
}

describe('CacheKeepManager default transient retries', () => {
  for (const ttlMs of [300_000, 1_800_000]) {
    test(`a first transient failure retries before expiry with a ${ttlMs}ms TTL`, async () => {
      let attempts = 0
      const { mgr, send, clock, advance, handles } = harness(
        { ttlMs },
        {
          send: async () => {
            if (++attempts === 1) throw new TypeError('temporary network error')
            return new Response('{}')
          },
        },
      )
      const start = clock.now()
      mgr.track({ sessionKey: 'retry', bodyText: body('test') })
      // The normal minute tick first observes the 75-second lead with 60 left.
      await advance(ttlMs - 60_000)
      expect(send).toHaveBeenCalledTimes(1)
      expect(mgr.status().targets[0]!.cacheExpiresAt).toBe(start + ttlMs)
      await advance(19_999)
      expect(send).toHaveBeenCalledTimes(1)
      await advance(1)
      expect(send).toHaveBeenCalledTimes(2)
      expect(clock.now()).toBeLessThan(start + ttlMs)
      expect(mgr.status().targets[0]!.cacheExpiresAt).toBe(clock.now() + ttlMs)
      expect(mgr.status().targets[0]!.failures).toBe(0)
      expect(mgr.status().targets[0]!.backoffUntil).toBeUndefined()
      expect(
        handles.every((handle) => handle.unref.mock.calls.length === 1),
      ).toBe(true)
    })
  }

  test('uses 20/40/60-second delays, caps at 60 seconds and resets on success', async () => {
    let attempts = 0
    const { mgr, send, clock, advance } = harness(
      { ttlMs: 1_800_000, leadMs: 300_000 },
      {
        send: async () =>
          new Response('{}', { status: ++attempts === 5 ? 200 : 503 }),
      },
    )
    mgr.track({ sessionKey: 'retry', bodyText: body('test') })
    await advance(1_500_000)
    const expiry = mgr.status().targets[0]!.cacheExpiresAt
    for (const delay of [20_000, 40_000, 60_000, 60_000]) {
      expect(mgr.status().targets[0]!.cacheExpiresAt).toBe(expiry)
      expect(mgr.status().targets[0]!.backoffUntil).toBe(clock.now() + delay)
      const before = send.mock.calls.length
      await advance(delay - 1)
      expect(send).toHaveBeenCalledTimes(before)
      await advance(1)
      expect(send).toHaveBeenCalledTimes(before + 1)
    }
    expect(mgr.status().targets[0]!.failures).toBe(0)
    expect(mgr.status().targets[0]!.warmCount).toBe(1)
    expect(mgr.status().targets[0]!.backoffUntil).toBeUndefined()
    expect(mgr.status().targets[0]!.cacheExpiresAt).toBe(
      clock.now() + 1_800_000,
    )
    clock.advance(1_500_000)
    await mgr.tick()
    expect(mgr.status().targets[0]!.failures).toBe(1)
    expect(mgr.status().targets[0]!.backoffUntil).toBe(clock.now() + 20_000)
  })

  for (const status of [408, 429, 500, 503, 599]) {
    test(`HTTP ${status} is transient`, async () => {
      const { mgr, send, advance } = harness(
        {},
        {
          send: async () => new Response('PRIVATE provider text', { status }),
        },
      )
      mgr.track({ sessionKey: 'retry', bodyText: body('test') })
      await advance(240_000)
      await advance(20_000)
      expect(send).toHaveBeenCalledTimes(2)
    })
  }

  for (const status of [301, 400, 401, 403, 404, 409, 422]) {
    test(`HTTP ${status} keeps the long backoff without a fast retry`, async () => {
      const { mgr, send, clock, advance, timers } = harness(
        {},
        {
          send: async () => new Response('PRIVATE provider text', { status }),
        },
      )
      mgr.track({ sessionKey: 'retry', bodyText: body('test') })
      await advance(240_000)
      expect(mgr.status().targets[0]!.backoffUntil).toBe(
        clock.now() + LONG_BACKOFF,
      )
      expect(timers.size).toBe(1)
      await advance(60_000)
      expect(send).toHaveBeenCalledTimes(1)
      expect(mgr.status().tracked).toBe(0)
    })
  }

  for (const warmTimeoutMs of [30_000, 45_000]) {
    test(`clips the final retry to expiry minus ${warmTimeoutMs}ms timeout and 5 seconds`, async () => {
      const { mgr, send, clock, timers } = harness(
        { warmTimeoutMs, leadMs: 90_000 },
        { send: async () => new Response('{}', { status: 503 }) },
      )
      mgr.track({ sessionKey: 'retry', bodyText: body('test') })
      const expiry = mgr.status().targets[0]!.cacheExpiresAt
      const deadline = expiry - warmTimeoutMs - 5_000
      clock.advance(deadline - clock.now() - 10_000)
      await mgr.tick()
      expect(mgr.status().targets[0]!.backoffUntil).toBe(deadline)
      const retry = [...timers.values()].find(
        (timer) => timer.interval === 10_000,
      )!
      clock.advance(10_000)
      await retry.callback()
      expect(send).toHaveBeenCalledTimes(2)
      expect(mgr.status().targets[0]!.cacheExpiresAt).toBe(expiry)
      expect(mgr.status().targets[0]!.backoffUntil).toBe(
        deadline + LONG_BACKOFF,
      )
      expect(timers.size).toBe(1)
      clock.advance(1)
      await mgr.tick()
      expect(send).toHaveBeenCalledTimes(2)
    })
  }

  test('a delayed retry timer cannot start after the last-start deadline', async () => {
    const { mgr, send, clock, advance, timers } = harness(
      {},
      {
        send: async () => new Response('{}', { status: 503 }),
      },
    )
    mgr.track({ sessionKey: 'retry', bodyText: body('test') })
    await advance(240_000)
    const retry = [...timers.values()].find(
      (timer) => timer.interval === 20_000,
    )!
    clock.advance(25_001)
    await retry.callback()
    expect(send).toHaveBeenCalledTimes(1)
    expect(timers.size).toBe(1)
  })

  test('rechecks the deadline after slow replay preparation', async () => {
    let builds = 0
    const { mgr, send, clock, advance } = harness(
      {},
      {
        buildBody: (target) => {
          if (++builds === 2) clock.advance(5_001)
          return target.bodyText
        },
        send: async () => new Response('{}', { status: 503 }),
      },
    )
    mgr.track({ sessionKey: 'retry', bodyText: body('test') })
    await advance(240_000)
    clock.advance(20_000)
    await mgr.tick()
    expect(builds).toBe(2)
    expect(send).toHaveBeenCalledTimes(1)
  })

  test('uses failure completion time without extending the cache clock', async () => {
    const { mgr, send, clock, advance, timers } = harness(
      {},
      {
        send: async () => {
          clock.advance(30_000)
          throw new DOMException('PRIVATE timeout detail', 'TimeoutError')
        },
      },
    )
    mgr.track({ sessionKey: 'retry', bodyText: body('test') })
    const expiry = mgr.status().targets[0]!.cacheExpiresAt
    // Drive this tick directly because the simulated send advances the clock.
    clock.advance(240_000)
    await mgr.tick()
    expect(send).toHaveBeenCalledTimes(1)
    expect(mgr.status().targets[0]!.cacheExpiresAt).toBe(expiry)
    expect(mgr.status().targets[0]!.backoffUntil).toBe(
      clock.now() + LONG_BACKOFF,
    )
    expect(timers.size).toBe(1)
    await advance(0)
    expect(send).toHaveBeenCalledTimes(1)
  })

  test('a custom backoff can still retry after the default deadline', async () => {
    const { mgr, send, clock, timers } = harness(
      { leadMs: 5_000, backoffMs: 1_000 },
      { send: async () => new Response('{}', { status: 503 }) },
    )
    mgr.track({ sessionKey: 'custom', bodyText: body('test') })
    clock.advance(296_000)
    await mgr.tick()
    expect(mgr.status().targets[0]!.backoffUntil).toBe(clock.now() + 1_000)
    expect(timers.size).toBe(1)
    clock.advance(1_000)
    await mgr.tick()
    expect(send).toHaveBeenCalledTimes(2)
    expect(mgr.status().targets[0]!.failures).toBe(2)
  })

  test('active-account lookup failures retry with safe authorization diagnostics', async () => {
    let lookups = 0
    const { mgr, send, log, advance } = harness(
      {},
      {
        activeAccount: async () => {
          if (++lookups === 1)
            throw Object.assign(new Error('PRIVATE credential'), {
              code: 'ECONNRESET',
            })
          return undefined
        },
      },
    )
    mgr.track({
      sessionKey: 'retry',
      bodyText: body('test'),
      accountId: 'account',
    })
    await advance(240_000)
    expect(send).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith(
      'cachekeep skip (active account unknown)',
      {
        sessionKey: 'retry',
        accountId: 'account',
        failures: 1,
        backoffUntil: expect.any(Number),
        stage: 'authorization',
        class: 'ECONNRESET',
      },
    )
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('PRIVATE')
    await advance(20_000)
    expect(send).toHaveBeenCalledTimes(1)
  })

  test('an unbuildable body is permanent and never logs error text', async () => {
    const { mgr, send, log, clock, advance, timers } = harness(
      {},
      {
        buildBody: () => {
          throw new Error('PRIVATE body')
        },
      },
    )
    mgr.track({ sessionKey: 'retry', bodyText: body('test') })
    await advance(240_000)
    expect(send).not.toHaveBeenCalled()
    expect(mgr.status().targets[0]!.backoffUntil).toBe(
      clock.now() + LONG_BACKOFF,
    )
    expect(log.warn).toHaveBeenCalledWith(
      'cachekeep skip (replay body unbuildable)',
      expect.objectContaining({ stage: 'authorization', class: 'unknown' }),
    )
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('PRIVATE')
    expect(timers.size).toBe(1)
  })

  for (const status of [200, 401, 503]) {
    test(`response-read failures retain HTTP ${status} and closed diagnostics`, async () => {
      const { mgr, log, clock, advance } = harness(
        {},
        {
          send: async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(new TypeError('PRIVATE response error'))
                },
              }),
              { status },
            ),
        },
      )
      mgr.track({ sessionKey: 'retry', bodyText: body('test') })
      const expiry = mgr.status().targets[0]!.cacheExpiresAt
      await advance(240_000)
      expect(mgr.status().targets[0]!.cacheExpiresAt).toBe(expiry)
      expect(mgr.status().targets[0]!.backoffUntil).toBe(
        clock.now() + (status === 401 ? LONG_BACKOFF : 20_000),
      )
      expect(log.warn).toHaveBeenCalledWith(
        'cachekeep failed',
        expect.objectContaining({
          stage: 'response',
          class: status === 200 ? 'TypeError' : status,
          status,
        }),
      )
      expect(JSON.stringify(log.warn.mock.calls)).not.toContain('PRIVATE')
    })
  }

  test('a failure that settles after stop cannot rearm retry timers', async () => {
    const pending = Promise.withResolvers<Response>()
    const { mgr, send, clock, timers } = harness(
      {},
      { send: () => pending.promise },
    )
    mgr.track({ sessionKey: 'retry', bodyText: body('test') })
    clock.advance(240_000)
    const tick = mgr.tick()
    for (let turn = 0; turn < 20 && send.mock.calls.length < 1; turn++)
      await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(1)
    mgr.stop()
    pending.reject(new TypeError('PRIVATE late failure'))
    await tick
    expect(timers.size).toBe(0)
    expect(mgr.status().tracked).toBe(0)
  })

  test('a retry wake-up waits for an in-flight tick instead of being lost', async () => {
    const pending = Promise.withResolvers<Response>()
    const { mgr, send, clock, timers } = harness(
      {},
      {
        send: async ({ target }) => {
          if (target.sessionKey === 'slow') return pending.promise
          return new Response('{}', { status: 503 })
        },
      },
    )
    mgr.track({ sessionKey: 'retry', bodyText: body('a') })
    mgr.track({ sessionKey: 'slow', bodyText: body('b') })
    clock.advance(240_000)
    const tick = mgr.tick()
    // Yield until the first failure has armed its retry and the second send is pending.
    for (let turn = 0; turn < 20 && send.mock.calls.length < 2; turn++)
      await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(2)
    const retry = [...timers.values()].find(
      (timer) => timer.interval === 20_000,
    )!
    clock.advance(20_000)
    const wake = retry.callback()
    expect(send).toHaveBeenCalledTimes(2)
    pending.resolve(new Response('{}'))
    await tick
    await wake
    expect(send.mock.calls.map(([input]) => input.target.sessionKey)).toEqual([
      'retry',
      'slow',
      'retry',
    ])
  })

  for (const cleanup of [
    'stop',
    'remove',
    'retrack',
    'evict',
    'expire',
  ] as const) {
    test(`${cleanup} clears a pending retry timer`, async () => {
      const { mgr, send, clock, advance, timers } = harness(
        { maxTargets: 1 },
        { send: async () => new Response('{}', { status: 503 }) },
      )
      mgr.track({ sessionKey: 'retry', bodyText: body('test') })
      await advance(240_000)
      const retry = [...timers.values()].find(
        (timer) => timer.interval === 20_000,
      )!
      expect(timers.size).toBe(2)
      switch (cleanup) {
        case 'stop':
          mgr.stop()
          break
        case 'remove':
          mgr.remove('retry')
          break
        case 'retrack':
          mgr.track({ sessionKey: 'retry', bodyText: body('new') })
          break
        case 'evict':
          mgr.track({ sessionKey: 'replacement', bodyText: body('new') })
          break
        case 'expire':
          clock.advance(60_000)
          await mgr.tick()
          break
      }
      expect(timers.size).toBe(cleanup === 'stop' ? 0 : 1)
      // A callback already queued by the runtime must also be harmless after cleanup.
      await retry.callback()
      expect(send).toHaveBeenCalledTimes(1)
    })
  }
})
