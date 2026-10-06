import { beforeEach, describe, expect } from 'bun:test'
import type { PoolRow } from '../../src/store/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import {
  apiKey,
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

const OLD_URL = 'https://old.invalid'
const NEW_URL = 'https://new.invalid'

async function rowOf(id: string): Promise<PoolRow | undefined> {
  const load = await s.open().read()
  if (load.status !== 'ready') throw new Error(`pool is ${load.status}`)
  return load.rows.find((row) => row.id === id)
}

describe('rotation refreshes the secret of one endpoint; another endpoint is a replacement', () => {
  it('an api-key rotation naming another baseURL is refused before writing and the row keeps its key at its endpoint', async () => {
    const store = s.open()
    await store.add({
      id: 'row',
      credential: apiKey('key-a', { baseURL: OLD_URL }),
    })
    const before = await s.bytes()
    const error = await rejectionOf(
      store.rotate('row', apiKey('key-b', { baseURL: NEW_URL })),
    )
    expect(error).toMatchObject({
      operation: 'rotate',
      kind: 'endpoint-mismatch',
      phase: 'before-first-write',
      retryable: false,
    })
    expect(await s.bytes()).toEqual(before)
    const row = await rowOf('row')
    expect(row?.credential).toMatchObject({ apiKey: 'key-a', baseURL: OLD_URL })
    expect(row?.candidate).toBe(true)
  })

  it('an api-key rotation naming another authHeader is refused before writing', async () => {
    const store = s.open()
    await store.add({
      id: 'row',
      credential: apiKey('key-a', { baseURL: OLD_URL }),
    })
    const before = await s.bytes()
    const error = await rejectionOf(
      store.rotate(
        'row',
        apiKey('key-b', { baseURL: OLD_URL, authHeader: 'x-api-key' }),
      ),
    )
    expect(error).toMatchObject({ kind: 'endpoint-mismatch' })
    expect(await s.bytes()).toEqual(before)
  })

  it('an api-key rotation that leaves out baseURL and authHeader keeps the row endpoint', async () => {
    const store = s.open()
    await store.add({
      id: 'row',
      credential: apiKey('key-a', {
        baseURL: OLD_URL,
        authHeader: 'x-api-key',
      }),
    })
    const rotated = await store.rotate('row', { type: 'api', apiKey: 'key-b' })
    expect(rotated.credential).toEqual({
      type: 'api',
      apiKey: 'key-b',
      baseURL: OLD_URL,
      authHeader: 'x-api-key',
    })
    const row = await rowOf('row')
    expect(row?.credential).toEqual(rotated.credential)
    expect(row?.credentialEpoch).toBe(1)
  })

  it('an api-key rotation naming the row endpoint refreshes the key', async () => {
    const store = s.open()
    await store.add({
      id: 'row',
      credential: apiKey('key-a', { baseURL: OLD_URL }),
    })
    await store.rotate(
      'row',
      apiKey('key-b', {
        baseURL: ` ${OLD_URL} `,
        authHeader: 'authorization-bearer',
      }),
    )
    expect((await rowOf('row'))?.credential).toMatchObject({
      apiKey: 'key-b',
      baseURL: OLD_URL,
      authHeader: 'authorization-bearer',
    })
  })

  it('an api-key rotation naming an invalid baseURL is refused as invalid input', async () => {
    const store = s.open()
    await store.add({
      id: 'row',
      credential: apiKey('key-a', { baseURL: OLD_URL }),
    })
    const error = await rejectionOf(
      store.rotate('row', apiKey('key-b', { baseURL: 'not a url' })),
    )
    expect(error).toMatchObject({ kind: 'invalid-input' })
  })
})

describe('a re-add is a rotation of the row holding the secret', () => {
  it('a re-add of a held api key at another endpoint is refused and adds no row', async () => {
    const store = s.open()
    await store.add({
      id: 'row',
      credential: apiKey('key-a', { baseURL: OLD_URL }),
    })
    const before = await s.bytes()
    const error = await rejectionOf(
      store.add({
        id: 'other',
        credential: apiKey('key-a', { baseURL: NEW_URL }),
      }),
    )
    expect(error).toMatchObject({
      operation: 'add',
      kind: 'endpoint-mismatch',
      phase: 'before-first-write',
    })
    expect(await s.bytes()).toEqual(before)
  })

  it('a re-add of a held api key leaving out authHeader keeps the row header', async () => {
    const store = s.open()
    await store.add({
      id: 'row',
      credential: apiKey('key-a', {
        baseURL: OLD_URL,
        authHeader: 'x-api-key',
      }),
    })
    const result = await store.add({
      id: 'other',
      credential: apiKey('key-a', { baseURL: OLD_URL }),
    })
    expect(result).toMatchObject({ id: 'row', outcome: 'rotated' })
    expect(result.credential).toMatchObject({ authHeader: 'x-api-key' })
  })

  it('a re-add of a held oauth credential naming another known account is refused', async () => {
    const store = s.open()
    await store.add({ id: 'row', credential: oauth('r-a'), identity: 'acct-a' })
    const before = await s.bytes()
    const error = await rejectionOf(
      store.add({ id: 'other', credential: oauth('r-a'), identity: 'acct-b' }),
    )
    expect(error).toMatchObject({
      operation: 'add',
      kind: 'identity-mismatch',
      phase: 'before-first-write',
    })
    expect(await s.bytes()).toEqual(before)
  })

  it('add completing a credential-less row refuses another endpoint or another known account', async () => {
    await s.writeConfig({
      version: 1,
      accounts: [
        { id: 'k', type: 'api', addedAt: 1, baseURL: OLD_URL },
        { id: 'o', type: 'oauth', addedAt: 1, accountId: 'acct-a' },
      ],
      commonAuthPool: { schemaVersion: 1, rows: {} },
    })
    const store = s.open()
    const before = await s.bytes()
    expect(
      await rejectionOf(
        store.add({
          id: 'k',
          credential: apiKey('key-k', { baseURL: NEW_URL }),
        }),
      ),
    ).toMatchObject({ kind: 'endpoint-mismatch' })
    expect(
      await rejectionOf(
        store.add({ id: 'o', credential: oauth('r-o'), identity: 'acct-b' }),
      ),
    ).toMatchObject({ kind: 'identity-mismatch' })
    expect(await s.bytes()).toEqual(before)
    const completed = await store.add({
      id: 'k',
      credential: apiKey('key-k', { baseURL: OLD_URL }),
    })
    expect(completed.outcome).toBe('completed')
  })
})
