import { beforeEach, describe, expect } from 'bun:test'
import {
  type AddInput,
  POOL_KEY,
  PoolOperationError,
  type PoolStore,
} from '../../src/store/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import {
  apiKey,
  CRASH_EXIT_CODE,
  oauth,
  objectStateCodec,
  type ParsedJson,
  runChild,
  type Scenario,
  scenario,
} from './helpers.js'

const hooks = lifetimeHooks()
const { afterEach, it } = hooks
let s: Scenario
beforeEach(async () => {
  s = hooks.lifetime.manage(await scenario())
  // A survivor row proves refusal leaves the entire files, not only the orphan, alone.
  await s.open().add({ id: 'survivor', credential: oauth('survivor') })
})
afterEach(() => s.cleanup())

const API: AddInput = {
  id: 'a',
  credential: apiKey('orphan-key', {
    baseURL: 'https://orphan-b.example.test/v1',
    authHeader: 'x-api-key',
  }),
  identity: 'acct-b',
}
const OAUTH: AddInput = {
  id: 'a',
  credential: oauth('orphan-refresh'),
  identity: 'acct-b',
}

function strict(): PoolStore {
  return s.open({
    requireCredentialStamps: true,
    providerState: objectStateCodec,
  })
}

async function rows(store = strict()) {
  const load = await store.read()
  expect(load.status).toBe('ready')
  if (load.status !== 'ready') throw new Error(`pool is ${load.status}`)
  return load.rows
}

async function interrupted(input: AddInput) {
  const child = runChild({
    ...s.paths,
    op: 'add',
    ...input,
    requireCredentialStamps: true,
    exitAt: 'after-state-write',
  })
  expect(await child.exited, child.output()).toBe(CRASH_EXIT_CODE)
  expect(child.output()).toContain('step:after-state-write')
  expect((await rows()).map((row) => row.id)).toEqual(['survivor'])
  expect((await s.state()).accounts.a[POOL_KEY]).toBeDefined()
}

async function refuses(input: AddInput) {
  const before = await s.bytes()
  let failure: unknown
  try {
    await strict().add(input)
  } catch (error) {
    failure = error
  }
  // These labels distinguish the safety assertion from a lease or harness failure.
  expect(
    failure,
    'strict interrupted add refuses conflicting material',
  ).toBeInstanceOf(PoolOperationError)
  expect(failure).toMatchObject({
    operation: 'add',
    rowId: 'a',
    kind: 'unbound-credential',
    phase: 'before-first-write',
    retryable: false,
  })
  expect(
    await s.bytes(),
    'refused interrupted add preserves state and roster bytes',
  ).toEqual(before)
  expect((await rows()).map((row) => row.id)).toEqual(['survivor'])
}

async function editOrphan(edit: (account: ParsedJson) => void) {
  const state = await s.state()
  edit(state.accounts.a)
  await s.writeState(state)
}

