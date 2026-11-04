import { beforeEach, expect } from 'bun:test'
import { randomUUID } from 'node:crypto'
import {
  acquireLimitsRegistry,
  createPoolLimitsAdapter,
  type LimitsCommand,
  type LimitsPersistenceSnapshot,
} from '../../src/limits/index.js'
import type { PoolStore } from '../../src/store/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { observed } from '../fixtures/observed.js'
import {
  childLeases,
  deferred,
  oauth,
  runChild,
  type Scenario,
  scenario,
} from '../store/helpers.js'

const hooks = lifetimeHooks()
const { afterEach, it } = hooks
let s: Scenario
let namespace: string
beforeEach(async () => {
  s = hooks.lifetime.manage(await scenario('limits-adapter-'))
  namespace = `openai:pool:${s.configPath}`
})
afterEach(() => s.cleanup())

function mark(view: LimitsPersistenceSnapshot): LimitsCommand {
  const binding = view.bindings[0]
  if (!binding) throw new Error('expected account binding')
  return {
    type: 'mark',
    producerId: 'test',
    operationId: randomUUID(),
    binding,
    baseRevision: view.snapshot.revision,
    scope: { kind: 'pool' },
    window: 'requests',
    until: Date.now() + 60_000,
    evidenceAt: Date.now(),
    mergeLaw: 'overwrite',
  }
}

it('refuses activation before readiness and without the optional namespace capability', async () => {
  await s.writeConfig({ accounts: [] })
  const store = s.open()
  await expect(
    createPoolLimitsAdapter({ namespace, store }),
  ).rejects.toMatchObject({ code: 'pool-not-ready' })
  await store.initialize()
  const { updateLimitsNamespace: _update, ...legacy } = store
  const structural: PoolStore = legacy
  await expect(
    createPoolLimitsAdapter({ namespace, store: structural }),
  ).rejects.toMatchObject({ code: 'limits-unsupported' })
})

it('rejects an unsupported envelope schema on activation', async () => {
  const store = s.open()
  await store.initialize()
  await store.updateLimitsNamespace!(() => ({ schemaVersion: 2 }))
  await expect(createPoolLimitsAdapter({ namespace, store })).rejects.toThrow(
    'Invalid or unsupported',
  )
})

for (const op of [
  'rotate',
  'refresh',
  'recordIdentity',
  'replace',
  'changed-identity',
] as const) {
  it(`validates the authoritative binding after another process commits ${op}, without a reload`, async () => {
    const store = s.open()
    await store.add({
      id: 'a',
      credential: oauth('r-a'),
      ...(op === 'recordIdentity' ? {} : { identity: 'acct-a' }),
    })
    const adapter = await createPoolLimitsAdapter({ namespace, store })
    const before = await adapter.read()
    const command = mark(before)
    const child = runChild({
      ...s.paths,
      op: op === 'changed-identity' ? 'replace' : op,
      id: 'a',
      credential: oauth('r-new'),
      identity: op === 'changed-identity' ? 'acct-other' : 'acct-a',
      credentialEpoch: 1,
    })
    expect(await hooks.lifetime.operation(child.exited), child.output()).toBe(0)
    const result = await adapter.commit([command])
    const rejected = op === 'replace' || op === 'changed-identity'
    expect(result.outcomes[0]?.status).toBe(rejected ? 'rejected' : 'committed')
    expect(result.snapshot.marks).toHaveLength(rejected ? 0 : 1)
    expect((await adapter.read()).snapshot).toEqual(result.snapshot)
    if (!rejected)
      expect(result.bindings[0]?.account).toEqual(command.binding.account)
  })
}

it('rejects a changed known identity even when the epoch matches', async () => {
  const store = s.open()
  await store.add({ id: 'a', credential: oauth('r-a'), identity: 'acct-a' })
  const adapter = await createPoolLimitsAdapter({ namespace, store })
  const command = mark(await adapter.read())
  // A different writer can change the roster without advancing the epoch.
  const config = await s.config()
  config.accounts[0].accountId = 'acct-other'
  await s.writeConfig(config)
  const result = await adapter.commit([command])
  expect(result.bindings[0]?.credentialEpoch).toBe(
    command.binding.credentialEpoch,
  )
  expect(result.outcomes[0]).toMatchObject({
    status: 'rejected',
    reason: 'identity-replaced',
  })
  expect(result.snapshot.marks).toHaveLength(0)
})

