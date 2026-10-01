import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type {
  PoolRow,
  PoolStore,
  PullRequest,
  WriteStep,
} from '../../src/store/index.js'
import {
  loadAccounts,
  saveAccounts,
} from '../fixtures/legacy-openai-auth/accounts.js'
import {
  apiKey,
  CRASH_EXIT_CODE,
  oauth,
  runChild,
  type Scenario,
  scenario,
} from './helpers.js'

let s: Scenario
beforeEach(async () => {
  s = await scenario()
})
afterEach(() => s.cleanup())

const STEPS: WriteStep[] = [
  'before-config-write',
  'after-config-write',
  'before-state-write',
  'after-state-write',
]
const ID = 'r'
const OLD_URL = 'https://old.example.test/v1'
const NEW_URL = 'https://new.example.test/v1'

/**
 * What a row is, for the crash table: the account it is recorded for, the
 * secret it would send, the endpoint it would send it to, its credential
 * epoch and whether it is enabled. A reader must only ever see one of the
 * shapes a case lists as whole.
 */
interface Shape {
  identity?: string
  secret?: string
  baseURL?: string
  epoch?: number
  enabled?: boolean
}

function shapeOf(row: PoolRow): Shape {
  const credential = row.credential
  return {
    identity: row.identity,
    secret:
      credential === undefined
        ? undefined
        : credential.type === 'oauth'
          ? credential.refresh
          : credential.apiKey,
    baseURL: credential?.type === 'api' ? credential.baseURL : undefined,
    epoch: row.credentialEpoch,
    enabled: row.enabled,
  }
}

function sameShape(a: Shape, b: Shape, fields: (keyof Shape)[]): boolean {
  return fields.every((field) => a[field] === b[field])
}

const ALL_FIELDS: (keyof Shape)[] = [
  'identity',
  'secret',
  'baseURL',
  'epoch',
  'enabled',
]

interface Case {
  title: string
  task: Record<string, unknown>
  setup(store: PoolStore): Promise<void>
  /** Every whole row a reader may see, by name; null stands for no row. */
  whole: Record<string, Shape | null>
}

/**
 * `whole: <name>` when the row is one of the case's whole shapes,
 * `not-routable` when it holds no credential and is no candidate, else a
 * description of the mixed row.
 */
function verdict(row: PoolRow | undefined, c: Case): string {
  if (!row) {
    const absent = Object.entries(c.whole).find(([, shape]) => shape === null)
    return absent ? `whole: ${absent[0]}` : 'MIXED: the row is missing'
  }
  const shape = shapeOf(row)
  for (const [name, whole] of Object.entries(c.whole))
    if (whole && sameShape(shape, whole, ALL_FIELDS)) return `whole: ${name}`
  if (!row.candidate && row.credential === undefined) return 'not-routable'
  return `MIXED: ${JSON.stringify(shape)} candidate=${row.candidate}`
}

/**
 * The same verdict for a pull request: whether its identity, secret and
 * epoch are those of one of the case's whole shapes.
 */
function pullVerdict(request: PullRequest, c: Case): string {
  const shape: Shape = {
    identity: request.identity,
    secret:
      request.credential.type === 'oauth'
        ? request.credential.refresh
        : request.credential.apiKey,
    epoch: request.credentialEpoch,
  }
  for (const [name, whole] of Object.entries(c.whole))
    if (whole && sameShape(shape, whole, ['identity', 'secret', 'epoch']))
      return `whole: ${name}`
  return `MIXED: ${JSON.stringify(shape)}`
}

const WHOLE_OR_NOT_ROUTABLE = /^(whole: |not-routable$)/

async function rowOf(id = ID): Promise<PoolRow | undefined> {
  const load = await s.open().read()
  if (load.status !== 'ready') throw new Error(`pool is ${load.status}`)
  return load.rows.find((row) => row.id === id)
}

