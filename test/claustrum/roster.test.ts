import { expect } from 'bun:test'
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  acceptAccount,
  acceptVaultRoute,
  declineAccount,
  declineVaultRoute,
  drainVaultQuota,
  isDeclined,
  mutateVaultRoster,
  projectVaultRoster,
  readVaultRoster,
  recordVaultQuota,
  refreshVaultRoster,
  type VaultCredential,
  type VaultInventory,
  type VaultRosterFile,
  vaultRoutingRows,
} from '../../src/claustrum/index.ts'
import {
  acquireRefreshFileLock,
  LockOwnershipError,
  lockPathFor,
} from '../../src/fs/index.js'
import { mergeQuotaObservation } from '../../src/quota/index.ts'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { cleanupDirs, deferred, tempDir } from './helpers.ts'

const hooks = lifetimeHooks()
const { afterEach, test } = hooks

afterEach(cleanupDirs)

// The promise answers whether the fence kept the reading (true once queued,
// false when refused). Persistence tests explicitly drain, and refused
// receipts must leave the actual roster bytes untouched.
async function publishQuota(
  path: string,
  input: Parameters<typeof recordVaultQuota>[1],
  kept = true,
) {
  const before = kept ? undefined : await readFile(path, 'utf8')
  expect(await recordVaultQuota(path, input)).toBe(kept)
  await drainVaultQuota(path)
  if (before !== undefined) expect(await readFile(path, 'utf8')).toBe(before)
}

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

test('publishes a runtime-only sibling file after asserting roster lock ownership', async () => {
  const { path } = await fixture()
  await refreshVaultRoster({ path, custody: inventory([work]) })
  const original = await readFile(path, 'utf8')
  const staged = `${path}.runtime-stage`
  const published = `${path}.runtime`
  await writeFile(staged, 'runtime data')
  await mutateVaultRoster(path, async (_current, { assertOwned }) => {
    await assertOwned()
    await rename(staged, published)
    return { result: 'published' }
  })
  expect(await readFile(published, 'utf8')).toBe('runtime data')
  expect(await readFile(path, 'utf8')).toBe(original)
})

