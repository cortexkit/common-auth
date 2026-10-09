import { beforeEach, expect, spyOn } from 'bun:test'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import {
  type AddInput,
  type OpenPoolStoreOptions,
  openPoolStore,
  type PoolRow,
  type PoolStore,
  type PublishPlan,
} from '../../src/store/index.js'
import { parseStamp } from '../../src/store/schema.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { observed } from '../fixtures/observed.js'
import { makeTempDir } from '../fixtures/scratch.js'

const hooks = lifetimeHooks()
const { test, afterEach } = hooks
let dir: string
let configPath: string
let statePath: string
let store: PoolStore
const oauth = (refresh = 'old-secret') => ({
  type: 'oauth' as const,
  refresh,
  access: `access-${refresh}`,
  expires: 1000,
})
const stage = (id = 'new', identity: string | undefined = 'wire') => ({
  id,
  credential: oauth(`secret-${id}`),
  identity,
  label: 'prepared',
  disabled: { reason: 'preparing' },
  stage: { reservation: 'reservation' },
  providerState: { bound: 'project', metadata: { cursor: 1 } },
})
const options = (): OpenPoolStoreOptions => ({
  provider: 'test',
  configPath,
  statePath,
  quota: { validate: () => true, merge: (_prior, next) => next },
  providerState: {
    validate: () => true,
    credentialBound: (value) => (value as { bound: unknown }).bound,
  },
  requireCredentialStamps: true,
  lockOptions: { renew: false, retryMs: 1, timeoutMs: 3000 },
})
const open = (extra: Partial<OpenPoolStoreOptions> = {}) =>
  openPoolStore({ ...options(), ...extra })
const bytes = async () =>
  Promise.all(
    [configPath, statePath].map(async (path) =>
      fs.readFile(path, 'utf8').catch(() => '<absent>'),
    ),
  )
const json = async (path: string) => JSON.parse(await fs.readFile(path, 'utf8'))
const write = async (path: string, value: unknown) =>
  fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
