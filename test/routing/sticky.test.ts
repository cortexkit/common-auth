import { describe, expect, test } from 'bun:test'
import {
  budgetExhaustedResetAt,
  type ProjectedBudget,
  type ProjectedQuota,
  projectQuota,
} from '../../src/quota/index.js'
import {
  admit,
  decideStickyBreak,
  MIN_RESET_HOURS,
  pendingBytesForPins,
  QUOTA_STALENESS_MS,
  routeSticky,
  type StickySelectionCandidate,
  selectStickyCandidate,
  snapshotCheckedAt,
  sustainableWindowWeight,
} from '../../src/routing/index.js'
import { quotaMap, reading, retired } from '../quota/helpers.js'
import { apiKey, oauth } from './helpers.js'

const now = Date.UTC(2026, 7, 10, 12, 0, 0)

// openai-auth's single-primary-window snapshot, as the projection of a map
// holding one (all, primary) reading.
function quota(
  remainingPercent: number,
  checkedAt = now,
  resetsAt?: string,
): ProjectedQuota {
  return projectQuota(
    quotaMap([
      reading('primary', 100 - remainingPercent, {
        checkedAt,
        ...(resetsAt === undefined ? {} : { resetsAt }),
      }),
    ]),
  )
}

function twoWindows(
  primary: { remaining: number; windowMinutes?: number; resetsAt?: string },
  secondary: { remaining: number; windowMinutes?: number; resetsAt?: string },
): ProjectedQuota {
  return projectQuota(
    quotaMap([
      reading('primary', 100 - primary.remaining, {
        ...(primary.windowMinutes === undefined
          ? {}
          : { windowMinutes: primary.windowMinutes }),
        ...(primary.resetsAt === undefined
          ? {}
          : { resetsAt: primary.resetsAt }),
      }),
      reading('secondary', 100 - secondary.remaining, {
        ...(secondary.windowMinutes === undefined
          ? {}
          : { windowMinutes: secondary.windowMinutes }),
        ...(secondary.resetsAt === undefined
          ? {}
          : { resetsAt: secondary.resetsAt }),
      }),
    ]),
  )
}

function candidate(
  accountId: string,
  accountQuota: ProjectedQuota | null | undefined,
  configuredOrder: number,
  overrides: Partial<StickySelectionCandidate> = {},
): StickySelectionCandidate {
  return {
    accountId,
    quota: accountQuota,
    reservePercent: { primary: 0, secondary: 0 },
    configuredOrder,
    ...overrides,
  }
}

function select(
  candidates: StickySelectionCandidate[],
  pendingBytes: ReadonlyMap<string, number> = new Map(),
  requestBytes = 1,
) {
  const result = selectStickyCandidate({
    candidates,
    pendingBytes,
    requestBytes,
    now,
  })
  if (!result) throw new Error('test helper: no candidate selected')
  return result
}

describe('sustainableWindowWeight', () => {
  test('keeps spendable capacity when the reset is unknown', () => {
    expect(sustainableWindowWeight({ remainingPercent: 40 }, 10, now)).toBe(30)
  })

  test('uses the minimum reset duration for near resets', () => {
    const remaining = 40
    const windowResettingIn30Seconds = {
      remainingPercent: remaining,
      resetsAt: new Date(now + 30_000).toISOString(),
    }

    expect(
      sustainableWindowWeight(windowResettingIn30Seconds, 0, now),
    ).toBeCloseTo(remaining / MIN_RESET_HOURS)
  })

  test('keeps spendable capacity when the reset timestamp is past', () => {
    expect(
      sustainableWindowWeight(
        { remainingPercent: 40, resetsAt: new Date(now - 1).toISOString() },
        10,
        now,
      ),
    ).toBe(30)
  })

  test('keeps spendable capacity when the reset timestamp is invalid', () => {
    expect(
      sustainableWindowWeight(
        { remainingPercent: 40, resetsAt: 'not-a-date' },
        10,
        now,
      ),
    ).toBe(30)
  })

  test('returns zero at the reserve threshold', () => {
    expect(sustainableWindowWeight({ remainingPercent: 10 }, 10, now)).toBe(0)
  })
})

describe('snapshotCheckedAt', () => {
  test('prefers the projection time, then the cache entry timestamp', () => {
    expect(snapshotCheckedAt(quota(50, 30), 10)).toBe(30)
    expect(snapshotCheckedAt({ scope: 'all', limits: [] }, 10)).toBe(10)
    expect(
      snapshotCheckedAt({ scope: 'all', limits: [], checkedAt: Number.NaN }),
    ).toBeUndefined()
  })
})

