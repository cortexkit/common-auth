import { beforeEach, describe, expect } from 'bun:test'
import { POOL_KEY, type WriteStep } from '../../src/store/index.js'
import { loadAccounts } from '../fixtures/legacy-openai-auth/accounts.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import {
  apiKey,
  CRASH_EXIT_CODE,
  deferred,
  oauth,
  rejectionOf,
  runChild,
  type Scenario,
  scenario,
  settlesWithin,
} from './helpers.js'

const hooks = lifetimeHooks()
const { afterEach, it } = hooks

let s: Scenario
beforeEach(async () => {
  s = hooks.lifetime.manage(await scenario())
})
afterEach(() => s.cleanup())

/** Three rows: two OAuth rows with identities and quota, one api-key row. */
async function populate() {
  const store = s.open()
  await store.add({ id: 'a', credential: oauth('r-a'), identity: 'acct-a' })
  await store.add({ id: 'b', credential: oauth('r-b'), identity: 'acct-b' })
  await store.add({ id: 'k', credential: apiKey('key-k') })
  await store.recordQuota('a', { credentialEpoch: 1, identity: 'acct-a' }, 1)
  await store.recordQuota('b', { credentialEpoch: 1, identity: 'acct-b' }, 2)
}

async function ready() {
  const load = await s.open().read()
  if (load.status !== 'ready') throw new Error(`pool is ${load.status}`)
  return load
}

/** What the legacy openai-auth reader loads: id and secret per row. */
async function legacyRows() {
  const storage = await loadAccounts(s.paths)
  if (!storage) throw new Error('legacy reader found no config')
  return storage.accounts.map((account) => [
    account.id,
    account.type === 'api' ? account.apiKey : account.refresh,
  ])
}

describe('remove', () => {
  it('remove deletes the roster row, its pool entry and its state credential and leaves the other rows intact', async () => {
    await populate()
    const store = s.open()
    expect(await store.remove('b')).toEqual({ id: 'b', outcome: 'removed' })
    const config = await s.config()
    expect(config.accounts.map((row: { id: string }) => row.id)).toEqual([
      'a',
      'k',
    ])
    expect(Object.keys(config[POOL_KEY].rows)).toEqual(['a', 'k'])
    const state = await s.state()
    expect(Object.keys(state.accounts)).toEqual(['a', 'k'])
    const load = await ready()
    expect(load.rows.map((row) => [row.id, row.candidate])).toEqual([
      ['a', true],
      ['k', true],
    ])
    expect(load.rows[0]?.quota).toEqual({ readings: [1] })
    // The id is not reused by add in this process, as for every id the store drops.
    const again = await rejectionOf(
      store.add({ id: 'b', credential: oauth('r-b2') }),
    )
    expect(again.kind).toBe('id-removed')
    const unknown = await rejectionOf(store.remove('b'))
    expect(unknown).toMatchObject({ kind: 'unknown-row', operation: 'remove' })
  })

  it('the legacy reader loads a pool a row was removed from with every other row and credential', async () => {
    await populate()
    expect(await legacyRows()).toEqual([
      ['a', 'r-a'],
      ['b', 'r-b'],
      ['k', 'key-k'],
    ])
    await s.open().remove('b')
    expect(await legacyRows()).toEqual([
      ['a', 'r-a'],
      ['k', 'key-k'],
    ])
    // The older reader keeps an api-key roster row even without its key, so
    // a removal that left the roster row behind would show here.
    await s.open().remove('k')
    expect(await legacyRows()).toEqual([['a', 'r-a']])
  })

  it('remove refuses an id the protect predicate reserves and one a pending-operation record names, with both files unchanged', async () => {
    const store = s.open()
    await store.add({ id: 'main', credential: oauth('r-main') })
    await populate()
    const config = await s.config()
    config.pluginPool = { pending: { rowId: 'b', operation: 'replace' } }
    await s.writeConfig(config)
    const before = await s.bytes()
    const seen: Array<[string, string | undefined]> = []
    const protect = (
      id: string,
      view: {
        row: { id: string } | undefined
        config: Readonly<Record<string, unknown>>
      },
    ) => {
      seen.push([id, view.row?.id])
      if (id === 'main') return 'the main row is reserved'
      const pending = (
        view.config.pluginPool as { pending?: { rowId?: string } }
      )?.pending
      return pending?.rowId === id
        ? `a pending operation names ${id}`
        : undefined
    }
    const failures: string[] = []
    const onFailure = (_id: string, error: { kind: string }) =>
      void failures.push(error.kind)
    const main = await rejectionOf(store.remove('main', { protect, onFailure }))
    expect(main).toMatchObject({
      operation: 'remove',
      kind: 'row-protected',
      phase: 'before-first-write',
      message: 'the main row is reserved',
    })
    const pending = await rejectionOf(store.remove('b', { protect }))
    expect(pending).toMatchObject({
      kind: 'row-protected',
      message: 'a pending operation names b',
    })
    expect(await s.bytes()).toEqual(before)
    expect(failures).toEqual(['row-protected'])
    expect(seen).toEqual([
      ['main', 'main'],
      ['b', 'b'],
    ])
    expect(await store.remove('a', { protect })).toEqual({
      id: 'a',
      outcome: 'removed',
    })
  })

  it('remove and enable refuse an unknown row and a pending-migration pool before writing', async () => {
    const store = s.open()
    expect(await rejectionOf(store.remove('nope'))).toMatchObject({
      kind: 'unknown-row',
    })
    expect(await rejectionOf(store.enable('nope'))).toMatchObject({
      kind: 'unknown-row',
    })
    await s.writeConfig({ accounts: [{ id: 'x', type: 'oauth' }] })
    const before = await s.bytes()
    expect(await rejectionOf(store.remove('x'))).toMatchObject({
      kind: 'pending-migration',
    })
    expect(await rejectionOf(store.enable('x'))).toMatchObject({
      kind: 'pending-migration',
    })
    expect(await s.bytes()).toEqual(before)
  })

  const steps: Array<[WriteStep, 'old' | 'removed', 'removed' | 'completed']> =
    [
      ['before-config-write', 'old', 'removed'],
      ['after-config-write', 'removed', 'completed'],
      ['before-state-write', 'removed', 'completed'],
      ['after-state-write', 'removed', 'completed'],
    ]
  for (const [step, seenAs, rerun] of steps) {
    it(`a crash at ${step} of remove leaves either the old pool or the removed one and a re-run remove finishes it`, async () => {
      await populate()
      const child = runChild({
        configPath: s.configPath,
        statePath: s.statePath,
        op: 'remove',
        id: 'b',
        exitAt: step,
      })
      expect(await child.exited).toBe(CRASH_EXIT_CODE)
      const load = await ready()
      const legacy = await legacyRows()
      if (seenAs === 'old') {
        expect(load.rows.map((row) => [row.id, row.candidate])).toEqual([
          ['a', true],
          ['b', true],
          ['k', true],
        ])
        expect(load.rows[1]).toMatchObject({
          identity: 'acct-b',
          credentialEpoch: 1,
          quota: { readings: [2] },
        })
        expect(legacy).toEqual([
          ['a', 'r-a'],
          ['b', 'r-b'],
          ['k', 'key-k'],
        ])
      } else {
        expect(load.rows.map((row) => [row.id, row.candidate])).toEqual([
          ['a', true],
          ['k', true],
        ])
        expect((await s.config())[POOL_KEY].rows.b).toBeUndefined()
        expect(legacy).toEqual([
          ['a', 'r-a'],
          ['k', 'key-k'],
        ])
      }
      const stateHasB = (await s.state()).accounts.b !== undefined
      if (step === 'after-state-write') {
        expect(stateHasB).toBe(false)
        expect(await rejectionOf(s.open().remove('b'))).toMatchObject({
          kind: 'unknown-row',
        })
      } else {
        expect(stateHasB).toBe(true)
        expect(await s.open().remove('b')).toEqual({
          id: 'b',
          outcome: rerun,
        })
      }
      expect((await s.state()).accounts.b).toBeUndefined()
      expect((await ready()).rows.map((row) => row.id)).toEqual(['a', 'k'])
      expect(await legacyRows()).toEqual([
        ['a', 'r-a'],
        ['k', 'key-k'],
      ])
    })
  }

  it('a refresh holding the row lock across its provider call makes remove wait and cannot write a credential for the removed row', async () => {
    await populate()
    const entered = deferred()
    const release = deferred()
    hooks.lifetime.unpark(() => release.resolve())
    const refresh = s.open().refresh('a', async () => {
      entered.resolve()
      await release.promise
      return { access: 'x', refresh: 'r-a2', expires: 4_000_000_000_000 }
    })
    await entered.promise
    const removal = s.open().remove('a')
    expect(await settlesWithin(removal, 300)).toBe(false)
    release.resolve()
    expect(await refresh).toMatchObject({ status: 'rotated' })
    expect(await removal).toEqual({ id: 'a', outcome: 'removed' })
    expect((await s.state()).accounts.a).toBeUndefined()
    expect((await ready()).rows.map((row) => row.id)).toEqual(['b', 'k'])
  })
})

