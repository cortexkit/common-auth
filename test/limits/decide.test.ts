import { describe, expect, test } from 'bun:test'
import type {
  AccountKey,
  LimitCandidate,
  LimitSignal,
  PolicyFacts,
  RequestHistory,
} from '../../src/limits/index.js'
import {
  commitRequestExclusion,
  confirmedAffinity,
  createRequestHistory,
  decideAfterLimit,
  earliestPoolEngine,
  holdDelayMs,
  isRequestExcluded,
  reduceRequestHistory,
  statusVaultOrder,
  windowRouter,
} from '../../src/limits/index.js'

const now = 1700000000000
const A: AccountKey = { namespace: 'test', accountId: 'A', incarnation: '1' }
const B: AccountKey = { namespace: 'test', accountId: 'B', incarnation: '1' }
const scope = { kind: 'model', model: 'claude-sonnet' } as const

function history(): RequestHistory {
  return createRequestHistory({
    requestId: 'turn-1',
    originalUrl: '/original',
    clockNow: 1000,
  })
}

function candidate(
  account = A,
  patch: Partial<LimitCandidate> = {},
): LimitCandidate {
  return {
    account,
    admitted: true,
    placementEligible: true,
    ready: true,
    blockers: [],
    ...patch,
  }
}

function signal(patch: Partial<LimitSignal> = {}): LimitSignal {
  return {
    account: A,
    kind: 'rate-limit',
    reason: 'rate',
    status: 429,
    scope,
    windows: [],
    observedAt: now,
    ...patch,
  }
}

function confirmed(resetAt: number | undefined, window = '5h') {
  return {
    window,
    resetAt,
    confirmed: true,
    confirmedByReading: true,
    observedAt: now,
    provenance: 'test',
  }
}

function facts(patch: Partial<PolicyFacts> = {}): PolicyFacts {
  return {
    phase: 'after-limit',
    host: 'opencode1',
    now,
    clockNow: 1000,
    sessionId: 'session-a',
    requestScope: scope,
    history: history(),
    attempted: A,
    signal: signal(),
    delivery: { owned: true, attributable: true, replayable: true },
    candidates: [candidate(A), candidate(B)],
    selection: { account: B, pin: 'pin' },
    ...patch,
  }
}

