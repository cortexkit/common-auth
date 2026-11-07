import { describe, expect, mock } from 'bun:test'
import type { CacheKeepPlan } from '../../src/cachekeep/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { body, DUE_MS, fakeNow, makeManager } from './helpers.js'

const hooks = lifetimeHooks()
const { test } = hooks
const managers = new Set<ReturnType<typeof makeManager>['mgr']>()
hooks.afterEach(() => {
  for (const manager of managers) manager.stop()
  managers.clear()
})
const DUE = 270_000

function harness(
  options: Parameters<typeof makeManager>[1] = {},
  adapter: Parameters<typeof makeManager>[2] = {},
  start?: number,
) {
  const clock = fakeNow(start)
  const timers = new Map<
    ReturnType<typeof setInterval>,
    { callback: () => unknown; due: number; interval: number }
  >()
  const handles: { unref: ReturnType<typeof mock> }[] = []
  const onWarmed = mock((_sessionKey: string, _input: { at: number }) => {})
  const onWarmStopped = mock(
    (_sessionKey: string, _input: { at: number; reason: string }) => {},
  )
  const result = makeManager(
    clock,
    {
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
    { onWarmed, onWarmStopped, ...adapter },
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
  const track = (sessionKey = 'session') =>
    result.mgr.track({ sessionKey, bodyText: body(sessionKey) })
  async function warm() {
    clock.advance(DUE)
    await result.mgr.tick()
  }
  return {
    ...result,
    clock,
    timers,
    handles,
    advance,
    track,
    warm,
    onWarmed,
    onWarmStopped,
  }
}

describe('CacheKeepManager session plans', () => {
  test('undefined plan preserves the legacy lead time and status shape', async () => {
    const { mgr, send, clock, track } = harness({}, { plan: () => undefined })
    track()
    expect(mgr.status().targets[0]).not.toHaveProperty('mode')
    clock.advance(DUE)
    await mgr.tick()
    expect(send).not.toHaveBeenCalled()
    clock.advance(DUE_MS - DUE)
    await mgr.tick()
    expect(send).toHaveBeenCalledTimes(1)
  })

  test('off refuses capture, drops an existing target and only reports if warmed', async () => {
    let plan: CacheKeepPlan = { mode: 'off' }
    const { mgr, send, track, warm, onWarmStopped, clock } = harness(
      {},
      { plan: () => plan },
    )
    expect(track()).toEqual({ tracked: false, reason: 'unsupported' })
    expect(mgr.status().tracked).toBe(0)
    expect(onWarmStopped).not.toHaveBeenCalled()
    plan = { mode: 'always' }
    track()
    plan = { mode: 'off' }
    await mgr.tick()
    expect(mgr.status().tracked).toBe(0)
    expect(onWarmStopped).not.toHaveBeenCalled()
    plan = { mode: 'always' }
    track()
    await warm()
    plan = { mode: 'off' }
    expect(track()).toEqual({ tracked: false, reason: 'unsupported' })
    expect(mgr.status().tracked).toBe(0)
    expect(send).toHaveBeenCalledTimes(1)
    expect(onWarmStopped).toHaveBeenCalledTimes(1)
    expect(onWarmStopped).toHaveBeenCalledWith('session', {
      at: clock.now(),
      reason: 'unsupported',
    })
  })

  test('a plan bypasses the legacy clock window for capture and warming', async () => {
    const { mgr, send, track, warm } = harness(
      { getWindow: () => ({ startHour: 1, endHour: 2 }) },
      { plan: () => ({ mode: 'always' }) },
      new Date(2026, 0, 15, 12).getTime(),
    )
    expect(track()).toEqual({ tracked: true })
    expect(mgr.status().targets[0]?.mode).toBe('always')
    await warm()
    expect(send).toHaveBeenCalledTimes(1)
  })

  test('wait uses an unref one-shot at 4m30s rather than the later 60s tick', async () => {
    const { mgr, send, track, advance, clock, timers, handles } = harness(
      { tickIntervalMs: 60_000 },
      { plan: () => ({ mode: 'always' }) },
    )
    const start = clock.now()
    track()
    const dueTimer = [...timers].find(([, timer]) => timer.due === start + DUE)
    expect(dueTimer).toBeDefined()
    expect(
      handles.every((handle) => handle.unref.mock.calls.length === 1),
    ).toBe(true)
    await advance(DUE - 1)
    expect(send).not.toHaveBeenCalled()
    await advance(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(mgr.status().targets[0]?.lastWarmedAt).toBe(start + DUE)
    expect(timers.has(dueTimer![0])).toBe(false)
    expect(
      [...timers.values()].some((timer) => timer.due === start + 2 * DUE),
    ).toBe(true)
  })

  test('hours warms across midnight in an explicit non-machine zone', async () => {
    const tz =
      Intl.DateTimeFormat().resolvedOptions().timeZone === 'Asia/Tokyo'
        ? 'America/New_York'
        : 'Asia/Tokyo'
    const start = Date.parse(
      tz === 'Asia/Tokyo' ? '2026-01-15T14:58:00Z' : '2026-01-16T04:58:00Z',
    )
    const { send, track, warm } = harness(
      {},
      {
        plan: () => ({
          mode: 'hours',
          hours: { from: '22:00', to: '06:00', tz },
        }),
      },
      start,
    )
    track()
    await warm()
    expect(send).toHaveBeenCalledTimes(1)
  })

  test('hours stops when the next due time is outside the window', async () => {
    const { mgr, send, track, warm, onWarmStopped, clock } = harness(
      {},
      {
        plan: () => ({
          mode: 'hours',
          hours: { from: '09:00', to: '10:00', tz: 'UTC' },
        }),
      },
      Date.parse('2026-01-15T09:53:00Z'),
    )
    track()
    await warm()
    expect(send).toHaveBeenCalledTimes(1)
    expect(mgr.status().tracked).toBe(0)
    expect(onWarmStopped).toHaveBeenCalledTimes(1)
    expect(onWarmStopped).toHaveBeenCalledWith('session', {
      at: clock.now(),
      reason: 'outside-hours',
    })
  })

  test('hours refuses a late send outside the window even when due was inside', async () => {
    const { mgr, send, track, clock, onWarmStopped } = harness(
      {},
      {
        plan: () => ({
          mode: 'hours',
          hours: { from: '09:00', to: '10:00', tz: 'UTC' },
        }),
      },
      Date.parse('2026-01-15T09:55:20Z'),
    )
    track()
    clock.advance(DUE + 10_000)
    await mgr.tick()
    expect(send).not.toHaveBeenCalled()
    expect(mgr.status().tracked).toBe(0)
    expect(onWarmStopped).not.toHaveBeenCalled()
  })

  test.each(['always', 'hours'] as const)(
    '%s ignores idle/profile caps, refuses warm 25',
    async (mode) => {
      const plan: CacheKeepPlan =
        mode === 'hours'
          ? { mode, hours: { from: '00:00', to: '23:59', tz: 'UTC' } }
          : { mode }
      const { mgr, send, track, warm, onWarmStopped, clock } = harness(
        { maxIdleWarmMs: 1 },
        { plan: () => plan, profile: () => ({ maxWarms: 1, maxIdleMs: 1 }) },
        Date.parse('2026-01-15T12:00:00Z'),
      )
      track()
      for (let i = 0; i < 24; i++) await warm()
      expect(send).toHaveBeenCalledTimes(24)
      await mgr.tick()
      expect(send).toHaveBeenCalledTimes(24)
      expect(mgr.status().tracked).toBe(0)
      expect(onWarmStopped).toHaveBeenCalledTimes(1)
      expect(onWarmStopped).toHaveBeenCalledWith('session', {
        at: clock.now(),
        reason: 'count-cap',
      })
    },
  )

  test('a real request resets the planned warm count and last warm timestamp', async () => {
    const { mgr, send, track, warm } = harness(
      {},
      { plan: () => ({ mode: 'always' }) },
    )
    track()
    for (let i = 0; i < 23; i++) await warm()
    track()
    expect(mgr.status().targets[0]?.warmCount).toBe(0)
    expect(mgr.status().targets[0]).not.toHaveProperty('lastWarmedAt')
    await warm()
    await warm()
    expect(send).toHaveBeenCalledTimes(25)
    expect(mgr.status().tracked).toBe(1)
  })
})

describe('CacheKeepManager plan bounds and liveness', () => {
  test.each([
    {
      name: 'main',
      options: { maxIdleWarmMs: 1 },
      adapter: {},
      isSubagent: false,
    },
    {
      name: 'subagent',
      options: { maxSubagentIdleMs: 1 },
      adapter: {},
      isSubagent: true,
    },
    {
      name: 'profile',
      options: {},
      adapter: { profile: () => ({ maxIdleMs: 1 }) },
      isSubagent: false,
    },
  ])(
    'unpriced auto retains the $name idle bound',
    async ({ options, adapter, isSubagent }) => {
      const { mgr, send, clock, onWarmStopped } = harness(options, {
        ...adapter,
        plan: () => ({ mode: 'auto' }),
      })
      mgr.track({
        sessionKey: 'session',
        bodyText: body('request'),
        isSubagent,
      })
      clock.advance(2)
      await mgr.tick()
      expect(mgr.status().tracked).toBe(0)
      expect(send).not.toHaveBeenCalled()
      expect(onWarmStopped).not.toHaveBeenCalled()
    },
  )

  test('unpriced auto retains the per-target warm cap', async () => {
    const { mgr, send, track, warm, onWarmStopped, clock } = harness(
      {},
      {
        plan: () => ({ mode: 'auto' }),
        profile: () => ({ maxWarms: 1 }),
      },
    )
    track()
    await warm()
    expect(send).toHaveBeenCalledTimes(1)
    expect(mgr.status().tracked).toBe(0)
    expect(onWarmStopped).toHaveBeenCalledTimes(1)
    expect(onWarmStopped).toHaveBeenCalledWith('session', {
      at: clock.now(),
      reason: 'count-cap',
    })
  })

  test('priced auto sums completed warm prices and stops at cost equality, not legacy bounds', async () => {
    let nextWarm = 3
    const { mgr, send, track, warm, onWarmStopped, clock } = harness(
      { maxIdleWarmMs: 1 },
      {
        plan: () => ({ mode: 'auto', costs: { nextWarm, rewrite: 12 } }),
        profile: () => ({ maxWarms: 1, maxIdleMs: 1 }),
      },
    )
    track()
    await warm()
    expect(mgr.status().tracked).toBe(1)
    nextWarm = 4
    await warm()
    expect(send).toHaveBeenCalledTimes(2)
    expect(mgr.status().tracked).toBe(1)
    nextWarm = 5
    await mgr.tick()
    expect(mgr.status().tracked).toBe(0)
    expect(onWarmStopped).toHaveBeenCalledTimes(1)
    expect(onWarmStopped).toHaveBeenCalledWith('session', {
      at: clock.now(),
      reason: 'cost-cap',
    })
  })

  test('a real request resets accumulated costs as well as the next due time', async () => {
    const { mgr, send, track, warm, clock } = harness(
      {},
      {
        plan: () => ({ mode: 'auto', costs: { nextWarm: 3, rewrite: 7 } }),
      },
    )
    track()
    await warm()
    clock.advance(1_000)
    track()
    clock.advance(DUE - 1)
    await mgr.tick()
    expect(send).toHaveBeenCalledTimes(1)
    clock.advance(1)
    await mgr.tick()
    expect(send).toHaveBeenCalledTimes(2)
    expect(mgr.status().tracked).toBe(1)
  })

  test('cost equality before the first warm does not report a stop', async () => {
    const { mgr, send, track, onWarmStopped } = harness(
      {},
      {
        plan: () => ({ mode: 'auto', costs: { nextWarm: 10, rewrite: 10 } }),
      },
    )
    track()
    await mgr.tick()
    expect(mgr.status().tracked).toBe(0)
    expect(send).not.toHaveBeenCalled()
    expect(onWarmStopped).not.toHaveBeenCalled()
  })

  test.each(['undefined', 'throw'] as const)(
    'a plan gone via %s stops, with no legacy fallback',
    async (gone) => {
      let ended = false
      const { mgr, send, track, warm, onWarmStopped, clock, advance, log } =
        harness(
          {},
          {
            plan: () => {
              if (!ended) return { mode: 'always' }
              if (gone === 'throw') throw new Error('secret plan error')
              return undefined
            },
          },
        )
      track()
      await warm()
      ended = true
      await mgr.tick()
      expect(mgr.status().tracked).toBe(0)
      expect(onWarmStopped).toHaveBeenCalledTimes(1)
      expect(onWarmStopped).toHaveBeenCalledWith('session', {
        at: clock.now(),
        reason: 'session-ended',
      })
      await advance(600_000)
      expect(send).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(log.warn.mock.calls)).not.toContain(
        'secret plan error',
      )
    },
  )

  test('plan gone during capture refuses legacy recapture and reports only a warmed target', async () => {
    let plan: CacheKeepPlan | undefined = { mode: 'always' }
    const { mgr, track, warm, onWarmStopped } = harness(
      {},
      { plan: () => plan },
    )
    track()
    await warm()
    plan = undefined
    expect(track()).toEqual({ tracked: false, reason: 'session-ended' })
    expect(mgr.status().tracked).toBe(0)
    expect(onWarmStopped.mock.calls[0]?.[1].reason).toBe('session-ended')
  })

  test('a throwing hook for a never-planned target warns once without error text and keeps legacy timing', async () => {
    const { mgr, send, track, clock, log } = harness(
      {},
      {
        plan: () => {
          throw new Error('secret plan error')
        },
      },
    )
    track()
    await mgr.tick()
    clock.advance(DUE_MS)
    await mgr.tick()
    expect(send).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith('cachekeep plan unavailable')
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(
      'secret plan error',
    )
  })

  test.each(['off', 'gone', 'outside-hours'] as const)(
    'rechecks the plan immediately before send when it flips to %s',
    async (flip) => {
      let plan: CacheKeepPlan | undefined = { mode: 'always' }
      const { mgr, send, track, warm, onWarmStopped } = harness(
        {},
        {
          plan: () => plan,
          buildBody: async () => {
            plan =
              flip === 'gone'
                ? undefined
                : flip === 'off'
                  ? { mode: 'off' }
                  : {
                      mode: 'hours',
                      hours: { from: '00:00', to: '00:01', tz: 'UTC' },
                    }
            return '{}'
          },
        },
      )
      track()
      await warm()
      expect(send).not.toHaveBeenCalled()
      expect(mgr.status().tracked).toBe(0)
      expect(onWarmStopped).not.toHaveBeenCalled()
    },
  )

  test('reports only successful 2xx warms and neither awaits nor depends on reports', async () => {
    let success = false
    const report = mock(
      (_sessionKey: string, _input: { at: number }) =>
        new Promise<void>(() => {}),
    )
    const { mgr, send, track, clock, warm, onWarmStopped } = harness(
      { backoffMs: 1_000 },
      {
        plan: () => ({ mode: 'auto', costs: { nextWarm: 3, rewrite: 7 } }),
        onWarmed: report,
        send: async () => new Response('{}', { status: success ? 200 : 503 }),
      },
    )
    track()
    await warm()
    expect(report).not.toHaveBeenCalled()
    success = true
    clock.advance(1_000)
    await mgr.tick()
    expect(send).toHaveBeenCalledTimes(2)
    expect(report).toHaveBeenCalledTimes(1)
    expect(report.mock.calls[0]).toEqual(['session', { at: clock.now() }])
    mgr.remove('session')
    expect(onWarmStopped).toHaveBeenCalledTimes(1)
  })

  test.each(['throw', 'reject'] as const)(
    'a %s from either report is debug-only and leaves scheduling intact',
    async (failure) => {
      const report = mock(() => {
        if (failure === 'throw') throw new Error('secret report')
        return Promise.reject(new Error('secret report'))
      })
      const { mgr, send, track, warm, log } = harness(
        {},
        {
          plan: () => ({ mode: 'always' }),
          onWarmed: report,
          onWarmStopped: report,
        },
      )
      track()
      await warm()
      await warm()
      expect(send).toHaveBeenCalledTimes(2)
      expect(mgr.status().targets[0]?.warmCount).toBe(2)
      mgr.remove('session')
      await Promise.resolve()
      expect(mgr.status().tracked).toBe(0)
      expect(report).toHaveBeenCalledTimes(3)
      expect(log.warn).not.toHaveBeenCalled()
      expect(
        log.debug.mock.calls.filter(
          ([message]) => message === 'cachekeep report failed',
        ),
      ).toHaveLength(3)
      expect(JSON.stringify(log.debug.mock.calls)).not.toContain(
        'secret report',
      )
    },
  )

  test('a real request preserves eligibility for one eventual stop report', async () => {
    const { mgr, track, warm, onWarmStopped } = harness(
      {},
      { plan: () => ({ mode: 'always' }) },
    )
    track()
    await warm()
    track()
    expect(onWarmStopped).not.toHaveBeenCalled()
    mgr.remove('session')
    mgr.remove('session')
    expect(onWarmStopped).toHaveBeenCalledTimes(1)
  })

  test.each(['remove', 'stop', 'retrack', 'evict', 'expiry'] as const)(
    '%s clears the pending one-shot and cannot send its stale callback',
    async (action) => {
      const { mgr, send, track, timers, clock } = harness(
        { maxTargets: 1 },
        { plan: () => ({ mode: 'always' }) },
      )
      track()
      const dueTimer = [...timers].find(([, timer]) => timer.interval === DUE)!
      expect(dueTimer).toBeDefined()
      if (action === 'remove') mgr.remove('session')
      if (action === 'stop') mgr.stop()
      if (action === 'retrack') track()
      if (action === 'evict') track('other')
      if (action === 'expiry') {
        clock.advance(300_000)
        await mgr.tick()
      }
      expect(timers.has(dueTimer[0])).toBe(false)
      await dueTimer[1].callback()
      expect(send).not.toHaveBeenCalled()
      if (action === 'stop') expect(timers.size).toBe(0)
    },
  )
})

describe('CacheKeepManager fresh plan decisions', () => {
  test('reads the next target plan after an earlier warm completes, before building its body', async () => {
    let secondOff = false
    const buildBody = mock(() => '{}')
    const { mgr, track, warm, send } = harness(
      {},
      {
        plan: (sessionKey) => ({
          mode: sessionKey === 'second' && secondOff ? 'off' : 'always',
        }),
        buildBody,
        onWarmed: () => {
          secondOff = true
        },
      },
    )
    track('first')
    track('second')
    await warm()
    expect(buildBody).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(mgr.status().targets.map((target) => target.sessionKey)).toEqual([
      'first',
    ])
  })

  test.each(['idle', 'warm cap'] as const)(
    'a switch to unpriced auto reapplies the %s bound before send',
    async (bound) => {
      let plan: CacheKeepPlan = { mode: 'always' }
      let builds = 0
      const { mgr, send, track, warm, onWarmStopped } = harness(
        {},
        {
          plan: () => plan,
          profile: () =>
            bound === 'idle' ? { maxIdleMs: 1 } : { maxWarms: 1 },
          buildBody: () => {
            if (++builds === 2) plan = { mode: 'auto' }
            return '{}'
          },
        },
      )
      track()
      await warm()
      expect(mgr.status().tracked).toBe(1)
      await warm()
      expect(send).toHaveBeenCalledTimes(1)
      expect(mgr.status().tracked).toBe(0)
      expect(onWarmStopped.mock.calls[0]?.[1].reason).toBe(
        bound === 'idle' ? 'idle' : 'count-cap',
      )
    },
  )
})
