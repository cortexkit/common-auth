import { beforeEach, expect } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import {
  type PoolLoad,
  type PoolRow,
  type PoolStore,
  PROVIDER_STATE_KEY,
  type ProviderStateCodec,
  type WriteStep,
} from '../../src/store/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import {
  oauth,
  type ParsedJson,
  rejectionOf,
  runChild,
  type Scenario,
  scenario,
} from './helpers.js'

const hooks = lifetimeHooks()
const { afterEach, test } = hooks

let s: Scenario
beforeEach(async () => {
  s = hooks.lifetime.manage(await scenario())
})
afterEach(() => s.cleanup())

/**
 * The provider state the tests keep: a project and a device fingerprint and
 * an eligibility time, which belong to the credential, and a cooldown, which
 * only tracks its use.
 */
type Acct = {
  project?: string
  fingerprint?: string
  disabledAt?: number
  cooldownUntil?: number
}

function isAcct(value: unknown): value is Acct {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false
  const v = value as Record<string, unknown>
  return (
    (v.project === undefined || typeof v.project === 'string') &&
    (v.fingerprint === undefined || typeof v.fingerprint === 'string') &&
    (v.disabledAt === undefined || typeof v.disabledAt === 'number') &&
    (v.cooldownUntil === undefined || typeof v.cooldownUntil === 'number')
  )
}

const stateCodec: ProviderStateCodec = {
  validate: isAcct,
  credentialBound: (value) => {
    const v = value as Acct
    return {
      project: v.project ?? null,
      fingerprint: v.fingerprint ?? null,
      disabledAt: v.disabledAt ?? null,
    }
  },
}

function open(overrides: Parameters<Scenario['open']>[0] = {}): PoolStore {
  return s.open({ providerState: stateCodec, ...overrides })
}

function rowsOf(load: PoolLoad): PoolRow[] {
  if (load.status !== 'ready') throw new Error(`expected ready: ${load.status}`)
  return load.rows
}

async function rowOf(store: PoolStore, id: string): Promise<PoolRow> {
  const row = rowsOf(await store.read()).find(
    (candidate) => candidate.id === id,
  )
  if (!row) throw new Error(`no row ${id}`)
  return row
}

/** The refresh token and the project a reader sees on a row, as one pair. */
async function pairOf(store: PoolStore, id: string): Promise<string> {
  const row = await rowOf(store, id)
  const refresh =
    row.credential?.type === 'oauth' ? row.credential.refresh : 'none'
  const project = (row.providerState as Acct | undefined)?.project ?? 'none'
  return `${refresh}/${project}`
}

async function addAB(store: PoolStore): Promise<void> {
  await store.add({
    id: 'a',
    credential: oauth('r-a1'),
    identity: 'acct-a',
    providerState: { project: 'P1', fingerprint: 'F1' },
  })
  await store.add({
    id: 'b',
    credential: oauth('r-b1'),
    identity: 'acct-b',
    providerState: { project: 'P2', fingerprint: 'F2' },
  })
}

function refreshTo(refresh: string, providerState?: unknown) {
  return async () => ({
    access: `access-${refresh}`,
    refresh,
    expires: 4_000_000_000_000,
    ...(providerState !== undefined ? { providerState } : {}),
  })
}

async function editState(edit: (state: ParsedJson) => void): Promise<void> {
  const state = await s.state()
  edit(state)
  await s.writeState(state)
}

async function editConfig(edit: (config: ParsedJson) => void): Promise<void> {
  const config = await s.config()
  edit(config)
  await s.writeConfig(config)
}

test('rows added with provider state each load their own, and a refresh of one moves only that row', async () => {
  const store = open()
  await addAB(store)
  expect((await rowOf(store, 'a')).providerState).toEqual({
    project: 'P1',
    fingerprint: 'F1',
  })
  const bBefore = JSON.stringify((await s.state()).accounts.b)

  await store.refresh(
    'a',
    refreshTo('r-a2', { project: 'P3', fingerprint: 'F1' }),
  )

  const a = await rowOf(store, 'a')
  expect(a.credential?.type === 'oauth' && a.credential.refresh).toBe('r-a2')
  expect(a.providerState).toEqual({ project: 'P3', fingerprint: 'F1' })
  expect((await rowOf(store, 'b')).providerState).toEqual({
    project: 'P2',
    fingerprint: 'F2',
  })
  expect(JSON.stringify((await s.state()).accounts.b)).toBe(bBefore)
  // A refresh whose provider returns no state keeps the row's.
  await store.refresh('a', refreshTo('r-a3'))
  expect((await rowOf(store, 'a')).providerState).toEqual({
    project: 'P3',
    fingerprint: 'F1',
  })
})