describe('decision algebra and delivery boundary', () => {
  test('the reducer is deterministic over frozen facts and changes no input history', () => {
    function freeze<T>(value: T): T {
      if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child)
        Object.freeze(value)
      }
      return value
    }
    const input = freeze(facts())
    expect(decideAfterLimit(input, confirmedAffinity)).toEqual(
      decideAfterLimit(input, confirmedAffinity),
    )
    expect(input.history.saw429).toBe(false)
    expect(input.history.tried).toEqual([])
  })
  test('pre-send selection needs neither attempted account nor signal', () => {
    const result = decideAfterLimit(
      facts({ phase: 'pre-send', attempted: undefined, signal: undefined }),
      confirmedAffinity,
    )
    expect(result).toMatchObject({
      action: 'reroute',
      account: B,
      pin: 'pin',
      retryable: true,
      hostRetry: 'leave',
    })
  })

  test('OpenCode 2 pre-send selection needs no attribution to a failed attempt', () => {
    expect(
      decideAfterLimit(
        facts({
          phase: 'pre-send',
          host: 'opencode2',
          attempted: undefined,
          signal: undefined,
          delivery: { owned: true, attributable: false, replayable: true },
        }),
        confirmedAffinity,
      ),
    ).toMatchObject({ action: 'reroute', account: B, hostRetry: 'leave' })
  })

  test('pre-send no account is an auth refusal, not a manufactured quota signal', () => {
    const result = decideAfterLimit(
      facts({
        phase: 'pre-send',
        attempted: undefined,
        signal: undefined,
        candidates: [],
        selection: undefined,
      }),
      confirmedAffinity,
    )
    expect(result).toMatchObject({
      action: 'refuse',
      reason: 'auth',
      family: 'local-auth',
      retryable: false,
      hostRetry: 'leave',
    })
    expect(result).not.toHaveProperty('retryAfterMs')
  })

  test('unsafe attributable output is pass plus veto before rerouting', () => {
    const result = decideAfterLimit(
      facts({
        delivery: { owned: true, attributable: true, replayable: false },
      }),
      earliestPoolEngine,
    )
    expect(result).toMatchObject({
      action: 'pass',
      retryable: false,
      hostRetry: 'veto',
      reason: 'unsafe-output',
    })
    expect(result.history.saw429).toBe(true)
  })

  test.each([
    { owned: false, attributable: true, replayable: false },
    { owned: true, attributable: false, replayable: false },
  ])(
    'OpenCode 2 ownership fences precede unsafe-output veto: %j',
    (delivery) => {
      expect(
        decideAfterLimit(
          facts({ host: 'opencode2', delivery, failureRetryable: true }),
          earliestPoolEngine,
        ),
      ).toMatchObject({
        action: 'pass',
        retryable: true,
        hostRetry: 'leave',
        reason: 'not-owned',
      })
    },
  )

  test('pass preserves input failure retryability', () => {
    expect(
      decideAfterLimit(
        facts({ signal: undefined, status: 500, failureRetryable: false }),
        confirmedAffinity,
      ),
    ).toMatchObject({ action: 'pass', retryable: false, hostRetry: 'leave' })
  })

  test('host continuations leave the requested retry, engine continuations veto independent replay', () => {
    expect(
      decideAfterLimit(facts({ host: 'opencode2' }), confirmedAffinity),
    ).toMatchObject({ action: 'reroute', retryable: true, hostRetry: 'leave' })
    expect(
      decideAfterLimit(facts({ host: 'opencode2' }), earliestPoolEngine),
    ).toMatchObject({ action: 'reroute', retryable: true, hostRetry: 'veto' })
  })

  test('CL-19 status-only 401 advances without any signal', () => {
    expect(
      decideAfterLimit(
        facts({ signal: undefined, status: 401 }),
        statusVaultOrder,
      ),
    ).toMatchObject({ action: 'reroute', account: B })
  })

  test('an inadmissible, nonready, excluded or zero-weight mode choice is not dispatched', () => {
    for (const invalid of [
      candidate(B, { admitted: false }),
      candidate(B, { ready: false }),
      candidate(B, { placementEligible: false }),
    ]) {
      const result = decideAfterLimit(
        facts({ host: 'opencode2', candidates: [candidate(A), invalid] }),
        confirmedAffinity,
      )
      expect(result.action).not.toBe('reroute')
    }
  })

  test('resolved terminal source and absent metadata are preserved', () => {
    const result = decideAfterLimit(
      facts({
        host: 'opencode2',
        selection: undefined,
        terminal: {
          source: 'vault',
          reason: 'quota',
          family: 'native-vault-refusal',
          messageKey: 'vault.quota',
          retryAfterMs: 180000,
        },
      }),
      confirmedAffinity,
    )
    expect(result).toMatchObject({
      action: 'refuse',
      family: 'native-vault-refusal',
      messageKey: 'vault.quota',
      retryAfterMs: 180000,
    })
    const terminal = decideAfterLimit(
      facts({
        host: 'opencode2',
        selection: undefined,
        terminal: {
          source: 'vault',
          reason: 'auth',
          family: 'native-vault-refusal',
          messageKey: 'vault.reauth',
          retryable: false,
        },
      }),
      confirmedAffinity,
    )
    expect(terminal).toMatchObject({
      action: 'refuse',
      reason: 'auth',
      family: 'native-vault-refusal',
      messageKey: 'vault.reauth',
      retryable: false,
      hostRetry: 'leave',
    })
    expect(terminal).not.toHaveProperty('retryAfterMs')
    expect(terminal).not.toHaveProperty('resetAt')
  })
})

