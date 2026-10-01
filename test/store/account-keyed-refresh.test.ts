import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { acquireRefreshFileLock } from '../../src/fs/refresh-file-lock.js'
import type {
  LockEvent,
  PoolLockSpec,
  PoolRow,
  ProviderRefreshResult,
} from '../../src/store/index.js'
import {
  deferred,
  oauth,
  rejectionOf,
  type Scenario,
  scenario,
  settlesWithin,
} from './helpers.js'

// A plugin may pass its own `providerLock` to one `refresh` call, keyed by
// the account being refreshed, so that refreshes of different accounts run
// side by side. Every operation that changes which identity a row lock is
// named by (`add`, `replace`, `recordIdentity`, `rotate` with an identity)
// keeps the store-wide provider lock. These tests pin what still holds when
// the two lock families no longer exclude each other.

let s: Scenario
// Releases every parked refresh, so a failed assertion cannot leave a lock
// renewing into the next test's run.
let unpark: Array<() => void> = []
beforeEach(async () => {
  s = await scenario()
})
afterEach(async () => {
  for (const release of unpark) release()
  unpark = []
  await new Promise((resolve) => setTimeout(resolve, 50))
  s.cleanup()
})

const A = 'acct-A'
const B = 'acct-B'

function result(refresh: string, extra: Partial<ProviderRefreshResult> = {}) {
  return {
    access: `access-${refresh}`,
    refresh,
    expires: 4_000_000_000_000,
    ...extra,
  }
}

/** The account-keyed lock a plugin would pass for one refresh call. */
function accountLock(key: string): PoolLockSpec {
  return { name: `acct-${key}`, path: s.statePath }
}

/** One lock log shared by every store in a test, each entry labelled by caller. */
function lockLog() {
  const log: string[] = []
  return {
    log,
    as: (who: string) => (event: LockEvent) => {
      if (event.name === 'save') return
      log.push(`${who} ${event.type} ${event.name}`)
    },
  }
}

/**
 * Parks the refresh of one row at the point just before its provider call,
 * with its row lock and its override lock held, until `go` resolves.
 */
function parkAt(rowId: string) {
  const parked = deferred()
  const go = deferred()
  unpark.push(() => go.resolve())
  return {
    parked,
    go,
    hold: async (point: string, id: string) => {
      if (point !== 'refresh-before-provider' || id !== rowId) return
      parked.resolve()
      await go.promise
    },
  }
}

/** A provider that records every refresh token it is handed. */
function countingProvider(value: ProviderRefreshResult) {
  const seen: string[] = []
  return {
    seen,
    fn: async (credential: { refresh: string }) => {
      seen.push(credential.refresh)
      return value
    },
  }
}

async function rowsOf(): Promise<PoolRow[]> {
  const load = await s.open().read()
  if (load.status !== 'ready') throw new Error(`pool is ${load.status}`)
  return load.rows
}

/** Per row: identity, enabled flag and disabled reason, in roster order. */
async function rosterView() {
  return (await rowsOf()).map((row) => ({
    id: row.id,
    identity: row.identity,
    enabled: row.enabled,
    disabledReason: row.disabledReason,
  }))
}

async function refreshTokenOf(id: string): Promise<string> {
  return (await s.state()).accounts[id].refresh
}

/** Enabled OAuth rows holding the identity: the dedupe leaves exactly one. */
async function enabledHolders(identity: string): Promise<string[]> {
  return (await rowsOf())
    .filter((row) => row.enabled && row.identity === identity)
    .map((row) => row.id)
}