it('merges against the durable envelope instead of saving a stale memory snapshot', async () => {
  const store = s.open()
  await store.add({ id: 'a', credential: oauth('r-a') })
  const first = await createPoolLimitsAdapter({ namespace, store })
  const second = await createPoolLimitsAdapter({ namespace, store: s.open() })
  const stale = await first.read()
  await second.commit([mark(await second.read())])
  const result = await first.commit([mark(stale)], stale.snapshot)
  expect(result.snapshot.revision).toBe(2)
  expect(result.snapshot.operationIds).toHaveLength(2)
})

for (const kind of ['mark', 'clear tombstone'] as const) {
  it(`payment cause survives pool discovery, admission, reorder, quota and registry reload${kind === 'mark' ? '' : ' (clear tombstone)'}`, async () => {
    const store = s.open()
    await store.add({ id: 'a', credential: oauth('r-a'), identity: 'acct-a' })
    const adapter = await createPoolLimitsAdapter({ namespace, store })
    const command = mark(await adapter.read())
    if (command.type !== 'mark') throw new Error('expected mark')
    const marked = await adapter.commit([
      { ...command, cause: 'payment-balance' },
    ])
    expect(marked.snapshot.marks[0]?.entries[0]?.cause).toBe('payment-balance')
    const persisted =
      kind === 'mark'
        ? marked
        : await adapter.commit([
            {
              ...command,
              type: 'clear',
              operationId: 'clear',
              baseRevision: marked.snapshot.revision,
              keys: [{ scope: command.scope, window: command.window }],
              cause: 'payment-balance',
            },
          ])
    if (kind !== 'mark')
      expect(persisted.snapshot.tombstones[0]?.cause).toBe('payment-balance')
    const check = async () =>
      expect((await s.config()).commonAuthLimits).toEqual(persisted.snapshot)
    await store.add({ id: 'b', credential: oauth('r-b'), identity: 'acct-b' })
    await check()
    await store.disable('a', 'manual')
    await check()
    await store.enable('a')
    await check()
    await store.reorder(['b', 'a'])
    await check()
    await store.recordQuota(
      'a',
      { credentialEpoch: 1, identity: 'acct-a' },
      'reading',
    )
    await check()
    await store.updateSettings(() => ({ routing: { mode: 'ordered' } }))
    await check()
    const reloaded = await createPoolLimitsAdapter({
      namespace,
      store: s.open(),
    })
    const registry = await acquireLimitsRegistry({
      adapter: reloaded,
      isAccessRestrictive: () => false,
    })
    hooks.lifetime.finish(() => registry.dispose())
    expect(registry.snapshot).toEqual(persisted.snapshot)
  })
}

it('read returns while another process holds the save lock', async () => {
  const store = s.open()
  await store.add({ id: 'a', credential: oauth('r-a'), identity: 'acct-a' })
  const adapter = await createPoolLimitsAdapter({ namespace, store })
  const child = runChild({
    ...s.paths,
    op: 'refresh',
    id: 'a',
    credential: oauth('r-new'),
    identity: 'acct-a',
    waitForParentRead: true,
    waitForRenewal: true,
  })
  hooks.lifetime.unpark(() => child.continue())
  const exited = hooks.lifetime.operation(child.exited)
  await observed(
    hooks.lifetime,
    child.printed(`"path":${JSON.stringify(`${s.configPath}.save.lock`)}`),
  )
  expect(
    childLeases(child.output()).some(
      (lease) => lease.path === `${s.configPath}.save.lock`,
    ),
  ).toBe(true)
  const view = await observed(hooks.lifetime, adapter.read())
  expect(view.authoritative).toBe(true)
  expect(view.bindings[0]?.identity).toBe('acct-a')
  expect(child.output()).not.toContain('done')
  child.continue()
  expect(await exited, child.output()).toBe(0)
})

