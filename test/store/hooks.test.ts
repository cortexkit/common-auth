import { beforeEach, describe, expect } from 'bun:test'
import {
  PoolReentryError,
  type PoolStore,
  type ProviderRefreshResult,
} from '../../src/store/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { observed } from '../fixtures/observed.js'
import {
  apiKey,
  deferred,
  oauth,
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

const ok = (refresh: string): ProviderRefreshResult => ({
  access: `access-${refresh}`,
  refresh,
  expires: 4_000_000_000_000,
})

/** Each forbidden call from inside a hook, named for the assertion message. */
function forbiddenCalls(store: PoolStore) {
  return {
    'rotate other': () => store.rotate('b', oauth('r-b-x')),
    'rotate same': () => store.rotate('a', oauth('r-a-x')),
    'replace other': () => store.replace('b', oauth('r-b-y')),
    'replace same': () => store.replace('a', oauth('r-a-y')),
    'identity other': () =>
      store.recordIdentity('b', 'acct-b', { credentialEpoch: 1 }),
    'identity same': () =>
      store.recordIdentity('a', 'acct-a', { credentialEpoch: 1 }),
    'disable other': () => store.disable('b', 'manual'),
    'disable same': () => store.disable('a', 'manual'),
    'refresh other': () => store.refresh('b', async () => ok('r-b-z')),
    add: () => store.add({ id: 'c', credential: oauth('r-c') }),
  }
}

async function expectAllRejectImmediately(store: PoolStore) {
  const outcomes: Record<string, string> = {}
  for (const [name, call] of Object.entries(forbiddenCalls(store))) {
    const error = await observed(hooks.lifetime, rejectionOf(call()))
    outcomes[name] =
      error instanceof PoolReentryError
        ? 'rejected'
        : `unexpected ${String(error)}`
  }
  return outcomes
}

async function seedTwoRows() {
  const store = s.open()
  await store.add({ id: 'a', credential: oauth('r-a') })
  await store.add({ id: 'b', credential: oauth('r-b') })
}

describe('hooks never re-enter the library', () => {
  it('every row operation and refresh called from an after-persist hook rejects immediately and the refresh still completes', async () => {
    await seedTwoRows()
    const store = s.open()
    let outcomes: Record<string, string> = {}
    const outcome = await store.refresh('a', async () => ok('r-a2'), {
      onPersisted: async () => {
        outcomes = await expectAllRejectImmediately(store)
      },
    })
    expect(outcome).toMatchObject({ status: 'rotated' })
    expect(Object.values(outcomes)).toEqual(
      Object.keys(forbiddenCalls(store)).map(() => 'rejected'),
    )
    expect((await s.state()).accounts.a.refresh).toBe('r-a2')
  })

  it('every row operation and refresh called from a refresh failure hook rejects immediately', async () => {
    await seedTwoRows()
    const store = s.open()
    let outcomes: Record<string, string> = {}
    const error = await rejectionOf(
      store.refresh(
        'a',
        async () => {
          throw new Error('provider down')
        },
        {
          onFailure: async () => {
            outcomes = await expectAllRejectImmediately(store)
          },
        },
      ),
    )
    expect(error.kind).toBe('provider')
    expect(Object.values(outcomes)).toEqual(
      Object.keys(forbiddenCalls(store)).map(() => 'rejected'),
    )
  })

  it('an after-persist hook rotating a row whose refresh waits for the provider-wide lock rejects at once and both refreshes finish', async () => {
    await seedTwoRows()
    const store = s.open()
    const aEntered = deferred()
    const aRelease = deferred()
    hooks.lifetime.unpark(() => aRelease.resolve())
    const bWaiting = deferred()
    const bStore = s.open({
      onLockEvent: (event) => {
        if (event.type === 'acquired' && event.name === 'row-b')
          bWaiting.resolve()
      },
    })
    let hookError: unknown
    const refreshA = store.refresh(
      'a',
      async () => {
        aEntered.resolve()
        await aRelease.promise
        return ok('r-a2')
      },
      {
        onPersisted: async () => {
          hookError = await rejectionOf(store.rotate('b', oauth('r-b-x')))
        },
      },
    )
    await aEntered.promise
    const refreshB = bStore.refresh('b', async () => ok('r-b2'))
    await bWaiting.promise
    aRelease.resolve()
    const [a, b] = await Promise.all([refreshA, refreshB])
    expect(hookError).toBeInstanceOf(PoolReentryError)
    expect(a).toMatchObject({ status: 'rotated' })
    expect(b).toMatchObject({ status: 'rotated' })
  })

  it('reads and quota recording for any row complete normally from inside a hook', async () => {
    await seedTwoRows()
    const store = s.open()
    let seenRows = 0
    await store.refresh('a', async () => ok('r-a2'), {
      onPersisted: async () => {
        await store.recordQuota('a', { credentialEpoch: 1 }, 'a-reading')
        await store.recordQuota('b', { credentialEpoch: 1 }, 'b-reading')
        const load = await store.read()
        if (load.status === 'ready') seenRows = load.rows.length
      },
    })
    const load = await store.read()
    if (load.status !== 'ready') throw new Error('expected ready')
    expect(load.rows.map((row) => row.quota)).toEqual([
      { readings: ['a-reading'] },
      { readings: ['b-reading'] },
    ])
    expect(seenRows).toBe(2)
  })

  it('a failed replace failure hook calling a same-row rotate and an other-row operation rejects both before any wait', async () => {
    await seedTwoRows()
    const store = s.open()
    const errors: unknown[] = []
    const replaceError = await rejectionOf(
      store.replace(
        'a',
        apiKey('wrong-type'),
        {},
        {
          onFailure: async () => {
            errors.push(await rejectionOf(store.rotate('a', oauth('r-a-x'))))
            errors.push(await rejectionOf(store.disable('b', 'manual')))
          },
        },
      ),
    )
    expect(replaceError.kind).toBe('type-mismatch')
    expect(errors.map((error) => error instanceof PoolReentryError)).toEqual([
      true,
      true,
    ])
  })

  it('work a hook schedules on a timer or a detached promise is rejected while the caller continuation succeeds', async () => {
    await seedTwoRows()
    const store = s.open()
    const timerDone = deferred<unknown>()
    const detachedDone = deferred<unknown>()
    await store.refresh('a', async () => ok('r-a2'), {
      onPersisted: () => {
        setTimeout(() => {
          rejectionOf(store.rotate('b', oauth('r-b-timer'))).then(
            timerDone.resolve,
          )
        }, 5)
        void Promise.resolve().then(() =>
          rejectionOf(store.disable('b', 'detached')).then(
            detachedDone.resolve,
          ),
        )
      },
    })
    expect(await timerDone.promise).toBeInstanceOf(PoolReentryError)
    expect(await detachedDone.promise).toBeInstanceOf(PoolReentryError)
    const continued = store.rotate('b', oauth('r-b-continuation'))
    expect(
      (await observed(hooks.lifetime, continued)).credential,
    ).toMatchObject({
      refresh: 'r-b-continuation',
    })
  })
})
