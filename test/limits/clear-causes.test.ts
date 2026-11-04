import { expect, test } from 'bun:test'
import { EnvelopeHistory } from '../../src/limits/envelope-loss.js'
import {
  acquireLimitsRegistry,
  applyLimitsCommands,
  type ClearTombstone,
  clearLimitsAfterProbe,
  createLimitsNamespace,
  LIMITS_HISTORY_BOUND,
  type LimitMarkCause,
  type LimitsCommand,
  mergeTimedMarkEntries,
  pruneLimitsNamespace,
} from '../../src/limits/index.js'

function fixture() {
  const binding = {
    account: { namespace: 'clear-causes', accountId: 'A', incarnation: 'one' },
    credentialEpoch: 'one',
  }
  const target = { scope: { kind: 'pool' as const }, window: 'requests' }
  let snapshot = createLimitsNamespace(binding.account.namespace, 'generation')
  let operation = 0
  const command = () => ({
    binding,
    producerId: 'test',
    operationId: `${++operation}`,
    baseRevision: snapshot.revision,
  })
  const context = { now: 100, bindings: [binding], authorizeEpoch: () => true }
  const commit = (commands: readonly LimitsCommand[]) => {
    const result = applyLimitsCommands(snapshot, commands, context)
    snapshot = result.snapshot
    return { ...result, bindings: [binding], authoritative: true }
  }
  return {
    binding,
    target,
    command,
    commit,
    snapshot: () => snapshot,
    clear: (cause?: LimitMarkCause): LimitsCommand => ({
      ...command(),
      type: 'clear',
      keys: [target],
      cause,
      evidenceAt: 100,
    }),
    mark: (cause?: LimitMarkCause): LimitsCommand => ({
      ...command(),
      ...target,
      type: 'mark',
      cause,
      until: 10000,
      evidenceAt: 100,
      mergeLaw: 'max-until',
    }),
    adapter: {
      namespace: binding.account.namespace,
      async read() {
        return { snapshot, bindings: [binding], authoritative: true }
      },
      async commit(commands: readonly LimitsCommand[]) {
        return commit(commands)
      },
    },
  }
}

test('delayed rate-limit lands after a payment-balance probe clear', async () => {
  const f = fixture()
  const registry = await acquireLimitsRegistry({
    adapter: f.adapter,
    isAccessRestrictive: () => false,
    clock: { now: () => 100, setTimeout: () => 0, clearTimeout: () => {} },
  })
  try {
    const delayed = f.mark('rate-limit')
    clearLimitsAfterProbe(registry, {
      ...f.command(),
      ...registry.observe(f.binding),
      keys: [f.target],
      evidenceAt: 100,
      cause: 'payment-balance',
    })
    await registry.beforeDispatch(f.binding)
    registry.enqueue(delayed)
    await registry.flush()
    expect(registry.snapshot.marks[0]?.entries[0]?.cause).toBe('rate-limit')
    expect(f.snapshot().marks).toEqual(registry.snapshot.marks)
  } finally {
    await registry.dispose()
  }
})

for (const cause of ['payment-balance', 'rate-limit', undefined] as const) {
  test(`${cause ?? 'all-cause'} clear fences only covered delayed causes`, () => {
    for (const markCause of [
      'payment-balance',
      'rate-limit',
      undefined,
    ] as const) {
      const f = fixture()
      const delayed = f.mark(markCause)
      f.commit([f.clear(cause)])
      const result = f.commit([delayed])
      const fenced = cause === undefined || cause === markCause
      expect(result.outcomes[0]).toMatchObject(
        fenced
          ? { status: 'rejected', reason: 'cleared' }
          : { status: 'committed' },
      )
      expect(result.snapshot.marks).toHaveLength(fenced ? 0 : 1)
    }
  })
}

test('successive cause clears retain independent revision fences', () => {
  for (const firstCause of ['rate-limit', undefined] as const) {
    const f = fixture()
    const beforeFirst = f.mark('rate-limit')
    const first = f.commit([f.clear(firstCause)])
    const between = f.mark('rate-limit')
    f.commit([f.clear('payment-balance')])
    expect(f.snapshot().tombstones).toHaveLength(2)
    expect(f.commit([beforeFirst]).outcomes[0]).toMatchObject({
      status: 'rejected',
      reason: 'cleared',
    })
    expect(f.commit([between]).outcomes[0]?.status).toBe('committed')
    expect(f.snapshot().marks[0]?.entries[0]?.baseRevision).toBe(
      first.snapshot.revision,
    )
  }
})

