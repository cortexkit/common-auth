import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  type AcceptedActivity,
  type AccountKey,
  createSessionActivityStore,
  holdWaitMaxS,
} from '../../src/limits/index.js'
import { askRouting } from '../../src/routing-accessor/index.js'

const symbol = Symbol.for('cortexkit.routing')
const original = Object.getOwnPropertyDescriptor(globalThis, symbol)
const now = 1700000000000
const accountKey: AccountKey = {
  namespace: 'vault',
  accountId: 'account-a',
  incarnation: '1',
}
const input = {
  sessionId: 'session-a',
  accountKey,
  now,
  maxSameAccountWait: 15,
} as const

function install(value: unknown): void {
  Object.defineProperty(globalThis, symbol, { configurable: true, value })
}

function recorded(patch: Partial<AcceptedActivity> = {}) {
  const store = createSessionActivityStore()
  expect(
    store.recordAccepted({
      sessionId: input.sessionId,
      accountKey,
      currentAccountKey: accountKey,
      lastAcceptedAt: now,
      ttlMs: 3600000,
      ...patch,
    }),
  ).toBe(true)
  return store
}

beforeEach(() => {
  install(() => ({ accountFor: () => Promise.resolve(undefined) }))
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, symbol)
  if (original) Object.defineProperty(globalThis, symbol, original)
})

describe('holdWaitMaxS', () => {
  test('caps setting 15 by seven minutes of remaining cache: 420 seconds', () => {
    const activity = recorded({ ttlMs: 420000 }).get(input.sessionId)
    expect(holdWaitMaxS({ ...input, activity })).toBe(420)
  })

  test('floors seven minutes and 600 ms of remaining cache to 420 seconds', () => {
    const activity = recorded({
      lastAcceptedAt: now - 10000,
      ttlMs: 430600,
    }).get(input.sessionId)
    expect(holdWaitMaxS({ ...input, activity })).toBe(420)
  })

  test('max uses all fifty minutes of remaining cache: 3000 seconds', () => {
    const activity = recorded({ ttlMs: 3000000 }).get(input.sessionId)
    expect(
      holdWaitMaxS({ ...input, activity, maxSameAccountWait: 'max' }),
    ).toBe(3000)
  })

  test.each([
    { setting: 0, expected: 0 },
    { setting: 15, expected: 900 },
    { setting: 'max', expected: 3600 },
    { setting: undefined, expected: 900 },
    { setting: '15', expected: 900 },
    { setting: -1, expected: 900 },
  ])('applies the persisted setting: %p', ({ setting, expected }) => {
    const activity = recorded().get(input.sessionId)
    expect(
      holdWaitMaxS({ ...input, activity, maxSameAccountWait: setting }),
    ).toBe(expected)
  })

  test.each([
    { lastAcceptedAt: now - 60001, ttlMs: 60000 },
    { lastAcceptedAt: now - 60000, ttlMs: 60000 },
    { lastAcceptedAt: now, ttlMs: 0 },
    { lastAcceptedAt: now, ttlMs: 999 },
  ])('returns zero for an expired, zero or subsecond cache: %p', (patch) => {
    const activity = recorded(patch).get(input.sessionId)
    expect(holdWaitMaxS({ ...input, activity })).toBe(0)
  })

  test('returns zero without an activity record', () => {
    expect(holdWaitMaxS(input)).toBe(0)
  })

  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'returns zero for an invalid clock: %p',
    (invalidNow) => {
      const activity = recorded().get(input.sessionId)
      expect(holdWaitMaxS({ ...input, activity, now: invalidNow })).toBe(0)
    },
  )

  test.each([
    { ...accountKey, namespace: 'another-vault' },
    { ...accountKey, accountId: 'account-b' },
    { ...accountKey, incarnation: 'replacement' },
  ])('returns zero for a different current account key: %p', (current) => {
    const activity = recorded().get(input.sessionId)
    expect(holdWaitMaxS({ ...input, activity, accountKey: current })).toBe(0)
  })

  test.each(
    [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1].map((ttlMs) => ({
      ttlMs,
    })),
  )('uses the five-minute fallback for unknown TTL: %p', (patch) => {
    const activity = recorded({ ...patch, lastAcceptedAt: now - 60000 }).get(
      input.sessionId,
    )
    expect(holdWaitMaxS({ ...input, activity })).toBe(240)
  })

  test('returns zero after forgetting or evicting the session', () => {
    const forgotten = recorded()
    forgotten.forgetSession(input.sessionId)
    expect(
      holdWaitMaxS({ ...input, activity: forgotten.get(input.sessionId) }),
    ).toBe(0)
    const evicted = recorded()
    for (let i = 1; i <= 256; i++) {
      evicted.recordAccepted({
        sessionId: `session-${i}`,
        accountKey,
        currentAccountKey: accountKey,
        lastAcceptedAt: now + i,
        ttlMs: 3600000,
      })
    }
    expect(
      holdWaitMaxS({ ...input, activity: evicted.get(input.sessionId) }),
    ).toBe(0)
  })

  test('leaves the cap unset without a usable routing accessor', () => {
    const activity = recorded().get(input.sessionId)
    Reflect.deleteProperty(globalThis, symbol)
    expect(holdWaitMaxS({ ...input, activity })).toBeUndefined()
    expect(holdWaitMaxS(input)).toBeUndefined()
    for (const accessor of [null, {}, () => undefined, () => ({})]) {
      install(accessor)
      expect(holdWaitMaxS({ ...input, activity })).toBeUndefined()
    }
  })

  test('ignores throwing optional accessors and checks again after bridge installation', () => {
    const activity = recorded().get(input.sessionId)
    Object.defineProperty(globalThis, symbol, {
      configurable: true,
      get() {
        throw new Error('bridge unavailable')
      },
    })
    expect(holdWaitMaxS({ ...input, activity })).toBeUndefined()
    install(() => {
      throw new Error('session unavailable')
    })
    expect(holdWaitMaxS({ ...input, activity })).toBeUndefined()
    install(() => ({ accountFor: () => Promise.resolve(undefined) }))
    expect(holdWaitMaxS({ ...input, activity })).toBe(900)
  })

  test('passes the computed cap to routing without asking for a route during calculation', async () => {
    const candidate = { accountId: 'account-a', credentialId: 'credential-a' }
    const accountFor = mock(() =>
      Promise.resolve({ account_id: candidate.accountId }),
    )
    const accessor = mock(() => ({ accountFor }))
    install(accessor)
    const activity = recorded({ ttlMs: 420600 }).get(input.sessionId)
    const cap = holdWaitMaxS({ ...input, activity })
    expect(accessor).toHaveBeenCalledWith(input.sessionId)
    expect(accountFor).not.toHaveBeenCalled()
    expect(
      await askRouting({
        sessionId: input.sessionId,
        provider: 'anthropic',
        modelId: 'claude-sonnet',
        candidates: [candidate],
        holdWaitMaxS: cap,
      }),
    ).toEqual({ candidate })
    expect(accountFor).toHaveBeenCalledWith(
      {
        provider: 'anthropic',
        modelId: 'claude-sonnet',
        hold_wait_max_s: 420,
      },
      { deadlineMs: 1500 },
    )
  })
})
