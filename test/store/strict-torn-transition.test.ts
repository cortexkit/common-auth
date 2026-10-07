import { beforeEach, describe, expect } from 'bun:test'
import { POOL_KEY, type PoolStore } from '../../src/store/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import {
  CRASH_EXIT_CODE,
  oauth,
  type ParsedJson,
  rejectionOf,
  runChild,
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

const REASON =
  'identity-contradicted: {"expectedIdentity":"acct-A","returnedIdentity":"acct-B"}'

function strict() {
  return s.open({ requireCredentialStamps: true })
}

async function rowOf(store: PoolStore) {
  const load = await store.read()
  expect(load.status).toBe('ready')
  if (load.status !== 'ready') throw new Error(`pool is ${load.status}`)
  const row = load.rows.find((candidate) => candidate.id === 'a')
  expect(row).toBeDefined()
  return row
}

async function interruptedContradiction() {
  const store = strict()
  await store.add({ id: 'a', credential: oauth('r-old'), identity: 'acct-A' })
  await store.recordQuota(
    'a',
    { credentialEpoch: 1, identity: 'acct-A' },
    'seen',
  )
  const child = runChild({
    ...s.paths,
    op: 'refresh',
    id: 'a',
    credential: oauth('r-new'),
    identity: 'acct-B',
    requireCredentialStamps: true,
    exitAt: 'after-state-write',
  })
  expect(await child.exited, child.output()).toBe(CRASH_EXIT_CODE)
  expect(child.output()).toContain('step:after-state-write')
  const config = await s.config()
  expect(config.accounts[0].enabled).toBeUndefined()
  expect(config[POOL_KEY].rows.a.transitionMark).toBeUndefined()
  const account = (await s.state()).accounts.a
  expect(account.refresh).toBe('r-new')
  expect(account[POOL_KEY].transition).toMatchObject({
    enabled: false,
    reason: REASON,
  })
}

async function editAccount(edit: (account: ParsedJson) => void) {
  const state = await s.state()
  edit(state.accounts.a)
  await s.writeState(state)
}

describe('strict torn refresh transition', () => {
  it('unchanged dispatch completes a real-crash contradicted refresh transition', async () => {
    await interruptedContradiction()
    const store = strict()
    expect(await rowOf(store)).toMatchObject({
      torn: true,
      stamp: 'bound',
      identity: 'acct-A',
      enabled: false,
      candidate: false,
      disabledReason: REASON,
    })
    const before = await s.bytes()
    const transition = (await s.state()).accounts.a[POOL_KEY].transition
    await store.disable('a', 'manual')
    expect((await s.bytes()).state).toBe(before.state)
    expect(await rowOf(store)).toMatchObject({
      stamp: 'bound',
      identity: 'acct-A',
      enabled: false,
      candidate: false,
      disabledReason: REASON,
      credential: oauth('r-new'),
    })
    expect((await rowOf(store))?.torn).toBeUndefined()
    const config = await s.config()
    expect(config.accounts[0]).toMatchObject({
      enabled: false,
      accountId: 'acct-A',
    })
    expect(config[POOL_KEY].rows.a).toMatchObject({
      transitionMark: transition.mark,
      disabledReason: REASON,
      credentialEpoch: 1,
      quota: { readings: ['seen'] },
    })
  })

  for (const [field, value] of [
    ['access', 'foreign-access'],
    ['expires', 4_100_000_000_000],
  ] as const) {
    it(`${field}-only edit refuses a real-crash transition without repairing file bytes`, async () => {
      await interruptedContradiction()
      await editAccount((account) => {
        account[field] = value
      })
      const before = await s.bytes()
      const store = strict()
      const failure = await rejectionOf(store.rotate('a', oauth('r-next')))
      expect(failure).toMatchObject({
        operation: 'rotate',
        kind: 'unbound-credential',
        phase: 'before-first-write',
        retryable: false,
      })
      expect(
        await s.bytes(),
        'strict transition refusal preserves state and config bytes',
      ).toEqual(before)
      const row = await rowOf(store)
      expect(row).toMatchObject({
        stamp: 'mismatched',
        unbound: true,
        enabled: true,
        candidate: false,
        identity: 'acct-A',
      })
      expect(row?.torn).toBeUndefined()
      let calls = 0
      const refreshed = await rejectionOf(
        store.refresh('a', async () => {
          calls++
          return {
            access: 'unused',
            refresh: 'unused',
            expires: 4_000_000_000_000,
          }
        }),
      )
      expect(refreshed).toMatchObject({
        operation: 'refresh',
        kind: 'unbound-credential',
        phase: 'before-first-write',
      })
      expect(calls).toBe(0)
      expect(await s.bytes()).toEqual(before)
    })

    it(`non-strict recovery still completes a real-crash transition after an ${field}-only edit`, async () => {
      await interruptedContradiction()
      await editAccount((account) => {
        account[field] = value
      })
      const store = s.open()
      expect(await rowOf(store)).toMatchObject({
        torn: true,
        stamp: 'mismatched',
        enabled: false,
        disabledReason: REASON,
      })
      const before = await s.bytes()
      await store.disable('a', 'manual')
      expect((await s.bytes()).state).toBe(before.state)
      const row = await rowOf(store)
      expect(row).toMatchObject({
        stamp: 'mismatched',
        enabled: false,
        disabledReason: REASON,
        identity: 'acct-A',
      })
      expect(row?.torn).toBeUndefined()
      expect(row?.unbound).toBeUndefined()
      expect((await s.config())[POOL_KEY].rows.a.transitionMark).toBeDefined()
    })
  }

  it('missing dispatch refuses a real-crash transition without repairing file bytes', async () => {
    await interruptedContradiction()
    await editAccount((account) => {
      delete account[POOL_KEY].dispatch
    })
    const before = await s.bytes()
    const failure = await rejectionOf(strict().rotate('a', oauth('r-next')))
    expect(failure.kind).toBe('unbound-credential')
    expect(
      await s.bytes(),
      'strict transition refusal preserves state and config bytes',
    ).toEqual(before)
    expect(await rowOf(strict())).toMatchObject({
      stamp: 'legacy',
      unbound: true,
      enabled: true,
    })
    expect((await rowOf(strict()))?.torn).toBeUndefined()
  })
})