describe('known holds and unknown retention', () => {
  function holdFacts(patch: Partial<PolicyFacts> = {}): PolicyFacts {
    return facts({
      signal: signal({ windows: [confirmed(now + 1000)] }),
      hold: { cacheExpiresAt: now + 300000, maxWaitMs: 900000 },
      ...patch,
    })
  }

  test('hold uses every blocker, one jitter and a full-incarnation checkpoint', () => {
    const result = decideAfterLimit(
      holdFacts({
        signal: signal({
          windows: [confirmed(now + 1000), confirmed(now + 2000, '7d')],
        }),
      }),
      confirmedAffinity,
    )
    expect(result).toMatchObject({
      action: 'hold',
      account: A,
      delayMs: 18000,
      retryAfterMs: 18000,
      target: now + 18000,
      retryable: true,
      hostRetry: 'leave',
    })
    expect(result).toHaveProperty('checkpoint', {
      accountKey: A,
      decidedAt: now,
      blockers: [
        { window: '5h', resetAt: now + 1000 },
        { window: '7d', resetAt: now + 2000 },
      ],
    })
  })

  test('disabled hold bound with +1 s reset and ready B reroutes', () => {
    const axes = {
      ...confirmedAffinity,
      shortLimit: {
        ...confirmedAffinity.shortLimit,
        holdBound: 'disabled' as const,
      },
    }
    expect(decideAfterLimit(holdFacts(), axes)).toMatchObject({
      action: 'reroute',
      account: B,
    })
  })

  test('a confirmed limit without a hold or ready alternative falls to terminal refusal', () => {
    const result = decideAfterLimit(
      holdFacts({
        hold: undefined,
        candidates: [candidate(A)],
        selection: undefined,
      }),
      confirmedAffinity,
    )
    expect(result).toMatchObject({
      action: 'refuse',
      reason: 'quota',
      family: 'claude-429',
      retryable: true,
      hostRetry: 'leave',
    })
    expect(result).not.toHaveProperty('retryAfterMs')
  })

  test.each([undefined, now, now - 1, Number.NaN, Number.POSITIVE_INFINITY])(
    'a missing, passed or nonfinite blocker reset %s prevents holding',
    (resetAt) => {
      expect(
        decideAfterLimit(
          holdFacts({
            signal: signal({
              windows: [confirmed(now + 1000), confirmed(resetAt, '7d')],
            }),
          }),
          confirmedAffinity,
        ),
      ).toMatchObject({ action: 'reroute', account: B })
    },
  )

  test('admission precedes hold; a retry hint does not confirm exhaustion', () => {
    expect(
      decideAfterLimit(
        holdFacts({
          candidates: [candidate(A, { admitted: false }), candidate(B)],
        }),
        confirmedAffinity,
      ),
    ).toMatchObject({ action: 'reroute', account: B })
    expect(
      decideAfterLimit(
        holdFacts({ signal: signal({ retryAfterMs: 1000, windows: [] }) }),
        confirmedAffinity,
      ),
    ).toMatchObject({ action: 'retain', retryMs: 1000 })
  })

  test('the rounded jittered target, not the raw reset, must fit every supplied bound', () => {
    for (const hold of [
      undefined,
      { cacheExpiresAt: now + 16999, maxWaitMs: 900000 },
      { cacheExpiresAt: now + 300000, maxWaitMs: 16999 },
      { cacheExpiresAt: now + 300000, maxWaitMs: 900000, maxDelayMs: 16999 },
      { cacheExpiresAt: now + 300000, maxWaitMs: Number.NaN },
    ])
      expect(
        decideAfterLimit(holdFacts({ hold }), confirmedAffinity),
      ).toMatchObject({ action: 'reroute', account: B })
    expect(
      decideAfterLimit(
        holdFacts({
          hold: {
            cacheExpiresAt: now + 17000,
            maxWaitMs: 17000,
            maxDelayMs: 17000,
          },
        }),
        confirmedAffinity,
      ).action,
    ).toBe('hold')
  })

  test('OpenCode 2 retry budget zero passes while one remaining retry holds', () => {
    expect(
      decideAfterLimit(
        holdFacts({
          host: 'opencode2',
          hostPhase: 'retry',
          remainingRetries: 0,
        }),
        confirmedAffinity,
      ),
    ).toMatchObject({ action: 'pass', hostRetry: 'leave' })
    expect(
      decideAfterLimit(
        holdFacts({
          host: 'opencode2',
          hostPhase: 'retry',
          remainingRetries: 1,
        }),
        confirmedAffinity,
      ),
    ).toMatchObject({ action: 'hold', hostRetry: 'leave' })
    expect(
      decideAfterLimit(
        holdFacts({
          host: 'opencode2',
          hostPhase: 'request',
          remainingRetries: 0,
        }),
        confirmedAffinity,
      ).action,
    ).toBe('reroute')
  })

  test('unknown retention preserves fractional normalized hints and adds no jitter', () => {
    expect(
      decideAfterLimit(
        facts({
          retryHintsMs: [Number.NaN, -1, 1250.25, 70000],
          signal: signal({ retryAfterMs: 2000 }),
        }),
        confirmedAffinity,
      ),
    ).toMatchObject({
      action: 'retain',
      account: A,
      retryMs: 1250.25,
      retryable: true,
      hostRetry: 'leave',
    })
    expect(decideAfterLimit(facts(), confirmedAffinity)).toMatchObject({
      action: 'retain',
      retryMs: 60000,
    })
    const pi = decideAfterLimit(facts({ host: 'pi' }), confirmedAffinity)
    expect(pi).toMatchObject({ action: 'pass', reason: 'unconfirmed-limit' })
    expect(pi).not.toHaveProperty('retryMs')
  })

  test('credential recovery retains separately from unconfirmed-limit policy', () => {
    const result = decideAfterLimit(
      facts({ host: 'opencode2', credentialRecovery: { retryMs: 0 } }),
      confirmedAffinity,
    )
    expect(result).toMatchObject({
      action: 'retain',
      account: A,
      reason: 'credential-recovery',
      retryMs: 0,
    })
    expect(result.history.retains).toEqual([])
  })

  test('reducing or polling never commits retain credits and none never bounds retains', () => {
    let input = facts()
    for (let i = 0; i < 4; i++) {
      const first = decideAfterLimit(input, confirmedAffinity)
      expect(first.action).toBe('retain')
      expect(decideAfterLimit(input, confirmedAffinity)).toEqual(first)
      expect(first.history.retains).toHaveLength(i ? 1 : 0)
      input = {
        ...input,
        history: reduceRequestHistory(first.history, {
          type: 'retain',
          cause: 'unconfirmed-limit',
          account: A,
          attemptId: `attempt-${i}`,
          clockNow: 1000 + i,
        }),
      }
    }
    expect(input.history.retains[0]?.count).toBe(4)
  })
})

