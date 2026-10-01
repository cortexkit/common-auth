import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { withLock } from '../../src/fs/with-lock.js'
import {
  type LockEvent,
  POOL_KEY,
  type WriteStep,
} from '../../src/store/index.js'
import { loadAccounts } from '../fixtures/legacy-openai-auth/accounts.js'
import {
  apiKey,
  CRASH_EXIT_CODE,
  deferred,
  type ParsedJson,
  oauth,
  rejectionOf,
  runChild,
  type Scenario,
  scenario,
  settlesWithin,
} from './helpers.js'

let s: Scenario
beforeEach(async () => {
  s = await scenario()
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
  await store.disable('b', 'manual')
}

async function storeOrder() {
  const load = await s.open().read()
  if (load.status !== 'ready') throw new Error(`pool is ${load.status}`)
  return load.rows.map((row) => row.id)
}

/** What the legacy openai-auth reader loads: id and secret per row, in order. */
async function legacyRows() {
  const storage = await loadAccounts(s.paths)
  if (!storage) throw new Error('legacy reader found no config')
  return storage.accounts.map((account) => [
    account.id,
    account.type === 'api' ? account.apiKey : account.refresh,
  ])
}

/** Each row's roster row and pool entry, serialized, keyed by id. */
function rowBytes(config: ParsedJson) {
  const out: Record<string, { roster: string; entry: string }> = {}
  for (const raw of config.accounts)
    out[raw.id] = {
      roster: JSON.stringify(raw),
      entry: JSON.stringify(config[POOL_KEY].rows[raw.id]),
    }
  return out
}

describe('reorder', () => {
  it('reorder sets the roster order, leaves every row byte-identical, and the legacy reader loads the new order', async () => {
    await populate()
    const before = await s.config()
    const stateBefore = (await s.bytes()).state
    expect(await legacyRows()).toEqual([
      ['a', 'r-a'],
      ['b', 'r-b'],
      ['k', 'key-k'],
    ])
    const store = s.open()
    expect(await store.reorder(['k', 'a', 'b'])).toEqual({
      ids: ['k', 'a', 'b'],
      outcome: 'reordered',
    })
    const after = await s.config()
    expect(after.accounts.map((row: { id: string }) => row.id)).toEqual([
      'k',
      'a',
      'b',
    ])
    expect(rowBytes(after)).toEqual(rowBytes(before))
    // The state file holds the credentials; a reorder never writes it.
    expect((await s.bytes()).state).toBe(stateBefore)
    expect(await storeOrder()).toEqual(['k', 'a', 'b'])
    expect(await legacyRows()).toEqual([
      ['k', 'key-k'],
      ['a', 'r-a'],
      ['b', 'r-b'],
    ])
    // The older reader keeps the disabled flag on the moved row.
    const legacy = await loadAccounts(s.paths)
    expect(legacy?.accounts[2]).toMatchObject({ id: 'b', enabled: false })
    // The current order again writes nothing.
    const unchanged = await s.bytes()
    expect(await store.reorder(['k', 'a', 'b'])).toEqual({
      ids: ['k', 'a', 'b'],
      outcome: 'unchanged',
    })
    expect(await s.bytes()).toEqual(unchanged)
  })

  it('reorder refuses a missing id, an unknown id, a duplicate id and a non-string id with both files unchanged', async () => {
    await populate()
    const before = await s.bytes()
    const failures: string[] = []
    const onFailure = (error: { kind: string; operation: string }) =>
      void failures.push(`${error.operation} ${error.kind}`)
    const store = s.open()
    const cases: Array<[unknown[], string]> = [
      [['a', 'b'], 'the order leaves out roster id(s) k'],
      [['a', 'b', 'k', 'x'], 'id x is not in the roster'],
      [['a', 'b', 'x'], 'id x is not in the roster'],
      [['a', 'a', 'b', 'k'], 'id a appears more than once'],
      [['a', 'b', 'k', 'k'], 'id k appears more than once'],
      [['a', 'b', 7], 'ids must be an array of roster ids'],
    ]
    for (const [ids, message] of cases) {
      const error = await rejectionOf(
        store.reorder(ids as string[], { onFailure }),
      )
      expect({ ids, error }).toMatchObject({
        ids,
        error: {
          operation: 'reorder',
          kind: 'invalid-order',
          phase: 'before-first-write',
          retryable: false,
          message,
        },
      })
      expect(await s.bytes()).toEqual(before)
    }
    expect(failures).toEqual(cases.map(() => 'reorder invalid-order'))
  })

  // reorder changes no row's credential, identity or quota, so it takes no row
  // or provider-wide lock: only the caller's extra locks, then the store
  // locks. A caller holding legacy locks around the roster passes them as
  // extraLocks, and reorder waits for them without blocking store writes.
  it('reorder takes extra locks before the store locks, waits on a held extra lock and completes once it is released', async () => {
    await populate()
    const log: string[] = []
    const onLockEvent = (event: LockEvent) => {
      if (event.type !== 'acquired') return
      log.push(
        `${event.name}@${event.path === s.configPath ? 'config' : 'state'}`,
      )
    }
    const held = deferred()
    const release = deferred()
    const holder = withLock(
      s.statePath,
      { name: 'extra-1', ttlMs: 10_000, timeoutMs: 5_000 },
      async () => {
        held.resolve()
        await release.promise
      },
    )
    await held.promise
    const reorder = s.open({ onLockEvent }).reorder(['k', 'b', 'a'], {
      extraLocks: [
        { name: 'extra-1', path: s.statePath },
        { name: 'extra-2', path: s.statePath },
      ],
    })
    expect(await settlesWithin(reorder, 300)).toBe(false)
    // While reorder waits on the extra lock, a store write still gets the
    // store locks: reorder has not taken them yet.
    expect(await settlesWithin(s.open().enable('b'), 2_000)).toBe(true)
    expect(await storeOrder()).toEqual(['a', 'b', 'k'])
    expect(log).toEqual([])
    release.resolve()
    await holder
    expect(await reorder).toEqual({
      ids: ['k', 'b', 'a'],
      outcome: 'reordered',
    })
    expect(log).toEqual([
      'extra-1@state',
      'extra-2@state',
      'save@config',
      'save@state',
    ])
    expect(await storeOrder()).toEqual(['k', 'b', 'a'])
    const rows = await s.open().read()
    if (rows.status !== 'ready') throw new Error('expected ready')
    expect(rows.rows.find((row) => row.id === 'b')?.enabled).toBe(true)
  })

  const steps: Array<[WriteStep, 'old' | 'new']> = [
    ['before-config-write', 'old'],
    ['after-config-write', 'new'],
  ]
  for (const [step, seenAs] of steps) {
    it(`a crash at ${step} of reorder leaves the whole old order or the whole new one`, async () => {
      await populate()
      const stateBefore = (await s.bytes()).state
      const child = runChild({
        configPath: s.configPath,
        statePath: s.statePath,
        op: 'reorder',
        id: '',
        ids: ['b', 'k', 'a'],
        exitAt: step,
      })
      expect(await child.exited).toBe(CRASH_EXIT_CODE)
      const order = seenAs === 'old' ? ['a', 'b', 'k'] : ['b', 'k', 'a']
      expect(await storeOrder()).toEqual(order)
      expect((await legacyRows()).map(([id]) => id)).toEqual(order)
      // A reorder never writes the state file, so no crash point changes it.
      expect((await s.bytes()).state).toBe(stateBefore)
    })
  }
})
