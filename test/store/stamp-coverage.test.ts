import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type {
  OpenPoolStoreOptions,
  PoolRow,
  PoolStore,
} from '../../src/store/index.js'
import { credentialDigest } from '../../src/store/schema.js'
import {
  apiKey,
  CRASH_EXIT_CODE,
  oauth,
  type ParsedJson,
  rejectionOf,
  runChild,
  type Scenario,
  scenario,
} from './helpers.js'

let s: Scenario
beforeEach(async () => {
  s = await scenario()
})
afterEach(() => s.cleanup())

const OLD_URL = 'https://old.example.test/v1'
const NEW_URL = 'https://new.example.test/v1'
const EXPIRES = 4_000_000_000_000

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

async function editConfig(edit: (config: ParsedJson) => void): Promise<void> {
  const config = await s.config()
  edit(config)
  await s.writeConfig(config)
}

/** The roster row with this id, inside a parsed config. */
function rosterOf(config: ParsedJson, id = 'a'): ParsedJson {
  return config.accounts.find((raw: ParsedJson) => raw.id === id)
}

/** What a strict and a default reader each make of row `a`. */
async function admission(id = 'a') {
  const tight = await rowOf(strict(), id)
  const loose = await rowOf(s.open(), id)
  return {
    stamp: tight.stamp,
    strictCandidate: tight.candidate,
    strictUnbound: tight.unbound,
    defaultCandidate: loose.candidate,
  }
}

const MISMATCHED = {
  stamp: 'mismatched',
  strictCandidate: false,
  strictUnbound: true,
  defaultCandidate: true,
}

function provider(calls: string[], identity?: string) {
  return async (credential: { refresh: string }) => {
    calls.push(credential.refresh)
    return {
      access: `access-${credential.refresh}-next`,
      refresh: `${credential.refresh}-next`,
      expires: EXPIRES,
      ...(identity !== undefined ? { identity } : {}),
    }
  }
}

describe('stamps cover the token sent and the account and endpoint it goes to', () => {
  it('strict mode must reject an access-only bearer swap', async () => {
    const store = strict()
    await store.add({ id: 'a', credential: oauth('r-a'), identity: 'acct-a' })
    await editState((accounts) => {
      accounts.a.access = 'access-foreign'
    })
    const row = await rowOf(store)
    expect({
      stamp: row.stamp,
      candidate: row.candidate,
      unbound: row.unbound,
    }).toEqual({ stamp: 'mismatched', candidate: false, unbound: true })
    const before = await s.bytes()
    const error = await rejectionOf(
      store.recordQuota(
        'a',
        { credentialEpoch: 1, identity: 'acct-a' },
        'from-foreign',
      ),
    )
    expect(error.kind).toBe('unbound-credential')
    expect(await s.bytes()).toEqual(before)
  })

  it('strict mode must reject endpoint-only mutation after initial API add', async () => {
    const store = strict()
    await store.add({
      id: 'a',
      credential: apiKey('key-a', { baseURL: OLD_URL }),
    })
    expect((await rowOf(store)).stamp).toBe('bound')
    await editConfig((config) => {
      rosterOf(config).baseURL = NEW_URL
    })
    expect(await admission()).toEqual(MISMATCHED)
  })

  it('ordinary API rotation must preserve endpoint binding', async () => {
    const store = strict()
    await store.add({
      id: 'a',
      credential: apiKey('key-a', { baseURL: OLD_URL }),
    })
    await store.replace('a', apiKey('key-b', { baseURL: OLD_URL }))
    expect((await rowOf(store)).stamp).toBe('bound')
    await store.rotate('a', { type: 'api', apiKey: 'key-c' })
    expect((await s.state()).accounts.a.commonAuthPool.binding).toEqual({
      baseURL: OLD_URL,
      authHeader: 'authorization-bearer',
    })
    await editConfig((config) => {
      rosterOf(config).baseURL = NEW_URL
    })
    expect(await admission()).toEqual(MISMATCHED)
  })

  it('ordinary OAuth rotation must preserve known identity binding', async () => {
    const store = strict()
    await store.add({ id: 'a', credential: oauth('r-a'), identity: 'acct-a' })
    await store.replace('a', oauth('r-b'), { identity: 'acct-b' })
    await store.rotate('a', oauth('r-c'), { identity: 'acct-b' })
    expect((await s.state()).accounts.a.commonAuthPool.binding).toEqual({
      identity: 'acct-b',
    })
    await editConfig((config) => {
      rosterOf(config).accountId = 'acct-foreign'
    })
    expect(await admission()).toEqual(MISMATCHED)
  })

  it('a config-only change of an added, rotated or refreshed row endpoint, header or identity is mismatched', async () => {
    const cases: Array<[string, () => Promise<void>]> = [
      [
        'added API key, header changed',
        async () => {
          await strict().add({
            id: 'a',
            credential: apiKey('key-a', { baseURL: OLD_URL }),
          })
          await editConfig((config) => {
            rosterOf(config).authHeader = 'x-api-key'
          })
        },
      ],
      [
        'rotated API key, endpoint changed',
        async () => {
          const store = strict()
          await store.add({
            id: 'a',
            credential: apiKey('key-a', { baseURL: OLD_URL }),
          })
          await store.rotate('a', { type: 'api', apiKey: 'key-a2' })
          await editConfig((config) => {
            rosterOf(config).baseURL = NEW_URL
          })
        },
      ],
      [
        'added OAuth row, identity changed',
        async () => {
          await strict().add({
            id: 'a',
            credential: oauth('r-a'),
            identity: 'acct-a',
          })
          await editConfig((config) => {
            rosterOf(config).accountId = 'acct-foreign'
          })
        },
      ],
      [
        'refreshed OAuth row, identity changed',
        async () => {
          const store = strict()
          await store.add({ id: 'a', credential: oauth('r-a') })
          await store.recordIdentity('a', 'acct-a', { credentialEpoch: 1 })
          await store.refresh('a', provider([]))
          expect((await s.state()).accounts.a.commonAuthPool.binding).toEqual({
            identity: 'acct-a',
          })
          await editConfig((config) => {
            rosterOf(config).accountId = 'acct-foreign'
          })
        },
      ],
    ]
    for (const [title, craft] of cases) {
      s.cleanup()
      s = await scenario()
      await craft()
      expect({ title, ...(await admission()) }).toEqual({
        title,
        ...MISMATCHED,
      })
    }
  }, 30_000)
})

