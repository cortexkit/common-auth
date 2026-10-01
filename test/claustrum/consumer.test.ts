import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { ScopedInventoryRow } from '@cortexkit/claustrum-client'
import {
  ClaustrumConsumer,
  type ClaustrumConsumerOptions,
  type ClaustrumScopedClient,
  declineVaultRoute,
  type VaultRosterFile,
} from '../../src/claustrum/index.ts'
import { admit, type RoutingRow } from '../../src/routing/index.ts'
import {
  cleanupDirs,
  deferred,
  family,
  inventoryRow,
  tempDir,
  writeToken,
} from './helpers.ts'

const consumers: ClaustrumConsumer[] = []
afterEach(async () => {
  for (const consumer of consumers.splice(0)) consumer.close()
  await cleanupDirs()
})

async function fixture() {
  const dir = await tempDir('claustrum-consumer-')
  const tokenPath = await writeToken(dir)
  const gets: Array<Parameters<ClaustrumScopedClient['getScoped']>[0]> = []
  const reports: Array<
    Parameters<ClaustrumScopedClient['reportAuthFailureScoped']>[0]
  > = []
  let connects = 0
  let lists = 0
  let closes = 0
  const rows: ScopedInventoryRow[] = ['oauth:test', 'oauth:test:work'].map(
    (id, index) => inventoryRow({ id, accountId: `provider-${index}` }),
  )
  const client: ClaustrumScopedClient = {
    listScoped: async () => {
      lists++
      return { rows, view: 'v' }
    },
    getScoped: async (input) => {
      gets.push(input)
      return {
        credentialId: input.credentialId,
        accountId: rows.find((row) => row.id === input.credentialId)?.accountId,
        material: 'vault-test-access',
        recordVersion: 3,
        expiresAtMs: Date.now() + 600_000,
      }
    },
    reportAuthFailureScoped: async (input) => {
      reports.push(input)
    },
    close: () => {
      closes++
    },
  }
  const options: ClaustrumConsumerOptions = {
    rosterPath: join(dir, 'vault-roster.json'),
    tokenPath,
    family,
    connect: async () => {
      connects++
      return client
    },
    pollIntervalMs: 0,
  }
  const consumer = new ClaustrumConsumer(options)
  consumers.push(consumer)
  const route = (roster: VaultRosterFile | undefined, credentialId: string) => {
    const id = roster?.rows.find(
      (row) => row.credentialId === credentialId,
    )?.routeId
    if (!id) throw new Error(`no route for ${credentialId}`)
    return id
  }
  return {
    dir,
    options,
    client,
    consumer,
    gets,
    reports,
    rows,
    route,
    counts: () => ({ connects, lists, closes }),
  }
}

function unauthorized() {
  return new Response(null, { status: 401 })
}

test('metadata refresh and connection coalesce, but dispatch authorization never coalesces', async () => {
  const f = await fixture()
  const [roster] = await Promise.all([
    f.consumer.refresh(),
    f.consumer.refresh(),
  ])
  expect(f.counts()).toEqual({ connects: 1, lists: 1, closes: 0 })
  const id = f.route(roster, 'oauth:test')
  await Promise.all([f.consumer.authorize(id), f.consumer.authorize(id)])
  expect(f.gets).toHaveLength(2)
})

test('a disabled route is refused even before the next metadata poll', async () => {
  const f = await fixture()
  const id = f.route(await f.consumer.refresh(), 'oauth:test:work')
  await f.consumer.authorize(id)
  // Another process declines the account; this instance has not polled since.
  await declineVaultRoute(f.options.rosterPath, id)
  await expect(f.consumer.authorize(id)).rejects.toThrow('disabled')
  expect(f.gets).toHaveLength(1)
})

test('quota requests authorize freshly and report the exact served version', async () => {
  const f = await fixture()
  const id = f.route(await f.consumer.refresh(), 'oauth:test')
  const sent: string[] = []
  const response = await f.consumer.send(
    id,
    async (attempt) => {
      sent.push(`Bearer ${attempt.accessToken}`)
      return unauthorized()
    },
    { site: 'quota' },
  )
  expect(response.status).toBe(401)
  expect(sent).toEqual(['Bearer vault-test-access'])
  expect(f.gets).toHaveLength(2)
  expect(f.reports).toEqual([
    {
      credentialId: 'oauth:test',
      enrollmentToken: '01'.repeat(32),
      providerStatus: 401,
      recordVersion: 3,
      reporterSource: 'direct',
    },
  ])
})

test('a late connector is closed rather than resurrected after shutdown', async () => {
  const f = await fixture()
  const started = deferred<void>()
  const connection = deferred<ClaustrumScopedClient>()
  const consumer = new ClaustrumConsumer({
    ...f.options,
    connect: () => {
      started.resolve()
      return connection.promise
    },
  })
  consumers.push(consumer)
  const result = consumer.refresh().then(
    () => 'resolved',
    () => 'rejected',
  )
  await started.promise
  consumer.close()
  connection.resolve(f.client)
  expect(await result).toBe('rejected')
  expect(f.counts().closes).toBe(1)
  expect(consumer.snapshot()).toBeUndefined()
})