test('serializes competing roster mutations until the first callback returns', async () => {
  const { path } = await fixture()
  const entered = deferred<void>()
  const release = deferred<void>()
  const first = mutateVaultRoster(path, async () => {
    entered.resolve()
    await release.promise
    return { result: undefined }
  })
  await entered.promise
  let secondEntered = false
  const second = mutateVaultRoster(path, () => {
    secondEntered = true
    return { result: undefined }
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(secondEntered).toBe(false)
  release.resolve()
  await Promise.all([first, second])
  expect(secondEntered).toBe(true)
})

async function stealRosterWriteLock(path: string): Promise<void> {
  const lockPath = lockPathFor(path, 'claustrum-roster-write')
  const current = JSON.parse(await readFile(lockPath, 'utf8'))
  await writeFile(
    lockPath,
    JSON.stringify({
      ownerId: 'foreign',
      expiresAt: Date.now() + 30_000,
    }),
  )
  expect(current.ownerId).toBeString()
}

test('lost roster ownership rejects and skips a caller rename and roster write', async () => {
  const { path } = await fixture()
  await refreshVaultRoster({ path, custody: inventory([work]) })
  const before = await readFile(path, 'utf8')
  const staged = `${path}.runtime-stage`
  const published = `${path}.runtime`
  await writeFile(staged, 'runtime data')
  let assertionRan = false
  let caught: unknown
  try {
    await mutateVaultRoster(path, async (_current, { assertOwned }) => {
      await stealRosterWriteLock(path)
      assertionRan = true
      await assertOwned()
      await rename(staged, published)
      return { result: undefined }
    })
  } catch (error) {
    caught = error
  }
  expect(assertionRan).toBe(true)
  expect(caught).toBeInstanceOf(LockOwnershipError)
  expect(await readFile(path, 'utf8')).toBe(before)
  expect(await readFile(staged, 'utf8')).toBe('runtime data')
  await expect(readFile(published, 'utf8')).rejects.toThrow()
})

test('the roster pre-write ownership check rejects a lost lease without writing', async () => {
  const { path } = await fixture()
  await refreshVaultRoster({ path, custody: inventory([work]) })
  const before = await readFile(path, 'utf8')
  let caught: unknown
  try {
    await mutateVaultRoster(path, async (current) => {
      if (!current) throw new Error('expected a roster')
      await stealRosterWriteLock(path)
      return { next: { ...current, view: 'must-not-write' }, result: undefined }
    })
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(LockOwnershipError)
  expect(await readFile(path, 'utf8')).toBe(before)
})

async function stagedFiles(path: string) {
  const { readdir } = await import('node:fs/promises')
  const { basename, dirname } = await import('node:path')
  return (await readdir(dirname(path))).filter(
    (name) => name.startsWith(`${basename(path)}.`) && name.endsWith('.tmp'),
  )
}

test('beforePublish runs after the roster is staged, immediately before the rename', async () => {
  const { path } = await fixture()
  await refreshVaultRoster({ path, custody: inventory([work]) })
  let staged: string[] = []
  let published: string | undefined
  await mutateVaultRoster(
    path,
    async (current) => {
      if (!current) throw new Error('expected a roster')
      return { next: { ...current, view: 'published' }, result: undefined }
    },
    {
      beforePublish: async () => {
        staged = await stagedFiles(path)
        published = (await readVaultRoster(path))?.view
      },
    },
  )
  expect(staged, 'the new roster is staged when the guard runs').toHaveLength(1)
  expect(published, 'the old roster is still in place then').not.toBe(
    'published',
  )
  expect((await readVaultRoster(path))?.view).toBe('published')
  expect(await stagedFiles(path)).toEqual([])
})

test('a rejecting beforePublish leaves the roster unchanged and removes the staged file', async () => {
  const { path } = await fixture()
  await refreshVaultRoster({ path, custody: inventory([work]) })
  const before = await readFile(path, 'utf8')
  const refusal = new Error('caller lease lost')
  let caught: unknown
  try {
    await mutateVaultRoster(
      path,
      async (current) => {
        if (!current) throw new Error('expected a roster')
        return { next: { ...current, view: 'must-not-publish' }, result: 0 }
      },
      {
        beforePublish: async () => {
          throw refusal
        },
      },
    )
  } catch (error) {
    caught = error
  }
  expect(caught).toBe(refusal)
  expect(await readFile(path, 'utf8'), 'roster bytes unchanged').toBe(before)
  expect(await stagedFiles(path), 'staged file removed').toEqual([])
})

test('losing the roster lock while staging prevents publication', async () => {
  const { path } = await fixture()
  await refreshVaultRoster({ path, custody: inventory([work]) })
  const before = await readFile(path, 'utf8')
  let caught: unknown
  try {
    await mutateVaultRoster(
      path,
      async (current) => {
        if (!current) throw new Error('expected a roster')
        return { next: { ...current, view: 'must-not-publish' }, result: 0 }
      },
      // The caller's own guard passes; the roster lock is gone by now.
      { beforePublish: () => stealRosterWriteLock(path) },
    )
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(LockOwnershipError)
  expect(await readFile(path, 'utf8'), 'roster bytes unchanged').toBe(before)
  expect(await stagedFiles(path), 'staged file removed').toEqual([])
})

test('one-argument roster mutation callbacks remain supported', async () => {
  const { path } = await fixture()
  const result = await mutateVaultRoster(path, (current) => ({
    result: current === undefined ? 'empty roster' : 'existing roster',
  }))
  expect(result).toBe('empty roster')
})

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
  await publishQuota(
    path,
    {
      routeId: original.routeId,
      observation,
      ...receiptFor(work),
    },
    true,
  )
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
  await publishQuota(
    path,
    {
      routeId: original.routeId,
      observation,
      ...receiptFor(anonymous),
    },
    true,
  )
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
  await publishQuota(
    path,
    {
      routeId: route,
      observation,
      ...receiptFor(work),
    },
    false,
  )
  const current = routeOf(await readVaultRoster(path), work.credentialId)
  await publishQuota(
    path,
    {
      routeId: current.routeId,
      observation,
      ...receiptFor(work),
    },
    false,
  )
  await publishQuota(
    path,
    {
      routeId: current.routeId,
      observation,
      ...receiptFor({ ...work, accountIdentity: 'replacement' }),
    },
    true,
  )
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
  await publishQuota(
    path,
    {
      routeId: original.routeId,
      observation,
      ...receiptFor(work),
    },
    true,
  )
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
  await publishQuota(path, {
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
  await publishQuota(
    path,
    {
      routeId: row.routeId,
      observation,
      ...receiptFor(work),
    },
    false,
  )
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
  const anonymous = unclaimed(newcomer)
  const first = await refreshVaultRoster({
    path,
    custody: inventory([work, alias, fallback, anonymous]),
  })
  const route = rowFor(first, 'provider-work').routeId
  // A row that has never had a known account takes a receipt issued for it
  // in that state, even when the token parse named an account, but not one
  // issued for a known account it does not hold.
  const anonymousRoute = routeOf(first, anonymous.credentialId).routeId
  await publishQuota(
    path,
    {
      routeId: anonymousRoute,
      observation,
      credentialId: anonymous.credentialId,
      accountIdentity: 'parsed-account',
      accountIdentitySource: 'parsed',
    },
    true,
  )
  await publishQuota(
    path,
    {
      routeId: anonymousRoute,
      observation,
      ...receiptFor({ ...anonymous, accountIdentity: 'other-account' }),
    },
    false,
  )
  // A receipt with no account identity is rejected for a row whose account is known.
  await publishQuota(
    path,
    {
      routeId: route,
      observation,
      credentialId: work.credentialId,
      accountIdentitySource: 'none',
    },
    false,
  )
  // A receipt is rejected when its credential is not the row's representative or alias.
  await publishQuota(
    path,
    {
      routeId: route,
      observation,
      ...receiptFor(fallback),
      accountIdentity: work.accountIdentity,
    },
    false,
  )
  await publishQuota(
    path,
    { routeId: route, observation, ...receiptFor(alias) },
    true,
  )
  // When the vault's list names no account for the row's credential, a reading
  // is accepted only if the vault's reply or the token parse proved the
  // account; the roster's expected account alone is not proof.
  await refreshVaultRoster({
    path,
    custody: inventory(
      [unclaimed(work), unclaimed(alias), fallback, anonymous],
      'v2',
    ),
  })
  await publishQuota(
    path,
    {
      routeId: route,
      observation,
      ...receiptFor(work),
      accountIdentitySource: 'expected',
    },
    false,
  )
  await publishQuota(
    path,
    { routeId: route, observation, ...receiptFor(work) },
    true,
  )
})

test('roster reads drop malformed counters without losing quota or the row', async () => {
  const { path } = await fixture()
  const first = await refreshVaultRoster({ path, custody: inventory([work]) })
  if (!first) throw new Error('expected roster')
  const quota = {
    limits: [
      {
        scope: 'all',
        label: '5h',
        kind: 'reading' as const,
        checkedAt: 100,
        usedPercent: 10,
      },
    ],
    counters: {
      resetCredits: { value: 4, checkedAt: 100 },
      negative: { value: -1, checkedAt: 100 },
      fractional: { value: 0.5, checkedAt: 100 },
      missingTime: { value: 2 },
      badTime: { value: 2, checkedAt: '100' },
      missingValue: { checkedAt: 100 },
    },
  }
  await writeFile(
    path,
    JSON.stringify({
      ...first,
      rows: first.rows.map((row) => ({ ...row, quota })),
    }),
  )
  const before = await readFile(path, 'utf8')
  const loaded = await readVaultRoster(path)
  expect(loaded?.rows).toHaveLength(1)
  expect(loaded?.rows[0]?.quota).toEqual({
    limits: quota.limits,
    counters: { resetCredits: { value: 4, checkedAt: 100 } },
  })
  expect(await readFile(path, 'utf8')).toBe(before)
})

test('counter-free roster quota writes keep the legacy file bytes', async () => {
  const { path } = await fixture()
  const first = await refreshVaultRoster({ path, custody: inventory([work]) })
  if (!first) throw new Error('expected roster')
  const row = rowFor(first, 'provider-work')
  await publishQuota(
    path,
    {
      routeId: row.routeId,
      ...receiptFor(work),
      observation: {
        checkedAt: 100,
        readings: [{ label: 'primary', usedPercent: 20 }],
        budget: { kind: 'cleared' },
      },
    },
    true,
  )
  const legacyQuota = {
    limits: [
      {
        scope: 'all',
        label: 'primary',
        kind: 'reading',
        checkedAt: 100,
        usedPercent: 20,
      },
    ],
    budget: { kind: 'cleared', checkedAt: 100 },
  }
  const expected = {
    ...first,
    rows: first.rows.map((entry) => ({ ...entry, quota: legacyQuota })),
  }
  expect(await readFile(path, 'utf8')).toBe(
    `${JSON.stringify(expected, null, 2)}\n`,
  )
})

test('a reading with a proven account on a row that has never had one binds that account, so a later list naming another account inherits no quota', async () => {
  const { path } = await fixture()
  const anonymous = unclaimed(work)
  const first = await refreshVaultRoster({
    path,
    custody: inventory([anonymous]),
  })
  const original = routeOf(first, work.credentialId)
  expect(original.accountIdentity).toBeUndefined()
  await publishQuota(
    path,
    {
      routeId: original.routeId,
      observation,
      credentialId: work.credentialId,
      accountIdentity: 'account-A',
      accountIdentitySource: 'asserted',
    },
    true,
  )
  const bound = routeOf(await readVaultRoster(path), work.credentialId)
  expect(bound).toMatchObject({
    routeId: original.routeId,
    accountIdentity: 'account-A',
    unclaimed: true,
  })
  expect(bound.quota).toBeDefined()
  // The bound account's own receipt still lands on the row.
  await publishQuota(
    path,
    {
      routeId: original.routeId,
      observation,
      ...receiptFor({ ...work, accountIdentity: 'account-A' }),
    },
    true,
  )
  const replaced = await refreshVaultRoster({
    path,
    custody: inventory([{ ...work, accountIdentity: 'account-B' }], 'v2'),
  })
  const row = routeOf(replaced, work.credentialId)
  expect(row.accountIdentity).toBe('account-B')
  expect(row.quota).toBeUndefined()
  expect(row.routeId).not.toBe(original.routeId)
})

test('a reading with no account on a row that has never had one is kept and binds nothing', async () => {
  const { path } = await fixture()
  const anonymous = unclaimed(work)
  const first = await refreshVaultRoster({
    path,
    custody: inventory([anonymous]),
  })
  const original = routeOf(first, work.credentialId)
  await publishQuota(
    path,
    {
      routeId: original.routeId,
      observation,
      credentialId: work.credentialId,
      accountIdentitySource: 'none',
    },
    true,
  )
  const kept = routeOf(await readVaultRoster(path), work.credentialId)
  expect(kept.quota).toBeDefined()
  expect(kept.accountIdentity).toBeUndefined()
  expect(kept.unclaimed).toBeUndefined()
})

test('a reading with a proven account on an accountless row with several credentials is refused', async () => {
  const { path } = await fixture()
  const roster: VaultRosterFile = {
    version: 1,
    complete: true,
    declined: [],
    rows: [
      {
        routeId: 'vault:shared',
        credentialId: work.credentialId,
        aliases: [alias.credentialId],
        credentialType: 'oauth',
        state: 'active',
        label: 'work',
        enabled: true,
        addedAt: 1,
      },
    ],
  }
  await writeFile(path, JSON.stringify(roster), { mode: 0o600 })
  await publishQuota(
    path,
    {
      routeId: 'vault:shared',
      observation,
      credentialId: alias.credentialId,
      accountIdentity: 'account-A',
      accountIdentitySource: 'parsed',
    },
    false,
  )
  expect(await readVaultRoster(path)).toEqual(roster)
})

async function rosterIdentity(path: string) {
  const { ino, mtimeMs, size } = await stat(path)
  return { ino, mtimeMs, size }
}

async function directoryEntries(path: string) {
  const { readdir } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  return (await readdir(dirname(path))).sort()
}

test('an unchanged list takes no write lock and leaves the roster file alone', async () => {
  const { path } = await fixture()
  await refreshVaultRoster({ path, custody: inventory([work]) })
  const before = await rosterIdentity(path)
  const entries = await directoryEntries(path)
  // Something else holds the write lock for the whole list: a refresh that
  // took it for an unchanged roster would wait and then refuse.
  const holder = await acquireRefreshFileLock({
    path,
    name: 'claustrum-roster-write',
    ttlMs: 10_000,
    renew: true,
  })
  if (!holder) throw new Error('holder failed')
  let roster: VaultRosterFile | undefined
  try {
    roster = await refreshVaultRoster({ path, custody: inventory([work]) })
  } finally {
    await holder.release()
  }
  expect(roster?.view).toBe('v')
  expect(await rosterIdentity(path)).toEqual(before)
  expect(await directoryEntries(path)).toEqual(entries)
})

test('a changed list still takes the write lock and writes', async () => {
  const { path } = await fixture()
  await refreshVaultRoster({ path, custody: inventory([work]) })
  const before = await rosterIdentity(path)
  const roster = await refreshVaultRoster({
    path,
    custody: inventory([work, fallback]),
  })
  expect(roster?.rows).toHaveLength(2)
  const after = await rosterIdentity(path)
  expect(after.ino).not.toBe(before.ino)
  expect(after.mtimeMs).not.toBe(before.mtimeMs)
  expect((await readVaultRoster(path))?.rows).toHaveLength(2)
})

// A quota observation that only this process holds in memory: it is drained
// after the check, by whichever commit reaches the file first.
const queuedObservation = {
  checkedAt: 100,
  readings: [{ label: '5h', usedPercent: 10 }],
}

test("an unchanged list still commits this process's unwritten quota readings", async () => {
  const { path } = await fixture()
  const first = await refreshVaultRoster({ path, custody: inventory([work]) })
  const route = routeOf(first, work.credentialId).routeId
  expect(
    await recordVaultQuota(path, {
      routeId: route,
      observation: queuedObservation,
      ...receiptFor(work),
    }),
  ).toBe(true)
  let roster: VaultRosterFile | undefined
  try {
    roster = await refreshVaultRoster({ path, custody: inventory([work]) })
  } finally {
    await drainVaultQuota(path)
  }
  // The roster the list returns is the file, as an unchanged commit returns
  // it: the reading beyond it is committed, not held back.
  expect(routeOf(roster, work.credentialId).quota).toBeUndefined()
  expect(
    routeOf(await readVaultRoster(path), work.credentialId).quota,
  ).toBeDefined()
})

test('a list whose unlocked read races a writer never overwrites the newer file', async () => {
  const { path } = await fixture()
  const other = {
    ...work,
    credentialId: 'oauth:test:other',
    accountIdentity: 'provider-other',
  }
  const first = await refreshVaultRoster({
    path,
    custody: inventory([work, other]),
  })
  const route = routeOf(first, work.credentialId).routeId
  // The second list leaves `work` out, so committing it would remove that
  // account and write a file unlike the one it read: it has to take the lock.
  let raced: VaultRosterFile | undefined
  const roster = await refreshVaultRoster({
    path,
    custody: inventory([other], 'v'),
    // Runs once the list is in hand and before the commit decides: the file
    // gains a decline that this refresh must not throw away.
    onInventory: async () => {
      await declineVaultRoute(path, route)
      raced = await readVaultRoster(path)
    },
  })
  expect(raced?.rows).toHaveLength(2)
  // The write the refresh compared was stale; the commit under the lock kept
  // the decline instead of reverting to the file it had read.
  expect(
    roster?.rows.some((row) => row.credentialId === work.credentialId),
  ).toBe(false)
  const saved = await readVaultRoster(path)
  expect(saved?.declined).toHaveLength(1)
  expect(saved?.declined).toEqual(raced?.declined)
})