const CASES: Case[] = [
  {
    title: 'add of an OAuth row',
    task: { op: 'add', credential: oauth('r-new'), identity: 'acct-new' },
    setup: async (store) => {
      await store.add({
        id: 'other',
        credential: oauth('r-other'),
        identity: 'acct-other',
      })
    },
    whole: {
      before: null,
      done: { identity: 'acct-new', secret: 'r-new', epoch: 1, enabled: true },
    },
  },
  {
    title: 'add of an API-key row',
    task: { op: 'add', credential: apiKey('key-new', { baseURL: NEW_URL }) },
    setup: async (store) => {
      await store.add({ id: 'other', credential: oauth('r-other') })
    },
    whole: {
      before: null,
      done: { secret: 'key-new', baseURL: NEW_URL, epoch: 1, enabled: true },
    },
  },
  {
    title: 'replace of an OAuth row by another account',
    task: { op: 'replace', credential: oauth('r-new'), identity: 'acct-new' },
    setup: async (store) => {
      await store.add({
        id: ID,
        credential: oauth('r-old'),
        identity: 'acct-old',
      })
    },
    whole: {
      before: {
        identity: 'acct-old',
        secret: 'r-old',
        epoch: 1,
        enabled: true,
      },
      done: { identity: 'acct-new', secret: 'r-new', epoch: 2, enabled: true },
    },
  },
  {
    title: 'replace of an API-key row by another endpoint',
    task: {
      op: 'replace',
      credential: apiKey('key-new', { baseURL: NEW_URL }),
    },
    setup: async (store) => {
      await store.add({
        id: ID,
        credential: apiKey('key-old', { baseURL: OLD_URL }),
      })
    },
    whole: {
      before: { secret: 'key-old', baseURL: OLD_URL, epoch: 1, enabled: true },
      done: { secret: 'key-new', baseURL: NEW_URL, epoch: 2, enabled: true },
    },
  },
  {
    title: 'rotate that learns the first identity',
    task: { op: 'rotate', credential: oauth('r-2'), identity: 'acct-1' },
    setup: async (store) => {
      await store.add({ id: ID, credential: oauth('r-1') })
    },
    whole: {
      before: { secret: 'r-1', epoch: 1, enabled: true },
      // Same account: the rotated token before its identity is recorded.
      rotated: { secret: 'r-2', epoch: 1, enabled: true },
      done: { identity: 'acct-1', secret: 'r-2', epoch: 1, enabled: true },
    },
  },
  {
    title: 'rotate of the same known account',
    task: { op: 'rotate', credential: oauth('r-2'), identity: 'acct-1' },
    setup: async (store) => {
      await store.add({ id: ID, credential: oauth('r-1'), identity: 'acct-1' })
    },
    whole: {
      before: { identity: 'acct-1', secret: 'r-1', epoch: 1, enabled: true },
      done: { identity: 'acct-1', secret: 'r-2', epoch: 1, enabled: true },
    },
  },
  {
    title: 'refresh that learns the first identity',
    task: { op: 'refresh', credential: oauth('r-2'), identity: 'acct-1' },
    setup: async (store) => {
      await store.add({ id: ID, credential: oauth('r-1') })
    },
    whole: {
      before: { secret: 'r-1', epoch: 1, enabled: true },
      rotated: { secret: 'r-2', epoch: 1, enabled: true },
      done: { identity: 'acct-1', secret: 'r-2', epoch: 1, enabled: true },
    },
  },
  {
    title: 'recordIdentity of a first identity',
    task: { op: 'recordIdentity', identity: 'acct-1', credentialEpoch: 1 },
    setup: async (store) => {
      await store.add({ id: ID, credential: oauth('r-1') })
    },
    whole: {
      before: { secret: 'r-1', epoch: 1, enabled: true },
      done: { identity: 'acct-1', secret: 'r-1', epoch: 1, enabled: true },
    },
  },
  {
    title: 'disable',
    task: { op: 'disable' },
    setup: async (store) => {
      await store.add({ id: ID, credential: oauth('r-1'), identity: 'acct-1' })
    },
    whole: {
      before: { identity: 'acct-1', secret: 'r-1', epoch: 1, enabled: true },
      done: { identity: 'acct-1', secret: 'r-1', epoch: 1, enabled: false },
    },
  },
  {
    title: 'enable',
    task: { op: 'enable' },
    setup: async (store) => {
      await store.add({ id: ID, credential: oauth('r-1'), identity: 'acct-1' })
      await store.disable(ID, 'manual')
    },
    whole: {
      before: { identity: 'acct-1', secret: 'r-1', epoch: 1, enabled: false },
      done: { identity: 'acct-1', secret: 'r-1', epoch: 1, enabled: true },
    },
  },
  {
    title: 'remove',
    task: { op: 'remove' },
    setup: async (store) => {
      await store.add({ id: ID, credential: oauth('r-1'), identity: 'acct-1' })
    },
    whole: {
      before: { identity: 'acct-1', secret: 'r-1', epoch: 1, enabled: true },
      done: null,
    },
  },
]