describe('enable', () => {
  it('enable clears enabled false and the disabled reason', async () => {
    await populate()
    const store = s.open()
    await store.disable('b', 'manual')
    let row = (await ready()).rows.find((candidate) => candidate.id === 'b')
    expect(row).toMatchObject({
      enabled: false,
      disabledReason: 'manual',
      candidate: false,
    })
    expect(await store.enable('b')).toEqual({ id: 'b' })
    row = (await ready()).rows.find((candidate) => candidate.id === 'b')
    expect(row).toMatchObject({ enabled: true, candidate: true })
    expect(row?.disabledReason).toBeUndefined()
    const config = await s.config()
    expect(config.accounts[1].enabled).toBe(true)
    expect('disabledReason' in config[POOL_KEY].rows.b).toBe(false)
    expect(config[POOL_KEY].rows.b.quota).toEqual({ readings: [2] })
    const legacy = await loadAccounts(s.paths)
    expect(legacy?.accounts[1]).toMatchObject({ id: 'b', enabled: true })
    // Enabling an enabled row writes nothing.
    const before = await s.bytes()
    expect(await store.enable('b')).toEqual({ id: 'b' })
    expect(await s.bytes()).toEqual(before)
  })

  it('enable refuses a row whose identity another enabled row holds, with both files unchanged', async () => {
    const store = s.open()
    await store.add({ id: 'a', credential: oauth('r-a'), identity: 'acct-1' })
    const added = await store.add({
      id: 'dup',
      credential: oauth('r-dup'),
      identity: 'acct-1',
    })
    expect(added.outcome).toBe('added-disabled')
    const before = await s.bytes()
    const refused = await rejectionOf(store.enable('dup'))
    expect(refused).toMatchObject({
      operation: 'enable',
      kind: 'duplicate-identity',
      phase: 'before-first-write',
    })
    expect(await s.bytes()).toEqual(before)
    // Once the holder is disabled, the duplicate may be enabled.
    await store.disable('a', 'manual')
    await store.enable('dup')
    const rows = (await ready()).rows
    expect(rows.map((row) => [row.id, row.enabled])).toEqual([
      ['a', false],
      ['dup', true],
    ])
  })
})
