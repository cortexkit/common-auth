import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { withLock } from '../../src/fs/with-lock.js'
import {
  POOL_KEY,
  type PoolOperationError,
  type PullRequest,
} from '../../src/store/index.js'
import {
  CRASH_EXIT_CODE,
  deferred,
  oauth,
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

async function rowOf(id: string) {
  const load = await s.open().read()
  if (load.status !== 'ready') throw new Error(`pool is ${load.status}`)
  return load.rows.find((row) => row.id === id)
}

function crashChild(task: Record<string, unknown>) {
  return runChild({ configPath: s.configPath, statePath: s.statePath, ...task })
}

function pausedPull() {
  const entered = deferred<PullRequest>()
  const release = deferred()
  return {
    entered,
    release,
    hook: async (request: PullRequest) => {
      entered.resolve(request)
      await release.promise
      return `reading-epoch-${request.credentialEpoch}`
    },
  }
}

describe('crash windows, with the observer surviving', () => {
  it('a crash after the state write of add leaves only a state entry no reader loads and a re-run add adds the row at epoch 1', async () => {
    await s.open().add({ id: 'b', credential: oauth('r-b') })
    const child = crashChild({
      op: 'add',
      id: 'a',
      credential: oauth('r-a'),
      exitAt: 'after-state-write',
    })
    expect(await child.exited).toBe(CRASH_EXIT_CODE)
    const store = s.open()
    expect(await rowOf('a')).toBeUndefined()
    expect((await s.state()).accounts.a.refresh).toBe('r-a')
    const refresh = await rejectionOf(
      store.refresh('a', async () => ({
        access: 'x',
        refresh: 'y',
        expires: 1,
      })),
    )
    expect(refresh.kind).toBe('unknown-row')
    expect(
      (await store.add({ id: 'a', credential: oauth('r-a') })).outcome,
    ).toBe('added')
    expect(await rowOf('a')).toMatchObject({
      credentialEpoch: 1,
      candidate: true,
    })
    const again = await rejectionOf(
      store.add({ id: 'a', credential: oauth('r-other') }),
    )
    expect(again.kind).toBe('id-exists')
  })

  it('a roster row left without a credential is completed at epoch 1 by a re-run add', async () => {
    // What an add of an earlier version left when it stopped between its
    // config and state writes.
    await s.writeConfig({
      version: 1,
      accounts: [{ id: 'a', type: 'oauth', addedAt: 1 }],
      [POOL_KEY]: {
        schemaVersion: 1,
        rows: { a: { credentialEpoch: 1, needsFirstReading: true } },
      },
    })
    const store = s.open()
    expect(await rowOf('a')).toMatchObject({
      credentialEpoch: 1,
      candidate: false,
    })
    const refresh = await rejectionOf(
      store.refresh('a', async () => ({
        access: 'x',
        refresh: 'y',
        expires: 1,
      })),
    )
    expect(refresh.kind).toBe('no-credential')
    expect(
      (await store.add({ id: 'a', credential: oauth('r-a') })).outcome,
    ).toBe('completed')
    expect(await rowOf('a')).toMatchObject({
      credentialEpoch: 1,
      candidate: true,
    })
  })

  it('a crash after the state write of replace leaves a torn row and a survivor pull for the prior epoch fails attribution', async () => {
    await s.open().add({ id: 'r', credential: oauth('r-old') })
    const pull = pausedPull()
    const failed = deferred<PoolOperationError>()
    const survivor = s.open({
      pull: pull.hook,
      onPullFailure: (_id, error) => failed.resolve(error),
    })
    survivor.requestReading('r')
    expect((await pull.entered.promise).credentialEpoch).toBe(1)
    const child = crashChild({
      op: 'replace',
      id: 'r',
      credential: oauth('r-new'),
      exitAt: 'after-state-write',
    })
    expect(await child.exited).toBe(CRASH_EXIT_CODE)
    let row = await rowOf('r')
    expect(row).toMatchObject({
      credentialEpoch: 2,
      torn: true,
      candidate: false,
    })
    expect(row?.credential).toMatchObject({ refresh: 'r-new' })
    pull.release.resolve()
    expect(await failed.promise).toMatchObject({ kind: 'attribution' })
    await s.open().replace('r', oauth('r-new'))
    row = await rowOf('r')
    expect(row).toMatchObject({ credentialEpoch: 3 })
    expect(row?.credential).toMatchObject({ refresh: 'r-new' })
  })

  it('a crash after the state write of rotate leaves the rotated credential and the next refresh completes the identity write-back', async () => {
    await s.open().add({ id: 'a', credential: oauth('r-a') })
    const child = crashChild({
      op: 'rotate',
      id: 'a',
      credential: oauth('r-rotated'),
      identity: 'acct-1',
      exitAt: 'after-state-write',
    })
    expect(await child.exited).toBe(CRASH_EXIT_CODE)
    let row = await rowOf('a')
    expect(row?.credential).toMatchObject({ refresh: 'r-rotated' })
    // The rotated credential's stamp names the identity being learnt: the row
    // is shown with it, completed forward and no candidate, while the config
    // still lacks it.
    expect(row).toMatchObject({
      identity: 'acct-1',
      torn: true,
      candidate: false,
    })
    expect((await s.config()).accounts[0].accountId).toBeUndefined()
    await s.open().refresh('a', async (credential) => {
      expect(credential.refresh).toBe('r-rotated')
      return {
        access: 'x',
        refresh: 'r-next',
        expires: 4_000_000_000_000,
        identity: 'acct-1',
      }
    })
    row = await rowOf('a')
    expect(row).toMatchObject({
      identity: 'acct-1',
      credentialEpoch: 1,
      candidate: true,
    })
    expect(row?.torn).toBeUndefined()
  })

  it('a crash after the state write of a rotate with nothing to record is indistinguishable from completion', async () => {
    await s
      .open()
      .add({ id: 'a', credential: oauth('r-a'), identity: 'acct-1' })
    const configBefore = (await s.bytes()).config
    const child = crashChild({
      op: 'rotate',
      id: 'a',
      credential: oauth('r-rotated'),
      exitAt: 'after-state-write',
    })
    expect(await child.exited).toBe(CRASH_EXIT_CODE)
    expect((await s.bytes()).config).toBe(configBefore)
    const row = await rowOf('a')
    expect(row).toMatchObject({
      identity: 'acct-1',
      credentialEpoch: 1,
      candidate: true,
    })
    expect(row?.credential).toMatchObject({ refresh: 'r-rotated' })
  })

  it('a pull paused in a survivor still applies after another process rotated the row and crashed', async () => {
    await s.open().add({ id: 'r', credential: oauth('r-1') })
    const pull = pausedPull()
    const survivor = s.open({ pull: pull.hook })
    survivor.requestReading('r')
    await pull.entered.promise
    const child = crashChild({
      op: 'rotate',
      id: 'r',
      credential: oauth('r-2'),
      exitAt: 'after-state-write',
    })
    expect(await child.exited).toBe(CRASH_EXIT_CODE)
    pull.release.resolve()
    await survivor.pullsSettled()
    expect((await rowOf('r'))?.quota).toEqual({ readings: ['reading-epoch-1'] })
  })

  it('a pull issued after a crash between replace writes completes the row and reads the replacement until a re-run replace supersedes it', async () => {
    await s.open().add({ id: 'r', credential: oauth('r-old') })
    const child = crashChild({
      op: 'replace',
      id: 'r',
      credential: oauth('r-new'),
      exitAt: 'after-state-write',
    })
    expect(await child.exited).toBe(CRASH_EXIT_CODE)
    const requests: PullRequest[] = []
    const survivor = s.open({
      pull: async (request) => {
        requests.push(request)
        return `reading-epoch-${request.credentialEpoch}`
      },
    })
    survivor.requestReading('r')
    await survivor.pullsSettled()
    expect(requests[0]).toMatchObject({ credentialEpoch: 2 })
    expect(requests[0]?.credential).toMatchObject({ refresh: 'r-new' })
    expect((await rowOf('r'))?.quota).toEqual({ readings: ['reading-epoch-2'] })
    await survivor.replace('r', oauth('r-new'))
    await survivor.pullsSettled()
    const row = await rowOf('r')
    expect(row).toMatchObject({
      credentialEpoch: 3,
      quota: { readings: ['reading-epoch-3'] },
    })
    expect(row?.credential).toMatchObject({ refresh: 'r-new' })
  })

  it('a refresh paused in a survivor fails attribution when a replace intermediate lands during its provider call', async () => {
    await s.open().add({ id: 'r', credential: oauth('r-old') })
    const entered = deferred()
    const release = deferred()
    const log: string[] = []
    const refresh = s.open().refresh(
      'r',
      async () => {
        entered.resolve()
        await release.promise
        return { access: 'x', refresh: 'r-rotated', expires: 4_000_000_000_000 }
      },
      {
        onPersisted: () => void log.push('persisted'),
        onFailure: (_id, error) => void log.push(`failure ${error.kind}`),
      },
    )
    await entered.promise
    // Plant what an interrupted replace leaves after its config write: bumped
    // epoch, cleared quota, prior credential. The library's own replace cannot
    // write it while this refresh holds the row lock, so the test writes the
    // config directly under the store lock.
    await withLock(
      s.configPath,
      { name: 'save', ttlMs: 10_000, timeoutMs: 5_000 },
      async () => {
        const config = await s.config()
        config[POOL_KEY].rows.r = {
          credentialEpoch: 2,
          needsFirstReading: true,
        }
        await s.writeConfig(config)
      },
    )
    release.resolve()
    const error = await rejectionOf(refresh)
    expect(error).toMatchObject({
      kind: 'attribution',
      phase: 'before-first-write',
      retryable: true,
      committed: undefined,
    })
    expect(log).toEqual(['failure attribution'])
    expect((await rowOf('r'))?.credential).toMatchObject({ refresh: 'r-old' })
  })

  it('two processes adding rows concurrently lose no write', async () => {
    const child = crashChild({ op: 'addMany', id: 'child', count: 8 })
    const store = s.open()
    for (let index = 0; index < 8; index++)
      await store.add({
        id: `parent-${index}`,
        credential: oauth(`p-${index}`),
      })
    expect(await child.exited).toBe(0)
    const load = await store.read()
    if (load.status !== 'ready') throw new Error('expected ready')
    expect(load.rows.length).toBe(16)
    expect(load.rows.every((row) => row.candidate)).toBe(true)
  })
})

for (const step of [
  'before-state-write',
  'after-state-write',
  'before-config-write',
  'after-config-write',
] as const) {
  it(`a contradicted refresh crash at ${step} never exposes rotated enabled credentials`, async () => {
    await s
      .open()
      .add({ id: 'a', credential: oauth('r-old'), identity: 'acct-A' })
    const child = crashChild({
      op: 'refresh',
      id: 'a',
      credential: oauth('r-new'),
      renew: true,
      identity: 'acct-B',
      exitAt: step,
    })
    expect(await child.exited).toBe(CRASH_EXIT_CODE)
    const store = s.open({ requireCredentialStamps: true })
    let load = await store.read()
    if (load.status !== 'ready') throw new Error('expected ready')
    let row = load.rows.find((row) => row.id === 'a')
    expect(row).toMatchObject({
      identity: 'acct-A',
      stamp: 'bound',
      credential: {
        refresh: step === 'before-state-write' ? 'r-old' : 'r-new',
      },
      enabled: step === 'before-state-write',
      candidate: step === 'before-state-write',
    })
    if (step !== 'before-state-write') {
      expect(row?.disabledReason).toBe(
        'identity-contradicted: {"expectedIdentity":"acct-A","returnedIdentity":"acct-B"}',
      )
      // A store write completes any interrupted config transition before proceeding.
      await store.add({ id: 'survivor', credential: oauth('r-survivor') })
      load = await store.read()
      if (load.status !== 'ready') throw new Error('expected ready')
      row = load.rows.find((row) => row.id === 'a')
      expect(row).toMatchObject({
        enabled: false,
        candidate: false,
        stamp: 'bound',
        identity: 'acct-A',
        credential: { refresh: 'r-new' },
      })
      expect(row?.torn).toBeUndefined()
      expect((await s.config()).accounts[0]).toMatchObject({
        enabled: false,
        accountId: 'acct-A',
      })
    }
  })
}

it('ordinary and contradicted exchanges both lose an in-memory successor before the first state rename', async () => {
  for (const identity of ['acct-A', 'acct-B']) {
    const id = identity === 'acct-A' ? 'ordinary' : 'contradicted'
    await s.open().add({ id, credential: oauth('r-old'), identity: 'acct-A' })
    const child = crashChild({
      op: 'refresh',
      id,
      credential: oauth('r-lost'),
      renew: true,
      identity,
      exitAt: 'before-state-write',
    })
    expect(await child.exited).toBe(CRASH_EXIT_CODE)
    expect(await rowOf(id)).toMatchObject({
      identity: 'acct-A',
      enabled: true,
      candidate: true,
      credential: { refresh: 'r-old' },
    })
    expect((await s.state()).accounts[id].refresh).toBe('r-old')
    await s.open().remove(id)
  }
})

it('a crashed identity-validated replacement resolves refresh quarantine without enabling the row', async () => {
  await s
    .open()
    .add({ id: 'a', credential: oauth('r-old'), identity: 'acct-A' })
  await s.open().refresh('a', async () => ({
    access: 'x',
    refresh: 'r-B',
    expires: 4_000_000_000_000,
    identity: 'acct-B',
  }))
  const child = crashChild({
    op: 'replace',
    id: 'a',
    credential: oauth('r-validated-A'),
    renew: true,
    identity: 'acct-A',
    exitAt: 'after-state-write',
  })
  expect(await child.exited).toBe(CRASH_EXIT_CODE)
  const row = await rowOf('a')
  expect(row).toMatchObject({
    identity: 'acct-A',
    enabled: false,
    candidate: false,
    stamp: 'bound',
    credential: { refresh: 'r-validated-A' },
  })
  expect(row?.disabledReason).toBeUndefined()
  await s.open({ requireCredentialStamps: true }).enable('a')
  expect(await rowOf('a')).toMatchObject({
    enabled: true,
    candidate: true,
    stamp: 'bound',
  })
})
