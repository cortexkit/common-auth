import { describe, expect, test } from 'bun:test'
import type {
  AcceptedActivity,
  AccountKey,
  LimitCandidate,
  LimitHost,
  LimitWindow,
  PolicyFacts,
  SessionActivityStore,
} from '../../src/limits/index.js'
import {
  confirmedAffinity,
  createRequestHistory,
  createSessionActivityStore,
  decideAfterLimit,
  earliestPoolEngine,
  MAX_SAME_ACCOUNT_HOLD_MS,
  readMaxSameAccountWait,
  sameAccountHoldFacts,
  statusVaultOrder,
  windowRouter,
} from '../../src/limits/index.js'

const now = 1700000000000
const A: AccountKey = { namespace: 'test', accountId: 'A', incarnation: '1' }
const B: AccountKey = { namespace: 'test', accountId: 'B', incarnation: '1' }
const replacement: AccountKey = { ...A, incarnation: '2' }
const scope = { kind: 'model', model: 'claude-sonnet' } as const
// SHA256 of this session id has first unsigned big-endian word modulo 21 = 16.
const sessionId = 'session-a'

function record(
  store: SessionActivityStore,
  patch: Partial<AcceptedActivity> = {},
): boolean {
  return store.recordAccepted({
    sessionId,
    accountKey: A,
    currentAccountKey: A,
    lastAcceptedAt: now,
    ttlMs: 3600000,
    ...patch,
  })
}

function blocker(resetAt: number | undefined, window = '5h'): LimitWindow {
  return {
    window,
    resetAt,
    confirmed: true,
    confirmedByReading: true,
    observedAt: now,
    provenance: 'reading',
  }
}

function candidate(account: AccountKey, ready: boolean): LimitCandidate {
  return {
    account,
    admitted: true,
    placementEligible: true,
    ready,
    blockers: [],
  }
}

function facts(
  store: SessionActivityStore,
  setting: unknown = 15,
  patch: Partial<PolicyFacts> = {},
): PolicyFacts {
  const attempted = patch.attempted ?? A
  const alternative = attempted.accountId === B.accountId ? A : B
  return {
    phase: 'after-limit',
    host: 'opencode1',
    now,
    clockNow: 1000,
    sessionId,
    requestScope: scope,
    history: createRequestHistory({
      requestId: 'turn',
      originalUrl: '/messages',
      clockNow: 1000,
    }),
    attempted,
    signal: {
      account: attempted,
      kind: 'rate-limit',
      reason: 'quota',
      status: 429,
      scope,
      windows: [blocker(now + 1000)],
      observedAt: now,
    },
    delivery: { owned: true, attributable: true, replayable: true },
    candidates: [candidate(attempted, false), candidate(alternative, true)],
    selection: { account: alternative, pin: 'pin' },
    hold: sameAccountHoldFacts({
      activity: store.get(sessionId),
      accountKey: attempted,
      maxSameAccountWait: setting,
    }),
    ...patch,
  }
}

function decide(
  store: SessionActivityStore,
  setting: unknown = 15,
  patch: Partial<PolicyFacts> = {},
) {
  return decideAfterLimit(facts(store, setting, patch), confirmedAffinity)
}

describe('routing.maxSameAccountWait', () => {
  test.each([0, 15, 'max'] as const)(
    'reads the persisted value %s',
    (value) => {
      expect(readMaxSameAccountWait(value)).toBe(value)
    },
  )

  test.each(
    [
      undefined,
      null,
      false,
      true,
      -1,
      1,
      900000,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '0',
      '15',
      'MAX',
      {},
      [],
    ].map((value) => ({ value })),
  )('an absent or invalid setting %s reads as 15', ({ value }) => {
    expect(readMaxSameAccountWait(value)).toBe(15)
    const store = createSessionActivityStore()
    record(store)
    expect(facts(store, value).hold?.maxWaitMs).toBe(900000)
  })

  test('0 never holds, 15 is bounded by 900000 ms, max by cache expiry', () => {
    const store = createSessionActivityStore()
    record(store)
    for (const [setting, resetMs, action] of [
      [0, 1000, 'reroute'],
      [15, 884000, 'hold'],
      [15, 884000.1, 'reroute'],
      [15, 2700000, 'reroute'],
      ['max', 2700000, 'hold'],
      ['max', 3584000, 'hold'],
      ['max', 3584000.1, 'reroute'],
    ] as const) {
      expect(
        decide(store, setting, {
          candidates: [
            {
              ...candidate(A, false),
              confirmedBlockers: [blocker(now + resetMs)],
            },
            candidate(B, true),
          ],
        }),
      ).toMatchObject({ action, account: action === 'hold' ? A : B })
    }
  })
})