test('a replace of one row moves only that row to the provider state given with it', async () => {
  const store = open()
  await addAB(store)
  const bBefore = JSON.stringify((await s.state()).accounts.b)

  const result = await store.replace('a', oauth('r-a2'), {
    identity: 'acct-a2',
    providerState: { project: 'P3', fingerprint: 'F3' },
  })

  expect(result.credentialEpoch).toBe(2)
  const a = await rowOf(store, 'a')
  expect(a.providerState).toEqual({ project: 'P3', fingerprint: 'F3' })
  expect(a.stamp).toBe('bound')
  expect((await rowOf(store, 'b')).providerState).toEqual({
    project: 'P2',
    fingerprint: 'F2',
  })
  expect(JSON.stringify((await s.state()).accounts.b)).toBe(bBefore)
})

test('a provider-state update read at an older credential epoch is refused', async () => {
  const store = open()
  await addAB(store)
  const seen = await rowOf(store, 'a')
  await store.replace('a', oauth('r-a2'), {
    identity: 'acct-a',
    providerState: { project: 'P3' },
  })
  const before = await s.bytes()

  const error = await rejectionOf(
    store.updateProviderState(
      'a',
      { credentialEpoch: seen.credentialEpoch ?? 1, identity: seen.identity },
      () => ({ project: 'P1-stale' }),
    ),
  )

  expect(error.kind).toBe('attribution')
  expect(error.retryable).toBe(true)
  expect(await s.bytes()).toEqual(before)
  expect((await rowOf(store, 'a')).providerState).toEqual({ project: 'P3' })
})

test('a provider-state update read for an identity the row no longer records is refused', async () => {
  const store = open()
  await store.add({
    id: 'a',
    credential: oauth('r-a1'),
    providerState: { project: 'P1' },
  })
  await store.recordIdentity('a', 'acct-a', { credentialEpoch: 1 })
  const before = await s.bytes()

  // Read before the identity was learnt: no identity.
  const stale = await rejectionOf(
    store.updateProviderState('a', { credentialEpoch: 1 }, () => ({
      project: 'P-stale',
    })),
  )
  const other = await rejectionOf(
    store.updateProviderState(
      'a',
      { credentialEpoch: 1, identity: 'acct-x' },
      () => ({ project: 'P-other' }),
    ),
  )

  expect(stale.kind).toBe('attribution')
  expect(other.kind).toBe('attribution')
  expect(await s.bytes()).toEqual(before)
  const result = await store.updateProviderState(
    'a',
    { credentialEpoch: 1, identity: 'acct-a' },
    () => ({ project: 'P2' }),
  )
  expect(result).toEqual({
    id: 'a',
    outcome: 'updated',
    providerState: { project: 'P2' },
  })
})

/** Runs `operation` with the store stopped (by a throw) at `step`. */
async function stoppedAt(
  step: WriteStep,
  operation: (store: PoolStore) => Promise<unknown>,
): Promise<void> {
  const store = open({
    onStep: (reached) => {
      if (reached === step) throw new Error(`stopped at ${step}`)
    },
  })
  await rejectionOf(operation(store))
}

test('a replace stopped at either write point never pairs a credential with the other credential provider state', async () => {
  const replace = (store: PoolStore) =>
    store.replace('a', oauth('r-a2'), {
      identity: 'acct-a',
      providerState: { project: 'P3' },
    })
  const expected: Record<string, string> = {
    'before-state-write': 'r-a1/P1',
    'after-state-write': 'r-a2/P3',
    'before-config-write': 'r-a2/P3',
    'after-config-write': 'r-a2/P3',
  }
  for (const [step, pair] of Object.entries(expected)) {
    s.cleanup()
    s = hooks.lifetime.manage(await scenario())
    await addAB(open())
    await stoppedAt(step as WriteStep, replace)
    const reader = open()
    expect(`${step}: ${await pairOf(reader, 'a')}`).toBe(`${step}: ${pair}`)
    const a = await rowOf(reader, 'a')
    // Between the writes the row is torn: shown completed, never a candidate.
    if (step === 'after-state-write' || step === 'before-config-write')
      expect(a.torn).toBe(true)
    expect(await pairOf(reader, 'b')).toBe('r-b1/P2')
  }
})