describe('decideStickyBreak', () => {
  test.each([
    {
      name: 'migrates permanent authorization failures before quota ignorance',
      input: { quota: null, status: 401, now },
      want: { action: 'migrate', reason: 'permanent' },
    },
    {
      name: 'migrates forbidden responses permanently',
      input: { quota: quota(50), status: 403, now },
      want: { action: 'migrate', reason: 'permanent' },
    },
    {
      name: 'retains an account with no quota snapshot',
      input: { quota: undefined, status: 400, now },
      want: { action: 'retain', reason: 'unknown' },
    },
    {
      name: 'retains an account with a stale snapshot',
      input: {
        quota: quota(0, now - QUOTA_STALENESS_MS - 1),
        status: 400,
        now,
      },
      want: { action: 'retain', reason: 'stale' },
    },
    {
      name: 'retains an account with a malformed snapshot timestamp',
      input: {
        quota: { scope: 'all', limits: [], checkedAt: Number.NaN },
        status: 400,
        now,
      },
      want: { action: 'retain', reason: 'stale' },
    },
    {
      name: 'migrates an exhausted fresh window with diagnostic reset metadata',
      input: {
        quota: quota(0, now, '2026-08-10T13:00:00.000Z'),
        status: 400,
        now,
      },
      want: {
        action: 'migrate',
        reason: 'exhausted',
        window: { scope: 'all', label: 'primary' },
        resetsAt: '2026-08-10T13:00:00.000Z',
      },
    },
    {
      name: 'treats a rate limit with healthy quota as transient',
      input: { quota: quota(50), status: 429, now },
      want: { action: 'retain', reason: 'transient' },
    },
    {
      name: 'treats a rate limit with no present fresh quota windows as transient',
      input: {
        quota: { scope: 'all', limits: [], checkedAt: now },
        status: 429,
        now,
      },
      want: { action: 'retain', reason: 'transient' },
    },
    {
      name: 'treats server failures as transient',
      input: { quota: quota(50), status: 500, now },
      want: { action: 'retain', reason: 'transient' },
    },
    {
      name: 'treats indeterminate transport failures as transient',
      input: { quota: quota(50), now },
      want: { action: 'retain', reason: 'transient' },
    },
    {
      name: 'retains a healthy account for non-routing client failures',
      input: { quota: quota(50), status: 400, now },
      want: { action: 'retain', reason: 'healthy' },
    },
    {
      name: 'does not migrate malformed exhausted-looking percentages',
      input: { quota: quota(Number.NaN), status: 400, now },
      want: { action: 'retain', reason: 'healthy' },
    },
    {
      name: 'does not migrate non-finite exhausted-looking percentages',
      input: { quota: quota(Number.NEGATIVE_INFINITY), status: 400, now },
      want: { action: 'retain', reason: 'healthy' },
    },
  ])('$name', ({ input, want }) => {
    expect(decideStickyBreak(input)).toEqual(want as never)
  })

  test('skips healthy windows when a longer window is exhausted', () => {
    const accountQuota = twoWindows(
      { remaining: 50, windowMinutes: 300 },
      {
        remaining: 0,
        windowMinutes: 10_080,
        resetsAt: '2026-08-17T12:00:00.000Z',
      },
    )

    expect(
      decideStickyBreak({ quota: accountQuota, status: 400, now }),
    ).toEqual({
      action: 'migrate',
      reason: 'exhausted',
      window: { scope: 'all', label: 'secondary' },
      resetsAt: '2026-08-17T12:00:00.000Z',
    })
  })

  test('reports the longest exhausted window when every window is exhausted', () => {
    const accountQuota = twoWindows(
      {
        remaining: 0,
        windowMinutes: 300,
        resetsAt: '2026-08-10T13:00:00.000Z',
      },
      {
        remaining: 0,
        windowMinutes: 10_080,
        resetsAt: '2026-08-17T12:00:00.000Z',
      },
    )

    expect(
      decideStickyBreak({ quota: accountQuota, status: 400, now }),
    ).toEqual({
      action: 'migrate',
      reason: 'exhausted',
      window: { scope: 'all', label: 'secondary' },
      resetsAt: '2026-08-17T12:00:00.000Z',
    })
  })

  test('names the exhausted limit by its label rather than the slot it occupies', () => {
    // The secondary-labelled week sorts into the first slot; the exhausted
    // limit in the second slot is the primary-labelled five hours.
    const accountQuota = twoWindows(
      {
        remaining: 0,
        windowMinutes: 300,
        resetsAt: '2026-08-10T13:00:00.000Z',
      },
      { remaining: 50, windowMinutes: 10_080 },
    )
    expect(accountQuota.limits.map((limit) => limit.label)).toEqual([
      'secondary',
      'primary',
    ])
    expect(
      decideStickyBreak({ quota: accountQuota, status: 400, now }),
    ).toEqual({
      action: 'migrate',
      reason: 'exhausted',
      window: { scope: 'all', label: 'primary' },
      resetsAt: '2026-08-10T13:00:00.000Z',
    })
  })

  test('omits non-string reset metadata from exhausted decisions', () => {
    const accountQuota = quota(0)
    accountQuota.limits = accountQuota.limits.map((limit) => ({
      ...limit,
      resetsAt: 1 as never,
    }))

    expect(
      decideStickyBreak({ quota: accountQuota, status: 400, now }),
    ).toEqual({
      action: 'migrate',
      reason: 'exhausted',
      window: { scope: 'all', label: 'primary' },
    })
  })

  test('never returns a hold action', () => {
    const decisions = [
      decideStickyBreak({ quota: null, now }),
      decideStickyBreak({ quota: quota(0), status: 400, now }),
      decideStickyBreak({ quota: quota(50), status: 429, now }),
      decideStickyBreak({ quota: quota(50), status: 400, now }),
    ]

    for (const decision of decisions) {
      expect(decision.action).not.toBe('hold')
    }
  })

  test('migrates a fresh below-floor account when killswitchPasses is false', () => {
    expect(
      decideStickyBreak({
        quota: quota(45),
        status: 400,
        now,
        killswitchPasses: false,
      }),
    ).toEqual({ action: 'migrate', reason: 'killswitch' })
  })

  test('keeps a stale snapshot when killswitchPasses is false (stale wins)', () => {
    expect(
      decideStickyBreak({
        quota: quota(45, now - QUOTA_STALENESS_MS - 1),
        status: 400,
        now,
        killswitchPasses: false,
      }),
    ).toEqual({ action: 'retain', reason: 'stale' })
  })

  test('keeps a no-quota account when killswitchPasses is false (unknown wins)', () => {
    expect(
      decideStickyBreak({
        quota: undefined,
        status: 400,
        now,
        killswitchPasses: false,
      }),
    ).toEqual({ action: 'retain', reason: 'unknown' })
  })

  test('migrates before exhaustion when the killswitch and exhaustion both apply', () => {
    expect(
      decideStickyBreak({
        quota: quota(0),
        status: 400,
        now,
        killswitchPasses: false,
      }),
    ).toEqual({ action: 'migrate', reason: 'killswitch' })
  })

  test('killswitchPasses true is a no-op on the healthy path', () => {
    expect(
      decideStickyBreak({
        quota: quota(50),
        status: 400,
        now,
        killswitchPasses: true,
      }),
    ).toEqual({ action: 'retain', reason: 'healthy' })
  })

  test('killswitchPasses undefined is a no-op (killswitch disabled / not opted in)', () => {
    expect(
      decideStickyBreak({
        quota: quota(45),
        status: 400,
        now,
      }),
    ).toEqual({ action: 'retain', reason: 'healthy' })
  })

  test('tombstones and absence records never read exhausted', () => {
    const evidenceOnly = projectQuota(quotaMap([retired('primary', now)]))
    expect(
      decideStickyBreak({ quota: evidenceOnly, status: 400, now }),
    ).toEqual({ action: 'retain', reason: 'healthy' })
  })
})

