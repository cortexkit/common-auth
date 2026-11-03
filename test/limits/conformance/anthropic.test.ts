import { describe, expect, test } from 'bun:test'
import {
  type AccountKey,
  buildRefusal,
  confirmedAffinity,
  createRequestHistory,
  createSessionActivityStore,
  decideAfterLimit,
  type LimitCandidate,
  type LimitDecision,
  type LimitWindow,
  type PolicyFacts,
  registerLimitMessages,
  sameAccountHoldFacts,
  type TerminalScanFacts,
  UnconfirmedRetainCounter,
} from '../../../src/limits/index.js'
import {
  type ChooseAccountInput,
  type ChooseAccountResult,
  installOpenCode2Auth,
  type OpenCode2AuthAdapter,
  placeholderSecret,
} from '../../../src/opencode2/index.js'
import {
  fakeAdapter,
  fakeHost,
  PROVIDER,
  scopeFor,
  type TestQuota,
} from '../../opencode2/fake-host.js'
import { conformanceExclusions } from './exclusions.js'
import { runFakeClockDriver } from './fake-clock-driver.js'
import { conformanceRows, type VectorResult } from './rows.js'

// The confirmed-affinity AN rows describe anthropic-auth's routing decisions,
// with cache-bound holds and capped, fresh terminal metadata applied. Provider
// parsing, admission and placement supply the reduced facts;
// these vectors exercise the shared decision, not a second provider parser.
const now = 1_700_000_000_000
const A: AccountKey = {
  namespace: 'anthropic',
  accountId: 'A',
  incarnation: '1',
}
const B: AccountKey = { ...A, accountId: 'B' }
const scope = { kind: 'model', model: 'claude-fable-5' } as const

export const anthropicVectorResults: VectorResult[] = []

function vector(rowId: string, value: string, run: () => void | Promise<void>) {
  const name = `${rowId} ${value}`
  test(name, async () => {
    await run()
    anthropicVectorResults.push({
      rowId,
      preset: 'confirmed-affinity',
      name,
      status: 'passed',
    })
  })
}

