import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { acquireRefreshFileLock } from '../../src/fs/refresh-file-lock.js'
import { LockContentionError } from '../../src/fs/with-lock.js'
import {
  POOL_KEY,
  PoolOperationError,
  type WriteStep,
} from '../../src/store/index.js'
import {
  mutateAccounts,
  saveAccountState,
} from '../fixtures/legacy-openai-auth/accounts.js'
import {
  apiKey,
  deferred,
  oauth,
  rejectionOf,
  type Scenario,
  scenario,
  settlesWithin,
} from './helpers.js'

let s: Scenario
beforeEach(async () => {
  s = await scenario()
})
afterEach(() => s.cleanup())

/** A store whose leases all expire when the named write step is reached. */
function expiringAt(step: WriteStep) {
  let clock = Date.now()
  const store = s.open({
    now: () => clock,
    lockOptions: { renew: false },
    onStep: (reached) => {
      if (reached === step) clock += 60_000
    },
  })
  return store
}

async function rowsOf(store = s.open()) {
  const load = await store.read()
  if (load.status !== 'ready') throw new Error(`pool is ${load.status}`)
  return load.rows
}

describe('dedupe and ids', () => {
  it('add of an existing fingerprint rotates that row and returns its id without an epoch bump', async () => {
    const store = s.open()
    await store.add({ id: 'a', credential: oauth('same') })
    const result = await store.add({
      id: 'requested',
      credential: oauth('same', { access: 'fresh-access' }),
    })
    expect(result).toMatchObject({ id: 'a', outcome: 'rotated' })
    const rows = await rowsOf(store)
    expect(rows.map((row) => row.id)).toEqual(['a'])
    expect(rows[0]?.credentialEpoch).toBe(1)
    expect(rows[0]?.credential).toMatchObject({ access: 'fresh-access' })
  })

  it('add with a different identity appends at the end', async () => {
    const store = s.open()
    await store.add({ id: 'a', credential: oauth('r-a'), identity: 'acct-1' })
    await store.add({ id: 'b', credential: oauth('r-b'), identity: 'acct-2' })
    const rows = await rowsOf(store)
    expect(rows.map((row) => [row.id, row.identity, row.enabled])).toEqual([
      ['a', 'acct-1', true],
      ['b', 'acct-2', true],
    ])
  })

  it('add carrying an enabled row identity with a different fingerprint appends the row disabled with its credential on disk', async () => {
    const store = s.open()
    await store.add({ id: 'a', credential: oauth('r-a'), identity: 'acct-1' })
    const result = await store.add({
      id: 'b',
      credential: oauth('r-b'),
      identity: 'acct-1',
    })
    expect(result.outcome).toBe('added-disabled')
    const rows = await rowsOf(store)
    expect(rows[1]).toMatchObject({
      id: 'b',
      enabled: false,
      disabledReason: 'duplicate-identity',
      candidate: false,
    })
    expect((await s.state()).accounts.b.refresh).toBe('r-b')
    expect(rows[0]?.enabled).toBe(true)
  })

  it('recording an identity another enabled row holds disables the later row in roster order without deleting it', async () => {
    const store = s.open()
    await store.add({ id: 'a', credential: oauth('r-a') })
    await store.add({ id: 'b', credential: oauth('r-b'), identity: 'acct-1' })
    const result = await store.recordIdentity('a', 'acct-1', {
      credentialEpoch: 1,
    })
    expect(result.disabled).toEqual(['b'])
    const rows = await rowsOf(store)
    expect(rows.map((row) => [row.id, row.enabled])).toEqual([
      ['a', true],
      ['b', false],
    ])
    expect(rows[1]?.disabledReason).toBe('duplicate-identity')
    expect((await s.state()).accounts.b.refresh).toBe('r-b')
  })

  it('replace does not dedupe, so two enabled rows may hold one credential until the next identity reading', async () => {
    const store = s.open()
    await store.add({ id: 'a', credential: oauth('r-a') })
    await store.add({ id: 'b', credential: oauth('r-b') })
    await store.replace('b', oauth('r-a'))
    let rows = await rowsOf(store)
    expect(rows.map((row) => row.enabled)).toEqual([true, true])
    expect(rows[0]?.fingerprint).toBe(rows[1]?.fingerprint as string)
    await store.recordIdentity('a', 'acct-1', { credentialEpoch: 1 })
    await store.recordIdentity('b', 'acct-1', { credentialEpoch: 2 })
    rows = await rowsOf(store)
    expect(rows.map((row) => row.enabled)).toEqual([true, false])
    expect(rows.length).toBe(2)
  })

  it('add refuses an id that already holds a credential', async () => {
    const store = s.open()
    await store.add({ id: 'a', credential: oauth('r-a') })
    const before = await s.bytes()
    const error = await rejectionOf(
      store.add({ id: 'a', credential: oauth('r-other') }),
    )
    expect(error).toMatchObject({ kind: 'id-exists', retryable: false })
    expect(await s.bytes()).toEqual(before)
  })

  it('replace bumps the epoch, records or clears identity and clears the quota map', async () => {
    const store = s.open()
    await store.add({ id: 'a', credential: oauth('r-a'), identity: 'acct-1' })
    await store.recordQuota('a', { credentialEpoch: 1, identity: 'acct-1' }, 1)
    let row = (await rowsOf(store))[0]
    expect(row?.quota).toEqual({ readings: [1] })
    expect(row?.needsFirstReading).toBe(false)

    const replaced = await store.replace('a', oauth('r-new'))
    expect(replaced.credentialEpoch).toBe(2)
    row = (await rowsOf(store))[0]
    expect(row).toMatchObject({ credentialEpoch: 2, needsFirstReading: true })
    expect(row?.identity).toBeUndefined()
    expect(row?.quota).toBeUndefined()
    expect(row?.credential).toMatchObject({ refresh: 'r-new' })

    await store.replace('a', oauth('r-third'), { identity: 'acct-3' })
    row = (await rowsOf(store))[0]
    expect(row).toMatchObject({ credentialEpoch: 3, identity: 'acct-3' })
  })

  it('an api-key row keeps its baseURL and header in the config and its key in the state', async () => {
    const store = s.open()
    await store.add({
      id: 'k',
      credential: apiKey('secret-key', { authHeader: 'x-api-key' }),
    })
    const config = await s.config()
    expect(config.accounts[0]).toMatchObject({
      id: 'k',
      type: 'api',
      baseURL: 'https://api.example.test/v1',
      authHeader: 'x-api-key',
    })
    expect(JSON.stringify(config)).not.toContain('secret-key')
    // Beside the key, only the stamp naming the epoch it belongs to.
    expect((await s.state()).accounts.k).toEqual({
      apiKey: 'secret-key',
      commonAuthPool: expect.objectContaining({ credentialEpoch: 1 }),
    })
    expect(config[POOL_KEY].rows.k).toEqual({
      credentialEpoch: 1,
      needsFirstReading: false,
    })
  })
})

