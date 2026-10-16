import { describe, expect, test } from 'bun:test'
import {
  formatQuota,
  NO_LIMITS_REPORTED,
  NO_QUOTA_READING,
  projectQuota,
  QUOTA_STALE_AFTER_MS,
  quotaTextParts,
  quotaWindowName,
  quotaWindowParts,
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

  test('a reset shows its two largest units and is never shown later than it is', () => {
    const resetIn = (ms: number) =>
      quotaWindowParts(
        projectQuota(
          quotaMap([
            reading('primary', 42, {
              windowMinutes: 300,
              resetsAt: at(ms),
            }),
          ]),
        ),
        { now },
      ).windows[0]?.resetIn
    expect(resetIn(2 * HOUR + 29 * MINUTE)).toBe('2h29m')
    expect(resetIn(2 * HOUR + 31 * MINUTE)).toBe('2h31m')
    expect(resetIn(3 * 24 * HOUR + 23 * HOUR + 50 * MINUTE)).toBe('3d23h')
    expect(resetIn(5 * HOUR)).toBe('5h')
    expect(resetIn(24 * HOUR + 30 * MINUTE)).toBe('1d')
    expect(resetIn(59 * MINUTE + 40_000)).toBe('59m')
    expect(resetIn(2 * HOUR + 29 * MINUTE + 40_000)).toBe('2h29m')
    expect(resetIn(45 * MINUTE)).toBe('45m')
    expect(resetIn(30_000)).toBe('1m')
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

  test('quotaTextParts stays in parity with structured window parts across fixtures', () => {
    const fixtures = [
      {
        name: 'compact fresh windows, future resets and budget',
        quota: projectQuota(openai),
        form: 'compact' as const,
        expected: ['5h 58% left', '7d 90% left', 'credits 75% left'],
      },
      {
        name: 'full fresh windows, future resets and budget',
        quota: projectQuota(openai),
        form: 'full' as const,
        expected: [
          '5h 58% left, resets 2h',
          '7d 90% left, resets 3d',
          'credits 75% left',
        ],
      },
      {
        name: 'compact stale reading with a missing length',
        quota: projectQuota(
          quotaMap([reading('primary', 42, { checkedAt: now - 3 * HOUR })]),
        ),
        form: 'compact' as const,
        expected: ['primary 58% left', 'checked 3h ago'],
      },
      {
        name: 'full past reset and missing length',
        quota: projectQuota(
          quotaMap([reading('primary', 42, { resetsAt: at(-HOUR) })]),
        ),
        form: 'full' as const,
        expected: ['primary 58% left'],
      },
      {
        name: 'full spent budget with future reset',
        quota: projectQuota(quotaMap([], spentBudget(at(2 * 24 * HOUR)))),
        form: 'full' as const,
        expected: ['credits spent, resets 2d'],
      },
      {
        name: 'compact budget without a remaining percentage',
        quota: projectQuota(
          quotaMap([], {
            kind: 'reading',
            checkedAt: now,
            reached: false,
            limit: 2500,
            used: 1000,
            remaining: 1500,
          }),
        ),
        form: 'compact' as const,
        expected: ['credits available'],
      },
    ]

    for (const fixture of fixtures) {
      const options = { now, form: fixture.form }
      const structured = quotaWindowParts(fixture.quota, options)
      const rebuilt = [
        ...structured.windows.map((part) => {
          const reset =
            fixture.form === 'full' && part.resetIn
              ? `, resets ${part.resetIn}`
              : ''
          return `${part.kind === 'budget' ? '' : `${part.name} `}${part.figure}${reset}`
        }),
        ...(structured.age === undefined ? [] : [structured.age]),
      ]

      expect(rebuilt, fixture.name).toEqual(fixture.expected)
      expect(quotaTextParts(fixture.quota, options), fixture.name).toEqual(
        fixture.expected,
      )
      expect(formatQuota(fixture.quota, options), fixture.name).toBe(
        fixture.expected.join(' · '),
      )
    }
  })

  test('structured parts expose the figures, percentages, and future reset spans', () => {
    expect(quotaWindowParts(projectQuota(openai), { now }).windows).toEqual([
      {
        kind: 'window',
        name: '5h',
        figure: '58% left',
        remainingPercent: 58,
        resetIn: '2h',
        checkedAt: now,
        resetSinceReading: false,
      },
      {
        kind: 'window',
        name: '7d',
        figure: '90% left',
        remainingPercent: 90,
        resetIn: '3d',
        checkedAt: now,
        resetSinceReading: false,
      },
      {
        kind: 'budget',
        name: 'credits',
        figure: 'credits 75% left',
        remainingPercent: 75,
        checkedAt: now,
        resetSinceReading: false,
      },
    ])
  })

  test('a reset at now counts as since reading, but a reset before it does not', () => {
    const checkedAt = now - 3 * HOUR
    const equalToNow = projectQuota(
      quotaMap([reading('primary', 42, { checkedAt, resetsAt: at(0) })]),
    )
    const beforeReading = projectQuota(
      quotaMap([
        reading('primary', 42, { checkedAt, resetsAt: at(-4 * HOUR) }),
      ]),
    )

    const partsAtNow = quotaWindowParts(equalToNow, { now }).windows[0]
    expect(partsAtNow).toMatchObject({ resetSinceReading: true })
    expect(partsAtNow).not.toHaveProperty('resetIn')
    expect(quotaWindowParts(beforeReading, { now }).windows[0]).toMatchObject({
      resetSinceReading: false,
    })
  })

  test('age is included only when the stale threshold is exceeded', () => {
    const atThreshold = projectQuota(
      quotaMap([
        reading('primary', 42, {
          checkedAt: now - QUOTA_STALE_AFTER_MS,
        }),
      ]),
    )
    const overThreshold = projectQuota(
      quotaMap([
        reading('primary', 42, {
          checkedAt: now - QUOTA_STALE_AFTER_MS - 1,
        }),
      ]),
    )

    expect(quotaWindowParts(atThreshold, { now }).age).toBeUndefined()
    expect(quotaWindowParts(overThreshold, { now }).age).toBe('checked 15m ago')
  })

  test('a window stored without a length falls back to its label', () => {
    // A snapshot written before lengths were recorded has none to show.
    const map = quotaMap([reading('primary', 42)])
    expect(formatQuota(projectQuota(map), { now })).toBe('primary 58% left')
  })
})
