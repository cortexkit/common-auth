import { describe, expect, test } from 'bun:test'
import type { ProjectedLimit, ProjectedQuota } from '../../src/quota/index.js'
import {
  formatQuota,
  isQuotaStale,
  quotaTextParts,
  quotaWindowParts,
} from '../../src/quota/index.js'
import * as published from './fixtures/format-0.20.0.js'
import { at, HOUR, now } from './helpers.js'

const MINUTE = 60_000
const DAY = 24 * HOUR
const FIVE_HOURS = 300
const SEVEN_DAYS = 10_080

// A window of a named group, built the way antigravity-auth projects its
// stored reading: the group's key as the scope, the group and window length
// in the label (`Gemini 7d`), and the length in minutes.
function groupWindow(
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
    checkedAt: now - 2 * MINUTE,
    usedPercent: 100 - remainingPercent,
    remainingPercent,
    ...(windowMinutes === undefined ? {} : { windowMinutes }),
    ...extra,
  }
}

const ANTIGRAVITY_GROUPS = [
  { scope: 'gemini', label: 'Gemini' },
  { scope: 'non-gemini', label: 'Other models' },
]

// antigravity-auth's reading for one account: no account-wide window, and two
// groups (Gemini, and the other models) with a 5h and a 7d window each. Pass
// null for the same reading without its group list.
function antigravity(
  groups: ProjectedQuota['groups'] | null = ANTIGRAVITY_GROUPS,
): ProjectedQuota {
  return {
    scope: 'all',
    limits: [
      groupWindow('gemini', 'Gemini 5h', 95, FIVE_HOURS, {
        resetsAt: at(2 * HOUR),
      }),
      groupWindow('gemini', 'Gemini 7d', 62, SEVEN_DAYS, {
        resetsAt: at(3 * DAY),
      }),
      groupWindow('non-gemini', 'Other models 5h', 100, FIVE_HOURS, {
        resetsAt: at(5 * HOUR),
      }),
      groupWindow('non-gemini', 'Other models 7d', 48, SEVEN_DAYS, {
        resetsAt: at(6 * DAY),
      }),
    ],
    checkedAt: now - 2 * MINUTE,
    ...(groups === null ? {} : { groups }),
  }
}

const narrow = (quota: ProjectedQuota | undefined) =>
  formatQuota(quota, { now, form: 'narrow' })

// One group per name, each with a 5h and a 7d window at the given figures,
// listed in the order given.
function lettered(
  figures: readonly (readonly [string, number, number])[],
): ProjectedQuota {
  return {
    scope: 'all',
    limits: figures.flatMap(([name, fiveHour, sevenDay]) => [
      groupWindow(name, `${name} 5h`, fiveHour, FIVE_HOURS),
      groupWindow(name, `${name} 7d`, sevenDay, SEVEN_DAYS),
    ]),
    groups: figures.map(([name]) => ({ scope: name, label: `${name} models` })),
  }
}