describe('stamps written by 0.4.3 or earlier', () => {
  it('a stamp without a dispatch digest loads legacy: strict refuses it, default mode routes it, and a default refresh rebinds it', async () => {
    const store = s.open()
    await store.add({ id: 'a', credential: oauth('r-a'), identity: 'acct-a' })
    await store.add({
      id: 'k',
      credential: apiKey('key-k', { baseURL: OLD_URL }),
    })
    await store.replace('k', apiKey('key-k2', { baseURL: NEW_URL }))
    // What 0.4.3 wrote: an add's stamp has no binding, a replace's has one.
    await editState((accounts) => {
      delete accounts.a.commonAuthPool.dispatch
      delete accounts.a.commonAuthPool.binding
      delete accounts.k.commonAuthPool.dispatch
      delete accounts.k.commonAuthPool.replace
    })
    for (const id of ['a', 'k'])
      expect({ id, ...(await admission(id)) }).toEqual({
        id,
        stamp: 'legacy',
        strictCandidate: false,
        strictUnbound: true,
        defaultCandidate: true,
      })
    const calls: string[] = []
    const refused = await rejectionOf(strict().refresh('a', provider(calls)))
    expect({ kind: refused.kind, calls }).toEqual({
      kind: 'unbound-credential',
      calls: [],
    })
    await store.refresh('a', provider(calls))
    expect(await admission()).toMatchObject({
      stamp: 'bound',
      strictCandidate: true,
    })
  })

  it('an interrupted replace written by 0.4.3 is still completed forward by a default-mode load', async () => {
    await s
      .open()
      .add({ id: 'a', credential: oauth('r-old'), identity: 'acct-old' })
    await s
      .open()
      .add({ id: 'k', credential: apiKey('key-old', { baseURL: OLD_URL }) })
    // The state half of a 0.4.3 replace, with the config half never written:
    // the new credential beside a stamp holding the lineage digest and the
    // binding, ahead of the config's epoch, with no dispatch digest.
    const fresh = oauth('r-new')
    await editState((accounts) => {
      accounts.a = {
        access: fresh.access,
        refresh: fresh.refresh,
        expires: fresh.expires,
        commonAuthPool: {
          credentialEpoch: 2,
          digest: credentialDigest(fresh),
          binding: { identity: 'acct-new' },
        },
      }
      accounts.k = {
        apiKey: 'key-new',
        commonAuthPool: {
          credentialEpoch: 2,
          digest: credentialDigest(apiKey('key-new')),
          binding: { baseURL: NEW_URL, authHeader: 'x-api-key' },
        },
      }
    })
    const shown = await rowOf(s.open())
    expect(shown).toMatchObject({
      torn: true,
      candidate: false,
      credentialEpoch: 2,
      identity: 'acct-new',
    })
    const reader = s.open({ pull: async () => 'reading' })
    await reader.load()
    await reader.pullsSettled()
    await reader.disable('k', 'probe')
    await reader.enable('k')
    const config = await s.config()
    expect({
      oauth: [
        config.commonAuthPool.rows.a.credentialEpoch,
        rosterOf(config).accountId,
      ],
      api: [
        config.commonAuthPool.rows.k.credentialEpoch,
        rosterOf(config, 'k').baseURL,
        rosterOf(config, 'k').authHeader,
      ],
    }).toEqual({
      oauth: [2, 'acct-new'],
      api: [2, NEW_URL, 'x-api-key'],
    })
    for (const id of ['a', 'k']) {
      const row = await rowOf(s.open(), id)
      expect({
        id,
        torn: row.torn,
        candidate: row.candidate,
        stamp: row.stamp,
      }).toEqual({ id, torn: undefined, candidate: true, stamp: 'legacy' })
    }
  })

  it('a stamp a rotate or refresh wrote is never completed as torn, even when the config epoch falls behind it', async () => {
    for (const write of ['rotate', 'refresh'] as const) {
      s.cleanup()
      s = await scenario()
      const store = s.open()
      await store.add({ id: 'a', credential: oauth('r-a'), identity: 'acct-a' })
      await store.replace('a', oauth('r-b'), { identity: 'acct-b' })
      await store.recordQuota(
        'a',
        { credentialEpoch: 2, identity: 'acct-b' },
        'kept',
      )
      if (write === 'rotate') await store.rotate('a', oauth('r-c'))
      else await store.refresh('a', provider([]))
      // Another writer moves the config's epoch back behind the stamp and
      // records another account; nothing this store wrote is half done.
      await editConfig((config) => {
        config.commonAuthPool.rows.a.credentialEpoch = 1
        rosterOf(config).accountId = 'acct-foreign'
      })
      await store.disable('a', 'probe')
      await store.enable('a')
      const config = await s.config()
      const row = await rowOf(s.open())
      expect({
        write,
        torn: row.torn,
        stamp: row.stamp,
        epoch: config.commonAuthPool.rows.a.credentialEpoch,
        identity: rosterOf(config).accountId,
        quota: config.commonAuthPool.rows.a.quota,
      }).toEqual({
        write,
        torn: undefined,
        stamp: 'mismatched',
        epoch: 1,
        identity: 'acct-foreign',
        quota: { readings: ['kept'] },
      })
    }
  }, 30_000)
})

