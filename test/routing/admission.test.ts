import { describe, expect, test } from 'bun:test'
import {
  budgetExhaustedResetAt,
  type CreditBudgetReading,
  mergeQuotaObservation,
  projectQuota,
  type QuotaMap,
} from '../../src/quota/index.js'
import {
  type AdmissionInput,
  admit,
  type RoutingRow,
} from '../../src/routing/index.js'
import {
  absent,
  at,
  HOUR,
  now,
  primaryAt,
  quotaMap,
  reading,
  retired,
  spentBudget,
} from '../quota/helpers.js'
import { apiKey, oauth } from './helpers.js'

const weekReset = at(7 * 24 * HOUR)
const creditReset = at(30 * 24 * HOUR)

function run(rows: RoutingRow[], extra: Partial<AdmissionInput> = {}) {
  const pulls: string[] = []
  const result = admit({
    rows,
    now,
    requestPull: (id) => {
      pulls.push(id)
    },
    ...extra,
  })
  return { ...result, fired: pulls }
}

const ids = (rows: { id: string }[]) => rows.map((row) => row.id)

function withBudget(map: QuotaMap, budget = spentBudget(creditReset)) {
  return { ...map, budget }
}

describe('admission credit budget', () => {
  test('admission quota skips a fallback whose credit budget is spent', () => {
    const result = run([
      oauth('work-alt', withBudget(primaryAt(20))),
      oauth('client-alt', primaryAt(20)),
    ])
    expect(ids(result.admitted)).toEqual(['client-alt'])
    expect(result.refused).toEqual([
      {
        id: 'work-alt',
        stage: 2,
        reason: 'budget-spent',
        resetsAt: creditReset,
        resetAtMs: Date.parse(creditReset),
      },
    ])
    expect(result.fired).toEqual([])
  })

  test('admission quota preserves the last fallback when every credit budget is spent', () => {
    const result = run([
      oauth('main', primaryAt(100)),
      oauth('work-alt', withBudget(primaryAt(20))),
    ])
    expect(result.admitted).toEqual([
      {
        id: 'work-alt',
        kind: 'oauth',
        projection: projectQuota(withBudget(primaryAt(20)), 'all'),
        lastPath: true,
      },
    ])
    expect(result.refused.map((refusal) => refusal.reason)).toEqual([
      'exhausted',
    ])
  })

  test('admission quota retains an exhausted-looking fallback after its reset passes', () => {
    const result = run([
      oauth('work-alt', withBudget(primaryAt(20), spentBudget(at(-60_000)))),
      oauth('client-alt', primaryAt(20)),
    ])
    expect(ids(result.admitted)).toEqual(['work-alt', 'client-alt'])
    expect(result.refused).toEqual([])
  })

  test('a reached credit budget with a future reset exhausts the account', () => {
    const spent = withBudget(primaryAt(20))
    expect(budgetExhaustedResetAt(projectQuota(spent), now)).toEqual({
      resetsAt: creditReset,
      resetAtMs: Date.parse(creditReset),
    })
    expect(ids(run([oauth('spent', spent), apiKey('key')]).admitted)).toEqual([
      'key',
    ])
  })

  test('a healthy credit budget does not exhaust the account', () => {
    const healthy = withBudget(primaryAt(20), {
      ...(spentBudget(creditReset) as CreditBudgetReading),
      reached: false,
      remainingPercent: 80,
    })
    expect(budgetExhaustedResetAt(projectQuota(healthy), now)).toBeUndefined()
    expect(
      ids(run([oauth('healthy', healthy), apiKey('key')]).admitted),
    ).toEqual(['healthy', 'key'])
  })

  test.each([
    ['missing reset', spentBudget(undefined)],
    ['malformed reset', spentBudget('not-a-date')],
    ['reset already past', spentBudget(at(-HOUR))],
  ])('fails open on a reached credit budget with %s', (_label, budget) => {
    const map = withBudget(primaryAt(20), budget)
    expect(budgetExhaustedResetAt(projectQuota(map), now)).toBeUndefined()
    expect(ids(run([oauth('a', map), apiKey('key')]).admitted)).toEqual([
      'a',
      'key',
    ])
  })

  test('a spent budget plus a live exhausted limit stays refused as the last one standing', () => {
    const map = withBudget(primaryAt(100))
    const result = run([oauth('only', map)])
    expect(result.admitted).toEqual([])
    expect(result.refused.map((refusal) => refusal.reason)).toEqual([
      'exhausted',
    ])
  })

  test('a spent budget whose only alternative has unknown quota is admitted as the last path', () => {
    const result = run([
      oauth('unknown'),
      oauth('spent', withBudget(primaryAt(20))),
    ])
    expect(ids(result.admitted)).toEqual(['spent'])
    expect(result.admitted[0]?.lastPath).toBe(true)
    expect(result.refused.map((refusal) => refusal.reason)).toEqual([
      'needs-first-reading',
    ])
    expect(result.fired).toEqual(['unknown'])
  })

  test('an api-key row is a surviving path, so a spent budget beside it is refused', () => {
    const result = run([
      oauth('spent', withBudget(primaryAt(20))),
      apiKey('key'),
    ])
    expect(ids(result.admitted)).toEqual(['key'])
  })
})