test('a rotate or refresh stopped at either write point never pairs a credential with the other credential provider state', async () => {
  const operations: Record<string, (store: PoolStore) => Promise<unknown>> = {
    // A rotate that learns the identity writes the state file, then the config.
    rotate: (store) =>
      store.rotate('a', oauth('r-a2'), {
        identity: 'acct-a',
        providerState: { project: 'P3' },
      }),
    refresh: (store) =>
      store.refresh('a', async () => ({
        access: 'access-r-a2',
        refresh: 'r-a2',
        expires: 4_000_000_000_000,
        identity: 'acct-a',
        providerState: { project: 'P3' },
      })),
  }
  for (const [name, operation] of Object.entries(operations)) {
    for (const step of [
      'before-state-write',
      'after-state-write',
      'before-config-write',
    ] as const) {
      s.cleanup()
      s = hooks.lifetime.manage(await scenario())
      await open().add({
        id: 'a',
        credential: oauth('r-a1'),
        providerState: { project: 'P1' },
      })
      await stoppedAt(step, operation)
      const pair = await pairOf(open(), 'a')
      expect(`${name} ${step}: ${pair}`).toBe(
        `${name} ${step}: ${step === 'before-state-write' ? 'r-a1/P1' : 'r-a2/P3'}`,
      )
    }
  }
})

test('a reader interleaved with every write point sees each credential only with its own provider state', async () => {
  await addAB(open())
  const reader = open()
  const seen: string[] = []
  const store = open({
    onStep: async (_step, info) => {
      if (info.rowId === 'a') seen.push(await pairOf(reader, 'a'))
    },
  })
  await store.replace('a', oauth('r-a2'), {
    identity: 'acct-a',
    providerState: { project: 'P2a' },
  })
  await store.rotate('a', oauth('r-a3'), { providerState: { project: 'P3' } })
  await store.refresh('a', refreshTo('r-a4', { project: 'P4' }))

  const allowed = new Set(['r-a1/P1', 'r-a2/P2a', 'r-a3/P3', 'r-a4/P4'])
  expect(seen.length).toBeGreaterThanOrEqual(8)
  expect(seen.filter((pair) => !allowed.has(pair))).toEqual([])
  expect(seen).toContain('r-a2/P2a')
  expect(seen).toContain('r-a4/P4')
})

test('removing a row clears its provider state and a writer that read it before cannot bring it back', async () => {
  const store = open()
  await addAB(store)
  const seen = await rowOf(store, 'a')
  const fence = {
    credentialEpoch: seen.credentialEpoch ?? 1,
    identity: seen.identity,
  }

  await store.remove('a')
  expect(Object.hasOwn((await s.state()).accounts, 'a')).toBe(false)

  const update = await rejectionOf(
    store.updateProviderState('a', fence, () => ({ project: 'P1' })),
  )
  const rotate = await rejectionOf(
    store.rotate('a', oauth('r-a1'), { providerState: { project: 'P1' } }),
  )
  const refresh = await rejectionOf(store.refresh('a', refreshTo('r-a2')))
  const readd = await rejectionOf(
    store.add({
      id: 'a',
      credential: oauth('r-a9'),
      providerState: { project: 'P1' },
    }),
  )
  expect([update.kind, rotate.kind, refresh.kind, readd.kind]).toEqual([
    'unknown-row',
    'unknown-row',
    'unknown-row',
    'id-removed',
  ])
  expect(Object.hasOwn((await s.state()).accounts, 'a')).toBe(false)
  expect((await rowOf(store, 'b')).providerState).toEqual({
    project: 'P2',
    fingerprint: 'F2',
  })
})