describe('an identity learnt after the stamp', () => {
  function crashChild(task: Record<string, unknown>) {
    return runChild({
      configPath: s.configPath,
      statePath: s.statePath,
      ...task,
    })
  }

  it('recordIdentity writes only the config; after a crash right after it the row is bound, and the next stamp write binds the identity', async () => {
    await strict().add({ id: 'a', credential: oauth('r-a') })
    const stateBefore = (await s.bytes()).state
    const child = crashChild({
      op: 'recordIdentity',
      id: 'a',
      identity: 'acct-a',
      credentialEpoch: 1,
      exitAt: 'after-config-write',
    })
    expect(await child.exited).toBe(CRASH_EXIT_CODE)
    expect((await s.bytes()).state).toBe(stateBefore)
    expect(child.output()).not.toContain('step:before-state-write')
    expect(await rowOf(strict())).toMatchObject({
      identity: 'acct-a',
      stamp: 'bound',
      candidate: true,
    })

    // The boundary: until the next stamp write, the stamp names no identity,
    // so an identity another writer records in its place is not detected.
    await editConfig((config) => {
      rosterOf(config).accountId = 'acct-foreign'
    })
    expect((await rowOf(strict())).stamp).toBe('bound')
    await editConfig((config) => {
      rosterOf(config).accountId = 'acct-a'
    })

    await strict().refresh('a', provider([]))
    expect((await s.state()).accounts.a.commonAuthPool.binding).toEqual({
      identity: 'acct-a',
    })
    await editConfig((config) => {
      rosterOf(config).accountId = 'acct-foreign'
    })
    expect(await admission()).toEqual(MISMATCHED)
  }, 30_000)

  it('a refresh that learns the identity and crashes before its config write leaves the row bound with no identity', async () => {
    await strict().add({ id: 'a', credential: oauth('r-a') })
    const child = crashChild({
      op: 'refresh',
      id: 'a',
      credential: oauth('r-a2'),
      identity: 'acct-a',
      exitAt: 'after-state-write',
    })
    expect(await child.exited).toBe(CRASH_EXIT_CODE)
    const row = await rowOf(strict())
    expect({
      refresh: row.credential?.type === 'oauth' && row.credential.refresh,
      identity: row.identity,
      stamp: row.stamp,
      candidate: row.candidate,
      binding: (await s.state()).accounts.a.commonAuthPool.binding,
    }).toEqual({
      refresh: 'r-a2',
      identity: undefined,
      stamp: 'bound',
      candidate: true,
      binding: {},
    })
    await strict().recordIdentity('a', 'acct-a', { credentialEpoch: 1 })
    expect(await rowOf(strict())).toMatchObject({
      identity: 'acct-a',
      stamp: 'bound',
      candidate: true,
    })
  }, 30_000)
})
