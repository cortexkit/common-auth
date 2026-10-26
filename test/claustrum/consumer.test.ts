import { expect } from 'bun:test'
import { join } from 'node:path'
import type { ScopedInventoryRow } from '@cortexkit/claustrum-client'
import {
  ClaustrumConsumer,
  type ClaustrumConsumerOptions,
  type ClaustrumScopedClient,
  ClaustrumUnreachableError,
  classifyVaultFailure,
  DEFAULT_CONNECT_TIMEOUT_MS,
  declineVaultRoute,
  readVaultRoster,
  type VaultRosterFile,
} from '../../src/claustrum/index.ts'
import { acquireRefreshFileLock } from '../../src/fs/index.js'
import { admit, type RoutingRow } from '../../src/routing/index.ts'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import {
  cleanupDirs,
  deferred,
  fakeTimers,
  family,
  inventoryRow,
  tempDir,
  unknownGrants,
  until,
  writeToken,
} from './helpers.ts'

const hooks = lifetimeHooks()
const { afterEach, test } = hooks

const consumers: ClaustrumConsumer[] = []
function managedConsumer(options: ClaustrumConsumerOptions) {
  return hooks.lifetime.manage(new ClaustrumConsumer(options))
}
afterEach(async () => {
  await Promise.all(consumers.splice(0).map((consumer) => consumer.dispose()))
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
      return { rows, view: 'v', ...unknownGrants }
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
  const consumer = managedConsumer(options)
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

test('shared consumers update memory before publication and the last dispose drains', async () => {
  const f = await fixture()
  const first = await f.consumer.refresh()
  const peer = managedConsumer({
    ...f.options,
    rosterPath: `${f.dir}/./vault-roster.json`,
  })
  consumers.push(peer)
  await peer.refresh()
  const route = f.route(first, 'oauth:test')
  const attempt = await f.consumer.authorize(route)
  const lock = await acquireRefreshFileLock({
    path: f.options.rosterPath,
    name: 'claustrum-roster-write',
    ttlMs: 10_000,
    renew: true,
  })
  if (!lock) throw new Error('holder failed')
  try {
    const start = performance.now()
    // The write lock is held, so the call must not wait for it: it answers
    // after the lock-free fence read, and both consumers see the reading in
    // memory while the file does not have it yet.
    expect(
      await f.consumer.recordQuota(
        route,
        { checkedAt: 100, readings: [{ label: 'primary', usedPercent: 20 }] },
        attempt,
      ),
    ).toBe(true)
    expect(performance.now() - start).toBeLessThan(500)
    expect(
      f.consumer.routingRows().find((row) => row.id === route)?.quota
        ?.limits[0],
    ).toMatchObject({ checkedAt: 100 })
    expect(
      peer.routingRows().find((row) => row.id === route)?.quota?.limits[0],
    ).toMatchObject({ checkedAt: 100 })
    expect(
      (await readVaultRoster(f.options.rosterPath))?.rows.find(
        (row) => row.routeId === route,
      )?.quota,
    ).toBeUndefined()
    await f.consumer.dispose()
    await peer.recordAccountQuota(route, 'provider-0', {
      checkedAt: 200,
      readings: [{ label: 'primary', usedPercent: 30 }],
    })
    const draining = peer.dispose()
    await lock.release()
    await draining
    expect(
      (await readVaultRoster(f.options.rosterPath))?.rows.find(
        (row) => row.routeId === route,
      )?.quota?.limits[0],
    ).toMatchObject({ checkedAt: 200, usedPercent: 30 })
  } finally {
    await lock.release()
  }
})

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

test('a reorder reaches the next routing decision in this process without contacting the vault', async () => {
  const f = await fixture()
  const roster = await f.consumer.refresh()
  const named = f.route(roster, 'oauth:test')
  const work = f.route(roster, 'oauth:test:work')
  expect(f.consumer.routingRows().map((row) => row.id)).toEqual([named, work])
  const before = f.counts()
  expect(await f.consumer.reorder([work, named])).toEqual({
    ids: [work, named],
    outcome: 'reordered',
  })
  // No refresh ran: the order comes from the re-read roster in memory.
  expect(f.consumer.routingRows().map((row) => row.id)).toEqual([work, named])
  expect(f.consumer.snapshot()?.rows.map((row) => row.routeId)).toEqual([
    work,
    named,
  ])
  await expect(f.consumer.reorder([work])).rejects.toMatchObject({
    kind: 'invalid-order',
  })
  expect(f.consumer.routingRows().map((row) => row.id)).toEqual([work, named])
  expect(f.counts()).toEqual(before)
  expect(f.gets).toHaveLength(0)
  // The next discovery keeps the new order.
  await f.consumer.refresh()
  expect(f.consumer.routingRows().map((row) => row.id)).toEqual([work, named])
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
  hooks.lifetime.unpark(() => connection.resolve(f.client))
  const consumer = managedConsumer({
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
  const consumer = managedConsumer({
    ...f.options,
    isCustodyActive: () => active,
  })
  consumers.push(consumer)
  const id = f.route(await consumer.refresh(), 'oauth:test')
  expect(f.counts().connects).toBe(1)
  active = false
  expect(await consumer.refresh()).toBeUndefined()
  await expect(consumer.authorize(id)).rejects.toThrow('not active')
  const local = managedConsumer({
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
  const peer = managedConsumer(f.options)
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

test('cancelling as 401 reauthorization resolves rejects without reporting or refreshing', async () => {
  const f = await fixture()
  const id = f.route(await f.consumer.refresh(), 'oauth:test')
  const controller = new AbortController()
  const cancelled = new Error('caller cancelled')
  const authorize = f.consumer.authorize.bind(f.consumer)
  f.consumer.authorize = async (...args) => {
    const attempt = await authorize(...args)
    // Abort after custody has resolved, before send resumes with the receipt.
    if (f.gets.length === 2) controller.abort(cancelled)
    return attempt
  }
  const refresh = f.consumer.refresh.bind(f.consumer)
  let refreshes = 0
  f.consumer.refresh = () => {
    refreshes++
    return refresh()
  }
  let dispatches = 0
  const outcome = await f.consumer
    .send(
      id,
      async () => {
        dispatches++
        return unauthorized()
      },
      { site: 'model', signal: controller.signal },
    )
    .then(
      (response) => response,
      (error: unknown) => error,
    )
  expect(outcome).toBe(cancelled)
  expect(f.gets).toHaveLength(2)
  expect(dispatches).toBe(1)
  expect(f.reports).toEqual([])
  expect(refreshes).toBe(0)
})

test('refresh and authorize work without AbortSignal.any', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any')
  Reflect.deleteProperty(AbortSignal, 'any')
  try {
    expect('any' in AbortSignal).toBe(false)
    const f = await fixture()
    const roster = await f.consumer.refresh()
    const route = f.route(roster, 'oauth:test')
    const attempt = await f.consumer.authorize(route)
    expect(attempt.accessToken).toBe('vault-test-access')
  } finally {
    if (descriptor) Object.defineProperty(AbortSignal, 'any', descriptor)
  }
})

test('cancelling a dispatch during connection setup does not wait for or cancel shared discovery', async () => {
  const f = await fixture()
  const entered = deferred<void>()
  const connection = deferred<ClaustrumScopedClient>()
  hooks.lifetime.unpark(() => connection.resolve(f.client))
  const consumer = managedConsumer({
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
  hooks.lifetime.unpark(() => connection.resolve(f.client))
  const consumer = managedConsumer({
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
  const consumer = managedConsumer({
    ...f.options,
    connect: async () => ({
      ...f.client,
      listScoped: async () => ({ rows: f.rows, view, ...unknownGrants }),
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
  hooks.lifetime.unpark(() => release.resolve())
  let peerLists = 0
  const peer = managedConsumer({
    ...f.options,
    connect: async () => ({
      ...f.client,
      listScoped: async () => {
        peerLists++
        entered.resolve()
        await release.promise
        return { rows: f.rows, view: 'new-view', ...unknownGrants }
      },
    }),
  })
  consumers.push(peer)
  const held = peer.refresh()
  await entered.promise
  const another = managedConsumer(f.options)
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
  const unenrolled = managedConsumer({
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

test('requireAssertion applies to every authorization the consumer makes', async () => {
  const f = await fixture()
  const connect = async (): Promise<ClaustrumScopedClient> => ({
    ...f.client,
    getScoped: async (input) => {
      f.gets.push(input)
      return {
        credentialId: input.credentialId,
        material: 'vault-test-access',
        recordVersion: 3,
        expiresAtMs: Date.now() + 600_000,
      }
    },
  })
  const strict = managedConsumer({
    ...f.options,
    connect,
    requireAssertion: true,
  })
  consumers.push(strict)
  const id = f.route(await strict.refresh(), 'oauth:test')
  await expect(strict.authorize(id)).rejects.toThrow('did not assert')
  const lenient = managedConsumer({ ...f.options, connect })
  consumers.push(lenient)
  await lenient.refresh()
  expect((await lenient.authorize(id)).accountIdentitySource).toBe('expected')
  expect(f.gets).toHaveLength(2)
})

test('a credential an incomplete reply re-lists under another account is never authorized or quota-recorded under its old account', async () => {
  const f = await fixture()
  f.rows.splice(
    0,
    f.rows.length,
    inventoryRow({ id: 'oauth:test', accountId: 'account-a' }),
    inventoryRow({ id: 'oauth:test:a2', accountId: 'account-a' }),
    inventoryRow({ id: 'oauth:test:work', accountId: 'account-b' }),
  )
  const first = await f.consumer.refresh()
  const routeA = f.route(first, 'oauth:test')
  const routeB = f.route(first, 'oauth:test:work')
  // Incomplete reply: one of A's records now logs into B, the other is
  // rejected (blank identity), so A cannot be removed and stays stale.
  f.rows.splice(
    0,
    f.rows.length,
    inventoryRow({ id: 'oauth:test', accountId: 'account-b' }),
    inventoryRow({ id: 'oauth:test:a2', accountId: ' ' }),
    inventoryRow({ id: 'oauth:test:work', accountId: 'account-b' }),
  )
  const next = await f.consumer.refresh()
  expect(next?.complete).toBe(false)
  const holders = (next?.rows ?? [])
    .filter((row) =>
      [row.credentialId, ...(row.aliases ?? [])].includes('oauth:test'),
    )
    .map((row) => row.routeId)
  expect(holders).toEqual([routeB])
  expect(next?.rows.find((row) => row.routeId === routeA)).toMatchObject({
    credentialId: 'oauth:test:a2',
    accountIdentity: 'account-a',
    stale: true,
  })
  await f.consumer.authorize(routeA).catch(() => undefined)
  expect(f.gets.map((get) => get.credentialId)).toEqual(['oauth:test:a2'])
  const observation = { checkedAt: Date.now(), readings: [] }
  for (const accountIdentity of ['account-a', 'account-b'])
    expect(
      await f.consumer.recordQuota(routeA, observation, {
        credentialId: 'oauth:test',
        accountIdentity,
        expectedAccountIdentity: accountIdentity,
        accountIdentitySource: 'asserted',
      }),
    ).toBe(false)
  expect(
    f.consumer.snapshot()?.rows.find((row) => row.routeId === routeA)?.quota,
  ).toBeUndefined()
  expect(
    await f.consumer.recordQuota(routeB, observation, {
      credentialId: 'oauth:test',
      accountIdentity: 'account-b',
      expectedAccountIdentity: 'account-b',
      accountIdentitySource: 'asserted',
    }),
  ).toBe(true)
  await f.consumer.dispose()
  expect(
    (await readVaultRoster(f.options.rosterPath))?.rows.find(
      (row) => row.routeId === routeA,
    )?.quota,
  ).toBeUndefined()
})

// --- connects that never settle ---

/** A connect that is called once per attempt and never settles on its own. */
function stalledConnects(timers: ReturnType<typeof fakeTimers>) {
  const attempts: Array<{ settle: (client: ClaustrumScopedClient) => void }> =
    []
  let connects = 0
  return {
    timers,
    connect: () => {
      connects++
      return new Promise<ClaustrumScopedClient>((resolve) => {
        attempts.push({ settle: resolve })
      })
    },
    count: () => connects,
    latest: () => attempts[attempts.length - 1],
  }
}

test('a connect that never settles rejects refresh at the limit and the next refresh connects again', async () => {
  const f = await fixture()
  const timers = fakeTimers()
  const stalled = stalledConnects(timers)
  const consumer = managedConsumer({
    ...f.options,
    connect: stalled.connect,
    connectTimeoutMs: 4_000,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  })
  consumers.push(consumer)
  const first = consumer.refresh().catch((error: unknown) => error)
  const second = consumer.refresh().catch((error: unknown) => error)
  await until(() => stalled.count() === 1)
  // The deadline is armed for the configured limit, not a default.
  expect(timers.pending()).toContain(4_000)
  timers.fire(4_000)
  for (const outcome of [await first, await second]) {
    expect(outcome).toBeInstanceOf(ClaustrumUnreachableError)
    expect(classifyVaultFailure(outcome)).toBe('unreachable')
  }
  // The stall did not stay latched: a later refresh starts a fresh attempt.
  const third = consumer.refresh().catch((error: unknown) => error)
  await until(() => stalled.count() === 2)
  timers.fire(4_000)
  expect(await third).toBeInstanceOf(ClaustrumUnreachableError)
  expect(stalled.count()).toBe(2)
  expect(f.counts().lists).toBe(0)
})

test('a client that connects after the limit is closed and never installed', async () => {
  const f = await fixture()
  const timers = fakeTimers()
  const stalled = stalledConnects(timers)
  const consumer = managedConsumer({
    ...f.options,
    connect: stalled.connect,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  })
  consumers.push(consumer)
  const outcome = consumer.refresh().catch((error: unknown) => error)
  await until(() => stalled.count() === 1)
  // The default limit bounds an attempt even when none is configured.
  timers.fire(DEFAULT_CONNECT_TIMEOUT_MS)
  expect(await outcome).toBeInstanceOf(ClaustrumUnreachableError)
  stalled.latest()?.settle(f.client)
  await Promise.resolve()
  await Promise.resolve()
  expect(f.counts().closes).toBe(1)
  expect(f.counts().lists).toBe(0)
  expect(consumer.snapshot()).toBeUndefined()
  // Nothing was installed by the late client: the next refresh connects anew.
  const again = consumer.refresh().catch((error: unknown) => error)
  await until(() => stalled.count() === 2)
  timers.fire(DEFAULT_CONNECT_TIMEOUT_MS)
  expect(await again).toBeInstanceOf(ClaustrumUnreachableError)
})

test('shutdown during a pending connect rejects at once and leaves no deadline behind', async () => {
  const f = await fixture()
  const timers = fakeTimers()
  const stalled = stalledConnects(timers)
  const consumer = managedConsumer({
    ...f.options,
    connect: stalled.connect,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  })
  consumers.push(consumer)
  const outcome = consumer.refresh().catch((error: unknown) => error)
  await until(() => stalled.count() === 1)
  consumer.close()
  expect(await outcome).toMatchObject({ kind: 'closed' })
  expect(timers.pending()).toEqual([DEFAULT_CONNECT_TIMEOUT_MS])
  stalled.latest()?.settle(f.client)
  await Promise.resolve()
  await Promise.resolve()
  expect(f.counts().closes).toBe(1)
})
