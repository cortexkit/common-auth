import { expect, test } from 'bun:test'
import * as limits from '../../src/limits/index.js'

const A = {
  namespace: 'payment-regression',
  accountId: 'A',
  incarnation: 'one',
}
const B = { ...A, accountId: 'B' }
const scope = { kind: 'pool' } as const
function blocked(account = A, until = 301000): limits.LimitCandidate {
  return {
    account,
    admitted: true,
    placementEligible: true,
    ready: false,
    blockers: [{ kind: 'hard', cause: 'payment-balance', until }],
  }
}
function presend(candidates: readonly limits.LimitCandidate[]) {
  return limits.decideAfterLimit(
    {
      phase: 'pre-send',
      host: 'opencode1',
      now: 2000,
      clockNow: 2000,
      sessionId: 'session',
      requestScope: scope,
      history: limits.createRequestHistory({
        requestId: 'new',
        originalUrl: 'https://provider.invalid',
        clockNow: 2000,
      }),
      delivery: { owned: true, attributable: true, replayable: true },
      candidates,
    },
    limits.statusVaultOrder,
  )
}

test('payment single-key refuses 402 with exact JSON', () => {
  const decision = presend([blocked()])
  expect(decision).toMatchObject({
    action: 'refuse',
    family: 'claustrum-402',
    messageKey: 'payment.insufficient-balance',
    retryAfterMs: 299000,
    hostRetry: 'leave',
  })
  if (decision.action !== 'refuse' || decision.family !== 'claustrum-402')
    throw new Error('expected payment refusal')
  const wire = limits.buildRefusal({
    ...decision,
    family: decision.family,
    now: 2000,
  })
  expect(wire).toMatchObject({
    kind: 'http',
    status: 402,
    body: '{"error":"claustrum-auth: insufficient balance"}',
  })
  if (wire.kind === 'http')
    expect([...wire.headers]).toEqual([
      ['content-type', 'application/json'],
      ['retry-after', '299'],
    ])
})

test('payment all eligible balances refuse 402 at earliest deadline', () => {
  expect(presend([blocked(A), blocked(B, 18000)])).toMatchObject({
    action: 'refuse',
    family: 'claustrum-402',
    retryAfterMs: 16000,
  })
})

test('payment huge Retry-After falls back to finite defaults', () => {
  for (const kind of ['rate-limit', 'payment-balance'] as const) {
    const signal: limits.LimitSignal = {
      account: A,
      kind,
      reason: kind,
      status: kind === 'rate-limit' ? 429 : 402,
      scope,
      windows: [],
      observedAt: 1e308,
      retryAfterMs: 1e308,
    }
    const expected = kind === 'rate-limit' ? 61000 : 301000
    expect(
      limits.markFromSignal(signal, limits.statusVaultOrder.markers.opencode1, {
        now: 1000,
      })?.until,
    ).toBe(expected)
    expect(
      limits.markFromSignal(
        { ...signal, observedAt: 1000, retryAfterMs: Number('1e308') * 1000 },
        limits.statusVaultOrder.markers.opencode1,
        { now: 1000 },
      )?.until,
    ).toBe(expected)
  }
})

test('payment expired successful probe fences a delayed pre-probe mark', async () => {
  const binding = { account: A, credentialEpoch: 'one' }
  let now = 1000
  let snapshot = limits.createLimitsNamespace(A.namespace, 'generation')
  const context = () => ({
    now,
    bindings: [binding],
    authorizeEpoch: () => true,
  })
  const mark: limits.LimitsCommand = {
    type: 'mark',
    binding,
    baseRevision: 0,
    producerId: 'old-process',
    operationId: 'expired',
    scope,
    window: 'requests',
    cause: 'payment-balance',
    until: 301000,
    evidenceAt: 1000,
    mergeLaw: 'overwrite',
  }
  snapshot = limits.applyLimitsCommands(snapshot, [mark], context()).snapshot
  now = 301001
  const registry = await limits.acquireLimitsRegistry({
    adapter: {
      namespace: A.namespace,
      async read() {
        return { snapshot, bindings: [binding], authoritative: true }
      },
      async commit(commands) {
        const result = limits.applyLimitsCommands(snapshot, commands, context())
        snapshot = result.snapshot
        return { ...result, bindings: [binding], authoritative: true }
      },
    },
    isAccessRestrictive: () => false,
    clock: { now: () => now, setTimeout: () => 0, clearTimeout: () => {} },
  })
  try {
    expect(registry.snapshot.marks).toEqual([])
    // An adopter publishes the recovery even when no live timer remains locally.
    limits.clearLimitsAfterProbe?.(registry, {
      ...registry.observe(binding),
      producerId: 'new-process',
      operationId: 'probe-success',
      cause: 'payment-balance',
      evidenceAt: now,
      keys: [{ scope, window: 'requests' }],
    })
    await registry.beforeDispatch(binding)
    const delayed = limits.applyLimitsCommands(
      snapshot,
      [{ ...mark, operationId: 'delayed', until: 901000 }],
      context(),
    )
    expect(delayed.outcomes[0]).toMatchObject({
      status: 'rejected',
      reason: 'cleared',
    })
    expect(delayed.snapshot.marks).toEqual([])
  } finally {
    await registry.dispose()
  }
})
