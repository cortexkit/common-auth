import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { POOL_KEY, PoolOperationError } from '../../src/store/index.js'
import {
  isAccountStore,
  loadAccounts,
} from '../fixtures/legacy-openai-auth/accounts.js'
import {
  oauth,
  rejectionOf,
  type Scenario,
  scenario,
  stealLease,
} from './helpers.js'

let s: Scenario
beforeEach(async () => {
  s = await scenario()
})
afterEach(() => s.cleanup())

const legacyConfig = {
  version: 1,
  main: { opencode: 'openai', openai: 'openai' },
  mainAccountId: 'acct-main',
  webSockets: true,
  accounts: [{ id: 'x', type: 'oauth', enabled: true }],
}

describe('initialize', () => {
  it('turns a pending-migration config into an empty pool, dropping only the named keys and leaving the state file alone', async () => {
    await s.writeConfig(legacyConfig)
    await s.writeState({ version: 1, accounts: { x: { refresh: 'r-x' } } })
    const stateBefore = (await s.bytes()).state
    const store = s.open()

    expect(await store.initialize({ dropKeys: ['mainAccountId'] })).toEqual({
      status: 'initialized',
    })

    const config = await s.config()
    expect(config[POOL_KEY]).toEqual({ schemaVersion: 1, rows: {} })
    expect('mainAccountId' in config).toBe(false)
    expect(config.webSockets).toBe(true)
    expect(config.main).toEqual(legacyConfig.main)
    expect(config.accounts).toEqual(legacyConfig.accounts)
    expect((await s.bytes()).state).toBe(stateBefore)

    const load = await store.read()
    if (load.status !== 'ready') throw new Error('expected ready')
    expect(load.rows.map((row) => [row.id, row.needsFirstReading])).toEqual([
      ['x', true],
    ])
    // The legacy reader still takes the file as its own store, with x loaded.
    expect(isAccountStore(config)).toBe(true)
    const legacy = await loadAccounts(s.paths)
    expect(legacy?.accounts.map((account) => account.id)).toEqual(['x'])
  })

  it('leaves a ready pool untouched and refuses a load error', async () => {
    const store = s.open()
    await store.add({ id: 'a', credential: oauth('r-a') })
    const before = await s.bytes()
    expect(await store.initialize({ dropKeys: ['accounts'] })).toEqual({
      status: 'already-ready',
    })
    expect(await s.bytes()).toEqual(before)

    await s.writeConfig({ version: 1, accounts: 'not a list' })
    const error = await rejectionOf(store.initialize())
    expect(error).toBeInstanceOf(PoolOperationError)
    expect(error).toMatchObject({ operation: 'initialize', kind: 'load-error' })
  })

  it('fails retryably with nothing written when its lease is lost before the write', async () => {
    await s.writeConfig(legacyConfig)
    const before = await s.bytes()
    const store = s.open({
      onStep: async (step) => {
        if (step === 'before-config-write')
          await stealLease(s.configPath, 'save')
      },
    })
    const error = await rejectionOf(store.initialize())
    expect(error).toMatchObject({
      operation: 'initialize',
      kind: 'lock-ownership',
      retryable: true,
      phase: 'before-first-write',
    })
    expect(await s.bytes()).toEqual(before)
  })
})
