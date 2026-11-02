import { expect } from 'bun:test'
import { join } from 'node:path'
import type { VaultInventory } from '../../src/claustrum/custody.js'
import {
  mutateVaultRoster,
  projectVaultRoster,
  readVaultRoster,
} from '../../src/claustrum/roster.js'
import {
  acquireLimitsRegistry,
  createPoolLimitsAdapter,
  LIMITS_HISTORY_BOUND,
  type LimitsCommand,
  type LimitsPersistenceOutcome,
  type LimitsRegistry,
} from '../../src/limits/index.js'
import { createVaultLimitsAdapter } from '../../src/limits/vault.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { deferred, oauth, type Scenario, scenario } from '../store/helpers.js'
import {
  changeInChild,
  clearInChild,
  RaceClock,
} from './registry-race-child.js'

const hooks = lifetimeHooks()
const { test, afterEach } = hooks
const owners: LimitsRegistry[] = []
const scenarios: Scenario[] = []
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.dispose()))
  for (const s of scenarios.splice(0)) s.cleanup()
})

function inventory(records: [string, string | undefined][]): VaultInventory {
  return {
    view: JSON.stringify(records),
    skipped: [],
    credentials: records.map(([credentialId, accountIdentity]) => ({
      credentialId,
      credentialType: 'oauth',
      state: 'active',
      ...(accountIdentity === undefined ? {} : { accountIdentity }),
    })),
  }
}

async function fixture(kind: 'pool' | 'vault', unknown = false) {
  const s = hooks.lifetime.manage(await scenario('limits-races-'))
  scenarios.push(s)
  const path = join(s.dir, 'roster.json')
  const namespace = `${kind}:${kind === 'pool' ? s.configPath : path}`
  const store = s.open()
  const list = inventory([['a', unknown ? undefined : 'account-a']])
  if (kind === 'pool') {
    await store.add({
      id: 'a',
      credential: oauth('r-a'),
      ...(unknown ? {} : { identity: 'account-a' }),
    })
  } else {
    await mutateVaultRoster(path, () => ({
      next: projectVaultRoster(undefined, list, { now: 10 }),
      result: undefined,
    }))
  }
  const clock = new RaceClock()
  const adapter =
    kind === 'pool'
      ? await createPoolLimitsAdapter({ namespace, store, now: clock.now })
      : await createVaultLimitsAdapter({ namespace, path, now: clock.now })
  const initial = await adapter.read()
  const binding = initial.bindings[0]!
  let reads = 0
  let writes = 0
  const rejected: LimitsPersistenceOutcome[] = []
  const settled = deferred()
  const owner = await acquireLimitsRegistry({
    adapter: {
      namespace,
      read: (previous) => {
        reads++
        return adapter.read(previous)
      },
      commit: (commands, previous) => {
        writes++
        return adapter.commit(commands, previous)
      },
    },
    clock,
    isAccessRestrictive: (state) => state === 'blocked',
    onRejected: (_command, outcome) => {
      rejected.push(outcome)
      settled.resolve()
    },
    onEvent: () => settled.resolve(),
  })
  owners.push(owner)
  let operation = 0
  const mark = (): LimitsCommand => ({
    ...owner.observe(binding),
    type: 'mark',
    producerId: 'delayed-process',
    operationId: `mark-${++operation}`,
    scope: { kind: 'pool' },
    window: 'requests',
    until: 100_000,
    evidenceAt: clock.now(),
    mergeLaw: 'max-until',
  })
  return {
    s,
    path,
    namespace,
    store,
    list,
    adapter,
    clock,
    owner,
    binding,
    mark,
    rejected,
    settled,
    reads: () => reads,
    writes: () => writes,
  }
}

for (const change of [
  'replace',
  'changed-identity',
  'rotate',
  'refresh',
  'recordIdentity',
] as const) {
  test(`pool: queued pre-login mark ${['replace', 'changed-identity'].includes(change) ? 'rejects' : 'accepts'} child ${change} without an intervening reload`, async () => {
    const f = await fixture('pool', change === 'recordIdentity')
    const command = f.mark()
    f.owner.enqueue(command)
    await changeInChild({
      ...f.s.paths,
      op: change === 'changed-identity' ? 'replace' : change,
      id: 'a',
      credential: oauth('r-new'),
      identity: change === 'changed-identity' ? 'account-other' : 'account-a',
      credentialEpoch: 1,
    })
    expect(f.reads()).toBe(1)
    expect(f.writes()).toBe(0)
    expect(f.owner.pendingCommands).toBe(1)
    await f.owner.flush()
    expect(f.reads()).toBe(1)
    const rejected = change === 'replace' || change === 'changed-identity'
    expect(f.rejected).toHaveLength(rejected ? 1 : 0)
    if (rejected) expect(f.rejected[0]?.reason).toBe('unknown-account')
    const durable = await f.adapter.read()
    expect(durable.snapshot.marks).toHaveLength(rejected ? 0 : 1)
    expect(f.owner.snapshot).toEqual(durable.snapshot)
    if (rejected) {
      expect(durable.bindings[0]?.account.incarnation).not.toBe(
        command.binding.account.incarnation,
      )
      f.owner.enqueue({ ...f.mark(), binding: durable.bindings[0]! })
      await f.owner.flush()
      expect((await f.adapter.read()).snapshot.marks).toHaveLength(1)
    } else {
      expect(durable.bindings[0]?.account).toEqual(command.binding.account)
      expect(durable.bindings[0]?.identity).toBe('account-a')
    }
  })
}

