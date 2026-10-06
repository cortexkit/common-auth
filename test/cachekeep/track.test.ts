import { beforeEach, describe, expect } from 'bun:test'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import {
  body,
  DUE_MS,
  fakeNow,
  LEAD_MS,
  makeManager,
  sessions,
  TTL_MS,
} from './helpers.js'

const hooks = lifetimeHooks()
const { test } = hooks

let clock: ReturnType<typeof fakeNow>
beforeEach(() => {
  clock = fakeNow()
})

describe('CacheKeepManager.track', () => {
  test('stores a target with correct fields', () => {
    const { mgr } = makeManager(clock)
    const result = mgr.track({
      sessionKey: 'sess-1',
      bodyText: body('test'),
      accountId: 'main',
    })
    expect(result).toEqual({ tracked: true })
    const status = mgr.status()
    expect(status.tracked).toBe(1)
    expect(status.targets[0]).toMatchObject({
      sessionKey: 'sess-1',
      accountId: 'main',
      isSubagent: false,
      lastRealRequestAt: clock.now(),
      warmCount: 0,
      failures: 0,
      ttlMs: TTL_MS,
      bodyBytes: body('test').length,
    })
  })

  test('sets cacheExpiresAt to now + TTL_MS', () => {
    const { mgr } = makeManager(clock)
    mgr.track({ sessionKey: 'sess-1', bodyText: body('test') })
    expect(mgr.status().targets[0]!.cacheExpiresAt).toBe(clock.now() + TTL_MS)
  })

  test('replace-on-retrack: freshest body wins', async () => {
    const { mgr, send } = makeManager(clock)
    mgr.track({ sessionKey: 'sess-1', bodyText: body('first') })
    clock.advance(10_000)
    mgr.track({ sessionKey: 'sess-1', bodyText: body('second') })
    clock.advance(DUE_MS)
    await mgr.tick()

    expect(mgr.status().tracked).toBe(1)
    expect(mgr.status().totalBytes).toBe(body('second').length)
    expect(JSON.parse(send.mock.calls[0]![0].body).input).toBe('second')
  })

  test('replace-on-retrack resets cacheExpiresAt', () => {
    const { mgr } = makeManager(clock)
    mgr.track({ sessionKey: 'sess-1', bodyText: body('first') })
    clock.advance(60_000)
    mgr.track({ sessionKey: 'sess-1', bodyText: body('second') })
    expect(mgr.status().targets[0]!.cacheExpiresAt).toBe(clock.now() + TTL_MS)
  })

  test('prunes targets past maxIdleWarmMs from last real request', () => {
    const { mgr } = makeManager(clock, { maxIdleWarmMs: 60_000 })
    mgr.track({ sessionKey: 'sess-1', bodyText: body('old') })
    clock.advance(60_001)
    mgr.track({ sessionKey: 'sess-2', bodyText: body('new') })
    expect(sessions(mgr)).toEqual(['sess-2'])
  })

  test('sustain toggles main idle pruning at runtime without recreating the manager', () => {
    let sustain = false
    const { mgr } = makeManager(clock, {
      maxIdleWarmMs: 60_000,
      getSustain: () => sustain,
    })

    mgr.track({ sessionKey: 'pruned-while-off', bodyText: body('old') })
    clock.advance(60_001)
    mgr.track({ sessionKey: 'trigger-off', bodyText: body('new') })
    expect(sessions(mgr)).toEqual(['trigger-off'])

    sustain = true
    mgr.track({ sessionKey: 'kept-while-on', bodyText: body('kept') })
    clock.advance(60_001)
    mgr.track({ sessionKey: 'trigger-on', bodyText: body('newer') })
    expect(sessions(mgr)).toEqual([
      'trigger-off',
      'kept-while-on',
      'trigger-on',
    ])
    expect(mgr.status().sustain).toBe(true)

    sustain = false
    clock.advance(60_001)
    mgr.track({ sessionKey: 'trigger-off-again', bodyText: body('latest') })
    expect(sessions(mgr)).toEqual(['trigger-off-again'])
    expect(mgr.status().sustain).toBe(false)
  })

  test('sustain bypasses idle pruning but leaves maxTargets and maxBytes eviction active', async () => {
    const big = body('x'.repeat(100))
    const { mgr } = makeManager(clock, {
      maxIdleWarmMs: 1,
      maxTargets: 8,
      maxBytes: big.length * 2 - 1,
      getSustain: () => true,
    })
    mgr.track({ sessionKey: 'sustained-old', bodyText: big })
    clock.advance(2)
    await mgr.tick()
    expect(sessions(mgr)).toEqual(['sustained-old'])

    mgr.track({ sessionKey: 'newer', bodyText: big })
    expect(sessions(mgr)).toEqual(['newer'])

    const { mgr: capped } = makeManager(clock, {
      maxIdleWarmMs: 1,
      maxTargets: 1,
      getSustain: () => true,
    })
    capped.track({ sessionKey: 'sustained-old', bodyText: body('old') })
    clock.advance(2)
    await capped.tick()
    expect(sessions(capped)).toEqual(['sustained-old'])

    capped.track({ sessionKey: 'newer', bodyText: body('new') })
    expect(sessions(capped)).toEqual(['newer'])
  })

  test('sustain leaves the configured clock window in control of capture and warming', async () => {
    let window: { startHour: number; endHour: number } | undefined
    const { mgr, send } = makeManager(clock, {
      getSustain: () => true,
      getWindow: () => window,
    })
    const outsideHour = new Date(clock.now()).getHours()
    mgr.track({ sessionKey: 'captured-before-window', bodyText: body('old') })
    window = {
      startHour: (outsideHour + 1) % 24,
      endHour: (outsideHour + 2) % 24,
    }

    expect(
      mgr.track({ sessionKey: 'blocked-by-window', bodyText: body('new') }),
    ).toEqual({ tracked: false, reason: 'outside-window' })
    expect(sessions(mgr)).toEqual(['captured-before-window'])

    clock.advance(TTL_MS - LEAD_MS + 1)
    await mgr.tick()
    expect(send).not.toHaveBeenCalled()
  })

  test('caps Map size at default maxTargets (32)', () => {
    const { mgr } = makeManager(clock, { maxTargets: 3 })
    for (let i = 0; i < 5; i++) {
      clock.advance(1)
      mgr.track({ sessionKey: `sess-${i}`, bodyText: body(`msg-${i}`) })
    }
    // The two least recently touched captures make room for the newest.
    expect(sessions(mgr)).toEqual(['sess-2', 'sess-3', 'sess-4'])

    const { mgr: defaults } = makeManager(clock)
    for (let i = 0; i < 40; i++) {
      clock.advance(1)
      defaults.track({ sessionKey: `sess-${i}`, bodyText: body(`msg-${i}`) })
    }
    expect(defaults.status().tracked).toBe(32)
  })

  test('caps total bytes at default maxBytes', () => {
    const { mgr } = makeManager(clock, { maxBytes: 200 })
    expect(
      mgr.track({ sessionKey: 'sess-1', bodyText: body('x'.repeat(300)) }),
    ).toEqual({ tracked: false, reason: 'body-exceeds-max-bytes' })
    expect(mgr.status().tracked).toBe(0)

    const { mgr: defaults } = makeManager(clock)
    const half = 'x'.repeat(4 * 1024 * 1024)
    defaults.track({ sessionKey: 'a', bodyText: half })
    clock.advance(1)
    defaults.track({ sessionKey: 'b', bodyText: half })
    clock.advance(1)
    defaults.track({ sessionKey: 'c', bodyText: half })
    // 8 MiB holds two 4 MiB captures; the third evicts the oldest.
    expect(sessions(defaults)).toEqual(['b', 'c'])
    expect(defaults.status().totalBytes).toBe(8 * 1024 * 1024)
  })

  test('rejects an oversized body without evicting existing targets', () => {
    const { mgr } = makeManager(clock, { maxBytes: 200 })
    mgr.track({ sessionKey: 'sess-1', bodyText: body('small') })
    mgr.track({ sessionKey: 'sess-oversize', bodyText: body('x'.repeat(300)) })
    expect(sessions(mgr)).toEqual(['sess-1'])
  })

  test('sustain leaves least-recently-used eviction active', async () => {
    const { mgr } = makeManager(clock, {
      maxIdleWarmMs: 1,
      maxTargets: 2,
      getSustain: () => true,
    })
    mgr.track({ sessionKey: 'main', bodyText: body('main') })
    clock.advance(1000)
    mgr.track({ sessionKey: 'ephemeral', bodyText: body('ephemeral') })
    clock.advance(TTL_MS - LEAD_MS - 1000)

    // Only `main` is due, so its warm makes it the more recently touched.
    await mgr.tick()
    mgr.track({ sessionKey: 'new-ephemeral', bodyText: body('new') })

    const tracked = sessions(mgr)
    expect(tracked).toContain('main')
    expect(tracked).toContain('new-ephemeral')
    expect(tracked).not.toContain('ephemeral')
  })

  test('byte caps count UTF-8 bytes, not string length', () => {
    // Each 'é' is one UTF-16 unit but two UTF-8 bytes.
    const accented = 'é'.repeat(60)
    const { mgr } = makeManager(clock, { maxBytes: 100 })
    expect(mgr.track({ sessionKey: 'a', bodyText: accented })).toEqual({
      tracked: false,
      reason: 'body-exceeds-max-bytes',
    })
    mgr.track({ sessionKey: 'b', bodyText: 'é'.repeat(30) })
    expect(mgr.status().targets[0]!.bodyBytes).toBe(60)
  })

  test('remove forgets a session and frees its bytes', async () => {
    const { mgr, send } = makeManager(clock)
    mgr.track({ sessionKey: 'gone', bodyText: body('gone') })
    mgr.track({ sessionKey: 'kept', bodyText: body('kept') })
    mgr.remove('gone')
    expect(sessions(mgr)).toEqual(['kept'])
    expect(mgr.status().totalBytes).toBe(body('kept').length)

    clock.advance(DUE_MS)
    await mgr.tick()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0].target.sessionKey).toBe('kept')
  })
})