const row = async (id: string): Promise<PoolRow> => {
  const read = await store.read()
  if (read.status !== 'ready') throw new Error(read.status)
  const found = read.rows.find((row) => row.id === id)
  if (!found) throw new Error(`missing ${id}`)
  return found
}
const fence = async (id: string) => {
  const loaded = await row(id)
  return {
    credentialEpoch: loaded.credentialEpoch ?? 1,
    identity: loaded.identity,
  }
}
const seed = async () => {
  await store.add({ id: 'old', credential: oauth(), identity: 'wire' })
  await store.add(stage(), { onExisting: 'stage-duplicate' })
}
const plan = async (operationId = 'publication'): Promise<PublishPlan> => ({
  operationId,
  remove: [
    {
      id: 'old',
      attribution: await fence('old'),
      fingerprint: (await row('old')).fingerprint,
    },
  ],
  finalize: [
    {
      id: 'new',
      attribution: await fence('new'),
      reservation: 'reservation',
      enabled: true,
    },
  ],
  order: ['new'],
})
async function unchanged(action: () => Promise<unknown>, kind: string) {
  const prior = await bytes()
  await expect(action()).rejects.toMatchObject({ kind })
  expect(await bytes()).toEqual(prior)
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(async () => {
  dir = await makeTempDir()
  configPath = join(dir, 'config.json')
  statePath = join(dir, 'state.json')
  store = open()
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

test('staged replacement refuse preserves holder and duplicate requires both staging fields', async () => {
  await store.add({ id: 'old', credential: oauth(), identity: 'wire' })
  await unchanged(
    () =>
      store.add({ id: 'other', credential: oauth() }, { onExisting: 'refuse' }),
    'credential-exists',
  )
  await unchanged(
    () =>
      store.add(
        { ...stage(), disabled: undefined },
        { onExisting: 'stage-duplicate' },
      ),
    'invalid-input',
  )
  await unchanged(
    () =>
      store.add(
        { ...stage(), stage: undefined },
        { onExisting: 'stage-duplicate' },
      ),
    'invalid-input',
  )
  const staged = await store.add(
    { ...stage(), credential: oauth() },
    { onExisting: 'stage-duplicate' },
  )
  expect(staged.outcome).toBe('added-disabled')
  expect(staged.credentialEpoch).toBe(1)
  expect((await row('old')).credential).toMatchObject(oauth())
  await interruptAdd(stage('orphan', 'other'))
  await unchanged(
    () =>
      store.add(
        { id: 'other', credential: stage('orphan').credential },
        { onExisting: 'refuse' },
      ),
    'credential-exists',
  )
})

async function interruptAdd(input: AddInput = stage()) {
  const interrupted = open({
    onStep: (step, info) => {
      if (info.operation === 'add' && step === 'after-state-write')
        throw new Error('stop after state')
    },
  })
  await expect(
    interrupted.add(input, { onExisting: 'stage-duplicate' }),
  ).rejects.toMatchObject({ phase: 'after-first-write' })
}

test('staged replacement orphan replay preserves genuine epoch and stored state', async () => {
  await write(configPath, {
    version: 1,
    accounts: [],
    commonAuthPool: { schemaVersion: 1, rows: {}, retiredEpochs: { new: 6 } },
  })
  await store.add({ id: 'old', credential: oauth(), identity: 'old-wire' })
  const interrupted = open({
    onStep: (step) => {
      if (step === 'after-state-write') throw new Error('stop replace')
    },
  })
  await expect(
    interrupted.replace('old', oauth('replacement'), { identity: 'new-wire' }),
  ).rejects.toMatchObject({ phase: 'after-first-write' })
  const prior = await json(configPath)
  let polled = 0
  store = open({
    pull: async () => {
      polled++
      return {}
    },
  })
  await interruptAdd()
  const stateBefore = await fs.readFile(statePath, 'utf8')
  const result = await store.add(stage(), { onExisting: 'stage-duplicate' })
  await store.pullsSettled()
  const completed = await json(configPath)
  expect(
    completed.accounts.find((raw: { id: string }) => raw.id === 'old'),
  ).toEqual(prior.accounts[0])
  expect(completed.commonAuthPool.rows.old).toEqual(
    prior.commonAuthPool.rows.old,
  )
  expect(polled).toBe(0)
  expect(result).toMatchObject({ outcome: 'completed', credentialEpoch: 7 })
  expect(await fs.readFile(statePath, 'utf8')).toBe(stateBefore)
  const completeBefore = await bytes()
  expect(
    await store.add(stage(), { onExisting: 'stage-duplicate' }),
  ).toMatchObject({ outcome: 'exists', credentialEpoch: 7 })
  expect(await bytes()).toEqual(completeBefore)
})

for (const alteration of ['different', 'missing'] as const) {
  test(`staged replacement foreign orphan ${alteration} reservation refuses unchanged`, async () => {
    await interruptAdd()
    const state = await json(statePath)
    if (alteration === 'different')
      state.accounts.new.commonAuthPool.staged.reservation = 'foreign'
    else delete state.accounts.new.commonAuthPool.staged
    await write(statePath, state)
    await unchanged(
      () => store.add(stage(), { onExisting: 'stage-duplicate' }),
      'unbound-credential',
    )
  })
}

for (const field of [
  'provider metadata',
  'label',
  'identity absence',
  'access token',
  'expiry',
  'endpoint',
  'enabled shape',
  'disabled reason',
] as const) {
  test(`staged replacement exact replay rejects changed ${field}`, async () => {
    const input: AddInput & {
      providerState: { bound: string; metadata: { cursor: number } }
    } =
      field === 'endpoint'
        ? {
            ...stage(),
            credential: {
              type: 'api' as const,
              apiKey: 'key',
              baseURL: ' https://old.example/ ',
              authHeader: 'x-api-key' as const,
            },
          }
        : stage()
    const changed = structuredClone(input)
    if (field === 'provider metadata') changed.providerState.metadata.cursor = 2
    if (field === 'label') changed.label = 'changed'
    if (field === 'identity absence') changed.identity = undefined
    if (field === 'access token' && changed.credential.type === 'oauth')
      changed.credential.access = 'changed'
    if (field === 'expiry' && changed.credential.type === 'oauth')
      changed.credential.expires = 2000
    if (field === 'endpoint' && changed.credential.type === 'api')
      changed.credential.baseURL = 'https://new.example/'
    if (field === 'disabled reason') changed.disabled!.reason = 'changed'
    await interruptAdd(input)
    if (field !== 'enabled shape')
      await unchanged(
        () => store.add(changed, { onExisting: 'stage-duplicate' }),
        'unbound-credential',
      )
    await store.add(input, { onExisting: 'stage-duplicate' })
    if (field === 'enabled shape') {
      const config = await json(configPath)
      config.accounts[0].enabled = true
      await write(configPath, config)
    }
    await unchanged(
      () => store.add(changed, { onExisting: 'stage-duplicate' }),
      'id-exists',
    )
    if (field === 'label' || field === 'identity absence') {
      const absent: AddInput = {
        ...stage('absent'),
        identity: undefined,
        label: undefined,
      }
      await store.add(absent, { onExisting: 'stage-duplicate' })
      const config = await json(configPath)
      const raw = config.accounts.find(
        (raw: { id: string }) => raw.id === 'absent',
      )
      if (field === 'label') raw.label = null
      else raw.accountId = null
      await write(configPath, config)
      await unchanged(
        () => store.add(absent, { onExisting: 'stage-duplicate' }),
        'id-exists',
      )
    }
  })
}

test('staged replacement stamp parser rejects malformed reservation records', async () => {
  await store.add(stage(), { onExisting: 'stage-duplicate' })
  const stamp = (await json(statePath)).accounts.new.commonAuthPool
  expect(parseStamp(stamp)?.staged?.reservation).toBe('reservation')
  for (const staged of [
    { ...stamp.staged, unknown: true },
    { ...stamp.staged, reservation: '' },
    { ...stamp.staged, label: 4 },
    { ...stamp.staged, disabledReason: false },
    { ...stamp.staged, providerState: 'not-a-digest' },
  ])
    expect(parseStamp({ ...stamp, staged })).toBeUndefined()
})

for (const operation of ['add', 'enable', 'disable'] as const) {
  test(`staged replacement protect ${operation} observes successor management under locks`, async () => {
    await store.add({ id: 'old', credential: oauth() })
    await store.updateSettings((settings) => ({
      ...settings,
      management: 'predecessor',
    }))
    const parked = deferred()
    const resume = deferred()
    const predecessor = open({
      onLockEvent: async (event) => {
        if (event.type === 'acquired' && event.name === 'management-wait') {
          parked.resolve()
          await resume.promise
        }
      },
    })
    const protect = (view: {
      config: Readonly<Record<string, unknown>>
      rows: unknown[]
    }) => {
      expect(JSON.stringify(view.rows)).not.toContain('old-secret')
      return view.config.management === 'predecessor' ? undefined : 'superseded'
    }
    const callOptions = {
      extraLocks: [{ name: 'management-wait', path: statePath }],
      protect,
    }
    hooks.lifetime.unpark(resume.resolve)
    const pending = hooks.lifetime.operation<unknown>(
      operation === 'add'
        ? predecessor.add(
            { id: 'next', credential: oauth('next') },
            callOptions,
          )
        : operation === 'enable'
          ? predecessor.enable('old', callOptions)
          : predecessor.disable('old', 'late', callOptions),
    )
    // Settings use only store locks, so this successor lands while the
    // predecessor is parked ahead of its store-lock acquisition.
    await observed(hooks.lifetime, parked.promise)
    await store.updateSettings((settings) => ({
      ...settings,
      management: 'successor',
    }))
    const successor = await bytes()
    resume.resolve()
    await expect(pending).rejects.toMatchObject({
      kind: 'row-protected',
      phase: 'before-first-write',
    })
    expect(await bytes()).toEqual(successor)
  })
}

for (const operation of [
  'enable',
  'disable',
  'refresh',
  'replace',
  'rotate',
  'recordIdentity',
  'recordQuota',
  'updateProviderState',
  'add',
] as const) {
  test(`staged replacement reserved ${operation} refuses unchanged`, async () => {
    await store.add(stage(), { onExisting: 'stage-duplicate' })
    const captured = await fence('new')
    const writers = {
      enable: () => store.enable('new'),
      disable: () => store.disable('new', 'late'),
      refresh: () =>
        store.refresh('new', async () => ({
          refresh: 'rotated',
          access: 'rotated-access',
          expires: 2000,
        })),
      replace: () => store.replace('new', oauth('replacement')),
      rotate: () => store.rotate('new', oauth('rotation')),
      recordIdentity: () => store.recordIdentity('new', 'wire', captured),
      recordQuota: () => store.recordQuota('new', captured, {}),
      updateProviderState: () =>
        store.updateProviderState('new', captured, () => ({})),
      add: () => store.add({ id: 'new', credential: stage().credential }),
    }
    await unchanged(writers[operation], 'row-staged')
  })
}

test('staged replacement enabled shaped reserved rows never route or pull', async () => {
  await store.add(stage(), { onExisting: 'stage-duplicate' })
  await unchanged(() => store.remove('new'), 'row-staged')
  const config = await json(configPath)
  config.accounts[0].enabled = true
  await write(configPath, config)
  let polled = 0
  const reader = open({
    pull: async () => {
      polled++
      return {}
    },
  })
  await reader.load()
  reader.requestReading('new')
  await reader.pullsSettled()
  expect(polled).toBe(0)
  expect(await row('new')).toMatchObject({
    candidate: false,
    staged: { reservation: 'reservation' },
  })
})

test('staged replacement remove fence deletes reserved rows but never published rows', async () => {
  await seed()
  await store.add(stage('discard', 'other'), { onExisting: 'stage-duplicate' })
  expect(
    await store.remove('discard', { staged: { reservation: 'reservation' } }),
  ).toMatchObject({ outcome: 'removed' })
  await store.publishRoster(await plan())
  await unchanged(
    () => store.remove('new', { staged: { reservation: 'reservation' } }),
    'attribution',
  )
  expect((await row('new')).candidate).toBe(true)
})

test('staged replacement attributed toggle still completes a proved torn replacement', async () => {
  await store.add({ id: 'old', credential: oauth(), identity: 'wire' })
  const interrupted = open({
    onStep: (step) => {
      if (step === 'after-state-write') throw new Error('stop replace')
    },
  })
  await expect(
    interrupted.replace('old', oauth('new-secret'), { identity: 'new-wire' }),
  ).rejects.toMatchObject({ phase: 'after-first-write' })
  expect((await row('old')).torn).toBe(true)
  await store.disable('old', 'off', {
    attribution: await fence('old'),
    protect: () => undefined,
  })
  expect(await row('old')).toMatchObject({
    credentialEpoch: 2,
    identity: 'new-wire',
    stamp: 'bound',
    disabledReason: 'off',
    enabled: false,
  })
  expect((await row('old')).torn).toBeUndefined()
})

for (const clause of [
  'attribution',
  'fingerprint',
  'missing reservation',
  'different reservation',
  'stamp reservation',
  'order',
  'enabled identity',
  'secret identity',
  'protect',
  'required fingerprint',
  'disabled reason required',
  'enabled reason forbidden',
  'removed reserved',
  'removed unbound',
  'removed torn',
] as const) {
  test(`staged replacement publication rejects ${clause} unchanged`, async () => {
    await seed()
    const publication = await plan()
    let callOptions = {}
    if (clause === 'attribution')
      publication.remove[0]!.attribution.credentialEpoch++
    if (clause === 'fingerprint')
      publication.remove[0]!.fingerprint = 'spent-secret'
    if (clause === 'order') publication.order = ['old']
    if (
      clause === 'missing reservation' ||
      clause === 'different reservation'
    ) {
      const config = await json(configPath)
      if (clause === 'missing reservation')
        delete config.commonAuthPool.rows.new.staged
      else config.commonAuthPool.rows.new.staged.reservation = 'foreign'
      await write(configPath, config)
    }
    if (clause === 'stamp reservation') {
      const state = await json(statePath)
      state.accounts.new.commonAuthPool.staged.reservation = 'foreign'
      await write(statePath, state)
    }
    if (clause === 'enabled identity') {
      await store.add(stage('second'), { onExisting: 'stage-duplicate' })
      publication.finalize.push({
        id: 'second',
        attribution: await fence('second'),
        reservation: 'reservation',
        enabled: true,
      })
      publication.order.push('second')
    }
    if (clause === 'secret identity') {
      await store.remove('new', { staged: { reservation: 'reservation' } })
      await store.add(
        { ...stage('foreign', 'different'), credential: oauth() },
        { onExisting: 'stage-duplicate' },
      )
      publication.finalize = [
        {
          id: 'foreign',
          attribution: await fence('foreign'),
          reservation: 'reservation',
          enabled: true,
        },
      ]
      publication.order = ['foreign']
    }
    if (clause === 'protect')
      callOptions = { protect: () => 'management changed' }
    if (clause === 'required fingerprint') {
      store = open({ requireRemovedFingerprint: true })
      delete publication.remove[0]!.fingerprint
    }
    if (clause === 'disabled reason required')
      publication.finalize[0]!.enabled = false
    if (clause === 'enabled reason forbidden')
      publication.finalize[0]!.disabledReason = 'not allowed'
    if (clause === 'removed reserved') {
      publication.remove = [{ id: 'new', attribution: await fence('new') }]
      publication.finalize = []
      publication.order = ['old']
    }
    if (clause === 'removed unbound') {
      const state = await json(statePath)
      delete state.accounts.old.commonAuthPool
      await write(statePath, state)
    }
    if (clause === 'removed torn') {
      const interrupted = open({
        onStep: (step) => {
          if (step === 'after-state-write') throw new Error('stop replace')
        },
      })
      await expect(
        interrupted.replace('old', oauth('replacement')),
      ).rejects.toMatchObject({ phase: 'after-first-write' })
      publication.remove[0]!.attribution = await fence('old')
      publication.remove[0]!.fingerprint = (await row('old')).fingerprint
    }
    const kind =
      clause === 'attribution' ||
      clause === 'fingerprint' ||
      clause === 'secret identity' ||
      clause === 'removed torn'
        ? 'attribution'
        : clause.includes('reservation') || clause === 'removed reserved'
          ? 'row-staged'
          : clause === 'protect'
            ? 'row-protected'
            : clause === 'removed unbound'
              ? 'unbound-credential'
              : 'invalid-input'
    await unchanged(() => store.publishRoster(publication, callOptions), kind)
    expect(await store.publication('publication')).toBeUndefined()
  })
}

test('staged replacement disabled finalization releases reservation and later attributed enable works', async () => {
  await seed()
  const publication = await plan()
  publication.finalize[0]!.enabled = false
  publication.finalize[0]!.disabledReason = 'awaiting approval'
  const result = await store.publishRoster(publication)
  expect(result).toMatchObject({
    outcome: 'published',
    receipt: {
      phase: 'cleaned',
      finalized: [
        {
          id: 'new',
          credentialEpoch: 1,
          reservation: 'reservation',
          enabled: false,
        },
      ],
    },
  })
  expect(await row('new')).toMatchObject({
    enabled: false,
    disabledReason: 'awaiting approval',
    candidate: false,
    stamp: 'bound',
  })
  expect((await row('new')).staged).toBeUndefined()
  expect(
    (await json(statePath)).accounts.new.commonAuthPool.staged,
  ).toBeUndefined()
  await store.enable('new', { attribution: await fence('new') })
  expect((await row('new')).candidate).toBe(true)
})

test('staged replacement deduplicates same wire lock and leaves outside rows untouched', async () => {
  await seed()
  await store.add({
    id: 'outside',
    credential: oauth('outside'),
    identity: 'other',
    label: 'outside',
  })
  const configBefore = await json(configPath)
  const stateBefore = await json(statePath)
  const publication = await plan()
  publication.order = ['outside', 'new']
  const locks: string[] = []
  const publisher = open({
    onLockEvent: (event) => {
      if (event.type === 'acquired') locks.push(event.name)
    },
  })
  await publisher.publishRoster(publication)
  expect(locks.filter((name) => name.startsWith('row-'))).toEqual(['row-wire'])
  const configAfter = await json(configPath)
  const stateAfter = await json(statePath)
  expect(
    JSON.stringify(
      configAfter.accounts.find((raw: { id: string }) => raw.id === 'outside'),
    ),
  ).toBe(
    JSON.stringify(
      configBefore.accounts.find((raw: { id: string }) => raw.id === 'outside'),
    ),
  )
  expect(JSON.stringify(configAfter.commonAuthPool.rows.outside)).toBe(
    JSON.stringify(configBefore.commonAuthPool.rows.outside),
  )
  expect(JSON.stringify(stateAfter.accounts.outside)).toBe(
    JSON.stringify(stateBefore.accounts.outside),
  )
})

test('staged replacement waits behind middle row refresh and checks post refresh fingerprint', async () => {
  await store.add({ id: 'old', credential: oauth(), identity: 'middle' })
  await store.add(stage('new', 'alpha'), { onExisting: 'stage-duplicate' })
  await store.add(stage('last', 'zulu'), { onExisting: 'stage-duplicate' })
  const publication = await plan()
  publication.finalize.push({
    id: 'last',
    attribution: await fence('last'),
    reservation: 'reservation',
    enabled: true,
  })
  publication.order.push('last')
  const providerEntered = deferred()
  const releaseProvider = deferred()
  hooks.lifetime.unpark(releaseProvider.resolve)
  const refresh = hooks.lifetime.operation(
    store.refresh('old', async () => {
      providerEntered.resolve()
      await releaseProvider.promise
      return { refresh: 'post-refresh', access: 'new-access', expires: 4000 }
    }),
  )
  await observed(hooks.lifetime, providerEntered.promise)
  const contended = deferred()
  const publisher = open({
    onLockEvent: (event) => {
      if (event.type === 'contended' && event.name === 'row-middle')
        contended.resolve()
    },
  })
  const publish = hooks.lifetime.operation(publisher.publishRoster(publication))
  await observed(hooks.lifetime, contended.promise)
  releaseProvider.resolve()
  await refresh
  const afterRefresh = await bytes()
  await expect(publish).rejects.toMatchObject({ kind: 'attribution' })
  expect(await bytes()).toEqual(afterRefresh)
})

test('staged replacement changed row keys retry once then refuse without publication', async () => {
  await seed()
  const publication = await plan()
  let attempts = 0
  const publisher = open({
    onLockEvent: async (event) => {
      if (event.type === 'acquired' && event.name === 'provider-test') {
        attempts++
        const config = await json(configPath)
        config.accounts.find(
          (raw: { id: string }) => raw.id === 'old',
        ).accountId = `changed-${attempts}`
        await write(configPath, config)
      }
    },
  })
  await expect(publisher.publishRoster(publication)).rejects.toMatchObject({
    kind: 'row-key-changed',
  })
  expect(attempts).toBe(2)
  expect(await store.publication('publication')).toBeUndefined()
  expect(
    (await json(configPath)).accounts.map((raw: { id: string }) => raw.id),
  ).toEqual(['old', 'new'])
})

for (const failure of ['observer', 'lease'] as const) {
  test(`staged replacement before publication rename ${failure} leaves old pool usable`, async () => {
    await seed()
    const publication = await plan()
    let armed = true
    const publisher = open({
      onStep: async (step, info) => {
        if (
          armed &&
          info.operation === 'publishRoster' &&
          step === 'before-config-write'
        ) {
          armed = false
          if (failure === 'observer') throw new Error('refuse publication')
          await fs.rm(`${statePath}.row-wire.lock`, { force: true })
        }
      },
    })
    await unchanged(
      () => publisher.publishRoster(publication),
      failure === 'observer' ? 'unexpected' : 'lock-ownership',
    )
    expect(await store.publication('publication')).toBeUndefined()
    expect((await row('old')).candidate).toBe(true)
    await store.refresh('old', async () => ({
      refresh: 'still-serves',
      access: 'still-access',
      expires: 4000,
    }))
    await expect(
      store.add({ id: 'old', credential: oauth('different') }),
    ).rejects.toMatchObject({ kind: 'id-exists' })
  })
}

test('staged replacement removal refused before rename does not retire id in memory', async () => {
  await store.add({ id: 'old', credential: oauth() })
  const remover = open({
    onStep: (step) => {
      if (step === 'before-config-write') throw new Error('stop removal')
    },
  })
  await unchanged(() => remover.remove('old'), 'unexpected')
  await expect(
    store.add({ id: 'old', credential: oauth('different') }),
  ).rejects.toMatchObject({ kind: 'id-exists' })
})

test('staged replacement after publication rename resumes only receipt cleanup', async () => {
  await seed()
  const publication = await plan()
  const publisher = open({
    onStep: (step, info) => {
      if (info.operation === 'publishRoster' && step === 'after-config-write')
        throw new Error('stop after commit')
    },
  })
  await expect(publisher.publishRoster(publication)).rejects.toMatchObject({
    phase: 'after-first-write',
  })
  expect(await store.publication('publication')).toMatchObject({
    phase: 'committed',
  })
  // This later credential no longer carries staging. Receipt cleanup must not
  // stamp or overwrite it merely because the receipt names the same local id.
  await store.rotate('new', oauth('successor'))
  const stateBefore = await json(statePath)
  expect(await store.publishRoster(publication)).toMatchObject({
    outcome: 'cleaned',
    receipt: { phase: 'cleaned' },
  })
  expect(JSON.stringify((await json(statePath)).accounts.new)).toBe(
    JSON.stringify(stateBefore.accounts.new),
  )
  expect((await json(statePath)).accounts.old).toBeUndefined()
  const finalBytes = await bytes()
  expect(await store.publishRoster(publication)).toMatchObject({
    outcome: 'already-cleaned',
  })
  expect(await bytes()).toEqual(finalBytes)
})

test('staged replacement reused operation id refuses a different plan digest', async () => {
  await seed()
  const publication = await plan()
  await store.publishRoster(publication)
  await unchanged(
    () => store.publishRoster({ ...publication, order: [] }),
    'publication-mismatch',
  )
})

test('staged replacement receipt replay never revalidates a committed plan', async () => {
  await seed()
  const publication = await plan()
  delete publication.remove[0]!.fingerprint
  const publisher = open({
    onStep: (step, info) => {
      if (info.operation === 'publishRoster' && step === 'after-config-write')
        throw new Error('stop after commit')
    },
  })
  await expect(publisher.publishRoster(publication)).rejects.toMatchObject({
    phase: 'after-first-write',
  })
  const stricter = open({ requireRemovedFingerprint: true })
  expect(await stricter.publishRoster(publication)).toMatchObject({
    outcome: 'cleaned',
    receipt: { phase: 'cleaned' },
  })
  await unchanged(
    () =>
      stricter.publishRoster({
        ...publication,
        finalize: [
          { ...publication.finalize[0]!, disabledReason: 'forbidden' },
        ],
      }),
    'publication-mismatch',
  )
})

test('staged replacement durable publication and receipt sync file and directory only', async () => {
  await seed()
  const publication = await plan()
  const originalOpen = fs.open
  const synced: string[] = []
  const spy = spyOn(fs, 'open').mockImplementation(
    async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args)
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        synced.push(String(args[0]))
        await sync()
      }
      return handle
    },
  )
  try {
    await store.publishRoster(publication)
    expect(synced.filter((path) => path === dir)).toHaveLength(2)
    expect(
      synced.filter(
        (path) => path.startsWith(`${configPath}.`) && path.endsWith('.tmp'),
      ),
    ).toHaveLength(2)
    expect(
      synced.filter((path) => path.startsWith(`${statePath}.`)),
    ).toHaveLength(0)
    synced.length = 0
    await store.disable('new', 'ordinary')
    expect(synced).toEqual([])
  } finally {
    spy.mockRestore()
  }
})

