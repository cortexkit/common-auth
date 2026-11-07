import { describe, expect, test } from 'bun:test'
import {
  type CacheKeepDecisionInput,
  decideCacheKeep,
} from '../../src/cachekeep/index.js'

const base = {
  mode: 'always',
  now: 270_000,
  ttlMs: 300_000,
  lastRealRequestAt: 0,
  warmsSinceLastRealRequest: 0,
} as const satisfies CacheKeepDecisionInput

const stop = (reason: string) => ({ action: 'stop' as const, reason })

describe('decideCacheKeep', () => {
  test('off never starts warming', () => {
    expect(decideCacheKeep({ ...base, mode: 'off' })).toEqual(
      stop('unsupported'),
    )
  })

  test.each(['always', 'auto', 'hours'] as const)(
    '%s follows the five-minute and one-hour cadence',
    (mode) => {
      const policy =
        mode === 'hours'
          ? { mode, hours: { from: '00:00', to: '23:59', tz: 'UTC' } }
          : { mode }
      expect(decideCacheKeep({ ...base, ...policy, now: 0 })).toEqual({
        action: 'wait',
        until: 270_000,
      })
      expect(decideCacheKeep({ ...base, ...policy })).toEqual({
        action: 'warm',
        at: 270_000,
      })
      expect(
        decideCacheKeep({ ...base, ...policy, ttlMs: 3_600_000, now: 0 }),
      ).toEqual({
        action: 'wait',
        until: 3_570_000,
      })
      expect(
        decideCacheKeep({
          ...base,
          ...policy,
          ttlMs: 3_600_000,
          now: 3_570_000,
        }),
      ).toEqual({
        action: 'warm',
        at: 3_570_000,
      })
    },
  )

  test('takes the later real request or warm, and schedules each subsequent warm', () => {
    expect(decideCacheKeep({ ...base, now: 0, lastWarmAt: 200_000 })).toEqual({
      action: 'wait',
      until: 470_000,
    })
    expect(
      decideCacheKeep({
        ...base,
        now: 0,
        lastRealRequestAt: 250_000,
        lastWarmAt: 200_000,
      }),
    ).toEqual({
      action: 'wait',
      until: 520_000,
    })
    expect(
      decideCacheKeep({ ...base, now: 540_000, lastWarmAt: 270_000 }),
    ).toEqual({
      action: 'warm',
      at: 540_000,
    })
  })

  test('a late timer can warm until, but not in, the final five seconds', () => {
    expect(decideCacheKeep({ ...base, now: 294_999 })).toEqual({
      action: 'warm',
      at: 294_999,
    })
    expect(decideCacheKeep({ ...base, now: 295_000 })).toEqual(stop('cost-cap'))
    expect(decideCacheKeep({ ...base, now: 300_000 })).toEqual(stop('cost-cap'))
    expect(decideCacheKeep({ ...base, now: 600_000 })).toEqual(stop('cost-cap'))
  })

  test('short TTLs use half-TTL lead and one-tenth-TTL safety margin', () => {
    expect(decideCacheKeep({ ...base, ttlMs: 10_000, now: 0 })).toEqual({
      action: 'wait',
      until: 5_000,
    })
    expect(decideCacheKeep({ ...base, ttlMs: 10_000, now: 8_999 })).toEqual({
      action: 'warm',
      at: 8_999,
    })
    expect(decideCacheKeep({ ...base, ttlMs: 10_000, now: 9_000 })).toEqual(
      stop('cost-cap'),
    )
  })

  test.each(['always', 'hours'] as const)(
    '%s allows warm 24 but refuses warm 25',
    (mode) => {
      const policy =
        mode === 'hours'
          ? { mode, hours: { from: '00:00', to: '23:59', tz: 'UTC' } }
          : { mode }
      expect(
        decideCacheKeep({ ...base, ...policy, warmsSinceLastRealRequest: 23 }),
      ).toEqual({
        action: 'warm',
        at: 270_000,
      })
      expect(
        decideCacheKeep({ ...base, ...policy, warmsSinceLastRealRequest: 24 }),
      ).toEqual(stop('count-cap'))
      expect(
        decideCacheKeep({ ...base, ...policy, warmsSinceLastRealRequest: 0 }),
      ).toEqual({
        action: 'warm',
        at: 270_000,
      })
    },
  )

  test('only auto applies the one-rewrite cap', () => {
    const prices = { warmCostSoFar: 90, nextWarmCost: 10, rewriteCost: 100 }
    expect(decideCacheKeep({ ...base, mode: 'auto', ...prices })).toEqual(
      stop('cost-cap'),
    )
    expect(
      decideCacheKeep({ ...base, mode: 'auto', ...prices, warmCostSoFar: 89 }),
    ).toEqual({
      action: 'warm',
      at: 270_000,
    })
    expect(
      decideCacheKeep({ ...base, mode: 'auto', ...prices, warmCostSoFar: 91 }),
    ).toEqual(stop('cost-cap'))
    expect(decideCacheKeep({ ...base, ...prices })).toEqual({
      action: 'warm',
      at: 270_000,
    })
    expect(
      decideCacheKeep({
        ...base,
        mode: 'hours',
        hours: { from: '00:00', to: '23:59', tz: 'UTC' },
        ...prices,
      }),
    ).toEqual({ action: 'warm', at: 270_000 })
  })

  test('auto checks the first warm against the rewrite cost too', () => {
    expect(
      decideCacheKeep({
        ...base,
        mode: 'auto',
        warmCostSoFar: 0,
        nextWarmCost: 100,
        rewriteCost: 100,
      }),
    ).toEqual(stop('cost-cap'))
    expect(
      decideCacheKeep({
        ...base,
        mode: 'auto',
        warmCostSoFar: 0,
        nextWarmCost: 99,
        rewriteCost: 100,
      }),
    ).toEqual({ action: 'warm', at: 270_000 })
  })

  test.each([
    {},
    { warmCostSoFar: 1_000 },
    { nextWarmCost: 1_000 },
    { rewriteCost: 1 },
    { warmCostSoFar: 1_000, nextWarmCost: 1_000 },
    { warmCostSoFar: 1_000, rewriteCost: 1 },
    { nextWarmCost: 1_000, rewriteCost: 1 },
  ])('auto without all prices returns timing only: %j', (prices) => {
    expect(
      decideCacheKeep({
        ...base,
        mode: 'auto',
        ...prices,
        now: 0,
        warmsSinceLastRealRequest: 100,
      }),
    ).toEqual({ action: 'wait', until: 270_000 })
    expect(
      decideCacheKeep({
        ...base,
        mode: 'auto',
        ...prices,
        warmsSinceLastRealRequest: 100,
      }),
    ).toEqual({ action: 'warm', at: 270_000 })
    expect(
      decideCacheKeep({ ...base, mode: 'auto', ...prices, now: 295_000 }),
    ).toEqual(stop('cost-cap'))
  })

  test.each([0, -1, NaN, Infinity])(
    'cannot warm without a positive finite cache TTL: %j',
    (ttlMs) => {
      expect(decideCacheKeep({ ...base, ttlMs })).toEqual(stop('unsupported'))
    },
  )
})

