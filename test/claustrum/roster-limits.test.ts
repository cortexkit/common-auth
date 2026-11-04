import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VaultInventory } from '../../src/claustrum/custody.js'
import {
  acceptVaultRoute,
  declineVaultRoute,
  drainVaultQuota,
  mutateVaultRoster,
  projectVaultRoster,
  readVaultRoster,
  recordVaultAccountQuota,
  refreshVaultRoster,
  reorderVaultRoster,
} from '../../src/claustrum/roster.js'
import { createLimitsNamespace } from '../../src/limits/namespace.js'
import { acquireLimitsRegistry } from '../../src/limits/registry.js'
import { createVaultLimitsAdapter } from '../../src/limits/vault.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

const inventory: VaultInventory = {
  view: 'initial',
  credentials: ['a', 'b'].map((id) => ({
    credentialId: id,
    credentialType: 'oauth' as const,
    accountIdentity: `account-${id}`,
    state: 'active',
  })),
  skipped: [],
}

async function fixture(cleared = false) {
  const directory = await mkdtemp(join(tmpdir(), 'roster-limits-'))
  directories.push(directory)
  const path = join(directory, 'roster.json')
  const namespace = `vault:${path}`
  const roster = {
    ...projectVaultRoster(undefined, inventory, { now: 10 }),
    limits: createLimitsNamespace(namespace, 'preserved-generation'),
  }
  await mutateVaultRoster(path, () => ({ next: roster, result: undefined }))
  if (cleared) {
    const adapter = await createVaultLimitsAdapter({
      namespace,
      path,
      now: () => 100,
    })
    const view = await adapter.read()
    const binding = view.bindings[0]!
    const target = { scope: { kind: 'pool' as const }, window: 'requests' }
    const marked = await adapter.commit([
      {
        type: 'mark',
        producerId: 'fixture',
        operationId: 'mark',
        binding,
        baseRevision: view.snapshot.revision,
        ...target,
        until: 10_000,
        evidenceAt: 100,
        mergeLaw: 'max-until',
      },
    ])
    const result = await adapter.commit([
      {
        type: 'clear',
        producerId: 'fixture',
        operationId: 'clear',
        binding,
        baseRevision: marked.snapshot.revision,
        keys: [target],
      },
    ])
    expect(result.snapshot.tombstones).toHaveLength(1)
    expect(result.snapshot.marks).toEqual([])
    roster.limits = result.snapshot
  }
  return { path, namespace, roster }
}

test('roster decoding carries a valid limits envelope without changing it', async () => {
  const { path, roster } = await fixture()
  expect((await readVaultRoster(path))?.limits).toEqual(roster.limits)
})

test('decline, accept and reorder preserve the limits envelope', async () => {
  const { path, roster } = await fixture(true)
  const first = roster.rows[0]!
  await declineVaultRoute(path, first.routeId)
  expect((await readVaultRoster(path))?.limits).toEqual(roster.limits)
  expect((await readVaultRoster(path))?.rows[0]?.enabled).toBe(false)
  await acceptVaultRoute(path, first.routeId)
  expect((await readVaultRoster(path))?.limits).toEqual(roster.limits)
  expect((await readVaultRoster(path))?.rows[0]?.enabled).toBe(true)
  await reorderVaultRoster(
    path,
    roster.rows.map((row) => row.routeId).reverse(),
  )
  const reordered = await readVaultRoster(path)
  expect(reordered?.rows.map((row) => row.routeId)).toEqual(
    roster.rows.map((row) => row.routeId).reverse(),
  )
  expect(reordered?.limits).toEqual(roster.limits)
})

test('quota flush preserves the limits envelope while persisting the reading', async () => {
  const { path, roster } = await fixture(true)
  const row = roster.rows[0]!
  expect(
    await recordVaultAccountQuota(path, {
      routeId: row.routeId,
      accountIdentity: row.accountIdentity!,
      observation: {
        checkedAt: 100,
        counters: { requests: { value: 7, checkedAt: 100 } },
      },
    }),
  ).toBe(true)
  await drainVaultQuota(path)
  const flushed = await readVaultRoster(path)
  expect(flushed?.rows[0]?.quota?.counters?.requests).toEqual({
    value: 7,
    checkedAt: 100,
  })
  expect(flushed?.limits).toEqual(roster.limits)
})

