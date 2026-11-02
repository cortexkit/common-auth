import { afterAll, describe, expect, test } from 'bun:test'
import {
  acquireLimitsRegistry,
  applyLimitsCommands,
  buildRefusal,
  createLimitsNamespace,
  createRequestHistory,
  decideAfterLimit,
  type IdentityBinding,
  type LimitDecision,
  type LimitHost,
  type LimitSignal,
  markFromSignal,
  markIsActive,
  marksAfterSuccess,
  mergeTimedMarkEntries,
  type PersistenceAdapter,
  type PolicyFacts,
  reduceFailureHistory,
  registerLimitMessages,
  resolveNamedWindowReset,
  resolveReset,
  sameAccountHoldFacts,
  scopeCovers,
  windowRouter,
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
import { runFakeClockDriver } from './fake-clock-driver.js'
import { conformanceRows, type VectorResult } from './rows.js'

// OA cases cover numeric hints, named-window resets, account-wide marks and
// host routing. Provider wire parsers stay in the plugin; signal fixtures
// supply parsed source facts to the shared reset and marker functions.
const now = Date.UTC(2026, 10, 1)
const A = {
  namespace: 'openai-conformance',
  accountId: 'A',
  incarnation: 'one',
}
const B = { ...A, accountId: 'B' }
const pool = { kind: 'pool' } as const
const settings = [0, 15, 'max'] as const
export const openaiConformanceResults: VectorResult[] = []
let sequence = 0

function signal(reason = 'rate_limit', resetAt?: number): LimitSignal {
  return {
    account: A,
    kind: 'rate-limit',
    reason,
    status: 429,
    scope: pool,
    observedAt: now,
    windows: [
      {
        window: reason,
        confirmed: false,
        confirmedByReading: false,
        observedAt: now,
        provenance: 'parsed-provider',
        ...(resetAt === undefined ? {} : { resetAt }),
      },
    ],
  }
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
    selection: { account: B, pin: 'pin' },
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

function parsedMark(
  reason: string,
  explicitResetAt?: number,
  cached: Record<string, number> = {},
) {
  const reset = resolveNamedWindowReset({
    now,
    window: reason,
    lendable: ['primary', 'secondary'],
    cached,
    explicitResetAt,
    defaultMs: 60000,
  })!
  const parsed = signal(reason, reset.resetAt)
  const failures = reduceFailureHistory(new Map(), {
    type: 'failure',
    account: A,
    at: now,
  })
  const mark = markFromSignal(parsed, windowRouter.markers.opencode2, {
    now,
    failures,
  })!
  const cleared = reduceFailureHistory(failures, {
    type: 'success',
    account: A,
  })
  expect(cleared.size).toBe(0)
  expect(mark.scope).toEqual(pool)
  expect(mark.mergeLaw).toBe('max-until')
  return { parsed, reset, mark }
}

function memory(namespace: string) {
  const binding: IdentityBinding = {
    account: { ...A, namespace },
    credentialEpoch: 'one',
    identity: 'known-A',
  }
  let snapshot = createLimitsNamespace(namespace, 'generation')
  let reads = 0
  let subscriptions = 0
  const adapter: PersistenceAdapter = {
    namespace,
    async read() {
      reads++
      return { snapshot, bindings: [binding], authoritative: true }
    },
    async commit(commands) {
      const merged = applyLimitsCommands(snapshot, commands, {
        now,
        bindings: [binding],
        authorizeEpoch: () => true,
      })
      snapshot = merged.snapshot
      return { ...merged, bindings: [binding], authoritative: true }
    },
    subscribe() {
      subscriptions++
      return () => {
        subscriptions--
      }
    },
  }
  return {
    binding,
    acquire: () =>
      acquireLimitsRegistry({
        adapter,
        isAccessRestrictive: () => false,
        clock: {
          now: () => now,
          setTimeout: () => Symbol(),
          clearTimeout() {},
        },
      }),
    mark(owner: Awaited<ReturnType<typeof acquireLimitsRegistry>>) {
      owner.enqueue({
        ...owner.observe(binding),
        producerId: 'fixture',
        operationId: `mark-${++sequence}`,
        type: 'mark',
        scope: pool,
        window: 'retry',
        until: now + 120000,
        evidenceAt: now,
        mergeLaw: 'max-until',
      })
    },
    reads: () => reads,
    subscriptions: () => subscriptions,
  }
}

for (const setting of settings)
  describe(`window-router maxSameAccountWait=${setting}`, () => {
    function vector(
      id: number,
      name: string,
      check: () => unknown | Promise<unknown>,
    ) {
      const rowId = `OA-${id}`
      const fullName = `${rowId} ${name} [${setting}]`
      test(fullName, async () => {
        await check()
        openaiConformanceResults.push({
          rowId,
          preset: 'window-router',
          name: fullName,
          status: 'passed',
        })
      })
    }

    const l1 = [
      {
        id: 1,
        name: 'absolute body source precedes relative and headers',
        reason: 'usage_limit_reached',
        absolute: now + 900000,
        relative: 600000,
        delay: 900000,
        source: 'body.absolute',
      },
      {
        id: 2,
        name: 'relative body source supplies ten minutes',
        reason: 'usage_limit_reached',
        relative: 600000,
        delay: 600000,
        source: 'body.relative',
      },
      {
        id: 3,
        name: 'past body source suppresses header; zero hint defaults mark',
        reason: 'usage_limit_reached',
        absolute: now - 1000,
        header: 600000,
        delay: 60000,
        source: 'default',
      },
      {
        id: 4,
        name: 'header-only unnamed limit cannot borrow healthy primary',
        reason: 'rate_limit',
        delay: 60000,
        source: 'default',
      },
      {
        id: 5,
        name: 'fractional numeric header has no rounding or jitter',
        reason: 'rate_limit',
        header: 1500,
        delay: 1500,
        source: 'explicit',
      },
      {
        id: 6,
        name: 'numeric zero hint falls through to the mark default',
        reason: 'rate_limit',
        header: 0,
        delay: 60000,
        source: 'default',
      },
      {
        id: 7,
        name: 'date invalid and negative headers supply no numeric hint',
        reason: 'rate_limit',
        delay: 60000,
        source: 'default',
      },
      {
        id: 8,
        name: 'retry-after-ms is not a parsed source',
        reason: 'rate_limit',
        delay: 60000,
        source: 'default',
      },
      {
        id: 9,
        name: 'capacity type or code is not a named primary window',
        reason: 'turn_rate_limit_exceeded',
        delay: 60000,
        source: 'default',
      },
    ] satisfies Array<{
      id: number
      name: string
      reason: string
      absolute?: number
      relative?: number
      header?: number
      delay: number
      source: string
    }>
    for (const row of l1)
      vector(row.id, `L1 ${row.name}`, () => {
        const input = row as (typeof l1)[number] & {
          absolute?: number
          relative?: number
          header?: number
        }
        const reset = resolveReset(
          [
            {
              source: 'body.absolute',
              value:
                input.absolute === undefined
                  ? undefined
                  : Math.max(now, input.absolute),
              unit: 'epoch-ms',
              zero: 'skip',
            },
            {
              source: 'body.relative',
              value: input.relative,
              unit: 'delay-ms',
              zero: 'accept',
            },
            {
              source: 'header.numeric',
              value: input.header,
              unit: 'delay-ms',
              zero: 'accept',
            },
          ],
          now,
        )
        const result = parsedMark(row.reason, reset?.resetAt, {
          primary: now + 7200000,
        })
        expect(result.mark.until).toBe(now + row.delay)
        expect(result.parsed).toEqual(signal(row.reason, now + row.delay))
        expect(result.reset.source).toBe(
          row.source.startsWith('body.') ? 'explicit' : row.source,
        )
        if (row.id === 1 || row.id === 2) expect(reset?.source).toBe(row.source)
        if (row.id === 3 || row.id === 6) expect(reset?.resetAt).toBe(now)
      })

    vector(10, 'marker future explicit +900s wins cached +300s', () => {
      expect(
        parsedMark('usage_limit_reached', now + 900000, {
          primary: now + 300000,
        }).mark.until,
      ).toBe(now + 900000)
    })
    vector(11, 'marker borrows only the matching named cached window', () => {
      for (const reason of ['primary', 'secondary']) {
        const result = parsedMark(reason, undefined, { [reason]: now + 300000 })
        expect(result.reset).toEqual({
          resetAt: now + 300000,
          source: 'cached',
        })
        expect(result.mark.until).toBe(now + 300000)
      }
    })
    vector(12, 'marker invalid own reset never borrows sibling', () => {
      for (const own of [now, now - 1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(
          parsedMark('secondary', own, {
            primary: now + 7200000,
            secondary: own,
          }).mark.until,
        ).toBe(now + 60000)
      }
      expect(parsedMark('secondary').mark.until).toBe(now + 60000)
    })
    vector(
      13,
      'L1 sending account owns secondary frame evidence and mark',
      () => {
        const result = parsedMark('secondary', undefined, {
          secondary: now + 180000,
        })
        expect(result.parsed.account).toEqual(A)
        expect(result.parsed.reason).toBe('secondary')
        expect(result.reset).toEqual({
          source: 'cached',
          resetAt: now + 180000,
        })
        expect(result.mark.until).toBe(now + 180000)
        expect(result.parsed.account).not.toEqual(B)
      },
    )
    vector(
      16,
      'L1 absent exhaustion signal produces no timed auth mark',
      () => {
        expect(
          markFromSignal(undefined, windowRouter.markers.opencode2, { now }),
        ).toBeUndefined()
        for (const status of [401, 403])
          expect(
            view(decideAfterLimit(facts(setting, { status }), windowRouter)),
          ).toEqual(expected('reroute', 'ready-alternative', { account: B }))
      },
    )
    vector(
      17,
      'pool mark covers other models; equality expires; B is separate',
      () => {
        const mark = parsedMark('primary', now + 120000).mark
        for (const model of ['gpt-a', 'gpt-b'])
          expect(scopeCovers(mark.scope, model, () => 'gpt')).toBe(true)
        expect(
          [119999, 120000, 120001].map((d) => markIsActive(mark, now + d)),
        ).toEqual([true, false, false])
        const decision = decideAfterLimit(
          facts(setting, {
            candidates: [
              {
                ...ready(A),
                ready: false,
                blockers: [{ kind: 'hard', until: mark.until }],
              },
              ready(B),
            ],
          }),
          windowRouter,
        )
        expect(view(decision)).toEqual(
          expected('reroute', 'ready-alternative', { account: B }),
        )
      },
    )
    vector(18, 'max-until shorter equal and later observations', () => {
      const entry = (delay: number, revision: number) => ({
        until: now + delay,
        evidenceAt: now,
        baseRevision: revision - 1,
        committedRevision: revision,
      })
      for (const [delay, wanted] of [
        [30000, 120000],
        [120000, 120000],
        [200000, 200000],
      ] as const) {
        const entries = mergeTimedMarkEntries(
          'max-until',
          [entry(120000, 1), entry(delay, 2)],
          now,
        )
        expect(Math.max(...entries.map((e) => e.until))).toBe(now + wanted)
      }
    })
    vector(
      19,
      'legacy healthy-reading explicit clear removes the covered mark',
      async () => {
        // Legacy snapshot health is a plugin fact; the shared layer executes its
        // explicit clear. The migrated preset instead preserves marks on success.
        const f = memory(`oa-legacy-${++sequence}`),
          owner = await f.acquire()
        try {
          f.mark(owner)
          await owner.flush()
          owner.enqueue({
            ...owner.observe(f.binding),
            producerId: 'fixture',
            operationId: 'healthy-clear',
            type: 'clear',
            keys: [{ scope: pool, window: 'retry' }],
            evidenceAt: now + 1,
          })
          await owner.flush()
          expect(owner.snapshot.marks).toEqual([])
          expect(owner.snapshot.tombstones).toHaveLength(1)
        } finally {
          await owner.dispose()
        }
      },
    )
    for (const id of [20, 25])
      vector(
        id,
        'known replacement partitions marks; token refresh retains identity',
        () => {
          const binding = {
            account: A,
            credentialEpoch: 'one',
            identity: 'known-A',
          }
          const command = {
            binding,
            baseRevision: 0,
            producerId: 'fixture',
            operationId: 'mark',
            type: 'mark' as const,
            scope: pool,
            window: 'retry',
            until: now + 120000,
            evidenceAt: now,
            mergeLaw: 'max-until' as const,
          }
          const initial = createLimitsNamespace(A.namespace, 'generation')
          const refreshed = applyLimitsCommands(initial, [command], {
            now,
            bindings: [{ ...binding, credentialEpoch: 'two' }],
            authorizeEpoch: () => true,
          })
          expect(refreshed.snapshot.marks).toHaveLength(1)
          const replacement = applyLimitsCommands(initial, [command], {
            now,
            bindings: [
              {
                ...binding,
                account: A,
                identity: 'known-B',
              },
            ],
            authorizeEpoch: () => true,
          })
          expect(replacement.outcomes[0]?.reason).toBe('identity-replaced')
          expect(replacement.snapshot.marks).toEqual([])
        },
      )
    for (const id of [21, 22, 23])
      vector(
        id,
        id === 23
          ? 'D process-wide owners replace unreleased module maps and hydrate after disposal'
          : 'same store namespace shares marks; different stores and pool/vault stay isolated',
        async () => {
          const f = memory(`oa-${id}-${++sequence}`),
            other = memory(`oa-other-${++sequence}`)
          const first = await f.acquire(),
            second = await f.acquire(),
            isolated = await other.acquire()
          try {
            f.mark(first)
            expect(second.pendingCommands).toBe(1)
            await first.flush()
            expect(second.snapshot.marks).toHaveLength(1)
            expect(isolated.snapshot.marks).toEqual([])
            expect(f.subscriptions()).toBe(1)
          } finally {
            await first.dispose()
            await second.dispose()
            await isolated.dispose()
          }
          expect(f.subscriptions()).toBe(0)
          const before = f.reads(),
            replacement = await f.acquire()
          try {
            expect(f.reads()).toBeGreaterThan(before)
            expect(
              (await replacement.beforeDispatch(f.binding)).snapshot.marks,
            ).toHaveLength(1)
            expect(() => f.mark(first)).toThrow('limits-registry-disposed')
          } finally {
            await replacement.dispose()
          }
        },
      )
    vector(
      24,
      'migrated healthy response and success leave timed marks in place',
      () => {
        const mark = parsedMark('primary', now + 120000).mark
        expect(windowRouter.readingClearsCoveredScopes).toBe('off')
        expect(
          marksAfterSuccess([mark], windowRouter, 'gpt-a', () => 'gpt'),
        ).toEqual([mark])
      },
    )
    vector(
      26,
      'Pi does not produce timed marks from token-attributed readings',
      () => {
        expect(
          markFromSignal(
            signal('primary', now + 600000),
            windowRouter.markers.pi,
            { now },
          ),
        ).toBeUndefined()
      },
    )

    for (const [id, host, affinity, confirmed] of [
      [27, 'opencode1', 'none', false],
      [32, 'opencode1', 'sticky', true],
      [57, 'pi', 'none', false],
      [58, 'pi', 'sticky', true],
    ] as const)
      vector(id, `L6 ${host} reroute(B) without a reset timer`, () => {
        const s = signal('primary', now + 1000)
        const decision = decideAfterLimit(
          facts(setting, {
            host,
            affinity,
            signal: confirmed
              ? {
                  ...s,
                  windows: s.windows.map((w) => ({
                    ...w,
                    confirmed: true,
                    confirmedByReading: true,
                  })),
                }
              : undefined,
          }),
          windowRouter,
        )
        expect(view(decision)).toEqual(
          expected('reroute', 'ready-alternative', { account: B }),
        )
        expect(Reflect.get(decision, 'target')).toBeUndefined()
      })
    vector(
      28,
      'L6 unconfigured status leaves original response to host',
      () => {
        expect(
          view(decideAfterLimit(facts(setting, { status: 500 }), windowRouter)),
        ).toEqual(expected('pass', 'unhandled-failure'))
      },
    )
    for (const [id, host] of [
      [31, 'opencode1'],
      [59, 'pi'],
    ] as const)
      vector(
        id,
        `L6 ${host} unconfirmed sticky retain(A) with no timer`,
        () => {
          expect(
            view(
              decideAfterLimit(
                facts(setting, {
                  host,
                  affinity: 'sticky',
                  signal: signal(),
                  retryHintsMs: [60000],
                }),
                windowRouter,
              ),
            ),
          ).toEqual(expected('retain', 'unconfirmed-limit', { account: A }))
        },
      )
    vector(33, 'L6 sticky 401/403 breaks affinity without a quota mark', () => {
      for (const status of [401, 403])
        expect(
          view(
            decideAfterLimit(
              facts(setting, { status, affinity: 'broken' }),
              windowRouter,
            ),
          ),
        ).toEqual(expected('reroute', 'ready-alternative', { account: B }))
    })

    for (const row of [
      {
        id: 36,
        reason: 'quota' as const,
        key: 'quota.no-route',
        ms: 90000,
        prefix: 'OpenAI rate limit reached — retrying on another account.',
        text: 'OpenAI rate limit reached — retrying on another account. Retry in 1m 30s.',
      },
      {
        id: 37,
        reason: 'incomplete' as const,
        key: 'incomplete.snapshot',
        ms: 5000,
        prefix:
          'OpenAI quota is not known yet for any available account; checking it now.',
        text: 'OpenAI quota is not known yet for any available account; checking it now. Retry in 0m 5s.',
      },
      {
        id: 38,
        reason: 'quota' as const,
        key: 'quota.killswitch',
        ms: 300000,
        prefix:
          'Killswitch: all OpenAI accounts are below their configured quota threshold.',
        text: 'Killswitch: all OpenAI accounts are below their configured quota threshold. Retry in 5m 0s.',
      },
    ])
      vector(
        row.id,
        'recorded formatter byte-for-byte — changes on adoption',
        () => {
          const decision = decideAfterLimit(
            facts(setting, {
              phase: 'pre-send',
              candidates: [],
              selection: undefined,
              terminal: {
                source: 'pool',
                reason: row.reason,
                messageKey: row.key,
                retryAfterMs: row.ms,
              },
            }),
            windowRouter,
          )
          expect(view(decision)).toEqual(
            expected('refuse', row.reason, {
              family: 'openai-429',
              messageKey: row.key,
              retryAfterMs: row.ms,
            }),
          )
          const messages = registerLimitMessages({
            retryable: {
              [row.key]: () => {
                const seconds = Math.ceil(row.ms / 1000)
                return `${row.prefix} Retry in ${Math.floor(seconds / 60)}m ${seconds % 60}s.`
              },
            },
          })
          const wire = buildRefusal({
            family: 'openai-429',
            messageKey: row.key,
            retryAfterMs: row.ms,
            now,
            messages,
          })
          expect(wire.kind).toBe('http')
          if (wire.kind !== 'http') throw new Error('Expected an HTTP refusal')
          expect(wire.status).toBe(429)
          expect(wire.headers.get('content-type')).toBe('application/json')
          expect(wire.headers.get('retry-after')).toBe(String(row.ms / 1000))
          expect(wire.body).toBe(
            `{"error":{"message":${JSON.stringify(row.text)},"type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}`,
          )
          expect(wire.retryable).toBe(true)
          expect(wire.hostRetry).toBe('leave')
        },
      )

    for (const row of [
      {
        id: 39,
        reason: 'auth' as const,
        source: 'pool' as const,
        family: 'local-auth' as const,
        key: 'auth.no-account',
      },
      {
        id: 61,
        reason: 'quota' as const,
        source: 'pool' as const,
        family: 'openai-429' as const,
        key: 'quota.no-route',
      },
      {
        id: 63,
        reason: 'incomplete' as const,
        source: 'vault' as const,
        family: 'native-vault-refusal' as const,
        key: 'vault.unreachable',
      },
      {
        id: 64,
        reason: 'auth' as const,
        source: 'vault' as const,
        family: 'native-vault-refusal' as const,
        key: 'vault.no-usable-account',
      },
      {
        id: 65,
        reason: 'auth' as const,
        source: 'vault' as const,
        family: 'native-vault-refusal' as const,
        key: 'vault.no-grant',
      },
      {
        id: 66,
        reason: 'auth' as const,
        source: 'vault' as const,
        family: 'native-vault-refusal' as const,
        key: 'vault.no-reached-login',
      },
      {
        id: 67,
        reason: 'auth' as const,
        source: 'vault' as const,
        family: 'native-vault-refusal' as const,
        key: 'vault.authorization-refused',
      },
    ])
      vector(
        row.id,
        'L6 plugin-owned auth/Pi presentation; no wire text',
        () => {
          const hosts: LimitHost[] =
            row.id === 61 ? ['pi'] : ['opencode1', 'opencode2', 'pi']
          for (const host of hosts) {
            const retryable = row.reason === 'quota'
            const decision = decideAfterLimit(
              facts(setting, {
                host,
                phase: 'pre-send',
                candidates: [],
                selection: undefined,
                terminal: {
                  source: row.source,
                  reason: row.reason,
                  family: row.family,
                  messageKey: row.key,
                  retryable,
                  hostRetry: 'leave',
                },
              }),
              windowRouter,
            )
            expect(view(decision)).toEqual(
              expected('refuse', row.reason, {
                family: row.family,
                messageKey: row.key,
                retryable,
              }),
            )
          }
        },
      )

    async function installerCase(
      mode: 'reroute' | 'same' | 'mixed' | 'output' | 'undefined' | 'throw',
      ws = false,
    ) {
      const host = fakeHost()
      const order: string[] = [],
        headersRead: string[] = []
      let marked = false
      const bridge = limitsFixtureAdapter(
        () => {
          expect(marked).toBe(true)
          order.push('choose')
          return facts(setting, {
            host: 'opencode2',
            hostPhase: 'retry',
            signal: signal(),
            candidates: mode === 'same' ? [ready(A)] : [ready(A), ready(B)],
            selection: mode === 'same' ? undefined : { account: B, pin: 'pin' },
          })
        },
        { axes: windowRouter },
      )
      const { adapter } = fakeAdapter(undefined, {
        chooseAccount(input) {
          if (input.phase === 'request') return 'A'
          if (mode === 'undefined') return undefined
          if (mode === 'throw') throw new Error('no available alternative')
          const result = bridge.chooseAccount(input)
          return typeof result === 'string' ? result : undefined
        },
        accountHeaders({ accountId }) {
          headersRead.push(accountId)
          return { authorization: `Bearer tok-${accountId}` }
        },
      })
      const installation = await installOpenCode2Auth(host.ctx, adapter, {
        gateOnPlaceholder: {
          credential: (headers) =>
            headers.get('authorization')?.replace(/^Bearer /, ''),
        },
      })
      installation.on('limit', async () => {
        await Promise.resolve()
        marked = true
        order.push('mark')
      })
      const secret = `Bearer ${placeholderSecret(PROVIDER)}`
      async function send(foreign = false) {
        const model = await host.fire('model.request', {
          ...scopeFor(),
          headers: {} as Record<string, string>,
        })
        const auth = foreign ? 'Bearer foreign' : secret
        if (ws)
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
          response: new Response('limited', { status: 429 }),
        })
        return Object.fromEntries(request.request.headers)
      }
      try {
        if (mode === 'mixed') await send(true)
        await send()
        if (ws) {
          for (const type of mode === 'output'
            ? ['delta', 'refused']
            : ['quota', 'refused']) {
            await host.fire('experimental.ws.receive', {
              ...scopeFor(),
              frame: JSON.stringify({ type }),
            })
          }
        }
        const { kind: _kind, ...scope } = scopeFor()
        const retry = await host.fire('retry', {
          ...scope,
          attempt: 1,
          error: { type: 'provider.unknown', message: 'limited' },
          decision: { retry: mode !== 'reroute', delay: 1234 } as {
            retry: boolean
            delay?: number
          },
        })
        if (mode === 'reroute' || mode === 'same') {
          expect(retry.decision).toEqual({
            retry: true,
            delay: mode === 'same' ? 1234 : 0,
          })
          expect(order).toEqual(['mark', 'choose'])
          const next = await send()
          expect(next.authorization).toBe(
            `Bearer tok-${mode === 'same' ? 'A' : 'B'}`,
          )
          expect(bridge.calls).toHaveLength(1)
          expect(view(bridge.decisions[0]!)).toEqual(
            mode === 'same'
              ? expected('retain', 'host-delay', { account: A })
              : expected('reroute', 'ready-alternative', { account: B }),
          )
        } else {
          expect(retry.decision).toEqual(
            mode === 'output' ? { retry: false } : { retry: true, delay: 1234 },
          )
          expect(bridge.calls).toHaveLength(0)
          expect(headersRead).toEqual(['A'])
        }
      } finally {
        await installation.dispose()
      }
    }
    vector(49, 'installer awaits mark then queues B exactly once', () =>
      installerCase('reroute'),
    )
    vector(50, 'installer lifecycle/quota frames allow WS reroute(B)', () =>
      installerCase('reroute', true),
    )
    vector(
      51,
      'installer queues last-account A and preserves host 1234ms',
      () => installerCase('same'),
    )
    vector(53, 'installer mixed ownership keeps host decision unchanged', () =>
      installerCase('mixed'),
    )
    vector(54, 'installer owned generated output vetoes replay', () =>
      installerCase('output', true),
    )
    vector(
      55,
      'L1 unnamed allow-listed failed frame does not invent a window',
      () => {
        for (const reason of ['usage_limit_reached', 'rate_limit_exceeded']) {
          const result = parsedMark(reason)
          expect(result.parsed.reason).toBe(reason)
          expect(result.parsed.windows[0]?.confirmed).toBe(false)
          expect(result.mark.until).toBe(now + 60000)
        }
      },
    )
    vector(
      56,
      'installer undefined or throwing retry choice preserves host policy',
      async () => {
        await installerCase('undefined')
        await installerCase('throw')
      },
    )

    test(`Pi decisions execute without a sleep [${setting}]`, () => {
      for (const affinity of ['none', 'sticky'] as const) {
        const trace = runFakeClockDriver({
          axes: windowRouter,
          now,
          clockNow: 0,
          history: facts(setting).history,
          readFacts: ({ event }) =>
            event.type === 'sent'
              ? undefined
              : facts(setting, { host: 'pi', affinity }),
        })
        expect(trace.sleeps).toEqual([])
        expect(trace.sends.map((send) => send.account)).toEqual([
          affinity === 'sticky' ? A : B,
        ])
      }
    })
  })

afterAll(() => {
  for (const setting of settings) {
    const results = openaiConformanceResults.filter((row) =>
      row.name.endsWith(`[${setting}]`),
    )
    for (const status of ['R', 'D'] as const) {
      const wanted = conformanceRows
        .filter(
          (row) => row.preset === 'window-router' && row.status === status,
        )
        .map((row) => row.id)
        .sort()
      const actual = results
        .filter((row) => (row.rowId === 'OA-23' ? 'D' : 'R') === status)
        .map((row) => row.rowId)
        .sort()
      expect(actual).toEqual(wanted)
    }
    expect(results).toHaveLength(49)
    expect(results.length + 21).toBe(70)
  }
})
