import { beforeEach, describe, expect } from 'bun:test'
import { POOL_KEY } from '../../src/store/index.js'
import {
  loadAccounts,
  mutateAccounts,
  saveAccountState,
  saveAccounts,
  withAccountStoreTransaction,
} from '../fixtures/legacy-openai-auth/accounts.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import {
  apiKey,
  oauth,
  rejectionOf,
  runChild,
  type Scenario,
  scenario,
} from './helpers.js'

const hooks = lifetimeHooks()
const { afterEach, it } = hooks

let s: Scenario
beforeEach(async () => {
  s = hooks.lifetime.manage(await scenario())
})
afterEach(() => s.cleanup())

async function populate() {
  const store = s.open()
  await store.add({ id: 'a', credential: oauth('r-a'), identity: 'acct-a' })
  await store.add({
    id: 'k',
    credential: apiKey('key-k', { authHeader: 'x-api-key' }),
  })
  await store.recordQuota('a', { credentialEpoch: 1, identity: 'acct-a' }, 1)
}

async function rows() {
  const load = await s.open().read()
  if (load.status !== 'ready') throw new Error(`pool is ${load.status}`)
  return load
}

const writers = {
  saveAccounts: async () => {
    const storage = await loadAccounts(s.paths)
    if (storage) await saveAccounts(storage, s.paths)
  },
  mutateAccounts: () => mutateAccounts(() => undefined, s.paths),
  withAccountStoreTransaction: () =>
    withAccountStoreTransaction(
      async (tx) => tx.write(await tx.read()),
      s.paths,
    ),
  saveAccountState: async () => {
    const storage = await loadAccounts(s.paths)
    if (storage) await saveAccountState(storage, s.paths)
  },
}

describe('downgrade through the vendored writers', () => {
  for (const [name, write] of Object.entries(writers)) {
    it(`after the legacy ${name} every row keeps its credential and the pool key is unchanged`, async () => {
      await populate()
      const poolBefore = JSON.stringify((await s.config())[POOL_KEY])
      await write()
      const config = await s.config()
      expect(config.version).toBe(1)
      expect(JSON.stringify(config[POOL_KEY])).toBe(poolBefore)
      const state = await s.state()
      expect(state.accounts.a.refresh).toBe('r-a')
      expect(state.accounts.k.apiKey).toBe('key-k')
      const load = await rows()
      expect(load.schemaVersion).toBe(1)
      expect(
        load.rows.map((row) => [row.id, row.candidate, row.identity]),
      ).toEqual([
        ['a', true, 'acct-a'],
        ['k', true, undefined],
      ])
      expect(load.rows[1]?.credential).toMatchObject({
        authHeader: 'x-api-key',
      })
      expect(load.rows[0]?.quota).toEqual({ readings: [1] })
    })
  }

  it('a config write omitting type or an api baseURL loses that row credential after one legacy mutateAccounts', async () => {
    await populate()
    const config = await s.config()
    delete config.accounts[0].type
    delete config.accounts[1].baseURL
    await s.writeConfig(config)
    await writers.mutateAccounts()
    const state = await s.state()
    expect(state.accounts.a).toBeUndefined()
    expect(state.accounts.k).toBeUndefined()
  })

  it('a config write omitting addedAt loads the row without addedAt and keeps its credential', async () => {
    await populate()
    const config = await s.config()
    delete config.accounts[0].addedAt
    await s.writeConfig(config)
    await writers.mutateAccounts()
    const load = await rows()
    expect(load.rows[0]?.addedAt).toBeUndefined()
    expect(load.rows[0]?.credential).toMatchObject({ refresh: 'r-a' })
  })

  it('a config write omitting an x-api-key row authHeader loads it as authorization-bearer', async () => {
    await populate()
    const config = await s.config()
    delete config.accounts[1].authHeader
    await s.writeConfig(config)
    await writers.mutateAccounts()
    expect((await rows()).rows[1]?.credential).toMatchObject({
      authHeader: 'authorization-bearer',
    })
  })

  it('an authHeader kept only in the state file is gone from the state after a legacy roster write', async () => {
    await populate()
    const config = await s.config()
    delete config.accounts[1].authHeader
    await s.writeConfig(config)
    const state = await s.state()
    state.accounts.k.authHeader = 'x-api-key'
    await s.writeState(state)
    await writers.saveAccountState()
    expect((await s.state()).accounts.k.authHeader).toBe('x-api-key')
    await writers.mutateAccounts()
    // A reader looking for the header in the state file no longer finds it.
    expect((await s.state()).accounts.k.authHeader).toBeUndefined()
  })

  it('a row removed by the legacy writer loses its pool entry on the next library write and its id is refused for the rest of the process', async () => {
    await populate()
    await s.open().add({ id: 'x', credential: oauth('r-x') })
    const config = await s.config()
    config[POOL_KEY].plantedKey = { keep: 'me' }
    await s.writeConfig(config)
    await mutateAccounts((current) => {
      current.accounts = current.accounts.filter((row) => row.id !== 'x')
      return current
    }, s.paths)
    const legacyConfig = await s.config()
    expect(legacyConfig.main).toEqual({ type: 'opencode', provider: 'openai' })
    expect(legacyConfig.claustrum.rowHistory).toEqual(['x'])
    expect(legacyConfig[POOL_KEY].rows.x).toBeDefined()

    const store = s.open()
    await store.disable('k', 'manual')
    const after = await s.config()
    expect(after[POOL_KEY].rows.x).toBeUndefined()
    // The dropped entry's epoch is recorded, so a later add of x starts past it.
    expect(after[POOL_KEY].retiredEpochs).toEqual({ x: 1 })
    expect(after[POOL_KEY].plantedKey).toEqual({ keep: 'me' })
    expect(after.main).toEqual({ type: 'opencode', provider: 'openai' })
    expect(after.claustrum.rowHistory).toEqual(['x'])
    expect((await rows()).rows.map((row) => row.id)).toEqual(['a', 'k'])

    const refused = await rejectionOf(
      store.add({ id: 'x', credential: oauth('r-x2') }),
    )
    expect(refused.kind).toBe('id-removed')
    const child = runChild({
      configPath: s.configPath,
      statePath: s.statePath,
      op: 'add',
      id: 'x',
      credential: oauth('r-x3'),
    })
    expect(await child.exited).toBe(0)
    const final = await rows()
    expect(final.rows.map((row) => [row.id, row.credentialEpoch])).toEqual([
      ['a', 1],
      ['k', 1],
      ['x', 2],
    ])
  })
})