test('changed discovery after a committed clear preserves the clear and envelope', async () => {
  const { path, namespace } = await fixture()
  const adapter = await createVaultLimitsAdapter({
    namespace,
    path,
    now: () => 100,
  })
  const initial = await adapter.read()
  const binding = initial.bindings[0]!
  const target = { scope: { kind: 'pool' as const }, window: 'requests' }
  await adapter.commit([
    {
      type: 'mark',
      producerId: 'p',
      operationId: 'mark',
      binding,
      baseRevision: 0,
      ...target,
      until: 10_000,
      evidenceAt: 100,
      mergeLaw: 'max-until',
    },
  ])
  const marked = await adapter.read()
  await adapter.commit([
    {
      type: 'clear',
      producerId: 'p',
      operationId: 'clear',
      binding,
      baseRevision: marked.snapshot.revision,
      keys: [target],
    },
  ])
  const cleared = (await adapter.read()).snapshot
  expect(cleared.marks).toEqual([])
  expect(cleared.tombstones).toHaveLength(1)
  const changed: VaultInventory = {
    ...inventory,
    view: 'changed',
    credentials: [
      ...inventory.credentials,
      {
        credentialId: 'c',
        credentialType: 'oauth',
        accountIdentity: 'account-c',
        state: 'active',
      },
    ],
  }
  const discovered = await refreshVaultRoster({
    path,
    custody: { discover: async () => changed },
    projection: { now: 200 },
  })
  expect(discovered?.view).toBe('changed')
  expect(discovered?.rows).toHaveLength(3)
  expect(discovered?.limits).toEqual(cleared)
  expect((await readVaultRoster(path))?.limits).toEqual(cleared)
  const stale = await adapter.commit([
    {
      type: 'mark',
      producerId: 'p',
      operationId: 'delayed',
      binding,
      baseRevision: 0,
      ...target,
      until: 20_000,
      evidenceAt: 100,
      mergeLaw: 'max-until',
    },
  ])
  expect(stale.outcomes[0]).toMatchObject({
    status: 'rejected',
    reason: 'cleared',
  })
  expect(stale.snapshot.marks).toEqual([])
})

for (const kind of ['mark', 'clear tombstone'] as const) {
  test(`payment cause survives discovery, admission, reorder, quota writes and registry reload${kind === 'mark' ? '' : ' (clear tombstone)'}`, async () => {
    const { path, namespace, roster } = await fixture()
    const adapter = await createVaultLimitsAdapter({
      namespace,
      path,
      now: () => 100,
    })
    const initial = await adapter.read()
    const marked = await adapter.commit([
      {
        type: 'mark',
        producerId: 'payment',
        operationId: 'mark',
        binding: initial.bindings[0]!,
        baseRevision: initial.snapshot.revision,
        scope: { kind: 'pool' },
        window: 'requests',
        mergeLaw: 'overwrite',
        until: 300100,
        evidenceAt: 100,
        cause: 'payment-balance',
      },
    ])
    expect(marked.snapshot.marks[0]?.entries[0]?.cause).toBe('payment-balance')
    const persisted =
      kind === 'mark'
        ? marked
        : await adapter.commit([
            {
              type: 'clear',
              producerId: 'payment',
              operationId: 'clear',
              binding: initial.bindings[0]!,
              baseRevision: marked.snapshot.revision,
              keys: [{ scope: { kind: 'pool' }, window: 'requests' }],
              cause: 'payment-balance',
            },
          ])
    if (kind !== 'mark')
      expect(persisted.snapshot.tombstones[0]?.cause).toBe('payment-balance')
    const check = async () =>
      expect((await readVaultRoster(path))?.limits).toEqual(persisted.snapshot)
    await refreshVaultRoster({
      path,
      custody: { discover: async () => ({ ...inventory, view: 'new' }) },
      projection: { now: 200 },
    })
    await check()
    const row = roster.rows[0]!
    await declineVaultRoute(path, row.routeId)
    await check()
    await acceptVaultRoute(path, row.routeId)
    await check()
    await reorderVaultRoster(path, roster.rows.map((r) => r.routeId).reverse())
    await check()
    expect(
      await recordVaultAccountQuota(path, {
        routeId: row.routeId,
        accountIdentity: row.accountIdentity!,
        observation: {
          checkedAt: 200,
          counters: { requests: { value: 7, checkedAt: 200 } },
        },
      }),
    ).toBe(true)
    await drainVaultQuota(path)
    await check()
    const reloaded = await createVaultLimitsAdapter({
      namespace,
      path,
      now: () => 200,
    })
    const registry = await acquireLimitsRegistry({
      adapter: reloaded,
      isAccessRestrictive: () => false,
      clock: { now: () => 200, setTimeout: () => 0, clearTimeout: () => {} },
    })
    try {
      expect(registry.snapshot).toEqual(persisted.snapshot)
    } finally {
      await registry.dispose()
    }
  })
}