describe('narrow quota wording for named groups', () => {
  test('the antigravity reading shows each group by its two-letter name with its tightest window', () => {
    expect(narrow(antigravity())).toBe('Ge 7d 62% · Ot 7d 48% left')
    expect(quotaTextParts(antigravity(), { now, form: 'narrow' })).toEqual([
      'Ge 7d 62%',
      'Ot 7d 48% left',
    ])
    // Without the group list the reading keeps the model-window rule.
    expect(narrow(antigravity(null))).toBe('No 48% left')
  })

  test('the tightest window of each group shows, compared before rounding, the shorter on a tie', () => {
    const quota = (gemini5h: number, gemini7d: number): ProjectedQuota => ({
      ...antigravity(),
      limits: [
        groupWindow('gemini', 'Gemini 5h', gemini5h, FIVE_HOURS),
        groupWindow('gemini', 'Gemini 7d', gemini7d, SEVEN_DAYS),
        groupWindow('non-gemini', 'Other models 7d', 48, SEVEN_DAYS),
      ],
    })
    expect(narrow(quota(20, 62))).toBe('Ge 5h 20% · Ot 7d 48% left')
    expect(narrow(quota(30.6, 30.4))).toBe('Ge 7d 30% · Ot 7d 48% left')
    expect(narrow(quota(50, 50))).toBe('Ge 5h 50% · Ot 7d 48% left')
  })

  test('with three groups the two with least left show, in listed order', () => {
    expect(
      narrow(
        lettered([
          ['Alpha', 90, 30],
          ['Beta', 80, 70],
          ['Gamma', 10, 95],
        ]),
      ),
    ).toBe('Al 7d 30% · Ga 5h 10% left')
    expect(
      narrow(
        lettered([
          ['Alpha', 90, 85],
          ['Beta', 40, 70],
          ['Gamma', 60, 50],
        ]),
      ),
    ).toBe('Be 5h 40% · Ga 7d 50% left')
  })

  test('groups with equal figures keep the order the reading lists them in', () => {
    expect(
      narrow(
        lettered([
          ['Gamma', 40, 90],
          ['Alpha', 40, 90],
          ['Beta', 40, 90],
        ]),
      ),
    ).toBe('Ga 5h 40% · Al 5h 40% left')
    expect(
      narrow(
        lettered([
          ['Alpha', 90, 70],
          ['Beta', 90, 20],
          ['Gamma', 90, 70],
        ]),
      ),
    ).toBe('Al 7d 70% · Be 7d 20% left')
  })

  test('a group with no windows is skipped and does not take a place', () => {
    const quota = lettered([
      ['Alpha', 90, 85],
      ['Beta', 40, 70],
    ])
    expect(
      narrow({
        ...quota,
        limits: [
          ...quota.limits,
          // A group the provider did not report: an absence record only.
          { scope: 'Empty', label: 'Empty 7d', kind: 'absent', checkedAt: now },
        ],
        groups: [{ scope: 'Empty', label: 'Empty' }, ...(quota.groups ?? [])],
      }),
    ).toBe('Al 7d 85% · Be 5h 40% left')
    // With no listed group reported at all, the line is what it would be
    // without the group list.
    expect(
      narrow({
        scope: 'all',
        limits: [groupWindow('fable', 'fable_week', 40, SEVEN_DAYS)],
        groups: [{ scope: 'gemini', label: 'Gemini' }],
      }),
    ).toBe('Fa 40% left')
  })

  test('a grouped line leaves out windows outside the listed groups and the budget', () => {
    const quota = antigravity()
    expect(
      narrow({
        ...quota,
        limits: [
          ...quota.limits,
          groupWindow('fable', 'fable_week', 5, SEVEN_DAYS),
        ],
        budget: { checkedAt: now, reached: true, remainingPercent: 0 },
      }),
    ).toBe('Ge 7d 62% · Ot 7d 48% left')
  })

  test('a group window stored without a length reads the group and its figure', () => {
    expect(
      narrow({
        scope: 'all',
        limits: [groupWindow('gemini', 'Gemini', 72.4)],
        groups: [{ scope: 'gemini', label: '  Gemini   Pro ' }],
      }),
    ).toBe('Ge 72% left')
  })

  test('group names are derived as model names are: capitalized, and extended on a collision', () => {
    const twoGroups = (first: string, second: string): ProjectedQuota => ({
      scope: 'all',
      limits: [
        groupWindow('a', 'a 7d', 30, SEVEN_DAYS),
        groupWindow('b', 'b 7d', 60, SEVEN_DAYS),
      ],
      groups: [
        { scope: 'a', label: first },
        { scope: 'b', label: second },
      ],
    })
    expect(narrow(twoGroups('gemini', 'other models'))).toBe(
      'Ge 7d 30% · Ot 7d 60% left',
    )
    expect(narrow(twoGroups('Gemini Pro', 'Gemini Flash'))).toBe(
      'Gemini P 7d 30% · Gemini F 7d 60% left',
    )
    // A blank label falls back to the group's scope.
    expect(narrow(twoGroups('  ', 'Other models'))).toBe(
      'A 7d 30% · Ot 7d 60% left',
    )
  })

  test('a stale grouped reading adds no age; isQuotaStale reports it', () => {
    const quota = antigravity()
    const stale: ProjectedQuota = {
      ...quota,
      limits: quota.limits.map((limit) => ({
        ...limit,
        checkedAt: now - 41 * HOUR,
      })),
    }
    expect(narrow(stale)).toBe('Ge 7d 62% · Ot 7d 48% left')
    expect(isQuotaStale(stale, { now })).toBe(true)
    expect(isQuotaStale(quota, { now })).toBe(false)
  })
})

// A small seeded generator, so the generated readings are the same on every
// run and a failure names a reproducible case.
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T
}

const LENGTHS = [undefined, 60, 90, FIVE_HOURS, 1440, SEVEN_DAYS] as const
const SCOPES = [
  'fable',
  'fabric',
  'fa',
  'mythos',
  'model:claude-opus-4',
  'gemini',
  'non-gemini',
] as const
const FIGURES = [-30, 0, 0.4, 22, 30.4, 30.6, 48, 50, 62, 99.5, 100, 100.5]

