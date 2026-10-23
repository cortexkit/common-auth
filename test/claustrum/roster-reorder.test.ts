import { expect } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ClaustrumConsumerError,
  declineVaultRoute,
  drainVaultQuota,
  mutateVaultRoster,
  readVaultRoster,
  recordVaultQuota,
  refreshVaultRoster,
  reorderVaultRoster,
  type VaultCredential,
  type VaultInventory,
  type VaultRosterFile,
  vaultRoutingRows,
} from '../../src/claustrum/index.ts'
import { acquireRefreshFileLock } from '../../src/fs/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { cleanupDirs, deferred, tempDir } from './helpers.ts'

const hooks = lifetimeHooks()
const { afterEach, test } = hooks

afterEach(cleanupDirs)

function credential(name: string): VaultCredential {
  return {
    credentialId: `oauth:test:${name}`,
    credentialType: 'oauth',
    accountIdentity: `provider-${name}`,
    state: 'active',
  }
}

const alpha = credential('alpha')
const bravo = credential('bravo')
const charlie = credential('charlie')
const delta = credential('delta')
const echo = credential('echo')

function list(credentials: readonly VaultCredential[], view = 'v') {
  return {
    discover: async (): Promise<VaultInventory> => ({
      view,
      credentials,
      skipped: [],
    }),
  }
}

/** A roster of alpha, bravo, charlie (discovery sorts new rows by id). */
async function fixture() {
  const dir = await tempDir('claustrum-reorder-')
  const path = join(dir, 'vault-roster.json')
  const roster = await refreshVaultRoster({
    path,
    custody: list([charlie, alpha, bravo]),
  })
  if (!roster) throw new Error('no roster')
  const route = (credentialId: string) => {
    const id = roster.rows.find(
      (row) => row.credentialId === credentialId,
    )?.routeId
    if (!id) throw new Error(`no route for ${credentialId}`)
    return id
  }
  return {
    path,
    roster,
    a: route(alpha.credentialId),
    b: route(bravo.credentialId),
    c: route(charlie.credentialId),
  }
}

const routeIds = (roster: VaultRosterFile | undefined) =>
  roster?.rows.map((row) => row.routeId)

test('a reorder sets the routing order and a later discovery keeps it, appending new accounts sorted by id', async () => {
  const f = await fixture()
  expect(routeIds(f.roster)).toEqual([f.a, f.b, f.c])

  expect(await reorderVaultRoster(f.path, [f.c, f.a, f.b])).toEqual({
    ids: [f.c, f.a, f.b],
    outcome: 'reordered',
  })
  const reordered = await readVaultRoster(f.path)
  expect(routeIds(reordered)).toEqual([f.c, f.a, f.b])
  expect(vaultRoutingRows(reordered).map((row) => row.id)).toEqual([
    f.c,
    f.a,
    f.b,
  ])

  // A new view with two new accounts: the reordered rows keep their places
  // and the newcomers follow, sorted by credential id.
  const refreshed = await refreshVaultRoster({
    path: f.path,
    custody: list([echo, bravo, delta, alpha, charlie], 'v2'),
  })
  expect(refreshed?.rows.map((row) => row.credentialId)).toEqual([
    charlie.credentialId,
    alpha.credentialId,
    bravo.credentialId,
    delta.credentialId,
    echo.credentialId,
  ])
  expect(routeIds(refreshed)?.slice(0, 3)).toEqual([f.c, f.a, f.b])
  expect(routeIds(await readVaultRoster(f.path))).toEqual(routeIds(refreshed))
})

test('routing order follows the new order and skips declined accounts in place', async () => {
  const f = await fixture()
  await declineVaultRoute(f.path, f.a)
  await reorderVaultRoster(f.path, [f.b, f.a, f.c])
  expect(
    vaultRoutingRows(await readVaultRoster(f.path)).map((row) => row.id),
  ).toEqual([f.b, f.c])
  await reorderVaultRoster(f.path, [f.c, f.a, f.b])
  expect(
    vaultRoutingRows(await readVaultRoster(f.path)).map((row) => row.id),
  ).toEqual([f.c, f.b])
})

test('a reorder changes only row positions: every row and the rest of the file keep their bytes', async () => {
  const f = await fixture()
  await declineVaultRoute(f.path, f.b)
  await recordVaultQuota(f.path, {
    routeId: f.a,
    credentialId: alpha.credentialId,
    accountIdentity: 'provider-alpha',
    expectedAccountIdentity: 'provider-alpha',
    accountIdentitySource: 'asserted',
    observation: {
      checkedAt: 100,
      readings: [{ label: 'primary', usedPercent: 25 }],
    },
  })
  await drainVaultQuota(f.path)
  const before = JSON.parse(await readFile(f.path, 'utf8'))
  await reorderVaultRoster(f.path, [f.b, f.c, f.a])
  const text = await readFile(f.path, 'utf8')
  const after = JSON.parse(text)
  const rowText = (rows: Array<{ routeId: string }>, id: string) =>
    JSON.stringify(rows.find((row) => row.routeId === id))
  for (const id of [f.a, f.b, f.c])
    expect(rowText(after.rows, id)).toBe(rowText(before.rows, id))
  const { rows: _beforeRows, ...beforeRest } = before
  const { rows: _afterRows, ...afterRest } = after
  expect(afterRest).toEqual(beforeRest)
  // The file is exactly the previous one with its rows permuted.
  const byId = new Map(
    before.rows.map((row: { routeId: string }) => [row.routeId, row]),
  )
  expect(text).toBe(
    `${JSON.stringify({ ...before, rows: [f.b, f.c, f.a].map((id) => byId.get(id)) }, null, 2)}\n`,
  )
})

