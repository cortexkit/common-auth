import { describe, expect, test } from 'bun:test'
import type { ProjectedLimit, ProjectedQuota } from '../../src/quota/index.js'
import {
  formatQuota,
  isQuotaStale,
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
        short: '5h',
        figure: '58% left',
        remainingPercent: 58,
        resetIn: '2h',
        checkedAt: now,
        resetSinceReading: false,
      },
      {
        kind: 'window',
        name: '7d',
        short: '7d',
        figure: '90% left',
        remainingPercent: 90,
        resetIn: '3d',
        checkedAt: now,
        resetSinceReading: false,
      },
      {
        kind: 'budget',
        name: 'credits',
        short: 'cr',
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

  test('the full and compact forms keep their exact wording across a range of inputs', () => {
    // Pins every existing form byte for byte, so adding another form cannot
    // change what the dialogs and sidebars already show.
    const budgetWithoutPercent = {
      kind: 'reading' as const,
      checkedAt: now,
      reached: false,
      limit: 2500,
      used: 1000,
      remaining: 1500,
    }
    const inputs = [
      { name: 'no projection', quota: undefined },
      { name: 'empty map', quota: projectQuota(quotaMap([])) },
      {
        name: 'only an absence record',
        quota: projectQuota(quotaMap([absent('primary', now)])),
      },
      { name: 'openai row with budget', quota: projectQuota(openai) },
      {
        name: 'stale, out-of-range and fractional figures',
        quota: projectQuota(
          quotaMap([
            reading('primary', 7.6, {
              windowMinutes: 300,
              checkedAt: now - 3 * HOUR,
              resetsAt: at(-HOUR),
            }),
            reading('secondary', 130, {
              windowMinutes: 10_080,
              resetsAt: at(26 * HOUR),
            }),
            reading('tertiary', -20, { windowMinutes: 90 }),
          ]),
        ),
      },
      {
        name: 'spent budget beside a scoped window',
        quota: projectQuota(
          quotaMap(
            [
              reading('five_hour', 20, { windowMinutes: 300 }),
              reading('seven_day_opus', 60, {
                scope: 'opus',
                windowMinutes: 10_080,
                resetsAt: at(4 * 24 * HOUR),
              }),
            ],
            spentBudget(at(2 * 24 * HOUR)),
          ),
          'opus',
        ),
      },
      {
        name: 'budget without a percentage',
        quota: projectQuota(quotaMap([], budgetWithoutPercent)),
      },
    ]
    const rendered = inputs.map(({ name, quota }) => ({
      name,
      compact: formatQuota(quota, { now, form: 'compact' }),
      full: formatQuota(quota, { now, form: 'full' }),
    }))
    expect(rendered).toEqual([
      {
        name: 'no projection',
        compact: NO_QUOTA_READING,
        full: NO_QUOTA_READING,
      },
      { name: 'empty map', compact: NO_QUOTA_READING, full: NO_QUOTA_READING },
      {
        name: 'only an absence record',
        compact: NO_LIMITS_REPORTED,
        full: NO_LIMITS_REPORTED,
      },
      {
        name: 'openai row with budget',
        compact: '5h 58% left · 7d 90% left · credits 75% left',
        full: '5h 58% left, resets 2h · 7d 90% left, resets 3d · credits 75% left',
      },
      {
        name: 'stale, out-of-range and fractional figures',
        compact: '90m 100% left · 5h 92% left · 7d 0% left · checked 3h ago',
        full: '90m 100% left · 5h 92% left · 7d 0% left, resets 1d2h · checked 3h ago',
      },
      {
        name: 'spent budget beside a scoped window',
        compact: '5h 80% left · seven_day_opus 40% left · credits spent',
        full: '5h 80% left · seven_day_opus 40% left, resets 4d · credits spent, resets 2d',
      },
      {
        name: 'budget without a percentage',
        compact: 'credits available',
        full: 'credits available',
      },
    ])
  })

  test('a window stored without a length falls back to its label', () => {
    // A snapshot written before lengths were recorded has none to show.
    const map = quotaMap([reading('primary', 42)])
    expect(formatQuota(projectQuota(map), { now })).toBe('primary 58% left')
  })
})