describe('hours policy', () => {
  const hours = { from: '09:15', to: '19:45', tz: 'UTC' }

  function at(time: string, window = hours, now?: string) {
    const due = Date.parse(`2026-01-15T${time}:00Z`)
    return decideCacheKeep({
      ...base,
      mode: 'hours',
      hours: window,
      now: now ? Date.parse(`2026-01-15T${now}:00Z`) : due,
      lastRealRequestAt: due - 270_000,
    })
  }

  test('uses minute precision, includes the start and excludes the end', () => {
    expect(at('09:14')).toEqual(stop('outside-hours'))
    expect(at('09:15')).toEqual({
      action: 'warm',
      at: Date.parse('2026-01-15T09:15:00Z'),
    })
    expect(at('19:44')).toEqual({
      action: 'warm',
      at: Date.parse('2026-01-15T19:44:00Z'),
    })
    expect(at('19:45')).toEqual(stop('outside-hours'))
  })

  test('a due time outside the window stops instead of scheduling the next opening', () => {
    expect(at('19:45', hours, '19:42')).toEqual(stop('outside-hours'))
  })

  test('a timer firing after the window ends stops even if due was inside it', () => {
    const due = Date.parse('2026-01-15T19:44:50Z')
    expect(
      decideCacheKeep({
        ...base,
        mode: 'hours',
        hours,
        lastRealRequestAt: due - 270_000,
        now: due + 10_000,
      }),
    ).toEqual(stop('outside-hours'))
  })

  test('a later real request inside the window can restart warming', () => {
    expect(at('08:59')).toEqual(stop('outside-hours'))
    expect(at('09:20')).toEqual({
      action: 'warm',
      at: Date.parse('2026-01-15T09:20:00Z'),
    })
  })

  test('supports a window crossing midnight', () => {
    const overnight = { from: '22:00', to: '06:00', tz: 'UTC' }
    expect(at('21:59', overnight)).toEqual(stop('outside-hours'))
    for (const time of ['22:00', '23:59', '00:00', '05:59']) {
      expect(at(time, overnight)).toEqual({
        action: 'warm',
        at: Date.parse(`2026-01-15T${time}:00Z`),
      })
    }
    expect(at('06:00', overnight)).toEqual(stop('outside-hours'))
  })

  test('uses the specified time zone rather than the machine clock', () => {
    const machineZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const tz = machineZone === 'Asia/Tokyo' ? 'America/New_York' : 'Asia/Tokyo'
    const window = { from: '09:15', to: '10:00', tz }
    const inside = tz === 'Asia/Tokyo' ? '00:15' : '14:15'
    const outside = tz === 'Asia/Tokyo' ? '01:00' : '15:00'
    expect(at(inside, window)).toEqual({
      action: 'warm',
      at: Date.parse(`2026-01-15T${inside}:00Z`),
    })
    expect(at(outside, window)).toEqual(stop('outside-hours'))
  })

  test('honours the zone offset in both summer and winter', () => {
    for (const date of ['2026-01-15', '2026-07-15']) {
      const utcHour = date.includes('-01-') ? '14:15' : '13:15'
      const due = Date.parse(`${date}T${utcHour}:00Z`)
      expect(
        decideCacheKeep({
          ...base,
          mode: 'hours',
          hours: { ...hours, tz: 'America/New_York' },
          now: due,
          lastRealRequestAt: due - 270_000,
        }),
      ).toEqual({ action: 'warm', at: due })
    }
  })
})
