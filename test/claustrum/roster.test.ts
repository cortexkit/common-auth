import { afterEach, expect, test } from 'bun:test'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  declineAccount,
  declineVaultRoute,
  isDeclined,
  projectVaultRoster,
  pruneDeclined,
  readVaultRoster,
  recordVaultQuota,
  refreshVaultRoster,
  type VaultCredential,
  type VaultInventory,
  vaultRoutingRows,
} from '../../src/claustrum/index.ts'
import { cleanupDirs, deferred, tempDir } from './helpers.ts'

afterEach(cleanupDirs)

const work: VaultCredential = {
  credentialId: 'oauth:test:work',
  credentialType: 'oauth',
  accountIdentity: 'provider-work',
  state: 'active',
}
const named: VaultCredential = {
  credentialId: 'oauth:test',
  credentialType: 'oauth',
  accountIdentity: 'provider-named',
  state: 'active',
}
const observation = {
  checkedAt: 100,
  readings: [
    { label: '5h', usedPercent: 10, resetsAt: '2026-10-01T12:00:00.000Z' },
  ],
}

function list(
  credentials: readonly VaultCredential[],
  view = 'v',
  skipped: VaultInventory['skipped'] = [],
): VaultInventory {
  return { view, credentials, skipped }
}
const inventory = (credentials: readonly VaultCredential[], view = 'v') => ({
  discover: async () => list(credentials, view),
})

async function fixture() {
  const dir = await tempDir('claustrum-roster-')
  return { path: join(dir, 'vault-roster.json') }
}

function routeOf(
  roster: Awaited<ReturnType<typeof readVaultRoster>>,
  credentialId: string,
) {
  const row = roster?.rows.find((entry) => entry.credentialId === credentialId)
  if (!row) throw new Error(`missing route for ${credentialId}`)
  return row
}

test('discovery projects vault credentials as secret-free routing rows', async () => {
  const { path } = await fixture()
  const roster = await refreshVaultRoster({
    path,
    custody: inventory([
      work,
      { ...named, credentialId: 'apikey:test', credentialType: 'api_key' },
    ]),
  })
  expect(roster?.rows.map((row) => [row.label, row.credentialType])).toEqual([
    ['apikey:test', 'api_key'],
    ['work', 'oauth'],
  ])
  expect(vaultRoutingRows(roster).map((row) => row.kind)).toEqual([
    'api-key',
    'oauth',
  ])
  expect(await readVaultRoster(path)).toEqual(roster)
  const text = await readFile(path, 'utf8')
  expect(text).not.toContain('access')
  expect(text).not.toContain('token')
})

test('there is no main: a record named exactly after the provider is an ordinary pool account', () => {
  const roster = projectVaultRoster(undefined, list([named, work]))
  expect(roster.rows.map((row) => row.credentialId)).toEqual([
    named.credentialId,
    work.credentialId,
  ])
  expect(vaultRoutingRows(roster)).toHaveLength(2)
  expect(roster.rows.every((row) => row.routeId !== 'main')).toBe(true)
})

test('identity replacement does not inherit quota, profile or route identity', async () => {
  const { path } = await fixture()
  const first = await refreshVaultRoster({ path, custody: inventory([work]) })
  const original = routeOf(first, work.credentialId)
  expect(
    await recordVaultQuota(path, {
      routeId: original.routeId,
      observation,
      accountIdentity: work.accountIdentity,
    }),
  ).toBe(true)
  const replaced = await refreshVaultRoster({
    path,
    custody: inventory([{ ...work, accountIdentity: 'replacement' }]),
  })
  const row = routeOf(replaced, work.credentialId)
  expect(row.routeId).not.toBe(original.routeId)
  expect(row.quota).toBeUndefined()
  expect(row.accountIdentity).toBe('replacement')
})

test('an identity learned later keeps the route and its quota', async () => {
  const { path } = await fixture()
  const anonymous = { ...work, accountIdentity: undefined }
  const first = await refreshVaultRoster({
    path,
    custody: inventory([anonymous]),
  })
  const original = routeOf(first, work.credentialId)
  await recordVaultQuota(path, { routeId: original.routeId, observation })
  const learned = await refreshVaultRoster({ path, custody: inventory([work]) })
  const row = routeOf(learned, work.credentialId)
  expect(row.routeId).toBe(original.routeId)
  expect(row.quota).toBeDefined()
})