// A projected limit built by hand, so one row can carry windows of several
// model scopes at once (a projection for one scope keeps only that scope).
function limit(
  scope: string,
  label: string,
  remainingPercent: number,
  windowMinutes?: number,
  extra: Partial<ProjectedLimit> = {},
): ProjectedLimit {
  return {
    scope,
    label,
    kind: 'reading',
    checkedAt: now,
    usedPercent: 100 - remainingPercent,
    remainingPercent,
    ...(windowMinutes === undefined ? {} : { windowMinutes }),
    ...extra,
  }
}

function row(
  limits: ProjectedLimit[],
  budget?: ProjectedQuota['budget'],
): ProjectedQuota {
  return {
    scope: 'all',
    limits,
    ...(budget === undefined ? {} : { budget }),
  }
}

const narrow = (quota: ProjectedQuota | undefined) =>
  formatQuota(quota, { now, form: 'narrow' })

const fiveHour = (remaining: number) =>
  limit('all', 'five_hour', remaining, 300)
const sevenDay = (remaining: number) =>
  limit('all', 'seven_day', remaining, 10_080)

describe('narrow quota wording', () => {
  test('each window reads its name and percent, with left once at the end', () => {
    expect(narrow(row([sevenDay(66), fiveHour(92)]))).toBe(
      '5h 92% · 7d 66% left',
    )
    expect(narrow(row([sevenDay(80)]))).toBe('7d 80% left')
    expect(narrow(projectQuota(openai))).toBe('5h 58% · 7d 90% · cr 75% left')
  })

  test('a model-scoped window follows the account-wide ones under its abbreviated model name', () => {
    expect(
      narrow(
        row([
          limit('fable', 'seven_day_fable', 98, 10_080),
          sevenDay(66),
          fiveHour(92),
        ]),
      ),
    ).toBe('5h 92% · 7d 66% · Fa 98% left')
    // A scoped window shorter than the account-wide ones still reads after them.
    expect(
      narrow(row([sevenDay(66), limit('mythos', 'mythos_hour', 40, 60)])),
    ).toBe('7d 66% · My 40% left')
    // A namespaced scope is named by the model after its namespace.
    expect(
      narrow(row([limit('model:claude-opus-4', 'opus_week', 50, 10_080)])),
    ).toBe('Cl 50% left')
  })

  test('scoped names that would collide are each extended one letter at a time until they differ', () => {
    const fabric = (remaining: number) =>
      limit('fabric', 'fabric_week', remaining, 10_080)
    const fable = (remaining: number) =>
      limit('fable', 'fable_week', remaining, 10_080)
    expect(narrow(row([fiveHour(90), fable(20), fabric(70)]))).toBe(
      '5h 90% · Fabl 20% left',
    )
    expect(narrow(row([fiveHour(90), fable(70), fabric(20)]))).toBe(
      '5h 90% · Fabr 20% left',
    )
    // A name that runs out of letters stays whole; the longer one extends.
    expect(narrow(row([limit('fa', 'fa_week', 30, 10_080), fable(60)]))).toBe(
      'Fa 30% left',
    )
    expect(narrow(row([limit('fa', 'fa_week', 60, 10_080), fable(30)]))).toBe(
      'Fab 30% left',
    )
    // Windows of the same model share its name; that is not a collision.
    expect(
      narrow(
        row([
          limit('fable', 'fable_day', 50, 1440),
          fable(40),
          limit('mythos', 'mythos_week', 90, 10_080),
        ]),
      ),
    ).toBe('Fa 40% left')
  })

  test('only the tightest model-scoped window shows, the first in display order on a tie', () => {
    const scoped = [
      limit('fable', 'fable_week', 55, 10_080),
      limit('mythos', 'mythos_week', 30, 10_080),
      limit('opus', 'opus_day', 80, 1440),
    ]
    expect(narrow(row([fiveHour(92), sevenDay(66), ...scoped]))).toBe(
      '5h 92% · 7d 66% · My 30% left',
    )
    // Equal remaining: the shorter window reads first in display order.
    expect(
      narrow(
        row([
          limit('mythos', 'mythos_week', 30, 10_080),
          limit('opus', 'opus_day', 30, 1440),
        ]),
      ),
    ).toBe('Op 30% left')
    // Equal remaining and length: the scopes' order decides.
    expect(
      narrow(
        row([
          limit('mythos', 'mythos_week', 30, 10_080),
          limit('fable', 'fable_week', 30, 10_080),
        ]),
      ),
    ).toBe('Fa 30% left')
    // Tightness compares the unrounded figure: 30.4 is tighter than 30.6
    // even though both round to 30.
    expect(
      narrow(
        row([
          limit('fable', 'fable_week', 30.6, 10_080),
          limit('mythos', 'mythos_week', 30.4, 10_080),
        ]),
      ),
    ).toBe('My 30% left')
  })

  test('a credit budget and scoped windows compete for one slot after the account-wide windows', () => {
    const fable = (remaining: number) =>
      limit('fable', 'fable_week', remaining, 10_080)
    const budget = (remainingPercent: number, reached = false) => ({
      checkedAt: now,
      reached,
      remainingPercent,
    })
    // Budget tighter than the scoped window: only the budget shows.
    expect(
      narrow(row([fiveHour(38), sevenDay(59), fable(80)], budget(22))),
    ).toBe('5h 38% · 7d 59% · cr 22% left')
    // Scoped window tighter than the budget: only the scoped window shows.
    expect(
      narrow(row([fiveHour(38), sevenDay(59), fable(22)], budget(75))),
    ).toBe('5h 38% · 7d 59% · Fa 22% left')
    // A tie goes to the scoped window, compared before rounding.
    expect(narrow(row([fiveHour(38), fable(40)], budget(40)))).toBe(
      '5h 38% · Fa 40% left',
    )
    expect(narrow(row([fiveHour(38), fable(40.4)], budget(40)))).toBe(
      '5h 38% · cr 40% left',
    )
    // A spent budget counts as 0% left, whatever percentage it carries.
    expect(narrow(row([fable(3)], budget(10, true)))).toBe('cr 0% left')
    // A budget without a percentage never takes the slot.
    expect(
      narrow(
        row([fiveHour(38), fable(90)], { checkedAt: now, reached: false }),
      ),
    ).toBe('5h 38% · Fa 90% left')
    // Among scoped windows, collision-extended names still apply.
    expect(
      narrow(
        row(
          [fiveHour(38), fable(50), limit('fabric', 'fabric_week', 20, 10_080)],
          budget(30),
        ),
      ),
    ).toBe('5h 38% · Fabr 20% left')
  })

  test('each part carries the short name the narrow line gives it', () => {
    const shorts = (quota: ProjectedQuota) =>
      quotaWindowParts(quota, { now }).windows.map((part) => [
        part.kind,
        part.name,
        part.short,
      ])
    const budget = { checkedAt: now, reached: false, remainingPercent: 50 }
    // Account-wide windows keep their name; a lone model window gets two
    // letters; the budget reads cr.
    expect(
      shorts(
        row([fiveHour(38), limit('fable', 'fable_week', 90, 10_080)], budget),
      ),
    ).toEqual([
      ['window', '5h', '5h'],
      ['window', expect.any(String), 'Fa'],
      ['budget', 'credits', 'cr'],
    ])
    // Colliding model names are extended exactly as the narrow line extends
    // them, and the narrow line uses the part's short name.
    const colliding = row([
      fiveHour(38),
      limit('fable', 'fable_week', 50, 10_080),
      limit('fabric', 'fabric_week', 20, 10_080),
    ])
    const parts = quotaWindowParts(colliding, { now }).windows
    expect(parts.map((part) => part.short)).toEqual(['5h', 'Fabl', 'Fabr'])
    expect(narrow(colliding)).toBe('5h 38% · Fabr 20% left')
  })

  test('the percentage is the compact figure: remaining, rounded and clamped', () => {
    const quota = row([
      limit('all', 'primary', 92.4, 300),
      limit('all', 'secondary', -30, 10_080),
      limit('all', 'tertiary', 100.5, 90),
    ])
    expect(formatQuota(quota, { now, form: 'compact' })).toBe(
      '90m 100% left · 5h 92% left · 7d 0% left',
    )
    expect(narrow(quota)).toBe('90m 100% · 5h 92% · 7d 0% left')
  })

  test('a credit budget reads cr with its percentage, cr 0% when spent, and is left out without one', () => {
    const budget = (
      fields: Partial<NonNullable<ProjectedQuota['budget']>>,
    ) => ({
      checkedAt: now,
      reached: false,
      ...fields,
    })
    // With no scoped window, the budget alone takes the slot.
    expect(
      narrow(row([fiveHour(92)], budget({ remainingPercent: 33.5 }))),
    ).toBe('5h 92% · cr 34% left')
    expect(
      narrow(
        row([fiveHour(92)], budget({ reached: true, remainingPercent: 4 })),
      ),
    ).toBe('5h 92% · cr 0% left')
    expect(narrow(row([fiveHour(92)], budget({ reached: true })))).toBe(
      '5h 92% · cr 0% left',
    )
    expect(narrow(row([fiveHour(92)], budget({})))).toBe('5h 92% left')
    // With nothing else to show, the budget keeps compact's wording rather
    // than leaving the line empty.
    expect(narrow(row([], budget({})))).toBe('credits available')
  })

  test('a stale reading adds no age; isQuotaStale reports it so the line can be dimmed', () => {
    const checked = (checkedAt: number) =>
      row([limit('all', 'primary', 58, 300, { checkedAt })])
    const stale = checked(now - 3 * HOUR)
    const fresh = checked(now - QUOTA_STALE_AFTER_MS)
    expect(formatQuota(stale, { now, form: 'compact' })).toBe(
      '5h 58% left · checked 3h ago',
    )
    expect(narrow(stale)).toBe('5h 58% left')
    expect(isQuotaStale(stale, { now })).toBe(true)
    expect(isQuotaStale(fresh, { now })).toBe(false)
    expect(isQuotaStale(checked(now - QUOTA_STALE_AFTER_MS - 1), { now })).toBe(
      true,
    )
    expect(isQuotaStale(stale, { now, staleAfterMs: 4 * HOUR })).toBe(false)
    expect(isQuotaStale(undefined, { now })).toBe(false)
  })

  test('a window that reset since the reading keeps its figure, as compact does', () => {
    const quota = row([
      limit('all', 'primary', 10, 300, {
        checkedAt: now - 10 * MINUTE,
        resetsAt: at(-MINUTE),
      }),
    ])
    expect(quotaWindowParts(quota, { now }).windows[0]).toMatchObject({
      resetSinceReading: true,
    })
    expect(formatQuota(quota, { now, form: 'compact' })).toBe('5h 10% left')
    expect(narrow(quota)).toBe('5h 10% left')
  })

  test('with nothing reported narrow says what compact says', () => {
    expect(narrow(undefined)).toBe(NO_QUOTA_READING)
    expect(narrow(projectQuota(quotaMap([])))).toBe(NO_QUOTA_READING)
    expect(narrow(projectQuota(quotaMap([absent('primary', now)])))).toBe(
      NO_LIMITS_REPORTED,
    )
    expect(quotaTextParts(undefined, { now, form: 'narrow' })).toEqual([])
  })

  test('quotaTextParts gives the narrow pieces that join into the narrow line', () => {
    const quota = row([sevenDay(66), fiveHour(92)], {
      checkedAt: now - HOUR,
      reached: false,
      remainingPercent: 75,
    })
    expect(quotaTextParts(quota, { now, form: 'narrow' })).toEqual([
      '5h 92%',
      '7d 66%',
      'cr 75% left',
    ])
  })
})
