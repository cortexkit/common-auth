import { describe, expect, test } from 'bun:test'
import {
  decodeQuotaMap,
  formatQuota,
  isQuotaCredits,
  isQuotaMap,
  isQuotaObservation,
  mergeQuotaObservation,
  projectQuota,
  QuotaCodecError,
  quotaCodec,
  quotaCreditsText,
  quotaTextParts,
  quotaWindowParts,
} from '../../src/quota/index.js'
import * as published from './fixtures/quota-0.22.0/map.js'
import * as publishedMerge from './fixtures/quota-0.22.0/merge.js'

const credits = (checkedAt: number, balance?: number) => ({
  hasCredits: true,
  unlimited: false,
  ...(balance === undefined ? {} : { balance }),
  checkedAt,
})

describe('quota credits', () => {
  test('the newest credits record wins in either arrival order using its own timestamp', () => {
    const older = { checkedAt: 900, credits: credits(100, 50) }
    const newer = {
      checkedAt: 1,
      credits: { ...credits(200, 7), overageLimitReached: true },
    }
    for (const [first, second] of [
      [older, newer],
      [newer, older],
    ] as const) {
      const stored = mergeQuotaObservation(undefined, first)
      const before = JSON.stringify(stored)
      const merged = mergeQuotaObservation(stored, second)
      expect(merged.credits).toEqual({
        hasCredits: true,
        unlimited: false,
        balance: 7,
        overageLimitReached: true,
        checkedAt: 200,
      })
      expect(JSON.stringify(stored)).toBe(before)
    }
  })

  test('equal-time credits apply, so the observation applied last wins', () => {
    const stored = mergeQuotaObservation(undefined, {
      checkedAt: 100,
      credits: credits(300, 40),
    })
    const merged = mergeQuotaObservation(stored, {
      checkedAt: 1,
      credits: { hasCredits: false, unlimited: false, checkedAt: 300 },
    })
    expect(merged.credits).toEqual({
      hasCredits: false,
      unlimited: false,
      checkedAt: 300,
    })
  })

  test('an observation without credits leaves the stored credits alone', () => {
    const stored = mergeQuotaObservation(undefined, {
      checkedAt: 100,
      readings: [{ label: 'primary', usedPercent: 20 }],
      budget: { kind: 'reading', reached: false },
      counters: { resetCredits: { value: 4, checkedAt: 100 } },
      credits: credits(100, 12),
    })
    for (const observation of [
      { checkedAt: 200 },
      { checkedAt: 200, coverage: [{ label: 'primary' }] },
      { checkedAt: 200, budget: { kind: 'cleared' } },
      {
        checkedAt: 200,
        counters: { resetCredits: { value: 0, checkedAt: 200 } },
      },
    ]) {
      expect(mergeQuotaObservation(stored, observation).credits).toEqual(
        credits(100, 12),
      )
    }
  })

  test('credits do not change limits, budget or counters', () => {
    const stored = mergeQuotaObservation(undefined, {
      checkedAt: 100,
      readings: [{ label: 'primary', usedPercent: 20 }],
      budget: { kind: 'reading', reached: false },
      counters: { resetCredits: { value: 4, checkedAt: 100 } },
    })
    const merged = mergeQuotaObservation(stored, {
      checkedAt: 1,
      credits: credits(500),
    })
    expect(merged.limits).toEqual(stored.limits)
    expect(merged.budget).toEqual(stored.budget)
    expect(merged.counters).toEqual(stored.counters)
    expect(merged.credits).toEqual(credits(500))
  })

  const malformed = [
    null,
    [],
    {},
    { hasCredits: true, checkedAt: 1 },
    { unlimited: false, checkedAt: 1 },
    { hasCredits: 'yes', unlimited: false, checkedAt: 1 },
    { hasCredits: true, unlimited: 0, checkedAt: 1 },
    { hasCredits: true, unlimited: false },
    { hasCredits: true, unlimited: false, checkedAt: '1' },
    { hasCredits: true, unlimited: false, checkedAt: Number.NaN },
    {
      hasCredits: true,
      unlimited: false,
      checkedAt: Number.POSITIVE_INFINITY,
    },
    { hasCredits: true, unlimited: false, balance: '12', checkedAt: 1 },
    { hasCredits: true, unlimited: false, balance: Number.NaN, checkedAt: 1 },
    {
      hasCredits: true,
      unlimited: false,
      balance: Number.POSITIVE_INFINITY,
      checkedAt: 1,
    },
    {
      hasCredits: true,
      unlimited: false,
      overageLimitReached: 'no',
      checkedAt: 1,
    },
  ]

  test('a malformed stored credits record is dropped on read and merge while limits, budget and counters are kept', () => {
    const kept = {
      limits: [
        {
          scope: 'all',
          label: 'primary',
          kind: 'reading' as const,
          checkedAt: 5,
          usedPercent: 20,
        },
      ],
      budget: { kind: 'cleared' as const, checkedAt: 5 },
      counters: { resetCredits: { value: 2, checkedAt: 5 } },
    }
    const stored = {
      ...kept,
      credits: { hasCredits: 'yes', unlimited: false, checkedAt: 5 },
    }
    expect(decodeQuotaMap(stored)).toEqual(kept)
    expect(mergeQuotaObservation(stored, { checkedAt: 6 })).toEqual(
      mergeQuotaObservation(kept, { checkedAt: 6 }),
    )
  })

  test.each(malformed.map((bad) => [bad] as const))(
    'malformed credits %j are refused in an observation and dropped from a stored map',
    (bad) => {
      const map = {
        limits: [
          {
            scope: 'all',
            label: 'primary',
            kind: 'reading' as const,
            checkedAt: 5,
            usedPercent: 20,
          },
        ],
        budget: { kind: 'cleared' as const, checkedAt: 5 },
        counters: { resetCredits: { value: 2, checkedAt: 5 } },
        credits: bad,
        future: { preserved: true },
      }
      const { credits: _dropped, ...kept } = map
      expect(isQuotaCredits(bad)).toBe(false)
      expect(isQuotaMap(map)).toBe(false)
      expect(decodeQuotaMap(map)).toEqual(kept)
      expect(quotaCodec.decode?.(map)).toEqual(kept)
      expect(isQuotaObservation({ checkedAt: 1, credits: bad })).toBe(false)
      expect(() =>
        mergeQuotaObservation(undefined, { checkedAt: 1, credits: bad }),
      ).toThrow(QuotaCodecError)
      // A stored map with bad credits merges like its decoded view.
      expect(mergeQuotaObservation(map, { checkedAt: 6 })).toEqual(
        mergeQuotaObservation(kept, { checkedAt: 6 }),
      )
      expect(mergeQuotaObservation(map, { checkedAt: 6 })).not.toHaveProperty(
        'credits',
      )
      expect(
        mergeQuotaObservation(map, { checkedAt: 6, credits: credits(6) })
          .credits,
      ).toEqual(credits(6))
    },
  )

  test('decoding returns a valid map with credits as the same object', () => {
    const map = {
      limits: [],
      counters: { resetCredits: { value: 1, checkedAt: 2 } },
      credits: { ...credits(2, 30), overageLimitReached: false },
    }
    expect(decodeQuotaMap(map)).toBe(map)
    expect(quotaCodec.decode?.(map)).toBe(map)
  })

  test('decoding still refuses malformed limits and budget beside valid credits', () => {
    expect(
      decodeQuotaMap({ limits: 'bad', credits: credits(1) }),
    ).toBeUndefined()
    expect(
      decodeQuotaMap({ limits: [], budget: {}, credits: credits(1) }),
    ).toBeUndefined()
  })

  test('projections carry credits in every scope without changing freshness', () => {
    const map = mergeQuotaObservation(undefined, {
      checkedAt: 100,
      readings: [{ label: 'primary', usedPercent: 20 }],
      credits: credits(900, 3),
    })
    for (const scope of ['all', 'family']) {
      const projected = projectQuota(map, scope)
      expect(projected.credits).toEqual(credits(900, 3))
      expect(projected.checkedAt).toBe(100)
    }
  })

  test('credit-free observations keep the legacy JSON bytes', () => {
    const observation = {
      checkedAt: 100,
      readings: [{ label: 'primary', usedPercent: 20 }],
      budget: { kind: 'cleared' },
    }
    const legacy =
      '{"limits":[{"scope":"all","label":"primary","kind":"reading","checkedAt":100,"usedPercent":20}],"budget":{"kind":"cleared","checkedAt":100}}'
    const map = mergeQuotaObservation(undefined, observation)
    expect(JSON.stringify(map)).toBe(legacy)
    expect(JSON.stringify(decodeQuotaMap(map))).toBe(legacy)
    expect(projectQuota(map)).not.toHaveProperty('credits')
  })

  test('a 0.22 reader carries credits it does not know untouched', () => {
    const map = mergeQuotaObservation(undefined, {
      checkedAt: 100,
      readings: [{ label: 'primary', usedPercent: 20 }],
      credits: { ...credits(100, 25), overageLimitReached: false },
    })
    const written = JSON.parse(JSON.stringify(map))
    expect(published.isQuotaMap(written)).toBe(true)
    expect(published.decodeQuotaMap(written)).toBe(written)
    const merged = publishedMerge.mergeQuotaObservation(written, {
      checkedAt: 200,
      readings: [{ label: 'primary', usedPercent: 60 }],
      budget: { kind: 'cleared' },
      counters: { resetCredits: { value: 1, checkedAt: 200 } },
    })
    expect((merged as unknown as { credits?: unknown }).credits).toEqual(
      map.credits,
    )
    // The current reader sees the 0.22 write with its credits intact.
    expect(decodeQuotaMap(JSON.parse(JSON.stringify(merged)))?.credits).toEqual(
      map.credits,
    )
  })
})

