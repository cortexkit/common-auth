import { beforeEach, describe, expect } from 'bun:test'
import { POOL_KEY, type WriteStep } from '../../src/store/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import {
  apiKey,
  CRASH_EXIT_CODE,
  oauth,
  rejectionOf,
  runChild,
  type Scenario,
  scenario,
} from './helpers.js'

const hooks = lifetimeHooks()
const { afterEach, it } = hooks

// `remove` with an attribution removes only the credential lineage it was
// decided for. A removal interrupted between its config and state writes
// leaves an orphan state entry under the id; a resumed removal must finish
// that one, and must refuse an orphan a later, interrupted add of the same
// id left there, with both files byte for byte unchanged.

let s: Scenario
beforeEach(async () => {
  s = hooks.lifetime.manage(await scenario('pool-remove-attribution-'))
})
afterEach(() => s.cleanup())

const B = { credentialEpoch: 1, identity: 'acct-b' }

async function populate() {
  const store = s.open()
  await store.add({ id: 'a', credential: oauth('r-a'), identity: 'acct-a' })
  await store.add({ id: 'b', credential: oauth('r-b'), identity: 'acct-b' })
  await store.add({ id: 'k', credential: apiKey('key-k') })
}

/** Runs one store operation in another process and expects it to crash at `exitAt`. */
async function crashIn(task: Record<string, unknown>, exitAt: WriteStep) {
  const child = runChild({ ...s.paths, ...task, exitAt })
  expect(await child.exited).toBe(CRASH_EXIT_CODE)
}

/** Removal of b interrupted after its config write: only b's state entry is left. */
async function interruptedRemoval() {
  await populate()
  await crashIn({ op: 'remove', id: 'b' }, 'after-config-write')
  expect((await s.state()).accounts.b).toBeDefined()
  expect((await s.config())[POOL_KEY].rows.b).toBeUndefined()
}

describe('remove attribution', () => {
  it('an attributed remove completes its own interrupted removal', async () => {
    await interruptedRemoval()
    expect(await s.open().remove('b', { attribution: B })).toEqual({
      id: 'b',
      outcome: 'completed',
    })
    expect((await s.state()).accounts.b).toBeUndefined()
  })

  it('an attributed remove refuses a foreign higher-epoch orphan with both files unchanged', async () => {
    await populate()
    await s.open().remove('b')
    // Another process adds b again, for the same account, and stops after its
    // state write: the orphan carries an epoch above the removed row's.
    await crashIn(
      { op: 'add', id: 'b', credential: oauth('r-b2'), identity: 'acct-b' },
      'after-state-write',
    )
    expect((await s.state()).accounts.b).toBeDefined()
    const before = await s.bytes()
    const refused = await rejectionOf(s.open().remove('b', { attribution: B }))
    expect(refused).toMatchObject({
      operation: 'remove',
      kind: 'attribution',
      phase: 'before-first-write',
    })
    expect(await s.bytes(), 'a foreign orphan is left byte for byte').toEqual(
      before,
    )
  })

  it('an attributed remove refuses a live row of another epoch or identity with both files unchanged', async () => {
    await populate()
    const before = await s.bytes()
    for (const attribution of [
      { credentialEpoch: 2, identity: 'acct-b' },
      { credentialEpoch: 1, identity: 'acct-x' },
      { credentialEpoch: 1 },
    ]) {
      const refused = await rejectionOf(s.open().remove('b', { attribution }))
      expect(refused).toMatchObject({
        operation: 'remove',
        kind: 'attribution',
      })
    }
    expect(await s.bytes(), 'a mismatched live row is left unchanged').toEqual(
      before,
    )
    expect(await s.open().remove('b', { attribution: B })).toEqual({
      id: 'b',
      outcome: 'removed',
    })
  })

  it('an attributed remove refuses an orphan without a bindable stamp with both files unchanged', async () => {
    await interruptedRemoval()
    const state = await s.state()
    const stamp = state.accounts.b[POOL_KEY]
    // Unstamped, malformed, and stamped for another credential.
    const variants: Array<
      [string, (account: Record<string, unknown>) => void]
    > = [
      ['unstamped', (account) => delete account[POOL_KEY]],
      [
        'malformed',
        (account) => (account[POOL_KEY] = { credentialEpoch: 'x' }),
      ],
      ['foreign secret', (account) => (account.refresh = 'r-other')],
    ]
    for (const [name, damage] of variants) {
      const damaged = structuredClone(state)
      damaged.accounts.b[POOL_KEY] = structuredClone(stamp)
      damage(damaged.accounts.b)
      await s.writeState(damaged)
      const before = await s.bytes()
      const refused = await rejectionOf(
        s.open().remove('b', { attribution: B }),
      )
      expect(refused, name).toMatchObject({
        operation: 'remove',
        kind: 'unbound-credential',
      })
      expect(await s.bytes(), `${name}: files unchanged`).toEqual(before)
    }
  })

  it('an attributed remove refuses a malformed attribution before reading the pool', async () => {
    await populate()
    const before = await s.bytes()
    for (const attribution of [
      { credentialEpoch: 0 },
      { credentialEpoch: 1.5 },
      {} as { credentialEpoch: number },
    ]) {
      expect(
        await rejectionOf(s.open().remove('b', { attribution })),
      ).toMatchObject({ kind: 'invalid-input' })
    }
    expect(await s.bytes()).toEqual(before)
  })

  it('an attributed remove completes no other row before refusing', async () => {
    await populate()
    // A replace of a, interrupted between its writes, leaves a torn row the
    // next ordinary write completes. A refused attributed remove must not.
    await crashIn(
      { op: 'replace', id: 'a', credential: oauth('r-a2'), identity: 'acct-a' },
      'after-state-write',
    )
    const before = await s.bytes()
    const refused = await rejectionOf(
      s.open().remove('b', {
        attribution: { credentialEpoch: 9, identity: 'acct-b' },
      }),
    )
    expect(refused).toMatchObject({ kind: 'attribution' })
    expect(await s.bytes(), 'the torn row is not completed').toEqual(before)
  })

  it('remove without attribution still drops whatever orphan the id holds', async () => {
    await populate()
    await s.open().remove('b')
    await crashIn(
      { op: 'add', id: 'b', credential: oauth('r-b2'), identity: 'acct-b' },
      'after-state-write',
    )
    expect(await s.open().remove('b')).toEqual({
      id: 'b',
      outcome: 'completed',
    })
    expect((await s.state()).accounts.b).toBeUndefined()
  })
})
