import { beforeEach, describe, expect } from 'bun:test'
import type {
  OpenPoolStoreOptions,
  PoolCredential,
  PoolRow,
  PoolStore,
} from '../../src/store/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import {
  apiKey,
  oauth,
  type ParsedJson,
  rejectionOf,
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

const OLD_URL = 'https://old.example.test/v1'
const NEW_URL = 'https://new.example.test/v1'
const OTHER_URL = 'https://other.example.test/v1'

function strict(overrides: Partial<OpenPoolStoreOptions> = {}): PoolStore {
  return s.open({ requireCredentialStamps: true, ...overrides })
}

async function rowOf(store: PoolStore, id = 'a'): Promise<PoolRow> {
  const load = await store.read()
  if (load.status !== 'ready') throw new Error(`pool is ${load.status}`)
  const row = load.rows.find((candidate) => candidate.id === id)
  if (!row) throw new Error(`no row ${id}`)
  return row
}

async function editState(edit: (accounts: ParsedJson) => void): Promise<void> {
  const state = await s.state()
  edit(state.accounts)
  await s.writeState(state)
}

/** What the config says about row `a`: its epoch, identity, quota and endpoint. */
async function configOf(): Promise<ParsedJson> {
  const config = await s.config()
  const raw = config.accounts.find((row: ParsedJson) => row.id === 'a')
  const entry = config.commonAuthPool.rows.a
  return {
    epoch: entry.credentialEpoch,
    identity: raw.accountId,
    quota: entry.quota,
    baseURL: raw.baseURL,
    authHeader: raw.authHeader,
  }
}

interface Kind {
  type: 'oauth' | 'api'
  before: PoolCredential
  after: PoolCredential
}

const OAUTH: Kind = {
  type: 'oauth',
  before: oauth('r-old'),
  after: oauth('r-new'),
}

/** An API key replaced by one for another endpoint and header. */
const API: Kind = {
  type: 'api',
  before: apiKey('key-old', { baseURL: OLD_URL }),
  after: apiKey('key-new', { baseURL: NEW_URL, authHeader: 'x-api-key' }),
}

/**
 * Row `a` holding `kind.before` for account `acct-old` at epoch 1 with a
 * quota reading, then a replace with `kind.after` for account `acct-new`
 * stopped right after its state write: the new credential and its stamp are
 * on disk, the config still describes the old one.
 */
async function interruptedReplace(kind: Kind): Promise<void> {
  const store = s.open()
  await store.add({ id: 'a', credential: kind.before, identity: 'acct-old' })
  await store.recordQuota(
    'a',
    { credentialEpoch: 1, identity: 'acct-old' },
    'seen',
  )
  let armed = true
  const writer = s.open({
    onStep: (at, info) => {
      if (armed && info.operation === 'replace' && at === 'after-state-write') {
        armed = false
        throw new Error('stopped after the state write')
      }
    },
  })
  await writer
    .replace('a', kind.after, { identity: 'acct-new' })
    .catch(() => undefined)
}

interface Corruption {
  title: string
  kind: Kind
  edit(accounts: ParsedJson): void
}

/**
 * Edits another writer makes to the interrupted replace's credential, each
 * leaving the stamp the replace wrote (lineage digest, dispatch digest,
 * binding and replace mark) untouched.
 */
const CORRUPTIONS: Corruption[] = [
  {
    title: 'access token changed',
    kind: OAUTH,
    edit: (accounts) => {
      accounts.a.access = 'access-foreign'
    },
  },
  {
    title: 'expiry changed',
    kind: OAUTH,
    edit: (accounts) => {
      accounts.a.expires = 4_100_000_000_000
    },
  },
  {
    title: 'API key changed',
    kind: API,
    edit: (accounts) => {
      accounts.a.apiKey = 'key-foreign'
    },
  },
  {
    title: 'API endpoint in the stamp binding changed',
    kind: API,
    edit: (accounts) => {
      accounts.a.commonAuthPool.binding.baseURL = OTHER_URL
    },
  },
]

async function corrupted(corruption: Corruption): Promise<void> {
  s.cleanup()
  s = hooks.lifetime.manage(await scenario())
  await interruptedReplace(corruption.kind)
  await editState(corruption.edit)
}

/**
 * With the corruption in place, a strict store loads row `a` as on disk
 * (unbound, no candidate), refuses every operation that keeps its material
 * without writing a byte or calling a provider, and no write that does go
 * through completes the replace.
 */
