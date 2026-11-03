import { afterAll, describe, expect, test } from 'bun:test'
import {
  acquireLimitsRegistry,
  applyLimitsCommands,
  buildRefusal,
  classifyHeaders,
  classifyRetryAfter,
  clearLimitsAfterProbe,
  createLimitsNamespace,
  createRequestHistory,
  decideAfterLimit,
  type IdentityBinding,
  type LimitDecision,
  type LimitMarkCause,
  type LimitSignal,
  type LimitsCommand,
  type LimitsNamespace,
  markFromSignal,
  markIsActive,
  marksAfterSuccess,
  mergeTimedMarkEntries,
  type PersistenceAdapter,
  type PolicyFacts,
  reduceFailureHistory,
  reduceRequestHistory,
  sameAccountHoldFacts,
  scopeCovers,
  statusVaultOrder,
  toOpenCode2LimitSignal,
} from '../../../src/limits/index.js'
import {
  installOpenCode2Auth,
  placeholderSecret,
} from '../../../src/opencode2/index.js'
import {
  fakeAdapter,
  fakeHost,
  PROVIDER,
  scopeFor,
} from '../../opencode2/fake-host.js'
import { limitsFixtureAdapter } from '../../opencode2/limits-fixture-adapter.js'
import { conformanceRows, type VectorResult } from './rows.js'

// CL cases cover retry hints, overwrite marks, vault-order routing and host
// retry safety. WS parsing remains plugin-owned: installer fixtures replay
// recorded inspector verdicts instead of implementing a provider parser.
const now = Date.UTC(2026, 10, 1)
const pool = { kind: 'pool' } as const
const A = {
  namespace: 'claustrum-conformance',
  accountId: 'A',
  incarnation: 'one',
}
const B = { ...A, accountId: 'B' }
const settings = [0, 15, 'max'] as const
export const claustrumConformanceResults: VectorResult[] = []
let sequence = 0

function classify(
  headers: ConstructorParameters<typeof Headers>[0] = {},
  status = 429,
) {
  return classifyRetryAfter({
    account: A,
    status,
    headers: new Headers(headers),
    effectiveModel: 'model-a',
    readings: [],
    now,
  })
}
function marker(
  s: LimitSignal | undefined,
  host: 'opencode1' | 'opencode2' = 'opencode1',
  markerNow = now,
) {
  const failures = reduceFailureHistory(new Map(), {
    type: 'failure',
    account: A,
    at: now,
  })
  const result = markFromSignal(s, statusVaultOrder.markers[host], {
    now: markerNow,
    failures,
  })
  const afterSuccess = reduceFailureHistory(failures, {
    type: 'success',
    account: A,
  })
  expect(afterSuccess.size).toBe(0)
  if (result) {
    expect(result.scope).toEqual(pool)
    expect(result.mergeLaw).toBe('overwrite')
  }
  return result
}
function ready(account = A) {
  return {
    account,
    admitted: true,
    placementEligible: true,
    ready: true,
    blockers: [],
  }
}
function facts(
  setting: (typeof settings)[number],
  changes: Partial<PolicyFacts> = {},
): PolicyFacts {
  return {
    phase: 'after-limit',
    host: 'opencode1',
    now,
    clockNow: 0,
    sessionId: 'session-a',
    requestScope: pool,
    history: createRequestHistory({
      requestId: 'request-a',
      originalUrl: 'https://provider.invalid/responses',
      clockNow: 0,
    }),
    attempted: A,
    status: 429,
    delivery: { owned: true, attributable: true, replayable: true },
    candidates: [ready(A), ready(B)],
    selection: { account: B, pin: 'preserve' },
    hold: sameAccountHoldFacts({
      accountKey: A,
      maxSameAccountWait: setting,
      activity: { accountKey: A, lastAcceptedAt: now, ttlMs: 3600000 },
    }),
    ...changes,
  }
}
function view(decision: LimitDecision) {
  return Object.fromEntries(
    [
      'action',
      'account',
      'delayMs',
      'retryMs',
      'reason',
      'family',
      'messageKey',
      'retryAfterMs',
      'retryable',
      'hostRetry',
    ].map((key) => [key, Reflect.get(decision, key)]),
  )
}
function expected(
  action: string,
  reason: string,
  extra: Record<string, unknown> = {},
) {
  return {
    action,
    account: undefined,
    delayMs: undefined,
    retryMs: undefined,
    reason,
    family: undefined,
    messageKey: undefined,
    retryAfterMs: undefined,
    retryable: true,
    hostRetry: 'leave',
    ...extra,
  }
}

// The adopter confirms balance from provider evidence; common-auth consumes only
// that typed signal. No provider response parser is reproduced by these vectors.
function payment(account = A, retryAfterMs?: number): LimitSignal {
  return {
    account,
    kind: 'payment-balance',
    reason: 'payment-required',
    status: 402,
    scope: pool,
    windows: [],
    observedAt: now,
    retryAfterMs,
  }
}
function blocked(account = A, cause?: LimitMarkCause, until = now + 300000) {
  return {
    ...ready(account),
    ready: false,
    blockers: [{ kind: 'hard' as const, until, ...(cause ? { cause } : {}) }],
  }
}
function paymentWire(decision: LimitDecision, retry: string) {
  expect(decision).toMatchObject({
    action: 'refuse',
    family: 'claustrum-402',
    messageKey: 'payment.insufficient-balance',
    hostRetry: 'leave',
  })
  if (decision.action !== 'refuse' || decision.family !== 'claustrum-402')
    throw new Error('not payment')
  const wire = buildRefusal({
    ...decision,
    family: decision.family,
    now,
    parameters: { labels: ['private-account@example.invalid'] },
  })
  expect(wire).toMatchObject({
    kind: 'http',
    status: 402,
    body: '{"error":"claustrum-auth: insufficient balance"}',
    hostRetry: 'leave',
  })
  if (wire.kind !== 'http') throw new Error('not http')
  expect([...wire.headers]).toEqual([
    ['content-type', 'application/json'],
    ['retry-after', retry],
  ])
}