describe('CacheKeepManager subagent pruneStale', () => {
  // A cache lifetime longer than either idle cap, so these targets are pruned
  // by the idle caps and not by the end of their cache lifetime.
  const hourAndHalf = {
    maxIdleWarmMs: 60 * 60_000,
    maxSubagentIdleMs: 30 * 60_000,
    ttlMs: 2 * 60 * 60_000,
  }

  test('subagent target pruned at 31min (past 30min cap)', () => {
    const { mgr } = makeManager(clock, {
      ...hourAndHalf,
      getSustain: () => true,
    })
    mgr.track({
      sessionKey: 'sub-sess',
      bodyText: body('sub'),
      isSubagent: true,
    })
    clock.advance(31 * 60_000)
    mgr.track({ sessionKey: 'main-sess', bodyText: body('main') })
    expect(sessions(mgr)).toEqual(['main-sess'])
  })

  test('subagent target survives at 29min (within 30min cap)', () => {
    const { mgr } = makeManager(clock, hourAndHalf)
    mgr.track({
      sessionKey: 'sub-sess',
      bodyText: body('sub'),
      isSubagent: true,
    })
    clock.advance(29 * 60_000)
    mgr.track({ sessionKey: 'main-sess', bodyText: body('main') })
    expect(mgr.status().tracked).toBe(2)
  })

  test('main target survives at 31min (within 1h cap)', () => {
    const { mgr } = makeManager(clock, hourAndHalf)
    mgr.track({ sessionKey: 'main-sess', bodyText: body('main') })
    clock.advance(31 * 60_000)
    mgr.track({ sessionKey: 'other-sess', bodyText: body('other') })
    expect(sessions(mgr)).toEqual(['main-sess', 'other-sess'])
  })

  test('main target pruned past 1h', () => {
    const { mgr } = makeManager(clock, hourAndHalf)
    mgr.track({ sessionKey: 'main-sess', bodyText: body('main') })
    clock.advance(61 * 60_000)
    mgr.track({ sessionKey: 'other-sess', bodyText: body('other') })
    expect(sessions(mgr)).toEqual(['other-sess'])
  })

  test('re-captures a subagent target after it was pruned', () => {
    const { mgr } = makeManager(clock, { maxSubagentIdleMs: 30 * 60_000 })
    mgr.track({
      sessionKey: 'sub-sess',
      bodyText: body('old'),
      isSubagent: true,
    })
    clock.advance(31 * 60_000)
    mgr.track({ sessionKey: 'other', bodyText: body('other') })
    expect(mgr.status().tracked).toBe(1)

    mgr.track({
      sessionKey: 'sub-sess',
      bodyText: body('new'),
      isSubagent: true,
    })
    expect(mgr.status().tracked).toBe(2)
    expect(
      mgr.status().targets.find((t) => t.sessionKey === 'sub-sess')!
        .lastRealRequestAt,
    ).toBe(clock.now())
  })
})