describe('a row of unknown identity refreshing under an account-keyed provider lock', () => {
  it('a row learning the same identity by recordIdentity during the provider call does not wait, and the earlier roster row keeps the account', async () => {
    await s.open().add({ id: 'x', credential: oauth('r-x') })
    await s.open().add({ id: 'y', credential: oauth('r-y') })
    const locks = lockLog()
    const park = parkAt('x')
    const provider = countingProvider(result('r-x2', { identity: A }))
    const refreshX = s
      .open({ hold: park.hold, onLockEvent: locks.as('X') })
      .refresh('x', provider.fn, { providerLock: accountLock('x') })
    await park.parked.promise

    const recordY = s
      .open({ onLockEvent: locks.as('Y') })
      .recordIdentity('y', A, { credentialEpoch: 1 })
    expect(await settlesWithin(recordY, 3_000)).toBe(true)
    // X holds no identity yet, so nothing is disabled when Y learns A.
    expect(await recordY).toEqual({ id: 'y', disabled: [] })

    park.go.resolve()
    expect(await refreshX).toMatchObject({
      status: 'rotated',
      rowId: 'x',
      identity: A,
    })
    expect(provider.seen).toEqual(['r-x'])
    expect(locks.log).toEqual([
      'X acquired row-x',
      'X acquired acct-x',
      // Y's identity write lands inside X's provider window: it holds the
      // store-wide provider lock, which X's override no longer takes.
      'Y acquired row-y',
      'Y acquired provider-openai',
      'Y released provider-openai',
      'Y released row-y',
      'X released acct-x',
      'X released row-x',
    ])
    // X's commit recorded A and applied the dedupe: X is first in the
    // roster, so Y is disabled, once.
    expect(await rosterView()).toEqual([
      { id: 'x', identity: A, enabled: true, disabledReason: undefined },
      {
        id: 'y',
        identity: A,
        enabled: false,
        disabledReason: 'duplicate-identity',
      },
    ])
    expect(await refreshTokenOf('x')).toBe('r-x2')
    expect(await refreshTokenOf('y')).toBe('r-y')
    expect(await enabledHolders(A)).toEqual(['x'])
  })

  it('when the in-flight row is later in the roster its own commit disables it, and the rotation the provider consumed stays stored on it', async () => {
    await s.open().add({ id: 'y', credential: oauth('r-y') })
    await s.open().add({ id: 'x', credential: oauth('r-x') })
    const park = parkAt('x')
    const provider = countingProvider(result('r-x2', { identity: A }))
    const refreshX = s
      .open({ hold: park.hold })
      .refresh('x', provider.fn, { providerLock: accountLock('x') })
    await park.parked.promise
    const recordY = s.open().recordIdentity('y', A, { credentialEpoch: 1 })
    expect(await settlesWithin(recordY, 3_000)).toBe(true)
    expect(await recordY).toEqual({ id: 'y', disabled: [] })

    park.go.resolve()
    expect(await refreshX).toMatchObject({
      status: 'rotated',
      rowId: 'x',
      identity: A,
    })
    expect(provider.seen).toEqual(['r-x'])
    // The provider has already consumed r-x, so its successor must be on
    // disk under x even though x is now the duplicate.
    expect(await refreshTokenOf('x')).toBe('r-x2')
    expect(await rosterView()).toEqual([
      { id: 'y', identity: A, enabled: true, disabledReason: undefined },
      {
        id: 'x',
        identity: A,
        enabled: false,
        disabledReason: 'duplicate-identity',
      },
    ])
    expect(await enabledHolders(A)).toEqual(['y'])
    // Nothing re-enables x: enabling it refuses and a refresh of it refuses
    // before any provider call.
    expect(await rejectionOf(s.open().enable('x'))).toMatchObject({
      kind: 'duplicate-identity',
    })
    expect(await rejectionOf(s.open().refresh('x', provider.fn))).toMatchObject(
      { kind: 'row-disabled' },
    )
    expect(provider.seen).toEqual(['r-x'])
    expect((await rosterView())[1]).toMatchObject({ id: 'x', enabled: false })
  })

  it('an add of a credential for the same identity during the provider call does not wait, and the dedupe at commit follows roster order either way', async () => {
    for (const order of ['x-first', 'y-first'] as const) {
      s.cleanup()
      s = await scenario()
      await s.open().add({ id: 'x', credential: oauth('r-x') })
      const park = parkAt('x')
      const provider = countingProvider(result('r-x2', { identity: A }))
      const refreshX = s
        .open({ hold: park.hold })
        .refresh('x', provider.fn, { providerLock: accountLock('x') })
      await park.parked.promise
      const addY = s
        .open()
        .add({ id: 'y', credential: oauth('r-y'), identity: A })
      expect(await settlesWithin(addY, 3_000)).toBe(true)
      // No enabled row holds A yet, so y is stored enabled.
      expect(await addY).toMatchObject({ id: 'y', outcome: 'added' })
      if (order === 'y-first') await s.open().reorder(['y', 'x'])

      park.go.resolve()
      expect(await refreshX).toMatchObject({ status: 'rotated', identity: A })
      expect(provider.seen).toEqual(['r-x'])
      expect(await refreshTokenOf('x')).toBe('r-x2')
      expect(await refreshTokenOf('y')).toBe('r-y')
      const keeper = order === 'x-first' ? 'x' : 'y'
      const duplicate = order === 'x-first' ? 'y' : 'x'
      expect(await enabledHolders(A)).toEqual([keeper])
      const view = await rosterView()
      expect(view.find((row) => row.id === duplicate)).toEqual({
        id: duplicate,
        identity: A,
        enabled: false,
        disabledReason: 'duplicate-identity',
      })
      expect(
        view.filter((row) => row.disabledReason === 'duplicate-identity'),
      ).toHaveLength(1)
    }
  })
})