describe('decideStickyBreak credit budget', () => {
  const creditReset = new Date(now + 30 * 24 * 3600_000).toISOString()

  function withSpendControl(
    base: ProjectedQuota,
    overrides: Partial<ProjectedBudget> = {},
  ): ProjectedQuota {
    return {
      ...base,
      budget: {
        checkedAt: now,
        remainingPercent: 0,
        resetsAt: creditReset,
        reached: true,
        ...overrides,
      },
    }
  }

  test('migrates a pin on an account with a reached credit budget', () => {
    expect(
      decideStickyBreak({
        quota: withSpendControl(quota(50)),
        status: 400,
        now,
      }),
    ).toEqual({ action: 'migrate', reason: 'exhausted', resetsAt: creditReset })
  })

  test('retains a pin on a stale credit reading', () => {
    expect(
      decideStickyBreak({
        quota: withSpendControl(quota(50, now - QUOTA_STALENESS_MS - 1)),
        status: 400,
        now,
      }),
    ).toEqual({ action: 'retain', reason: 'stale' })
  })

  test.each([
    ['a malformed reset', { resetsAt: 'not-a-date' }],
    ['a missing reset', { resetsAt: undefined }],
    ['a lapsed reset', { resetsAt: new Date(now - 3600_000).toISOString() }],
  ])(
    'retains a pin on a reached credit budget with %s',
    (_label, overrides) => {
      expect(
        decideStickyBreak({
          quota: withSpendControl(quota(50), overrides),
          status: 400,
          now,
        }),
      ).toEqual({ action: 'retain', reason: 'healthy' })
    },
  )

  test('decides a no-spend-control account exactly as today', () => {
    expect(decideStickyBreak({ quota: quota(50), status: 400, now })).toEqual({
      action: 'retain',
      reason: 'healthy',
    })
    expect(
      decideStickyBreak({
        quota: quota(0, now, creditReset),
        status: 400,
        now,
      }),
    ).toEqual({
      action: 'migrate',
      reason: 'exhausted',
      window: { scope: 'all', label: 'primary' },
      resetsAt: creditReset,
    })
  })

  test('trusts the reached boolean over a spent-looking percentage', () => {
    expect(
      decideStickyBreak({
        quota: withSpendControl(quota(50), {
          reached: false,
          remainingPercent: 0,
        }),
        status: 400,
        now,
      }),
    ).toEqual({ action: 'retain', reason: 'healthy' })
  })

  test('admission and migration agree on a spent credit budget', () => {
    const spent = withSpendControl(quota(50))
    expect(budgetExhaustedResetAt(spent, now)).toBeDefined()
    const map = {
      ...quotaMap([reading('primary', 50, { checkedAt: now })]),
      budget: {
        kind: 'reading' as const,
        checkedAt: now,
        reached: true,
        remainingPercent: 0,
        resetsAt: creditReset,
      },
    }
    expect(
      admit({ rows: [oauth('spent', map), apiKey('key')], now }).refused,
    ).toMatchObject([{ id: 'spent', reason: 'budget-spent' }])
    expect(decideStickyBreak({ quota: spent, status: 400, now })).toEqual({
      action: 'migrate',
      reason: 'exhausted',
      resetsAt: creditReset,
    })
  })
})