function generatedLimit(
  random: () => number,
  scope: string,
  index: number,
  accountWide: boolean,
): ProjectedLimit {
  const checkedAt = now - pick(random, [0, 2 * MINUTE, 16 * MINUTE, 3 * HOUR])
  // An account-wide window is always a reading, so every generated reading
  // that is meant to have one really shows one.
  const kind: ProjectedLimit['kind'] = accountWide
    ? 'reading'
    : pick(random, [
        'reading',
        'reading',
        'reading',
        'absent',
        'retired',
      ] as const)
  const windowMinutes = pick(random, LENGTHS)
  const remainingPercent =
    random() < 0.5 ? pick(random, FIGURES) : Math.round(random() * 1000) / 10
  return {
    scope,
    label: `${scope}_${index}`,
    kind,
    checkedAt,
    ...(windowMinutes === undefined ? {} : { windowMinutes }),
    ...(kind === 'reading'
      ? { usedPercent: 100 - remainingPercent, remainingPercent }
      : {}),
    ...(random() < 0.6
      ? { resetsAt: at(pick(random, [-HOUR, 0, 30 * MINUTE, 3 * DAY])) }
      : {}),
  }
}

function generatedQuota(
  random: () => number,
  accountWideCount: number,
): ProjectedQuota {
  const limits: ProjectedLimit[] = []
  for (let index = 0; index < accountWideCount; index++) {
    limits.push(generatedLimit(random, 'all', index, true))
  }
  const scopedCount = Math.floor(random() * 5)
  for (let index = 0; index < scopedCount; index++) {
    limits.push(generatedLimit(random, pick(random, SCOPES), index, false))
  }
  const budget: ProjectedQuota['budget'] =
    random() < 0.5
      ? undefined
      : {
          checkedAt: now - pick(random, [0, 20 * MINUTE]),
          reached: random() < 0.3,
          ...(random() < 0.8
            ? { remainingPercent: pick(random, FIGURES) }
            : {}),
        }
  const groups =
    random() < 0.5
      ? undefined
      : SCOPES.filter(() => random() < 0.5).map((scope) => ({
          scope,
          label: `${scope} models`,
        }))
  return {
    scope: 'all',
    limits,
    ...(budget === undefined ? {} : { budget }),
    ...(groups === undefined ? {} : { groups }),
  }
}

type Formatter = Pick<
  typeof published,
  'formatQuota' | 'quotaTextParts' | 'quotaWindowParts' | 'isQuotaStale'
>

// Everything a formatter shows for one reading, in every form.
function rendered(formatter: Formatter, quota: ProjectedQuota) {
  return {
    narrow: formatter.formatQuota(quota, { now, form: 'narrow' }),
    narrowParts: formatter.quotaTextParts(quota, { now, form: 'narrow' }),
    compact: formatter.formatQuota(quota, { now, form: 'compact' }),
    full: formatter.formatQuota(quota, { now, form: 'full' }),
    parts: formatter.quotaWindowParts(quota, { now }),
    stale: formatter.isQuotaStale(quota, { now }),
  }
}

const live: Formatter = {
  formatQuota,
  quotaTextParts,
  quotaWindowParts,
  isQuotaStale,
}

describe('readings outside the group rule keep the 0.20.0 wording', () => {
  test('generated readings with account-wide windows read exactly as in 0.20.0, with or without listed groups', () => {
    const random = seeded(20_000)
    let withGroups = 0
    for (let run = 0; run < 3000; run++) {
      const quota = generatedQuota(random, 1 + Math.floor(random() * 3))
      if (quota.groups?.length) withGroups++
      expect({ run, ...rendered(live, quota) }).toEqual({
        run,
        ...rendered(published, quota),
      })
    }
    // Enough of the generated readings list groups for the comparison to
    // cover a group list beside account-wide windows.
    expect(withGroups).toBeGreaterThan(1000)
  })

  test('generated readings without a group list read exactly as in 0.20.0', () => {
    const random = seeded(20_001)
    for (let run = 0; run < 3000; run++) {
      const { groups: _unused, ...quota } = generatedQuota(
        random,
        Math.floor(random() * 3),
      )
      expect({ run, ...rendered(live, quota) }).toEqual({
        run,
        ...rendered(published, quota),
      })
    }
  })
})
