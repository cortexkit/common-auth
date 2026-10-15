import { describe, expect, test } from 'bun:test'
import {
  decodeQuotaMap,
  isQuotaMap,
  isQuotaObservation,
  mergeQuotaObservation,
  projectQuota,
  QuotaCodecError,
  quotaCodec,
} from '../../src/quota/index.js'

describe('quota counters', () => {
  test('the newest counter wins in either arrival order using its own timestamp', () => {
    const older = {
      checkedAt: 900,
      counters: { resetCredits: { value: 8, checkedAt: 100 } },
    }
    const newer = {
      checkedAt: 1,
      counters: { resetCredits: { value: 3, checkedAt: 200 } },
    }
    for (const [first, second] of [
      [older, newer],
      [newer, older],
    ] as const) {
      const stored = mergeQuotaObservation(undefined, first)
      const before = JSON.stringify(stored)
      const merged = mergeQuotaObservation(stored, second)
      expect(JSON.parse(JSON.stringify(merged)).counters).toEqual({
        resetCredits: { value: 3, checkedAt: 200 },
      })
      expect(JSON.stringify(stored)).toBe(before)
    }
  })

  test('an absent counter name leaves the stored count alone', () => {
    const stored = mergeQuotaObservation(undefined, {
      checkedAt: 100,
      counters: { resetCredits: { value: 4, checkedAt: 100 } },
    })
    for (const observation of [
      { checkedAt: 200 },
      { checkedAt: 200, counters: {} },
      {
        checkedAt: 200,
        counters: { other: { value: 7, checkedAt: 200 } },
      },
    ]) {
      expect(
        mergeQuotaObservation(stored, observation).counters?.resetCredits,
      ).toEqual({ value: 4, checkedAt: 100 })
    }
  })

  test('zero and equal-time updates apply without coupling counters to budget or limits', () => {
    const stored = mergeQuotaObservation(undefined, {
      checkedAt: 100,
      readings: [{ label: 'primary', usedPercent: 20 }],
      budget: { kind: 'reading', reached: false },
      counters: { resetCredits: { value: 4, checkedAt: 300 } },
    })
    const cleared = mergeQuotaObservation(stored, {
      checkedAt: 200,
      coverage: [{ label: 'primary' }],
      budget: { kind: 'cleared' },
    })
    expect(cleared.counters).toEqual({
      resetCredits: { value: 4, checkedAt: 300 },
    })
    const updated = mergeQuotaObservation(cleared, {
      checkedAt: 1,
      counters: { resetCredits: { value: 0, checkedAt: 300 } },
    })
    expect(updated.counters).toEqual({
      resetCredits: { value: 0, checkedAt: 300 },
    })
    expect(updated.limits).toEqual(cleared.limits)
    expect(updated.budget).toEqual(cleared.budget)
  })

  const malformed = [
    null,
    [],
    {},
    { value: -1, checkedAt: 1 },
    { value: 1.5, checkedAt: 1 },
    { value: Number.NaN, checkedAt: 1 },
    { value: Number.POSITIVE_INFINITY, checkedAt: 1 },
    { value: '2', checkedAt: 1 },
    { value: 2 },
    { value: 2, checkedAt: '1' },
    { value: 2, checkedAt: Number.POSITIVE_INFINITY },
    { value: 2, checkedAt: Number.NaN },
  ]

  test.each(malformed.map((bad) => [bad] as const))(
    'malformed counter %j is dropped on read and refused on write',
    (bad) => {
      const counters = { good: { value: 0, checkedAt: 2 }, bad }
      const map = { limits: [], counters, future: { preserved: true } }
      expect(isQuotaMap(map)).toBe(false)
      expect(quotaCodec.decode?.(map)).toEqual({
        limits: [],
        future: { preserved: true },
        counters: { good: { value: 0, checkedAt: 2 } },
      })
      expect(decodeQuotaMap({ limits: [], counters: { bad } })).toEqual({
        limits: [],
      })
      expect(isQuotaObservation({ checkedAt: 1, counters })).toBe(false)
      expect(() =>
        mergeQuotaObservation(undefined, { checkedAt: 1, counters }),
      ).toThrow(QuotaCodecError)
    },
  )

  test.each([null, [], 1, 'bad'].map((counters) => [counters] as const))(
    'a malformed counters container %j does not hide the map',
    (counters) => {
      expect(decodeQuotaMap({ limits: [], counters })).toEqual({ limits: [] })
      expect(isQuotaObservation({ checkedAt: 1, counters })).toBe(false)
    },
  )

  test('decoding still refuses malformed limits and budget', () => {
    expect(decodeQuotaMap({ limits: 'bad', counters: {} })).toBeUndefined()
    expect(decodeQuotaMap({ limits: [], budget: {} })).toBeUndefined()
  })

  test('projections preserve named counters in every scope without changing freshness', () => {
    const map = mergeQuotaObservation(undefined, {
      checkedAt: 100,
      readings: [{ label: 'primary', usedPercent: 20 }],
      counters: { resetCredits: { value: 5, checkedAt: 900 } },
    })
    for (const scope of ['all', 'family']) {
      const projected = projectQuota(map, scope)
      expect(projected.counters).toEqual({
        resetCredits: { value: 5, checkedAt: 900 },
      })
      expect(projected.checkedAt).toBe(100)
    }
  })

  test('plugin-owned names including object prototype names survive JSON round trips', () => {
    const counters = JSON.parse(
      '{"__proto__":{"value":3,"checkedAt":1},"constructor":{"value":0,"checkedAt":2}}',
    )
    const map = mergeQuotaObservation(undefined, { checkedAt: 1, counters })
    expect(decodeQuotaMap(JSON.parse(JSON.stringify(map)))?.counters).toEqual(
      counters,
    )
  })

  test('counter-free observations keep the legacy JSON bytes without empty counters', () => {
    const observation = {
      checkedAt: 100,
      readings: [{ label: 'primary', usedPercent: 20 }],
      budget: { kind: 'cleared' },
    }
    const legacy =
      '{"limits":[{"scope":"all","label":"primary","kind":"reading","checkedAt":100,"usedPercent":20}],"budget":{"kind":"cleared","checkedAt":100}}'
    for (const input of [observation, { ...observation, counters: {} }]) {
      const map = mergeQuotaObservation(undefined, input)
      expect(JSON.stringify(map)).toBe(legacy)
      expect(JSON.stringify(decodeQuotaMap(map))).toBe(legacy)
      expect(projectQuota(map)).not.toHaveProperty('counters')
    }
  })
})