describe('a row of known identity refreshing under an account-keyed provider lock', () => {
  it('an add for the same identity waits on the refreshing row lock and is stored disabled after the rotation commits', async () => {
    await s.open().add({ id: 'x', credential: oauth('r-x'), identity: A })
    const locks = lockLog()
    const park = parkAt('x')
    const provider = countingProvider(result('r-x2'))
    const refreshX = s
      .open({ hold: park.hold, onLockEvent: locks.as('X') })
      .refresh('x', provider.fn, { providerLock: accountLock(A) })
    await park.parked.promise
    const addY = s
      .open({ onLockEvent: locks.as('Y') })
      .add({ id: 'y', credential: oauth('r-y'), identity: A })
    expect(await settlesWithin(addY, 300)).toBe(false)
    park.go.resolve()
    expect(await refreshX).toMatchObject({ status: 'rotated', rowId: 'x' })
    expect(await addY).toMatchObject({ id: 'y', outcome: 'added-disabled' })
    expect(provider.seen).toEqual(['r-x'])
    expect(locks.log.slice(0, 2)).toEqual([
      'X acquired row-acct-A',
      'X acquired acct-acct-A',
    ])
    // The add takes the row lock of the identity it is given, so it starts
    // only once the refresh has released it.
    expect(locks.log.indexOf('Y acquired row-acct-A')).toBeGreaterThan(
      locks.log.indexOf('X released row-acct-A'),
    )
    expect(await refreshTokenOf('x')).toBe('r-x2')
    expect(await enabledHolders(A)).toEqual(['x'])
    expect(
      (await rosterView()).filter(
        (row) => row.disabledReason === 'duplicate-identity',
      ),
    ).toEqual([
      {
        id: 'y',
        identity: A,
        enabled: false,
        disabledReason: 'duplicate-identity',
      },
    ])
  })

  it('a later row learning the identity during the provider call is disabled at once and its refresh refuses', async () => {
    await s.open().add({ id: 'x', credential: oauth('r-x'), identity: A })
    await s.open().add({ id: 'y', credential: oauth('r-y') })
    const park = parkAt('x')
    const provider = countingProvider(result('r-x2'))
    const refreshX = s
      .open({ hold: park.hold })
      .refresh('x', provider.fn, { providerLock: accountLock(A) })
    await park.parked.promise
    // y is keyed by its local id until it learns A, so recording A does not
    // wait on x's row lock: the alias boundary between the two row locks.
    const recordY = s.open().recordIdentity('y', A, { credentialEpoch: 1 })
    expect(await settlesWithin(recordY, 3_000)).toBe(true)
    expect(await recordY).toEqual({ id: 'y', disabled: ['y'] })
    park.go.resolve()
    expect(await refreshX).toMatchObject({ status: 'rotated', rowId: 'x' })
    const providerY = countingProvider(result('r-y2'))
    expect(
      await rejectionOf(s.open().refresh('y', providerY.fn)),
    ).toMatchObject({ kind: 'row-disabled' })
    expect(provider.seen).toEqual(['r-x'])
    expect(providerY.seen).toEqual([])
    expect(await refreshTokenOf('x')).toBe('r-x2')
    expect(await refreshTokenOf('y')).toBe('r-y')
    expect(await enabledHolders(A)).toEqual(['x'])
  })

  it('an earlier row learning the identity disables the in-flight row, whose rotation still commits, and its own refresh re-keys and waits on the in-flight row lock', async () => {
    await s.open().add({ id: 'y', credential: oauth('r-y') })
    await s.open().add({ id: 'x', credential: oauth('r-x'), identity: A })
    const locks = lockLog()
    const park = parkAt('x')
    const providerX = countingProvider(result('r-x2'))
    const refreshX = s
      .open({ hold: park.hold, onLockEvent: locks.as('X') })
      .refresh('x', providerX.fn, { providerLock: accountLock(A) })
    await park.parked.promise

    // A gate held by the test parks y's identity write under y's local-id
    // row lock, so y's refresh reads y unkeyed and queues behind it.
    const gate: PoolLockSpec = { name: 'gate', path: s.statePath }
    const gateHolder = await acquireRefreshFileLock({ ...gate, ttlMs: 30_000 })
    const recordHoldsRow = deferred()
    const logR = locks.as('R')
    const recordY = s
      .open({
        onLockEvent: (event) => {
          logR(event)
          if (event.type === 'acquired' && event.name === 'provider-openai')
            recordHoldsRow.resolve()
        },
      })
      .recordIdentity('y', A, { credentialEpoch: 1 }, { extraLocks: [gate] })
    await recordHoldsRow.promise
    const providerY = countingProvider(result('r-y2'))
    const refreshY = s
      .open({ onLockEvent: locks.as('Y') })
      .refresh('y', providerY.fn, { providerLock: accountLock('y') })
    expect(await settlesWithin(refreshY, 300)).toBe(false)
    await gateHolder?.release()
    // Recording A on y, the earlier roster row, disables x while x's
    // provider call is still pending.
    expect(await recordY).toEqual({ id: 'y', disabled: ['x'] })
    // y's refresh now finds y keyed by A, releases, and waits on row-acct-A,
    // which x still holds.
    expect(await settlesWithin(refreshY, 300)).toBe(false)
    expect(providerY.seen).toEqual([])

    park.go.resolve()
    expect(await refreshX).toMatchObject({ status: 'rotated', rowId: 'x' })
    expect(await refreshY).toMatchObject({ status: 'rotated', rowId: 'y' })
    expect(providerX.seen).toEqual(['r-x'])
    expect(providerY.seen).toEqual(['r-y'])
    expect(locks.log.filter((line) => line.startsWith('Y '))).toEqual([
      'Y acquired row-y',
      'Y acquired acct-y',
      'Y released acct-y',
      'Y released row-y',
      'Y acquired row-acct-A',
      'Y acquired acct-y',
      'Y released acct-y',
      'Y released row-acct-A',
    ])
    expect(locks.log.indexOf('Y acquired row-acct-A')).toBeGreaterThan(
      locks.log.indexOf('X released row-acct-A'),
    )
    // Both rotations are on disk; x stays the disabled duplicate.
    expect(await refreshTokenOf('x')).toBe('r-x2')
    expect(await refreshTokenOf('y')).toBe('r-y2')
    expect(await rosterView()).toEqual([
      { id: 'y', identity: A, enabled: true, disabledReason: undefined },
      {
        id: 'x',
        identity: A,
        enabled: false,
        disabledReason: 'duplicate-identity',
      },
    ])
  })
})