describe('same-account hold eligibility', () => {
  test('every confirmed blocker contributes to one rounded, jittered target', () => {
    const store = createSessionActivityStore()
    record(store)
    const input = facts(store, 'max')
    const result = decideAfterLimit(
      {
        ...input,
        candidates: [
          {
            ...candidate(A, false),
            confirmedBlockers: [
              blocker(now + 1000),
              blocker(now + 2000.1, '7d'),
              { ...blocker(undefined, 'hint'), confirmed: false },
            ],
          },
          candidate(B, true),
        ],
      },
      confirmedAffinity,
    )
    expect(result).toMatchObject({
      action: 'hold',
      account: A,
      delayMs: 19000,
      retryAfterMs: 19000,
      target: now + 19000,
      reason: 'confirmed-limit',
      retryable: true,
      hostRetry: 'leave',
      checkpoint: {
        accountKey: A,
        decidedAt: now,
        blockers: [
          { window: '5h', resetAt: now + 1000 },
          { window: '7d', resetAt: now + 2000.1 },
        ],
      },
    })
  })

  test.each([undefined, now, now - 1, Number.NaN, Number.POSITIVE_INFINITY])(
    'any nonfuture or unknown confirmed reset %s prevents a hold',
    (resetAt) => {
      const store = createSessionActivityStore()
      record(store)
      expect(
        decide(store, 'max', {
          candidates: [
            {
              ...candidate(A, false),
              confirmedBlockers: [blocker(now + 1000), blocker(resetAt, '7d')],
            },
            candidate(B, true),
          ],
        }),
      ).toMatchObject({ action: 'reroute', account: B })
    },
  )

  test('cache expiry, setting bound and admission are independently required', () => {
    const store = createSessionActivityStore()
    record(store, { lastAcceptedAt: now - 3600000 })
    expect(decide(store, 'max').action).toBe('reroute')
    record(store)
    expect(
      decide(store, 'max', {
        candidates: [
          { ...candidate(A, false), admitted: false },
          candidate(B, true),
        ],
      }),
    ).toMatchObject({ action: 'reroute', account: B })
    for (const lastAcceptedAt of [now - 3583000, now - 3583001]) {
      const boundaryStore = createSessionActivityStore()
      record(boundaryStore, { lastAcceptedAt })
      expect(decide(boundaryStore).action).toBe(
        lastAcceptedAt === now - 3583000 ? 'hold' : 'reroute',
      )
    }
  })

  test('a failed same-account bound with no ready alternative uses terminal facts', () => {
    const store = createSessionActivityStore()
    record(store, { ttlMs: 0 })
    expect(
      decide(store, 15, {
        candidates: [candidate(A, false)],
        selection: undefined,
        terminal: { source: 'pool', reason: 'quota', retryAfterMs: 600000 },
      }),
    ).toMatchObject({
      action: 'refuse',
      reason: 'quota',
      // Pool refusals take their wait only from a fresh reading scan, never
      // from a caller-supplied value; with no scan, the 300 s fallback applies.
      retryAfterMs: 300000,
    })
  })

  test('disabled presets remain unchanged under 0, 15 and max', () => {
    const store = createSessionActivityStore()
    record(store)
    for (const axes of [earliestPoolEngine, windowRouter, statusVaultOrder]) {
      const results = [0, 15, 'max'].map((setting) =>
        decideAfterLimit(facts(store, setting), axes),
      )
      expect(results[0]).toMatchObject({ action: 'reroute', account: B })
      expect(results[1]).toEqual(results[0])
      expect(results[2]).toEqual(results[0])
    }
  })
})