describe('failure values carry the commit phase', () => {
  it('ownership lost before the first write of add, replace and rotate refuses retryably with both files unchanged', async () => {
    await s.open().add({ id: 'a', credential: oauth('r-a') })
    const cases: Array<
      [WriteStep, (store: ReturnType<typeof expiringAt>) => Promise<unknown>]
    > = [
      [
        'before-state-write',
        (store) => store.add({ id: 'b', credential: oauth('r-b') }),
      ],
      ['before-state-write', (store) => store.replace('a', oauth('r-x'))],
      ['before-state-write', (store) => store.rotate('a', oauth('r-y'))],
    ]
    for (const [step, run] of cases) {
      const before = await s.bytes()
      const hooked: PoolOperationError[] = []
      const store = expiringAt(step)
      const error = await rejectionOf((async () => run(store))())
      expect(error).toBeInstanceOf(PoolOperationError)
      expect(error).toMatchObject({
        kind: 'lock-ownership',
        phase: 'before-first-write',
        retryable: true,
        committed: undefined,
      })
      expect(hooked).toEqual([])
      expect(await s.bytes()).toEqual(before)
    }
  })

  it('ownership lost before the second write of add is a partial commit that leaves only a state entry no reader loads', async () => {
    const store = expiringAt('before-config-write')
    const hooked: PoolOperationError[] = []
    const error = await rejectionOf(
      store.add(
        { id: 'a', credential: oauth('r-a') },
        { onFailure: (_id, failure) => void hooked.push(failure) },
      ),
    )
    expect(error).toMatchObject({
      operation: 'add',
      rowId: 'a',
      kind: 'lock-ownership',
      phase: 'after-first-write',
      retryable: true,
    })
    expect(error.committed).toMatchObject({ refresh: 'r-a' })
    expect(hooked).toEqual([error])
    expect(await rowsOf()).toEqual([])
    expect((await s.state()).accounts.a.refresh).toBe('r-a')
    const added = await s.open().add({ id: 'a', credential: oauth('r-a') })
    expect(added.outcome).toBe('added')
    expect((await rowsOf())[0]).toMatchObject({
      credentialEpoch: 1,
      candidate: true,
    })
  })

  it('ownership lost before the config write of rotate reports after-first-write with the rotated credential', async () => {
    await s.open().add({ id: 'a', credential: oauth('r-a') })
    const store = expiringAt('before-config-write')
    const hooked: PoolOperationError[] = []
    const error = await rejectionOf(
      store.rotate(
        'a',
        oauth('r-rotated'),
        { identity: 'acct-1' },
        {
          onFailure: (_id, failure) => void hooked.push(failure),
        },
      ),
    )
    expect(error).toMatchObject({
      operation: 'rotate',
      rowId: 'a',
      phase: 'after-first-write',
      kind: 'lock-ownership',
    })
    expect(error.committed).toMatchObject({
      type: 'oauth',
      refresh: 'r-rotated',
    })
    expect(hooked).toEqual([error])
    expect((await s.state()).accounts.a.refresh).toBe('r-rotated')
    expect((await rowsOf())[0]?.identity).toBeUndefined()
  })

  it('ownership lost before the config write of replace reports after-first-write with the committed credential and leaves the row torn', async () => {
    await s.open().add({ id: 'a', credential: oauth('r-a') })
    const store = expiringAt('before-config-write')
    const hooked: PoolOperationError[] = []
    const error = await rejectionOf(
      store.replace(
        'a',
        oauth('r-new'),
        {},
        {
          onFailure: (_id, failure) => void hooked.push(failure),
        },
      ),
    )
    expect(error).toMatchObject({
      operation: 'replace',
      rowId: 'a',
      phase: 'after-first-write',
      kind: 'lock-ownership',
    })
    expect(error.committed).toMatchObject({ refresh: 'r-new' })
    expect(hooked).toEqual([error])
    const row = (await rowsOf())[0]
    expect(row).toMatchObject({
      credentialEpoch: 2,
      torn: true,
      candidate: false,
    })
    expect(row?.credential).toMatchObject({ refresh: 'r-new' })
    expect((await s.config())[POOL_KEY].rows.a.credentialEpoch).toBe(1)
  })

  it('a failed disable and a failed record identity reach their failure hook before the first write', async () => {
    await s.open().add({ id: 'a', credential: oauth('r-a') })
    const before = await s.bytes()
    const hooked: PoolOperationError[] = []
    const onFailure = (_id: string, failure: PoolOperationError) =>
      void hooked.push(failure)
    const disableError = await rejectionOf(
      expiringAt('before-config-write').disable('a', 'manual', { onFailure }),
    )
    const identityError = await rejectionOf(
      expiringAt('before-config-write').recordIdentity(
        'a',
        'acct',
        { credentialEpoch: 1 },
        {
          onFailure,
        },
      ),
    )
    expect(hooked).toEqual([disableError, identityError])
    expect(disableError).toMatchObject({
      operation: 'disable',
      phase: 'before-first-write',
      committed: undefined,
    })
    expect(identityError).toMatchObject({
      operation: 'recordIdentity',
      phase: 'before-first-write',
      committed: undefined,
    })
    expect(await s.bytes()).toEqual(before)
  })

  it('a failure hook that throws leaves the partial-commit failure intact and every lock released', async () => {
    await s.open().add({ id: 'a', credential: oauth('r-a') })
    const warnings: string[] = []
    let clock = Date.now()
    const store = s.open({
      now: () => clock,
      lockOptions: { renew: false },
      logger: { warn: (message) => void warnings.push(message) },
      onStep: (step) => {
        if (step === 'before-config-write') clock += 60_000
      },
    })
    const error = await rejectionOf(
      store.rotate(
        'a',
        oauth('r-rotated'),
        { identity: 'acct-1' },
        {
          onFailure: () => {
            throw new Error('hook failure')
          },
        },
      ),
    )
    expect(error).toMatchObject({
      phase: 'after-first-write',
      kind: 'lock-ownership',
    })
    expect(error.committed).toMatchObject({ refresh: 'r-rotated' })
    expect(warnings.length).toBe(1)
    for (const [name, path] of [
      ['save', s.configPath],
      ['save', s.statePath],
      ['row-a', s.statePath],
      ['provider-openai', s.statePath],
    ] as const) {
      const lock = await acquireRefreshFileLock({ name, path, ttlMs: 10_000 })
      expect(lock).not.toBeNull()
      await lock?.release()
    }
  })
})