it('settles a pending control command as rejected when the pool turns not-ready', async () => {
  const store = s.open()
  await store.add({ id: 'a', credential: oauth('r-a') })
  const entered = deferred()
  const release = deferred()
  hooks.lifetime.unpark(() => release.resolve())
  const delayed: PoolStore = {
    ...store,
    updateLimitsNamespace: async (mutator) => {
      entered.resolve()
      await release.promise
      await store.updateLimitsNamespace!(mutator)
    },
  }
  const adapter = await createPoolLimitsAdapter({ namespace, store: delayed })
  const view = await adapter.read()
  const rejected: unknown[] = []
  const registry = await acquireLimitsRegistry({
    adapter,
    isAccessRestrictive: () => false,
    onRejected: (_command, outcome) => rejected.push(outcome),
  })
  hooks.lifetime.finish(() => registry.dispose())
  const command = mark(view)
  registry.enqueue({
    ...command,
    type: 'clear',
    keys: [{ scope: { kind: 'pool' }, window: 'requests' }],
  })
  const dispatch = hooks.lifetime.operation(
    registry.beforeDispatch(command.binding),
  )
  await observed(hooks.lifetime, entered.promise)
  await s.writeConfig({ accounts: [] })
  release.resolve()
  await observed(hooks.lifetime, dispatch)
  expect(registry.pendingCommands).toBe(0)
  expect(rejected).toEqual([
    expect.objectContaining({ status: 'rejected', reason: 'pool-not-ready' }),
  ])
  expect(registry.degradedAgreement).toBe(true)
})

it('publishes a debounced mark recorded inside the real onPersisted hook', async () => {
  const store = s.open()
  await store.add({ id: 'a', credential: oauth('r-a') })
  const adapter = await createPoolLimitsAdapter({ namespace, store })
  const command = mark(await adapter.read())
  const published = deferred()
  const registry = await acquireLimitsRegistry({
    adapter,
    isAccessRestrictive: () => false,
    onEvent: (event) => {
      if (event.type === 'mark') published.resolve()
    },
  })
  hooks.lifetime.finish(() => registry.dispose())
  await store.refresh(
    'a',
    async () => ({ access: 'access-new', refresh: 'r-new', expires: 4e12 }),
    {
      onPersisted: async () => {
        registry.enqueue(command)
      },
    },
  )
  await observed(hooks.lifetime, published.promise)
  expect(registry.pendingCommands).toBe(0)
  expect((await adapter.read()).snapshot.marks).toHaveLength(1)
})

it('bounds lock-free read retries and returns an unverifiable last view under continuous replacement', async () => {
  const store = s.open()
  await store.add({ id: 'a', credential: oauth('r-a') })
  let changing = false
  let reads = 0
  const racing: PoolStore = {
    ...store,
    read: async () => {
      const pool = await store.read()
      if (changing && pool.status === 'ready') {
        reads++
        pool.rows[0]!.credentialEpoch = reads
      }
      return pool
    },
  }
  const adapter = await createPoolLimitsAdapter({ namespace, store: racing })
  changing = true
  const view = await adapter.read()
  expect(reads).toBe(4)
  expect(view.authoritative).toBe(false)
  expect(view.bindings[0]?.credentialEpoch).toBe('3')
})

it('rechecks the envelope generation when a writer replaces it between binding reads', async () => {
  const store = s.open()
  await store.add({ id: 'a', credential: oauth('r-a') })
  const initial = await createPoolLimitsAdapter({ namespace, store })
  const before = await initial.commit([mark(await initial.read())])
  let changing = false
  let reads = 0
  const racing: PoolStore = {
    ...store,
    read: async () => {
      const pool = await store.read()
      if (changing && ++reads === 2) {
        await store.updateLimitsNamespace!(() => ({
          ...before.snapshot,
          generation: 'replacement-generation',
          revision: 2,
        }))
      }
      return pool
    },
  }
  const adapter = await createPoolLimitsAdapter({ namespace, store: racing })
  const completed = deferred()
  const unsubscribe = adapter.subscribe?.(() => completed.resolve())
  hooks.lifetime.unpark(() => unsubscribe?.())
  changing = true
  const view = await adapter.read()
  expect(reads).toBe(3)
  expect(view.authoritative).toBe(false)
  expect(view.snapshot.generation).toBe('replacement-generation')
  // A replaced generation counts as loss and is repaired, never passively accepted.
  expect(view.snapshot.revision).toBe(3)
  expect(view.snapshot.lowWatermark).toBe(3)
  expect(view.degradedAgreement).toBe(true)
  await observed(hooks.lifetime, completed.promise)
  expect((await adapter.read()).authoritative).toBe(true)
})
