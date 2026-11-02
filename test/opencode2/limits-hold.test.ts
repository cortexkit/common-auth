import { describe, expect, test } from 'bun:test'
import type {
  AccountKey,
  LimitCandidate,
  LimitWindow,
  PolicyFacts,
} from '../../src/limits/index.js'
import {
  createRequestHistory,
  createSessionActivityStore,
  sameAccountHoldFacts,
} from '../../src/limits/index.js'
import type {
  ChooseAccountResult,
  OpenCode2AuthAdapter,
  OpenCode2AuthEvents,
} from '../../src/opencode2/index.js'
import {
  installOpenCode2Auth,
  placeholderSecret,
} from '../../src/opencode2/index.js'
import {
  fakeAdapter,
  fakeHost,
  PROVIDER,
  scopeFor,
  type TestQuota,
} from './fake-host.js'
import { limitsFixtureAdapter } from './limits-fixture-adapter.js'

const now = 1_700_000_000_000
const A: AccountKey = { namespace: 'fixture', accountId: 'A', incarnation: '1' }
const B: AccountKey = { ...A, accountId: 'B' }
// This session's stable jitter is 16 s, making a +2700 s reset a +2716 s hold.
const sessionId = 'session-a'
const scope = scopeFor('primary', sessionId)
const modelScope = { kind: 'model', model: scope.model.id } as const

function window(resetAt: number): LimitWindow {
  return {
    window: '5h',
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
    placementEligible: ready,
    ready,
    blockers: [],
  }
}

function fixture({
  setting = 'max',
  ttlMs = 3_600_000,
  activity = true,
  alternative = true,
  resetMs = 2_700_000,
  hostRetryLimit = 10,
}: {
  setting?: 0 | 15 | 'max'
  ttlMs?: number
  activity?: boolean
  alternative?: boolean
  resetMs?: number
  hostRetryLimit?: number
} = {}) {
  const store = createSessionActivityStore()
  if (activity)
    store.recordAccepted({
      sessionId,
      accountKey: A,
      currentAccountKey: A,
      lastAcceptedAt: now,
      ttlMs,
    })
  let limited = false
  let clock = now
  let patch: Partial<PolicyFacts> = {}
  const held: LimitCandidate = {
    ...candidate(A, false),
    confirmedBlockers: [window(now + resetMs)],
  }
  const policy = limitsFixtureAdapter(
    () => ({
      phase: 'pre-send',
      host: 'opencode2',
      now: clock,
      clockNow: 1000 + clock - now,
      sessionId,
      requestScope: modelScope,
      history: createRequestHistory({
        requestId: 'turn',
        originalUrl: '/messages',
        clockNow: 1000,
      }),
      attempted: A,
      delivery: { owned: true, attributable: true, replayable: true },
      candidates: [
        limited ? held : candidate(A, true),
        ...(alternative ? [candidate(B, true)] : []),
      ],
      selection: { account: limited && alternative ? B : A, pin: 'pin' },
      hold: sameAccountHoldFacts({
        activity: store.get(sessionId),
        accountKey: A,
        maxSameAccountWait: setting,
      }),
      terminal: {
        source: 'pool',
        reason: 'quota',
        scan: {
          candidates: limited
            ? [
                {
                  account: A,
                  readingAccount: A,
                  windows: [
                    {
                      window: '5h',
                      scope: modelScope,
                      blockedBy: 'exhausted',
                      reset: { at: now + resetMs, observedAt: now },
                    },
                  ],
                },
              ]
            : [],
          effectiveModel: scope.model.id,
          familyOf: () => 'mock',
          maxAgeMs: 60_000,
          maxSameAccountWait: setting,
          activity: store.get(sessionId),
          accountKey: A,
        },
      },
      ...patch,
    }),
    { hostRetryLimit },
  )
  return {
    ...policy,
    store,
    held,
    hostRetryLimit,
    limit() {
      limited = true
    },
    wake(at = now + 2_716_000, update: Partial<PolicyFacts> = {}) {
      clock = at
      patch = update
    },
  }
}