test('duplicate login records never create duplicate quota weight', () => {
  const result = projectVaultRoster(
    undefined,
    list([
      work,
      { ...work, credentialId: 'oauth:test:duplicate' },
      { ...work, credentialId: 'alias', state: 'needs_reauth' },
    ]),
  )
  expect(result.rows).toHaveLength(1)
  expect(result.rows[0]?.credentialId).toBe('oauth:test:duplicate')
  expect(result.rows[0]?.aliases).toEqual(['alias', 'oauth:test:work'])
  const cold = projectVaultRoster(
    undefined,
    list([
      { ...work, state: 'needs_reauth' },
      { ...work, credentialId: 'working-alias' },
    ]),
  )
  expect(cold.rows.map((row) => row.credentialId)).toEqual(['working-alias'])
})

test('fresh config mutation during discovery is preserved at commit', async () => {
  const { path } = await fixture()
  const first = await refreshVaultRoster({ path, custody: inventory([work]) })
  const route = routeOf(first, work.credentialId).routeId
  const started = deferred<void>()
  const reply = deferred<VaultInventory>()
  const pending = refreshVaultRoster({
    path,
    custody: {
      discover: async () => {
        started.resolve()
        return reply.promise
      },
    },
  })
  await started.promise
  await declineVaultRoute(path, route)
  reply.resolve(list([work], 'v2'))
  expect(routeOf(await pending, work.credentialId).enabled).toBe(false)
  expect(routeOf(await readVaultRoster(path), work.credentialId).enabled).toBe(
    false,
  )
})

test('a delayed discovery that lost its lease cannot overwrite a successor inventory', async () => {
  const { path } = await fixture()
  const started = deferred<void>()
  const reply = deferred<VaultInventory>()
  const old = refreshVaultRoster({
    path,
    custody: {
      discover: async () => {
        started.resolve()
        return reply.promise
      },
    },
  })
  const outcome = old.then(
    () => ({ rejected: false }),
    () => ({ rejected: true }),
  )
  await started.promise
  await rm(`${path}.claustrum-roster.lock`, { recursive: true })
  await refreshVaultRoster({ path, custody: inventory([], 'newer') })
  reply.resolve(list([work], 'older'))
  expect(await outcome).toEqual({ rejected: true })
  const saved = await readVaultRoster(path)
  expect(saved?.view).toBe('newer')
  expect(saved?.rows).toEqual([])
})

test('discovery failure and switching to local during discovery never delete accounts', async () => {
  const { path } = await fixture()
  await refreshVaultRoster({ path, custody: inventory([work]) })
  const before = await readFile(path, 'utf8')
  await expect(
    refreshVaultRoster({
      path,
      custody: {
        discover: async () => {
          throw new Error('daemon unavailable')
        },
      },
    }),
  ).rejects.toThrow('daemon unavailable')
  expect(await readFile(path, 'utf8')).toBe(before)
  let active = true
  const started = deferred<void>()
  const reply = deferred<VaultInventory>()
  const pending = refreshVaultRoster({
    path,
    isActive: () => active,
    custody: {
      discover: async () => {
        started.resolve()
        return reply.promise
      },
    },
  })
  await started.promise
  active = false
  reply.resolve(list([], 'empty'))
  expect(await pending).toBeUndefined()
  expect(await readFile(path, 'utf8')).toBe(before)
  let calls = 0
  await refreshVaultRoster({
    path,
    isActive: () => false,
    custody: {
      discover: async () => {
        calls++
        return list([])
      },
    },
  })
  expect(calls).toBe(0)
})

