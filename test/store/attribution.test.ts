import { beforeEach, describe, expect } from 'bun:test'
import type { PoolOperationError, PullRequest } from '../../src/store/index.js'
import { mutateAccounts } from '../fixtures/legacy-openai-auth/accounts.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { deferred, oauth, type Scenario, scenario } from './helpers.js'

const hooks = lifetimeHooks()
const { afterEach, it } = hooks

let s: Scenario
beforeEach(async () => {
  s = hooks.lifetime.manage(await scenario())
})
afterEach(() => s.cleanup())

/**
 * A pull hook whose first call pauses until released and whose later calls
 * remain pending throughout the body, so only the paused reading is recorded.
 * Teardown rejects later calls without returning an observation to persist.
 */
function pausedPull() {
  const entered = deferred<PullRequest>()
  const release = deferred()
  hooks.lifetime.unpark(() => release.resolve())
  const stop = deferred()
  hooks.lifetime.unpark(() => stop.resolve())
  let calls = 0
  return {
    entered,
    release,
    hook: async (request: PullRequest) => {
      calls++
      if (calls > 1) {
        await stop.promise
        throw new Error('test pull stopped during teardown')
      }
      entered.resolve(request)
      await release.promise
      return `reading-for-${request.credential.type === 'oauth' ? request.credential.refresh : ''}`
    },
  }
}

async function rowOf(id: string) {
  const load = await s.open().read()
  if (load.status !== 'ready') throw new Error(`pool is ${load.status}`)
  return load.rows.find((row) => row.id === id)
}

describe('attribution', () => {
  for (const identity of ['acct-I', undefined]) {
    const variant = identity ? 'known' : 'unknown'
    it(`a pull paused across a library replace is discarded when the identity is ${variant}`, async () => {
      const pull = pausedPull()
      const failed = deferred<PoolOperationError>()
      const store = s.open({
        pull: pull.hook,
        onPullFailure: (_id, error) => failed.resolve(error),
      })
      await store.add({
        id: 'r',
        credential: oauth('r-I'),
        ...(identity ? { identity } : {}),
      })
      const request = await pull.entered.promise
      expect(request).toMatchObject({ credentialEpoch: 1 })
      await store.replace(
        'r',
        oauth('r-J'),
        identity ? { identity: 'acct-J' } : {},
      )
      pull.release.resolve()
      const error = await failed.promise
      expect(error).toMatchObject({
        operation: 'pull',
        phase: 'pull',
        kind: 'attribution',
        retryable: true,
        committed: undefined,
      })
      const row = await rowOf('r')
      expect(row).toMatchObject({ credentialEpoch: 2, needsFirstReading: true })
      expect(row?.quota).toBeUndefined()
    })
  }

  it('a pull paused across a library rotation of the same account still applies', async () => {
    const pull = pausedPull()
    const store = s.open({ pull: pull.hook })
    await store.add({ id: 'r', credential: oauth('r-1'), identity: 'acct-I' })
    await pull.entered.promise
    await store.rotate('r', oauth('r-2'))
    pull.release.resolve()
    await store.pullsSettled()
    const row = await rowOf('r')
    expect(row).toMatchObject({
      credentialEpoch: 1,
      needsFirstReading: false,
      quota: { readings: ['reading-for-r-1'] },
    })
  })

  it('a foreign writer removing and re-adding the id before the pull completes lets the pull apply', async () => {
    const pull = pausedPull()
    const store = s.open({ pull: pull.hook })
    await store.add({ id: 'r', credential: oauth('r-1') })
    await pull.entered.promise
    await mutateAccounts((current) => {
      current.accounts = current.accounts.filter((row) => row.id !== 'r')
      return current
    }, s.paths)
    await mutateAccounts((current) => {
      current.accounts.push({ id: 'r', type: 'oauth', refresh: 'r-readded' })
      return current
    }, s.paths)
    pull.release.resolve()
    await store.pullsSettled()
    const row = await rowOf('r')
    expect(row?.credential).toMatchObject({ refresh: 'r-readded' })
    expect(row?.quota).toEqual({ readings: ['reading-for-r-1'] })
  })

  it('a foreign writer replacing the credential in place leaves epoch and identity unchanged so the pull applies', async () => {
    const pull = pausedPull()
    const store = s.open({ pull: pull.hook })
    await store.add({ id: 'r', credential: oauth('r-1') })
    await pull.entered.promise
    await mutateAccounts((current) => {
      const row = current.accounts.find((account) => account.id === 'r')
      if (row?.type === 'oauth' && !row.corrupt) row.refresh = 'r-foreign'
      return current
    }, s.paths)
    pull.release.resolve()
    await store.pullsSettled()
    const row = await rowOf('r')
    expect(row).toMatchObject({ credentialEpoch: 1 })
    expect(row?.credential).toMatchObject({ refresh: 'r-foreign' })
    expect(row?.quota).toEqual({ readings: ['reading-for-r-1'] })
  })

  it('a pull issued during a live replace captures the credential and its epoch in one locked read', async () => {
    await s.open().add({ id: 'r', credential: oauth('r-old') })
    const paused = deferred()
    hooks.lifetime.unpark(() => paused.resolve())
    const reached = deferred()
    const replacer = s.open({
      onStep: async (step) => {
        if (step === 'before-state-write') {
          reached.resolve()
          await paused.promise
        }
      },
    })
    const replace = replacer.replace('r', oauth('r-new'))
    await reached.promise
    const captured = deferred<PullRequest>()
    const puller = s.open({
      pull: async (request) => {
        captured.resolve(request)
        return 'reading'
      },
    })
    puller.requestReading('r')
    await new Promise((resolve) => setTimeout(resolve, 200))
    paused.resolve()
    await replace
    const request = await captured.promise
    expect(request.credentialEpoch).toBe(2)
    expect(request.credential).toMatchObject({ refresh: 'r-new' })
    await puller.pullsSettled()
    expect((await rowOf('r'))?.quota).toEqual({ readings: ['reading'] })
  })

  it('recordQuota refuses a stale epoch with a retryable attribution failure', async () => {
    const store = s.open()
    await store.add({ id: 'r', credential: oauth('r-1') })
    await store.replace('r', oauth('r-2'))
    const error = await store
      .recordQuota('r', { credentialEpoch: 1 }, 'stale')
      .catch((failure) => failure)
    expect(error).toMatchObject({
      kind: 'attribution',
      retryable: true,
      phase: 'pull',
    })
    await store.recordQuota('r', { credentialEpoch: 2 }, 'fresh')
    expect((await rowOf('r'))?.quota).toEqual({ readings: ['fresh'] })
  })
})
