import { describe, expect, test } from 'bun:test'
import {
  formatQuota,
  NO_LIMITS_REPORTED,
  NO_QUOTA_READING,
  projectQuota,
  QUOTA_STALE_AFTER_MS,
  quotaTextParts,
  quotaWindowName,
} from '../../src/quota/index.js'
import {
  absent,
  at,
  HOUR,
  now,
  quotaMap,
  reading,
  retired,
  spentBudget,
} from './helpers.js'

const MINUTE = 60_000

// An OpenAI-shaped row: the provider's `primary` and `secondary` windows,
// stored with their lengths, plus a credit budget.
const openai = quotaMap(
  [
    reading('primary', 42, { windowMinutes: 300, resetsAt: at(2 * HOUR) }),
    reading('secondary', 10, {
      windowMinutes: 10_080,
      resetsAt: at(3 * 24 * HOUR),
    }),
  ],
  {
    kind: 'reading',
    checkedAt: now,
    reached: false,
    remainingPercent: 75,
  },
)

describe('shared quota wording', () => {
  test('windows are named by their length and read in percent left, shortest first', () => {
    expect(formatQuota(projectQuota(openai), { now, form: 'compact' })).toBe(
      '5h 58% left · 7d 90% left · credits 75% left',
    )
  })

  test('the full form adds a short relative reset to each window', () => {
    expect(formatQuota(projectQuota(openai), { now, form: 'full' })).toBe(
      '5h 58% left, resets 2h · 7d 90% left, resets 3d · credits 75% left',
    )
    expect(formatQuota(projectQuota(openai), { now })).toBe(
      formatQuota(projectQuota(openai), { now, form: 'full' }),
    )
  })

  test('a reset under an hour away is in minutes and a passed reset is left out', () => {
    const map = quotaMap([
      reading('primary', 50, { windowMinutes: 300, resetsAt: at(45 * MINUTE) }),
      reading('secondary', 50, {
        windowMinutes: 10_080,
        resetsAt: at(-MINUTE),
      }),
    ])
    expect(formatQuota(projectQuota(map), { now })).toBe(
      '5h 50% left, resets 45m · 7d 50% left',
    )
  })

  test('a model-scoped window keeps its stored label beside the general windows', () => {
    // anthropic-auth's model week: an extra cap stored under its own label.
    const map = quotaMap([
      reading('five_hour', 20, { windowMinutes: 300 }),
      reading('seven_day', 30, { windowMinutes: 10_080 }),
      reading('seven_day_opus', 60, { scope: 'opus', windowMinutes: 10_080 }),
    ])
    expect(formatQuota(projectQuota(map, 'opus'), { now })).toBe(
      '5h 80% left · 7d 70% left · seven_day_opus 40% left',
    )
    expect(
      quotaWindowName({
        scope: 'claude-opus',
        label: 'daily',
        windowMinutes: 1440,
      }),
    ).toBe('daily')
    expect(
      quotaWindowName({ scope: 'all', label: 'primary', windowMinutes: 90 }),
    ).toBe('90m')
    expect(
      quotaWindowName({ scope: 'all', label: 'primary', windowMinutes: 1440 }),
    ).toBe('1d')
  })

  test('a window the provider did not report is left out, never written as not reported', () => {
    const map = quotaMap([
      reading('primary', 42, { windowMinutes: 300 }),
      retired('secondary', now),
      absent('tertiary', now),
    ])
    const text = formatQuota(projectQuota(map), { now })
    expect(text).toBe('5h 58% left')
    expect(text).not.toContain('reported')
    expect(text).not.toContain('secondary')
  })

  test('with nothing reported the text says so in one short sentence', () => {
    expect(formatQuota(undefined, { now })).toBe(NO_QUOTA_READING)
    expect(formatQuota(projectQuota(quotaMap([])), { now })).toBe(
      NO_QUOTA_READING,
    )
    expect(
      formatQuota(projectQuota(quotaMap([absent('primary', now)])), { now }),
    ).toBe(NO_LIMITS_REPORTED)
    expect(quotaTextParts(undefined, { now })).toEqual([])
  })

  test('a reading older than fifteen minutes is marked with its age in both forms', () => {
    const map = (checkedAt: number) =>
      quotaMap([reading('primary', 42, { windowMinutes: 300, checkedAt })])
    const fresh = projectQuota(map(now - QUOTA_STALE_AFTER_MS))
    expect(formatQuota(fresh, { now })).toBe('5h 58% left')
    const stale = projectQuota(map(now - 3 * HOUR))
    expect(formatQuota(stale, { now, form: 'compact' })).toBe(
      '5h 58% left · checked 3h ago',
    )
    expect(formatQuota(stale, { now, form: 'full' })).toBe(
      '5h 58% left · checked 3h ago',
    )
    expect(formatQuota(projectQuota(map(now - 16 * MINUTE)), { now })).toBe(
      '5h 58% left · checked 16m ago',
    )
  })

  test('a spent budget reads credits spent and its reset only in the full form', () => {
    const map = quotaMap(
      [reading('primary', 100, { windowMinutes: 300 })],
      spentBudget(at(2 * 24 * HOUR)),
    )
    expect(formatQuota(projectQuota(map), { now, form: 'compact' })).toBe(
      '5h 0% left · credits spent',
    )
    expect(quotaTextParts(projectQuota(map), { now })).toEqual([
      '5h 0% left',
      'credits spent, resets 2d',
    ])
  })

  test('a window stored without a length falls back to its label', () => {
    // A snapshot written before lengths were recorded has none to show.
    const map = quotaMap([reading('primary', 42)])
    expect(formatQuota(projectQuota(map), { now })).toBe('primary 58% left')
  })
})