test('an order that is not a permutation of the roster refuses and leaves the file byte-identical', async () => {
  const f = await fixture()
  const before = await readFile(f.path, 'utf8')
  const refusals: Array<[readonly string[], string]> = [
    [[f.a, f.b], 'the order leaves out 1 roster route id'],
    [
      [f.a, f.b, f.c, 'vault:unknown'],
      'route id vault:unknown is not in the roster',
    ],
    [[f.a, f.b, f.b], `route id ${f.b} appears more than once`],
    [[f.a, f.a, f.b, f.c], `route id ${f.a} appears more than once`],
    [[], 'the order leaves out 3 roster route ids'],
  ]
  for (const [order, message] of refusals) {
    const error = await reorderVaultRoster(f.path, order).then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(ClaustrumConsumerError)
    expect(error).toMatchObject({ kind: 'invalid-order', message })
    expect(await readFile(f.path, 'utf8')).toBe(before)
  }
  // A list of non-strings is refused the same way.
  await expect(
    reorderVaultRoster(f.path, [f.a, f.b, 3] as unknown as string[]),
  ).rejects.toMatchObject({ kind: 'invalid-order' })
  expect(await readFile(f.path, 'utf8')).toBe(before)
})

test('the current order, or an empty order with no roster yet, is unchanged and writes nothing', async () => {
  const f = await fixture()
  const before = await readFile(f.path, 'utf8')
  expect(await reorderVaultRoster(f.path, [f.a, f.b, f.c])).toEqual({
    ids: [f.a, f.b, f.c],
    outcome: 'unchanged',
  })
  expect(await readFile(f.path, 'utf8')).toBe(before)

  const empty = join(await tempDir('claustrum-reorder-'), 'vault-roster.json')
  expect(await reorderVaultRoster(empty, [])).toEqual({
    ids: [],
    outcome: 'unchanged',
  })
  expect(await readVaultRoster(empty)).toBeUndefined()
  await expect(reorderVaultRoster(empty, ['vault:x'])).rejects.toMatchObject({
    kind: 'invalid-order',
  })
  expect(await readVaultRoster(empty)).toBeUndefined()
})

test('a reorder waits for a roster write in progress and keeps what that write committed', async () => {
  const f = await fixture()
  const entered = deferred<void>()
  const gate = deferred<void>()
  // Another writer (a decline) is inside the roster's write lock.
  const writing = mutateVaultRoster(f.path, async (current) => {
    entered.resolve()
    await gate.promise
    if (!current) throw new Error('no roster')
    return {
      next: {
        ...current,
        rows: current.rows.map((row) =>
          row.routeId === f.b ? { ...row, enabled: false } : row,
        ),
      },
      result: undefined,
    }
  })
  await entered.promise
  const reordering = reorderVaultRoster(f.path, [f.c, f.b, f.a])
  // Give the reorder time to read the file, were it not waiting for the lock.
  await new Promise((done) => setTimeout(done, 50))
  gate.resolve()
  await writing
  await reordering
  const roster = await readVaultRoster(f.path)
  expect(routeIds(roster)).toEqual([f.c, f.b, f.a])
  expect(roster?.rows.find((row) => row.routeId === f.b)?.enabled).toBe(false)
})

test('a concurrent reorder and quota record both land: neither loses the other', async () => {
  const f = await fixture()
  const lock = await acquireRefreshFileLock({
    path: f.path,
    name: 'claustrum-roster-write',
    ttlMs: 10_000,
    renew: true,
  })
  if (!lock) throw new Error('holder failed')
  let reordering: Promise<unknown> | undefined
  try {
    reordering = reorderVaultRoster(f.path, [f.b, f.c, f.a])
    expect(
      await recordVaultQuota(f.path, {
        routeId: f.c,
        credentialId: charlie.credentialId,
        accountIdentity: 'provider-charlie',
        expectedAccountIdentity: 'provider-charlie',
        accountIdentitySource: 'asserted',
        observation: {
          checkedAt: 200,
          readings: [{ label: 'primary', usedPercent: 40 }],
        },
      }),
    ).toBe(true)
  } finally {
    await lock.release()
  }
  await reordering
  await drainVaultQuota(f.path)
  const roster = await readVaultRoster(f.path)
  expect(routeIds(roster)).toEqual([f.b, f.c, f.a])
  expect(
    roster?.rows.find((row) => row.routeId === f.c)?.quota?.limits[0],
  ).toMatchObject({ checkedAt: 200, usedPercent: 40 })
})