function registryFixture() {
  let time = now
  let snapshot: LimitsNamespace = createLimitsNamespace(
    `${A.namespace}-${++sequence}`,
    'generation',
  )
  const account = { ...A, namespace: snapshot.namespace }
  const binding: IdentityBinding = { account, credentialEpoch: 'epoch' }
  const context = () => ({
    now: time,
    bindings: [binding],
    authorizeEpoch: () => true,
  })
  const adapter: PersistenceAdapter = {
    namespace: snapshot.namespace,
    async read() {
      return { snapshot, bindings: [binding], authoritative: true }
    },
    async commit(commands) {
      const result = applyLimitsCommands(snapshot, commands, context())
      snapshot = result.snapshot
      return { ...result, bindings: [binding], authoritative: true }
    },
  }
  const acquire = () =>
    acquireLimitsRegistry({
      adapter,
      isAccessRestrictive: () => false,
      clock: { now: () => time, setTimeout: () => 0, clearTimeout: () => {} },
    })
  const command = (
    operationId: string,
    cause: LimitMarkCause = 'payment-balance',
    until = now + 300000,
  ): LimitsCommand => ({
    type: 'mark',
    producerId: 'payment-test',
    operationId,
    binding,
    baseRevision: snapshot.revision,
    scope: pool,
    window: 'requests',
    mergeLaw: 'overwrite',
    evidenceAt: time,
    until,
    cause,
  })
  return {
    adapter,
    acquire,
    binding,
    command,
    setTime: (at: number) => {
      time = at
    },
    get snapshot() {
      return snapshot
    },
  }
}

