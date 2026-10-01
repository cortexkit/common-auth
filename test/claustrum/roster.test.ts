import { afterEach, expect, test } from 'bun:test'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  acceptAccount,
  acceptVaultRoute,
  declineAccount,
  declineVaultRoute,
  isDeclined,
  projectVaultRoster,
  readVaultRoster,
  recordVaultQuota,
  refreshVaultRoster,
  type VaultCredential,
  type VaultInventory,
  type VaultRosterFile,
  vaultRoutingRows,
} from '../../src/claustrum/index.ts'
import { mergeQuotaObservation } from '../../src/quota/index.ts'
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
const alias: VaultCredential = {
  ...work,
  credentialId: 'oauth:test:work-alias',
}
const fallback: VaultCredential = {
  credentialId: 'oauth:test:fallback',
  credentialType: 'oauth',
  accountIdentity: 'provider-fallback',
  state: 'active',
}
const newcomer: VaultCredential = {
  credentialId: 'oauth:test:newcomer',
  credentialType: 'oauth',
  accountIdentity: 'provider-newcomer',
  state: 'active',
}
const unclaimed = (credential: VaultCredential): VaultCredential => ({
  credentialId: credential.credentialId,
  credentialType: credential.credentialType,
  state: credential.state,
})
const receiptFor = (credential: VaultCredential) => ({
  credentialId: credential.credentialId,
  ...(credential.accountIdentity !== undefined && {
    accountIdentity: credential.accountIdentity,
    expectedAccountIdentity: credential.accountIdentity,
  }),
  accountIdentitySource: 'asserted' as const,
})
function withQuota(roster: VaultRosterFile): VaultRosterFile {
  return {
    ...roster,
    rows: roster.rows.map((row) => ({
      ...row,
      quota: mergeQuotaObservation(undefined, observation),
    })),
  }
}
function rowFor(roster: VaultRosterFile | undefined, accountIdentity: string) {
  const row = roster?.rows.find(
    (entry) => entry.accountIdentity === accountIdentity,
  )
  if (!row) throw new Error(`missing row for ${accountIdentity}`)
  return row
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
      ...receiptFor(work),
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
  expect(
    await recordVaultQuota(path, {
      routeId: original.routeId,
      observation,
      ...receiptFor(anonymous),
    }),
  ).toBe(true)
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
      ...receiptFor(work),
    }),
  ).toBe(false)
  const current = routeOf(await readVaultRoster(path), work.credentialId)
  expect(
    await recordVaultQuota(path, {
      routeId: current.routeId,
      observation,
      ...receiptFor(work),
    }),
  ).toBe(false)
  expect(
    await recordVaultQuota(path, {
      routeId: current.routeId,
      observation,
      ...receiptFor({ ...work, accountIdentity: 'replacement' }),
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

test('the declined interlock follows a known account across credential ids, and falls back to the credential id while the account is unknown', () => {
  const known = declineAccount([], 'cred-a', 'acct-1')
  expect(isDeclined(known, 'cred-a', 'acct-1')).toBe(true)
  expect(isDeclined(known, 'cred-a', undefined)).toBe(true)
  // The same account under another credential id or alias stays declined.
  expect(isDeclined(known, 'cred-b', 'acct-1')).toBe(true)
  // A different known account behind the declined credential id has its own policy.
  expect(isDeclined(known, 'cred-a', 'acct-2')).toBe(false)
  expect(isDeclined(known, 'cred-b', undefined)).toBe(false)
  const unknown = declineAccount([], 'cred-a')
  expect(isDeclined(unknown, 'cred-a', 'acct-9')).toBe(true)
  expect(isDeclined(unknown, 'cred-b', 'acct-9')).toBe(false)
  // Accepting lifts exactly the entries that decline the accepted row.
  const both = declineAccount(known, 'cred-c', 'acct-3')
  expect(acceptAccount(both, ['cred-z'], 'acct-1')).toEqual(
    declineAccount([], 'cred-c', 'acct-3'),
  )
  expect(acceptAccount(both, ['cred-a'], 'acct-2')).toEqual(both)
  expect(acceptAccount(unknown, ['cred-a'])).toEqual([])
})

test('a temporary identity omission keeps the last known binding, so the same account returns with its route, aliases and quota', async () => {
  const { path } = await fixture()
  const first = await refreshVaultRoster({
    path,
    custody: inventory([work, alias], 'v1'),
  })
  const original = routeOf(first, work.credentialId)
  expect(
    await recordVaultQuota(path, {
      routeId: original.routeId,
      observation,
      ...receiptFor(work),
    }),
  ).toBe(true)
  const omitted = await refreshVaultRoster({
    path,
    custody: inventory([unclaimed(work), unclaimed(alias)], 'v2'),
  })
  expect(omitted?.rows).toHaveLength(1)
  expect(omitted?.rows[0]).toMatchObject({
    routeId: original.routeId,
    credentialId: work.credentialId,
    accountIdentity: work.accountIdentity,
    aliases: [alias.credentialId],
    unclaimed: true,
  })
  expect(omitted?.rows[0]?.quota).toBeDefined()
  const back = await refreshVaultRoster({
    path,
    custody: inventory([work, alias], 'v3'),
  })
  expect(back?.rows).toHaveLength(1)
  expect(back?.rows[0]).toMatchObject({
    routeId: original.routeId,
    accountIdentity: work.accountIdentity,
    aliases: [alias.credentialId],
  })
  expect(back?.rows[0]?.unclaimed).toBeUndefined()
  expect(back?.rows[0]?.quota).toBeDefined()
})

test('a known replacement after a temporary identity omission inherits no route, quota or decline', async () => {
  const { path } = await fixture()
  const first = await refreshVaultRoster({
    path,
    custody: inventory([work, alias], 'v1'),
  })
  const original = routeOf(first, work.credentialId)
  await recordVaultQuota(path, {
    routeId: original.routeId,
    observation,
    ...receiptFor(work),
  })
  await declineVaultRoute(path, original.routeId)
  const omitted = await refreshVaultRoster({
    path,
    custody: inventory([unclaimed(work), unclaimed(alias)], 'v2'),
  })
  expect(omitted?.rows[0]).toMatchObject({
    routeId: original.routeId,
    accountIdentity: work.accountIdentity,
    enabled: false,
  })
  const replacement = 'provider-replacement'
  const replaced = await refreshVaultRoster({
    path,
    custody: inventory(
      [
        { ...work, accountIdentity: replacement },
        { ...alias, accountIdentity: replacement },
      ],
      'v3',
    ),
  })
  expect(replaced?.rows).toHaveLength(1)
  const row = rowFor(replaced, replacement)
  expect(row.routeId).not.toBe(original.routeId)
  expect(row.quota).toBeUndefined()
  expect(row.enabled).toBe(true)
  expect(row.unclaimed).toBeUndefined()
  expect(
    await recordVaultQuota(path, {
      routeId: row.routeId,
      observation,
      ...receiptFor(work),
    }),
  ).toBe(false)
})

test('an incomplete reply keeps an account whose representative record is malformed, with that record still a member', () => {
  const previous = withQuota(
    projectVaultRoster(undefined, list([work, alias, fallback])),
  )
  const before = rowFor(previous, 'provider-work')
  const next = projectVaultRoster(
    previous,
    list([alias, fallback], 'v2', [
      { credentialId: work.credentialId, reason: 'blank account identity' },
    ]),
  )
  expect(next.complete).toBe(false)
  expect(next.rejected).toEqual([
    { credentialId: work.credentialId, reason: 'blank account identity' },
  ])
  const row = rowFor(next, 'provider-work')
  expect(row).toMatchObject({
    routeId: before.routeId,
    credentialId: alias.credentialId,
    aliases: [work.credentialId],
  })
  expect(row.quota).toEqual(before.quota)
  expect(next.rows).toHaveLength(2)
})

test('a malformed or duplicated fallback record keeps its account as stale', () => {
  const previous = withQuota(
    projectVaultRoster(undefined, list([work, alias, fallback])),
  )
  for (const skipped of [
    [{ credentialId: fallback.credentialId, reason: 'empty state' as const }],
    [
      {
        credentialId: fallback.credentialId,
        reason: 'duplicate credential id' as const,
      },
      {
        credentialId: fallback.credentialId,
        reason: 'duplicate credential id' as const,
      },
    ],
  ]) {
    const next = projectVaultRoster(
      previous,
      list([work, alias], 'v2', skipped),
    )
    expect(next.complete).toBe(false)
    expect(rowFor(next, 'provider-fallback')).toEqual({
      ...rowFor(previous, 'provider-fallback'),
      stale: true,
    })
  }
})

test('a record with no recoverable id keeps every unaccounted account and still adds a valid newcomer', () => {
  const previous = withQuota(
    projectVaultRoster(undefined, list([work, alias, fallback])),
  )
  const next = projectVaultRoster(
    previous,
    list([newcomer], 'v2', [{ reason: 'empty credential id' }]),
  )
  expect(next.complete).toBe(false)
  expect(next.rejected).toEqual([{ reason: 'empty credential id' }])
  expect(rowFor(next, 'provider-work')).toMatchObject({
    routeId: rowFor(previous, 'provider-work').routeId,
    aliases: [alias.credentialId],
    stale: true,
  })
  expect(rowFor(next, 'provider-fallback').stale).toBe(true)
  expect(rowFor(next, 'provider-newcomer').stale).toBeUndefined()
  expect(next.rows).toHaveLength(3)
})

test('a malformed alias record stays a member of its account', () => {
  const previous = projectVaultRoster(undefined, list([work, alias, fallback]))
  const next = projectVaultRoster(
    previous,
    list([work, fallback], 'v2', [
      { credentialId: alias.credentialId, reason: 'blank account identity' },
    ]),
  )
  expect(next.complete).toBe(false)
  expect(rowFor(next, 'provider-work')).toMatchObject({
    routeId: rowFor(previous, 'provider-work').routeId,
    credentialId: work.credentialId,
    aliases: [alias.credentialId],
  })
  expect(next.rows).toHaveLength(2)
})

test('a complete reply that no longer lists an account removes it', () => {
  const previous = projectVaultRoster(undefined, list([work, alias, fallback]))
  const next = projectVaultRoster(previous, list([work], 'v2'))
  expect(next.complete).toBe(true)
  expect(next.rejected).toBeUndefined()
  expect(next.rows.map((row) => [row.credentialId, row.aliases])).toEqual([
    [work.credentialId, undefined],
  ])
})

test('a declined account stays declined under a new credential id or alias, and after leaving and returning', async () => {
  const { path } = await fixture()
  const first = await refreshVaultRoster({ path, custody: inventory([work]) })
  await declineVaultRoute(path, routeOf(first, work.credentialId).routeId)
  const relabelled = { ...work, credentialId: 'oauth:test:relabelled' }
  const moved = await refreshVaultRoster({
    path,
    custody: inventory([relabelled], 'v2'),
  })
  expect(routeOf(moved, relabelled.credentialId).enabled).toBe(false)
  await refreshVaultRoster({ path, custody: inventory([], 'gone') })
  const returned = await refreshVaultRoster({
    path,
    custody: inventory(
      [{ ...work, credentialId: 'oauth:test:third' }, alias],
      'back',
    ),
  })
  const row = rowFor(returned, 'provider-work')
  expect(row.enabled).toBe(false)
  expect(vaultRoutingRows(returned)).toEqual([])
  await acceptVaultRoute(path, row.routeId)
  const accepted = await refreshVaultRoster({
    path,
    custody: inventory(
      [{ ...work, credentialId: 'oauth:test:third' }, alias],
      'again',
    ),
  })
  expect(rowFor(accepted, 'provider-work').enabled).toBe(true)
  expect(accepted?.declined).toEqual([])
})

test('a different account behind a declined credential id has its own policy, and the declined account stays declined when it returns', async () => {
  const { path } = await fixture()
  const first = await refreshVaultRoster({ path, custody: inventory([work]) })
  await declineVaultRoute(path, routeOf(first, work.credentialId).routeId)
  const other = await refreshVaultRoster({
    path,
    custody: inventory([{ ...work, accountIdentity: 'provider-other' }], 'v2'),
  })
  expect(rowFor(other, 'provider-other').enabled).toBe(true)
  const returned = await refreshVaultRoster({
    path,
    custody: inventory(
      [
        { ...work, accountIdentity: 'provider-other' },
        { ...work, credentialId: 'oauth:test:back' },
      ],
      'v3',
    ),
  })
  expect(rowFor(returned, 'provider-other').enabled).toBe(true)
  expect(rowFor(returned, 'provider-work').enabled).toBe(false)
})

test('a quota observation must name the served credential and account, and an absent side never matches a known one', async () => {
  const { path } = await fixture()
  const first = await refreshVaultRoster({
    path,
    custody: inventory([work, alias, fallback]),
  })
  const route = rowFor(first, 'provider-work').routeId
  const record = (receipt: Parameters<typeof recordVaultQuota>[1]) =>
    recordVaultQuota(path, receipt)
  // No identity on the receipt for a known account.
  expect(
    await record({
      routeId: route,
      observation,
      credentialId: work.credentialId,
      accountIdentitySource: 'none',
    }),
  ).toBe(false)
  // A credential that is not a member of the account.
  expect(
    await record({
      routeId: route,
      observation,
      ...receiptFor(fallback),
      accountIdentity: work.accountIdentity,
    }),
  ).toBe(false)
  expect(
    await record({ routeId: route, observation, ...receiptFor(alias) }),
  ).toBe(true)
  // While the inventory makes no claim, only an identity the vault or the
  // token itself proved may land; the roster's own expectation is not proof.
  await refreshVaultRoster({
    path,
    custody: inventory([unclaimed(work), unclaimed(alias), fallback], 'v2'),
  })
  expect(
    await record({
      routeId: route,
      observation,
      ...receiptFor(work),
      accountIdentitySource: 'expected',
    }),
  ).toBe(false)
  expect(
    await record({ routeId: route, observation, ...receiptFor(work) }),
  ).toBe(true)
})