async function install(policy: ReturnType<typeof fixture>) {
  const host = fakeHost()
  const headers: string[] = []
  const sends: string[] = []
  const retries: OpenCode2AuthEvents<TestQuota>['retry'][] = []
  const adapter: OpenCode2AuthAdapter<TestQuota, unknown, ChooseAccountResult> =
    {
      ...fakeAdapter().adapter,
      chooseAccount: policy.chooseAccount,
      accountHeaders({ accountId }) {
        headers.push(accountId)
        return {
          authorization: `Bearer tok-${accountId}`,
          'x-account': accountId,
        }
      },
      limitFromError: () => ({ reason: 'quota', status: 429 }),
    }
  const auth = await installOpenCode2Auth(host.ctx, adapter, {
    hostRetryLimit: policy.hostRetryLimit,
    enforceRequestExclusion: true,
  })
  auth.on('retry', (event) => {
    retries.push(event)
  })
  return {
    auth,
    headers,
    sends,
    retries,
    async send() {
      const model = await host.fire('model.request', {
        ...scope,
        headers: {} as Record<string, string>,
      })
      const draft = await host.fire('http.request', {
        ...scope,
        request: new Request('https://provider.invalid/messages', {
          headers: {
            ...model.headers,
            authorization: `Bearer ${placeholderSecret(PROVIDER)}`,
          },
        }),
      })
      const account = draft.request.headers.get('x-account')
      if (account !== null) sends.push(account)
    },
    retry(
      attempt = policy.hostRetryLimit - 1,
      decision: { retry: boolean; delay?: number } = { retry: false },
    ) {
      policy.limit()
      return host.fire('retry', {
        ...scope,
        attempt,
        error: { type: 'provider.unknown', message: 'quota' },
        decision,
      })
    },
  }
}

describe('limits fixture adapter: OpenCode 2 single hold', () => {
  test('max delivers one 2716000 ms retry, with one adapter call at hold and one at wake', async () => {
    const policy = fixture()
    const s = await install(policy)
    try {
      await s.send()
      expect(policy.calls).toHaveLength(1)
      expect(policy.calls[0]?.hostAttempt).toBeUndefined()
      expect((await s.retry()).decision).toEqual({
        retry: true,
        delay: 2_716_000,
      })
      expect(policy.calls).toHaveLength(2)
      expect(policy.calls[1]).toMatchObject({ phase: 'retry', hostAttempt: 9 })
      expect(policy.decisions[1]).toMatchObject({
        action: 'hold',
        account: A,
        delayMs: 2_716_000,
        retryAfterMs: 2_716_000,
        target: now + 2_716_000,
        reason: 'confirmed-limit',
        retryable: true,
        hostRetry: 'leave',
      })
      expect(policy.results[1]).toEqual({
        hold: {
          delayMs: 2_716_000,
          target: now + 2_716_000,
          checkpoint: {
            accountKey: A,
            decidedAt: now,
            blockers: [{ window: '5h', resetAt: now + 2_700_000 }],
          },
          kind: undefined,
        },
      })
      policy.wake()
      await s.send()
      expect(policy.calls).toHaveLength(3)
      expect(policy.calls[2]).toMatchObject({
        phase: 'request',
        previousAccountId: 'A',
        hostAttempt: 9,
        wake: {
          target: now + 2_716_000,
          checkpoint: { accountKey: A, decidedAt: now },
        },
      })
      expect(policy.calls[2]?.excluded ?? []).toEqual([])
      expect(policy.decisions[2]).toMatchObject({
        action: 'retain',
        account: A,
        liftedWindows: ['5h'],
        reason: 'wait-elapsed',
      })
      expect(policy.results[2]).toBe('A')
      expect(s.headers).toEqual(['A', 'A'])
      expect(s.sends).toEqual(['A', 'A'])
      expect(s.retries).toHaveLength(1)
      expect(policy.decisions.filter((d) => d.action === 'hold')).toHaveLength(
        1,
      )
    } finally {
      await s.auth.dispose()
    }
  })

  test('15 reroutes to B for the same +2716 s facts', async () => {
    const policy = fixture({ setting: 15 })
    const s = await install(policy)
    try {
      await s.send()
      expect((await s.retry()).decision).toEqual({ retry: true, delay: 0 })
      expect(policy.decisions[1]).toMatchObject({
        action: 'reroute',
        account: B,
      })
      expect(policy.results[1]).toBe('B')
      await s.send()
      expect(s.sends).toEqual(['A', 'B'])
      expect(policy.calls).toHaveLength(2)
    } finally {
      await s.auth.dispose()
    }
  })

  test('remainingRetries=0 passes and leaves the host decision; 1 holds with a configured limit', async () => {
    for (const remainingRetries of [0, 1]) {
      const policy = fixture({ hostRetryLimit: 4 })
      const s = await install(policy)
      try {
        await s.send()
        const hostDecision = { retry: true, delay: 123 }
        const result = await s.retry(4 - remainingRetries, hostDecision)
        expect(policy.calls[1]?.hostAttempt).toBe(4 - remainingRetries)
        if (remainingRetries === 0) {
          expect(policy.decisions[1]).toMatchObject({
            action: 'pass',
            hostRetry: 'leave',
            reason: 'host-retries-exhausted',
          })
          expect(policy.results[1]).toEqual({ hostRetry: 'leave' })
          expect(result.decision).toEqual(hostDecision)
        } else {
          expect(policy.decisions[1]?.action).toBe('hold')
          expect(result.decision).toEqual({ retry: true, delay: 2_716_000 })
        }
      } finally {
        await s.auth.dispose()
      }
    }
  })

  test('a 3622000 ms hold is above the clamp and reroutes to B', async () => {
    const policy = fixture({ ttlMs: 7_200_000, resetMs: 3_606_000 })
    const s = await install(policy)
    try {
      await s.send()
      expect((await s.retry()).decision).toEqual({ retry: true, delay: 0 })
      expect(policy.decisions[1]).toMatchObject({
        action: 'reroute',
        account: B,
      })
      expect(policy.results[1]).toBe('B')
      await s.send()
      expect(s.headers).toEqual(['A', 'B'])
      expect(s.sends).toEqual(['A', 'B'])
    } finally {
      await s.auth.dispose()
    }
  })
})