describe('selectStickyCandidate', () => {
  test('excludes candidates with missing quota', () => {
    expect(
      select([candidate('unknown', null, 0), candidate('known', quota(1), 1)])
        .accountId,
    ).toBe('known')
  })

  test('excludes candidates with stale quota snapshots', () => {
    expect(
      select([
        candidate('stale', quota(100, now - QUOTA_STALENESS_MS - 1), 0),
        candidate('fresh', quota(1), 1),
      ]).accountId,
    ).toBe('fresh')
  })

  test('uses the tightest present quota window as the account weight', () => {
    const tight = twoWindows({ remaining: 80 }, { remaining: 10 })
    const roomy = twoWindows({ remaining: 20 }, { remaining: 20 })

    expect(
      select([candidate('tight', tight, 0), candidate('roomy', roomy, 1)])
        .accountId,
    ).toBe('roomy')
  })

  test('selects the lower projected pressure', () => {
    expect(
      select(
        [
          candidate('less-pressure', quota(50), 0),
          candidate('more-pressure', quota(50), 1),
        ],
        new Map([
          ['less-pressure', 0],
          ['more-pressure', 100],
        ]),
        100,
      ).accountId,
    ).toBe('less-pressure')
  })

  test('changes the next pick when pending bytes change', () => {
    const candidates = [
      candidate('a', quota(50), 0),
      candidate('b', quota(50), 1),
    ]

    expect(select(candidates, new Map([['a', 100]])).accountId).toBe('b')
    expect(select(candidates, new Map([['b', 100]])).accountId).toBe('a')
  })

  test('resolves equal scores by configured order then account id', () => {
    expect(
      select([candidate('z', quota(50), 1), candidate('a', quota(50), 0)])
        .accountId,
    ).toBe('a')
    expect(
      select([candidate('z', quota(50), 0), candidate('a', quota(50), 0)])
        .accountId,
    ).toBe('a')
  })

  test('never selects zero capacity over positive capacity', () => {
    expect(
      select([
        candidate('empty', quota(0), 0),
        candidate('usable', quota(1), 1),
      ]).accountId,
    ).toBe('usable')
  })

  test('falls back to configured order when every snapshot is stale', () => {
    const selection = select([
      candidate('first', quota(50, now - QUOTA_STALENESS_MS - 1), 0),
      candidate('second', quota(50, now - QUOTA_STALENESS_MS - 1), 1),
    ])

    expect(selection).toEqual({
      accountId: 'first',
      quotaCheckedAt: now - QUOTA_STALENESS_MS - 1,
      source: 'mode-fallback',
    })
  })

  test('notifies the caller when no weighted candidate survives', () => {
    let emptySetCalls = 0

    selectStickyCandidate({
      candidates: [
        candidate('stale', quota(50, now - QUOTA_STALENESS_MS - 1), 0),
      ],
      pendingBytes: new Map(),
      requestBytes: 1,
      now,
      onEmptyWeightedSet: () => {
        emptySetCalls += 1
      },
    })

    expect(emptySetCalls).toBe(1)
  })

  test('prefers a positive optional reset-credit count in empty-set fallback', () => {
    expect(
      select([
        candidate('no-credit', null, 0, { resetCreditsApplicable: 0 }),
        candidate('credit', null, 1, { resetCreditsApplicable: 1 }),
      ]).accountId,
    ).toBe('credit')
  })

  test('rejects an empty input candidate list', () => {
    expect(() => select([])).toThrow(
      'Cannot select a sticky candidate: input.candidates is empty',
    )
  })

  test('excludes a killswitch-killed candidate from weighted placement', () => {
    expect(
      select([
        candidate('killed', quota(20), 0, { killswitchPasses: false }),
        candidate('healthy', quota(50), 1),
      ]).accountId,
    ).toBe('healthy')
  })

  test('excludes a killswitch-killed candidate from mode-fallback fail-open', () => {
    expect(
      select([
        candidate('killed', quota(50, now - QUOTA_STALENESS_MS - 1), 0, {
          killswitchPasses: false,
        }),
        candidate('healthy', quota(50, now - QUOTA_STALENESS_MS - 1), 1),
      ]).accountId,
    ).toBe('healthy')
  })

  test('killswitchPasses true is a no-op on placement', () => {
    const candidates = [
      candidate('explicit', quota(50), 0, { killswitchPasses: true }),
      candidate('implicit', quota(50), 1),
    ]
    expect(select(candidates).accountId).toBe('explicit')
  })

  test('killswitchPasses undefined is a no-op on placement (killswitch disabled)', () => {
    const candidates = [
      candidate('a', quota(50), 0),
      candidate('b', quota(50), 1),
    ]
    expect(select(candidates).accountId).toBe('a')
    expect(select(candidates).accountId).toBe('a')
  })

  test('tombstones and absence records add no weight', () => {
    const evidenceOnly = projectQuota(quotaMap([retired('primary', now)]))
    expect(
      select([
        candidate('evidence', evidenceOnly, 0),
        candidate('reading', quota(1), 1),
      ]).accountId,
    ).toBe('reading')
    expect(select([candidate('evidence', evidenceOnly, 0)]).source).toBe(
      'mode-fallback',
    )
    // Beside a reading, a tombstone neither adds nor removes weight.
    const readingAndTombstone = projectQuota(
      quotaMap([reading('primary', 50), retired('secondary', now)]),
    )
    expect(
      select([
        candidate('mixed', readingAndTombstone, 1),
        candidate('plain', quota(40), 0),
      ]),
    ).toEqual({ accountId: 'mixed', quotaCheckedAt: now, source: 'weighted' })
  })

  test('a third window adds no weight', () => {
    const threeWindows = projectQuota(
      quotaMap([
        reading('primary', 50, { windowMinutes: 300 }),
        reading('secondary', 50, { windowMinutes: 10_080 }),
        reading('tertiary', 99, { windowMinutes: 60 }),
      ]),
    )
    expect(
      select([
        candidate('three', threeWindows, 1),
        candidate('two', twoWindows({ remaining: 40 }, { remaining: 40 }), 0),
      ]).accountId,
    ).toBe('three')
  })

  test('selection judges freshness by the minimum checkedAt of the projection', () => {
    const mixed = projectQuota(
      quotaMap([
        reading('primary', 10, { checkedAt: now }),
        reading('secondary', 10, { checkedAt: now - QUOTA_STALENESS_MS - 1 }),
      ]),
    )
    expect(select([candidate('mixed', mixed, 0)])).toEqual({
      accountId: 'mixed',
      quotaCheckedAt: now - QUOTA_STALENESS_MS - 1,
      source: 'mode-fallback',
    })
  })
})