describe('OpenCode 2 single hold and retry budget', () => {
  test('max permits one +2716 s hold; 15 reroutes on the same facts', () => {
    const store = createSessionActivityStore()
    record(store)
    const patch: Partial<PolicyFacts> = {
      host: 'opencode2',
      hostPhase: 'retry',
      remainingRetries: 1,
      candidates: [
        {
          ...candidate(A, false),
          confirmedBlockers: [blocker(now + 2700000)],
        },
        candidate(B, true),
      ],
    }
    expect(decide(store, 'max', patch)).toMatchObject({
      action: 'hold',
      delayMs: 2716000,
      target: now + 2716000,
    })
    expect(decide(store, 15, patch)).toMatchObject({
      action: 'reroute',
      account: B,
    })
    expect(
      decide(store, 'max', { ...patch, remainingRetries: 0 }),
    ).toMatchObject({ action: 'pass', hostRetry: 'leave' })
  })

  test('the 3621000 ms host clamp is intrinsic, not an optional caller bound', () => {
    const store = createSessionActivityStore()
    record(store, { ttlMs: 7200000 })
    expect(MAX_SAME_ACCOUNT_HOLD_MS).toBe(3621000)
    for (const [resetMs, action] of [
      [3605000, 'hold'],
      [3605000.1, 'reroute'],
      [3606000, 'reroute'],
    ] as const) {
      expect(
        decide(store, 'max', {
          host: 'opencode2',
          hostPhase: 'retry',
          remainingRetries: 1,
          candidates: [
            {
              ...candidate(A, false),
              confirmedBlockers: [blocker(now + resetMs)],
            },
            candidate(B, true),
          ],
        }),
      ).toMatchObject({ action, account: action === 'hold' ? A : B })
    }
  })

  test.each([undefined, Number.NaN, -1, 0])(
    'a hold needs at least one known remaining retry, not %s',
    (remainingRetries) => {
      const store = createSessionActivityStore()
      record(store)
      const result = decide(store, 'max', {
        host: 'opencode2',
        hostPhase: 'retry',
        remainingRetries,
      })
      expect(result.action).not.toBe('hold')
      if (remainingRetries !== undefined && remainingRetries < 1)
        expect(result).toMatchObject({ action: 'pass', hostRetry: 'leave' })
    },
  )

  test.each(['opencode1', 'pi'] satisfies LimitHost[])(
    '%s has no OpenCode 2 hold clamp or retry-budget dependency',
    (host) => {
      const store = createSessionActivityStore()
      record(store, { ttlMs: 7200000 })
      expect(
        decide(store, 'max', {
          host,
          remainingRetries: 0,
          candidates: [
            {
              ...candidate(A, false),
              confirmedBlockers: [blocker(now + 3606000)],
            },
            candidate(B, true),
          ],
        }),
      ).toMatchObject({ action: 'hold', delayMs: 3622000 })
    },
  )
})

