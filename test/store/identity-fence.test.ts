import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { PoolRow } from '../../src/store/index.js'
import { oauth, rejectionOf, type Scenario, scenario } from './helpers.js'

let s: Scenario
beforeEach(async () => {
  s = await scenario()
})
afterEach(() => s.cleanup())

async function rowOf(id: string): Promise<PoolRow | undefined> {
  const load = await s.open().read()
  if (load.status !== 'ready') throw new Error(`pool is ${load.status}`)
  return load.rows.find((row) => row.id === id)
}

/** A row at epoch 1 with a recorded reading and, when given, an identity. */
async function rowWithReading(identity?: string) {
  const store = s.open()
  await store.add({
    id: 'a',
    credential: oauth('r-1'),
    ...(identity !== undefined ? { identity } : {}),
  })
  await store.recordQuota(
    'a',
    {
      credentialEpoch: 1,
      ...(identity !== undefined ? { identity } : {}),
    },
    'used-90',
  )
  return store
}

describe('rotation keeps an account; another account is a replacement', () => {
  it('a rotation of the same known account keeps the epoch, identity and quota', async () => {
    const store = await rowWithReading('acct-a')
    await store.rotate('a', oauth('r-2'), { identity: 'acct-a' })
    const row = await rowOf('a')
    expect(row).toMatchObject({
      identity: 'acct-a',
      credentialEpoch: 1,
      quota: { readings: ['used-90'] },
    })
    expect(row?.credential).toMatchObject({ refresh: 'r-2' })
  })

  it('a rotation that learns the first identity records it at the same epoch', async () => {
    const store = await rowWithReading()
    await store.rotate('a', oauth('r-2'), { identity: 'acct-a' })
    const row = await rowOf('a')
    expect(row).toMatchObject({ identity: 'acct-a', credentialEpoch: 1 })
    expect(row?.credential).toMatchObject({ refresh: 'r-2' })
  })

  it('a rotation carrying another known account is refused and the row is unchanged', async () => {
    const store = await rowWithReading('acct-a')
    const before = await s.bytes()
    const error = await rejectionOf(
      store.rotate('a', oauth('r-b'), { identity: 'acct-b' }),
    )
    expect(error).toMatchObject({
      kind: 'identity-mismatch',
      phase: 'before-first-write',
    })
    expect(await s.bytes()).toEqual(before)
  })
})

describe('identity learning is fenced on the credential epoch the lookup captured', () => {
  it('recordIdentity of a first identity applies at the credential epoch the lookup captured', async () => {
    const store = await rowWithReading()
    await store.recordIdentity('a', 'acct-a', { credentialEpoch: 1 })
    expect(await rowOf('a')).toMatchObject({
      identity: 'acct-a',
      credentialEpoch: 1,
      quota: { readings: ['used-90'] },
    })
  })

  it('a first-identity lookup that completes after a replacement is refused', async () => {
    const store = await rowWithReading()
    // The lookup is issued for the credential at epoch 1 ...
    const captured = (await rowOf('a'))?.credentialEpoch as number
    // ... the row is replaced by another account's credential ...
    await store.replace('a', oauth('r-b'))
    const before = await s.bytes()
    // ... and the lookup then reports the first credential's account.
    const error = await rejectionOf(
      store.recordIdentity('a', 'acct-a', { credentialEpoch: captured }),
    )
    expect(error).toMatchObject({
      kind: 'attribution',
      phase: 'before-first-write',
    })
    expect(await s.bytes()).toEqual(before)
    expect((await rowOf('a'))?.identity).toBeUndefined()
  })

  it('recordIdentity of another known account is refused', async () => {
    const store = await rowWithReading('acct-a')
    const before = await s.bytes()
    const error = await rejectionOf(
      store.recordIdentity('a', 'acct-b', { credentialEpoch: 1 }),
    )
    expect(error.kind).toBe('identity-mismatch')
    expect(await s.bytes()).toEqual(before)
  })

  it('recordIdentity without a captured credential epoch is refused before writing', async () => {
    const store = await rowWithReading()
    const before = await s.bytes()
    const error = await rejectionOf(
      store.recordIdentity(
        'a',
        'acct-a',
        {} as unknown as { credentialEpoch: number },
      ),
    )
    expect(error.kind).toBe('invalid-input')
    expect(await s.bytes()).toEqual(before)
  })
})
