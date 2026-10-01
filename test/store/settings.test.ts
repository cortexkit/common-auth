import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  type LockEvent,
  POOL_KEY,
  POOL_OWNED_KEYS,
  type PoolSettings,
} from '../../src/store/index.js'
import { loadAccounts } from '../fixtures/legacy-openai-auth/accounts.js'
import {
  apiKey,
  oauth,
  rejectionOf,
  type Scenario,
  scenario,
} from './helpers.js'

let s: Scenario
beforeEach(async () => {
  s = await scenario()
})
afterEach(() => s.cleanup())

async function populate() {
  const store = s.open()
  await store.add({ id: 'a', credential: oauth('r-a'), identity: 'acct-a' })
  await store.add({ id: 'k', credential: apiKey('key-k') })
  // A key an older writer put there; settings writes must keep it.
  const config = await s.config()
  await s.writeConfig({
    ...config,
    main: { type: 'opencode' },
    logging: { level: 'info' },
  })
}

describe('updateSettings', () => {
  it('updateSettings writes settings beside the pool, keeping every pool-owned key and the state file unchanged', async () => {
    await populate()
    const before = await s.config()
    const stateBefore = (await s.bytes()).state
    const store = s.open()
    const read = await store.readSettings()
    expect(read).toEqual({
      status: 'ready',
      settings: { main: { type: 'opencode' }, logging: { level: 'info' } },
    })
    const result = await store.updateSettings((settings) => {
      settings.routing = { mode: 'sticky-balanced' }
      ;(settings.logging as Record<string, unknown>).level = 'debug'
      return undefined
    })
    expect(result).toEqual({
      outcome: 'updated',
      settings: {
        main: { type: 'opencode' },
        logging: { level: 'debug' },
        routing: { mode: 'sticky-balanced' },
      },
    })
    const after = await s.config()
    for (const key of POOL_OWNED_KEYS) expect(after[key]).toEqual(before[key])
    expect(after.main).toEqual({ type: 'opencode' })
    expect(after.routing).toEqual({ mode: 'sticky-balanced' })
    expect((await s.bytes()).state).toBe(stateBefore)
    // The older reader still loads every row and credential.
    const legacy = await loadAccounts(s.paths)
    expect(
      legacy?.accounts.map((account) => [
        account.id,
        account.type === 'api' ? account.apiKey : account.refresh,
      ]),
    ).toEqual([
      ['a', 'r-a'],
      ['k', 'key-k'],
    ])
    // A returned object that equals the current settings writes nothing.
    const unchanged = await s.bytes()
    const again = await store.updateSettings((settings) => ({ ...settings }))
    expect(again.outcome).toBe('unchanged')
    expect(await s.bytes()).toEqual(unchanged)
  })

  it('updateSettings refuses a result that sets a pool-owned key, with both files unchanged', async () => {
    await populate()
    const before = await s.bytes()
    const store = s.open()
    const failures: string[] = []
    const mutators: Array<
      (settings: PoolSettings) => PoolSettings | undefined
    > = [
      (settings) => {
        settings.accounts = []
        return undefined
      },
      (settings) => ({ ...settings, [POOL_KEY]: { schemaVersion: 1 } }),
      (settings) => ({ ...settings, version: 2 }),
    ]
    for (const mutator of mutators) {
      const error = await rejectionOf(
        store.updateSettings(mutator, {
          onFailure: (failure) =>
            void failures.push(`${failure.operation} ${failure.kind}`),
        }),
      )
      expect(error).toMatchObject({
        operation: 'updateSettings',
        kind: 'invalid-input',
        phase: 'before-first-write',
      })
      expect(error.message).toContain('pool-owned key')
      expect(await s.bytes()).toEqual(before)
    }
    expect(failures).toEqual(mutators.map(() => 'updateSettings invalid-input'))
  })

  it('updateSettings refuses a pending-migration pool and a store call from inside the mutator, writing nothing', async () => {
    await s.writeConfig({ version: 1, accounts: [{ id: 'x', type: 'oauth' }] })
    const legacy = await s.bytes()
    const store = s.open()
    expect(await store.readSettings()).toEqual({
      status: 'pending-migration',
      settings: {},
    })
    let ran = false
    const pending = await rejectionOf(
      store.updateSettings(() => {
        ran = true
        return { logging: { level: 'debug' } }
      }),
    )
    expect(pending).toMatchObject({ kind: 'pending-migration' })
    expect(ran).toBe(false)
    expect(await s.bytes()).toEqual(legacy)

    s.cleanup()
    s = await scenario()
    await populate()
    const before = await s.bytes()
    const ready = s.open()
    const reentry = await rejectionOf(
      ready.updateSettings(async (settings) => {
        await ready.disable('a', 'from inside')
        return settings
      }),
    )
    expect(reentry.operation).toBe('updateSettings')
    expect(String(reentry.message)).toContain('called from inside a store hook')
    expect(await s.bytes()).toEqual(before)
  })

  it('updateSettings takes extra locks before the store locks', async () => {
    await populate()
    const log: string[] = []
    const onLockEvent = (event: LockEvent) => {
      if (event.type !== 'acquired') return
      log.push(
        `${event.name}@${event.path === s.configPath ? 'config' : 'state'}`,
      )
    }
    await s
      .open({ onLockEvent })
      .updateSettings(
        (settings) => ({ ...settings, costZeroing: { enabled: true } }),
        { extraLocks: [{ name: 'extra-1', path: s.statePath }] },
      )
    expect(log).toEqual(['extra-1@state', 'save@config', 'save@state'])
    expect((await s.config()).costZeroing).toEqual({ enabled: true })
  })
})