describe('request history and exclusion protocol', () => {
  test('response history records every 429 even when no mark survives', () => {
    const result = decideAfterLimit(
      facts({
        signal: undefined,
        status: 429,
        candidates: [candidate(A)],
        selection: undefined,
      }),
      statusVaultOrder,
    )
    expect(result.history.saw429).toBe(true)
    expect(result.history.tried).toEqual([{ account: A, scope }])
    expect(result.history.excludedForRequest).toEqual([])
  })

  test('retains are idempotent per committed attempt, per identity and turn; recovery is free', () => {
    const event = {
      type: 'retain',
      account: A,
      attemptId: 'a1',
      clockNow: 1100,
      cause: 'unconfirmed-limit',
    } as const
    const once = reduceRequestHistory(history(), event)
    expect(reduceRequestHistory(once, event)).toBe(once)
    expect(once.retains).toEqual([
      { account: A, count: 1, startedAt: 1100, lastRetainedAt: 1100 },
    ])
    const twice = reduceRequestHistory(once, {
      ...event,
      attemptId: 'a2',
      clockNow: 2200,
    })
    expect(twice.retains[0]).toMatchObject({
      count: 2,
      startedAt: 1100,
      lastRetainedAt: 2200,
    })
    expect(
      reduceRequestHistory(twice, {
        ...event,
        attemptId: 'recovery',
        cause: 'credential-recovery',
      }),
    ).toBe(twice)
    const replacement = reduceRequestHistory(twice, {
      ...event,
      account: { ...A, incarnation: '2' },
      attemptId: 'new-identity',
    })
    expect(replacement.retains.map((entry) => entry.count)).toEqual([2, 1])
    expect(history().retains).toEqual([])
  })

  test('exclusion returns only loop effects; commit is idempotent and charges no switch', () => {
    const input = facts({
      signal: signal({ kind: 'model-unavailable', status: 404 }),
    })
    const result = decideAfterLimit(input, earliestPoolEngine)
    expect(result).toMatchObject({
      action: 'exclude-for-request',
      account: A,
      scope,
      retryable: true,
      hostRetry: 'veto',
      effects: {
        refundHybridToken: true,
        cancelDiscardedBody: true,
        addMark: false,
        addCooldown: false,
        penalizeHealth: false,
        chargeSwitch: false,
      },
    })
    expect(result.history.excludedForRequest).toEqual([])
    const committed = commitRequestExclusion(result.history, {
      account: A,
      scope,
      attemptId: 'a1',
    })
    expect(committed.effects).toEqual(
      result.action === 'exclude-for-request' ? result.effects : undefined,
    )
    expect(
      commitRequestExclusion(committed.history, {
        account: A,
        scope,
        attemptId: 'a1',
      }),
    ).toEqual({ history: committed.history })
    expect(committed.history.switches).toBe(0)
    expect(input.history.excludedForRequest).toEqual([])
    expect(
      decideAfterLimit(
        {
          ...input,
          history: committed.history,
        },
        earliestPoolEngine,
      ).action,
    ).toBe('reroute')
  })

  test('excluded accounts are filtered from mode selection and wait/reset scans', () => {
    const excluded = commitRequestExclusion(history(), {
      account: A,
      scope,
      attemptId: 'a1',
    }).history
    const blocked = facts({
      history: excluded,
      signal: undefined,
      status: 429,
      selection: { account: A, pin: 'pin' },
      candidates: [
        candidate(A, {
          ready: false,
          blockers: [{ kind: 'hard', until: now + 1000 }],
        }),
        candidate(B, {
          ready: false,
          blockers: [{ kind: 'hard', until: now + 10000 }],
        }),
      ],
    })
    const result = decideAfterLimit(blocked, earliestPoolEngine)
    expect(result).toMatchObject({
      action: 'wait-then-reselect',
      delayMs: 10000,
    })
    expect(result).not.toHaveProperty('account')
    expect(result.history.excludedForRequest).toEqual(
      excluded.excludedForRequest,
    )
    expect(
      decideAfterLimit(
        {
          ...blocked,
          candidates: [candidate(A), candidate(B)],
          selection: { account: A, pin: 'pin' },
        },
        earliestPoolEngine,
      ).action,
    ).not.toBe('reroute')
  })

  test('all otherwise admitted identities excluded gives model-unavailable, not quota', () => {
    let excluded = commitRequestExclusion(history(), {
      account: A,
      scope,
      attemptId: 'a1',
    }).history
    excluded = commitRequestExclusion(excluded, {
      account: B,
      scope,
      attemptId: 'b1',
    }).history
    expect(
      decideAfterLimit(facts({ history: excluded }), earliestPoolEngine),
    ).toMatchObject({
      action: 'refuse',
      reason: 'model-unavailable',
      family: 'json-412',
      messageKey: 'model-unavailable',
      retryable: false,
      hostRetry: 'veto',
    })
    expect(excluded.excludedForRequest).toHaveLength(2)
    expect(history().excludedForRequest).toEqual([])
  })

  test('the owning loop excludes each identity once, cancels/refunds, then stops', () => {
    let state = history()
    let refunds = 0
    let cancellations = 0
    for (const [account, attemptId] of [
      [A, 'a1'],
      [B, 'b1'],
    ] as const) {
      const result = decideAfterLimit(
        facts({
          history: state,
          attempted: account,
          signal: signal({ account, kind: 'model-unavailable', status: 404 }),
        }),
        earliestPoolEngine,
      )
      expect(result.action).toBe('exclude-for-request')
      const committed = commitRequestExclusion(result.history, {
        account,
        scope,
        attemptId,
      })
      if (committed.effects?.refundHybridToken) refunds++
      if (committed.effects?.cancelDiscardedBody) cancellations++
      state = committed.history
      expect(
        commitRequestExclusion(state, { account, scope, attemptId }).effects,
      ).toBeUndefined()
    }
    expect(refunds).toBe(2)
    expect(cancellations).toBe(2)
    expect(state.switches).toBe(0)
    expect(
      decideAfterLimit(
        facts({
          phase: 'pre-send',
          attempted: undefined,
          signal: undefined,
          history: state,
        }),
        earliestPoolEngine,
      ),
    ).toMatchObject({ action: 'refuse', reason: 'model-unavailable' })
  })

  test('exclusion keys include namespace, incarnation and request model, not object key order', () => {
    const excluded = commitRequestExclusion(history(), {
      account: A,
      scope,
      attemptId: 'a1',
    }).history
    expect(
      isRequestExcluded(excluded, A, { model: scope.model, kind: 'model' }),
    ).toBe(true)
    expect(isRequestExcluded(excluded, { ...A, incarnation: '2' }, scope)).toBe(
      false,
    )
    expect(
      isRequestExcluded(excluded, { ...A, namespace: 'other' }, scope),
    ).toBe(false)
    expect(
      isRequestExcluded(excluded, A, { kind: 'model', model: 'gemini' }),
    ).toBe(false)
  })

  test('ready selection clears the blocked period, never the request clock or exclusions', () => {
    let blocked = reduceRequestHistory(history(), {
      type: 'blocked',
      clockNow: 1200,
    })
    blocked = reduceRequestHistory(blocked, { type: 'blocked', clockNow: 5000 })
    expect(blocked.blockedSince).toBe(1200)
    const result = decideAfterLimit(
      facts({ history: blocked, clockNow: 5000 }),
      earliestPoolEngine,
    )
    expect(result.history).not.toHaveProperty('blockedSince')
    expect(result.history.requestStartedAt).toBe(1000)
    expect(result.history.originalUrl).toBe('/original')
  })

  test('switch accounting is separate from tried and request exclusions', () => {
    const switched = reduceRequestHistory(history(), {
      type: 'switch',
      attemptId: 'a1',
    })
    expect(
      reduceRequestHistory(switched, { type: 'switch', attemptId: 'a1' }),
    ).toBe(switched)
    expect(switched.switches).toBe(1)
    expect(switched.tried).toEqual([])
    expect(switched.excludedForRequest).toEqual([])
  })
})

