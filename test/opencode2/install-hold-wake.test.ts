import { describe, expect, spyOn, test } from 'bun:test'
import type {
  AccountKey,
  LimitCandidate,
  LimitDecision,
  PolicyFacts,
} from '../../src/limits/index.js'
import {
  confirmedAffinity,
  createRequestHistory,
  decideAfterLimit,
} from '../../src/limits/index.js'
import type {
  ChooseAccountInput,
  ChooseAccountResult,
  InstallOpenCode2AuthOptions,
  OpenCode2AuthAdapter,
} from '../../src/opencode2/index.js'
import {
  installOpenCode2Auth,
  MAX_RETRY_HOLD_MS,
  placeholderSecret,
} from '../../src/opencode2/index.js'
import {
  fakeAdapter,
  fakeHost,
  PROVIDER,
  scopeFor,
  type TestQuota,
} from './fake-host.js'

const now = 1_700_000_000_000
const A: AccountKey = { namespace: 'test', accountId: 'A', incarnation: '1' }
const B: AccountKey = { ...A, accountId: 'B' }
const sessionID = 'session-a'

async function setup(
  choose: (input: ChooseAccountInput) => ChooseAccountResult,
  options: InstallOpenCode2AuthOptions = {},
) {
  const host = fakeHost()
  const choices: ChooseAccountInput[] = []
  const headers: string[] = []
  const sends: string[] = []
  const drops: Array<ChooseAccountInput & { accountId: string }> = []
  const adapter: OpenCode2AuthAdapter<TestQuota, unknown, ChooseAccountResult> =
    {
      ...fakeAdapter().adapter,
      chooseAccount(input) {
        choices.push(input)
        return choose(input)
      },
      dropChoice(input) {
        drops.push(input)
      },
      accountHeaders({ accountId }) {
        headers.push(accountId)
        return {
          authorization: `Bearer tok-${accountId}`,
          'x-account': accountId,
        }
      },
      limitFromError: () => ({ reason: 'usage_limit_reached', status: 429 }),
    }
  const auth = await installOpenCode2Auth(host.ctx, adapter, options)
  const send = async () => {
    const scope = scopeFor('primary', sessionID)
    const model = await host.fire('model.request', {
      ...scope,
      headers: {} as Record<string, string>,
    })
    const draft = await host.fire('http.request', {
      ...scope,
      request: new Request('https://provider.invalid/v1/responses', {
        headers: {
          ...model.headers,
          authorization: `Bearer ${placeholderSecret(PROVIDER)}`,
        },
      }),
    })
    const account = draft.request.headers.get('x-account')
    if (account !== null) sends.push(account)
  }
  const retry = (
    attempt = 1,
    decision: { retry: boolean; delay?: number } = { retry: false },
  ) =>
    host.fire('retry', {
      ...scopeFor('primary', sessionID),
      attempt,
      error: { type: 'provider.unknown', message: 'usage_limit_reached' },
      decision,
    })
  return { auth, choices, headers, sends, drops, send, retry }
}

/** Map shared limit decisions to chooser results as a plugin adapter would. */
function policyAdapter(hostRetryLimit = 10) {
  const window = {
    window: '5h',
    resetAt: now + 2_700_000,
    confirmed: true,
    confirmedByReading: true,
    observedAt: now,
    provenance: 'reading',
  }
  const held: LimitCandidate = {
    account: A,
    admitted: true,
    placementEligible: false,
    ready: false,
    blockers: [],
    confirmedBlockers: [window],
  }
  const alternative: LimitCandidate = {
    account: B,
    admitted: true,
    placementEligible: true,
    ready: true,
    blockers: [],
  }
  const facts: PolicyFacts = {
    phase: 'after-limit',
    host: 'opencode2',
    now,
    clockNow: 1000,
    sessionId: sessionID,
    requestScope: { kind: 'model', model: 'mock-model' },
    history: createRequestHistory({
      requestId: 'turn',
      originalUrl: '/messages',
      clockNow: 1000,
    }),
    attempted: A,
    delivery: { owned: true, attributable: true, replayable: true },
    candidates: [held, alternative],
    selection: { account: B, pin: 'pin' },
    hold: { cacheExpiresAt: now + 3_600_000, maxWaitMs: Infinity },
    terminal: { source: 'pool', reason: 'quota' },
  }
  const decisions: LimitDecision[] = []
  let patch: Partial<PolicyFacts> = {}
  return {
    held,
    decisions,
    update(value: Partial<PolicyFacts>) {
      patch = value
    },
    choose(input: ChooseAccountInput): ChooseAccountResult {
      if (input.phase === 'request' && !input.wake) return 'A'
      const decision = decideAfterLimit(
        {
          ...facts,
          ...patch,
          phase: input.phase === 'retry' ? 'after-limit' : 'pre-send',
          hostPhase: input.phase,
          remainingRetries:
            input.hostAttempt === undefined
              ? undefined
              : hostRetryLimit - input.hostAttempt,
          wake: input.wake?.checkpoint
            ? { ...input.wake, checkpoint: input.wake.checkpoint }
            : undefined,
        },
        confirmedAffinity,
      )
      decisions.push(decision)
      if (decision.action === 'hold') {
        return {
          hold: {
            delayMs: decision.delayMs,
            target: decision.target,
            checkpoint: decision.checkpoint,
            kind: decision.waitKind,
          },
        }
      }
      if (decision.action === 'reroute' || decision.action === 'retain')
        return decision.account.accountId
      return undefined
    },
  }
}