describe('strict interrupted add', () => {
  for (const [kind, input] of [
    ['API', API],
    ['OAuth', OAUTH],
  ] as const) {
    it(`matching ${kind} replay recovers a bound readable row after a real crash`, async () => {
      await interrupted(input)
      expect((await strict().add(input)).outcome).toBe('added')
      expect((await rows()).find((row) => row.id === 'a')).toMatchObject({
        credential: input.credential,
        identity: 'acct-b',
        credentialEpoch: 1,
        stamp: 'bound',
        candidate: true,
      })
    })
    it(`${kind} recovery preserves the stamped identity when replay omits identity`, async () => {
      await interrupted(input)
      expect(
        (await strict().add({ id: 'a', credential: input.credential })).outcome,
      ).toBe('added')
      expect((await rows()).find((row) => row.id === 'a')).toMatchObject({
        identity: 'acct-b',
        stamp: 'bound',
      })
    })
    it(`${kind} replay refuses a different identity without changing bytes`, async () => {
      await interrupted(input)
      await refuses({ ...input, identity: 'acct-a' })
    })
    for (const point of [
      'before-config-write',
      'after-config-write',
    ] as const) {
      it(`${kind} recovery crash at ${point} leaves only the orphan or completed row`, async () => {
        await interrupted(input)
        const before = await s.bytes()
        const child = runChild({
          ...s.paths,
          op: 'add',
          ...input,
          requireCredentialStamps: true,
          exitAt: point,
        })
        expect(await child.exited, child.output()).toBe(CRASH_EXIT_CODE)
        expect(child.output()).toContain(`step:${point}`)
        expect(
          (await s.bytes()).state,
          'recovery never rewrites the orphan credential',
        ).toBe(before.state)
        if (point === 'before-config-write') {
          expect((await s.bytes()).config).toBe(before.config)
          expect((await strict().add(input)).outcome).toBe('added')
        }
        expect((await rows()).find((row) => row.id === 'a')).toMatchObject({
          credential: input.credential,
          identity: 'acct-b',
          stamp: 'bound',
          candidate: true,
        })
      })
    }
  }

  it('API replay refuses a different endpoint without changing bytes', async () => {
    await interrupted(API)
    await refuses({
      ...API,
      credential: apiKey('orphan-key', {
        baseURL: 'https://captured-a.example.test/v1',
        authHeader: 'x-api-key',
      }),
    })
  })
  it('API replay refuses a different header without changing bytes', async () => {
    await interrupted(API)
    await refuses({
      ...API,
      credential: apiKey('orphan-key', {
        baseURL: 'https://orphan-b.example.test/v1',
        authHeader: 'authorization-bearer',
      }),
    })
  })
  it('API replay refuses a different key without changing bytes', async () => {
    await interrupted(API)
    await refuses({
      ...API,
      credential: {
        ...API.credential,
        type: 'api',
        apiKey: 'other-key',
      } as AddInput['credential'],
    })
  })
  for (const [field, value] of [
    ['refresh', 'other-refresh'],
    ['access', 'other-access'],
    ['expires', 4_100_000_000_000],
  ] as const) {
    it(`OAuth replay refuses different ${field} material without changing bytes`, async () => {
      await interrupted(OAUTH)
      await refuses({
        ...OAUTH,
        credential: { ...OAUTH.credential, [field]: value },
      })
    })
  }
  for (const [title, edit] of [
    [
      'malformed stamp',
      (account: ParsedJson) => {
        account[POOL_KEY].binding = null
      },
    ],
    [
      'missing stamp',
      (account: ParsedJson) => {
        delete account[POOL_KEY]
      },
    ],
    [
      'legacy stamp',
      (account: ParsedJson) => {
        delete account[POOL_KEY].dispatch
      },
    ],
    [
      'wrong epoch',
      (account: ParsedJson) => {
        account[POOL_KEY].credentialEpoch = 2
      },
    ],
    [
      'incomplete endpoint binding',
      (account: ParsedJson) => {
        delete account[POOL_KEY].binding.authHeader
      },
    ],
    [
      'changed on-disk key',
      (account: ParsedJson) => {
        account.apiKey = 'foreign-key'
      },
    ],
    [
      'changed stamped endpoint',
      (account: ParsedJson) => {
        account[POOL_KEY].binding.baseURL = 'https://foreign.example.test'
      },
    ],
  ] as const) {
    it(`API orphan with ${title} refuses without changing bytes`, async () => {
      await interrupted(API)
      await editOrphan(edit)
      await refuses(API)
    })
  }
  it('OAuth orphan with changed on-disk access refuses without changing bytes', async () => {
    await interrupted(OAUTH)
    await editOrphan((account) => {
      account.access = 'foreign-access'
    })
    await refuses(OAUTH)
  })
  it('refusal does not repair an unrelated torn row before validating the orphan', async () => {
    await interrupted(API)
    const child = runChild({
      ...s.paths,
      op: 'replace',
      id: 'survivor',
      credential: oauth('replacement'),
      identity: 'replacement-account',
      exitAt: 'after-state-write',
    })
    expect(await child.exited, child.output()).toBe(CRASH_EXIT_CODE)
    await refuses({ ...API, identity: 'acct-a' })
    expect((await rows()).find((row) => row.id === 'survivor')?.torn).toBe(true)
  })
  it('refusal precedes deduplication onto another row holding the incoming secret', async () => {
    await interrupted(API)
    await refuses({ id: 'a', credential: oauth('survivor') })
  })
  it('matching recovery keeps the epoch stamped after prior id retirement', async () => {
    const config = await s.config()
    config[POOL_KEY].retiredEpochs = { a: 3 }
    await s.writeConfig(config)
    await interrupted(API)
    expect((await strict().add(API)).outcome).toBe('added')
    expect((await rows()).find((row) => row.id === 'a')).toMatchObject({
      credentialEpoch: 4,
      stamp: 'bound',
      candidate: true,
    })
  })
  it('matching API recovery accepts trimmed endpoints and the default bearer header', async () => {
    const input = {
      id: 'a',
      credential: apiKey('orphan-key', {
        baseURL: ' https://orphan-b.example.test/v1 ',
      }),
    }
    await interrupted(input)
    expect(
      (
        await strict().add({
          ...input,
          credential: apiKey('orphan-key', {
            baseURL: 'https://orphan-b.example.test/v1',
            authHeader: 'authorization-bearer',
          }),
        })
      ).outcome,
    ).toBe('added')
    expect((await rows()).find((row) => row.id === 'a')).toMatchObject({
      stamp: 'bound',
      candidate: true,
    })
  })
  it('matching OAuth recovery retains the state and provider-state binding byte for byte', async () => {
    const input = { ...OAUTH, providerState: { project: 'project-b' } }
    await interrupted(input)
    const before = await s.bytes()
    expect((await strict().add(input)).outcome).toBe('added')
    expect((await s.bytes()).state).toBe(before.state)
    expect((await rows()).find((row) => row.id === 'a')).toMatchObject({
      stamp: 'bound',
      providerState: input.providerState,
    })
  })
  it('OAuth replay refuses a different bound provider state without changing bytes', async () => {
    await interrupted({ ...OAUTH, providerState: { project: 'project-b' } })
    await refuses({ ...OAUTH, providerState: { project: 'project-a' } })
  })
  it('OAuth orphan with changed bound provider state refuses without changing bytes', async () => {
    const input = { ...OAUTH, providerState: { project: 'project-b' } }
    await interrupted(input)
    await editOrphan((account) => {
      account.commonAuthProviderState.project = 'foreign-project'
    })
    await refuses(input)
  })
  it('remove discards a refused state-only orphan so new material can be added', async () => {
    await interrupted(API)
    const next = { ...API, credential: apiKey('new-key'), identity: 'acct-new' }
    await refuses(next)
    const before = await s.bytes()
    const locks: string[] = []
    const store = s.open({
      requireCredentialStamps: true,
      onLockEvent: (event) => {
        if (event.type === 'acquired') locks.push(event.name)
      },
    })
    expect(
      await store.remove('a', {
        extraLocks: [{ name: 'extra', path: s.statePath }],
      }),
    ).toEqual({ id: 'a', outcome: 'completed' })
    expect(locks).toEqual(['row-a', 'extra', 'save', 'save'])
    expect((await s.bytes()).config).toBe(before.config)
    expect((await s.state()).accounts.a).toBeUndefined()
    expect((await store.add(next)).outcome).toBe('added')
    expect((await rows(store)).find((row) => row.id === 'a')).toMatchObject({
      credential: next.credential,
      identity: 'acct-new',
      stamp: 'bound',
      candidate: true,
    })
  })
  it('non-strict replay still overwrites a conflicting orphan as before', async () => {
    await interrupted(API)
    const next = { ...API, credential: apiKey('other-key'), identity: 'acct-a' }
    expect((await s.open().add(next)).outcome).toBe('added')
    expect((await rows(s.open())).find((row) => row.id === 'a')).toMatchObject({
      credential: next.credential,
      identity: 'acct-a',
      stamp: 'bound',
    })
  })
  it('non-strict OAuth replay still overwrites malformed orphan material as before', async () => {
    await interrupted(OAUTH)
    await editOrphan((account) => {
      account[POOL_KEY] = null
    })
    const next = {
      ...OAUTH,
      credential: oauth('other-refresh'),
      identity: 'acct-a',
    }
    expect((await s.open().add(next)).outcome).toBe('added')
    expect((await rows(s.open())).find((row) => row.id === 'a')).toMatchObject({
      credential: next.credential,
      identity: 'acct-a',
      stamp: 'bound',
    })
  })
})