for (const change of [
  'remove-readd',
  'known-identity',
  'alias',
  'representative',
  'bind',
] as const) {
  test(`vault: queued pre-login mark ${['remove-readd', 'known-identity'].includes(change) ? 'rejects' : 'accepts'} child ${change} without an intervening reload`, async () => {
    const f = await fixture('vault', change === 'bind')
    const command = f.mark()
    f.owner.enqueue(command)
    const discoveries =
      change === 'remove-readd'
        ? [
            { inventory: inventory([]), now: 20 },
            { inventory: f.list, now: 30 },
          ]
        : change === 'alias'
          ? [
              {
                inventory: inventory([
                  ['a', 'account-a'],
                  ['b', 'account-a'],
                ]),
                now: 20,
              },
            ]
          : change === 'representative'
            ? [{ inventory: inventory([['b', 'account-a']]), now: 20 }]
            : change === 'bind'
              ? [{ inventory: inventory([['a', 'account-a']]), now: 20 }]
              : []
    await changeInChild({
      op: 'vault-roster',
      path: f.path,
      discoveries,
      ...(change === 'known-identity'
        ? { knownIdentity: 'account-other' }
        : {}),
    })
    expect(f.reads()).toBe(1)
    expect(f.writes()).toBe(0)
    expect(f.owner.pendingCommands).toBe(1)
    const row = (await readVaultRoster(f.path))!.rows[0]!
    expect(row.routeId).toBe(command.binding.account.accountId)
    expect(row.addedAt).toBe(change === 'remove-readd' ? 30 : 10)
    if (change === 'alias') expect(row.aliases).toEqual(['b'])
    if (change === 'representative') expect(row.credentialId).toBe('b')
    if (change === 'bind') expect(row.accountIdentity).toBe('account-a')
    await f.owner.flush()
    expect(f.reads()).toBe(1)
    const rejected = change === 'remove-readd' || change === 'known-identity'
    expect(f.rejected).toHaveLength(rejected ? 1 : 0)
    if (rejected) {
      expect(f.rejected[0]?.reason).toBe(
        change === 'remove-readd' ? 'unknown-account' : 'identity-replaced',
      )
    }
    const durable = await f.adapter.read()
    expect(durable.snapshot.marks).toHaveLength(rejected ? 0 : 1)
    expect(f.owner.snapshot).toEqual(durable.snapshot)
    if (rejected) {
      f.owner.enqueue({ ...f.mark(), binding: durable.bindings[0]! })
      await f.owner.flush()
      expect((await f.adapter.read()).snapshot.marks).toHaveLength(1)
    } else expect(durable.bindings[0]?.account).toEqual(command.binding.account)
  })
}

for (const kind of ['pool', 'vault'] as const) {
  for (const compact of [false, true]) {
    test(`${kind}: delayed mark cannot resurrect a child clear${compact ? ' below the watermark' : ''}`, async () => {
      const f = await fixture(kind)
      f.owner.enqueue(f.mark())
      await f.owner.flush()
      const delayed = f.mark()
      const cleared = await clearInChild(f.s, kind, f.namespace, f.path)
      expect(cleared.outcomes[0]?.status).toBe('committed')
      expect(cleared.snapshot.marks).toHaveLength(0)
      expect(delayed.baseRevision).toBeLessThan(cleared.snapshot.revision)
      if (compact) {
        // Distinct covered keys evict the original tombstone, not just its op id.
        const compacted = await f.adapter.commit([
          {
            type: 'clear',
            producerId: 'compactor',
            operationId: 'compact',
            binding: f.binding,
            baseRevision: cleared.snapshot.revision,
            keys: Array.from({ length: LIMITS_HISTORY_BOUND }, (_, i) => ({
              scope: { kind: 'pool' as const },
              window: `other-${i}`,
            })),
          },
        ])
        expect(compacted.snapshot.tombstones).toHaveLength(LIMITS_HISTORY_BOUND)
        expect(
          compacted.snapshot.tombstones.some(
            (t) => t.key.window === 'requests',
          ),
        ).toBe(false)
        expect(compacted.snapshot.lowWatermark).toBeGreaterThan(
          delayed.baseRevision,
        )
      }
      f.owner.enqueue(delayed)
      await f.owner.flush()
      expect(f.rejected).toMatchObject([
        {
          operationId: delayed.operationId,
          status: 'rejected',
          reason: compact ? 'below-watermark' : 'cleared',
        },
      ])
      expect(f.owner.pendingCommands).toBe(0)
      expect(f.owner.snapshot.marks).toHaveLength(0)
      expect((await f.adapter.read()).snapshot.marks).toHaveLength(0)
      // A mark based on the acknowledged clear revision may succeed.
      f.owner.enqueue(f.mark())
      await f.owner.flush()
      expect((await f.adapter.read()).snapshot.marks).toHaveLength(1)
    })
  }

  test(`${kind}: another process's clear survives the 1000 ms debounced save`, async () => {
    const f = await fixture(kind)
    f.owner.enqueue(f.mark())
    const cleared = await clearInChild(f.s, kind, f.namespace, f.path)
    expect(cleared.outcomes[0]?.status).toBe('committed')
    expect(f.writes()).toBe(0)
    f.clock.advance(999)
    expect(f.writes()).toBe(0)
    expect(f.owner.pendingCommands).toBe(1)
    f.clock.advance(1)
    await f.settled.promise
    expect(f.writes()).toBe(1)
    expect(f.rejected).toMatchObject([
      { status: 'rejected', reason: 'cleared' },
    ])
    expect(f.owner.pendingCommands).toBe(0)
    expect(f.owner.snapshot.marks).toHaveLength(0)
    const durable = await f.adapter.read()
    expect(durable.snapshot.marks).toHaveLength(0)
    expect(durable.snapshot.tombstones).toEqual(cleared.snapshot.tombstones)
  })
}