describe('selectStickyCandidate credit budget', () => {
  const creditReset = new Date(now + 30 * 24 * 3600_000).toISOString()

  function withSpendControl(
    base: ProjectedQuota,
    remainingPercent: number,
  ): ProjectedQuota {
    return {
      ...base,
      budget: {
        checkedAt: now,
        remainingPercent,
        resetsAt: creditReset,
        reached: false,
      },
    }
  }

  test('deprioritises a nearly-spent credit budget in cold placement', () => {
    expect(
      select([
        candidate('nearly-spent', withSpendControl(quota(50), 1), 0),
        candidate('roomy', withSpendControl(quota(50), 80), 1),
      ]).accountId,
    ).toBe('roomy')
  })

  test('ignores a malformed credit reading instead of excluding the account', () => {
    const malformed = withSpendControl(quota(50), Number.NaN)
    expect(
      select([
        candidate('malformed', malformed, 0),
        candidate('plain', quota(50), 1),
      ]).accountId,
    ).toBe('malformed')
  })

  test('routes a candidate with no spend control by its rate-limit windows alone', () => {
    expect(
      select([
        candidate('tight', quota(10), 0),
        candidate('roomy', quota(90), 1),
      ]),
    ).toEqual({ accountId: 'roomy', quotaCheckedAt: now, source: 'weighted' })
  })
})

