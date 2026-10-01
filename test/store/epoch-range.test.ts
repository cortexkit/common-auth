import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { POOL_KEY, type PoolRow } from '../../src/store/index.js'
import { credentialDigest } from '../../src/store/schema.js'
import { oauth, rejectionOf, type Scenario, scenario } from './helpers.js'

let s: Scenario
beforeEach(async () => {
  s = await scenario()
})
afterEach(() => s.cleanup())

const UNSAFE_EPOCH = Number.MAX_SAFE_INTEGER + 1

async function rowOf(id: string): Promise<PoolRow | undefined> {
  const load = await s.open().read()
  if (load.status !== 'ready') throw new Error(`pool is ${load.status}`)
  return load.rows.find((row) => row.id === id)
}

/** Row `row` holding credential A for account A, its config epoch set as given. */
async function rowAtEpoch(epoch: number) {
  const store = s.open()
  await store.add({
    id: 'row',
    credential: oauth('refresh-A'),
    identity: 'account-A',
  })
  const config = await s.config()
  config[POOL_KEY].rows.row.credentialEpoch = epoch
  await s.writeConfig(config)
  return store
}

describe('credential epochs stay inside the safe integer range', () => {
  it('a config epoch above the safe integer range makes the row invalid, and a replace interrupted after its state write never makes it a candidate', async () => {
    await rowAtEpoch(UNSAFE_EPOCH)
    expect(await rowOf('row')).toMatchObject({
      invalid: 'entry',
      candidate: false,
    })
    let armed = true
    const store = s.open({
      onStep: (step) => {
        if (armed && step === 'after-state-write')
          throw new Error('synthetic interruption')
      },
    })
    const error = await rejectionOf(
      store.replace('row', oauth('refresh-B'), { identity: 'account-B' }),
    )
    armed = false
    expect(error).toMatchObject({
      kind: 'invalid-row',
      phase: 'before-first-write',
    })
    const row = await rowOf('row')
    expect(row).toMatchObject({ invalid: 'entry', candidate: false })
    expect(row?.torn).toBeUndefined()
    expect((await s.state()).accounts.row.refresh).toBe('refresh-A')
  })

  it('a replace at the largest safe epoch is refused before writing and the row is unchanged', async () => {
    const store = await rowAtEpoch(Number.MAX_SAFE_INTEGER)
    const before = await s.bytes()
    const error = await rejectionOf(
      store.replace('row', oauth('refresh-B'), { identity: 'account-B' }),
    )
    expect(error).toMatchObject({
      operation: 'replace',
      kind: 'invalid-row',
      phase: 'before-first-write',
      retryable: false,
    })
    expect(error.message).toContain(String(Number.MAX_SAFE_INTEGER))
    expect(await s.bytes()).toEqual(before)
    const row = await rowOf('row')
    expect(row).toMatchObject({
      identity: 'account-A',
      credentialEpoch: Number.MAX_SAFE_INTEGER,
      candidate: true,
    })
    expect(row?.credential).toMatchObject({ refresh: 'refresh-A' })
  })

  it('a credential stamp naming an epoch above the safe integer range is ignored, so no reader completes the row to it', async () => {
    await rowAtEpoch(1)
    const state = await s.state()
    const credentialB = oauth('refresh-B')
    state.accounts.row = {
      ...state.accounts.row,
      refresh: credentialB.refresh,
      access: credentialB.access,
      [POOL_KEY]: {
        credentialEpoch: UNSAFE_EPOCH,
        digest: credentialDigest(credentialB),
        binding: { identity: 'account-B' },
      },
    }
    await s.writeState(state)
    const row = await rowOf('row')
    expect(row?.torn).toBeUndefined()
    expect(row?.credentialEpoch).toBe(1)
    expect(row?.identity).toBe('account-A')
  })

  it('identity and quota records refuse a captured epoch above the safe integer range as invalid input before writing', async () => {
    const store = s.open()
    await store.add({ id: 'row', credential: oauth('refresh-A') })
    const before = await s.bytes()
    expect(
      await rejectionOf(
        store.recordIdentity('row', 'account-A', {
          credentialEpoch: UNSAFE_EPOCH,
        }),
      ),
    ).toMatchObject({ kind: 'invalid-input', phase: 'before-first-write' })
    expect(
      await rejectionOf(
        store.recordQuota('row', { credentialEpoch: UNSAFE_EPOCH }, 'used-10'),
      ),
    ).toMatchObject({ kind: 'invalid-input', phase: 'pull' })
    expect(await s.bytes()).toEqual(before)
  })
})