test('a removal stopped between its writes leaves a provider state no reader loads and no later add inherits', async () => {
  await addAB(open())
  await stoppedAt('after-config-write', (store) => store.remove('a'))
  expect((await s.state()).accounts.a[PROVIDER_STATE_KEY]).toEqual({
    project: 'P1',
    fingerprint: 'F1',
  })
  expect(rowsOf(await open().read()).map((row) => row.id)).toEqual(['b'])

  // Another process, which has not seen the removal, adds the id again
  // without a provider state: the leftover entry is not carried over.
  const child = runChild({
    ...s.paths,
    op: 'add',
    id: 'a',
    credential: oauth('r-a-new'),
  })
  expect(await child.exited).toBe(0)
  const a = await rowOf(open(), 'a')
  expect(a.providerState).toBeUndefined()
  expect(a.providerStateDropped).toBeUndefined()
  expect(Object.hasOwn((await s.state()).accounts.a, PROVIDER_STATE_KEY)).toBe(
    false,
  )
})

test('the codec merge decides between the provider state on disk and the one a write brings', async () => {
  const calls: unknown[][] = []
  const newestDisabled: ProviderStateCodec = {
    ...stateCodec,
    merge: (onDisk, incoming) => {
      calls.push([onDisk, incoming])
      const a = onDisk as Acct
      const b = incoming as Acct
      return {
        ...a,
        ...b,
        disabledAt: Math.max(a.disabledAt ?? 0, b.disabledAt ?? 0),
      }
    },
  }
  const store = open({ providerState: newestDisabled })
  await store.add({
    id: 'a',
    credential: oauth('r-a1'),
    providerState: { project: 'P1', disabledAt: 200 },
  })
  expect(calls).toEqual([])

  await store.rotate('a', oauth('r-a2'), {
    providerState: { project: 'P1', disabledAt: 100 },
  })
  expect((await rowOf(store, 'a')).providerState).toEqual({
    project: 'P1',
    disabledAt: 200,
  })
  await store.refresh(
    'a',
    refreshTo('r-a3', { project: 'P1', disabledAt: 300 }),
  )
  expect((await rowOf(store, 'a')).providerState).toEqual({
    project: 'P1',
    disabledAt: 300,
  })
  // Re-adding the secret the row holds rotates it, and merges too.
  await store.add({
    id: 'other',
    credential: oauth('r-a3'),
    providerState: { project: 'P1', disabledAt: 250 },
  })
  expect((await rowOf(store, 'a')).providerState).toEqual({
    project: 'P1',
    disabledAt: 300,
  })
  expect(calls).toEqual([
    [
      { project: 'P1', disabledAt: 200 },
      { project: 'P1', disabledAt: 100 },
    ],
    [
      { project: 'P1', disabledAt: 200 },
      { project: 'P1', disabledAt: 300 },
    ],
    [
      { project: 'P1', disabledAt: 300 },
      { project: 'P1', disabledAt: 250 },
    ],
  ])
})

test('replace runs onReplace with the previous provider state and stores what it returns', async () => {
  const calls: unknown[][] = []
  const store = open({
    providerState: {
      ...stateCodec,
      onReplace: (previous, replacement) => {
        calls.push([previous, replacement])
        const prior = previous as Acct | undefined
        return replacement.identity === 'acct-gone'
          ? undefined
          : { fingerprint: prior?.fingerprint, project: 'P-new' }
      },
    },
  })
  await addAB(store)

  await store.replace('a', oauth('r-a2'), {
    identity: 'acct-a',
    providerState: { project: 'P-given' },
  })
  expect((await rowOf(store, 'a')).providerState).toEqual({
    fingerprint: 'F1',
    project: 'P-new',
  })
  await store.replace('a', oauth('r-a3'), { identity: 'acct-gone' })
  const a = await rowOf(store, 'a')
  expect(a.providerState).toBeUndefined()
  expect(a.providerStateDropped).toBeUndefined()
  expect(Object.hasOwn((await s.state()).accounts.a, PROVIDER_STATE_KEY)).toBe(
    false,
  )
  expect(calls).toEqual([
    [
      { project: 'P1', fingerprint: 'F1' },
      {
        id: 'a',
        credentialEpoch: 2,
        identity: 'acct-a',
        incoming: { project: 'P-given' },
      },
    ],
    [
      { fingerprint: 'F1', project: 'P-new' },
      { id: 'a', credentialEpoch: 3, identity: 'acct-gone' },
    ],
  ])
})