/** Runs the case's operation in a child that exits at `step`. */
async function crashAt(c: Case, step: WriteStep): Promise<void> {
  const child = runChild({
    configPath: s.configPath,
    statePath: s.statePath,
    id: ID,
    exitAt: step,
    renew: true,
    ...c.task,
  })
  const code = await child.exited
  // An operation that never reaches the requested write step completes
  // normally instead.
  const reached = child.output().includes(`step:${step}\n`)
  expect({ code, output: child.output() }).toMatchObject({
    code: reached ? CRASH_EXIT_CODE : 0,
  })
}

describe('crash table: every write step of every operation that writes a row', () => {
  for (const c of CASES) {
    for (const step of STEPS) {
      it(`a crash at ${step} of ${c.title} shows a fresh reader, a fresh pull and the next write only whole rows`, async () => {
        await c.setup(s.open())
        await crashAt(c, step)

        // A fresh reader sees a whole row, or one that is not routable.
        const seen = await rowOf()
        expect(verdict(seen, c)).toMatch(WHOLE_OR_NOT_ROUTABLE)
        if (seen?.torn) expect(seen.candidate).toBe(false)

        // A quota reading for the row as read lands only on a whole row.
        if (seen?.credentialEpoch !== undefined) {
          const recorded = await s
            .open()
            .recordQuota(
              ID,
              {
                credentialEpoch: seen.credentialEpoch,
                ...(seen.identity !== undefined
                  ? { identity: seen.identity }
                  : {}),
              },
              'probe',
            )
            .then(
              () => true,
              () => false,
            )
          if (seen.torn) expect(recorded).toBe(false)
          if (recorded) expect(verdict(await rowOf(), c)).toMatch(/^whole: /)
        }

        // A fresh process loading the pool pulls only for a whole pair.
        const requests: PullRequest[] = []
        const puller = s.open({
          pull: async (request) => {
            if (request.id === ID) requests.push(request)
            return 'reading'
          },
        })
        await puller.load()
        await puller.pullsSettled()
        for (const request of requests)
          expect(pullVerdict(request, c)).toMatch(/^whole: /)

        // The next write on the row leaves it whole and, holding a
        // credential, routable.
        if (seen) {
          const store = s.open()
          await store.disable(ID, 'probe')
          await store.enable(ID)
          const after = await rowOf()
          expect(verdict(after, c)).toMatch(WHOLE_OR_NOT_ROUTABLE)
          expect(after?.torn).toBeUndefined()
          if (after?.credential) expect(after.candidate).toBe(true)
          if (seen.torn) expect(verdict(after, c)).toBe('whole: done')
        }
      }, 15_000)
    }
  }
})