test('a replacement cannot reuse an unrelated pre-existing route id', () => {
  const fresh = projectVaultRoster(undefined, list([work]))
  const id = fresh.rows[0]?.routeId
  if (!id) throw new Error('missing generated route id')
  const reserved = projectVaultRoster(undefined, list([work]), {
    reservedRouteIds: new Set([id]),
  })
  expect(reserved.rows[0]?.routeId).not.toBe(id)
  const replaced = projectVaultRoster(
    fresh,
    list([{ ...work, accountIdentity: 'another-identity' }]),
  )
  expect(replaced.rows[0]?.routeId).not.toBe(id)
  expect(replaced.rows[0]?.quota).toBeUndefined()
})

test('a quota observation taken for a replaced account is dropped', async () => {
  const { path } = await fixture()
  const first = await refreshVaultRoster({ path, custody: inventory([work]) })
  const route = routeOf(first, work.credentialId).routeId
  await refreshVaultRoster({
    path,
    custody: inventory([{ ...work, accountIdentity: 'replacement' }]),
  })
  expect(
    await recordVaultQuota(path, {
      routeId: route,
      observation,
      accountIdentity: work.accountIdentity,
    }),
  ).toBe(false)
  const current = routeOf(await readVaultRoster(path), work.credentialId)
  expect(
    await recordVaultQuota(path, {
      routeId: current.routeId,
      observation,
      accountIdentity: work.accountIdentity,
    }),
  ).toBe(false)
  expect(
    await recordVaultQuota(path, {
      routeId: current.routeId,
      observation,
      accountIdentity: 'replacement',
    }),
  ).toBe(true)
  expect(
    routeOf(await readVaultRoster(path), work.credentialId).quota,
  ).toBeDefined()
})

test('a record skipped as malformed keeps its last good projection instead of reading as removed', () => {
  const previous = projectVaultRoster(undefined, list([work, named]))
  const next = projectVaultRoster(
    previous,
    list([named], 'v2', [
      { credentialId: work.credentialId, reason: 'blank account identity' },
    ]),
  )
  const kept = next.rows.find((row) => row.credentialId === work.credentialId)
  expect(kept).toMatchObject({
    routeId: previous.rows.find((row) => row.credentialId === work.credentialId)
      ?.routeId,
    stale: true,
  })
  const gone = projectVaultRoster(previous, list([named], 'v3'))
  expect(gone.rows.map((row) => row.credentialId)).toEqual([named.credentialId])
})

test('a declined account that leaves the vault and returns is still declined', async () => {
  const { path } = await fixture()
  const first = await refreshVaultRoster({ path, custody: inventory([work]) })
  await declineVaultRoute(path, routeOf(first, work.credentialId).routeId)
  await refreshVaultRoster({ path, custody: inventory([], 'gone') })
  const returned = await refreshVaultRoster({
    path,
    custody: inventory([work], 'back'),
  })
  expect(routeOf(returned, work.credentialId).enabled).toBe(false)
  expect(vaultRoutingRows(returned)).toEqual([])
})

test('the declined interlock is keyed on credential and identity, sticky without identity, and lifts only on a known different identity', () => {
  const known = declineAccount([], 'cred-a', 'acct-1')
  expect(isDeclined(known, 'cred-a', 'acct-1')).toBe(true)
  expect(isDeclined(known, 'cred-a', undefined)).toBe(true)
  expect(isDeclined(known, 'cred-a', 'acct-2')).toBe(false)
  expect(isDeclined(known, 'cred-b', 'acct-1')).toBe(false)
  const unknown = declineAccount([], 'cred-a')
  expect(isDeclined(unknown, 'cred-a', 'acct-9')).toBe(true)
  expect(
    pruneDeclined(unknown, [{ credentialId: 'cred-a', accountIdentity: 'x' }]),
  ).toEqual(unknown)
  expect(pruneDeclined(known, [{ credentialId: 'cred-a' }])).toEqual(known)
  expect(pruneDeclined(known, [])).toEqual(known)
  expect(
    pruneDeclined(known, [
      { credentialId: 'cred-a', accountIdentity: 'acct-1' },
    ]),
  ).toEqual(known)
  expect(
    pruneDeclined(known, [
      { credentialId: 'cred-a', accountIdentity: 'acct-2' },
    ]),
  ).toEqual([])
})