test('replace without onReplace clears the provider state unless one is given with it', async () => {
  const store = open()
  await addAB(store)

  await store.replace('a', oauth('r-a2'), { identity: 'acct-a' })

  const a = await rowOf(store, 'a')
  expect(a.providerState).toBeUndefined()
  expect(a.providerStateDropped).toBeUndefined()
  const account = (await s.state()).accounts.a
  expect(Object.hasOwn(account, PROVIDER_STATE_KEY)).toBe(false)
  expect(Object.hasOwn(account.commonAuthPool, 'providerState')).toBe(false)
  expect((await rowOf(store, 'b')).providerState).toEqual({
    project: 'P2',
    fingerprint: 'F2',
  })
})

test('an onReplace that throws or returns a rejected value leaves the row as it was', async () => {
  await addAB(open())
  const before = await s.bytes()
  const throwing = open({
    providerState: {
      ...stateCodec,
      onReplace: () => {
        throw new Error('no')
      },
    },
  })
  const rejected = open({
    providerState: { ...stateCodec, onReplace: () => ({ project: 5 }) },
  })

  const thrown = await rejectionOf(throwing.replace('a', oauth('r-a2')))
  const invalid = await rejectionOf(rejected.replace('a', oauth('r-a2')))

  expect(thrown.phase).toBe('before-first-write')
  expect(invalid.kind).toBe('invalid-provider-state')
  expect(invalid.phase).toBe('before-first-write')
  expect(await s.bytes()).toEqual(before)
})

const FIXTURE = new URL('./fixtures/v0.5.0/', import.meta.url)

async function fixture(name: string): Promise<string> {
  return readFile(new URL(name, FIXTURE), 'utf8')
}

// The fixture files were written by the 0.5.0 store (commit 260ccee) with
// the clock below: `add` a (OAuth, identity acct-a, label A), b (API key) and
// c (OAuth), one quota reading for a, `replace` c (identity acct-c), and
// `disable` b. `rows.json` is what 0.5.0's `read()` returned for them, and
// the `after-` files are what 0.5.0 wrote for the operations replayed below.
test('a 0.5.0 pool without provider state loads and writes byte for byte as 0.5.0 did', async () => {
  await writeFile(s.configPath, await fixture('config.json'))
  await writeFile(s.statePath, await fixture('state.json'))
  let now = 1_700_000_004_000
  const store = open({ now: () => now })

  const load = await store.read()
  expect(`${JSON.stringify(load, null, 2)}\n`).toBe(await fixture('rows.json'))

  now += 1000
  await store.rotate('a', {
    type: 'oauth',
    access: 'acc-a2',
    refresh: 'ref-a2',
    expires: 4_000_000_000_000,
  })
  await store.replace('b', {
    type: 'api',
    apiKey: 'key-b2',
    baseURL: 'https://api.example.test/v1',
  })
  await store.recordIdentity('c', 'acct-c', { credentialEpoch: 2 })
  const bytes = await s.bytes()
  expect(bytes.config).toBe(await fixture('after-config.json'))
  expect(bytes.state).toBe(await fixture('after-state.json'))
})

test('strict stamps refuse a provider-state update on an unbound row, and so does a row no stamp can bind it to', async () => {
  await addAB(open())
  // Another writer puts the same credential back without the stamp.
  await editState((state) => {
    delete state.accounts.a.commonAuthPool
  })
  const before = await s.bytes()
  const fence = { credentialEpoch: 1, identity: 'acct-a' }

  const strict = await rejectionOf(
    open({ requireCredentialStamps: true }).updateProviderState(
      'a',
      fence,
      () => ({ project: 'P9' }),
    ),
  )
  const lenient = await rejectionOf(
    open().updateProviderState('a', fence, () => ({ project: 'P9' })),
  )

  expect(strict.kind).toBe('unbound-credential')
  expect(strict.message).toContain('not the one this store stamped')
  expect(lenient.kind).toBe('unbound-credential')
  expect(lenient.message).toContain('no stamp of this store')
  expect(await s.bytes()).toEqual(before)

  // A stamp that names another identity than the row records: a provider
  // state written under it would never be shown, so the write is refused.
  await editConfig((config) => {
    config.accounts[1].accountId = 'acct-other'
  })
  const named = await s.bytes()
  const otherIdentity = await rejectionOf(
    open().updateProviderState(
      'b',
      { credentialEpoch: 1, identity: 'acct-other' },
      () => ({ project: 'P9' }),
    ),
  )
  expect(otherIdentity.kind).toBe('unbound-credential')
  expect(await s.bytes()).toEqual(named)
})

