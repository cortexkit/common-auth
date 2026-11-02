import { afterAll, describe, expect, test } from 'bun:test'
import {
  acquireLimitsRegistry,
  applyLimitsCommands,
  buildRefusal,
  classifyHeaders,
  classifyRetryAfter,
  createLimitsNamespace,
  createRequestHistory,
  decideAfterLimit,
  type IdentityBinding,
  type LimitDecision,
  type LimitSignal,
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
    expect(results).toHaveLength(31)
    expect(results.length + 10).toBe(41)
  }
})