test('staged replacement directory sync failure still records the irreversible rename', async () => {
  await seed()
  const publication = await plan()
  const originalOpen = fs.open
  const spy = spyOn(fs, 'open').mockImplementation(
    async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args)
      if (String(args[0]) === dir)
        handle.sync = async () => {
          throw new Error('directory sync failed')
        }
      return handle
    },
  )
  try {
    await expect(store.publishRoster(publication)).rejects.toMatchObject({
      phase: 'after-first-write',
    })
  } finally {
    spy.mockRestore()
  }
  expect(await store.publication('publication')).toMatchObject({
    phase: 'committed',
  })
  await expect(
    store.add({ id: 'old', credential: oauth('different') }),
  ).rejects.toMatchObject({ kind: 'id-removed' })
  expect(await store.publishRoster(publication)).toMatchObject({
    outcome: 'cleaned',
    receipt: { phase: 'cleaned' },
  })
})

test('staged replacement keeps every committed receipt and eight recent cleaned receipts', async () => {
  for (let i = 0; i < 10; i++)
    await store.publishRoster({
      operationId: String(10 - i),
      remove: [],
      finalize: [],
      order: [],
    })
  expect(await store.publication('10')).toBeUndefined()
  expect(await store.publication('9')).toBeUndefined()
  expect(await store.publication('1')).toMatchObject({ phase: 'cleaned' })
  expect(
    Object.keys((await json(configPath)).commonAuthPool.publications),
  ).toHaveLength(8)
})