describe('limits fixture adapter: wake re-check', () => {
  for (const failure of ['admission', 'identity', 'custody', 'cache'] as const)
    for (const alternative of [true, false])
      test(`${failure} failure at wake ${alternative ? 'reroutes to B' : 'refuses without an alternative'}`, async () => {
        const policy = fixture({ alternative })
        const s = await install(policy)
        try {
          await s.send()
          expect((await s.retry()).decision).toEqual({
            retry: true,
            delay: 2_716_000,
          })
          const held = {
            ...policy.held,
            // Custody and admission checks are both caller-owned admission facts.
            ...(failure === 'admission' || failure === 'custody'
              ? { admitted: false }
              : {}),
            ...(failure === 'identity'
              ? { account: { ...A, incarnation: '2' } }
              : {}),
          }
          policy.wake(failure === 'cache' ? now + 3_600_001 : now + 2_716_000, {
            candidates: [held, ...(alternative ? [candidate(B, true)] : [])],
          })
          if (alternative) {
            await s.send()
            expect(policy.decisions[2]).toMatchObject({
              action: 'reroute',
              account: B,
            })
            expect(policy.results[2]).toBe('B')
          } else {
            await expect(s.send()).rejects.toMatchObject({ kind: 'no-account' })
            expect(policy.decisions[2]).toMatchObject({
              action: 'refuse',
              reason: 'quota',
              family: 'claude-429',
              messageKey: 'quota.all-accounts',
              retryAfterMs: 300_000,
              retryable: true,
              hostRetry: 'leave',
            })
            expect(policy.results[2]).toBeUndefined()
          }
          expect(policy.calls).toHaveLength(3)
          expect(policy.calls[2]).toMatchObject({
            phase: 'request',
            hostAttempt: 9,
            wake: { target: now + 2_716_000 },
          })
          expect(s.headers).toEqual(alternative ? ['A', 'B'] : ['A'])
          expect(s.sends).toEqual(alternative ? ['A', 'B'] : ['A'])
          expect(s.retries).toHaveLength(1)
        } finally {
          await s.auth.dispose()
        }
      })
})