describe('a replace torn between its writes', () => {
  const replaceCase = CASES[2] as Case

  it('a quota reading after a crash inside replace is recorded only against a whole row', async () => {
    for (const step of STEPS) {
      s.cleanup()
      s = await scenario()
      await replaceCase.setup(s.open())
      await crashAt(replaceCase, step)
      for (const attribution of [
        { credentialEpoch: 1, identity: 'acct-old' },
        { credentialEpoch: 2, identity: 'acct-new' },
      ]) {
        const recorded = await s
          .open()
          .recordQuota(ID, attribution, `${step} ${attribution.identity}`)
          .then(
            () => true,
            () => false,
          )
        if (!recorded) continue
        const row = await rowOf()
        expect(row?.torn).toBeUndefined()
        expect({ step, verdict: verdict(row, replaceCase) }).toEqual({
          step,
          verdict:
            attribution.identity === 'acct-old'
              ? 'whole: before'
              : 'whole: done',
        })
      }
    }
  }, 30_000)

  it('a refresh after a crash inside replace calls the provider with the credential and identity of one account', async () => {
    for (const step of STEPS) {
      s.cleanup()
      s = await scenario()
      await replaceCase.setup(s.open())
      await crashAt(replaceCase, step)
      const calls: string[] = []
      await s.open().refresh(ID, async (credential, row) => {
        calls.push(`${credential.refresh} ${row.identity}`)
        return {
          access: 'x',
          refresh: `${credential.refresh}-next`,
          expires: 4_000_000_000_000,
        }
      })
      expect({ step, calls }).toEqual({
        step,
        calls: [
          expect.stringMatching(/^(r-old acct-old|r-new acct-new)$/) as never,
        ],
      })
    }
  }, 30_000)

  it('a row torn between the writes of replace is shown as the replacement, is no candidate, and the next write completes it', async () => {
    await replaceCase.setup(s.open())
    await crashAt(replaceCase, 'after-state-write')
    const torn = await rowOf()
    expect(torn).toMatchObject({ torn: true, candidate: false })
    expect(verdict(torn, replaceCase)).toBe('whole: done')
    // On disk the config still names the old account until a write
    // completes the row.
    const config = await s.config()
    expect(config.accounts[0].accountId).toBe('acct-old')
    await s.open().disable(ID, 'probe')
    const repaired = await s.config()
    expect(repaired.accounts[0].accountId).toBe('acct-new')
    expect(repaired.commonAuthPool.rows[ID]).toMatchObject({
      credentialEpoch: 2,
      needsFirstReading: true,
    })
  })

  it('a pull fired by a fresh load completes a torn OAuth row and reads it for the replacement', async () => {
    await replaceCase.setup(s.open())
    await s
      .open()
      .recordQuota(ID, { credentialEpoch: 1, identity: 'acct-old' }, 'old')
    await crashAt(replaceCase, 'after-state-write')
    const requests: PullRequest[] = []
    const store = s.open({
      pull: async (request) => {
        requests.push(request)
        return 'new'
      },
    })
    await store.load()
    await store.pullsSettled()
    expect(
      requests.map((request) => pullVerdict(request, replaceCase)),
    ).toEqual(['whole: done'])
    const row = await rowOf()
    expect(row).toMatchObject({
      candidate: true,
      identity: 'acct-new',
      credentialEpoch: 2,
      quota: { readings: ['new'] },
    })
    expect(row?.torn).toBeUndefined()
  })

  it('a torn API-key row is no candidate until the next write completes it with the new endpoint', async () => {
    const apiCase = CASES[3] as Case
    await apiCase.setup(s.open())
    await crashAt(apiCase, 'after-state-write')
    expect(await rowOf()).toMatchObject({ torn: true, candidate: false })
    expect((await s.config()).accounts[0].baseURL).toBe(OLD_URL)
    await s.open().disable(ID, 'probe')
    await s.open().enable(ID)
    const row = await rowOf()
    expect(row).toMatchObject({ candidate: true, credentialEpoch: 2 })
    expect(row?.credential).toMatchObject({
      apiKey: 'key-new',
      baseURL: NEW_URL,
    })
  })
})

describe('quota and leftovers', () => {
  it('a quota reading for a row holding no credential is refused', async () => {
    await s.writeConfig({
      version: 1,
      accounts: [{ id: 'a', type: 'oauth', addedAt: 1 }],
      commonAuthPool: {
        schemaVersion: 1,
        rows: { a: { credentialEpoch: 1, needsFirstReading: true } },
      },
    })
    const before = await s.bytes()
    const error = await s
      .open()
      .recordQuota('a', { credentialEpoch: 1 }, 'reading')
      .then(
        () => undefined,
        (failure) => failure,
      )
    expect(error).toMatchObject({ kind: 'no-credential', phase: 'pull' })
    expect(await s.bytes()).toEqual(before)
  })

  it('an add over a state entry left by an interrupted removal keeps nothing of it', async () => {
    await s.open().add({ id: 'other', credential: oauth('r-other') })
    const state = await s.state()
    state.accounts.a = {
      refresh: 'r-removed',
      lastUsed: 5,
      lastRefreshError: { message: 'old' },
    }
    await s.writeState(state)
    await s.open().add({ id: 'a', credential: oauth('r-a') })
    expect(Object.keys((await s.state()).accounts.a).sort()).toEqual([
      'access',
      'commonAuthPool',
      'expires',
      'lastRefreshedAt',
      'refresh',
    ])
  })
})