describe('quota credits text', () => {
  test.each([
    ['unlimited', { hasCredits: true, unlimited: true }, 'Unlimited'],
    [
      'unlimited without has-credits and with a balance',
      { hasCredits: false, unlimited: true, balance: 40 },
      'Unlimited',
    ],
    [
      'a whole balance',
      { hasCredits: true, unlimited: false, balance: 12 },
      '12 credits',
    ],
    [
      'a fractional balance, rounded',
      { hasCredits: true, unlimited: false, balance: 1234.6 },
      '1235 credits',
    ],
    [
      'a zero balance',
      { hasCredits: true, unlimited: false, balance: 0 },
      'Available',
    ],
    [
      'a negative balance',
      { hasCredits: true, unlimited: false, balance: -5 },
      'Available',
    ],
    [
      'an infinite balance',
      {
        hasCredits: true,
        unlimited: false,
        balance: Number.POSITIVE_INFINITY,
      },
      'Available',
    ],
    [
      'a NaN balance',
      { hasCredits: true, unlimited: false, balance: Number.NaN },
      'Available',
    ],
    ['no balance', { hasCredits: true, unlimited: false }, 'Available'],
    [
      'no credits',
      { hasCredits: false, unlimited: false, balance: 40 },
      undefined,
    ],
    ['no record', undefined, undefined],
  ] as const)('credits text for %s', (_name, input, expected) => {
    expect(quotaCreditsText(input)).toBe(expected)
  })

  test('the existing formatters do not add credits text', () => {
    const map = mergeQuotaObservation(undefined, {
      checkedAt: 100,
      readings: [{ label: 'primary', usedPercent: 20, windowMinutes: 300 }],
      budget: { kind: 'reading', reached: false, remainingPercent: 50 },
    })
    const withCredits = mergeQuotaObservation(map, {
      checkedAt: 100,
      credits: { hasCredits: true, unlimited: true, checkedAt: 100 },
    })
    for (const form of ['compact', 'full', 'narrow'] as const) {
      const options = { now: 200, form }
      expect(formatQuota(projectQuota(withCredits), options)).toBe(
        formatQuota(projectQuota(map), options),
      )
      expect(quotaTextParts(projectQuota(withCredits), options)).toEqual(
        quotaTextParts(projectQuota(map), options),
      )
      expect(quotaWindowParts(projectQuota(withCredits), options)).toEqual(
        quotaWindowParts(projectQuota(map), options),
      )
    }
  })
})