describe('routeSticky', () => {
  const week = new Date(now + 7 * 24 * 3600_000).toISOString()
  const fresh = (usedPercent: number, checkedAt = now) =>
    quotaMap([
      reading('primary', usedPercent, {
        checkedAt,
        resetsAt: week,
        windowMinutes: 10_080,
      }),
    ])
  const stale = (usedPercent: number) =>
    fresh(usedPercent, now - QUOTA_STALENESS_MS - 1)
  const base = { now, requestBytes: 10 }

  test('admission is not weighting: 95% used under a 10% reserve is admitted at zero weight via mode-fallback', () => {
    const route = routeSticky({
      ...base,
      rows: [oauth('a', fresh(95))],
      reservePercent: { primary: 10 },
      killswitch: new Map([['a', true]]),
    })
    expect(route).toMatchObject({
      outcome: 'dispatch',
      accountId: 'a',
      source: 'mode-fallback',
    })
  })

  test('50% used is admitted and weighted ahead of a zero-weight row', () => {
    const route = routeSticky({
      ...base,
      rows: [oauth('a', fresh(95)), oauth('b', fresh(50))],
      reservePercent: { primary: 10 },
    })
    expect(route).toMatchObject({ accountId: 'b', source: 'weighted' })
  })

  test('an all-unknown OAuth pool refuses every candidate while mode-fallback keeps returning one and ends as no admissible account', () => {
    const pulls: string[] = []
    const route = routeSticky({
      ...base,
      rows: [oauth('a'), oauth('b')],
      requestPull: (id) => {
        pulls.push(id)
      },
    })
    expect(route.outcome).toBe('no-admissible-account')
    expect(route.refusedSelections.map((refusal) => refusal.id)).toEqual([
      'a',
      'b',
    ])
    expect(pulls).toEqual(['a', 'b'])
  })

  test('a refusal re-runs selection with the id excluded and the pin retained', () => {
    const route = routeSticky({
      ...base,
      rows: [oauth('a'), oauth('b', stale(20))],
      pin: { accountId: 'a' },
    })
    expect(route).toMatchObject({
      outcome: 'dispatch',
      accountId: 'b',
      source: 'mode-fallback',
      pin: { action: 'retain' },
    })
    expect(route.refusedSelections).toMatchObject([
      { id: 'a', reason: 'needs-first-reading' },
    ])
  })

  test('a pin whose quota turns unknown is refused but not deleted', () => {
    const rows = [oauth('a', fresh(20)), oauth('b', fresh(20))]
    const pin = { accountId: 'b' }
    expect(routeSticky({ ...base, rows, pin })).toMatchObject({
      accountId: 'b',
      source: 'pin',
      pin: { action: 'retain' },
    })
    const unknown = routeSticky({
      ...base,
      rows: [oauth('a', fresh(20)), oauth('b')],
      pin,
    })
    expect(unknown).toMatchObject({
      accountId: 'a',
      pin: { action: 'retain' },
    })
    expect(unknown.admission.refused).toMatchObject([
      { id: 'b', reason: 'needs-first-reading' },
    ])
  })

  test('a mixed pool dispatches the api-key row', () => {
    const route = routeSticky({ ...base, rows: [oauth('a'), apiKey('key')] })
    expect(route).toMatchObject({ outcome: 'dispatch', accountId: 'key' })
  })

  test('an exhausted row returned by mode-fallback is refused exhausted', () => {
    const route = routeSticky({
      ...base,
      rows: [oauth('spent', fresh(100)), oauth('b', stale(20))],
    })
    expect(route.refusedSelections).toMatchObject([
      { id: 'spent', reason: 'exhausted' },
    ])
    expect(route).toMatchObject({ accountId: 'b', source: 'mode-fallback' })
  })

  test('a fresh healthy reading is dispatched end-to-end in sticky-balanced mode', () => {
    const route = routeSticky({
      ...base,
      rows: [oauth('a', fresh(20))],
      identities: new Map([['a', 'wire-a']]),
    })
    expect(route).toMatchObject({
      outcome: 'dispatch',
      accountId: 'a',
      source: 'weighted',
      quotaCheckedAt: now,
      pin: {
        action: 'assign',
        pin: {
          accountId: 'a',
          wireIdentity: 'wire-a',
          inputBytes: 10,
          quotaCheckedAt: now,
        },
      },
    })
  })

  test('a supplied cross-process pending-bytes map changes the choice relative to the in-memory pins', () => {
    const rows = [oauth('a', fresh(20)), oauth('b', fresh(20))]
    expect(routeSticky({ ...base, rows })).toMatchObject({ accountId: 'a' })
    const pendingBytes = pendingBytesForPins(
      [
        [
          'other-process-session',
          { accountId: 'a', inputBytes: 1000, quotaCheckedAt: now },
        ],
      ],
      new Map([
        ['a', now],
        ['b', now],
      ]),
    )
    expect(routeSticky({ ...base, rows, pendingBytes })).toMatchObject({
      accountId: 'b',
    })
  })

  test('sticky-balanced excludes a rate-limited row entirely and readmits it after the mark expires', () => {
    const rows = [oauth('a', fresh(10)), oauth('b', fresh(60))]
    const rateLimitMarks = new Map([['a', now + 1000]])
    expect(routeSticky({ ...base, rows, rateLimitMarks })).toMatchObject({
      accountId: 'b',
    })
    // Excluded rather than de-weighted: not even the fallback may return it.
    expect(
      routeSticky({
        ...base,
        rows: [oauth('a', stale(10)), oauth('b')],
        rateLimitMarks,
      }).outcome,
    ).toBe('no-admissible-account')
    expect(
      routeSticky({ ...base, rows, rateLimitMarks, now: now + 1000 }),
    ).toMatchObject({ accountId: 'a' })
  })

  test('sticky-balanced excludes a backed-off row until its retry time', () => {
    const rows = [oauth('a', fresh(10)), oauth('b', fresh(60))]
    const refreshBackoff = new Map([['a', now + 1000]])
    expect(routeSticky({ ...base, rows, refreshBackoff })).toMatchObject({
      accountId: 'b',
      admission: { excluded: [{ id: 'a', reason: 'refresh-backoff' }] },
    })
    expect(
      routeSticky({ ...base, rows, refreshBackoff, now: now + 1000 }),
    ).toMatchObject({ accountId: 'a' })
  })

  test("sticky-balanced leaves an unmarked row's order and weight unchanged by another row's mark", () => {
    const pair = [oauth('a', fresh(50)), oauth('b', fresh(40))]
    const without = routeSticky({ ...base, rows: pair })
    const withMark = routeSticky({
      ...base,
      rows: [oauth('c', fresh(1)), ...pair],
      rateLimitMarks: new Map([['c', now + 1]]),
    })
    expect(withMark).toMatchObject({
      accountId: without.outcome === 'dispatch' ? without.accountId : '',
      source: 'weighted',
      quotaCheckedAt: now,
    })
  })

  test('a killed pinned row is routed around and its pin retained', () => {
    const route = routeSticky({
      ...base,
      rows: [oauth('a', fresh(10)), oauth('b', fresh(10))],
      pin: { accountId: 'a' },
      killswitch: new Map([['a', false]]),
    })
    expect(route).toMatchObject({ accountId: 'b', pin: { action: 'retain' } })
  })

  test('per-row reserves change placement per row, as a map or a function, over the shared reserve', () => {
    // a: 60% left, b: 50% left. Without reserves a carries more weight.
    const rows = [oauth('a', fresh(40)), oauth('b', fresh(50))]
    expect(routeSticky({ ...base, rows })).toMatchObject({
      accountId: 'a',
      source: 'weighted',
    })
    // A 30% reserve on a alone leaves it 30 spendable against b's 50.
    const map = new Map([['a', { primary: 30 }]])
    expect(
      routeSticky({ ...base, rows, rowReservePercent: map }),
    ).toMatchObject({ accountId: 'b', source: 'weighted' })
    expect(
      routeSticky({
        ...base,
        rows,
        rowReservePercent: (row) =>
          row.id === 'a' ? { primary: 30 } : undefined,
      }),
    ).toMatchObject({ accountId: 'b', source: 'weighted' })
    // The shared 30% reserve applies to both rows, so a stays ahead.
    expect(
      routeSticky({ ...base, rows, reservePercent: { primary: 30 } }),
    ).toMatchObject({ accountId: 'a' })
    // A row the per-row map covers ignores the shared reserve; b keeps it.
    expect(
      routeSticky({
        ...base,
        rows,
        reservePercent: { primary: 45 },
        rowReservePercent: new Map([['a', { primary: 0 }]]),
      }),
    ).toMatchObject({ accountId: 'a', source: 'weighted' })
    expect(
      routeSticky({
        ...base,
        rows,
        reservePercent: { primary: 0 },
        rowReservePercent: new Map([['b', { primary: 45 }]]),
      }),
    ).toMatchObject({ accountId: 'a', source: 'weighted' })
    expect(
      routeSticky({
        ...base,
        rows,
        reservePercent: { primary: 0 },
        rowReservePercent: new Map([['a', { primary: 45 }]]),
      }),
    ).toMatchObject({ accountId: 'b', source: 'weighted' })
  })

  describe('refused pin policy', () => {
    const pin = { accountId: 'a' }
    const moved = {
      outcome: 'dispatch',
      accountId: 'b',
      pin: { action: 'assign', pin: { accountId: 'b', inputBytes: 10 } },
    }
    const kept = {
      outcome: 'dispatch',
      accountId: 'b',
      pin: { action: 'retain' },
    }
    const move = 'move-on-confirmed-exhaustion' as const
    // Healthy windows with a reached credit budget resetting in thirty days.
    const spent = {
      ...fresh(10),
      budget: {
        kind: 'reading' as const,
        checkedAt: now,
        reached: true,
        remainingPercent: 0,
        resetsAt: new Date(now + 30 * 24 * 3600_000).toISOString(),
      },
    }

    test('the move policy moves a pin whose row is refused as exhausted or budget-spent', () => {
      const exhausted = [oauth('a', fresh(100)), oauth('b', fresh(20))]
      expect(
        routeSticky({ ...base, rows: exhausted, pin, refusedPinPolicy: move }),
      ).toMatchObject(moved)
      const budget = routeSticky({
        ...base,
        rows: [oauth('a', spent), oauth('b', fresh(20))],
        pin,
        refusedPinPolicy: move,
      })
      expect(budget.admission.refused).toMatchObject([
        { id: 'a', reason: 'budget-spent' },
      ])
      expect(budget).toMatchObject(moved)
    })

    test('the move policy moves a pin whose row the killswitch kills', () => {
      expect(
        routeSticky({
          ...base,
          rows: [oauth('a', fresh(10)), oauth('b', fresh(10))],
          pin,
          killswitch: new Map([['a', false]]),
          refusedPinPolicy: move,
        }),
      ).toMatchObject(moved)
    })

    test('the move policy keeps a pin whose row is refused for unknown quota or excluded, serving elsewhere', () => {
      for (const reasonRows of [
        // No reading yet.
        [oauth('a'), oauth('b', fresh(20))],
        // Exhausted with a reset that has already passed: admission cannot
        // tell whether the window has refilled, so it refuses as unknown-reset.
        [
          oauth(
            'a',
            quotaMap([
              reading('primary', 100, {
                resetsAt: new Date(now - 1000).toISOString(),
              }),
            ]),
          ),
          oauth('b', fresh(20)),
        ],
      ]) {
        const route = routeSticky({
          ...base,
          rows: reasonRows,
          pin,
          refusedPinPolicy: move,
        })
        expect(route.admission.refused[0]?.id).toBe('a')
        expect(route).toMatchObject(kept)
      }
      expect(
        routeSticky({
          ...base,
          rows: [oauth('a', fresh(10)), oauth('b', fresh(20))],
          pin,
          rateLimitMarks: new Map([['a', now + 1000]]),
          refusedPinPolicy: move,
        }),
      ).toMatchObject(kept)
    })

    test('the move policy retains the pin when nothing else is admissible', () => {
      expect(
        routeSticky({
          ...base,
          rows: [oauth('a', fresh(100)), oauth('b')],
          pin,
          refusedPinPolicy: move,
        }),
      ).toMatchObject({
        outcome: 'no-admissible-account',
        pin: { action: 'retain' },
      })
    })

    test('the default policy keeps a pin whose row is exhausted, budget-spent or killed', () => {
      for (const extra of [
        { rows: [oauth('a', fresh(100)), oauth('b', fresh(20))] },
        { rows: [oauth('a', spent), oauth('b', fresh(20))] },
        {
          rows: [oauth('a', fresh(10)), oauth('b', fresh(10))],
          killswitch: new Map([['a', false]]),
        },
      ]) {
        expect(routeSticky({ ...base, ...extra, pin })).toMatchObject(kept)
        expect(
          routeSticky({ ...base, ...extra, pin, refusedPinPolicy: 'keep' }),
        ).toMatchObject(kept)
      }
    })
  })
})