async function crashChild(
  operation: 'add' | 'publish',
  input: AddInput | PublishPlan,
) {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'staged-child.fixture.ts'),
      configPath,
      statePath,
      operation,
      JSON.stringify(input),
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  hooks.lifetime.unpark(() => {
    child.kill()
  })
  const output = new Response(child.stdout).text()
  const errors = new Response(child.stderr).text()
  const exitCode = await hooks.lifetime.operation(child.exited)
  const stderr = await errors
  expect(exitCode, stderr).toBe(17)
  expect(await output).toContain(
    operation === 'add'
      ? 'crash:after-state-write'
      : 'crash:after-config-write',
  )
  expect(stderr).toBe('')
}

test('staged replacement child crash after add state resumes exact replay at genuine epoch', async () => {
  await write(configPath, {
    version: 1,
    accounts: [],
    commonAuthPool: { schemaVersion: 1, rows: {}, retiredEpochs: { new: 4 } },
  })
  await crashChild('add', stage())
  const stateBefore = await fs.readFile(statePath, 'utf8')
  expect(
    await store.add(stage(), { onExisting: 'stage-duplicate' }),
  ).toMatchObject({ outcome: 'completed', credentialEpoch: 5 })
  expect(await fs.readFile(statePath, 'utf8')).toBe(stateBefore)
})

test('staged replacement child crash after publication resumes with attributed orphan removal', async () => {
  await seed()
  const publication = await plan()
  const oldFence = await fence('old')
  await crashChild('publish', publication)
  expect(await store.publication('publication')).toMatchObject({
    phase: 'committed',
  })
  expect(await store.remove('old', { attribution: oldFence })).toMatchObject({
    outcome: 'completed',
  })
  expect(await store.publishRoster(publication)).toMatchObject({
    outcome: 'cleaned',
    receipt: { phase: 'cleaned' },
  })
  expect((await row('new')).stamp).toBe('bound')
  expect((await json(statePath)).accounts.old).toBeUndefined()
})
