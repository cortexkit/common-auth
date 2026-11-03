import { expect, expectTypeOf, test } from 'bun:test'
import {
  acquireLimitsRegistry,
  applyLimitsCommands,
  buildRefusal,
  clearLimitsAfterProbe,
  createLimitsNamespace,
  createRequestHistory,
  type LimitMark,
  type LimitsCommand,
  type MarkerAxes,
  type RequestHistory,
  type RequestHistoryEvent,
  type TimedBlocker,
  type TimedMarkEntry,
} from '../../src/limits/index.js'
import type { OpenCode2AuthAdapter } from '../../src/opencode2/index.js'

test('0.33/0.34 structural limits callers need no payment fields', () => {
  const account = { namespace: 'compat', accountId: 'A', incarnation: 'one' }
  const mark = {
    scope: { kind: 'pool' as const },
    until: 100,
    mergeLaw: 'overwrite' as const,
  }
  expectTypeOf(mark).toExtend<LimitMark>()
  expectTypeOf({ kind: 'hard' as const, until: 100 }).toExtend<TimedBlocker>()
  expectTypeOf({
    until: 100,
    evidenceAt: 0,
    baseRevision: 0,
    committedRevision: 1,
  }).toExtend<TimedMarkEntry>()
  expectTypeOf({
    kind: 'hint' as const,
    mergeLaw: 'overwrite' as const,
    defaultMs: 60000,
    minimumMs: 0,
    zero: 'accept' as const,
    hintClock: 'signal' as const,
  }).toExtend<MarkerAxes>()
  const response = {
    type: 'response' as const,
    account,
    scope: mark.scope,
    status: 429,
  }
  expectTypeOf(response).toExtend<RequestHistoryEvent>()
  const command = {
    ...mark,
    type: 'mark' as const,
    binding: { account, credentialEpoch: 'one' },
    producerId: 'old',
    operationId: 'mark',
    baseRevision: 0,
    evidenceAt: 0,
    window: 'requests',
  }
  expectTypeOf(command).toExtend<LimitsCommand>()
  const history = {
    requestId: 'legacy',
    originalUrl: 'https://provider.invalid',
    requestStartedAt: 0,
    saw429: false,
    tried: [],
    excludedForRequest: [],
    retains: [],
    retainedAttempts: [],
    excludedAttempts: [],
    switchedAttempts: [],
    switches: 0,
  }
  expectTypeOf(history).toExtend<RequestHistory>()
  expect(history).not.toHaveProperty('sawPaymentBalance')
  expect(
    createRequestHistory({
      requestId: 'new',
      originalUrl: history.originalUrl,
      clockNow: 0,
    }),
  ).not.toHaveProperty('sawPaymentBalance')
  // Response rewriting keeps its original direct-call return type. Retry policy
  // remains a separate adapter hook rather than a new rewrite envelope.
  expectTypeOf<
    Awaited<ReturnType<NonNullable<OpenCode2AuthAdapter['rewriteResponse']>>>
  >().toEqualTypeOf<Response | undefined>()
})

test('local OpenCode 2 refusals veto host replay without text matching', () => {
  for (const family of [
    'claustrum-402',
    'claustrum-429',
    'openai-429',
    'claude-429',
    'json-412',
    'pi-final',
    'claude-econnreset',
  ] as const) {
    const refusal = buildRefusal({
      family,
      messageKey: 'payment.insufficient-balance',
      now: 0,
      host: 'opencode2',
      retryAfterMs: 1001,
    })
    expect(refusal.hostRetry).toBe('veto')
  }
})

test('probe clears stay cause/account scoped and fence delayed enum marks', async () => {
  const account = {
    namespace: 'probe-payment-compat',
    accountId: 'A',
    incarnation: 'one',
  }
  const binding = { account, credentialEpoch: 'one' }
  const other = {
    account: { ...account, accountId: 'B' },
    credentialEpoch: 'one',
  }
  const target = { scope: { kind: 'pool' as const }, window: 'requests' }
  let snapshot = createLimitsNamespace(account.namespace, 'generation')
  const context = {
    now: 100,
    bindings: [binding, other],
    authorizeEpoch: () => true,
  }
  const mark = (
    operationId: string,
    cause?: 'rate-limit' | 'payment-balance',
  ): LimitsCommand => ({
    type: 'mark',
    producerId: 'compat',
    operationId,
    binding,
    baseRevision: snapshot.revision,
    ...target,
    evidenceAt: 100,
    until: 10000,
    mergeLaw: 'overwrite',
    cause,
  })
  const registry = await acquireLimitsRegistry({
    adapter: {
      namespace: account.namespace,
      async read() {
        return { snapshot, bindings: context.bindings, authoritative: true }
      },
      async commit(commands) {
        const result = applyLimitsCommands(snapshot, commands, context)
        snapshot = result.snapshot
        return { ...result, bindings: context.bindings, authoritative: true }
      },
    },
    isAccessRestrictive: () => false,
    clock: { now: () => 100, setTimeout: () => 0, clearTimeout: () => {} },
  })
  try {
    registry.enqueue(mark('payment', 'payment-balance'))
    await registry.flush()
    clearLimitsAfterProbe(registry, {
      ...registry.observe(other),
      producerId: 'compat',
      operationId: 'other-success',
      keys: [target],
      evidenceAt: 101,
      cause: 'payment-balance',
    })
    await registry.beforeDispatch(other)
    expect(registry.snapshot.marks[0]?.key.account).toEqual(account)
    expect(registry.snapshot.marks[0]?.entries[0]?.cause).toBe(
      'payment-balance',
    )
    const probe = registry.observe(binding)
    registry.enqueue(mark('new-rate', 'rate-limit'))
    await registry.flush()
    clearLimitsAfterProbe(registry, {
      ...probe,
      producerId: 'compat',
      operationId: 'old-probe',
      keys: [target],
      evidenceAt: 101,
      cause: 'payment-balance',
    })
    await registry.beforeDispatch(binding)
    expect(registry.snapshot.marks[0]?.entries[0]?.cause).toBe('rate-limit')
    // JavaScript callers cannot persist provider text through the enum field.
    const unsafe = {
      ...mark('unsafe'),
      cause: 'private provider body',
    } as unknown as LimitsCommand
    registry.enqueue(unsafe)
    await registry.flush()
    expect(registry.snapshot.marks[0]?.entries[0]).not.toHaveProperty('cause')
    expect(JSON.stringify(registry.snapshot)).not.toContain(
      'private provider body',
    )
  } finally {
    await registry.dispose()
  }
})