describe('rows of different accounts under account-keyed provider locks', () => {
  async function overlapping(
    lockFor: (key: string) => PoolLockSpec | undefined,
  ) {
    await s.open().add({ id: 'x', credential: oauth('r-x'), identity: A })
    await s.open().add({ id: 'z', credential: oauth('r-z'), identity: B })
    const entered = { x: deferred(), z: deferred() }
    const release = deferred()
    unpark.push(() => release.resolve())
    const seen: string[] = []
    const provider =
      (id: 'x' | 'z') => async (credential: { refresh: string }) => {
        seen.push(credential.refresh)
        entered[id].resolve()
        await release.promise
        return result(`${credential.refresh}2`)
      }
    const options = (key: string) => {
      const lock = lockFor(key)
      return lock ? { providerLock: lock } : {}
    }
    const refreshX = s.open().refresh('x', provider('x'), options(A))
    const refreshZ = s.open().refresh('z', provider('z'), options(B))
    const both = Promise.all([entered.x.promise, entered.z.promise])
    const overlapped = await settlesWithin(both, 1_000)
    release.resolve()
    const outcomes = await Promise.all([refreshX, refreshZ])
    return { overlapped, outcomes, seen }
  }

  it('refreshes of two accounts under their own provider locks are in their provider calls at the same time', async () => {
    const { overlapped, outcomes, seen } = await overlapping(accountLock)
    expect(overlapped).toBe(true)
    expect(outcomes).toMatchObject([
      { status: 'rotated', rowId: 'x' },
      { status: 'rotated', rowId: 'z' },
    ])
    expect([...seen].sort()).toEqual(['r-x', 'r-z'])
    expect(await refreshTokenOf('x')).toBe('r-x2')
    expect(await refreshTokenOf('z')).toBe('r-z2')
  })

  it('refreshes of two accounts under the default provider lock never overlap', async () => {
    const { overlapped, seen } = await overlapping(() => undefined)
    expect(overlapped).toBe(false)
    expect([...seen].sort()).toEqual(['r-x', 'r-z'])
  })
})

describe('an override naming the row lock', () => {
  it('a provider lock override equal to the row lock name waits on the refresh own row lock until its timeout and calls no provider', async () => {
    await s.open().add({ id: 'x', credential: oauth('r-x'), identity: A })
    const before = (await s.state()).accounts.x
    const provider = countingProvider(result('r-x2'))
    const error = await rejectionOf(
      s.open().refresh('x', provider.fn, {
        providerLock: { name: 'row-acct-A', path: s.statePath, timeoutMs: 300 },
      }),
    )
    // Lock files are not re-entrant: the second acquisition of the same
    // (name, path) by one refresh is a wait on itself, bounded by the
    // override's timeout.
    expect(error).toMatchObject({ kind: 'lock-contention', retryable: true })
    expect(provider.seen).toEqual([])
    expect((await s.state()).accounts.x).toEqual(before)
    // Every lock was released: a refresh with a distinct override succeeds.
    expect(
      await s
        .open()
        .refresh('x', provider.fn, { providerLock: accountLock(A) }),
    ).toMatchObject({ status: 'rotated' })
    expect(provider.seen).toEqual(['r-x'])
  })
})