test('pruning filters each cause before max-until supersession', () => {
  const f = fixture()
  const cleared = f.commit([f.clear('payment-balance')]).snapshot
  const result = pruneLimitsNamespace(
    {
      ...cleared,
      marks: [
        {
          key: { ...f.target, account: f.binding.account },
          mergeLaw: 'max-until',
          entries: [
            {
              until: 20000,
              evidenceAt: 100,
              baseRevision: 0,
              committedRevision: 2,
              cause: 'payment-balance',
            },
            {
              until: 10000,
              evidenceAt: 100,
              baseRevision: 0,
              committedRevision: 3,
              cause: 'rate-limit',
            },
          ],
        },
      ],
    },
    100,
  )
  expect(result.marks[0]?.entries.map((e) => e.cause)).toEqual(['rate-limit'])
})

test('recovery detects a replaced cause fence and retains both causes', () => {
  const f = fixture()
  const old = f.commit([f.clear('rate-limit')]).snapshot
  const newer = f.commit([f.clear('payment-balance')]).snapshot
  const present = {
    ...newer,
    tombstones: newer.tombstones.filter((t) => t.cause === 'payment-balance'),
  }
  const history = new EnvelopeHistory()
  history.remember(old)
  expect(history.lost(present)).toBe(true)
  const recovered = history.recover(present, old, old.namespace, 100)
  expect(recovered.tombstones.map((t) => [t.cause, t.revision])).toEqual([
    ['rate-limit', 1],
    ['payment-balance', 2],
  ])
})

test('cause tombstones remain bounded and eviction raises the revision barrier', () => {
  const f = fixture()
  const result = f.commit([
    {
      ...f.command(),
      type: 'clear',
      cause: 'payment-balance',
      keys: Array.from({ length: LIMITS_HISTORY_BOUND + 1 }, (_, i) => ({
        ...f.target,
        window: `window-${i}`,
      })),
    },
  ])
  expect(result.snapshot.tombstones).toHaveLength(LIMITS_HISTORY_BOUND)
  expect(
    result.snapshot.tombstones.every((t) => t.cause === 'payment-balance'),
  ).toBe(true)
  expect(result.snapshot.lowWatermark).toBe(2)
})

test('clear commands never persist provider text in the cause field', () => {
  const f = fixture()
  f.commit([
    {
      ...f.clear(),
      cause: 'private provider body',
    } as unknown as LimitsCommand,
  ])
  expect(f.snapshot().tombstones[0]).not.toHaveProperty('cause')
  expect(JSON.stringify(f.snapshot())).not.toContain('private provider body')
  const marked = fixture()
  marked.commit([marked.mark('rate-limit')])
  marked.commit([
    {
      ...marked.clear(),
      cause: 'private provider body',
    } as unknown as LimitsCommand,
  ])
  expect(marked.snapshot().marks[0]?.entries[0]?.cause).toBe('rate-limit')
  expect(marked.snapshot().tombstones).toEqual([])
})

for (const cause of ['payment-balance', undefined] as const) {
  test(`legacy tombstone readers accept stored ${cause ?? 'all-cause'} fences`, () => {
    const f = fixture()
    const stored = JSON.stringify(f.commit([f.clear(cause)]).snapshot)
    // Older readers use only key/revision and pass the revision to the timed merge.
    // Reading the optional cause must not require a schema change or relax their fence.
    const legacy: {
      schemaVersion: 1
      tombstones: Omit<ClearTombstone, 'cause'>[]
    } = JSON.parse(stored)
    expect(legacy.schemaVersion).toBe(1)
    expect(legacy.tombstones[0]?.key).toEqual({
      ...f.target,
      account: f.binding.account,
    })
    expect(
      mergeTimedMarkEntries(
        'max-until',
        [
          {
            until: 10000,
            evidenceAt: 100,
            baseRevision: 0,
            committedRevision: 2,
          },
        ],
        100,
        legacy.tombstones[0]!.revision,
      ),
    ).toEqual([])
  })
}