function candidate(
  account: AccountKey,
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

function window(
  name: string,
  resetMs?: number,
  patch: Partial<LimitWindow> = {},
): LimitWindow {
  return {
    window: name,
    confirmed: true,
    confirmedByReading: true,
    observedAt: now,
    provenance: 'poll',
    ...(resetMs === undefined ? {} : { resetAt: now + resetMs }),
    ...patch,
  }
}

function facts(
  windows: readonly LimitWindow[] = [],
  patch: Partial<PolicyFacts> = {},
): PolicyFacts {
  return {
    phase: 'after-limit',
    host: 'opencode1',
    now,
    clockNow: 1000,
    sessionId: 'session-a',
    requestScope: scope,
    history: createRequestHistory({
      requestId: 'anthropic-turn',
      originalUrl: '/v1/messages',
      clockNow: 1000,
    }),
    attempted: A,
    status: 429,
    signal: {
      account: A,
      kind: windows.some((item) => item.confirmed)
        ? 'quota-exhausted'
        : 'rate-limit',
      reason: 'quota',
      status: 429,
      scope,
      observedAt: now,
      windows,
    },
    affinity: 'sticky',
    delivery: { owned: true, attributable: true, replayable: true },
    candidates: [candidate(A), candidate(B)],
    selection: { account: B, pin: 'pin' },
    // A 15-minute same-account wait, a just-accepted one-hour cache, and ready B.
    hold: cacheBound(3_600_000),
    ...patch,
  }
}

function cacheBound(ttlMs?: number) {
  const activity = createSessionActivityStore()
  activity.recordAccepted({
    sessionId: 'session-a',
    accountKey: A,
    currentAccountKey: A,
    lastAcceptedAt: now,
    ttlMs,
  })
  return sameAccountHoldFacts({
    activity: activity.get('session-a'),
    accountKey: A,
    maxSameAccountWait: 15,
  })
}

type ExpectedDecision = {
  action: LimitDecision['action']
  reason: string
  account?: AccountKey
  delayMs?: number
  retryMs?: number
  family?: Extract<LimitDecision, { action: 'refuse' }>['family']
  messageKey?: string
  retryAfterMs?: number
  retryable?: boolean
  hostRetry?: 'leave' | 'veto'
}

// Compare every routing-decision delivery field, including absence. A wrong action, timer,
// account, family or host disposition cannot hide behind a partial matcher.
function decisionIs(decision: LimitDecision, expected: ExpectedDecision) {
  expect({
    action: decision.action,
    account: 'account' in decision ? decision.account : undefined,
    delayMs: 'delayMs' in decision ? decision.delayMs : undefined,
    retryMs: 'retryMs' in decision ? decision.retryMs : undefined,
    reason: decision.reason,
    family: 'family' in decision ? decision.family : undefined,
    messageKey: 'messageKey' in decision ? decision.messageKey : undefined,
    retryAfterMs:
      'retryAfterMs' in decision ? decision.retryAfterMs : undefined,
    retryable: decision.retryable,
    hostRetry: decision.hostRetry,
  }).toEqual({
    account: undefined,
    delayMs: undefined,
    retryMs: undefined,
    family: undefined,
    messageKey: undefined,
    retryAfterMs: undefined,
    retryable: true,
    hostRetry: 'leave',
    ...expected,
  })
}

function retain(retryMs = 60_000): ExpectedDecision {
  return { action: 'retain', account: A, reason: 'unconfirmed-limit', retryMs }
}

const reroute: ExpectedDecision = {
  action: 'reroute',
  account: B,
  reason: 'ready-alternative',
}

function held(delayMs: number): ExpectedDecision {
  return {
    action: 'hold',
    account: A,
    reason: 'confirmed-limit',
    delayMs,
    retryAfterMs: delayMs,
  }
}

describe('confirmed-affinity Anthropic L6 conformance', () => {
  for (const [id, name, windows] of [
    ['AN01', 'unknown quota retains A at 60000 without exhaustion', []],
    [
      'AN02',
      'nonexhausted poll retains A at 60000',
      [window('5h', undefined, { confirmed: false })],
    ],
    [
      'AN13',
      'wrong Fable scope is inapplicable for Opus; retains A at 60000',
      [],
    ],
    [
      'AN15',
      'rounded header zero and raw 0.999 do not confirm; retains A at 60000',
      [
        window('5h', undefined, {
          confirmed: false,
          confirmedByReading: false,
          provenance: 'response-headers',
        }),
      ],
    ],
    ['AN19', 'Opus-only response is inapplicable to Sonnet; retains A', []],
    ['AN22', 'failed probe leaves quota unconfirmed; retains A at 60000', []],
  ] as const) {
    vector(id, name, () => {
      const input = facts(windows, {
        ...(id === 'AN13'
          ? { requestScope: { kind: 'model', model: 'claude-opus-5' } }
          : {}),
        ...(id === 'AN19'
          ? { requestScope: { kind: 'model', model: 'claude-sonnet' } }
          : {}),
      })
      decisionIs(decideAfterLimit(input, confirmedAffinity), retain())
      expect(input.signal?.windows.some((item) => item.confirmed)).toBe(false)
    })
  }

  for (const [id, name, windows, delayMs] of [
    ['AN03', 'holds A at 616000', [window('5h', 600_000)], 616_000],
    [
      'AN06',
      'ceil 1ms then session jitter holds A at 17000',
      [window('5h', 1)],
      17_000,
    ],
    ['AN07', 'holds A at 856000', [window('5h', 840_000)], 856_000],
    [
      'AN08',
      'latest blocker holds A at 736000',
      [window('5h', 300_000), window('7d', 720_000)],
      736_000,
    ],
    [
      'AN09',
      '5h outranks scoped-first inspection; holds A at 856000',
      [
        window('scoped:fable', 120_000),
        window('5h', 840_000),
        window('7d', 600_000),
      ],
      856_000,
    ],
    [
      'AN14',
      'Opus ignores wrong Fable scope; general blocker holds at 616000',
      [window('5h', 600_000)],
      616_000,
    ],
    [
      'AN20',
      'response 7d overlay preserves different poll 5h; holds at 736000',
      [
        window('5h', 720_000),
        window('7d', 600_000, { provenance: 'response-headers' }),
      ],
      736_000,
    ],
    [
      'AN26',
      'initial SSE limit before output holds A at 856000',
      [window('5h', 840_000)],
      856_000,
    ],
  ] as const) {
    vector(id, name, () => {
      const decision = decideAfterLimit(
        facts(
          windows,
          id === 'AN14'
            ? {
                requestScope: { kind: 'model', model: 'claude-opus-5' },
              }
            : {},
        ),
        confirmedAffinity,
      )
      decisionIs(decision, held(delayMs))
      if (decision.action !== 'hold') throw new Error('Expected hold')
      expect(decision.target).toBe(now + delayMs)
      expect(decision.checkpoint).toEqual({
        accountKey: A,
        decidedAt: now,
        blockers: windows.map(({ window, resetAt }) => ({
          window,
          resetAt: resetAt!,
        })),
      })
      if (id === 'AN26') {
        const response = holdResponse(decision)
        expect(response.headers.get('retry-after')).toBe('856')
        expect(response.body).toBe(
          '{"type":"error","error":{"type":"rate_limit_error","message":"Sticky OAuth account quota resets shortly; retaining session affinity."}}',
        )
      }
    })
  }

  for (const [id, name, windows] of [
    [
      'AN04',
      'decided reroute B: jittered 916000 exceeds 15-minute bound',
      [window('7d', 900_000)],
    ],
    ['AN05', 'scoped +15m+1ms reroutes B', [window('scoped:fable', 900_001)]],
    [
      'AN10',
      'one long blocker reroutes B',
      [window('5h', 300_000), window('7d', 960_000)],
    ],
    [
      'AN11',
      'missing own reset cannot borrow another window; reroutes B',
      [window('7d'), window('5h', 60_000)],
    ],
    [
      'AN12',
      'past blocking reset does not create a zero hold; reroutes B',
      [window('7d', 0), window('5h', 60_000)],
    ],
    [
      'AN16',
      'raw utilization 1 with five-day reset reroutes B',
      [window('7d', 432_000_000, { provenance: 'response-headers' })],
    ],
    [
      'AN17',
      'rejected status alone with five-day reset reroutes B',
      [window('7d', 432_000_000, { provenance: 'response-headers' })],
    ],
    [
      'AN18',
      'matching Opus header spelling confirms long blocker; reroutes B',
      [window('scoped:opus', 432_000_000, { provenance: 'response-headers' })],
    ],
    [
      'AN21',
      'same-window response missing reset replaces poll reset; reroutes B',
      [window('7d', undefined, { provenance: 'response-headers' })],
    ],
  ] as const) {
    vector(id, name, () => {
      decisionIs(
        decideAfterLimit(
          facts(
            windows,
            id === 'AN18'
              ? {
                  requestScope: { kind: 'model', model: 'claude-opus-5' },
                }
              : {},
          ),
          confirmedAffinity,
        ),
        reroute,
      )
    })
  }

  for (const [id, name, hints, retryMs] of [
    [
      'AN23',
      'long hints retain at 60000 with no jitter',
      [432_000_000, 432_000_000],
      60_000,
    ],
    [
      'AN24',
      'shortest valid reset hint retains at 2000',
      [432_000_000, 2000, Number.NaN],
      2000,
    ],
    [
      'AN25',
      'fractional seconds retain at 1500 without rounding',
      [432_000_000, 1500],
      1500,
    ],
  ] as const) {
    vector(id, name, () => {
      decisionIs(
        decideAfterLimit(facts([], { retryHintsMs: hints }), confirmedAffinity),
        retain(retryMs),
      )
    })
  }
})

describe('confirmed-affinity proactive and host decisions', () => {
  vector(
    'AN27',
    'owned attributable output-started OC2 passes with veto and installer retry false',
    async () => {
      decisionIs(
        decideAfterLimit(
          facts([window('5h', 120_000)], {
            host: 'opencode2',
            hostPhase: 'retry',
            remainingRetries: 1,
            delivery: { owned: true, attributable: true, replayable: false },
          }),
          confirmedAffinity,
        ),
        {
          action: 'pass',
          reason: 'unsafe-output',
          retryable: false,
          hostRetry: 'veto',
        },
      )
      const host = fakeHost()
      const { adapter, choices } = fakeAdapter()
      const auth = await installOpenCode2Auth(host.ctx, adapter)
      try {
        const model = await host.fire('model.request', {
          ...scopeFor(),
          headers: {} as Record<string, string>,
        })
        await host.fire('experimental.ws.handshake', {
          ...scopeFor(),
          url: 'wss://provider.invalid/v1/messages',
          headers: {
            ...model.headers,
            authorization: `Bearer ${placeholderSecret(PROVIDER)}`,
          },
        })
        for (const type of ['delta', 'refused'])
          await host.fire('experimental.ws.receive', {
            ...scopeFor(),
            frame: JSON.stringify({ type }),
          })
        const retry = await host.fire('retry', {
          ...scopeFor(),
          attempt: 1,
          error: { type: 'provider.unknown', message: 'quota' },
          decision: { retry: true, delay: 1500 } as {
            retry: boolean
            delay?: number
          },
        })
        expect(retry.decision).toEqual({ retry: false })
        expect(choices).toHaveLength(1)
        expect(choices[0]?.phase).toBe('request')
      } finally {
        await auth.dispose()
      }
    },
  )

  vector(
    'AN89',
    'signal-free pre-send holds A at 616000 and publishes without sleeping or sending',
    () => {
      const input = facts([], {
        phase: 'pre-send',
        attempted: undefined,
        status: undefined,
        signal: undefined,
        candidates: [
          candidate(A, {
            ready: false,
            placementEligible: false,
            confirmedBlockers: [window('5h', 600_000)],
          }),
          candidate(B),
        ],
        selection: { account: A, pin: 'preserve' },
      })
      const decision = decideAfterLimit(input, confirmedAffinity)
      decisionIs(decision, held(616_000))
      const response = holdResponse(decision)
      expect(response.headers.get('retry-after')).toBe('616')
      expect(response.body).toBe(
        '{"type":"error","error":{"type":"rate_limit_error","message":"Sticky OAuth account quota resets shortly; retaining session affinity."}}',
      )
    },
  )

  test('proactive holds reuse setting, cache, admission and jitter bounds before rerouting to ready B', () => {
    for (const patch of [
      { hold: undefined },
      { hold: { cacheExpiresAt: now + 3_600_000, maxWaitMs: 0 } },
      { hold: { cacheExpiresAt: now + 600_000, maxWaitMs: 900_000 } },
      { hold: { cacheExpiresAt: now + 3_600_000, maxWaitMs: 616_000 - 1 } },
      {
        candidates: [
          candidate(A, {
            admitted: false,
            confirmedBlockers: [window('5h', 600_000)],
          }),
          candidate(B),
        ],
      },
    ] satisfies Partial<PolicyFacts>[]) {
      decisionIs(
        decideAfterLimit(
          facts([], {
            phase: 'pre-send',
            signal: undefined,
            status: undefined,
            candidates: [
              candidate(A, { confirmedBlockers: [window('5h', 600_000)] }),
              candidate(B),
            ],
            ...patch,
          }),
          confirmedAffinity,
        ),
        reroute,
      )
    }
  })

  vector(
    'AN90',
    'initial SSE unconfirmed retain at 60000 uses the recorded affinity formatter',
    () => {
      const decision = decideAfterLimit(facts(), confirmedAffinity)
      decisionIs(decision, retain())
      if (decision.action !== 'retain') throw new Error('Expected retain')
      const response = buildRefusal({
        family: 'claude-429',
        messageKey: 'affinity.unconfirmed',
        now,
        retryAfterMs: decision.retryMs,
        messages: registerLimitMessages({
          retryable: {
            'affinity.unconfirmed': () =>
              'Sticky OAuth account quota is unconfirmed; retrying shortly while retaining session affinity.',
          },
        }),
      })
      if (response.kind !== 'http') throw new Error('Expected HTTP refusal')
      expect(response.headers.get('retry-after')).toBe('60')
      expect(response.body).toBe(
        '{"type":"error","error":{"type":"rate_limit_error","message":"Sticky OAuth account quota is unconfirmed; retrying shortly while retaining session affinity."}}',
      )
    },
  )

  vector(
    'AN91',
    'retry-phase OC2 holds A at 136000 over host retry false',
    async () => {
      const input = facts([window('5h', 120_000)], {
        host: 'opencode2',
        hostPhase: 'retry',
        remainingRetries: 1,
      })
      const decision = decideAfterLimit(input, confirmedAffinity)
      decisionIs(decision, held(136_000))
      const fixture = await installerFixture(() => {
        if (decision.action !== 'hold') throw new Error('Expected hold')
        return {
          hold: {
            delayMs: decision.delayMs,
            target: decision.target,
            checkpoint: decision.checkpoint,
          },
        }
      })
      try {
        await fixture.send()
        expect((await fixture.retry({ retry: false })).decision).toEqual({
          retry: true,
          delay: 136_000,
        })
        expect(fixture.choices.map((input) => input.phase)).toEqual([
          'request',
          'retry',
        ])
        expect(fixture.choices[1]?.previousAccountId).toBe('A')
      } finally {
        await fixture.auth.dispose()
      }
    },
  )

  vector(
    'AN92',
    'recorded OC2 unknown quota reroutes B at delay 0, not OC1 retain',
    async () => {
      // Before bc06ec4a added per-turn retry budgets, anthropic-auth used this
      // uncounted OC2 path. Counted rows describe its current behavior;
      // anthropic-auth must supply the count when adopting it.
      const decision = decideAfterLimit(
        facts([], {
          host: 'opencode2',
          hostPhase: 'retry',
          remainingRetries: 1,
        }),
        confirmedAffinity,
      )
      decisionIs(decision, reroute)
      const fixture = await installerFixture(() => {
        if (decision.action !== 'reroute') throw new Error('Expected reroute')
        return decision.account.accountId
      })
      try {
        await fixture.send()
        expect(
          (await fixture.retry({ retry: true, delay: 1234 })).decision,
        ).toEqual({ retry: true, delay: 0 })
      } finally {
        await fixture.auth.dispose()
      }
    },
  )

  vector(
    'AN93',
    'ambiguous mixed-credential session passes to host without delay or account override',
    () => {
      decisionIs(
        decideAfterLimit(
          facts([window('5h', 120_000)], {
            host: 'opencode2',
            hostPhase: 'retry',
            remainingRetries: 1,
            delivery: { owned: false, attributable: false, replayable: true },
          }),
          confirmedAffinity,
        ),
        { action: 'pass', reason: 'not-owned' },
      )
    },
  )

  vector(
    'AN94',
    'undefined OC2 retry choice leaves host delay 1234 and pin unchanged',
    async () => {
      decisionIs(
        decideAfterLimit(
          facts([], {
            host: 'opencode2',
            hostPhase: 'retry',
            remainingRetries: 1,
            signal: undefined,
            candidates: [candidate(A)],
            selection: undefined,
          }),
          confirmedAffinity,
        ),
        { action: 'pass', reason: 'unhandled-failure' },
      )
      const fixture = await installerFixture(() => undefined)
      try {
        await fixture.send()
        expect(
          (await fixture.retry({ retry: true, delay: 1234 })).decision,
        ).toEqual({ retry: true, delay: 1234 })
        expect(fixture.choices[1]?.previousAccountId).toBe('A')
      } finally {
        await fixture.auth.dispose()
      }
    },
  )

  vector(
    'AN99',
    'decided Pi wait 616000 then recheck and send A; no immediate HTTP429 error event',
    () => {
      const trace = runFakeClockDriver({
        axes: confirmedAffinity,
        now,
        clockNow: 1000,
        history: facts().history,
        readFacts: (state) =>
          state.event.type === 'sent'
            ? undefined
            : facts([window('5h', 600_000)], {
                host: 'pi',
                candidates: [
                  candidate(A, {
                    ready: false,
                    confirmedBlockers: [window('5h', 600_000)],
                  }),
                  candidate(B),
                ],
              }),
      })
      expect(trace.stop).toBe('sent')
      expect(trace.sleeps).toEqual([{ now, clockNow: 1000, delayMs: 616_000 }])
      expect(trace.sends).toEqual([
        { now: now + 616_000, clockNow: 617_000, account: A },
      ])
      expect(trace.decisions).toHaveLength(2)
      decisionIs(trace.decisions[0]!.decision, held(616_000))
      decisionIs(trace.decisions[1]!.decision, {
        action: 'retain',
        account: A,
        reason: 'wait-elapsed',
      })
    },
  )

  vector(
    'AN100',
    'recorded Pi unknown limit passes original multi-day hints, no normalized timer or wait',
    () => {
      // Before bc06ec4a added per-turn retry budgets, anthropic-auth used this
      // uncounted Pi path. Counted rows describe its current behavior;
      // anthropic-auth must supply the count when adopting it.
      for (const retryHintsMs of [[432_000_000], [1500, 432_000_000]]) {
        decisionIs(
          decideAfterLimit(
            facts([], { host: 'pi', retryHintsMs }),
            confirmedAffinity,
          ),
          {
            action: 'pass',
            reason: 'unconfirmed-limit',
          },
        )
      }
    },
  )

  for (const [id, resetMs, expected] of [
    ['AN03', 600_000, reroute],
    ['AN06', 1, held(17_000)],
    ['AN91', 120_000, held(136_000)],
  ] as const) {
    vector(
      id,
      `unknown TTL means 300000 cache: ${expected.action} at ${expected.delayMs ?? 0}`,
      () => {
        decisionIs(
          decideAfterLimit(
            facts([window('5h', resetMs)], {
              hold: cacheBound(),
              ...(id === 'AN91'
                ? { host: 'opencode2', hostPhase: 'retry', remainingRetries: 1 }
                : {}),
            }),
            confirmedAffinity,
          ),
          expected,
        )
      },
    )
  }
})

async function installerFixture(
  choose: (input: ChooseAccountInput) => ChooseAccountResult,
) {
  const host = fakeHost()
  const choices: ChooseAccountInput[] = []
  const adapter: OpenCode2AuthAdapter<TestQuota, unknown, ChooseAccountResult> =
    {
      ...fakeAdapter().adapter,
      chooseAccount(input) {
        choices.push(input)
        return input.phase === 'request' ? 'A' : choose(input)
      },
      limitFromError: () => ({ reason: 'quota', status: 429 }),
    }
  const auth = await installOpenCode2Auth(host.ctx, adapter)
  const send = async () => {
    const model = await host.fire('model.request', {
      ...scopeFor(),
      headers: {} as Record<string, string>,
    })
    return host.fire('http.request', {
      ...scopeFor(),
      request: new Request('https://provider.invalid/v1/messages', {
        headers: {
          ...model.headers,
          authorization: `Bearer ${placeholderSecret(PROVIDER)}`,
        },
      }),
    })
  }
  const retry = (decision: { retry: boolean; delay?: number }) =>
    host.fire('retry', {
      ...scopeFor(),
      attempt: 1,
      error: { type: 'provider.unknown', message: 'quota' },
      decision,
    })
  return { auth, host, choices, send, retry }
}

function holdResponse(decision: LimitDecision) {
  if (decision.action !== 'hold') throw new Error('Expected hold')
  const response = buildRefusal({
    family: 'claude-429',
    messageKey: 'affinity.hold',
    messages: registerLimitMessages({
      retryable: {
        'affinity.hold': () =>
          'Sticky OAuth account quota resets shortly; retaining session affinity.',
      },
    }),
    now,
    retryAfterMs: decision.retryAfterMs,
  })
  if (response.kind !== 'http') throw new Error('Expected HTTP refusal')
  expect(response.status).toBe(429)
  expect(response.retryable).toBe(true)
  expect(response.hostRetry).toBe('leave')
  return response
}

function scan(resetMs?: number): TerminalScanFacts {
  return {
    candidates: [
      {
        account: A,
        readingAccount: A,
        windows: [
          {
            window: '5h',
            scope: { kind: 'pool' },
            blockedBy: 'exhausted',
            ...(resetMs === undefined
              ? {}
              : { reset: { at: now + resetMs, observedAt: now } }),
          },
        ],
      },
    ],
    effectiveModel: scope.model,
    familyOf: () => 'claude',
    maxAgeMs: 60_000,
    maxSameAccountWait: 15,
    accountKey: A,
  }
}

function noRoute(terminal: NonNullable<PolicyFacts['terminal']>) {
  return facts([], {
    candidates: [],
    selection: undefined,
    signal: undefined,
    terminal,
  })
}

const quotaRefusal = (retryAfterMs: number): ExpectedDecision => ({
  action: 'refuse',
  reason: 'quota',
  family: 'claude-429',
  messageKey: 'quota.all-accounts',
  retryAfterMs,
})

function quotaWire(
  decision: LimitDecision,
  messages?: ReturnType<typeof registerLimitMessages>,
) {
  if (decision.action !== 'refuse' || decision.family !== 'claude-429')
    throw new Error('Expected Claude quota refusal')
  const response = buildRefusal({
    family: decision.family,
    messageKey: decision.messageKey,
    retryAfterMs: decision.retryAfterMs,
    resetAt: decision.resetAt,
    now,
    messages,
  })
  if (response.kind !== 'http') throw new Error('Expected HTTP refusal')
  expect(response.status).toBe(429)
  expect(response.retryable).toBe(true)
  expect(response.hostRetry).toBe('leave')
  expect(response.headers.get('content-type')).toBe('application/json')
  return response
}

describe('confirmed-affinity terminal conformance', () => {
  vector(
    'AN04',
    'decided no-B terminal refusal has Retry-After 900, not a 916000 hold',
    () => {
      const decision = decideAfterLimit(
        facts([window('7d', 900_000)], {
          candidates: [candidate(A, { ready: false })],
          selection: undefined,
          terminal: { source: 'pool', reason: 'quota', scan: scan(900_000) },
        }),
        confirmedAffinity,
      )
      decisionIs(decision, quotaRefusal(900_000))
      expect(quotaWire(decision).headers.get('retry-after')).toBe('900')
    },
  )

  for (const [id, name] of [
    [
      'AN48',
      'missing snapshot gives retryable incomplete error before terminal auth/quota',
    ],
    [
      'AN49',
      'stale snapshot or incomplete empty roster gives retryable incomplete error',
    ],
  ] as const) {
    vector(id, name, () => {
      const decision = decideAfterLimit(
        noRoute({ source: 'pool', reason: 'incomplete' }),
        confirmedAffinity,
      )
      decisionIs(decision, {
        action: 'refuse',
        reason: 'incomplete',
        family: 'claude-econnreset',
        messageKey: 'incomplete.snapshot',
      })
      if (
        decision.action !== 'refuse' ||
        decision.family !== 'claude-econnreset'
      )
        throw new Error('Expected incomplete refusal')
      const response = buildRefusal({
        family: decision.family,
        messageKey: decision.messageKey,
        messages: registerLimitMessages({
          retryable: {
            'incomplete.snapshot': () =>
              'Sticky-balanced routing is waiting for current OAuth quota snapshots',
          },
        }),
        now,
      })
      expect(response.kind).toBe('throw')
      if (response.kind !== 'throw') throw new Error('Expected thrown refusal')
      expect(response.error).toMatchObject({
        message:
          'Sticky-balanced routing is waiting for current OAuth quota snapshots',
        code: 'ECONNRESET',
        syscall: 'sticky-routing',
      })
      expect(response.retryable).toBe(true)
      expect(response.hostRetry).toBe('leave')
    })
  }

  // Main/fallback authentication precedence and labels are resolved by the
  // plugin. Only the routing decision is shared: no invented HTTP text or retry hint.
  for (const [id, name] of [
    ['AN50', 'L6-only main permanent auth wins over fallback labels, unscoped'],
    ['AN51', 'L6-only main permanent auth, matched Fable scope'],
    ['AN52', 'L6-only fallback re-login work/backup, unscoped'],
    ['AN53', 'L6-only fallback re-login ufuk2/yiyi, matched Fable scope'],
  ] as const) {
    vector(id, name, () => {
      decisionIs(
        decideAfterLimit(
          noRoute({ source: 'pool', reason: 'auth' }),
          confirmedAffinity,
        ),
        {
          action: 'refuse',
          reason: 'auth',
          family: 'local-auth',
          messageKey: 'auth.no-account',
          retryable: false,
        },
      )
    })
  }

  vector(
    'AN54',
    'fresh pool reset +10m refuses with 600000, no old 60s pad',
    () => {
      const decision = decideAfterLimit(
        noRoute({ source: 'pool', reason: 'quota', scan: scan(600_000) }),
        confirmedAffinity,
      )
      decisionIs(decision, quotaRefusal(600_000))
      const response = quotaWire(decision)
      expect(response.headers.get('retry-after')).toBe('600')
      expect(response.body).toBe(
        '{"type":"error","error":{"type":"rate_limit_error","message":"No account is available. Retry in 10m. Reset at 10m."}}',
      )
    },
  )

  vector(
    'AN55',
    'decided new rendering: Retry in 5m. The reset is unknown.',
    () => {
      for (const resetMs of [undefined, Number.NaN, 0, -1]) {
        const decision = decideAfterLimit(
          noRoute({ source: 'pool', reason: 'quota', scan: scan(resetMs) }),
          confirmedAffinity,
        )
        decisionIs(decision, quotaRefusal(300_000))
        const response = quotaWire(decision)
        expect(response.headers.get('retry-after')).toBe('300')
        expect(response.body).toBe(
          '{"type":"error","error":{"type":"rate_limit_error","message":"No account is available. Retry in 5m. The reset is unknown."}}',
        )
      }
    },
  )

  vector(
    'AN56',
    'scoped Fable reset +96h caps retry at 900000, retains true reset',
    () => {
      const terminalScan: TerminalScanFacts = {
        ...scan(),
        candidates: [
          {
            account: A,
            readingAccount: A,
            windows: [
              {
                window: 'scoped:fable',
                scope,
                blockedBy: 'exhausted',
                reset: { at: now + 345_600_000, observedAt: now },
              },
            ],
          },
        ],
      }
      const decision = decideAfterLimit(
        noRoute({ source: 'pool', reason: 'quota', scan: terminalScan }),
        confirmedAffinity,
      )
      decisionIs(decision, quotaRefusal(900_000))
      if (decision.action !== 'refuse') throw new Error('Expected refusal')
      expect(decision.resetAt).toBe(now + 345_600_000)
      const response = quotaWire(decision)
      expect(response.headers.get('retry-after')).toBe('900')
      expect(response.body).toBe(
        '{"type":"error","error":{"type":"rate_limit_error","message":"No account is available. Retry in 15m. Reset at 4d 0h 0m."}}',
      )
    },
  )

  vector(
    'AN57',
    'changes on adoption: enabled vault reauth precedes quota, recorded text byte-for-byte',
    () => {
      const decision = decideAfterLimit(
        noRoute({ source: 'vault', reason: 'auth' }),
        confirmedAffinity,
      )
      decisionIs(decision, {
        action: 'refuse',
        reason: 'auth',
        family: 'local-auth',
        messageKey: 'auth.no-account',
        retryable: false,
      })
      if (decision.action !== 'refuse') throw new Error('Expected refusal')
      // The plugin throws its own auth error for local-auth. Exercise its recorded
      // message registration without inventing a library HTTP auth envelope.
      const messages = registerLimitMessages({
        refusals: {
          'auth.no-account': () =>
            'No vault account can serve this request. Open /claude to see which account needs signing in again.',
        },
      })
      expect(
        messages.render(
          decision.messageKey,
          { labels: [] },
          !decision.retryable,
        ),
      ).toBe(
        'No vault account can serve this request. Open /claude to see which account needs signing in again.',
      )
    },
  )

  for (const [id, label, delayMs, expectedBody] of [
    [
      'AN58',
      'quota floor',
      300_000,
      '{"type":"error","error":{"type":"rate_limit_error","message":"No vault account currently satisfies quota policy: quota floor. Open /claude → Killswitch / Quota to change these limits. Retry in 5m 0s."}}',
    ],
    [
      'AN59',
      'killswitch limit',
      300_000,
      '{"type":"error","error":{"type":"rate_limit_error","message":"No vault account currently satisfies quota policy: killswitch limit. Open /claude → Killswitch / Quota to change these limits. Retry in 5m 0s."}}',
    ],
    [
      'AN60',
      'Opus scoped limit',
      180_000,
      '{"type":"error","error":{"type":"rate_limit_error","message":"No vault account currently satisfies quota policy: Opus scoped limit. Open /claude → Killswitch / Quota to change these limits. Retry in 3m 0s."}}',
    ],
  ] as const) {
    vector(
      id,
      `changes on adoption: vault ${label}, recorded text byte-for-byte`,
      () => {
        const messages = registerLimitMessages({
          retryable: {
            'quota.all-accounts': ({ retryIn }) =>
              `No vault account currently satisfies quota policy: ${label}. Open /claude → Killswitch / Quota to change these limits. Retry in ${retryIn} 0s.`,
          },
        })
        for (const setting of [0, 15, 'max'] as const) {
          const decision = decideAfterLimit(
            noRoute({
              source: 'vault',
              reason: 'quota',
              retryAfterMs: delayMs,
              scan: { ...scan(), maxSameAccountWait: setting },
            }),
            confirmedAffinity,
          )
          decisionIs(decision, quotaRefusal(delayMs))
          const response = quotaWire(decision, messages)
          expect(response.body).toBe(expectedBody)
          expect(response.headers.get('retry-after')).toBe(
            String(delayMs / 1000),
          )
        }
      },
    )
  }
})

describe('confirmed-affinity counted unconfirmed retries', () => {
  const limitedReroute = { ...reroute, reason: 'unconfirmed-retry-limit' }

  function retry(
    counter: UnconfirmedRetainCounter,
    patch: Partial<PolicyFacts> = {},
    turnId = 'billing-prompt-id',
  ) {
    const input = facts([], patch)
    const account = input.attempted ?? A
    const decision = decideAfterLimit(
      {
        ...input,
        unconfirmedRetainCount: counter.count(input.sessionId, turnId, account),
      },
      confirmedAffinity,
    )
    if (decision.action === 'retain' && decision.incrementUnconfirmedRetain)
      counter.increment(input.sessionId, turnId, account)
    return decision
  }

  vector(
    'AN101',
    'first and second unconfirmed retains commit only on execution',
    () => {
      const counter = new UnconfirmedRetainCounter()
      const input = facts([], { unconfirmedRetainCount: 0 })
      const first = decideAfterLimit(input, confirmedAffinity)
      decisionIs(first, retain())
      expect(first).toHaveProperty('incrementUnconfirmedRetain', true)
      expect(decideAfterLimit(input, confirmedAffinity)).toEqual(first)
      expect(counter.count('session-a', 'billing-prompt-id', A)).toBe(0)
      decisionIs(retry(counter), retain())
      decisionIs(retry(counter), retain())
      expect(counter.count('session-a', 'billing-prompt-id', A)).toBe(2)
    },
  )

  vector(
    'AN102',
    'third unconfirmed 429 reroutes with unconfirmed-retry-limit',
    () => {
      decisionIs(
        decideAfterLimit(
          facts([], { unconfirmedRetainCount: 2 }),
          confirmedAffinity,
        ),
        limitedReroute,
      )
    },
  )

  vector(
    'AN103',
    'confirmed holds and migrations do not consume retains',
    () => {
      const counter = new UnconfirmedRetainCounter()
      for (const resetMs of [120_000, 86_400_000]) {
        const input = facts([window('5h', resetMs)])
        const decision = retry(counter, input)
        decisionIs(decision, resetMs === 120_000 ? held(136_000) : reroute)
        expect(decision).not.toHaveProperty('incrementUnconfirmedRetain')
      }
      expect(counter.count('session-a', 'billing-prompt-id', A)).toBe(0)
      decisionIs(retry(counter), retain())
      decisionIs(retry(counter), retain())
      decisionIs(retry(counter), limitedReroute)
    },
  )

  vector(
    'AN104',
    'a move clears the budget even when returning to the same account',
    () => {
      const counter = new UnconfirmedRetainCounter()
      retry(counter)
      retry(counter)
      decisionIs(retry(counter), limitedReroute)
      counter.clear('session-a')
      decisionIs(retry(counter), retain())
      decisionIs(retry(counter), retain())
      decisionIs(retry(counter), limitedReroute)
    },
  )

  vector(
    'AN105',
    'a different account in the same turn has a fresh budget',
    () => {
      const counter = new UnconfirmedRetainCounter()
      retry(counter)
      retry(counter)
      const patch = {
        attempted: B,
        signal: undefined,
        selection: { account: A, pin: 'pin' as const },
      }
      for (let attempt = 0; attempt < 2; attempt++)
        decisionIs(retry(counter, patch), { ...retain(), account: B })
      decisionIs(retry(counter, patch), { ...limitedReroute, account: A })
    },
  )

  vector(
    'AN106',
    'a new turn resets the budget without disturbing another session',
    () => {
      const counter = new UnconfirmedRetainCounter()
      retry(counter)
      retry(counter)
      retry(counter, { sessionId: 'other-session' })
      decisionIs(retry(counter, {}, 'next-prompt-id'), retain())
      decisionIs(retry(counter, {}, 'next-prompt-id'), retain())
      decisionIs(retry(counter, {}, 'next-prompt-id'), limitedReroute)
      decisionIs(retry(counter, { sessionId: 'other-session' }), retain())
      decisionIs(retry(counter, { sessionId: 'other-session' }), limitedReroute)
    },
  )

  for (const [id, host, turnId] of [
    ['AN107', 'opencode2', 'requestOptions.billingLineage.promptId'],
    ['AN108', 'pi', '1700000000000'],
  ] as const) {
    vector(
      id,
      `${host} counts across logical requests in the same user turn`,
      () => {
        const counter = new UnconfirmedRetainCounter()
        for (let request = 0; request < 3; request++) {
          const decision = retry(
            counter,
            {
              host,
              hostPhase: 'retry',
              remainingRetries: 1,
              retryHintsMs: [432_000_000],
              history: createRequestHistory({
                requestId: `logical-request-${request}`,
                originalUrl: '/v1/messages',
                clockNow: 1000 + request,
              }),
            },
            turnId,
          )
          decisionIs(decision, request < 2 ? retain() : limitedReroute)
        }
      },
    )
  }

  vector(
    'AN109',
    'counted waits cap at 60s and preserve shorter finite hints including zero',
    () => {
      for (const [hints, signalHint, expected] of [
        [[], undefined, 60_000],
        [[432_000_000], undefined, 60_000],
        [[432_000_000, 2000, Number.NaN], undefined, 2000],
        [[60_000], 1500, 1500],
        [[-1000], undefined, 0],
        [[Number.POSITIVE_INFINITY, Number.NaN], 0, 0],
      ] as const) {
        const input = facts([], {
          unconfirmedRetainCount: 0,
          retryHintsMs: hints,
        })
        decisionIs(
          decideAfterLimit(
            {
              ...input,
              signal: { ...input.signal!, retryAfterMs: signalHint },
            },
            confirmedAffinity,
          ),
          retain(expected),
        )
      }
    },
  )

  vector(
    'AN110',
    'exhausted budget never retains when no replacement is ready',
    () => {
      const decision = decideAfterLimit(
        facts([], {
          unconfirmedRetainCount: 2,
          candidates: [candidate(A)],
          selection: undefined,
        }),
        confirmedAffinity,
      )
      expect(decision.action).toBe('refuse')
      expect(decision).not.toHaveProperty('incrementUnconfirmedRetain')
    },
  )
})

test('confirmed-affinity executed R coverage plus B boundaries accounts for AN 110', () => {
  const rows = conformanceRows.filter(
    (row) => row.preset === 'confirmed-affinity',
  )
  const covered = new Set(anthropicVectorResults.map((result) => result.rowId))
  const excluded = new Set(conformanceExclusions.map((entry) => entry.rowId))
  expect(
    rows
      .filter(
        (row) =>
          row.status === 'R' && !covered.has(row.id) && !excluded.has(row.id),
      )
      .map((row) => row.id),
  ).toEqual([])
  expect({
    rCovered: rows.filter((row) => row.status === 'R' && covered.has(row.id))
      .length,
    rExcluded: rows.filter((row) => row.status === 'R' && excluded.has(row.id))
      .length,
    bRows: rows.filter((row) => row.status === 'B').length,
    dWitnesses: rows.filter((row) => row.status === 'D').length,
    total: rows.length,
  }).toEqual({
    rCovered: 58,
    rExcluded: 0,
    bRows: 52,
    dWitnesses: 0,
    total: 110,
  })
})