test('a foreign edit of the credential-bound part hides the provider state, and of the rest does not', async () => {
  const store = open()
  await addAB(store)
  await editState((state) => {
    state.accounts.b[PROVIDER_STATE_KEY].cooldownUntil = 99
  })
  expect((await rowOf(store, 'b')).providerState).toEqual({
    project: 'P2',
    fingerprint: 'F2',
    cooldownUntil: 99,
  })

  await editState((state) => {
    state.accounts.a[PROVIDER_STATE_KEY].project = 'P-foreign'
    state.accounts.b[PROVIDER_STATE_KEY].fingerprint = 'F-foreign'
  })
  for (const id of ['a', 'b']) {
    const row = await rowOf(store, id)
    expect(row.providerState).toBeUndefined()
    expect(row.providerStateDropped).toBe('uncovered')
    expect(row.stamp).toBe('bound')
    expect(row.candidate).toBe(true)
  }
  // The edited value is kept on disk, still unbound, through a rotate.
  await store.rotate('a', oauth('r-a2'))
  expect((await rowOf(store, 'a')).providerStateDropped).toBe('uncovered')
  expect((await s.state()).accounts.a[PROVIDER_STATE_KEY].project).toBe(
    'P-foreign',
  )
})

test('a provider state is not shown beside a credential, epoch or identity it was not bound to', async () => {
  const cases: Record<string, () => Promise<void>> = {
    // What 0.5.0 writes: a stamp that names no provider state.
    'older writer stamp': () =>
      editState((state) => {
        delete state.accounts.a.commonAuthPool.providerState
      }),
    // A writer that does not know about stamps swaps the refresh token.
    'credential swapped': () =>
      editState((state) => {
        state.accounts.a.refresh = 'r-foreign'
      }),
    // The config moved to another epoch (an older version's replace).
    'epoch moved': () =>
      editConfig((config) => {
        config.commonAuthPool.rows.a.credentialEpoch = 2
      }),
    'identity changed': () =>
      editConfig((config) => {
        config.accounts[0].accountId = 'acct-other'
      }),
  }
  for (const [name, edit] of Object.entries(cases)) {
    s.cleanup()
    s = hooks.lifetime.manage(await scenario())
    await addAB(open())
    await edit()
    const row = await rowOf(open(), 'a')
    expect(`${name}: ${row.providerStateDropped}`).toBe(`${name}: uncovered`)
    expect(row.providerState).toBeUndefined()
  }
  // A digest that is not a string makes the stamp itself malformed.
  await editState((state) => {
    state.accounts.b.commonAuthPool.providerState = 5
  })
  const b = await rowOf(open(), 'b')
  expect(b.stamp).toBe('malformed')
  expect(b.providerStateDropped).toBe('uncovered')
})

test('an update of the part not bound to the credential leaves the stamp as it was, and of the bound part rebinds it', async () => {
  const store = open()
  await addAB(store)
  const fence = { credentialEpoch: 1, identity: 'acct-a' }
  const stampBefore = JSON.stringify(
    (await s.state()).accounts.a.commonAuthPool,
  )

  await store.updateProviderState('a', fence, (current) => ({
    ...(current as Acct),
    cooldownUntil: 500,
  }))
  expect(JSON.stringify((await s.state()).accounts.a.commonAuthPool)).toBe(
    stampBefore,
  )
  expect((await rowOf(store, 'a')).providerState).toEqual({
    project: 'P1',
    fingerprint: 'F1',
    cooldownUntil: 500,
  })

  await store.updateProviderState('a', fence, (current) => ({
    ...(current as Acct),
    project: 'P5',
  }))
  const stampAfter = (await s.state()).accounts.a.commonAuthPool
  expect(JSON.stringify(stampAfter)).not.toBe(stampBefore)
  const { providerState: _bound, ...rest } = stampAfter
  const { providerState: _old, ...restBefore } = JSON.parse(stampBefore)
  expect(rest).toEqual(restBefore)
  const a = await rowOf(store, 'a')
  expect(a.providerState).toEqual({
    project: 'P5',
    fingerprint: 'F1',
    cooldownUntil: 500,
  })
  expect(a.stamp).toBe('bound')
})