async function refusedWithoutRepair(corruption: Corruption): Promise<void> {
  await corrupted(corruption)
  const title = corruption.title
  const oauthRow = corruption.kind.type === 'oauth'
  const before = await s.bytes()

  const loaded = await rowOf(strict())
  expect({
    title,
    stamp: loaded.stamp,
    unbound: loaded.unbound,
    candidate: loaded.candidate,
    torn: loaded.torn,
    epoch: loaded.credentialEpoch,
    identity: loaded.identity,
  }).toEqual({
    title,
    stamp: 'mismatched',
    unbound: true,
    candidate: false,
    torn: undefined,
    epoch: 1,
    identity: 'acct-old',
  })

  const calls: string[] = []
  const refreshed = await rejectionOf(
    strict().refresh('a', async (credential) => {
      calls.push(credential.refresh)
      return { access: 'x', refresh: 'r-next', expires: 4_000_000_000_000 }
    }),
  )

  let requests = 0
  const pullFailures: string[] = []
  const puller = strict({
    pull: async () => {
      requests++
      return 'reading'
    },
    onPullFailure: (_id, error) => {
      pullFailures.push(error.kind)
    },
  })
  puller.requestReading('a')
  await puller.pullsSettled()

  const quota = await rejectionOf(
    strict().recordQuota(
      'a',
      { credentialEpoch: 1, identity: 'acct-old' },
      'late',
    ),
  )
  const identity = await rejectionOf(
    strict().recordIdentity('a', 'acct-old', { credentialEpoch: 1 }),
  )
  const rotated = await rejectionOf(
    strict().rotate(
      'a',
      oauthRow ? oauth('r-rotated') : { type: 'api', apiKey: 'key-rotated' },
    ),
  )

  expect({
    title,
    refresh: refreshed.kind,
    calls,
    requests,
    pullFailures,
    recordQuota: quota.kind,
    recordIdentity: identity.kind,
    rotate: rotated.kind,
    bytes: await s.bytes(),
  }).toEqual({
    title,
    // An API row is never refreshed; it is refused before any lock.
    refresh: oauthRow ? 'unbound-credential' : 'no-credential',
    calls: [],
    requests: 0,
    // An API row never pulls, so its pull is dropped rather than refused.
    pullFailures: oauthRow ? ['unbound-credential'] : [],
    recordQuota: 'unbound-credential',
    recordIdentity: 'unbound-credential',
    rotate: 'unbound-credential',
    bytes: before,
  })

  // A write that does go through on the row leaves the replace
  // uncompleted: the old epoch, identity, quota and endpoint stay.
  const store = strict()
  await store.disable('a', 'probe')
  await store.enable('a')
  expect({ title, config: await configOf() }).toEqual({
    title,
    config: {
      epoch: 1,
      identity: 'acct-old',
      quota: { readings: ['seen'] },
      baseURL: oauthRow ? undefined : OLD_URL,
      authHeader: oauthRow ? undefined : 'authorization-bearer',
    },
  })
  expect((await rowOf(store)).unbound).toBe(true)
}

describe('a strict store and a torn replace whose stamp no longer describes the credential', () => {
  it('strict corrupted-dispatch torn replacement must refuse before any config repair', async () => {
    await refusedWithoutRepair(CORRUPTIONS[0] as Corruption)
  }, 15_000)

  it('a strict store neither completes nor operates on a torn OAuth replace whose expiry was changed', async () => {
    await refusedWithoutRepair(CORRUPTIONS[1] as Corruption)
  }, 15_000)

  it('a strict store neither completes nor operates on a torn API replace whose key was changed', async () => {
    await refusedWithoutRepair(CORRUPTIONS[2] as Corruption)
  }, 15_000)

  it('a strict store neither completes nor operates on a torn API replace whose stamped endpoint was changed', async () => {
    await refusedWithoutRepair(CORRUPTIONS[3] as Corruption)
  }, 15_000)

  it('a strict store still completes an untouched interrupted replace forward, OAuth and API to a new endpoint', async () => {
    for (const kind of [OAUTH, API]) {
      s.cleanup()
      s = hooks.lifetime.manage(await scenario())
      await interruptedReplace(kind)
      const apiRow = kind.type === 'api'

      const torn = await rowOf(strict())
      expect({
        type: kind.type,
        torn: torn.torn,
        stamp: torn.stamp,
        unbound: torn.unbound,
        candidate: torn.candidate,
        epoch: torn.credentialEpoch,
        identity: torn.identity,
        quota: torn.quota,
      }).toEqual({
        type: kind.type,
        torn: true,
        stamp: 'bound',
        unbound: undefined,
        candidate: false,
        epoch: 2,
        identity: 'acct-new',
        quota: undefined,
      })
      // On disk the config still describes the replaced credential.
      expect((await configOf()).epoch).toBe(1)

      const store = strict()
      await store.disable('a', 'probe')
      expect({ type: kind.type, config: await configOf() }).toEqual({
        type: kind.type,
        config: {
          epoch: 2,
          identity: 'acct-new',
          quota: undefined,
          baseURL: apiRow ? NEW_URL : undefined,
          authHeader: apiRow ? 'x-api-key' : undefined,
        },
      })
      await store.enable('a')
      const after = await rowOf(store)
      expect({
        type: kind.type,
        torn: after.torn,
        stamp: after.stamp,
        unbound: after.unbound,
        candidate: after.candidate,
        credential: after.credential,
      }).toEqual({
        type: kind.type,
        torn: undefined,
        stamp: 'bound',
        unbound: undefined,
        candidate: true,
        credential: expect.objectContaining(
          apiRow
            ? { apiKey: 'key-new', baseURL: NEW_URL, authHeader: 'x-api-key' }
            : { refresh: 'r-new', access: 'access-r-new' },
        ) as never,
      })
    }
  }, 30_000)

  it('without requireCredentialStamps a torn replace whose access token was changed is completed forward as before', async () => {
    await corrupted(CORRUPTIONS[0] as Corruption)
    const store = s.open()
    const loaded = await rowOf(store)
    expect({
      torn: loaded.torn,
      stamp: loaded.stamp,
      unbound: loaded.unbound,
      candidate: loaded.candidate,
      epoch: loaded.credentialEpoch,
      identity: loaded.identity,
    }).toEqual({
      torn: true,
      stamp: 'mismatched',
      unbound: undefined,
      candidate: false,
      epoch: 2,
      identity: 'acct-new',
    })
    await store.disable('a', 'probe')
    expect(await configOf()).toEqual({
      epoch: 2,
      identity: 'acct-new',
      quota: undefined,
      baseURL: undefined,
      authHeader: undefined,
    })
    await store.enable('a')
    expect(await rowOf(store)).toMatchObject({
      candidate: true,
      stamp: 'mismatched',
    })
  })
})