describe('admission gates', () => {
  test('gate 1: an api-key row is admitted without quota', () => {
    const result = run([{ id: 'key', kind: 'api-key', quota: primaryAt(100) }])
    expect(result.admitted).toEqual([{ id: 'key', kind: 'api-key' }])
    expect(result.fired).toEqual([])
  })

  test('gate 2: an OAuth row with no evidence for the scope needs a first reading and requests a pull', () => {
    const result = run([oauth('empty', quotaMap([])), oauth('none')])
    expect(result.admitted).toEqual([])
    expect(result.refused).toEqual([
      {
        id: 'empty',
        stage: 1,
        gate: 2,
        reason: 'needs-first-reading',
        pullRequested: true,
      },
      {
        id: 'none',
        stage: 1,
        gate: 2,
        reason: 'needs-first-reading',
        pullRequested: true,
      },
    ])
    expect(result.fired).toEqual(['empty', 'none'])
    expect(result.pulls).toEqual(['empty', 'none'])
  })

  test('gate 2: a no-reading sole OAuth candidate stays refused with its pull requested', () => {
    const result = run([oauth('sole')])
    expect(result.admitted).toEqual([])
    expect(result.fired).toEqual(['sole'])
  })

  test('gate 2: a family-only map refuses an all-scope request as needing a first reading', () => {
    const map = quotaMap([reading('primary', 10, { scope: 'family-x' })])
    const result = run([oauth('a', map)], { scope: 'all' })
    expect(result.refused.map((refusal) => refusal.reason)).toEqual([
      'needs-first-reading',
    ])
    expect(ids(run([oauth('a', map)], { scope: 'family-x' }).admitted)).toEqual(
      ['a'],
    )
  })

  test('gate 3: a missing required label is unknown for that window and the required-label input decides it', () => {
    const map = quotaMap([
      reading('secondary', 10, { resetsAt: weekReset, windowMinutes: 10_080 }),
    ])
    const refused = run([oauth('a', map)])
    expect(refused.refused).toEqual([
      {
        id: 'a',
        stage: 1,
        gate: 3,
        reason: 'unknown-window',
        window: { scope: 'all', label: 'primary' },
        pullRequested: true,
      },
    ])
    expect(refused.fired).toEqual(['a'])
    const admitted = run([oauth('a', map)], { requiredLabels: ['secondary'] })
    expect(ids(admitted.admitted)).toEqual(['a'])
    expect(admitted.fired).toEqual([])
  })

  test('an all-models primary reading admits a family request', () => {
    expect(
      ids(run([oauth('a', primaryAt(20))], { scope: 'family-x' }).admitted),
    ).toEqual(['a'])
  })

  test.each([
    ['a passed reset', at(-60_000)],
    ['a missing reset', undefined],
    ['an unparsable reset', 'not-a-date'],
  ])(
    'gate 4: an exhausted reading with %s is refused unknown with a pull',
    (_label, resetsAt) => {
      const map = quotaMap([
        reading('primary', 100, resetsAt === undefined ? {} : { resetsAt }),
      ])
      const result = run([oauth('a', map)])
      expect(result.refused).toEqual([
        {
          id: 'a',
          stage: 1,
          gate: 4,
          reason: 'unknown-reset',
          window: { scope: 'all', label: 'primary' },
          pullRequested: true,
        },
      ])
      expect(result.fired).toEqual(['a'])
    },
  )

  test('gate 4 leaves a reading below 100% admitted whatever its reset says', () => {
    const map = quotaMap([reading('primary', 99, { resetsAt: at(-HOUR) })])
    expect(ids(run([oauth('a', map)]).admitted)).toEqual(['a'])
  })

  test('gate 5: an exhausted reading with a future reset is refused exhausted without a pull', () => {
    const result = run([oauth('a', primaryAt(100))])
    expect(result.refused).toEqual([
      {
        id: 'a',
        stage: 1,
        gate: 5,
        reason: 'exhausted',
        window: { scope: 'all', label: 'primary' },
        resetsAt: weekReset,
        resetAtMs: Date.parse(weekReset),
      },
    ])
    expect(result.fired).toEqual([])
  })

  test('a third window reaches admission and alone drives a refusal', () => {
    const map = quotaMap([
      reading('primary', 10, { resetsAt: weekReset, windowMinutes: 300 }),
      reading('secondary', 10, { resetsAt: weekReset, windowMinutes: 10_080 }),
      reading('tertiary', 100, { resetsAt: weekReset, windowMinutes: 60 }),
    ])
    const result = run([oauth('a', map)])
    expect(result.refused).toMatchObject([
      { id: 'a', reason: 'exhausted', window: { label: 'tertiary' } },
    ])
  })

  test('a reading older than the staleness threshold is admitted', () => {
    const stale = primaryAt(20, now - 24 * HOUR)
    expect(ids(run([oauth('a', stale)]).admitted)).toEqual(['a'])
  })

  test('a map holding only a tombstone or absence record for the requested pairs is admitted', () => {
    const result = run([
      oauth('retired', quotaMap([retired('primary', 5)])),
      oauth('absent', quotaMap([absent('primary', 5)])),
    ])
    expect(ids(result.admitted)).toEqual(['retired', 'absent'])
    expect(result.fired).toEqual([])
  })

  test('covered absence admits as known-unlimited', () => {
    const map = mergeQuotaObservation(undefined, {
      checkedAt: 110,
      coverage: [{ label: 'primary' }],
    })
    expect(ids(run([oauth('a', map)]).admitted)).toEqual(['a'])
  })

  test('gates apply in precedence order', () => {
    const map = quotaMap([
      reading('primary', 100, { resetsAt: weekReset }),
      reading('secondary', 100),
    ])
    expect(run([oauth('a', map)]).refused).toMatchObject([
      { gate: 4, window: { label: 'secondary' } },
    ])
    expect(
      run([oauth('a', map)], { requiredLabels: ['primary', 'tertiary'] })
        .refused,
    ).toMatchObject([{ gate: 3, window: { label: 'tertiary' } }])
  })

  test('a rate-limit mark or refresh backoff excludes the row before the gates until it expires', () => {
    const rows = [oauth('marked'), oauth('backed'), apiKey('key')]
    const marks = {
      rateLimitMarks: new Map([['marked', now + 1]]),
      refreshBackoff: new Map([['backed', now + 1]]),
    }
    const excluded = run(rows, marks)
    expect(excluded.excluded).toEqual([
      { id: 'marked', reason: 'rate-limited', until: now + 1 },
      { id: 'backed', reason: 'refresh-backoff', until: now + 1 },
    ])
    expect(excluded.fired).toEqual([])
    const expired = run(rows, { ...marks, now: now + 1 })
    expect(expired.excluded).toEqual([])
    expect(expired.fired).toEqual(['marked', 'backed'])
  })

  test('the pull request is synchronous and never awaited', () => {
    let calls = 0
    const result = admit({
      rows: [oauth('a')],
      now,
      requestPull: () => {
        calls += 1
        return new Promise<void>(() => {}) as unknown as undefined
      },
    })
    expect(calls).toBe(1)
    expect(result.refused).toHaveLength(1)
  })
})

