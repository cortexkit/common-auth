import { beforeEach, describe, expect } from 'bun:test'
import {
  POOL_KEY,
  type PoolOperationError,
  type PullRequest,
} from '../../src/store/index.js'
import { mutateAccounts } from '../fixtures/legacy-openai-auth/accounts.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { observed } from '../fixtures/observed.js'
import { apiKey, deferred, oauth, type Scenario, scenario } from './helpers.js'

const hooks = lifetimeHooks()
const { afterEach, it } = hooks

let s: Scenario
beforeEach(async () => {
  s = hooks.lifetime.manage(await scenario())
})
afterEach(() => s.cleanup())

async function seed(rows: Array<[string, string]>) {
  const store = s.open()
  for (const [id, refresh] of rows)
    await store.add({ id, credential: oauth(refresh) })
}

describe('pulls never block the caller', () => {
  it('load and a reading request return while pulls that never resolve are pending', async () => {
    await seed([
      ['a', 'r-a'],
      ['b', 'r-b'],
    ])
    const requested: string[] = []
    const allRequested = deferred()
    const stop = deferred()
    hooks.lifetime.unpark(() => stop.resolve())
    const store = s.open({
      pull: async (request) => {
        requested.push(request.id)
        if (requested.length === 3) allRequested.resolve()
        // These pulls stay pending for every assertion. Only teardown rejects
        // them, without returning an observation that could write after cleanup.
        await stop.promise
        throw new Error('test pull stopped during teardown')
      },
    })
    const load = store.load()
    expect((await observed(hooks.lifetime, load)).status).toBe('ready')
    store.requestReading('a')
    await observed(hooks.lifetime, allRequested.promise)
    expect(requested.sort()).toEqual(['a', 'a', 'b'])
  })

  it('a rejecting pull reaches the store failure hook with phase pull and leaves needs-first-reading set', async () => {
    await seed([['a', 'r-a']])
    const failures: PoolOperationError[] = []
    let calls = 0
    const store = s.open({
      pull: async () => {
        calls++
        throw new Error('quota endpoint down')
      },
      onPullFailure: (_id, error) => void failures.push(error),
    })
    await store.load()
    await store.pullsSettled()
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({
      operation: 'pull',
      rowId: 'a',
      phase: 'pull',
      kind: 'pull',
      committed: undefined,
    })
    const load = await store.read()
    if (load.status !== 'ready') throw new Error('expected ready')
    expect(load.rows[0]?.needsFirstReading).toBe(true)
    // The failure released the once-per-process guard, so a later load fires again.
    await store.load()
    await store.pullsSettled()
    expect(calls).toBe(2)
  })

  it('the pull hook fires on add of an enabled OAuth row and on replace, never for api-key or disabled rows', async () => {
    const requests: PullRequest[] = []
    const store = s.open({
      pull: async (request) => {
        requests.push(request)
        return 'reading'
      },
    })
    await store.add({ id: 'a', credential: oauth('r-a') })
    await store.add({ id: 'k', credential: apiKey('key-k') })
    await store.add({ id: 'b', credential: oauth('r-b'), identity: 'acct' })
    await store.add({ id: 'dup', credential: oauth('r-dup'), identity: 'acct' })
    await store.pullsSettled()
    expect(requests.map((request) => [request.id, request.reason])).toEqual([
      ['a', 'add'],
      ['b', 'add'],
    ])
    await store.replace('a', oauth('r-a2'))
    await store.disable('b', 'manual')
    store.requestReading('b')
    store.requestReading('k')
    await store.pullsSettled()
    expect(requests.map((request) => [request.id, request.reason])).toEqual([
      ['a', 'add'],
      ['b', 'add'],
      ['a', 'replace'],
    ])
    expect(requests[2]?.credentialEpoch).toBe(2)
  })

  it('load fires a pull once per process per row and a refresh re-read never fires one', async () => {
    await seed([['a', 'r-a']])
    const release = deferred()
    hooks.lifetime.unpark(() => release.resolve())
    let calls = 0
    const store = s.open({
      pull: async () => {
        calls++
        await release.promise
        return 'reading'
      },
    })
    await store.load()
    await store.load()
    await s
      .open({
        pull: async () => {
          calls++
          return 'x'
        },
      })
      .load()
    await store.refresh('a', async () => ({
      access: 'x',
      refresh: 'r-a2',
      expires: 4_000_000_000_000,
    }))
    release.resolve()
    await store.pullsSettled()
    expect(calls).toBe(1)
  })
})

describe('roster rows without a per-row entry', () => {
  for (const variant of [
    'appended by the legacy writer',
    'whose entry was stripped',
  ]) {
    it(`a roster row ${variant} is a candidate and its first pull creates its entry at epoch 1 before issuing`, async () => {
      await seed([['a', 'r-a']])
      if (variant === 'appended by the legacy writer') {
        await mutateAccounts((current) => {
          current.accounts.push({ id: 'y', type: 'oauth', refresh: 'r-y' })
          return current
        }, s.paths)
      } else {
        await s.open().add({ id: 'y', credential: oauth('r-y') })
        const config = await s.config()
        delete config[POOL_KEY].rows.y
        await s.writeConfig(config)
      }
      const before = await s.bytes()
      const release = deferred()
      hooks.lifetime.unpark(() => release.resolve())
      const stop = deferred()
      hooks.lifetime.unpark(() => stop.resolve())
      const issued = deferred<{ request: PullRequest; entry: unknown }>()
      const store = s.open({
        pull: async (request) => {
          if (request.id !== 'y') {
            await stop.promise
            throw new Error('test pull stopped during teardown')
          }
          issued.resolve({
            request,
            entry: (await s.config())[POOL_KEY].rows.y,
          })
          await release.promise
          return 'first-reading'
        },
      })
      const load = await s.open().read()
      if (load.status !== 'ready') throw new Error('expected ready')
      expect(load.rows.find((row) => row.id === 'y')).toMatchObject({
        candidate: true,
        needsFirstReading: true,
        hasEntry: false,
      })
      expect(await s.bytes()).toEqual(before)

      const loaded = await store.load()
      if (loaded.status !== 'ready') throw new Error('expected ready')
      expect(loaded.rows.find((row) => row.id === 'y')?.hasEntry).toBe(false)
      const { request, entry } = await issued.promise
      expect(entry).toEqual({ credentialEpoch: 1, needsFirstReading: true })
      expect(request).toMatchObject({ id: 'y', credentialEpoch: 1 })
      release.resolve()
      // Wait until the reading is recorded rather than a fixed pause, which a
      // loaded host can outlast. If it is never recorded, the runner's test
      // timeout fails this test by name; teardown's cancellation ends the loop
      // so the body does not hold cleanup.
      let after = await s.open().read()
      while (
        !hooks.lifetime.signal.aborted &&
        after.status === 'ready' &&
        after.rows.find((row) => row.id === 'y')?.needsFirstReading !== false
      ) {
        await Bun.sleep(10)
        after = await s.open().read()
      }
      if (after.status !== 'ready') throw new Error('expected ready')
      expect(after.rows.find((row) => row.id === 'y')).toMatchObject({
        credentialEpoch: 1,
        needsFirstReading: false,
        quota: { readings: ['first-reading'] },
      })
    })
  }
})