test('local mode performs no vault connection and rejects any stale scoped dispatch', async () => {
  const f = await fixture()
  let active = true
  const consumer = new ClaustrumConsumer({
    ...f.options,
    isCustodyActive: () => active,
  })
  consumers.push(consumer)
  const id = f.route(await consumer.refresh(), 'oauth:test')
  expect(f.counts().connects).toBe(1)
  active = false
  expect(await consumer.refresh()).toBeUndefined()
  await expect(consumer.authorize(id)).rejects.toThrow('not active')
  const local = new ClaustrumConsumer({
    ...f.options,
    isCustodyActive: () => false,
  })
  consumers.push(local)
  expect(await local.refresh()).toBeUndefined()
  await expect(local.authorize(id)).rejects.toThrow('not active')
  expect(f.counts().connects).toBe(1)
  expect(f.gets).toHaveLength(0)
})

test('a peer replacing an account cannot leave its old route authorized', async () => {
  const f = await fixture()
  const id = f.route(await f.consumer.refresh(), 'oauth:test')
  const original = f.rows[0]
  if (!original) throw new Error('missing fixture row')
  f.rows[0] = { ...original, accountId: 'replacement-provider' }
  const peer = new ClaustrumConsumer(f.options)
  consumers.push(peer)
  await peer.refresh()
  await expect(f.consumer.authorize(id)).rejects.toThrow('changed')
  expect(f.gets).toHaveLength(0)
})

test('each send gets a new scoped receipt bound to its provider identity', async () => {
  const f = await fixture()
  const id = f.route(await f.consumer.refresh(), 'oauth:test')
  const receipts: unknown[] = []
  for (let index = 0; index < 2; index++) {
    await f.consumer.send(
      id,
      async (attempt) => {
        receipts.push(attempt)
        expect(attempt.accountIdentity).toBe('provider-0')
        return new Response('ok')
      },
      { site: 'profile' },
    )
  }
  expect(receipts[0]).not.toBe(receipts[1])
  expect(f.gets).toHaveLength(2)
  expect(f.reports).toHaveLength(0)
})

test('profile 401 retries the new record and reports its version if it also fails', async () => {
  const f = await fixture()
  const id = f.route(await f.consumer.refresh(), 'oauth:test')
  const sent: string[] = []
  const response = await f.consumer.send(
    id,
    async (attempt) => {
      sent.push(`Bearer ${attempt.accessToken}`)
      f.client.getScoped = async (input) => ({
        credentialId: input.credentialId,
        accountId: f.rows[0]?.accountId,
        material: 'new-vault-access',
        recordVersion: 4,
        expiresAtMs: Date.now() + 600_000,
      })
      return unauthorized()
    },
    { site: 'profile' },
  )
  expect(response.status).toBe(401)
  expect(f.reports).toHaveLength(1)
  expect(sent).toEqual(['Bearer vault-test-access', 'Bearer new-vault-access'])
  expect(f.reports[0]?.recordVersion).toBe(4)
})

test('cancelling a dispatch during connection setup does not wait for or cancel shared discovery', async () => {
  const f = await fixture()
  const entered = deferred<void>()
  const connection = deferred<ClaustrumScopedClient>()
  const consumer = new ClaustrumConsumer({
    ...f.options,
    connect: () => {
      entered.resolve()
      return connection.promise
    },
  })
  consumers.push(consumer)
  const controller = new AbortController()
  const outcome = consumer.authorize('any-route', controller.signal).then(
    () => 'unexpected success',
    (error: unknown) => String(error),
  )
  try {
    await entered.promise
    const shared = consumer.refresh()
    controller.abort(new Error('caller cancelled'))
    expect(await outcome).toContain('caller cancelled')
    expect(f.gets).toHaveLength(0)
    connection.resolve(f.client)
    const roster = await shared
    expect(roster?.rows).toHaveLength(2)
    const id = f.route(roster, 'oauth:test')
    expect((await consumer.authorize(id)).accountIdentity).toBe('provider-0')
  } finally {
    connection.resolve(f.client)
  }
})

test('shutdown rejects connection waiters immediately and closes a late client', async () => {
  const f = await fixture()
  const entered = deferred<void>()
  const closed = deferred<void>()
  const connection = deferred<ClaustrumScopedClient>()
  const consumer = new ClaustrumConsumer({
    ...f.options,
    connect: () => {
      entered.resolve()
      return connection.promise
    },
  })
  consumers.push(consumer)
  const outcome = consumer.refresh().then(
    () => 'unexpected success',
    (error: unknown) => String(error),
  )
  const client = {
    ...f.client,
    close: () => {
      f.client.close()
      closed.resolve()
    },
  }
  try {
    await entered.promise
    consumer.close()
    expect(await outcome).toContain('closed')
    connection.resolve(client)
    await closed.promise
    expect(f.counts().closes).toBe(1)
    expect(f.counts().lists).toBe(0)
  } finally {
    connection.resolve(client)
  }
})