describe('CacheKeepManager status', () => {
  test('does not expose captured body text', () => {
    const { mgr } = makeManager(clock)
    mgr.track({ sessionKey: 'sess-1', bodyText: body('secret prompt') })
    const target = mgr.status().targets[0] as unknown as Record<string, unknown>
    expect(target.bodyText).toBeUndefined()
    expect(JSON.stringify(mgr.status())).not.toContain('secret prompt')
    expect(target.bodyBytes).toBeGreaterThan(0)
  })
})

describe('CacheKeepManager start/stop', () => {
  test('start sets running flag', () => {
    const { mgr } = makeManager(clock)
    mgr.start()
    try {
      expect(mgr.status().running).toBe(true)
    } finally {
      mgr.stop()
    }
  })

  test('stop clears targets and timer', () => {
    const { mgr } = makeManager(clock)
    mgr.start()
    mgr.track({ sessionKey: 'sess-1', bodyText: body('test') })
    mgr.stop()
    const status = mgr.status()
    expect(status.running).toBe(false)
    expect(status.tracked).toBe(0)
    expect(status.totalBytes).toBe(0)
  })

  test('status shows max idle warm time', () => {
    const { mgr } = makeManager(clock, { maxIdleWarmMs: 60 * 60_000 })
    expect(mgr.status().maxIdleWarmMs).toBe(60 * 60_000)
    expect(makeManager(clock).mgr.status()).toMatchObject({
      maxIdleWarmMs: 60 * 60_000,
      maxSubagentIdleMs: 30 * 60_000,
    })
  })
})
