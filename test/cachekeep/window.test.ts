import { beforeEach, describe, expect, test } from 'bun:test'
import {
  isWithinCacheKeepWindow,
  normalizeCacheKeepWindow,
} from '../../src/cachekeep/index.js'
import { body, DUE_MS, fakeNow, makeManager } from './helpers.js'

describe('getCacheKeepWindow', () => {
  test('returns undefined for null storage', () => {
    expect(normalizeCacheKeepWindow(null)).toBeUndefined()
  })

  test('returns undefined when storage has no cachekeep block', () => {
    expect(normalizeCacheKeepWindow(undefined)).toBeUndefined()
    expect(normalizeCacheKeepWindow({})).toBeUndefined()
  })

  test('returns the parsed window for a valid same-day pair', () => {
    expect(normalizeCacheKeepWindow({ startHour: 9, endHour: 18 })).toEqual({
      startHour: 9,
      endHour: 18,
    })
  })

  test('returns the parsed window for a valid overnight wrap pair', () => {
    expect(normalizeCacheKeepWindow({ startHour: 22, endHour: 6 })).toEqual({
      startHour: 22,
      endHour: 6,
    })
  })

  test('returns undefined when start and end are equal', () => {
    expect(
      normalizeCacheKeepWindow({ startHour: 9, endHour: 9 }),
    ).toBeUndefined()
    expect(
      normalizeCacheKeepWindow({ startHour: 0, endHour: 0 }),
    ).toBeUndefined()
  })

  test('returns undefined when hours are out of 0-23 range', () => {
    expect(
      normalizeCacheKeepWindow({ startHour: -1, endHour: 9 }),
    ).toBeUndefined()
    expect(
      normalizeCacheKeepWindow({ startHour: 24, endHour: 9 }),
    ).toBeUndefined()
    expect(
      normalizeCacheKeepWindow({ startHour: 9, endHour: 24 }),
    ).toBeUndefined()
  })

  test('returns undefined when hours are non-integer', () => {
    expect(
      normalizeCacheKeepWindow({ startHour: 9.5, endHour: 18 }),
    ).toBeUndefined()
    expect(
      normalizeCacheKeepWindow({ startHour: Number.NaN, endHour: 18 }),
    ).toBeUndefined()
  })

  test('returns undefined when either hour is missing', () => {
    expect(normalizeCacheKeepWindow({ startHour: 9 })).toBeUndefined()
    expect(normalizeCacheKeepWindow({ endHour: 18 })).toBeUndefined()
  })
})

describe('isWithinCacheKeepWindow', () => {
  // Local time, so getHours() is stable in any timezone.
  const at = (h: number) => new Date(2024, 5, 15, h, 0, 0, 0)

  test('returns false for undefined window', () => {
    expect(isWithinCacheKeepWindow(undefined, at(3))).toBe(false)
  })

  test('same-day window (9-18): inside hours', () => {
    const win = { startHour: 9, endHour: 18 }
    expect(isWithinCacheKeepWindow(win, at(9))).toBe(true)
    expect(isWithinCacheKeepWindow(win, at(12))).toBe(true)
    expect(isWithinCacheKeepWindow(win, at(17))).toBe(true)
  })

  test('same-day window (9-18): outside hours', () => {
    const win = { startHour: 9, endHour: 18 }
    expect(isWithinCacheKeepWindow(win, at(8))).toBe(false)
    expect(isWithinCacheKeepWindow(win, at(18))).toBe(false)
    expect(isWithinCacheKeepWindow(win, at(23))).toBe(false)
  })

  test('overnight wrap (22-6): inside hours', () => {
    const win = { startHour: 22, endHour: 6 }
    expect(isWithinCacheKeepWindow(win, at(23))).toBe(true)
    expect(isWithinCacheKeepWindow(win, at(0))).toBe(true)
    expect(isWithinCacheKeepWindow(win, at(5))).toBe(true)
  })

  test('overnight wrap (22-6): outside hours', () => {
    const win = { startHour: 22, endHour: 6 }
    expect(isWithinCacheKeepWindow(win, at(12))).toBe(false)
    expect(isWithinCacheKeepWindow(win, at(9))).toBe(false)
    expect(isWithinCacheKeepWindow(win, at(6))).toBe(false)
    expect(isWithinCacheKeepWindow(win, at(21))).toBe(false)
  })
})

describe('CacheKeepManager window gating', () => {
  let clock: ReturnType<typeof fakeNow>
  beforeEach(() => {
    // Start at 10:00 local so the advances below never cross an hour.
    clock = fakeNow(new Date(2024, 5, 15, 10, 0, 0, 0).getTime())
  })
  const included = { startHour: 10, endHour: 11 }
  const excluded = { startHour: 11, endHour: 16 }

  test('without getWindow: behavior is identical to the pre-window manager (unchanged legacy path)', async () => {
    const { mgr, send } = makeManager(clock)
    mgr.track({ sessionKey: 'legacy-sess', bodyText: body('test') })
    expect(mgr.status().tracked).toBe(1)
    expect(mgr.status().window).toBeUndefined()
    clock.advance(DUE_MS)
    await mgr.tick()
    expect(send).toHaveBeenCalledTimes(1)
  })

  test('with excluded getWindow: track() captures nothing and tick() does not fire', async () => {
    const { mgr, send } = makeManager(clock, { getWindow: () => excluded })
    mgr.track({ sessionKey: 'sess-1', bodyText: body('test') })
    expect(mgr.status().tracked).toBe(0)
    expect(mgr.status().window).toEqual(excluded)
    clock.advance(DUE_MS)
    await mgr.tick()
    expect(send).not.toHaveBeenCalled()
  })

  test('with included getWindow: track() captures and tick() fires normally', async () => {
    const { mgr, send } = makeManager(clock, { getWindow: () => included })
    mgr.track({ sessionKey: 'sess-1', bodyText: body('test') })
    expect(mgr.status().tracked).toBe(1)
    expect(mgr.status().window).toEqual(included)
    clock.advance(DUE_MS)
    await mgr.tick()
    expect(send).toHaveBeenCalledTimes(1)
  })

  test('tick() before any capture with excluded window: no targets created, fetch not called', async () => {
    const { mgr, send } = makeManager(clock, { getWindow: () => excluded })
    await mgr.tick()
    expect(send).not.toHaveBeenCalled()
    expect(mgr.status().tracked).toBe(0)
  })

  test('changing getWindow at runtime affects only subsequent track/tick calls (existing targets survive outside-window)', async () => {
    let currentWindow = included
    const { mgr, send } = makeManager(clock, {
      getWindow: () => currentWindow,
    })
    mgr.track({ sessionKey: 'sess-1', bodyText: body('in') })
    expect(mgr.status().tracked).toBe(1)

    currentWindow = excluded
    clock.advance(DUE_MS)
    await mgr.tick()
    expect(send).not.toHaveBeenCalled()
    expect(mgr.status().tracked).toBe(1)

    currentWindow = included
    clock.advance(1000)
    await mgr.tick()
    expect(send).toHaveBeenCalledTimes(1)
  })
})