test('onRoster fires only when the discovery view changes', async () => {
  const f = await fixture()
  let view = 'v1'
  const seen: string[] = []
  const consumer = new ClaustrumConsumer({
    ...f.options,
    connect: async () => ({
      ...f.client,
      listScoped: async () => ({ rows: f.rows, view }),
    }),
    onRoster: (roster) => {
      seen.push(roster.view ?? '')
    },
  })
  consumers.push(consumer)
  await consumer.refresh()
  await consumer.refresh()
  // A second poll with an identical view must not re-notify: subscribers
  // rewrite shared state files on every notification.
  expect(seen).toEqual(['v1'])
  view = 'v2'
  await consumer.refresh()
  expect(seen).toEqual(['v1', 'v2'])
})

test('two project runtimes sharing storage serve the persisted roster while a peer holds discovery lease', async () => {
  const f = await fixture()
  const original = await f.consumer.refresh()
  const entered = deferred<void>()
  const release = deferred<void>()
  let peerLists = 0
  const peer = new ClaustrumConsumer({
    ...f.options,
    connect: async () => ({
      ...f.client,
      listScoped: async () => {
        peerLists++
        entered.resolve()
        await release.promise
        return { rows: f.rows, view: 'new-view' }
      },
    }),
  })
  consumers.push(peer)
  const held = peer.refresh()
  await entered.promise
  const another = new ClaustrumConsumer(f.options)
  consumers.push(another)
  try {
    const alreadyCommitted = await another.refresh()
    expect(alreadyCommitted?.view).toBe(original?.view)
    expect(alreadyCommitted?.rows).toEqual(original?.rows)
    expect(peerLists).toBe(1)
    const receipt = await another.authorize(f.route(original, 'oauth:test'))
    expect(receipt.accountIdentity).toBe('provider-0')
    expect(f.gets.at(-1)?.credentialId).toBe('oauth:test')
  } finally {
    release.resolve()
    await held
  }
})

test.each(['quota', 'profile'] as const)(
  '%s recovers a 401 only when the same scoped account advances',
  async (site) => {
    const f = await fixture()
    const id = f.route(await f.consumer.refresh(), 'oauth:test')
    let version = 3
    const sent: string[] = []
    f.client.getScoped = async (input) => {
      f.gets.push(input)
      return {
        credentialId: input.credentialId,
        accountId: f.rows[0]?.accountId,
        material: `vault-v${version}`,
        recordVersion: version,
        expiresAtMs: Date.now() + 600_000,
      }
    }
    const response = await f.consumer.send(
      id,
      async (attempt) => {
        const authorization = `Bearer ${attempt.accessToken}`
        sent.push(authorization)
        if (authorization === 'Bearer vault-v3') {
          version = 4
          return unauthorized()
        }
        return Response.json({ ok: true })
      },
      { site },
    )
    expect(response.status).toBe(200)
    expect(sent).toEqual(['Bearer vault-v3', 'Bearer vault-v4'])
    expect(f.gets).toHaveLength(2)
    expect(f.reports).toEqual([])
  },
)

test('a send never enrolls: without a token it fails before reaching the vault', async () => {
  const f = await fixture()
  const id = f.route(await f.consumer.refresh(), 'oauth:test')
  const unenrolled = new ClaustrumConsumer({
    ...f.options,
    tokenPath: join(f.dir, 'missing-token.json'),
  })
  consumers.push(unenrolled)
  await expect(
    unenrolled.send(id, async () => new Response('ok'), { site: 'model' }),
  ).rejects.toThrow('not configured')
  expect(f.gets).toHaveLength(0)
})

test('vault rows route through /routing admission and /quota projection alongside local rows', async () => {
  const f = await fixture()
  const roster = await f.consumer.refresh()
  const id = f.route(roster, 'oauth:test:work')
  const attempt = await f.consumer.authorize(id)
  expect(
    await f.consumer.recordQuota(
      id,
      {
        checkedAt: Date.now(),
        readings: [
          {
            label: '5h',
            usedPercent: 100,
            resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
        ],
      },
      attempt,
    ),
  ).toBe(true)
  const vaultRows = f.consumer.routingRows()
  expect(vaultRows.find((row) => row.id === id)?.quota).toBeDefined()
  const local: RoutingRow = { id: 'local-key', kind: 'api-key' }
  const pulls: string[] = []
  const result = admit({
    rows: [local, ...vaultRows],
    requiredLabels: ['5h'],
    now: Date.now(),
    requestPull: (rowId) => pulls.push(rowId),
  })
  expect(result.admitted.map((row) => row.id)).toEqual(['local-key'])
  expect(
    result.refused.map((refusal) => [
      refusal.id,
      'reason' in refusal && refusal.reason,
    ]),
  ).toEqual([
    [f.route(roster, 'oauth:test'), 'needs-first-reading'],
    [id, 'exhausted'],
  ])
  expect(pulls).toEqual([f.route(roster, 'oauth:test')])
})
