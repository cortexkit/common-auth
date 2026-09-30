import { describe, expect, test } from 'bun:test'
import {
  isQuotaMap,
  isQuotaObservation,
  mergeQuotaObservation,
  QuotaCodecError,
  type QuotaMap,
  type QuotaObservation,
} from '../../src/quota/index.js'
import { absent, reading, reload, retired } from './helpers.js'

const primary = { label: 'primary' }
const secondary = { label: 'secondary' }

// Every step persists and reloads the map, so each sequence proves the merge
// rules survive a store write and read.
function apply(stored: QuotaMap | undefined, observation: QuotaObservation) {
  const merged = reload(mergeQuotaObservation(stored, observation))
  expect(isQuotaMap(merged)).toBe(true)
  return merged
}

function entry(map: QuotaMap, label: string, scope = 'all') {
  return map.limits.find(
    (limit) => limit.label === label && limit.scope === scope,
  )
}

const primaryAt100 = (): QuotaMap =>
  apply(undefined, {
    checkedAt: 100,
    readings: [{ label: 'primary', usedPercent: 40 }],
  })

describe('quota merge', () => {
  test('an older covering observation keeps a reading and an equal one tombstones it', () => {
    let map = primaryAt100()
    map = apply(map, {
      checkedAt: 90,
      readings: [{ label: 'secondary', usedPercent: 10 }],
      coverage: [primary, secondary],
    })
    expect(entry(map, 'primary')).toEqual(
      reading('primary', 40, { checkedAt: 100 }),
    )
    expect(entry(map, 'secondary')).toEqual(
      reading('secondary', 10, { checkedAt: 90 }),
    )
    map = apply(map, {
      checkedAt: 100,
      readings: [{ label: 'secondary', usedPercent: 10 }],
      coverage: [primary, secondary],
    })
    expect(entry(map, 'primary')).toEqual(retired('primary', 100))
  })

  test('a newer covering observation moves the tombstone and only a reading not older replaces it', () => {
    let map = apply(primaryAt100(), {
      checkedAt: 100,
      coverage: [primary],
    })
    map = apply(map, { checkedAt: 110, coverage: [primary, secondary] })
    expect(entry(map, 'primary')).toEqual(retired('primary', 110))
    map = apply(map, {
      checkedAt: 105,
      readings: [{ label: 'primary', usedPercent: 70 }],
    })
    expect(entry(map, 'primary')).toEqual(retired('primary', 110))
    map = apply(map, {
      checkedAt: 110,
      readings: [{ label: 'primary', usedPercent: 70 }],
    })
    expect(entry(map, 'primary')).toEqual(
      reading('primary', 70, { checkedAt: 110 }),
    )
    map = apply(map, {
      checkedAt: 115,
      readings: [{ label: 'primary', usedPercent: 75 }],
    })
    expect(entry(map, 'primary')).toEqual(
      reading('primary', 75, { checkedAt: 115 }),
    )
  })

  test('coverage of one pair never touches another pair', () => {
    const map = apply(primaryAt100(), {
      checkedAt: 110,
      coverage: [secondary],
    })
    expect(entry(map, 'primary')).toEqual(
      reading('primary', 40, { checkedAt: 100 }),
    )
    expect(entry(map, 'secondary')).toEqual(absent('secondary', 110))
  })

  test('an omission older than a reading never deletes it', () => {
    let map = apply(undefined, {
      checkedAt: 30,
      readings: [{ label: 'primary', usedPercent: 5 }],
    })
    map = apply(map, { checkedAt: 20, coverage: [primary] })
    expect(entry(map, 'primary')).toEqual(
      reading('primary', 5, { checkedAt: 30 }),
    )
  })

  test('a header-shaped partial observation leaves the family limit and the budget intact', () => {
    let map = apply(undefined, {
      checkedAt: 100,
      readings: [
        { label: 'primary', usedPercent: 10 },
        { scope: 'family-x', label: 'primary', usedPercent: 60 },
      ],
      budget: { kind: 'reading', reached: false, remainingPercent: 80 },
    })
    map = apply(map, {
      checkedAt: 200,
      readings: [{ label: 'primary', usedPercent: 20 }],
    })
    expect(entry(map, 'primary', 'family-x')).toEqual(
      reading('primary', 60, { scope: 'family-x', checkedAt: 100 }),
    )
    expect(map.budget).toEqual({
      kind: 'reading',
      reached: false,
      remainingPercent: 80,
      checkedAt: 100,
    })
    expect(entry(map, 'primary')).toEqual(
      reading('primary', 20, { checkedAt: 200 }),
    )
  })

  test('an older budget clear does not erase a newer budget reading', () => {
    let map = apply(undefined, {
      checkedAt: 100,
      budget: { kind: 'reading', reached: true, resetsAt: 'x' },
    })
    map = apply(map, { checkedAt: 90, budget: { kind: 'cleared' } })
    expect(map.budget).toEqual({
      kind: 'reading',
      reached: true,
      resetsAt: 'x',
      checkedAt: 100,
    })
  })

  test('an older budget reading does not undo a newer clear', () => {
    let map = apply(undefined, {
      checkedAt: 100,
      budget: { kind: 'cleared' },
    })
    map = apply(map, {
      checkedAt: 90,
      budget: { kind: 'reading', reached: true },
    })
    expect(map.budget).toEqual({ kind: 'cleared', checkedAt: 100 })
  })

  test('an equal-time budget observation applies', () => {
    let map = apply(undefined, {
      checkedAt: 100,
      budget: { kind: 'reading', reached: true },
    })
    map = apply(map, { checkedAt: 100, budget: { kind: 'cleared' } })
    expect(map.budget).toEqual({ kind: 'cleared', checkedAt: 100 })
    map = apply(map, {
      checkedAt: 100,
      budget: { kind: 'reading', reached: false },
    })
    expect(map.budget).toEqual({
      kind: 'reading',
      reached: false,
      checkedAt: 100,
    })
  })

  test('a cleared budget clears only the budget', () => {
    let map = apply(primaryAt100(), {
      checkedAt: 100,
      budget: { kind: 'reading', reached: true },
    })
    map = apply(map, { checkedAt: 150, budget: { kind: 'cleared' } })
    expect(map.budget).toEqual({ kind: 'cleared', checkedAt: 150 })
    expect(map.limits).toEqual([reading('primary', 40, { checkedAt: 100 })])
  })

  test('covered absence records an unlimited key until a reading not older replaces it', () => {
    let map = apply(undefined, { checkedAt: 110, coverage: [primary] })
    expect(map.limits).toEqual([absent('primary', 110)])
    map = apply(map, {
      checkedAt: 105,
      readings: [{ label: 'primary', usedPercent: 30 }],
    })
    expect(map.limits).toEqual([absent('primary', 110)])
    const atEqual = apply(map, {
      checkedAt: 110,
      readings: [{ label: 'primary', usedPercent: 30 }],
    })
    expect(atEqual.limits).toEqual([reading('primary', 30, { checkedAt: 110 })])
    const atLater = apply(map, {
      checkedAt: 115,
      readings: [{ label: 'primary', usedPercent: 35 }],
    })
    expect(atLater.limits).toEqual([reading('primary', 35, { checkedAt: 115 })])
  })

  test('on equal checkedAt the observation applied last wins', () => {
    let map = apply(undefined, {
      checkedAt: 100,
      readings: [{ label: 'primary', usedPercent: 10 }],
    })
    map = apply(map, {
      checkedAt: 100,
      readings: [{ label: 'primary', usedPercent: 90 }],
    })
    expect(map.limits).toEqual([reading('primary', 90, { checkedAt: 100 })])
  })

  test('merge keeps reading metadata and preserves unknown top-level map keys', () => {
    const stored = { limits: [], futureKey: { kept: true } }
    const map = apply(stored, {
      checkedAt: 100,
      readings: [
        {
          label: 'primary',
          usedPercent: 10,
          resetsAt: '2026-08-10T13:00:00.000Z',
          windowMinutes: 300,
        },
      ],
    })
    expect(map).toEqual({
      limits: [
        reading('primary', 10, {
          checkedAt: 100,
          resetsAt: '2026-08-10T13:00:00.000Z',
          windowMinutes: 300,
        }),
      ],
      futureKey: { kept: true },
    } as QuotaMap)
  })

  test('merge refuses a malformed stored map or observation without modifying its input', () => {
    const stored = primaryAt100()
    const before = JSON.stringify(stored)
    expect(() =>
      mergeQuotaObservation({ limits: 'x' }, { checkedAt: 1 }),
    ).toThrow(QuotaCodecError)
    expect(() =>
      mergeQuotaObservation(stored, { checkedAt: Number.NaN }),
    ).toThrow(QuotaCodecError)
    expect(() =>
      mergeQuotaObservation(stored, {
        checkedAt: 1,
        readings: [
          { label: 'primary', usedPercent: 1 },
          { scope: 'all', label: 'primary', usedPercent: 2 },
        ],
      }),
    ).toThrow(QuotaCodecError)
    mergeQuotaObservation(stored, {
      checkedAt: 200,
      coverage: [primary],
    })
    expect(JSON.stringify(stored)).toBe(before)
  })

  test('observation validation accepts the documented shape and rejects malformed parts', () => {
    expect(
      isQuotaObservation({
        checkedAt: 1,
        readings: [{ scope: 'family-x', label: 'primary', usedPercent: 1 }],
        coverage: [{ label: 'secondary' }],
        budget: { kind: 'cleared' },
      }),
    ).toBe(true)
    expect(
      isQuotaObservation({ checkedAt: 1, coverage: [{ label: '' }] }),
    ).toBe(false)
    expect(
      isQuotaObservation({
        checkedAt: 1,
        readings: [{ label: 'primary', usedPercent: 1, windowMinutes: 0 }],
      }),
    ).toBe(false)
    expect(
      isQuotaObservation({ checkedAt: 1, budget: { kind: 'reading' } }),
    ).toBe(false)
  })
})
