import { beforeEach, describe, expect } from 'bun:test'
import type { Attribution, PoolRow, PoolStore } from '../../src/store/index.js'
import { mutateAccounts } from '../fixtures/legacy-openai-auth/accounts.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import {
  oauth,
  objectStateCodec,
  rejectionOf,
  runChild,
  type Scenario,
  scenario,
} from './helpers.js'

const hooks = lifetimeHooks()
const { afterEach, test } = hooks

// An attribution names a row by id, credential epoch and identity. A plugin
// chooses its ids and often reuses one (`main`), so a row removed and added
// again under the same id must not be mistaken for the removed one: work
// attributed to the removed row's credential has to be refused on the new
// credential, from whichever process it lands.

let s: Scenario
beforeEach(async () => {
  s = hooks.lifetime.manage(await scenario('pool-id-reuse-'))
})
afterEach(() => s.cleanup())

function open(): PoolStore {
  return s.open({ providerState: objectStateCodec })
}

async function rowOf(id: string): Promise<PoolRow> {
  const load = await open().read()
  if (load.status !== 'ready') throw new Error(`pool is ${load.status}`)
  const row = load.rows.find((candidate) => candidate.id === id)
  if (!row) throw new Error(`no row ${id}`)
  return row
}

function attributionOf(row: PoolRow): Attribution {
  return {
    credentialEpoch: row.credentialEpoch ?? 1,
    ...(row.identity !== undefined ? { identity: row.identity } : {}),
  }
}

/** Runs one store operation in a separate process and expects it to succeed. */
async function inChild(task: Record<string, unknown>): Promise<void> {
  const child = runChild({ ...s.paths, ...task })
  const code = await child.exited
  if (code !== 0) throw new Error(`child failed: ${child.output()}`)
}

/**
 * Process 1 adds row r with credential A, takes the attribution a request
 * served with A would carry, and removes r; process 2 then adds r again with
 * credential B, under the same identity or, like A, under none.
 */
async function reAddedElsewhere(identity: string | undefined) {
  const store = open()
  await store.add({
    id: 'r',
    credential: oauth('r-a'),
    ...(identity !== undefined ? { identity } : {}),
    providerState: { project: 'PA' },
  })
  const attribution = attributionOf(await rowOf('r'))
  await store.remove('r')
  await inChild({
    op: 'add',
    id: 'r',
    credential: oauth('r-b'),
    ...(identity !== undefined ? { identity } : {}),
    providerState: { project: 'PB' },
  })
  return { store, attribution }
}

for (const identity of ['acct-x', undefined]) {
  const variant = identity ? 'the same identity' : 'no identity'
  describe(`an id removed and added again by another process with ${variant}`, () => {
    test(`a late attributed disable for the removed credential is refused and writes nothing (${variant})`, async () => {
      const { store, attribution } = await reAddedElsewhere(identity)
      const before = await s.bytes()
      const refused = await rejectionOf(
        store.disable('r', 'ineligible', {
          attribution,
          providerState: (current) => ({
            ...(current as object),
            project: 'PA',
            ineligibleAt: 100,
          }),
        }),
      )
      expect(refused).toMatchObject({
        operation: 'disable',
        kind: 'attribution',
        retryable: true,
      })
      expect(await s.bytes()).toEqual(before)
      const row = await rowOf('r')
      expect(row.enabled).toBe(true)
      expect(row.credential).toMatchObject({ refresh: 'r-b' })
      expect(row.providerState).toEqual({ project: 'PB' })
      expect(row.credentialEpoch).toBe(2)
    })

    test(`late quota, provider-state, identity and enable writes for the removed credential are refused (${variant})`, async () => {
      const { store, attribution } = await reAddedElsewhere(identity)
      // The enable needs a disabled row to switch back on.
      await store.disable('r', 'manual')
      const before = await s.bytes()
      const failures = [
        await rejectionOf(store.recordQuota('r', attribution, 'reading-a')),
        await rejectionOf(
          store.updateProviderState('r', attribution, () => ({
            project: 'PA',
          })),
        ),
        await rejectionOf(
          store.recordIdentity('r', identity ?? 'acct-a', {
            credentialEpoch: attribution.credentialEpoch,
          }),
        ),
        await rejectionOf(store.enable('r', { attribution })),
      ]
      for (const failure of failures)
        expect(failure).toMatchObject({ kind: 'attribution', retryable: true })
      expect(await s.bytes()).toEqual(before)
      const row = await rowOf('r')
      expect(row.enabled).toBe(false)
      expect(row.quota).toBeUndefined()
      expect(row.providerState).toEqual({ project: 'PB' })
      expect(row.identity).toBe(identity)
    })
  })
}