describe('limits fixture adapter: terminal holds and dispositions', () => {
  test('max with ttl 3600000 and a reset beyond it delivers one 3600000 ms terminal hold', async () => {
    const policy = fixture({ alternative: false, resetMs: 86_400_000 })
    const s = await install(policy)
    try {
      await s.send()
      expect((await s.retry()).decision).toEqual({
        retry: true,
        delay: 3_600_000,
      })
      expect(policy.decisions[1]).toMatchObject({
        action: 'hold',
        account: A,
        delayMs: 3_600_000,
        retryAfterMs: 3_600_000,
        target: now + 3_600_000,
        resetAt: now + 86_400_000,
        reason: 'terminal-quota',
        waitKind: 'terminal',
        retryable: true,
        hostRetry: 'leave',
      })
      expect(policy.results[1]).toMatchObject({ hold: { kind: 'terminal' } })
      policy.wake(now + 3_600_000)
      await expect(s.send()).rejects.toMatchObject({ kind: 'no-account' })
      expect(policy.calls).toHaveLength(3)
      expect(policy.calls[2]?.wake?.kind).toBe('terminal')
      expect(policy.decisions[2]?.action).toBe('refuse')
      expect(policy.results[2]).toBeUndefined()
      expect(s.headers).toEqual(['A'])
      expect(s.sends).toEqual(['A'])
      expect(s.retries).toHaveLength(1)
      expect(policy.decisions.filter((d) => d.action === 'hold')).toHaveLength(
        1,
      )
    } finally {
      await s.auth.dispose()
    }
  })

  test('AN54 under 15 without activity delivers one 600000 ms terminal hold and wakes to A', async () => {
    const policy = fixture({
      setting: 15,
      activity: false,
      alternative: false,
      resetMs: 600_000,
    })
    const s = await install(policy)
    try {
      expect(policy.store.get(sessionId)).toBeUndefined()
      await s.send()
      expect((await s.retry()).decision).toEqual({
        retry: true,
        delay: 600_000,
      })
      expect(policy.decisions[1]).toMatchObject({
        action: 'hold',
        account: A,
        delayMs: 600_000,
        retryAfterMs: 600_000,
        target: now + 600_000,
        waitKind: 'terminal',
        checkpoint: {
          accountKey: A,
          blockers: [{ window: '5h', resetAt: now + 600_000 }],
        },
        reason: 'terminal-quota',
      })
      expect(policy.results[1]).toMatchObject({
        hold: { delayMs: 600_000, target: now + 600_000, kind: 'terminal' },
      })
      policy.wake(now + 600_000)
      await s.send()
      expect(policy.calls).toHaveLength(3)
      expect(policy.calls[2]).toMatchObject({
        hostAttempt: 9,
        wake: { target: now + 600_000, kind: 'terminal' },
      })
      expect(policy.decisions[2]).toMatchObject({
        action: 'retain',
        account: A,
        liftedWindows: ['5h'],
      })
      expect(policy.results[2]).toBe('A')
      expect(s.sends).toEqual(['A', 'A'])
      expect(s.retries).toHaveLength(1)
      expect(policy.decisions.filter((d) => d.action === 'hold')).toHaveLength(
        1,
      )
    } finally {
      await s.auth.dispose()
    }
  })

  test('a max terminal hold with remainingRetries=0 passes and leaves the host alone', async () => {
    const policy = fixture({ alternative: false, resetMs: 86_400_000 })
    const s = await install(policy)
    try {
      await s.send()
      const hostDecision = { retry: true, delay: 321 }
      expect((await s.retry(10, hostDecision)).decision).toEqual(hostDecision)
      expect(policy.decisions[1]).toMatchObject({
        action: 'pass',
        hostRetry: 'leave',
      })
      expect(policy.results[1]).toEqual({ hostRetry: 'leave' })
      expect(policy.decisions.some((d) => d.action === 'hold')).toBe(false)
    } finally {
      await s.auth.dispose()
    }
  })

  test('setting 0 maps a non-retryable terminal refusal to veto, overriding a host retry', async () => {
    const policy = fixture({
      setting: 0,
      alternative: false,
      resetMs: 5_700_000,
    })
    const s = await install(policy)
    try {
      await s.send()
      expect((await s.retry(1, { retry: true, delay: 321 })).decision).toEqual({
        retry: false,
      })
      expect(policy.decisions[1]).toMatchObject({
        action: 'refuse',
        reason: 'quota',
        family: 'json-412',
        messageKey: 'quota.all-accounts',
        retryAfterMs: 5_700_000,
        resetAt: now + 5_700_000,
        retryable: false,
        hostRetry: 'veto',
      })
      expect(policy.results[1]).toEqual({ hostRetry: 'veto' })
      expect(s.headers).toEqual(['A'])
      expect(s.sends).toEqual(['A'])
    } finally {
      await s.auth.dispose()
    }
  })
})
