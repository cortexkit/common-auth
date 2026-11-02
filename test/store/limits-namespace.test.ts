import { beforeEach, expect } from 'bun:test'
import {
  POOL_OWNED_KEYS,
  PoolReentryError,
  type PoolStore,
} from '../../src/store/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import {
  listCodec,
  oauth,
  rejectionOf,
  type Scenario,
  scenario,
} from './helpers.js'

const hooks = lifetimeHooks()
const { afterEach, it } = hooks
let s: Scenario
beforeEach(async () => {
  s = hooks.lifetime.manage(await scenario('pool-limits-'))
})
afterEach(() => s.cleanup())

const refreshed = {
  access: 'access-new',
  refresh: 'refresh-new',
  expires: 4e12,
}

it('merges the envelope with custody-only rows in one config write and no row lock', async () => {
  const seed = s.open()
  await seed.add({ id: 'a', credential: oauth('r-a'), identity: 'acct-a' })
  await seed.updateLimitsNamespace!(() => ({ revision: 1 }))
  const before = await s.bytes()
  const locks: string[] = []
  const writes: string[] = []
  const store = s.open({
    onLockEvent: (event) => {
      if (event.type === 'acquired') locks.push(event.name)
    },
    onStep: (step) => {
      if (step.startsWith('after-')) writes.push(step)
    },
  })
  await store.updateLimitsNamespace!((envelope, rows) => {
    expect(envelope).toEqual({ revision: 1 })
    expect(rows).toEqual([{ id: 'a', credentialEpoch: 1, identity: 'acct-a' }])
    return { revision: 2, extra: { z: 1, a: [2, 3] } }
  })
  expect((await s.config()).commonAuthLimits).toEqual({
    revision: 2,
    extra: { z: 1, a: [2, 3] },
  })
  expect((await s.bytes()).state).toBe(before.state)
  expect(writes).toEqual(['after-config-write'])
  expect(locks).toEqual(['save', 'save'])
})

it('carries commonAuthLimits byte-identically through a fresh settings result', async () => {
  const store = s.open()
  await store.initialize()
  const envelope = {
    generation: 'g',
    revision: 50,
    arbitrary: { z: [1, 2], a: 'x' },
  }
  await store.updateLimitsNamespace!(() => envelope)
  const before = JSON.stringify((await s.config()).commonAuthLimits)
  const result = await store.updateSettings(() => ({
    routing: { mode: 'ordered' },
  }))
  expect(JSON.stringify((await s.config()).commonAuthLimits)).toBe(before)
  expect(result.settings.commonAuthLimits).toEqual(envelope)
  expect(await store.readSettings()).toEqual({
    status: 'ready',
    settings: result.settings,
  })
  expect(POOL_OWNED_KEYS).toEqual(['version', 'accounts', 'commonAuthPool'])
  expect(
    await store.updateSettings(() => ({ routing: { mode: 'ordered' } })),
  ).toMatchObject({ outcome: 'unchanged' })
})

it('refuses settings results that alter or introduce the envelope before writing', async () => {
  const store = s.open()
  await store.initialize()
  const absent = await s.bytes()
  expect(
    await rejectionOf(store.updateSettings(() => ({ commonAuthLimits: {} }))),
  ).toMatchObject({ kind: 'invalid-input' })
  expect(await s.bytes()).toEqual(absent)
  await store.updateLimitsNamespace!(() => ({ revision: 1 }))
  const before = await s.bytes()
  expect(
    await rejectionOf(
      store.updateSettings(() => ({ commonAuthLimits: { revision: 2 } })),
    ),
  ).toMatchObject({ kind: 'invalid-input' })
  expect(
    await rejectionOf(
      store.updateSettings((draft) => {
        ;(draft.commonAuthLimits as { revision: number }).revision = 2
        return draft
      }),
    ),
  ).toMatchObject({ kind: 'invalid-input' })
  expect(await s.bytes()).toEqual(before)
})

it('refuses a namespace write before readiness without running the mutator', async () => {
  await s.writeConfig({ accounts: [] })
  const store = s.open()
  let called = false
  const before = await s.bytes()
  expect(
    await rejectionOf(
      store.updateLimitsNamespace!(() => {
        called = true
      }),
    ),
  ).toMatchObject({
    operation: 'updateLimitsNamespace',
    kind: 'pending-migration',
  })
  expect(called).toBe(false)
  expect(await s.bytes()).toEqual(before)
})

it('allows namespace writes in onPersisted, onFailure and a pull', async () => {
  let store: PoolStore
  store = s.open({
    pull: async () => {
      await store.updateLimitsNamespace!(() => ({ hook: 'pull' }))
      return 'reading'
    },
  })
  await store.add({ id: 'a', credential: oauth('r-a') })
  await store.pullsSettled()
  expect((await s.config()).commonAuthLimits).toEqual({ hook: 'pull' })
  expect(
    await store.refresh('a', async () => refreshed, {
      onPersisted: async () => {
        await store.updateLimitsNamespace!(() => ({ hook: 'persisted' }))
      },
    }),
  ).toMatchObject({ status: 'rotated' })
  expect((await s.config()).commonAuthLimits).toEqual({ hook: 'persisted' })
  expect(
    await rejectionOf(
      store.refresh(
        'a',
        async () => {
          throw new Error('offline')
        },
        {
          onFailure: async () => {
            await store.updateLimitsNamespace!(() => ({ hook: 'failure' }))
          },
        },
      ),
    ),
  ).toMatchObject({ kind: 'provider' })
  expect((await s.config()).commonAuthLimits).toEqual({ hook: 'failure' })
})

it('refuses namespace reentry inside protect, settings and namespace mutators without acquiring locks', async () => {
  const store = s.open()
  await store.add({ id: 'a', credential: oauth('r-a') })
  const errors: unknown[] = []
  const attempt = async () => {
    errors.push(await rejectionOf(store.updateLimitsNamespace!(() => ({}))))
  }
  expect(
    await rejectionOf(
      store.remove('a', {
        protect: async () => {
          await attempt()
          return 'keep'
        },
      }),
    ),
  ).toMatchObject({ kind: 'row-protected' })
  await store.updateSettings(async () => {
    await attempt()
    return {}
  })
  await store.updateLimitsNamespace!(async () => {
    await attempt()
    return {}
  })
  expect(errors).toHaveLength(3)
  for (const error of errors) expect(error).toBeInstanceOf(PoolReentryError)
})

it('refuses namespace writes from provider-state mutators and synchronous codec hooks', async () => {
  let store: PoolStore
  const attempts: Promise<unknown>[] = []
  store = s.open({
    quota: {
      ...listCodec,
      merge: (stored, value) => {
        attempts.push(rejectionOf(store.updateLimitsNamespace!(() => ({}))))
        return listCodec.merge(stored, value)
      },
    },
    providerState: { validate: () => true },
  })
  await store.add({ id: 'a', credential: oauth('r-a') })
  await store.updateProviderState('a', { credentialEpoch: 1 }, async () => {
    attempts.push(rejectionOf(store.updateLimitsNamespace!(() => ({}))))
    return { seen: true }
  })
  await store.recordQuota('a', { credentialEpoch: 1 }, 'reading')
  expect(attempts).toHaveLength(2)
  for (const error of await Promise.all(attempts))
    expect(error).toBeInstanceOf(PoolReentryError)
})