describe('store concurrency and the store-lock list', () => {
  it('a legacy save lock holder at the config path makes a library write wait and then succeed', async () => {
    const holder = await acquireRefreshFileLock({
      name: 'save',
      path: s.configPath,
      ttlMs: 10_000,
    })
    const add = s.open().add({ id: 'a', credential: oauth('r-a') })
    expect(await settlesWithin(add, 300)).toBe(false)
    await holder?.release()
    expect((await add).outcome).toBe('added')
  })

  it('a legacy save lock holder at the state path makes a library write fail with lock contention after its timeout', async () => {
    const holder = await acquireRefreshFileLock({
      name: 'save',
      path: s.statePath,
      ttlMs: 10_000,
    })
    const error = await rejectionOf(
      s
        .open({ lockOptions: { timeoutMs: 300 } })
        .add({ id: 'a', credential: oauth('r-a') }),
    )
    await holder?.release()
    expect(error).toMatchObject({ kind: 'lock-contention', retryable: true })
    expect(error.cause).toBeInstanceOf(LockContentionError)
    expect(await s.bytes()).toEqual({ config: null, state: null })
  })

  it('a legacy config writer waits for the library store locks and neither write is lost', async () => {
    await s.open().add({ id: 'a', credential: oauth('r-a') })
    const paused = deferred()
    const reached = deferred()
    const store = s.open({
      onStep: async (step) => {
        if (step === 'before-config-write') {
          reached.resolve()
          await paused.promise
        }
      },
    })
    const add = store.add({ id: 'b', credential: oauth('r-b') })
    await reached.promise
    const legacy = mutateAccounts((current) => {
      current.accounts.push({
        id: 'legacy',
        type: 'oauth',
        refresh: 'r-legacy',
      })
      return current
    }, s.paths)
    expect(await settlesWithin(legacy, 300)).toBe(false)
    paused.resolve()
    await Promise.all([add, legacy])
    const ids = (await s.config()).accounts.map((row: any) => row.id)
    expect(ids.sort()).toEqual(['a', 'b', 'legacy'])
    const state = await s.state()
    expect(Object.keys(state.accounts).sort()).toEqual(['a', 'b', 'legacy'])
  })

  it('a legacy state writer waits for the library store locks and neither write is lost', async () => {
    await s.open().add({ id: 'a', credential: oauth('r-a') })
    const paused = deferred()
    const reached = deferred()
    const store = s.open({
      onStep: async (step) => {
        if (step === 'before-state-write') {
          reached.resolve()
          await paused.promise
        }
      },
    })
    const add = store.add({ id: 'b', credential: oauth('r-b') })
    await reached.promise
    const legacy = saveAccountState(
      {
        version: 1,
        accounts: [{ id: 'a', type: 'oauth', refresh: 'r-a', lastUsed: 777 }],
      },
      s.paths,
      { accounts: ['a'] },
    )
    expect(await settlesWithin(legacy, 300)).toBe(false)
    paused.resolve()
    await Promise.all([add, legacy])
    const state = await s.state()
    expect(state.accounts.a.lastUsed).toBe(777)
    expect(state.accounts.b.refresh).toBe('r-b')
  })

  it('two stores in one process adding concurrently lose no write', async () => {
    const one = s.open()
    const two = s.open()
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        (index % 2 ? one : two).add({
          id: `row-${index}`,
          credential: oauth(`r-${index}`),
        }),
      ),
    )
    const rows = await rowsOf()
    expect(rows.map((row) => row.id).sort()).toEqual(
      Array.from({ length: 6 }, (_, index) => `row-${index}`).sort(),
    )
    expect(rows.every((row) => row.candidate)).toBe(true)
  })
})
