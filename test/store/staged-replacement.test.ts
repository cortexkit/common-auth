import { beforeEach, expect, spyOn } from 'bun:test'
import * as crypto from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import * as timers from 'node:timers/promises'
import {
  type AddInput,
  type OpenPoolStoreOptions,
  openPoolStore,
  type PoolRow,
  type PoolStore,
  type PublishPlan,
} from '../../src/store/index.js'
import { parseStamp } from '../../src/store/schema.js'
import { completeTornRows } from '../../src/store/torn.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { observed } from '../fixtures/observed.js'
import { makeTempDir } from '../fixtures/scratch.js'
import { expireChildLeases } from './helpers.js'

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
    'row-staged',
  )
})

test('staged replacement stage with rotate refuses before locks and preserves holder', async () => {
  await store.add({ id: 'old', credential: oauth(), identity: 'wire' })
  let acquired = 0
  const caller = open({
    onLockEvent: (event) => {
      if (event.type === 'acquired') acquired++
    },
  })
  const input = { ...stage(), credential: oauth() }
  await unchanged(() => caller.add(input), 'invalid-input')
  await unchanged(
    () => caller.add(input, { onExisting: 'rotate' }),
    'invalid-input',
  )
  expect(acquired).toBe(0)
  await expect(caller.add(input)).rejects.toMatchObject({
    message: "a staged add needs onExisting: 'refuse' or 'stage-duplicate'",
  })
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
  let addCommitted = false
  let captureLocks = 0
  store = open({
    onStep: (step, info) => {
      if (info.operation === 'add' && step === 'after-config-write')
        addCommitted = true
    },
    onLockEvent: (event) => {
      if (addCommitted && event.type === 'acquired') captureLocks++
    },
    pull: async () => {
      polled++
      return {}
    },
  })
  await interruptAdd()
  const stateBefore = await fs.readFile(statePath, 'utf8')
  const result = await store.add(stage(), { onExisting: 'stage-duplicate' })
  await store.pullsSettled()
  expect(captureLocks).toBe(0)
  addCommitted = false
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
    // Recovery will pause after replacing this expired lease with the one the
    // predecessor holds while it waits for store locks.
    const managementLockPath = `${statePath}.management-wait.lock`
    await write(managementLockPath, {
      ownerId: 'expired-predecessor',
      expiresAt: Date.now() - 1,
    })
    const parked = deferred()
    const resume = deferred()
    const predecessor = open({
      onLockStep: async (lock, step) => {
        if (
          lock.name === 'management-wait' &&
          step === 'stale-lock-recreated'
        ) {
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
    // Settings use only store locks, so they can change while the predecessor
    // holds the management lease and waits to acquire those store locks.
    await observed(hooks.lifetime, parked.promise)
    const heldLease = await json(managementLockPath)
    expect(heldLease.ownerId).not.toBe('expired-predecessor')
    expect(heldLease.expiresAt).toBeGreaterThan(Date.now())
    await store.updateSettings((settings) => ({
      ...settings,
      management: 'successor',
    }))
    const successor = await bytes()
    expect(await json(managementLockPath)).toEqual(heldLease)
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
    await store.add(
      {
        ...stage(),
        ...(operation === 'recordIdentity' ? { identity: undefined } : {}),
      },
      { onExisting: 'stage-duplicate' },
    )
    if (operation === 'refresh') {
      const config = await json(configPath)
      config.accounts[0].enabled = true
      await write(configPath, config)
    }
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
        store.updateProviderState('new', captured, () => ({
          bound: 'updated-project',
          metadata: { cursor: 2 },
        })),
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
  config.accounts[0].type = 'invalid'
  await write(configPath, config)
  expect(await row('new')).toMatchObject({
    candidate: false,
    invalid: 'roster',
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
    // The store calls lock observers synchronously and does not await what
    // they return, so the key change is written synchronously here: it must
    // be on disk before the store re-reads the row keys under the lock. An
    // async write lands at an unpredictable point and can surface as an
    // attribution refusal instead of the retry being exercised.
    onLockEvent: (event) => {
      if (event.type === 'acquired' && event.name === 'provider-test') {
        attempts++
        const config = JSON.parse(readFileSync(configPath, 'utf8'))
        config.accounts.find(
          (raw: { id: string }) => raw.id === 'old',
        ).accountId = `changed-${attempts}`
        writeFileSync(configPath, `${JSON.stringify(config)}\n`)
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
    expect(synced.filter((path) => path === dir)).toHaveLength(4)
    expect(
      synced.filter(
        (path) => path.startsWith(`${configPath}.`) && path.endsWith('.tmp'),
      ),
    ).toHaveLength(2)
    expect(
      synced.filter((path) => path.startsWith(`${statePath}.`)),
    ).toHaveLength(1)
    expect(synced.filter((path) => path === statePath)).toHaveLength(1)
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
  let directories = 0
  const spy = spyOn(fs, 'open').mockImplementation(
    async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args)
      const sync = handle.sync.bind(handle)
      if (String(args[0]) === dir)
        handle.sync = async () => {
          if (++directories === 2) throw new Error('directory sync failed')
          await sync()
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

test('staged replacement keeps every committed and cleaned receipt permanently', async () => {
  for (let i = 0; i < 10; i++)
    await store.publishRoster({
      operationId: String(10 - i),
      remove: [],
      finalize: [],
      order: [],
    })
  expect(await store.publication('10')).toMatchObject({ phase: 'cleaned' })
  expect(await store.publication('9')).toMatchObject({ phase: 'cleaned' })
  expect(await store.publication('1')).toMatchObject({ phase: 'cleaned' })
  expect(
    Object.keys((await json(configPath)).commonAuthPool.publications),
  ).toHaveLength(10)
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
  const stdout = await output
  expect(exitCode, stderr).toBe(17)
  await expireChildLeases(stdout)
  expect(stdout).toContain(
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

test('staged revision rotating add fences the exact valid holder behind an invalid holder', async () => {
  await store.add({
    id: 'invalid',
    credential: oauth(),
    identity: 'first-wire',
  })
  await store.add(
    { ...stage(), credential: oauth() },
    { onExisting: 'stage-duplicate' },
  )
  const config = await json(configPath)
  config.commonAuthPool.rows.invalid.credentialEpoch = 0
  await write(configPath, config)
  await unchanged(
    () => store.add({ id: 'other', credential: oauth() }),
    'row-staged',
  )
})

for (const mode of ['rotate', 'refuse', 'stage-duplicate'] as const) {
  test(`staged revision ${mode} add cannot duplicate a staged orphan under another id`, async () => {
    await interruptAdd(stage())
    const input =
      mode === 'stage-duplicate'
        ? { ...stage('other'), credential: stage().credential }
        : { id: 'other', credential: stage().credential }
    await unchanged(() => store.add(input, { onExisting: mode }), 'row-staged')
    expect(
      await store.add(stage(), { onExisting: 'stage-duplicate' }),
    ).toMatchObject({ outcome: 'completed' })
  })
}

for (const combination of [
  'survivor and finalized',
  'two finalized',
  'two survivors',
] as const) {
  test(`staged revision publication rejects shared secret across different identities for ${combination}`, async () => {
    if (combination !== 'two finalized')
      await store.add({ id: 'one', credential: oauth(), identity: 'one-wire' })
    if (combination !== 'two survivors')
      await store.add(
        { ...stage('two', 'two-wire'), credential: oauth() },
        { onExisting: 'stage-duplicate' },
      )
    if (combination === 'two finalized')
      await store.add(
        { ...stage('one', 'one-wire'), credential: oauth() },
        { onExisting: 'stage-duplicate' },
      )
    if (combination === 'two survivors') {
      await store.add({
        id: 'two',
        credential: oauth('other'),
        identity: 'two-wire',
      })
      await store.rotate('two', oauth())
    }
    const finalize =
      combination === 'two survivors'
        ? []
        : [
            {
              id: 'two',
              attribution: await fence('two'),
              reservation: 'reservation',
              enabled: true,
            },
          ]
    if (combination === 'two finalized')
      finalize.push({
        id: 'one',
        attribution: await fence('one'),
        reservation: 'reservation',
        enabled: true,
      })
    await unchanged(
      () =>
        store.publishRoster({
          operationId: 'same-secret',
          remove: [],
          finalize,
          order: ['one', 'two'],
        }),
      'attribution',
    )
  })
}

async function tornSibling(kind: 'replace' | 'transition') {
  await store.add({
    id: 'sibling',
    credential: oauth('sibling'),
    identity: 'sibling-wire',
    providerState: { bound: 'original' },
  })
  const interrupted = open({
    onStep: (step) => {
      if (step === 'after-state-write') throw new Error('interrupt sibling')
    },
  })
  if (kind === 'replace')
    await expect(
      interrupted.replace('sibling', oauth('new-sibling'), {
        identity: 'new-sibling-wire',
      }),
    ).rejects.toMatchObject({ phase: 'after-first-write' })
  else
    await expect(
      interrupted.disable('sibling', 'off', {
        attribution: await fence('sibling'),
        providerState: () => ({ bound: 'new-state' }),
      }),
    ).rejects.toMatchObject({ phase: 'after-first-write' })
  expect((await row('sibling')).torn).toBe(true)
}

for (const kind of ['replace', 'transition'] as const) {
  test(`staged revision publication refuses a surviving torn ${kind} without repair`, async () => {
    await seed()
    await tornSibling(kind)
    const publication = await plan()
    publication.order.push('sibling')
    await unchanged(() => store.publishRoster(publication), 'attribution')
    await store.disable('sibling', 'completed')
    expect((await row('sibling')).torn).toBeUndefined()
    expect(await store.publishRoster(publication)).toMatchObject({
      outcome: 'published',
    })
  })
}

test('staged revision publication rejects duplicate raw roster ids instead of writing null accounts', async () => {
  await seed()
  const config = await json(configPath)
  config.accounts.push({ ...config.accounts[1] })
  await write(configPath, config)
  const publication = await plan()
  publication.order.push('ghost')
  await unchanged(() => store.publishRoster(publication), 'invalid-input')
})

for (const reason of ['identity-contradicted', 'duplicate-identity'] as const) {
  test(`staged revision enable ${reason} refusal does not repair a torn sibling`, async () => {
    await store.add({ id: 'target', credential: oauth(), identity: 'wire' })
    if (reason === 'identity-contradicted') {
      await store.refresh('target', async () => ({
        refresh: 'new',
        access: 'new',
        expires: 2000,
        identity: 'contradiction',
      }))
    } else {
      await store.disable('target', 'off')
      await store.add({
        id: 'holder',
        credential: oauth('holder'),
        identity: 'wire',
      })
    }
    await tornSibling('replace')
    const before = await bytes()
    await expect(
      store.enable('target', { attribution: await fence('target') }),
    ).rejects.toMatchObject({ kind: reason, phase: 'before-first-write' })
    expect(await bytes()).toEqual(before)
    expect((await row('sibling')).torn).toBe(true)
  })
}

for (const operation of ['enable', 'disable'] as const) {
  test(`staged revision ${operation} provider mutator refusal precedes any torn repair`, async () => {
    await store.add({
      id: 'target',
      credential: oauth(),
      providerState: { bound: 'project' },
    })
    await tornSibling('replace')
    const callOptions = {
      attribution: await fence('target'),
      providerState: () => {
        throw new Error('mutator refuses')
      },
    }
    await unchanged(
      () =>
        operation === 'enable'
          ? store.enable('target', callOptions)
          : store.disable('target', 'off', callOptions),
      'unexpected',
    )
    expect((await row('sibling')).torn).toBe(true)
  })
}

test('staged revision every publication receipt remains a permanent replay fence', async () => {
  const plans = Array.from({ length: 10 }, (_, i) => ({
    operationId: `forever-${i}`,
    remove: [],
    finalize: [],
    order: [],
  }))
  for (const publication of plans) await store.publishRoster(publication)
  for (const publication of plans)
    expect(await store.publication(publication.operationId)).toMatchObject({
      operationId: publication.operationId,
      phase: 'cleaned',
      removed: [],
      finalized: [],
    })
  const before = await bytes()
  expect(await store.publishRoster(plans[0]!)).toMatchObject({
    outcome: 'already-cleaned',
  })
  expect(await bytes()).toEqual(before)
  await unchanged(
    () => store.publishRoster({ ...plans[0]!, order: ['other'] }),
    'publication-mismatch',
  )
})

test('staged revision config read before publication and state read after cleanup retries lock free', async () => {
  await seed()
  const publication = await plan()
  const captured = deferred()
  const resume = deferred()
  hooks.lifetime.unpark(resume.resolve)
  const originalRead = fs.readFile
  let arm = true
  let readerLocks = 0
  const reader = open({
    onLockEvent: () => {
      readerLocks++
    },
  })
  const spy = spyOn(fs, 'readFile').mockImplementation((async (
    ...args: Parameters<typeof fs.readFile>
  ) => {
    const value = await originalRead(...args)
    if (arm && String(args[0]) === configPath) {
      arm = false
      captured.resolve()
      await resume.promise
    }
    return value
  }) as typeof fs.readFile)
  try {
    const read = hooks.lifetime.operation(reader.read())
    await observed(hooks.lifetime, captured.promise)
    await store.publishRoster(publication)
    resume.resolve()
    const result = await read
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') throw new Error(result.status)
    expect(
      result.rows.filter((row) => row.candidate).map((row) => row.id),
    ).toEqual(['new'])
    expect(readerLocks).toBe(0)
  } finally {
    spy.mockRestore()
  }
})

test('staged revision reserved pull capture and quota recording write nothing even beside a torn sibling', async () => {
  await store.add(stage(), { onExisting: 'stage-duplicate' })
  await tornSibling('replace')
  const config = await json(configPath)
  config.accounts.find((raw: { id: string }) => raw.id === 'new').enabled = true
  await write(configPath, config)
  let polled = 0
  const reader = open({
    pull: async () => {
      polled++
      return {}
    },
  })
  const before = await bytes()
  reader.requestReading('new')
  await reader.pullsSettled()
  expect(polled).toBe(0)
  expect(await bytes()).toEqual(before)
  await unchanged(
    () =>
      reader.recordQuota('new', { credentialEpoch: 1, identity: 'wire' }, {}),
    'row-staged',
  )
})

for (const field of ['providerState', 'label', 'disabledReason'] as const) {
  test(`staged revision finalize rejects changed full staged ${field} material`, async () => {
    await seed()
    const publication = await plan()
    if (field === 'providerState') {
      const state = await json(statePath)
      state.accounts.new.commonAuthProviderState.metadata.cursor = 9
      await write(statePath, state)
    } else {
      const config = await json(configPath)
      if (field === 'label')
        config.accounts.find((raw: { id: string }) => raw.id === 'new').label =
          'changed'
      else config.commonAuthPool.rows.new.disabledReason = 'changed'
      await write(configPath, config)
    }
    await unchanged(() => store.publishRoster(publication), 'row-staged')
  })
}

async function syncRecorder() {
  const events: string[] = []
  const originalOpen = fs.open
  const originalRename = fs.rename
  const which = (path: string) =>
    path.startsWith(statePath) || path === dirname(statePath)
      ? 'state'
      : 'config'
  const opens = spyOn(fs, 'open').mockImplementation(
    async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args)
      const sync = handle.sync.bind(handle)
      const path = String(args[0])
      handle.sync = async () => {
        const kind = path.endsWith('.tmp')
          ? 'temp'
          : path === dirname(configPath) || path === dirname(statePath)
            ? 'directory'
            : 'file'
        events.push(`${which(path)}:${kind}:sync`)
        await sync()
      }
      return handle
    },
  )
  const renames = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    events.push(`${which(String(to))}:rename`)
    await originalRename(from, to)
  })
  return {
    events,
    restore: () => {
      opens.mockRestore()
      renames.mockRestore()
    },
  }
}

async function separateStateDir() {
  statePath = join(dir, 'state', 'state.json')
  store = open()
  await seed()
}

test('staged revision publication syncs staged state before the durable roster decision', async () => {
  await separateStateDir()
  const publication = await plan()
  const recorder = await syncRecorder()
  try {
    await store.publishRoster(publication)
    expect(recorder.events.slice(0, 5)).toEqual([
      'state:file:sync',
      'state:directory:sync',
      'config:temp:sync',
      'config:rename',
      'config:directory:sync',
    ])
  } finally {
    recorder.restore()
  }
})

test('staged revision committed receipt replay resyncs config before any cleanup write', async () => {
  await separateStateDir()
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
  const recorder = await syncRecorder()
  try {
    expect(await store.publishRoster(publication)).toMatchObject({
      outcome: 'cleaned',
    })
    expect(recorder.events.slice(0, 2)).toEqual([
      'config:file:sync',
      'config:directory:sync',
    ])
    expect(recorder.events.indexOf('state:rename')).toBeGreaterThan(1)
  } finally {
    recorder.restore()
  }
})

test('staged revision cleanup state file and directory are durable before cleaned receipt', async () => {
  await separateStateDir()
  const publication = await plan()
  const recorder = await syncRecorder()
  try {
    await store.publishRoster(publication)
    expect(recorder.events.slice(-6)).toEqual([
      'state:temp:sync',
      'state:rename',
      'state:directory:sync',
      'config:temp:sync',
      'config:rename',
      'config:directory:sync',
    ])
  } finally {
    recorder.restore()
  }
})

test('staged revision committed receipts survive every later cleaned publication', async () => {
  await seed()
  const publication = await plan('pending-forever')
  const publisher = open({
    onStep: (step, info) => {
      if (info.operation === 'publishRoster' && step === 'after-config-write')
        throw new Error('stop after commit')
    },
  })
  await expect(publisher.publishRoster(publication)).rejects.toMatchObject({
    phase: 'after-first-write',
  })
  const committed = await store.publication(publication.operationId)
  for (let i = 0; i < 10; i++)
    await store.publishRoster({
      operationId: `later-${i}`,
      remove: [],
      finalize: [],
      order: ['new'],
    })
  expect(await store.publication(publication.operationId)).toEqual(committed)
  expect(await store.publishRoster(publication)).toMatchObject({
    outcome: 'cleaned',
  })
})

test('staged revision publication rejects duplicate removed roster ids too', async () => {
  await seed()
  const publication = await plan()
  const config = await json(configPath)
  config.accounts.push({ ...config.accounts[0] })
  await write(configPath, config)
  await unchanged(() => store.publishRoster(publication), 'invalid-input')
})

test('staged revision snapshot validation refuses after three changing config reads without locks', async () => {
  await seed()
  const originalRead = fs.readFile
  let configReads = 0
  let locks = 0
  const reader = open({
    onLockEvent: () => {
      locks++
    },
  })
  const spy = spyOn(fs, 'readFile').mockImplementation((async (
    ...args: Parameters<typeof fs.readFile>
  ) => {
    const value = await originalRead(...args)
    if (String(args[0]) === configPath && ++configReads % 2 === 1) {
      const config = JSON.parse(String(value))
      config.readGeneration = configReads
      await write(configPath, config)
    }
    return value
  }) as typeof fs.readFile)
  try {
    expect(await reader.read()).toMatchObject({
      status: 'error',
      file: 'config',
      reason: 'The store was changing; retry the operation once writes settle.',
      kind: 'snapshot-contended',
      retryable: true,
    })
    expect(configReads).toBe(6)
    expect(locks).toBe(0)
  } finally {
    spy.mockRestore()
  }
})

for (const barrier of [
  'prepublication-state',
  'committed-config',
  'cleanup-state',
] as const) {
  test(`staged revision ${barrier} sync rejection prevents the next irreversible write`, async () => {
    await separateStateDir()
    const publication = await plan()
    if (barrier === 'committed-config') {
      const publisher = open({
        onStep: (step, info) => {
          if (
            info.operation === 'publishRoster' &&
            step === 'after-config-write'
          )
            throw new Error('stop after commit')
        },
      })
      await expect(publisher.publishRoster(publication)).rejects.toMatchObject({
        phase: 'after-first-write',
      })
    }
    const before = await bytes()
    const originalOpen = fs.open
    const spy = spyOn(fs, 'open').mockImplementation(
      async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args)
        const path = String(args[0])
        const rejects =
          barrier === 'prepublication-state'
            ? path === statePath
            : barrier === 'committed-config'
              ? path === configPath
              : path.startsWith(`${statePath}.`) && path.endsWith('.tmp')
        if (rejects)
          handle.sync = async () => {
            throw new Error('sync refuses')
          }
        return handle
      },
    )
    try {
      await expect(store.publishRoster(publication)).rejects.toMatchObject({
        phase:
          barrier === 'cleanup-state'
            ? 'after-first-write'
            : 'before-first-write',
      })
    } finally {
      spy.mockRestore()
    }
    if (barrier !== 'cleanup-state') expect(await bytes()).toEqual(before)
    else expect(await fs.readFile(statePath, 'utf8')).toBe(before[1]!)
    if (barrier === 'prepublication-state')
      expect(await store.publication('publication')).toBeUndefined()
    else
      expect(await store.publication('publication')).toMatchObject({
        phase: 'committed',
      })
  })
}

for (const operation of [
  'read',
  'replace',
  'rotate',
  'enable',
  'disable',
  'recordIdentity',
  'remove',
  'publishRoster',
] as const) {
  test(`final audit snapshot contention is retryable at ${operation} lock key pre-read`, async () => {
    await seed()
    const publication = await plan()
    let locks = 0
    const caller = open({
      onLockEvent: () => {
        locks++
      },
    })
    const originalRead = fs.readFile
    let configReads = 0
    const spy = spyOn(fs, 'readFile').mockImplementation((async (
      ...args: Parameters<typeof fs.readFile>
    ) => {
      const value = await originalRead(...args)
      if (String(args[0]) === configPath && ++configReads % 2 === 1) {
        const config = JSON.parse(String(value))
        config.churn = configReads
        await write(configPath, config)
      }
      return value
    }) as typeof fs.readFile)
    try {
      if (operation === 'read') {
        expect(await caller.read()).toMatchObject({
          status: 'error',
          kind: 'snapshot-contended',
          retryable: true,
          reason:
            'The store was changing; retry the operation once writes settle.',
        })
      } else {
        const calls = {
          replace: () => caller.replace('old', oauth('replacement')),
          rotate: () => caller.rotate('old', oauth('rotation')),
          enable: () => caller.enable('old'),
          disable: () => caller.disable('old', 'off'),
          recordIdentity: () =>
            caller.recordIdentity('old', 'wire', { credentialEpoch: 1 }),
          remove: () => caller.remove('old'),
          publishRoster: () => caller.publishRoster(publication),
        }
        await expect(calls[operation]()).rejects.toMatchObject({
          kind: 'snapshot-contended',
          retryable: true,
          phase: 'before-first-write',
          message:
            'The store was changing; retry the operation once writes settle.',
        })
      }
      expect(configReads).toBe(6)
      expect(locks).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })
}

for (const barrier of [
  'pre-decision-state',
  'pre-decision-config',
  'decision-directory',
  'replay-config',
  'cleanup-state',
  'cleaned-config',
] as const) {
  test(`final audit ${barrier} sync failure is a typed retryable publication refusal`, async () => {
    await separateStateDir()
    const publication = await plan()
    if (barrier === 'replay-config') {
      const interrupted = open({
        onStep: (step, info) => {
          if (
            step === 'after-config-write' &&
            info.operation === 'publishRoster'
          )
            throw new Error('interrupt')
        },
      })
      await expect(
        interrupted.publishRoster(publication),
      ).rejects.toMatchObject({ phase: 'after-first-write' })
    }
    const before = await bytes()
    const originalOpen = fs.open
    let configTemps = 0
    const spy = spyOn(fs, 'open').mockImplementation(
      async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args)
        const path = String(args[0])
        if (path.startsWith(`${configPath}.`) && path.endsWith('.tmp'))
          configTemps++
        const reject =
          barrier === 'pre-decision-state'
            ? path === statePath
            : barrier === 'pre-decision-config'
              ? path.startsWith(`${configPath}.`) &&
                path.endsWith('.tmp') &&
                configTemps === 1
              : barrier === 'decision-directory'
                ? path === dirname(configPath)
                : barrier === 'replay-config'
                  ? path === configPath
                  : barrier === 'cleanup-state'
                    ? path.startsWith(`${statePath}.`) && path.endsWith('.tmp')
                    : path.startsWith(`${configPath}.`) &&
                      path.endsWith('.tmp') &&
                      configTemps === 2
        if (reject)
          handle.sync = async () => {
            throw new Error('injected sync failure')
          }
        return handle
      },
    )
    try {
      await expect(store.publishRoster(publication)).rejects.toMatchObject({
        kind: barrier.startsWith('pre-decision')
          ? 'publication-sync'
          : 'publication-incomplete',
        retryable: true,
        message: barrier.startsWith('pre-decision')
          ? 'Publication sync failed before the decision; nothing was written. Retry the same plan.'
          : 'The publication may already be decided. Replay the same plan or check publication(operationId).',
      })
    } finally {
      spy.mockRestore()
    }
    if (barrier.startsWith('pre-decision')) {
      expect(await bytes()).toEqual(before)
      expect(await store.publication(publication.operationId)).toBeUndefined()
    } else
      expect(await store.publication(publication.operationId)).toMatchObject({
        phase: 'committed',
      })
    expect(await store.publishRoster(publication)).toMatchObject({
      outcome: barrier.startsWith('pre-decision') ? 'published' : 'cleaned',
      receipt: { phase: 'cleaned' },
    })
  })
}

test('final audit surviving torn row requires explicit completion instead of blind retry', async () => {
  await seed()
  await tornSibling('replace')
  const publication = await plan()
  publication.order.push('sibling')
  const before = await bytes()
  await expect(store.publishRoster(publication)).rejects.toMatchObject({
    kind: 'attribution',
    retryable: false,
    message:
      'Row sibling has an interrupted write; complete it with a normal store operation before publishing.',
  })
  expect(await bytes()).toEqual(before)
})

test('final audit publication carries unnamed and invalid roster rows verbatim after ordered survivors', async () => {
  await seed()
  const publication = await plan()
  const config = await json(configPath)
  const preserved = [
    null,
    { metadata: { untouched: true } },
    17,
    { id: 'broken', type: 'unsupported', enabled: true, extra: ['keep', 2] },
  ]
  config.accounts = [
    preserved[0],
    config.accounts[0],
    preserved[1],
    config.accounts[1],
    ...preserved.slice(2),
  ]
  config.commonAuthPool.rows.broken = { credentialEpoch: 4, unknown: 'keep' }
  await write(configPath, config)
  await store.publishRoster(publication)
  const after = await json(configPath)
  expect(after.accounts[0].id).toBe('new')
  expect(JSON.stringify(after.accounts.slice(1))).toBe(
    JSON.stringify(preserved),
  )
  expect(after.commonAuthPool.rows.broken).toEqual(
    config.commonAuthPool.rows.broken,
  )
  const result = await store.read()
  if (result.status !== 'ready') throw new Error(result.status)
  expect(
    result.rows.filter((row) => row.candidate).map((row) => row.id),
  ).toEqual(['new'])
})

for (const reason of [
  'endpoint-mismatch',
  'merge-rejection',
  'bound-projection-rejection',
  'id-exists',
  'invalid-row',
  'unbound-credential',
  'type-mismatch',
  'identity-mismatch',
  'epoch-exhausted',
] as const) {
  test(`final audit add ${reason} refusal leaves torn siblings and both files unchanged`, async () => {
    const api = {
      type: 'api' as const,
      apiKey: 'key',
      baseURL: 'https://original.example/',
    }
    if (reason === 'endpoint-mismatch')
      await store.add({ id: 'target', credential: api })
    else
      await store.add({
        id: 'target',
        credential: oauth(),
        identity: 'wire',
        providerState: { bound: 'project' },
      })
    await tornSibling('replace')
    let input: AddInput = { id: 'other', credential: oauth() }
    const kind =
      reason === 'merge-rejection' || reason === 'bound-projection-rejection'
        ? 'unexpected'
        : reason === 'epoch-exhausted'
          ? 'id-removed'
          : reason
    if (reason === 'endpoint-mismatch')
      input = {
        id: 'other',
        credential: { ...api, baseURL: 'https://different.example/' },
      }
    if (
      reason === 'merge-rejection' ||
      reason === 'bound-projection-rejection'
    ) {
      input.providerState = { bound: 'next', reject: true }
      store = open({
        providerState: {
          validate: () => true,
          ...(reason === 'merge-rejection'
            ? {
                merge: () => {
                  throw new Error('merge refuses')
                },
              }
            : {}),
          credentialBound: (value) => {
            if (
              reason === 'bound-projection-rejection' &&
              (value as { reject?: boolean }).reject
            )
              throw new Error('projection refuses')
            return (value as { bound: string }).bound
          },
        },
      })
    }
    if (
      reason === 'id-exists' ||
      reason === 'invalid-row' ||
      reason === 'unbound-credential' ||
      reason === 'type-mismatch' ||
      reason === 'identity-mismatch'
    ) {
      input = { id: 'target', credential: oauth('different') }
      const config = await json(configPath)
      const state = await json(statePath)
      if (reason === 'invalid-row')
        config.commonAuthPool.rows.target.credentialEpoch = 0
      if (
        reason === 'unbound-credential' ||
        reason === 'type-mismatch' ||
        reason === 'identity-mismatch'
      )
        delete state.accounts.target
      if (reason === 'type-mismatch') {
        config.accounts.find(
          (raw: { id: string }) => raw.id === 'target',
        ).type = 'api'
        config.accounts.find(
          (raw: { id: string }) => raw.id === 'target',
        ).baseURL = 'https://original.example/'
        store = open({ requireCredentialStamps: false })
      }
      if (reason === 'identity-mismatch') {
        input.identity = 'another-wire'
        store = open({ requireCredentialStamps: false })
      }
      await write(configPath, config)
      await write(statePath, state)
    }
    if (reason === 'epoch-exhausted') {
      input = { id: 'spent', credential: oauth('fresh') }
      const config = await json(configPath)
      config.commonAuthPool.retiredEpochs = { spent: Number.MAX_SAFE_INTEGER }
      await write(configPath, config)
    }
    await unchanged(() => store.add(input), kind)
    expect((await row('sibling')).torn).toBe(true)
  })
}

test('final audit snapshot retries wait with bounded jitter without taking locks', async () => {
  await seed()
  const originalRead = fs.readFile
  let configReads = 0
  let locks = 0
  const reader = open({
    onLockEvent: () => {
      locks++
    },
  })
  const delays: number[] = []
  const random = spyOn(Math, 'random')
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(0.99)
  const timer = spyOn(timers, 'setTimeout').mockImplementation((async (
    delay?: number,
  ) => {
    delays.push(delay ?? 0)
  }) as typeof timers.setTimeout)
  const spy = spyOn(fs, 'readFile').mockImplementation((async (
    ...args: Parameters<typeof fs.readFile>
  ) => {
    const value = await originalRead(...args)
    if (String(args[0]) === configPath && ++configReads % 2 === 1) {
      const config = JSON.parse(String(value))
      config.churn = configReads
      await write(configPath, config)
    }
    return value
  }) as typeof fs.readFile)
  try {
    await reader.read()
    expect(delays).toEqual([2, 5])
    expect(locks).toBe(0)
  } finally {
    spy.mockRestore()
    timer.mockRestore()
    random.mockRestore()
  }
})

for (const torn of ['replace', 'transition'] as const) {
  for (const operation of ['enable', 'disable'] as const) {
    test(`final audit fenced ${operation} plans the same account and stamp for a torn target ${torn}`, async () => {
      await store.add({
        id: 'target',
        credential: oauth(),
        identity: 'wire',
        providerState: { bound: 'initial', metadata: 1 },
      })
      const interrupted = open({
        onStep: (step) => {
          if (step === 'after-state-write') throw new Error('interrupt target')
        },
      })
      if (torn === 'replace')
        await expect(
          interrupted.replace('target', oauth('new-target'), {
            identity: 'new-wire',
            providerState: { bound: 'replacement', metadata: 2 },
          }),
        ).rejects.toMatchObject({ phase: 'after-first-write' })
      else
        await expect(
          interrupted.disable('target', 'pending', {
            attribution: await fence('target'),
            providerState: () => ({ bound: 'transition', metadata: 2 }),
          }),
        ).rejects.toMatchObject({ phase: 'after-first-write' })
      const captured = await fence('target')
      const config = await json(configPath)
      const state = await json(statePath)
      const controlConfig = join(dir, 'completed-config.json')
      const controlState = join(dir, 'completed-state.json')
      const completed = completeTornRows(config, state, options().quota, {
        requireCredentialStamps: true,
      })
      await write(controlConfig, completed.config)
      await write(controlState, state)
      const control = openPoolStore({
        ...options(),
        configPath: controlConfig,
        statePath: controlState,
      })
      const expectedEpoch = torn === 'replace' ? 2 : 1
      const expectedIdentity = torn === 'replace' ? 'new-wire' : 'wire'
      const uuid = spyOn(crypto, 'randomUUID').mockReturnValue(
        '11111111-1111-4111-8111-111111111111',
      )
      const callOptions = {
        attribution: captured,
        providerState: () => ({ bound: 'final', metadata: 3 }),
      }
      try {
        if (operation === 'enable') {
          await store.enable('target', callOptions)
          await control.enable('target', callOptions)
        } else {
          await store.disable('target', 'final reason', callOptions)
          await control.disable('target', 'final reason', callOptions)
        }
      } finally {
        uuid.mockRestore()
      }
      const account = (await json(statePath)).accounts.target
      expect(account).toEqual((await json(controlState)).accounts.target)
      expect(account.commonAuthProviderState).toEqual({
        bound: 'final',
        metadata: 3,
      })
      expect(account.commonAuthPool).toMatchObject({
        credentialEpoch: expectedEpoch,
        binding: { identity: expectedIdentity },
      })
      expect((await json(configPath)).commonAuthPool.rows.target).toEqual(
        (await json(controlConfig)).commonAuthPool.rows.target,
      )
      expect(await row('target')).toMatchObject({
        credentialEpoch: expectedEpoch,
        identity: expectedIdentity,
        stamp: 'bound',
        enabled: operation === 'enable',
      })
      expect((await row('target')).torn).toBeUndefined()
    })
  }
}

test('final audit accepted API re-add plans the projected torn endpoint and epoch', async () => {
  await store.add({
    id: 'target',
    credential: {
      type: 'api',
      apiKey: 'old-key',
      baseURL: 'https://old.example/',
    },
    identity: 'old-wire',
  })
  const interrupted = open({
    onStep: (step) => {
      if (step === 'after-state-write')
        throw new Error('interrupt API replacement')
    },
  })
  const credential = {
    type: 'api' as const,
    apiKey: 'new-key',
    baseURL: 'https://new.example/',
    authHeader: 'x-api-key' as const,
  }
  await expect(
    interrupted.replace('target', credential, {
      identity: 'new-wire',
      providerState: { bound: 'replacement' },
    }),
  ).rejects.toMatchObject({ phase: 'after-first-write' })
  const added = await store.add({
    id: 'other',
    credential,
    identity: 'new-wire',
  })
  expect(added).toMatchObject({
    id: 'target',
    outcome: 'rotated',
    credentialEpoch: 2,
    credential,
  })
  expect((await json(statePath)).accounts.target.commonAuthPool).toMatchObject({
    credentialEpoch: 2,
    binding: {
      identity: 'new-wire',
      baseURL: 'https://new.example/',
      authHeader: 'x-api-key',
    },
  })
  expect(await row('target')).toMatchObject({
    credentialEpoch: 2,
    stamp: 'bound',
    credential,
    identity: 'new-wire',
  })
  expect((await row('target')).torn).toBeUndefined()
})