test('an attribution held by a process that saw neither the removal nor the re-add is refused', async () => {
  const store = open()
  await store.add({
    id: 'r',
    credential: oauth('r-a'),
    identity: 'acct-x',
    providerState: { project: 'PA' },
  })
  const attribution = attributionOf(await rowOf('r'))
  await inChild({ op: 'remove', id: 'r' })
  await inChild({
    op: 'add',
    id: 'r',
    credential: oauth('r-b'),
    identity: 'acct-x',
    providerState: { project: 'PB' },
  })
  const before = await s.bytes()
  const disable = await rejectionOf(
    store.disable('r', 'ineligible', {
      attribution,
      providerState: () => ({ project: 'PA', ineligibleAt: 100 }),
    }),
  )
  const quota = await rejectionOf(
    store.recordQuota('r', attribution, 'reading-a'),
  )
  expect(disable).toMatchObject({ kind: 'attribution' })
  expect(quota).toMatchObject({ kind: 'attribution' })
  expect(await s.bytes()).toEqual(before)
  expect(await rowOf('r')).toMatchObject({
    enabled: true,
    credentialEpoch: 2,
    providerState: { project: 'PB' },
  })
})

test('a re-added id starts past every epoch it held, including those of replaced credentials', async () => {
  const store = open()
  await store.add({ id: 'r', credential: oauth('r-a') })
  await store.add({ id: 'other', credential: oauth('other') })
  const first = attributionOf(await rowOf('r'))
  await store.replace('r', oauth('r-b'))
  const second = attributionOf(await rowOf('r'))
  await store.remove('r')
  expect((await s.config()).commonAuthPool.retiredEpochs).toEqual({ r: 2 })
  // Removing another id records its own epoch and leaves r's recorded 2.
  await store.remove('other')
  expect((await s.config()).commonAuthPool.retiredEpochs).toEqual({
    r: 2,
    other: 1,
  })
  await inChild({ op: 'add', id: 'r', credential: oauth('r-c') })
  expect((await rowOf('r')).credentialEpoch).toBe(3)
  for (const attribution of [first, second])
    expect(
      await rejectionOf(store.recordQuota('r', attribution, 'stale')),
    ).toMatchObject({ kind: 'attribution' })
})

test('a row without an entry that the store removes is not matched by its epoch-1 attribution once re-added', async () => {
  const store = open()
  await store.add({ id: 'other', credential: oauth('other') })
  // A writer that does not know the pool adds r, so r has no entry and is at
  // epoch 1 (the epoch callers attribute such a row to).
  await mutateAccounts((current) => {
    current.accounts.push({ id: 'r', type: 'oauth', refresh: 'r-a' })
    return current
  }, s.paths)
  const attribution = attributionOf(await rowOf('r'))
  expect(attribution).toEqual({ credentialEpoch: 1 })
  await store.remove('r')
  await inChild({ op: 'add', id: 'r', credential: oauth('r-b') })
  expect((await rowOf('r')).credentialEpoch).toBe(2)
  const refused = await rejectionOf(
    store.disable('r', 'ineligible', { attribution }),
  )
  expect(refused).toMatchObject({ kind: 'attribution' })
  expect((await rowOf('r')).enabled).toBe(true)
})