describe('accepted response and prewarm activity', () => {
  test('the longest TTL in one response wins, not a historical maximum', () => {
    const store = createSessionActivityStore()
    expect(record(store, { ttlMs: [300000, 3600000, 600000] })).toBe(true)
    expect(store.get(sessionId)).toEqual({
      accountKey: A,
      lastAcceptedAt: now,
      ttlMs: 3600000,
    })
    expect(record(store, { lastAcceptedAt: now + 1, ttlMs: [0, 60000] })).toBe(
      true,
    )
    expect(store.get(sessionId)?.ttlMs).toBe(60000)
    expect(record(store, { lastAcceptedAt: now + 2, ttlMs: 0 })).toBe(true)
    expect(store.get(sessionId)?.ttlMs).toBe(0)
    expect(decide(store)).toMatchObject({ action: 'reroute', account: B })
  })

  test.each(
    [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, []].map((ttlMs) => ({
      ttlMs,
    })),
  )(
    'unknown TTL %s counts as 300000 ms and fits the jittered boundary',
    ({ ttlMs }) => {
      const store = createSessionActivityStore()
      record(store, { ttlMs, lastAcceptedAt: now - 283000 })
      expect(store.get(sessionId)?.ttlMs).toBe(300000)
      expect(decide(store)).toMatchObject({ action: 'hold', delayMs: 17000 })
      record(store, { ttlMs, lastAcceptedAt: now - 282999 })
      const input = facts(store)
      expect(
        decideAfterLimit({ ...input, now: now + 2 }, confirmedAffinity),
      ).toMatchObject({ action: 'reroute', account: B })
    },
  )

  test('a known zero TTL reroutes even with a reset within one minute', () => {
    const store = createSessionActivityStore()
    record(store, { ttlMs: 0 })
    expect(decide(store)).toMatchObject({ action: 'reroute', account: B })
  })

  test('successful prewarm 10 minutes ago refreshes a turn from 70 minutes ago', () => {
    const store = createSessionActivityStore()
    record(store, { lastAcceptedAt: now - 70 * 60000 })
    const patch = {
      candidates: [
        {
          ...candidate(A, false),
          confirmedBlockers: [blocker(now + 10 * 60000)],
        },
        candidate(B, true),
      ],
    }
    expect(decide(store, 'max', patch).action).toBe('reroute')
    expect(record(store, { lastAcceptedAt: now - 10 * 60000 })).toBe(true)
    expect(decide(store, 15, patch)).toMatchObject({
      action: 'hold',
      account: A,
      delayMs: 616000,
    })
  })

  test('a missing record or another account, namespace or incarnation never holds', () => {
    const store = createSessionActivityStore()
    expect(decide(store).action).toBe('reroute')
    record(store)
    for (const attempted of [B, { ...A, namespace: 'other' }, replacement])
      expect(decide(store, 'max', { attempted }).action).toBe('reroute')
    expect(
      record(store, { accountKey: A, currentAccountKey: replacement }),
    ).toBe(false)
    expect(
      record(store, {
        accountKey: replacement,
        currentAccountKey: replacement,
        lastAcceptedAt: now + 1,
      }),
    ).toBe(true)
    expect(record(store, { currentAccountKey: replacement })).toBe(false)
    expect(store.get(sessionId)?.accountKey).toEqual(replacement)
  })

  test('an accepted response on another account replaces the session record', () => {
    const store = createSessionActivityStore()
    record(store)
    record(store, {
      accountKey: B,
      currentAccountKey: B,
      lastAcceptedAt: now + 1,
    })
    expect(store.size).toBe(1)
    expect(decide(store).action).toBe('reroute')
  })

  test.each(['forget', 'host deletion'])('%s evicts session activity', () => {
    const store = createSessionActivityStore()
    record(store)
    expect(decide(store).action).toBe('hold')
    store.forgetSession(sessionId)
    expect(store.size).toBe(0)
    expect(decide(store).action).toBe('reroute')
  })

  test('300 sessions retain at most 256 records, oldest accepted activity first', () => {
    const store = createSessionActivityStore()
    record(store, { lastAcceptedAt: now - 1 })
    for (let i = 0; i < 299; i++)
      record(store, { sessionId: `session-${i}`, lastAcceptedAt: now + i })
    expect(store.size).toBe(256)
    expect(decide(store).action).toBe('reroute')
    expect(store.get('session-42')).toBeUndefined()
    expect(store.get('session-43')).toBeDefined()
    expect(store.get('session-298')).toBeDefined()
  })

  test('reads do not refresh age, accepted prewarms do; snapshots are immutable', () => {
    const store = createSessionActivityStore()
    const key = { ...A }
    record(store, { accountKey: key })
    key.incarnation = 'changed'
    expect(store.get(sessionId)?.accountKey).toEqual(A)
    expect(Object.isFrozen(store.get(sessionId))).toBe(true)
    expect(Object.isFrozen(store.get(sessionId)?.accountKey)).toBe(true)
    expect(record(store, { lastAcceptedAt: Number.NaN })).toBe(false)
    expect(record(store, { lastAcceptedAt: now - 1 })).toBe(false)
    for (let i = 0; i < 255; i++)
      record(store, { sessionId: `session-${i}`, lastAcceptedAt: now + i + 1 })
    record(store, { lastAcceptedAt: now + 300 })
    record(store, { sessionId: 'new', lastAcceptedAt: now + 301 })
    expect(store.get(sessionId)?.lastAcceptedAt).toBe(now + 300)
    expect(store.get('session-0')).toBeUndefined()
    expect(createSessionActivityStore().get(sessionId)).toBeUndefined()
  })
})
