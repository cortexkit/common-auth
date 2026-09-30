import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { POOL_KEY, PoolOperationError } from '../../src/store/index.js'
import {
  isAccountStore,
  loadAccounts,
  migrateIfNeeded,
  mutateAccounts,
} from '../fixtures/legacy-openai-auth/accounts.js'
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

describe('store shapes', () => {
  it('a missing config loads as an empty pool', async () => {
    const store = s.open()
    expect(await store.load()).toEqual({
      status: 'ready',
      schemaVersion: 1,
      rows: [],
    })
    expect(await s.bytes()).toEqual({ config: null, state: null })
  })

  it('a config without accounts is an empty roster and the first add writes the legacy shape beside the pool key', async () => {
    await s.writeConfig({ webSockets: true })
    const store = s.open({ now: () => 1_000 })
    expect(await store.load()).toMatchObject({ status: 'ready', rows: [] })
    await store.add({ id: 'a', credential: oauth('r-a') })

    const config = await s.config()
    expect(Object.keys(config).sort()).toEqual(
      ['webSockets', 'version', 'accounts', POOL_KEY].sort(),
    )
    expect(config.webSockets).toBe(true)
    expect(config.version).toBe(1)
    expect(config.accounts).toEqual([
      { id: 'a', type: 'oauth', addedAt: 1_000 },
    ])
    expect(config[POOL_KEY]).toEqual({
      schemaVersion: 1,
      rows: { a: { credentialEpoch: 1, needsFirstReading: true } },
    })
    expect('mainAccountId' in config).toBe(false)

    const before = await s.bytes()
    expect(isAccountStore(config)).toBe(true)
    await migrateIfNeeded(
      {
        type: 'oauth',
        access: 'slot-access',
        refresh: 'slot-refresh',
        expires: 1,
      },
      s.paths,
    )
    expect(await s.bytes()).toEqual(before)
  })

  it('a legacy roster without the pool key is pending migration and every write refuses with both files unchanged', async () => {
    await s.writeConfig({
      version: 1,
      accounts: [{ id: 'x', type: 'oauth' }],
    })
    await s.writeState({ version: 1, accounts: { x: { refresh: 'r-x' } } })
    const before = await s.bytes()
    let pulls = 0
    const store = s.open({
      pull: async () => {
        pulls++
        return {}
      },
    })

    const load = await store.load()
    expect(load).toEqual({
      status: 'pending-migration',
      roster: [{ id: 'x', type: 'oauth' }],
    })
    const attempts = [
      () => store.add({ id: 'y', credential: oauth('r-y') }),
      () => store.disable('x', 'manual'),
      () =>
        store.refresh('x', async () => ({
          access: 'a',
          refresh: 'b',
          expires: 1,
        })),
      () => store.recordQuota('x', { credentialEpoch: 1 }, { used: 1 }),
      () => store.replace('x', oauth('r-z')),
      () => store.rotate('x', oauth('r-z')),
      () => store.recordIdentity('x', 'acct-x'),
    ]
    for (const attempt of attempts) {
      const error = await rejectionOf(attempt())
      expect(error).toBeInstanceOf(PoolOperationError)
      expect(error.kind).toBe('pending-migration')
    }
    store.requestReading('x')
    await store.pullsSettled()
    expect(pulls).toBe(0)
    expect(await s.bytes()).toEqual(before)
  })

  it('malformed JSON, a non-object root and a newer schemaVersion in the config are load errors that refuse every write', async () => {
    const variants = [
      '{ not json',
      '[1, 2]\n',
      `${JSON.stringify({ version: 1, accounts: [], [POOL_KEY]: { schemaVersion: 2, rows: {} } })}\n`,
      `${JSON.stringify({ version: 1, accounts: [], [POOL_KEY]: 'broken' })}\n`,
    ]
    for (const text of variants) {
      await Bun.write(s.configPath, text)
      await s.writeState({ version: 1, accounts: {} })
      const before = await s.bytes()
      const store = s.open()
      expect(await store.load()).toMatchObject({
        status: 'error',
        file: 'config',
      })
      const error = await rejectionOf(
        store.add({ id: 'a', credential: oauth('r-a') }),
      )
      expect(error.kind).toBe('load-error')
      expect(await s.bytes()).toEqual(before)
    }
  })

  it('a malformed or non-object state file beside a valid config is a load error that refuses every write', async () => {
    for (const text of ['{ nope', '"a string"\n', '{"accounts": []}\n']) {
      await s.writeConfig({
        version: 1,
        accounts: [],
        [POOL_KEY]: { schemaVersion: 1, rows: {} },
      })
      await Bun.write(s.statePath, text)
      const before = await s.bytes()
      const store = s.open()
      expect(await store.load()).toMatchObject({
        status: 'error',
        file: 'state',
      })
      const error = await rejectionOf(
        store.add({ id: 'a', credential: oauth('r-a') }),
      )
      expect(error.kind).toBe('load-error')
      expect(await s.bytes()).toEqual(before)
    }
  })

  it('a missing state file leaves a two-row roster loading without credentials and the first write creates it', async () => {
    await s.writeConfig({
      version: 1,
      accounts: [
        { id: 'a', type: 'oauth' },
        { id: 'b', type: 'oauth' },
      ],
      [POOL_KEY]: {
        schemaVersion: 1,
        rows: { a: { credentialEpoch: 1 }, b: { credentialEpoch: 1 } },
      },
    })
    const store = s.open()
    const load = await store.load()
    if (load.status !== 'ready') throw new Error('expected ready')
    expect(
      load.rows.map((row) => [row.id, row.credential, row.candidate]),
    ).toEqual([
      ['a', undefined, false],
      ['b', undefined, false],
    ])
    const refresh = await rejectionOf(
      store.refresh('a', async () => ({
        access: 'x',
        refresh: 'y',
        expires: 1,
      })),
    )
    expect(refresh.kind).toBe('no-credential')
    await store.disable('b', 'manual')
    expect(await s.state()).toBeNull()
    await store.add({ id: 'c', credential: oauth('r-c') })
    expect(Object.keys((await s.state()).accounts)).toEqual(['c'])
  })

  it('a roster entry the legacy normaliser rejects survives a sibling write verbatim and is never a candidate', async () => {
    const broken = { id: 'bad', type: 'api', baseURL: 'not a url', note: 1 }
    await s.writeConfig({
      version: 1,
      accounts: [broken, { id: 'a', type: 'oauth' }],
      [POOL_KEY]: { schemaVersion: 1, rows: { a: { credentialEpoch: 1 } } },
    })
    await s.writeState({
      version: 1,
      accounts: { a: { refresh: 'r-a' }, bad: { apiKey: 'k' } },
    })
    const store = s.open()
    const load = await store.load()
    if (load.status !== 'ready') throw new Error('expected ready')
    expect(load.rows.find((row) => row.id === 'bad')).toMatchObject({
      invalid: 'roster',
      candidate: false,
    })
    expect(load.rows.find((row) => row.id === 'a')?.candidate).toBe(true)
    await store.add({ id: 'c', credential: oauth('r-c') })
    expect((await s.config()).accounts[0]).toEqual(broken)
    expect((await store.read()).status).toBe('ready')
  })

  it('a malformed per-row entry survives a sibling write verbatim and is never a candidate', async () => {
    const malformed = { credentialEpoch: 'one', extra: [1, 2] }
    await s.writeConfig({
      version: 1,
      accounts: [
        { id: 'a', type: 'oauth' },
        { id: 'b', type: 'oauth' },
      ],
      [POOL_KEY]: {
        schemaVersion: 1,
        rows: { a: malformed, b: { credentialEpoch: 1 } },
      },
    })
    await s.writeState({
      version: 1,
      accounts: { a: { refresh: 'r-a' }, b: { refresh: 'r-b' } },
    })
    const store = s.open()
    const load = await store.load()
    if (load.status !== 'ready') throw new Error('expected ready')
    expect(load.rows[0]).toMatchObject({
      id: 'a',
      invalid: 'entry',
      candidate: false,
    })
    expect(load.rows[1]).toMatchObject({ id: 'b', candidate: true })
    await store.disable('b', 'manual')
    expect((await s.config())[POOL_KEY].rows.a).toEqual(malformed)
    const error = await rejectionOf(
      store.refresh('a', async () => ({
        access: 'x',
        refresh: 'y',
        expires: 1,
      })),
    )
    expect(error.kind).toBe('invalid-row')
  })

  it('load at the current schema version writes neither file', async () => {
    const seed = s.open()
    await seed.add({ id: 'a', credential: oauth('r-a') })
    await seed.add({ id: 'k', credential: apiKey('key-k') })
    await seed.pullsSettled()
    const before = await s.bytes()
    const load = await s.open().load()
    expect(load.status).toBe('ready')
    expect(await s.bytes()).toEqual(before)
  })

  it('add, reload and a second add succeed with no host-slot or custody adapter', async () => {
    await s.open().add({ id: 'a', credential: oauth('r-a') })
    const reloaded = s.open()
    const load = await reloaded.load()
    expect(load.status).toBe('ready')
    await reloaded.add({ id: 'b', credential: oauth('r-b') })
    const again = await reloaded.read()
    if (again.status !== 'ready') throw new Error('expected ready')
    expect(again.rows.map((row) => row.id)).toEqual(['a', 'b'])
  })

  it('the unlocked legacy config read never observes a partial file during library writes', async () => {
    const store = s.open()
    await store.add({ id: 'seed', credential: oauth('r-seed') })
    const observed: string[] = []
    let stop = false
    const reader = (async () => {
      while (!stop) {
        try {
          observed.push(await readFile(s.configPath, 'utf8'))
        } catch {}
        await new Promise((resolve) => setImmediate(resolve))
      }
    })()
    const names: string[] = []
    const watcher = watch(s.dir, (_event, name) => {
      if (name) names.push(String(name))
    })
    for (let index = 0; index < 20; index++)
      await store.add({ id: `r${index}`, credential: oauth(`r-${index}`) })
    stop = true
    await reader
    watcher.close()
    expect(observed.length).toBeGreaterThan(0)
    for (const text of observed) expect(() => JSON.parse(text)).not.toThrow()
    // Every config write went through a temp file renamed into place.
    expect(names.some((name) => /openai-auth\.json\..+\.tmp$/.test(name))).toBe(
      true,
    )
    const legacy = await loadAccounts(s.paths)
    expect(legacy?.accounts.length).toBe(21)
  })

  it('ids are kept verbatim and ids the legacy reader would rename are refused', async () => {
    const store = s.open()
    await store.add({ id: 'Mixed.Case-id_1', credential: oauth('r-1') })
    expect((await s.config()).accounts[0].id).toBe('Mixed.Case-id_1')
    for (const id of [' padded', 'padded ', '', '__proto__']) {
      const error = await rejectionOf(
        store.add({ id, credential: oauth(`r${id}`) }),
      )
      expect(error.kind).toBe('invalid-input')
    }
    await mutateAccounts(() => undefined, s.paths)
    expect((await s.config()).accounts[0].id).toBe('Mixed.Case-id_1')
  })

  it('library writes preserve unknown pool keys and unknown per-row entry keys', async () => {
    const store = s.open()
    await store.add({ id: 'a', credential: oauth('r-a') })
    const config = await s.config()
    config[POOL_KEY].futureKey = { keep: true }
    config[POOL_KEY].rows.a.futureField = 'kept'
    config.topLevelUnknown = [1]
    await s.writeConfig(config)
    await store.disable('a', 'manual')
    const after = await s.config()
    expect(after[POOL_KEY].futureKey).toEqual({ keep: true })
    expect(after[POOL_KEY].rows.a.futureField).toBe('kept')
    expect(after.topLevelUnknown).toEqual([1])
  })
})