describe('OpenCode 2 hold wake', () => {
  test('max issues a single 2716000 ms hold and chooses once more at wake', async () => {
    const policy = policyAdapter()
    const s = await setup(policy.choose)
    try {
      await s.send()
      expect((await s.retry(9)).decision).toEqual({
        retry: true,
        delay: 2_716_000,
      })
      expect(s.choices).toHaveLength(2)
      expect(s.choices[1]).toMatchObject({ phase: 'retry', hostAttempt: 9 })
      policy.update({ now: now + 2_716_000 })
      await s.send()
      expect(s.choices).toHaveLength(3)
      expect(s.choices[2]).toMatchObject({
        phase: 'request',
        previousAccountId: 'A',
        hostAttempt: 9,
        wake: {
          target: now + 2_716_000,
          checkpoint: { accountKey: A, decidedAt: now },
        },
      })
      expect(policy.decisions.map((decision) => decision.action)).toEqual([
        'hold',
        'retain',
      ])
      expect(s.headers).toEqual(['A', 'A'])
      expect(s.sends).toEqual(['A', 'A'])
      expect(s.drops).toHaveLength(1)
      expect(s.drops[0]).toMatchObject({
        accountId: 'A',
        phase: 'retry',
        hostAttempt: 9,
      })
    } finally {
      await s.auth.dispose()
    }
  })
  for (const [when, offset] of [
    ['before', -1],
    ['at', 0],
    ['after', 1],
  ] as const) {
    test(`targeted hold rechecks when target is ${when} now`, async () => {
      const clock = spyOn(Date, 'now').mockReturnValue(now)
      const s = await setup((input) => {
        if (input.phase === 'retry')
          return {
            hold: { delayMs: 1000, target: Date.now() + offset * 60_000 },
          }
        return input.wake ? 'B' : 'A'
      })
      try {
        await s.send()
        await s.retry(3)
        await s.send()
        expect(s.choices).toHaveLength(3)
        expect(s.choices[0]?.hostAttempt).toBeUndefined()
        expect(s.choices[2]).toMatchObject({ phase: 'request', hostAttempt: 3 })
        expect(s.headers).toEqual(['A', 'B'])
        expect(s.sends).toEqual(['A', 'B'])
      } finally {
        await s.auth.dispose()
        clock.mockRestore()
      }
    })
  }

  for (const gated of [false, true]) {
    for (const failure of [
      'admission',
      'identity',
      'custody',
      'cache',
    ] as const) {
      for (const alternative of [true, false]) {
        test(`${gated ? 'gated' : 'ungated'} wake ${failure} failure ${alternative ? 'reroutes' : 'refuses'} before held credentials or send`, async () => {
          const policy = policyAdapter()
          const s = await setup(
            policy.choose,
            gated
              ? {
                  gateOnPlaceholder: {
                    credential: (headers) =>
                      headers.get('authorization')?.replace(/^Bearer /, ''),
                  },
                }
              : {},
          )
          try {
            await s.send()
            expect((await s.retry()).decision.retry).toBe(true)
            const held = {
              ...policy.held,
              ...(failure === 'admission' || failure === 'custody'
                ? { admitted: false }
                : {}),
              ...(failure === 'identity'
                ? { account: { ...A, incarnation: '2' } }
                : {}),
            }
            policy.update({
              now: now + 2_716_000,
              candidates: [
                held,
                ...(alternative
                  ? [
                      {
                        account: B,
                        admitted: true,
                        placementEligible: true,
                        ready: true,
                        blockers: [],
                      },
                    ]
                  : []),
              ],
              ...(failure === 'cache'
                ? {
                    hold: {
                      cacheExpiresAt: now + 2_715_999,
                      maxWaitMs: Infinity,
                    },
                  }
                : {}),
            })
            if (alternative) await s.send()
            else
              await expect(s.send()).rejects.toMatchObject({
                kind: 'no-account',
              })
            expect(s.choices).toHaveLength(3)
            expect(policy.decisions.at(-1)?.action).toBe(
              alternative ? 'reroute' : 'refuse',
            )
            expect(s.headers).toEqual(alternative ? ['A', 'B'] : ['A'])
            expect(s.sends).toEqual(alternative ? ['A', 'B'] : ['A'])
          } finally {
            await s.auth.dispose()
          }
        })
      }
    }
  }

  test('a hold without target still takes next without another chooser call', async () => {
    const s = await setup((input) =>
      input.phase === 'retry'
        ? { hold: { delayMs: 1000 } }
        : input.previousAccountId
          ? 'B'
          : 'A',
    )
    try {
      await s.send()
      await s.retry()
      await s.send()
      expect(s.choices).toHaveLength(2)
      expect(s.headers).toEqual(['A', 'A'])
      expect(s.sends).toEqual(['A', 'A'])
      expect(s.drops).toEqual([])
    } finally {
      await s.auth.dispose()
    }
  })

  test('hostAttempt is absent on ordinary requests after a non-hold retry', async () => {
    const s = await setup((input) =>
      input.phase === 'retry' ? undefined : 'A',
    )
    try {
      await s.send()
      await s.retry(7)
      await s.send()
      expect(s.choices.map((input) => input.hostAttempt)).toEqual([
        undefined,
        7,
        undefined,
      ])
      expect(s.choices[2]?.wake).toBeUndefined()
    } finally {
      await s.auth.dispose()
    }
  })

  for (const [delayMs, accepted] of [
    [3_621_000, true],
    [3_622_000, false],
  ] as const) {
    test(`${accepted ? 'accepts' : 'rejects'} a ${delayMs} ms hold at the raised clamp`, async () => {
      const s = await setup((input) =>
        input.phase === 'retry'
          ? { hold: { delayMs, target: now + delayMs } }
          : 'A',
      )
      try {
        await s.send()
        expect((await s.retry()).decision).toEqual(
          accepted ? { retry: true, delay: 3_621_000 } : { retry: false },
        )
        expect(s.drops).toHaveLength(accepted ? 0 : 1)
        expect(MAX_RETRY_HOLD_MS).toBe(3_621_000)
      } finally {
        await s.auth.dispose()
      }
    })
  }

  for (const limit of [undefined, 4]) {
    for (const remaining of [0, 1]) {
      test(`retry budget ${limit ?? 'default 10'} with ${remaining} remaining ${remaining ? 'holds' : 'passes and leaves host retry'}`, async () => {
        const policy = policyAdapter(limit)
        const s = await setup(policy.choose, { hostRetryLimit: limit })
        try {
          await s.send()
          const draft = await s.retry((limit ?? 10) - remaining)
          expect(draft.decision).toEqual(
            remaining ? { retry: true, delay: 2_716_000 } : { retry: false },
          )
          expect(policy.decisions[0]).toMatchObject(
            remaining
              ? { action: 'hold' }
              : { action: 'pass', hostRetry: 'leave' },
          )
        } finally {
          await s.auth.dispose()
        }
      })
    }
  }

  for (const limit of [undefined, 4]) {
    for (const choice of [
      'B',
      { hold: { delayMs: 1000 } },
    ] satisfies ChooseAccountResult[]) {
      test(`installer retry budget ${limit ?? 'default 10'} releases an unexecutable ${typeof choice === 'string' ? 'reroute' : 'hold'} and leaves the host decision`, async () => {
        const s = await setup(
          (input) => (input.phase === 'retry' ? choice : 'A'),
          { hostRetryLimit: limit },
        )
        try {
          await s.send()
          const hostDecision = { retry: true, delay: 1234 }
          expect((await s.retry(limit ?? 10, hostDecision)).decision).toEqual(
            hostDecision,
          )
          expect(s.drops).toHaveLength(1)
          expect(s.drops[0]?.accountId).toBe(
            typeof choice === 'string' ? 'B' : 'A',
          )
          await s.send()
          expect(s.choices).toHaveLength(3)
          expect(s.choices[2]?.hostAttempt).toBeUndefined()
          expect(s.sends).toEqual(['A', 'A'])
        } finally {
          await s.auth.dispose()
        }
      })
    }
  }
})