test('updateProviderState hands the mutator a copy, writes nothing for an unchanged value and clears on undefined', async () => {
  const store = open()
  await addAB(store)
  const fence = { credentialEpoch: 1, identity: 'acct-a' }
  const before = await s.bytes()

  const same = await store.updateProviderState('a', fence, (current) => {
    ;(current as Acct).project = 'mutated-in-place'
    return { project: 'P1', fingerprint: 'F1' }
  })
  expect(same.outcome).toBe('unchanged')
  expect(await s.bytes()).toEqual(before)

  const cleared = await store.updateProviderState('a', fence, () => undefined)
  expect(cleared).toEqual({ id: 'a', outcome: 'cleared' })
  const account = (await s.state()).accounts.a
  expect(Object.hasOwn(account, PROVIDER_STATE_KEY)).toBe(false)
  expect(Object.hasOwn(account.commonAuthPool, 'providerState')).toBe(false)
  expect((await rowOf(store, 'a')).stamp).toBe('bound')
  const again = await store.updateProviderState('a', fence, () => undefined)
  expect(again.outcome).toBe('unchanged')
})

test('a provider state stays bound when a rotate or recordIdentity records the row identity', async () => {
  const store = open()
  await store.add({
    id: 'a',
    credential: oauth('r-a1'),
    providerState: { project: 'P1' },
  })
  await store.add({
    id: 'b',
    credential: oauth('r-b1'),
    providerState: { project: 'P2' },
  })
  await store.rotate('a', oauth('r-a2'), { identity: 'acct-a' })
  await store.recordIdentity('b', 'acct-b', { credentialEpoch: 1 })
  await store.refresh('a', refreshTo('r-a3'))

  for (const [id, project] of [
    ['a', 'P1'],
    ['b', 'P2'],
  ]) {
    const row = await rowOf(store, id as string)
    expect(row.stamp).toBe('bound')
    expect(row.providerState).toEqual({ project })
  }
})

test('a provider state that is not JSON, that the codec rejects, or that a store without a codec is given is refused before any write', async () => {
  const store = open()
  await addAB(store)
  const before = await s.bytes()
  const fence = { credentialEpoch: 1, identity: 'acct-a' }

  const rejected = await rejectionOf(
    store.rotate('a', oauth('r-a2'), { providerState: { project: 7 } }),
  )
  const notJson = await rejectionOf(
    store.updateProviderState('a', fence, () => ({ project: 1n })),
  )
  const refreshed = await rejectionOf(
    store.refresh('a', refreshTo('r-a2', { fingerprint: false })),
  )
  const noCodec = await rejectionOf(
    s.open().rotate('a', oauth('r-a2'), { providerState: { project: 'P' } }),
  )

  expect(rejected.kind).toBe('invalid-provider-state')
  expect(notJson.kind).toBe('invalid-provider-state')
  expect(refreshed.kind).toBe('invalid-provider-state')
  expect(noCodec.kind).toBe('invalid-input')
  expect(await s.bytes()).toEqual(before)
})

test('a stored provider state the codec rejects is dropped and the row stays usable', async () => {
  const store = open()
  await addAB(store)
  // An edit outside the credential-bound part keeps it bound, but the value
  // no longer validates.
  await editState((state) => {
    state.accounts.a[PROVIDER_STATE_KEY].cooldownUntil = 'soon'
  })
  const a = await rowOf(store, 'a')
  expect(a.providerState).toBeUndefined()
  expect(a.providerStateDropped).toBe('invalid')
  expect(a.invalid).toBeUndefined()
  expect(a.candidate).toBe(true)
  // A store opened without the codec shows no provider state either.
  expect((await rowOf(s.open(), 'b')).providerStateDropped).toBe('invalid')
})
