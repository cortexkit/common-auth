import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  REFRESH_STAMP_TOLERANCE_MS,
  type StoredCredential,
} from '../../src/store/index.js'
import { saveAccountState } from '../fixtures/legacy-openai-auth/accounts.js'
import { oauth, rejectionOf, type Scenario, scenario } from './helpers.js'

let s: Scenario
// The injected clock is pinned at the real clock when each test starts and
// only advanced while no vendored writer runs, so the vendored comparator's
// own Date.now() stays within a few milliseconds of it.
let T0: number
let clock: number
beforeEach(async () => {
  s = await scenario()
  T0 = Date.now()
  clock = T0
})
afterEach(() => s.cleanup())

const EXPIRES = 4_000_000_000_000

/** Seeds row `a` holding r0 with the given prior stamp and expiry. */
async function seed(prior: number, expires = EXPIRES) {
  const store = s.open({ now: () => clock })
  await store.add({ id: 'a', credential: oauth('r0') })
  const state = await s.state()
  state.accounts.a = {
    access: 'access-r0',
    refresh: 'r0',
    expires,
    lastRefreshedAt: prior,
  }
  await s.writeState(state)
  return store
}

/** The pre-rotation snapshot an older process still holds in memory. */
function staleSnapshot(prior: number, expires = EXPIRES) {
  return {
    version: 1 as const,
    accounts: [
      {
        id: 'a',
        type: 'oauth' as const,
        access: 'access-r0',
        refresh: 'r0',
        expires,
        lastRefreshedAt: prior,
      },
    ],
  }
}

async function stored(): Promise<StoredCredential | undefined> {
  const load = await s.open().read()
  if (load.status !== 'ready') throw new Error('expected ready')
  return load.rows[0]?.credential
}

describe('refresh stamps against the legacy comparator', () => {
  for (const [label, offset] of [
    ['equal to the frozen clock', 0],
    ['slightly ahead of the clock', 1_000],
  ] as const) {
    it(`a stale snapshot submitted after a rotation loses when the prior stamp is ${label} and expiry is equal`, async () => {
      const prior = T0 + offset
      const store = await seed(prior)
      await store.refresh('a', async () => ({
        access: 'access-r1',
        refresh: 'r1',
        expires: EXPIRES,
      }))
      await saveAccountState(staleSnapshot(prior), s.paths, { accounts: ['a'] })
      expect((await s.state()).accounts.a.refresh).toBe('r1')
    })
  }

  it('an untrusted prior stamp is ignored, so the rotation is stamped within the trust bound and wins', async () => {
    const prior = T0 + 10 * 60_000
    const store = await seed(prior)
    await store.refresh('a', async () => ({
      access: 'access-r1',
      refresh: 'r1',
      expires: EXPIRES,
    }))
    const stamp = (await s.state()).accounts.a.lastRefreshedAt
    expect(stamp).toBeGreaterThanOrEqual(T0)
    expect(stamp).toBeLessThanOrEqual(T0 + REFRESH_STAMP_TOLERANCE_MS)
    await saveAccountState(staleSnapshot(prior), s.paths, { accounts: ['a'] })
    expect((await s.state()).accounts.a.refresh).toBe('r1')
  })

  it('a trusted prior stamp at exactly the trust bound refuses the refresh retryably with no provider call and nothing written', async () => {
    const prior = T0 + REFRESH_STAMP_TOLERANCE_MS
    const store = await seed(prior)
    const before = await s.bytes()
    let calls = 0
    const error = await rejectionOf(
      store.refresh('a', async () => {
        calls++
        return { access: 'access-r1', refresh: 'r1', expires: EXPIRES }
      }),
    )
    expect(error).toMatchObject({
      kind: 'refresh-stamp-ahead',
      retryable: true,
      phase: 'before-first-write',
    })
    expect(calls).toBe(0)
    expect(await s.bytes()).toEqual(before)
    await saveAccountState(staleSnapshot(prior), s.paths, { accounts: ['a'] })
    expect((await s.state()).accounts.a).toMatchObject({
      refresh: 'r0',
      lastRefreshedAt: prior,
    })
  })

  it('the stamp refusal clears once the injected clock passes the prior stamp', async () => {
    const prior = T0 + REFRESH_STAMP_TOLERANCE_MS
    const store = await seed(prior)
    clock = prior + 1
    const outcome = await store.refresh('a', async () => ({
      access: 'access-r1',
      refresh: 'r1',
      expires: EXPIRES,
    }))
    expect(outcome.status).toBe('rotated')
    expect(await stored()).toMatchObject({
      refresh: 'r1',
      lastRefreshedAt: prior + 1,
    })
  })

  it('a longer and an equal-or-shorter provider expiry get the same pre-call verdict and are persisted verbatim', async () => {
    for (const [prior, verdict] of [
      [0, 'rotated'],
      [REFRESH_STAMP_TOLERANCE_MS, 'refresh-stamp-ahead'],
    ] as const) {
      const outcomes: string[] = []
      for (const expires of [EXPIRES + 1_000, EXPIRES - 1_000]) {
        s.cleanup()
        s = await scenario()
        const store = await seed(T0 + prior)
        const outcome = await store
          .refresh('a', async () => ({
            access: 'access-r1',
            refresh: 'r1',
            expires,
          }))
          .then(
            (value) => value.status,
            (error) => error.kind,
          )
        outcomes.push(outcome)
        if (outcome === 'rotated')
          expect((await s.state()).accounts.a.expires).toBe(expires)
      }
      expect(outcomes).toEqual([verdict, verdict])
    }
  })
})