for (const setting of settings)
  describe(`status-vault-order maxSameAccountWait=${setting}`, () => {
    function vector(
      id: number,
      name: string,
      check: () => unknown | Promise<unknown>,
    ) {
      const rowId = `CL-${id}`,
        fullName = `${rowId} ${name} [${setting}]`
      test(fullName, async () => {
        await check()
        claustrumConformanceResults.push({
          rowId,
          preset: 'status-vault-order',
          name: fullName,
          status: 'passed',
        })
      })
    }
    vector(1, 'marker numeric 17s hint; no wait is inferred', () => {
      const s = classify({ 'Retry-After': '17' })!
      expect(s).toMatchObject({
        status: 429,
        reason: 'rate-limit',
        retryAfterMs: 17000,
        scope: pool,
      })
      expect(s.windows[0]?.confirmed).toBe(false)
      for (const host of ['opencode1', 'opencode2'] as const)
        expect(marker(s, host)?.until).toBe(now + 17000)
    })
    vector(
      2,
      'marker zero means immediately inactive, never default sixty seconds',
      () => {
        const s = classify({ 'Retry-After': '0' })!
        expect(s.retryAfterMs).toBe(0)
        for (const host of ['opencode1', 'opencode2'] as const) {
          const mark = marker(s, host)!
          expect(mark.until).toBe(now)
          expect(markIsActive(mark, now)).toBe(false)
        }
      },
    )
    vector(
      3,
      'marker date distinguishes classifier and OC2 event clocks',
      () => {
        const s = classify({
          'Retry-After': new Date(now + 17000).toUTCString(),
        })!
        expect(s.retryAfterMs).toBe(17000)
        expect(marker(s, 'opencode1', now + 250)?.until).toBe(now + 17000)
        expect(marker(s, 'opencode2', now + 250)?.until).toBe(now + 17250)
      },
    )
    vector(4, 'marker absent blank invalid and nonfuture dates default', () => {
      for (const value of [
        undefined,
        '',
        'invalid',
        new Date(now).toUTCString(),
        new Date(now - 1000).toUTCString(),
      ]) {
        const s = classify(value === undefined ? {} : { 'Retry-After': value })!
        expect(s.retryAfterMs).toBeUndefined()
        for (const host of ['opencode1', 'opencode2'] as const)
          expect(marker(s, host)?.until).toBe(now + 60000)
      }
    })
    vector(
      5,
      'L1 generic headers stay opt-in; other sources cannot extend CL mark',
      () => {
        const input = {
          account: A,
          status: 429,
          headers: new Headers({
            'retry-after-ms': '180000',
            'x-ratelimit-reset-requests': '2h',
          }),
          body: { resetAt: now + 7200000 },
          effectiveModel: 'model-a',
          now,
          readings: [
            {
              window: 'quota',
              confirmed: true,
              confirmedByReading: true,
              resetAt: now + 7200000,
              observedAt: now,
              provenance: 'cache',
            },
          ],
        }
        expect(classifyHeaders(input)?.retryAfterMs).toBe(7200000)
        const s = classifyRetryAfter(input)!
        expect(s.retryAfterMs).toBeUndefined()
        expect(
          s.windows.every((w) => !w.confirmed && !w.confirmedByReading),
        ).toBe(true)
        expect(marker(s)?.until).toBe(now + 60000)
      },
    )
    vector(6, 'L1 401 supplies no exhaustion signal or mark', () => {
      expect(classify({}, 401)).toBeUndefined()
      expect(marker(classify({}, 401))).toBeUndefined()
    })
    vector(7, 'L6 402/403 are not advance or quota signals', () => {
      for (const status of [402, 403]) {
        expect(classify({ 'Retry-After': '17' }, status)).toBeUndefined()
        expect(
          view(decideAfterLimit(facts(setting, { status }), statusVaultOrder)),
        ).toEqual(expected('pass', 'unhandled-failure'))
      }
    })
    for (const id of [8, 9])
      vector(
        id,
        'marker WS parsed rate-limit verdict ignores frame reset hints',
        () => {
          // The plugin's frame inspector supplies only reason/status to the
          // shared classifier; retry/reset fields are not parsed signal facts.
          const s: LimitSignal = {
            account: A,
            kind: 'rate-limit',
            reason: 'rate-limit',
            status: 429,
            scope: pool,
            observedAt: now,
            windows: [],
          }
          expect(s.retryAfterMs).toBeUndefined()
          expect(marker(s, 'opencode2')?.until).toBe(now + 60000)
        },
      )
    for (const [id, host] of [
      [10, 'opencode1'],
      [11, 'opencode2'],
    ] as const)
      vector(
        id,
        'marker overwrite supersedes a longer deadline including zero',
        () => {
          for (const [value, until] of [
            ['17', now + 17000],
            ['0', now],
            [undefined, now + 60000],
          ] as const) {
            const mark = marker(
              classify(value === undefined ? {} : { 'Retry-After': value }),
              host,
            )!
            const entries = mergeTimedMarkEntries(
              mark.mergeLaw,
              [
                {
                  until: now + 120000,
                  evidenceAt: now,
                  baseRevision: 0,
                  committedRevision: 1,
                },
                {
                  until: mark.until,
                  evidenceAt: now,
                  baseRevision: 1,
                  committedRevision: 2,
                },
              ],
              now,
            )
            expect(entries.map((e) => e.until)).toEqual(
              until === now ? [] : [until],
            )
            expect(
              mergeTimedMarkEntries(mark.mergeLaw, entries, until),
            ).toEqual([])
          }
        },
      )
    vector(
      12,
      'marker expiry equality permits placement without deletion',
      () => {
        const mark = marker(classify({ 'Retry-After': '17' }))!
        expect(
          [16999, 17000, 17001].map((d) => markIsActive(mark, now + d)),
        ).toEqual([true, false, false])
        expect(mark.until).toBe(now + 17000)
      },
    )
    vector(
      14,
      'B success leaves A timed mark; success history resets independently',
      () => {
        const mark = marker(classify({ 'Retry-After': '17' }))!
        const failures = reduceFailureHistory(new Map(), {
          type: 'failure',
          account: A,
          at: now,
        })
        expect(
          reduceFailureHistory(failures, { type: 'success', account: B }),
        ).toEqual(failures)
        expect(
          marksAfterSuccess(
            [mark],
            statusVaultOrder,
            'model-a',
            () => 'family',
          ),
        ).toEqual([mark])
        expect(statusVaultOrder.readingClearsCoveredScopes).toBe('off')
      },
    )
    vector(
      15,
      'D process-wide registry replaces setup instance isolation, not provider isolation',
      async () => {
        const namespace = `cl-${++sequence}`
        const binding: IdentityBinding = {
          account: { ...A, namespace },
          credentialEpoch: 'one',
        }
        let snapshot = createLimitsNamespace(namespace, 'generation')
        const adapter: PersistenceAdapter = {
          namespace,
          async read() {
            return { snapshot, bindings: [binding], authoritative: true }
          },
          async commit(commands) {
            const result = applyLimitsCommands(snapshot, commands, {
              now,
              bindings: [binding],
              authorizeEpoch: () => true,
            })
            snapshot = result.snapshot
            return { ...result, bindings: [binding], authoritative: true }
          },
        }
        const acquire = (persistence = adapter) =>
          acquireLimitsRegistry({
            adapter: persistence,
            isAccessRestrictive: () => false,
            clock: {
              now: () => now,
              setTimeout: () => Symbol(),
              clearTimeout() {},
            },
          })
        const first = await acquire(),
          second = await acquire({ ...adapter })
        const otherNamespace = `${namespace}:other-provider`
        const other = await acquire({
          ...adapter,
          namespace: otherNamespace,
          async read() {
            return {
              snapshot: createLimitsNamespace(otherNamespace, 'generation'),
              bindings: [],
              authoritative: true,
            }
          },
        })
        try {
          first.enqueue({
            ...first.observe(binding),
            producerId: 'fixture',
            operationId: 'mark',
            type: 'mark',
            scope: pool,
            window: 'retry',
            until: now + 17000,
            evidenceAt: now,
            mergeLaw: 'overwrite',
          })
          expect(second.pendingCommands).toBe(1)
          await first.flush()
          expect(second.snapshot.marks).toHaveLength(1)
          expect(other.snapshot.marks).toEqual([])
        } finally {
          await first.dispose()
          await second.dispose()
          await other.dispose()
        }
      },
    )
    vector(
      16,
      'pool scope covers all models and is independent of transport',
      () => {
        const http = marker(classify({ 'Retry-After': '17' }))!
        const ws = marker({ ...classify()!, windows: [] }, 'opencode2')!
        for (const model of ['claude-sonnet', 'gpt-a', 'gemini']) {
          expect(scopeCovers(http.scope, model, () => model)).toBe(true)
          expect(scopeCovers(ws.scope, model, () => model)).toBe(true)
        }
      },
    )

    for (const [id, status] of [
      [18, 429],
      [19, 401],
    ] as const)
      vector(id, 'L6 vault-order reroute(B), never wait for A', () => {
        for (const host of ['opencode1', 'pi'] as const) {
          const decision = decideAfterLimit(
            facts(setting, { host, status }),
            statusVaultOrder,
          )
          expect(view(decision)).toEqual(
            expected('reroute', 'ready-alternative', { account: B }),
          )
          expect(classify({}, status) === undefined).toBe(status === 401)
        }
      })
    for (const [id, status] of [
      [20, 429],
      [21, 401],
    ] as const)
      vector(
        id,
        'L6 no next route leaves original provider response with host',
        () => {
          for (const host of ['opencode1', 'pi'] as const)
            expect(
              view(
                decideAfterLimit(
                  facts(setting, {
                    host,
                    status,
                    candidates: [ready(A)],
                    selection: undefined,
                  }),
                  statusVaultOrder,
                ),
              ),
            ).toEqual(expected('pass', 'original-response'))
        },
      )

    function quota(changes: Partial<PolicyFacts>, retryAfterMs: number) {
      const decision = decideAfterLimit(
        facts(setting, changes),
        statusVaultOrder,
      )
      expect(view(decision)).toEqual(
        expected('refuse', 'quota', {
          family: 'claustrum-429',
          messageKey: 'quota.accounts-rate-limited',
          retryAfterMs,
        }),
      )
      const wire = buildRefusal({
        family: 'claustrum-429',
        messageKey: 'quota.accounts-rate-limited',
        now,
        retryAfterMs,
      })
      expect(wire.kind).toBe('http')
      if (wire.kind !== 'http') throw new Error('Expected HTTP refusal')
      expect(wire.status).toBe(429)
      expect(wire.body).toBe(
        '{"error":"claustrum-auth: accounts-rate-limited"}',
      )
      expect(wire.headers.get('retry-after')).toBe(
        String(Math.ceil(retryAfterMs / 1000)),
      )
      expect(wire.retryable).toBe(true)
      expect(wire.hostRetry).toBe('leave')
    }
    vector(22, 'L6 saw429 survives expired marks and terminal 401', () => {
      const history = reduceRequestHistory(facts(setting).history, {
        type: 'response',
        account: A,
        scope: pool,
        status: 429,
      })
      expect(history.saw429).toBe(true)
      quota(
        {
          status: 401,
          history,
          candidates: [
            {
              ...ready(A),
              ready: false,
              blockers: [{ kind: 'hard', until: now + 17000 }],
            },
          ],
          selection: undefined,
        },
        17000,
      )
      quota(
        { status: 401, history, candidates: [ready(A)], selection: undefined },
        60000,
      )
    })
    vector(
      23,
      'L6 all-marked nonempty roster uses earliest deadline eight seconds',
      () => {
        quota(
          {
            phase: 'pre-send',
            now: 1000,
            candidates: [
              {
                ...ready(A),
                ready: false,
                blockers: [{ kind: 'hard', until: 18000 }],
              },
              {
                ...ready(B),
                ready: false,
                blockers: [{ kind: 'hard', until: 9000 }],
              },
            ],
            selection: undefined,
          },
          8000,
        )
      },
    )
    vector(
      24,
      'L6 synthetic deadline ceil, one-second floor and sixty-second fallback',
      () => {
        const history = { ...facts(setting).history, saw429: true }
        for (const [delay, wanted] of [
          [250, 1000],
          [1250, 1250],
          [0, 60000],
        ] as const)
          quota(
            {
              history,
              status: 401,
              candidates: [
                {
                  ...ready(A),
                  ready: false,
                  blockers: [{ kind: 'hard', until: now + delay }],
                },
              ],
              selection: undefined,
            },
            wanted,
          )
      },
    )
    vector(
      26,
      'L6 unsignalled post-return stream failures stay with host, no explicit veto',
      () => {
        for (const host of ['opencode1', 'pi'] as const)
          expect(
            view(
              decideAfterLimit(
                facts(setting, {
                  host,
                  status: 200,
                  signal: undefined,
                }),
                statusVaultOrder,
              ),
            ),
          ).toEqual(expected('pass', 'unhandled-failure'))
      },
    )

    async function installerCase(
      mode:
        | 'reroute'
        | 'exhausted'
        | 'done'
        | 'unknown'
        | 'mixed'
        | 'foreign'
        | 'unsignalled'
        | 'dedup',
      unknownFrame = '{}',
    ) {
      const host = fakeHost(),
        headersRead: string[] = [],
        order: string[] = []
      let requestChoices = 0,
        feedback = 0,
        marked = false
      let release = () => {}
      const barrier = new Promise<void>((resolve) => {
        release = resolve
      })
      const bridge = limitsFixtureAdapter(
        () => {
          expect(marked).toBe(true)
          order.push('choose')
          return facts(setting, {
            host: 'opencode2',
            hostPhase: 'retry',
            signal: classify(),
            candidates:
              mode === 'exhausted'
                ? [
                    {
                      ...ready(A),
                      ready: false,
                      blockers: [{ kind: 'hard', until: now + 17000 }],
                    },
                  ]
                : [ready(A), ready(B)],
            selection:
              mode === 'exhausted'
                ? undefined
                : { account: B, pin: 'preserve' },
          })
        },
        { axes: statusVaultOrder },
      )
      const limitedFrame = '{"type":"error","status":429}'
      const doneFrames = [
        '{"type":"response.output_item.added"}',
        '{"type":"response.output_text.done"}',
      ]
      const { adapter } = fakeAdapter(undefined, {
        chooseAccount(input) {
          if (input.phase === 'request') {
            requestChoices++
            return 'A'
          }
          const result = bridge.chooseAccount(input)
          return typeof result === 'string' ? result : undefined
        },
        accountHeaders({ accountId }) {
          headersRead.push(accountId)
          return { authorization: `Bearer tok-${accountId}` }
        },
        inspectEvent({ data }) {
          // The frozen plugin inspector's verdict is an input to common-auth.
          if (data === limitedFrame)
            return { limit: { reason: 'rate-limit', status: 429 } }
          if (doneFrames.includes(data) || data === unknownFrame)
            return { outputStarted: true }
          return undefined
        },
      })
      const installation = await installOpenCode2Auth(host.ctx, adapter, {
        gateOnPlaceholder: {
          credential: (headers) =>
            headers.get('authorization')?.replace(/^Bearer /, ''),
        },
      })
      installation.on('limit', async () => {
        feedback++
        if (mode === 'dedup') await barrier
        else await Promise.resolve()
        marked = true
        order.push('mark')
      })
      const secret = `Bearer ${placeholderSecret(PROVIDER)}`
      async function send(foreign = false, status = 200) {
        const model = await host.fire('model.request', {
          ...scopeFor(),
          headers: {} as Record<string, string>,
        })
        const auth = foreign ? 'Bearer foreign' : secret
        if (mode === 'unsignalled') {
          const request = await host.fire('http.request', {
            ...scopeFor(),
            request: new Request('https://provider.invalid/responses', {
              method: 'POST',
              headers: { ...model.headers, authorization: auth },
            }),
          })
          await host.fire('http.response', {
            ...scopeFor(),
            request: request.request,
            response: new Response('auth refused', { status }),
          })
          return Object.fromEntries(request.request.headers)
        }
        return (
          await host.fire('experimental.ws.handshake', {
            ...scopeFor(),
            url: 'wss://provider.invalid/responses',
            headers: { ...model.headers, Authorization: auth } as Record<
              string,
              string
            >,
          })
        ).headers
      }
      const receive = (frame: string) =>
        host.fire('experimental.ws.receive', { ...scopeFor(), frame })
      try {
        if (mode === 'mixed') await send(true)
        await send(mode === 'foreign', mode === 'unsignalled' ? 401 : 200)
        if (mode === 'done')
          for (const frame of doneFrames) await receive(frame)
        if (mode === 'unknown') await receive(unknownFrame)
        const pending =
          mode === 'unsignalled' ? Promise.resolve() : receive(limitedFrame)
        if (mode !== 'dedup') await pending
        const { kind: _kind, ...scope } = scopeFor()
        const retryPromise = host.fire('retry', {
          ...scope,
          attempt: 1,
          error: { type: 'provider.unknown', message: 'limited' },
          decision: { retry: mode !== 'reroute', delay: 1234 } as {
            retry: boolean
            delay?: number
          },
        })
        if (mode === 'dedup') {
          await Promise.resolve()
          await Promise.resolve()
          expect(bridge.calls).toHaveLength(0)
          release()
          await pending
        }
        const retry = await retryPromise
        if (mode === 'reroute' || mode === 'dedup') {
          expect(retry.decision).toEqual({ retry: true, delay: 0 })
          expect(order).toEqual(['mark', 'choose'])
          if (mode === 'dedup') {
            await receive(limitedFrame)
            expect(feedback).toBe(1)
          }
          const next = await send()
          expect(next.authorization).toBe('Bearer tok-B')
          expect(headersRead).toEqual(['A', 'B'])
          expect(requestChoices).toBe(1)
          expect(bridge.calls).toHaveLength(1)
          expect(view(bridge.decisions[0]!)).toEqual(
            expected('reroute', 'ready-alternative', { account: B }),
          )
        } else {
          const veto = mode === 'done' || mode === 'unknown'
          expect(retry.decision).toEqual(
            veto ? { retry: false } : { retry: true, delay: 1234 },
          )
          expect(headersRead).toEqual(mode === 'foreign' ? [] : ['A'])
          expect(bridge.calls).toHaveLength(mode === 'exhausted' ? 1 : 0)
          if (mode === 'exhausted') {
            expect(view(bridge.decisions[0]!)).toEqual(
              expected('pass', 'host-delay'),
            )
            await send()
            expect(requestChoices).toBe(2)
            expect(headersRead).toEqual(['A', 'A'])
          }
        }
      } finally {
        release()
        await installation.dispose()
      }
    }
    vector(
      17,
      'installer awaits delayed once-per-attempt feedback before retry choice',
      () => installerCase('dedup'),
    )
    vector(
      28,
      'installer queues vault-order B with zero delay and consumes once',
      () => installerCase('reroute'),
    )
    vector(
      29,
      'installer exhausted retry commits nothing and preserves host delay',
      () => installerCase('exhausted'),
    )
    vector(
      31,
      'installer done-only output sequence vetoes retry; B is never read',
      () => installerCase('done'),
    )
    vector(
      33,
      'installer unknown empty non-object and malformed frames conservatively veto',
      async () => {
        for (const frame of ['{"type":"future"}', '{}', 'null', 'not JSON'])
          await installerCase('unknown', frame)
      },
    )
    vector(
      35,
      'installer mixed history remains tainted after owned limit',
      () => installerCase('mixed'),
    )
    vector(
      36,
      'installer foreign retry never chooses an arbitrary account',
      () => installerCase('foreign'),
    )
    vector(
      37,
      'installer unsignalled HTTP 401 leaves host retry unchanged',
      () => installerCase('unsignalled'),
    )
    for (const id of [42, 43])
      vector(
        id,
        'confirmed balance marks A for five minutes and advances to B',
        () => {
          // CL-43 OpenRouter metadata precedence is proven by claustrum-auth's parser tests.
          const signal = payment()
          expect(marker(signal)).toMatchObject({
            until: now + 300000,
            cause: 'payment-balance',
          })
          for (const host of ['opencode1', 'pi'] as const) {
            const decision = decideAfterLimit(
              facts(setting, { host, signal, status: 402 }),
              statusVaultOrder,
            )
            expect(decision).toMatchObject({
              action: 'reroute',
              account: B,
              hostRetry: 'leave',
            })
            expect(decision.history.sawPaymentBalance).toBe(true)
            expect(decision.history.saw429).toBe(false)
          }
        },
      )
    for (const id of [44, 45, 46, 61, 69])
      vector(id, 'unconfirmed 402 passes without payment evidence', () => {
        // Provider metadata/body parsing and secret redaction are proven by
        // claustrum-auth's parser/transport tests; these facts start after parsing.
        expect(marker(undefined)).toBeUndefined()
        const decision = decideAfterLimit(
          facts(setting, {
            status: 402,
            signal: undefined,
            ...(id === 69 ? { host: 'opencode2', hostPhase: 'retry' } : {}),
          }),
          statusVaultOrder,
        )
        expect(decision).toMatchObject({
          action: 'pass',
          reason: 'unhandled-failure',
        })
        expect(decision.history.sawPaymentBalance).toBeUndefined()
      })
    function attempted(
      kinds: readonly ('balance' | 'rate' | 'auth' | 'cap')[],
    ) {
      let history = facts(setting).history
      let decision: LimitDecision | undefined
      kinds.forEach((kind, index) => {
        const account = index ? B : A
        const signal =
          kind === 'balance'
            ? payment(account, 17000)
            : kind === 'rate'
              ? { ...classify({ 'Retry-After': '17' })!, account }
              : kind === 'cap'
                ? { ...payment(account), kind: 'payment-cap' as const }
                : undefined
        decision = decideAfterLimit(
          facts(setting, {
            attempted: account,
            history,
            signal,
            status: kind === 'rate' ? 429 : kind === 'auth' ? 401 : 402,
            selection: index ? undefined : { account: B, pin: 'preserve' },
            candidates: [
              blocked(
                A,
                kinds[0] === 'rate' ? 'rate-limit' : 'payment-balance',
                now + 17000,
              ),
              index
                ? blocked(
                    B,
                    kind === 'rate' ? 'rate-limit' : 'payment-balance',
                    now + 17000,
                  )
                : ready(B),
            ],
          }),
          statusVaultOrder,
        )
        history = decision.history
        if (!index) expect(decision.action).toBe('reroute')
      })
      return decision!
    }
    for (const [id, kinds] of [
      [47, ['balance', 'rate']],
      [48, ['rate', 'balance']],
    ] as const)
      vector(
        id,
        'mixed attempted balance/429 produces exact synthetic 429 in either order',
        () => {
          const decision = attempted(kinds)
          expect(decision).toMatchObject({
            action: 'refuse',
            family: 'claustrum-429',
            retryAfterMs: 17000,
          })
          expect(decision.history).toMatchObject({
            saw429: true,
            sawPaymentBalance: true,
          })
          const wire = buildRefusal({
            family: 'claustrum-429',
            messageKey: 'quota.accounts-rate-limited',
            now,
            retryAfterMs: 17000,
          })
          expect(wire).toMatchObject({
            kind: 'http',
            status: 429,
            body: '{"error":"claustrum-auth: accounts-rate-limited"}',
          })
          if (wire.kind === 'http')
            expect(wire.headers.get('retry-after')).toBe('17')
        },
      )
    vector(
      49,
      'two attempted balance failures pass the last original 402',
      () => {
        expect(attempted(['balance', 'balance'])).toMatchObject({
          action: 'pass',
          reason: 'original-response',
        })
      },
    )
    vector(
      50,
      'auth/balance in either order passes the last original response',
      () => {
        for (const kinds of [
          ['auth', 'balance'],
          ['balance', 'auth'],
        ] as const)
          expect(attempted(kinds)).toMatchObject({
            action: 'pass',
            reason: 'original-response',
          })
      },
    )
    vector(51, 'key-cap after 429 passes immediately without marking', () => {
      expect(marker({ ...payment(), kind: 'payment-cap' })).toBeUndefined()
      expect(attempted(['rate', 'cap'])).toMatchObject({
        action: 'pass',
        reason: 'unhandled-failure',
      })
    })
    vector(
      52,
      'balance retry hints, zero and non-finite deadlines use finite defaults',
      () => {
        for (const [hint, expectedMs] of [
          [undefined, 300000],
          [NaN, 300000],
          [7200000, 7200000],
          [17000, 17000],
          [10000, 10000],
          [0, 0],
          [Infinity, 300000],
        ] as const) {
          const signal = payment(A, hint)
          for (const host of ['opencode1', 'pi', 'opencode2'] as const) {
            const mark = markFromSignal(
              signal,
              statusVaultOrder.markers[host],
              { now },
            )!
            expect(mark.until).toBe(now + expectedMs)
            expect(mark.cause).toBe('payment-balance')
            expect(markIsActive(mark, now)).toBe(expectedMs > 0)
          }
        }
        expect(
          marker(
            payment(
              A,
              classify({ 'Retry-After': new Date(now + 10000).toUTCString() })!
                .retryAfterMs,
            ),
          )?.until,
        ).toBe(now + 10000)
        for (const kind of ['payment-balance', 'rate-limit'] as const) {
          const signal = {
            ...payment(),
            kind,
            retryAfterMs: 1e308,
            observedAt: 1e308,
          }
          expect(
            markFromSignal(signal, statusVaultOrder.markers.opencode1, { now })
              ?.until,
          ).toBe(now + (kind === 'payment-balance' ? 300000 : 60000))
          expect(
            marker({ ...signal, observedAt: now, retryAfterMs: Infinity })
              ?.until,
          ).toBe(now + (kind === 'payment-balance' ? 300000 : 60000))
        }
        const zero = decideAfterLimit(
          facts(setting, {
            signal: payment(A, 0),
            status: 402,
            candidates: [ready(A)],
            selection: undefined,
          }),
          statusVaultOrder,
        )
        expect(zero.action).toBe('pass')
        expect(zero.history.tried).toHaveLength(1)
      },
    )
    function presend(
      candidates = [blocked(A, 'payment-balance')],
      at = now + 1000,
    ) {
      return decideAfterLimit(
        facts(setting, {
          phase: 'pre-send',
          now: at,
          attempted: undefined,
          status: undefined,
          candidates,
          selection: undefined,
        }),
        statusVaultOrder,
      )
    }
    vector(
      53,
      'single balance-marked account refuses 402 without a send',
      () => {
        paymentWire(presend(), '299')
        paymentWire(
          presend([blocked(A, 'payment-balance', now + 1001)], now + 1000),
          '1',
        )
      },
    )
    vector(
      54,
      'registry restart retains payment cause and refusal without provider text',
      async () => {
        const f = registryFixture()
        const first = await f.acquire()
        first.enqueue(f.command('balance'))
        await first.dispose()
        const second = await f.acquire()
        try {
          expect(second.snapshot.marks[0]?.entries[0]?.cause).toBe(
            'payment-balance',
          )
          const entry = second.snapshot.marks[0]!.entries[0]!
          paymentWire(presend([blocked(A, entry.cause, entry.until)]), '299')
          expect(Object.keys(entry).sort()).toEqual([
            'baseRevision',
            'cause',
            'committedRevision',
            'evidenceAt',
            'until',
          ])
        } finally {
          await second.dispose()
        }
      },
    )
    async function probeRecovery(at: number) {
      const f = registryFixture()
      const old = f.command('delayed', 'payment-balance', now + 900000)
      await f.adapter.commit([f.command('expired')])
      f.setTime(at)
      const registry = await f.acquire()
      try {
        expect(registry.snapshot.marks).toEqual([])
        const observation = registry.observe(f.binding)
        clearLimitsAfterProbe(registry, {
          ...observation,
          producerId: 'probe',
          operationId: 'success',
          cause: 'payment-balance',
          evidenceAt: at,
          keys: [{ scope: pool, window: 'requests' }],
        })
        // A different account does not join A's pending clear.
        const other = {
          ...f.binding,
          account: { ...f.binding.account, accountId: 'B' },
        }
        await registry.beforeDispatch(other)
        expect(registry.pendingCommands).toBe(1)
        expect((await registry.beforeDispatch(f.binding)).blocked).toBe(false)
        expect(f.snapshot.tombstones).toHaveLength(1)
        const delayed = await f.adapter.commit([old])
        expect(delayed.outcomes[0]).toMatchObject({
          status: 'rejected',
          reason: 'cleared',
        })
        expect(delayed.snapshot.marks).toEqual([])
      } finally {
        await registry.dispose()
      }
    }
    vector(
      55,
      'exact expiry admits A and successful probe fences old payment marks',
      async () => {
        const at = now + 300000
        expect(markIsActive(marker(payment())!, at)).toBe(false)
        expect(
          decideAfterLimit(
            facts(setting, {
              phase: 'pre-send',
              now: at,
              candidates: [ready(A)],
              selection: { account: A, pin: 'preserve' },
            }),
            statusVaultOrder,
          ),
        ).toMatchObject({ action: 'reroute', account: A })
        await probeRecovery(at)
      },
    )
    vector(
      56,
      'confirmed balance on expired probe renews for five minutes',
      () => {
        const at = now + 300001
        const signal = { ...payment(), observedAt: at }
        const mark = markFromSignal(
          signal,
          statusVaultOrder.markers.opencode1,
          { now: at },
        )!
        expect(mark).toMatchObject({
          until: now + 600001,
          cause: 'payment-balance',
        })
        expect(
          decideAfterLimit(
            facts(setting, {
              now: at,
              status: 402,
              signal,
              candidates: [blocked(A, mark.cause, mark.until), ready(B)],
            }),
            statusVaultOrder,
          ),
        ).toMatchObject({ action: 'reroute', account: B })
      },
    )
    vector(
      57,
      'unconfirmed cap probe passes and clears only expired balance evidence',
      async () => {
        expect(
          decideAfterLimit(
            facts(setting, { status: 402, signal: undefined }),
            statusVaultOrder,
          ),
        ).toMatchObject({ action: 'pass' })
        await probeRecovery(now + 300001)
      },
    )
    vector(
      58,
      'OC2 bridge and marker use parsed balance and event-relative delay',
      () => {
        const signal = payment(A, 17000)
        expect(toOpenCode2LimitSignal(signal)).toEqual({
          reason: 'payment-required',
          status: 402,
          retryAfterMs: 17000,
        })
        expect(marker(signal, 'opencode2', now + 250)?.until).toBe(now + 17250)
        expect(
          decideAfterLimit(
            facts(setting, {
              host: 'opencode2',
              hostPhase: 'retry',
              signal,
              status: 402,
              candidates: [
                blocked(A, 'payment-balance', now + 17250),
                ready(B),
              ],
            }),
            statusVaultOrder,
          ),
        ).toMatchObject({ action: 'reroute', account: B })
      },
    )
    vector(
      59,
      'OC2 request escapes balance mark and exhausted retry leaves host unchanged',
      () => {
        const candidates = [blocked(A, 'payment-balance')]
        const base = facts(setting, {
          host: 'opencode2',
          candidates,
          selection: { account: A, pin: 'preserve' },
        })
        expect(
          decideAfterLimit(
            { ...base, phase: 'pre-send', hostPhase: 'request' },
            statusVaultOrder,
          ),
        ).toMatchObject({ action: 'reroute', account: A })
        expect(
          decideAfterLimit(
            {
              ...base,
              hostPhase: 'retry',
              status: 402,
              signal: payment(),
              selection: undefined,
              remainingRetries: 0,
            },
            statusVaultOrder,
          ),
        ).toMatchObject({
          action: 'pass',
          reason: 'host-retries-exhausted',
          hostRetry: 'leave',
        })
        expect(
          decideAfterLimit(
            {
              ...base,
              hostPhase: 'retry',
              status: 402,
              signal: payment(),
              selection: undefined,
            },
            statusVaultOrder,
          ),
        ).toMatchObject({
          action: 'pass',
          reason: 'host-delay',
          hostRetry: 'leave',
        })
      },
    )
    vector(
      60,
      'persisted overwrite replaces cause and deadline together including zero',
      async () => {
        for (const [first, second, duration] of [
          ['payment-balance', 'rate-limit', 17000],
          ['payment-balance', 'rate-limit', 0],
          ['rate-limit', 'payment-balance', 300000],
        ] as const) {
          const f = registryFixture()
          await f.adapter.commit([f.command('first', first)])
          const registry = await f.acquire()
          try {
            registry.enqueue(f.command('second', second, now + duration))
            await registry.flush()
            const entries = registry.snapshot.marks.flatMap(
              (mark) => mark.entries,
            )
            if (!duration) expect(entries).toEqual([])
            else
              expect(entries).toEqual([
                {
                  until: now + duration,
                  cause: second,
                  evidenceAt: now,
                  baseRevision: 1,
                  committedRevision: 2,
                },
              ])
          } finally {
            await registry.dispose()
          }
        }
      },
    )
    vector(
      62,
      'all eligible accounts balance-marked refuse 402 at earliest deadline',
      () => {
        paymentWire(
          presend([
            blocked(A, 'payment-balance'),
            blocked(B, 'payment-balance', now + 17001),
          ]),
          '17',
        )
      },
    )
    vector(
      63,
      'mixed balance and rate or legacy causes retain exact quota refusal',
      () => {
        for (const cause of ['rate-limit', undefined] as const)
          expect(
            presend([blocked(A, 'payment-balance'), blocked(B, cause)]),
          ).toMatchObject({
            action: 'refuse',
            family: 'claustrum-429',
            messageKey: 'quota.accounts-rate-limited',
            retryAfterMs: 299000,
          })
      },
    )
    vector(
      64,
      'sole rate or legacy mark stays 429; absent payment facts are byte-identical',
      () => {
        const legacyAxes = {
          ...statusVaultOrder,
          terminalStatusHistory: { minRetryMs: 1000, defaultRetryMs: 60000 },
        }
        for (const cause of ['rate-limit', undefined] as const) {
          const input = facts(setting, {
            phase: 'pre-send',
            candidates: [blocked(A, cause)],
            selection: undefined,
          })
          expect(decideAfterLimit(input, statusVaultOrder)).toEqual(
            decideAfterLimit(input, legacyAxes),
          )
          expect(presend([blocked(A, cause)])).toMatchObject({
            action: 'refuse',
            family: 'claustrum-429',
          })
        }
        for (const status of [200, 401, 402, 403, 429, 503]) {
          const input = facts(setting, { status })
          expect(
            JSON.stringify(decideAfterLimit(input, statusVaultOrder)),
          ).toBe(JSON.stringify(decideAfterLimit(input, legacyAxes)))
        }
      },
    )
    vector(
      65,
      'only admitted placement-eligible accounts determine payment refusal',
      () => {
        for (const extra of [
          { ...ready(B), admitted: false },
          { ...ready(B), placementEligible: false },
        ])
          paymentWire(presend([blocked(A, 'payment-balance'), extra]), '299')
        expect(
          presend([blocked(A, 'payment-balance', now + 1000)]),
        ).not.toMatchObject({ family: 'claustrum-402' })
      },
    )
    vector(
      66,
      'fresh process after expiry publishes a recovery fence for a successful probe',
      () => probeRecovery(now + 300001),
    )
    for (const id of [67, 68])
      vector(
        id,
        'OC2 parsed balance frame marks without using wire hints; output veto stays intact',
        () => {
          // Frame classification is proven by claustrum-auth's inspector tests;
          // its verdict omits retry/reset hints before reaching shared policy.
          const signal = payment()
          expect(marker(signal, 'opencode2')?.until).toBe(now + 300000)
          const decision = decideAfterLimit(
            facts(setting, {
              host: 'opencode2',
              hostPhase: 'retry',
              signal,
              status: 402,
              delivery: {
                owned: true,
                attributable: true,
                replayable: id === 67,
              },
            }),
            statusVaultOrder,
          )
          expect(decision).toMatchObject(
            id === 67
              ? { action: 'reroute', account: B }
              : { action: 'pass', reason: 'unsafe-output', hostRetry: 'veto' },
          )
          expect(decision.history.sawPaymentBalance).toBe(true)
        },
      )
  })

afterAll(() => {
  for (const setting of settings) {
    const results = claustrumConformanceResults.filter((row) =>
      row.name.endsWith(`[${setting}]`),
    )
    for (const status of ['R', 'D'] as const) {
      const wanted = conformanceRows
        .filter(
          (row) => row.preset === 'status-vault-order' && row.status === status,
        )
        .map((row) => row.id)
        .sort()
      const actual = results
        .filter((row) => (row.rowId === 'CL-15' ? 'D' : 'R') === status)
        .map((row) => row.rowId)
        .sort()
      expect(actual).toEqual(wanted)
    }
    expect(results).toHaveLength(59)
    expect(results.length + 10).toBe(69)
  }
})