test('an id whose roster row another writer removed is re-added past the epoch its leftover entry holds', async () => {
  const store = open()
  await store.add({ id: 'r', credential: oauth('r-a'), identity: 'acct-x' })
  const attribution = attributionOf(await rowOf('r'))
  // The other writer drops only the roster row; the pool entry stays behind.
  await mutateAccounts((current) => {
    current.accounts = current.accounts.filter((row) => row.id !== 'r')
    return current
  }, s.paths)
  expect((await s.config()).commonAuthPool.rows.r).toBeDefined()
  await inChild({
    op: 'add',
    id: 'r',
    credential: oauth('r-b'),
    identity: 'acct-x',
  })
  expect((await rowOf('r')).credentialEpoch).toBe(2)
  const refused = await rejectionOf(
    store.disable('r', 'ineligible', { attribution }),
  )
  expect(refused).toMatchObject({ kind: 'attribution' })
})

test('the recorded epoch of an id never goes down when a later row with that id held a lower one', async () => {
  const store = open()
  await store.add({ id: 'r', credential: oauth('r-a') })
  await store.replace('r', oauth('r-b'))
  const second = attributionOf(await rowOf('r'))
  await store.remove('r')
  // A writer that does not know the pool adds r again without an entry, at
  // epoch 1, and the store removes that row too.
  await mutateAccounts((current) => {
    current.accounts.push({ id: 'r', type: 'oauth', refresh: 'r-foreign' })
    return current
  }, s.paths)
  await store.remove('r')
  expect((await s.config()).commonAuthPool.retiredEpochs).toEqual({ r: 2 })
  await inChild({ op: 'add', id: 'r', credential: oauth('r-c') })
  expect((await rowOf('r')).credentialEpoch).toBe(3)
  expect(
    await rejectionOf(store.recordQuota('r', second, 'stale')),
  ).toMatchObject({ kind: 'attribution' })
})

test('an add of an id that held the last safe credential epoch is refused and writes nothing', async () => {
  const store = open()
  await store.add({ id: 'other', credential: oauth('other') })
  const config = await s.config()
  config.commonAuthPool.retiredEpochs = { r: Number.MAX_SAFE_INTEGER }
  await s.writeConfig(config)
  const before = await s.bytes()
  const refused = await rejectionOf(
    store.add({ id: 'r', credential: oauth('r-a') }),
  )
  expect(refused).toMatchObject({
    operation: 'add',
    kind: 'id-removed',
    phase: 'before-first-write',
  })
  expect(await s.bytes()).toEqual(before)
})

test('an attribution taken before a refresh and a rotate of the same credential is still accepted', async () => {
  const store = open()
  await store.add({
    id: 'r',
    credential: oauth('r-1'),
    identity: 'acct-x',
    providerState: { project: 'P' },
  })
  const attribution = attributionOf(await rowOf('r'))
  await store.refresh('r', async () => ({
    access: 'access-r-2',
    refresh: 'r-2',
    expires: 4_000_000_000_000,
  }))
  await store.recordQuota('r', attribution, 'served-before-refresh')
  await store.rotate('r', oauth('r-3'))
  await store.updateProviderState('r', attribution, (current) => ({
    ...(current as object),
    seenAt: 1,
  }))
  await store.disable('r', 'ineligible', {
    attribution,
    providerState: (current) => ({ ...(current as object), ineligibleAt: 2 }),
  })
  await store.enable('r', { attribution })
  const row = await rowOf('r')
  expect(row).toMatchObject({
    credentialEpoch: 1,
    enabled: true,
    quota: { readings: ['served-before-refresh'] },
    providerState: { project: 'P', seenAt: 1, ineligibleAt: 2 },
  })
  expect(row.credential).toMatchObject({ refresh: 'r-3' })
})