describe('pool waits and status history', () => {
  const blocked = [
    candidate(A, {
      ready: false,
      blockers: [
        { kind: 'hard', until: now + 10000 },
        { kind: 'soft', until: now + 20000 },
      ],
    }),
    candidate(B, {
      ready: false,
      blockers: [{ kind: 'hard', until: now + 15000 }],
    }),
  ]

  test('pool proposal is min of per-account max, without hold jitter or a future pin', () => {
    const result = decideAfterLimit(
      facts({ candidates: blocked, selection: undefined }),
      earliestPoolEngine,
    )
    expect(result).toMatchObject({
      action: 'wait-then-reselect',
      delayMs: 15000,
      retryable: true,
      hostRetry: 'veto',
    })
    expect(result.history.blockedSince).toBe(1000)
    expect(result).not.toHaveProperty('account')
    expect(result).not.toHaveProperty('resetAt')
  })

  test('single-eligible soft exemption permits the supplied choice, never waiving hard marks', () => {
    const input = facts({
      phase: 'pre-send',
      attempted: undefined,
      signal: undefined,
      candidates: [
        candidate(A, {
          ready: false,
          blockers: [{ kind: 'soft', until: now + 20000 }],
        }),
      ],
      selection: { account: A, pin: 'preserve' },
    })
    expect(decideAfterLimit(input, earliestPoolEngine)).toMatchObject({
      action: 'reroute',
      account: A,
      hostRetry: 'leave',
    })
    expect(
      decideAfterLimit(
        {
          ...input,
          candidates: [
            candidate(A, {
              ready: false,
              blockers: [
                { kind: 'soft', until: now + 20000 },
                { kind: 'hard', until: now + 1000 },
              ],
            }),
          ],
        },
        earliestPoolEngine,
      ),
    ).toMatchObject({
      action: 'wait-then-reselect',
      delayMs: 1000,
      hostRetry: 'leave',
    })
  })

  test('blocked budget uses the original blocked-period start and zero disables it', () => {
    const old = reduceRequestHistory(history(), {
      type: 'blocked',
      clockNow: 1000,
    })
    expect(
      decideAfterLimit(
        facts({
          candidates: blocked,
          selection: undefined,
          history: old,
          clockNow: 291000,
        }),
        earliestPoolEngine,
      ),
    ).toMatchObject({ action: 'wait-then-reselect', delayMs: 10000 })
    expect(
      decideAfterLimit(
        facts({
          candidates: blocked,
          selection: undefined,
          history: old,
          clockNow: 301000,
        }),
        earliestPoolEngine,
      ),
    ).toMatchObject({
      action: 'refuse',
      reason: 'quota',
      retryable: false,
      hostRetry: 'veto',
    })
    expect(
      decideAfterLimit(
        facts({
          candidates: blocked,
          selection: undefined,
          history: old,
          clockNow: 301000,
          poolWaitBudgetMs: 0,
        }),
        earliestPoolEngine,
      ),
    ).toMatchObject({ action: 'wait-then-reselect', delayMs: 15000 })
  })

  test('request deadline clips a wait and is not replenished after selection', () => {
    const selected = reduceRequestHistory(history(), { type: 'selected' })
    expect(
      decideAfterLimit(
        facts({
          history: selected,
          clockNow: 600000,
          poolWaitBudgetMs: 0,
          candidates: blocked,
          selection: undefined,
        }),
        earliestPoolEngine,
      ),
    ).toMatchObject({ action: 'wait-then-reselect', delayMs: 1000 })
    expect(
      decideAfterLimit(
        facts({
          history: selected,
          clockNow: 601000,
          poolWaitBudgetMs: 0,
          candidates: blocked,
          selection: undefined,
        }),
        earliestPoolEngine,
      ),
    ).toMatchObject({
      action: 'refuse',
      reason: 'incomplete',
      messageKey: 'incomplete.timeout',
      retryable: false,
      hostRetry: 'veto',
    })
  })

  test('CL-22 terminal 401 after a zero-length 429 mark still synthesizes quota', () => {
    const first = decideAfterLimit(
      facts({
        signal: undefined,
        status: 429,
        candidates: [candidate(A)],
        selection: undefined,
      }),
      statusVaultOrder,
    )
    const result = decideAfterLimit(
      facts({
        signal: undefined,
        status: 401,
        history: first.history,
        candidates: [candidate(A)],
        selection: undefined,
      }),
      statusVaultOrder,
    )
    expect(result).toMatchObject({
      action: 'refuse',
      reason: 'quota',
      family: 'claustrum-429',
      messageKey: 'quota.accounts-rate-limited',
      retryAfterMs: 60000,
      retryable: true,
      hostRetry: 'leave',
    })
  })

  test('CL original last 401 without saw429 stays pass-through', () => {
    expect(
      decideAfterLimit(
        facts({
          signal: undefined,
          status: 401,
          candidates: [candidate(A)],
          selection: undefined,
          failureRetryable: false,
        }),
        statusVaultOrder,
      ),
    ).toMatchObject({ action: 'pass', retryable: false, hostRetry: 'leave' })
  })

  test('CL-20 final provider 429 stays original even when every account is now marked', () => {
    expect(
      decideAfterLimit(
        facts({ candidates: blocked, selection: undefined }),
        statusVaultOrder,
      ),
    ).toMatchObject({ action: 'pass', retryable: true, hostRetry: 'leave' })
  })

  test('CL-23 a fresh all-marked pool uses the earliest live deadline', () => {
    expect(
      decideAfterLimit(
        facts({
          phase: 'pre-send',
          attempted: undefined,
          signal: undefined,
          candidates: blocked,
          selection: undefined,
        }),
        statusVaultOrder,
      ),
    ).toMatchObject({
      action: 'refuse',
      family: 'claustrum-429',
      retryAfterMs: 10000,
      retryable: true,
      hostRetry: 'leave',
    })
  })

  test('OpenCode 2 marked-pool escape never bypasses admission or non-mark blockers', () => {
    const marked = facts({
      phase: 'pre-send',
      host: 'opencode2',
      hostPhase: 'request',
      attempted: undefined,
      signal: undefined,
      candidates: blocked.map((entry) => ({
        ...entry,
        blockers: [{ kind: 'hard' as const, until: now + 10000 }],
      })),
    })
    expect(decideAfterLimit(marked, windowRouter)).toMatchObject({
      action: 'reroute',
      account: B,
    })
    expect(
      decideAfterLimit(
        {
          ...marked,
          candidates: [candidate(B, { admitted: false, ready: false })],
        },
        windowRouter,
      ).action,
    ).not.toBe('reroute')
    expect(
      decideAfterLimit(
        {
          ...marked,
          candidates: [
            candidate(B, {
              ready: false,
              blockers: [{ kind: 'soft', until: now + 10000 }],
            }),
          ],
        },
        windowRouter,
      ).action,
    ).not.toBe('reroute')
  })
})

describe('hold jitter', () => {
  test.each([
    ['session-a', 1, 17000],
    ['session-a', 840000, 856000],
    ['session-a', 1000.1, 18000],
    ['', 1, 9000],
    ['abc', 1, 13000],
  ] as const)(
    'SHA256 whole-hold law: %s, %d ms yields %d ms',
    (seed, delay, expected) => {
      expect(holdDelayMs(seed, delay)).toBe(expected)
    },
  )
})