// A provider whose model families carry a weekly cap on top of the general
// weekly cap stores the family week under its own label, so both caps reach
// admission for a family request.
describe('admission with a family cap under its own label', () => {
  const required = { requiredLabels: ['five_hour', 'seven_day'] }

  function additiveWeeks(generalUsed: number, familyUsed: number): QuotaMap {
    return quotaMap([
      reading('five_hour', 10, { resetsAt: at(HOUR), windowMinutes: 300 }),
      reading('seven_day', generalUsed, {
        resetsAt: weekReset,
        windowMinutes: 10_080,
      }),
      reading('seven_day_opus', familyUsed, {
        scope: 'opus',
        resetsAt: weekReset,
        windowMinutes: 10_080,
      }),
    ])
  }

  test('an exhausted general week refuses a family request whose own week is healthy', () => {
    const map = additiveWeeks(100, 5)
    for (const scope of ['opus', 'all']) {
      const result = run([oauth('a', map)], { ...required, scope })
      expect(result.admitted).toEqual([])
      expect(result.refused).toMatchObject([
        {
          id: 'a',
          gate: 5,
          reason: 'exhausted',
          window: { scope: 'all', label: 'seven_day' },
        },
      ])
    }
  })

  test('an exhausted family week refuses the family request and leaves the general request admitted', () => {
    const map = additiveWeeks(10, 100)
    const family = run([oauth('a', map)], { ...required, scope: 'opus' })
    expect(family.admitted).toEqual([])
    expect(family.refused).toMatchObject([
      {
        id: 'a',
        gate: 5,
        reason: 'exhausted',
        window: { scope: 'opus', label: 'seven_day_opus' },
      },
    ])
    const general = run([oauth('a', map)], { ...required, scope: 'all' })
    expect(ids(general.admitted)).toEqual(['a'])
  })
})