describe('credential stamps', () => {
  it('every credential write stamps the state entry with the credential epoch it belongs to', async () => {
    const store = s.open()
    await store.add({ id: ID, credential: oauth('r-1') })
    expect((await s.state()).accounts[ID].commonAuthPool).toMatchObject({
      credentialEpoch: 1,
    })
    await store.replace(ID, oauth('r-2'), { identity: 'acct-2' })
    expect((await s.state()).accounts[ID].commonAuthPool).toMatchObject({
      credentialEpoch: 2,
      binding: { identity: 'acct-2' },
    })
    await store.refresh(ID, async () => ({
      access: 'x',
      refresh: 'r-3',
      expires: 4_000_000_000_000,
    }))
    expect((await s.state()).accounts[ID].commonAuthPool).toMatchObject({
      credentialEpoch: 2,
    })
  })

  it('a pool written before credential stamps loads every row as before', async () => {
    await s.writeConfig({
      version: 1,
      accounts: [
        { id: 'a', type: 'oauth', addedAt: 1, accountId: 'acct-a' },
        { id: 'k', type: 'api', addedAt: 1, baseURL: NEW_URL },
      ],
      commonAuthPool: {
        schemaVersion: 1,
        rows: {
          a: { credentialEpoch: 3, needsFirstReading: false },
          k: { credentialEpoch: 2, needsFirstReading: false },
        },
      },
    })
    await s.writeState({
      version: 1,
      accounts: { a: { refresh: 'r-a' }, k: { apiKey: 'key-k' } },
    })
    const load = await s.open().read()
    if (load.status !== 'ready') throw new Error('expected ready')
    expect(
      load.rows.map((row) => [
        row.id,
        row.candidate,
        row.torn,
        row.credentialEpoch,
        shapeOf(row).secret,
      ]),
    ).toEqual([
      ['a', true, undefined, 3, 'r-a'],
      ['k', true, undefined, 2, 'key-k'],
    ])
  })

  it('a stamp beside a credential it was not written with is ignored', async () => {
    // Another writer put a credential beside a stamp it kept from an earlier
    // one: the stamp says nothing about the credential now on disk.
    await s.writeConfig({
      version: 1,
      accounts: [{ id: 'a', type: 'oauth', addedAt: 1, accountId: 'acct-a' }],
      commonAuthPool: {
        schemaVersion: 1,
        rows: { a: { credentialEpoch: 1, needsFirstReading: false } },
      },
    })
    await s.writeState({
      version: 1,
      accounts: {
        a: {
          refresh: 'r-now',
          commonAuthPool: {
            credentialEpoch: 2,
            digest: 'written-for-another-credential',
            binding: { identity: 'acct-gone' },
          },
        },
      },
    })
    const row = await rowOf('a')
    expect(row).toMatchObject({
      candidate: true,
      identity: 'acct-a',
      credentialEpoch: 1,
    })
    expect(row?.torn).toBeUndefined()
  })

  it('a stamped pool loads through the legacy reader, and a legacy rewrite that drops the stamps loads as before', async () => {
    const store = s.open()
    await store.add({ id: 'a', credential: oauth('r-a'), identity: 'acct-a' })
    await store.add({ id: 'k', credential: apiKey('key-k') })
    await store.replace('a', oauth('r-a2'), { identity: 'acct-a2' })
    const legacy = await loadAccounts(s.paths)
    expect(
      legacy?.accounts.map((account) =>
        account.type === 'oauth' ? account.refresh : account.apiKey,
      ),
    ).toEqual(['r-a2', 'key-k'])
    if (legacy) await saveAccounts(legacy, s.paths)
    expect((await s.state()).accounts.a.commonAuthPool).toBeUndefined()
    const load = await s.open().read()
    if (load.status !== 'ready') throw new Error('expected ready')
    expect(
      load.rows.map((row) => [
        row.id,
        row.candidate,
        row.identity,
        row.credentialEpoch,
      ]),
    ).toEqual([
      ['a', true, 'acct-a2', 2],
      ['k', true, undefined, 1],
    ])
  })
})
