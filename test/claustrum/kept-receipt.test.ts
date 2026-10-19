import { expect } from 'bun:test'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SubcClient } from '@cortexkit/subc-client'
import {
  ClaustrumConsumer,
  type ClaustrumConsumerOptions,
  type ClaustrumScopedAttempt,
  type ClaustrumScopedClient,
  ClaustrumScopedCustody,
  ClaustrumUnreachableError,
  connectClaustrumScopedClient,
  declineVaultRoute,
  mutateVaultRoster,
} from '../../src/claustrum/index.ts'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import {
  captureLogger,
  cleanupDirs,
  family,
  tempDir,
  writeToken,
} from './helpers.ts'
import {
  type MockCredential,
  type MockDaemon,
  startMockDaemon,
} from './mock-daemon.ts'

const hooks = lifetimeHooks()
const { afterEach, test } = hooks
const daemons: MockDaemon[] = []
afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await cleanupDirs()
})

const ID = 'oauth:test:work'
const SECRET = 'unique-kept-bearer-do-not-persist'
const HOUR = 3_600_000

async function scenario(apiKey = false) {
  const dir = await tempDir('claustrum-kept-')
  let now = Date.now()
  let active = true
  const record: MockCredential = {
    payload: SECRET,
    account_id: 'private-account-identity',
    project_id: 'served-project',
    record_version: 7,
    expires_at_ms: apiKey ? null : now + HOUR,
    ...(apiKey && { type: 'api_key', refresh_adapter: null }),
  }
  const start = async () => {
    const daemon = await startMockDaemon({
      directory: dir,
      credentials: { [ID]: record },
    })
    daemons.push(daemon)
    return daemon
  }
  const daemon = await start()
  const logs = captureLogger()
  const options: ClaustrumConsumerOptions = {
    rosterPath: join(dir, 'vault-roster.json'),
    tokenPath: await writeToken(dir),
    family: { ...family, apiKeys: true },
    connect: () =>
      connectClaustrumScopedClient({
        connectionFile: daemon.connectionFile,
        // Reconnect attempts still run against the real socket; only backoff sleeps are virtual.
        connector: (options) =>
          SubcClient.connect({ ...options, sleep: async () => {} }),
        identity: { project_root: dir, harness: 'test', session: 'kept' },
        logger: () => {},
      }),
    logger: logs.logger,
    now: () => now,
    isCustodyActive: () => active,
    pollIntervalMs: 0,
  }
  const consumer = hooks.lifetime.manage(new ClaustrumConsumer(options))
  await consumer.refresh()
  const route = consumer.snapshot()?.rows[0]?.routeId
  if (!route) throw new Error('missing vault route')
  const sends: ClaustrumScopedAttempt[] = []
  const send = () =>
    consumer.send(
      route,
      async (receipt) => {
        sends.push(receipt)
        return new Response('ok')
      },
      { site: 'model' },
    )
  const warm = async () => {
    await send()
    record.refuse = 'unavailable'
    await send()
    expect(sends.at(-1)?.accessToken).toBe(SECRET)
    delete record.refuse
    // A successful listing ends the outage before testing fresh-call fences.
    await consumer.refresh()
  }
  return {
    dir,
    record,
    daemon,
    start,
    logs,
    options,
    consumer,
    route,
    send,
    sends,
    warm,
    advance: (ms: number) => {
      now += ms
    },
    setActive: (value: boolean) => {
      active = value
    },
    now: () => now,
  }
}

test('kept receipt survives a stopped daemon and recovers fresh without changing outage routing', async () => {
  const s = await scenario()
  await s.send()
  const roster = s.consumer.snapshot()
  const routing = s.consumer.routingRows()
  await s.daemon.stop()
  await expect(s.consumer.refresh()).rejects.toBeDefined()
  expect(s.consumer.snapshot()).toEqual(roster)
  expect(s.consumer.routingRows()).toEqual(routing)
  await s.send()
  await s.send()
  expect(
    s.sends.map((r) => [r.accessToken, r.recordVersion, r.projectId]),
  ).toEqual([
    [SECRET, 7, 'served-project'],
    [SECRET, 7, 'served-project'],
    [SECRET, 7, 'served-project'],
  ])
  expect(s.sends[1]).not.toBe(s.sends[0])
  expect(s.consumer.keptReceiptState()).toEqual({
    active: true,
    since: s.now(),
  })
  s.record.payload = 'fresh-token'
  s.record.record_version = 8
  s.record.project_id = 'fresh-project'
  const restarted = await s.start()
  await s.consumer.refresh()
  await s.send()
  expect(restarted.gets).toHaveLength(1)
  expect(s.sends.at(-1)?.accessToken).toBe('fresh-token')
  expect(s.sends.at(-1)?.recordVersion).toBe(8)
  expect(s.sends.at(-1)?.projectId).toBe('fresh-project')
  expect(s.consumer.keptReceiptState()).toEqual({ active: false, since: null })
  expect(s.logs.records.filter((r) => r.level === 'warn')).toEqual([
    {
      level: 'warn',
      message: 'serving kept vault receipt',
      data: { reason: 'unreachable' },
    },
  ])
  expect(s.logs.records.filter((r) => r.level === 'info')).toEqual([
    {
      level: 'info',
      message: 'vault receipt serving resumed',
      data: { reason: 'reachable' },
    },
  ])
})

const refusals = [
  'enrollment_revoked',
  'enrollment_invalid',
  'grant_denied',
  'needs_reauth',
  'not_found',
  'credential_unavailable',
  'declined',
  'disabled',
  'future_unknown_code',
]
for (const code of refusals) {
  test(`kept receipt is dropped after vault refusal ${code}`, async () => {
    const s = await scenario()
    await s.warm()
    s.record.refuse = code
    await expect(s.send()).rejects.toMatchObject({ code })
    s.record.refuse = 'unavailable'
    await expect(s.send()).rejects.toMatchObject({ code: 'unavailable' })
    expect(s.consumer.keptReceiptState()).toEqual({
      active: false,
      since: null,
    })
  })
}

test('kept OAuth receipt is bounded by expiry with a sixty second margin', async () => {
  const s = await scenario()
  await s.warm()
  s.record.refuse = 'unavailable'
  s.advance(HOUR - 60_001)
  await s.send()
  s.advance(1)
  await expect(s.send()).rejects.toMatchObject({ code: 'unavailable' })
  s.advance(60_001)
  await expect(s.send()).rejects.toMatchObject({ code: 'unavailable' })
  expect(s.consumer.keptReceiptState()).toEqual({ active: false, since: null })
})

test('kept API key without expiry stays usable during an extended outage', async () => {
  const s = await scenario(true)
  await s.warm()
  s.record.refuse = 'unavailable'
  s.advance(24 * HOUR)
  await s.send()
  expect(s.sends.at(-1)?.accessToken).toBe(SECRET)
  expect(s.sends.at(-1)?.expiresAtMs).toBeNull()
})

for (const change of [
  'removed',
  'credential',
  'identity',
  'declined',
  'turned-off',
] as const) {
  test(`kept receipt is dropped when roster is ${change}`, async () => {
    const s = await scenario()
    await s.warm()
    const original = await readFile(s.options.rosterPath, 'utf8')
    await mutateVaultRoster(s.options.rosterPath, (roster) => {
      if (!roster) throw new Error('missing roster')
      const row = roster.rows[0]
      if (!row) throw new Error('missing row')
      if (change === 'removed') roster.rows = []
      else if (change === 'credential') row.credentialId = 'replacement'
      else if (change === 'identity') row.accountIdentity = 'replacement'
      else if (change === 'declined') row.enabled = false
      else row.state = 'needs_reauth'
      return { next: roster, result: undefined }
    })
    await expect(s.send()).rejects.toBeDefined()
    // Restoring an earlier roster must not restore the token discarded when the route changed.
    await writeFile(s.options.rosterPath, original)
    s.record.refuse = 'unavailable'
    await expect(s.send()).rejects.toMatchObject({ code: 'unavailable' })
  })
}

test('kept receipt is dropped by a successful discovery removing the account', async () => {
  const s = await scenario()
  await s.warm()
  delete s.daemon.credentials[ID]
  await s.consumer.refresh()
  s.daemon.credentials[ID] = s.record
  await s.consumer.refresh()
  s.record.refuse = 'unavailable'
  await expect(s.send()).rejects.toMatchObject({ code: 'unavailable' })
})

test('kept receipt is dropped immediately on local decline', async () => {
  const s = await scenario()
  await s.warm()
  await s.consumer.decline(s.route)
  await s.consumer.accept(s.route)
  s.record.refuse = 'unavailable'
  await expect(s.send()).rejects.toMatchObject({ code: 'unavailable' })
})

test('kept receipt is dropped on disconnect even without a discovery poll', async () => {
  const s = await scenario()
  await s.warm()
  s.setActive(false)
  await expect(s.send()).rejects.toMatchObject({ kind: 'not-active' })
  s.setActive(true)
  s.record.refuse = 'unavailable'
  await expect(s.send()).rejects.toMatchObject({ code: 'unavailable' })
})

test('kept receipt is dropped when enrollment token disappears', async () => {
  const s = await scenario()
  await s.warm()
  await rm(s.options.tokenPath)
  await expect(s.send()).rejects.toBeDefined()
  await writeToken(s.dir)
  s.record.refuse = 'unavailable'
  await expect(s.send()).rejects.toMatchObject({ code: 'unavailable' })
})

test('kept receipt is dropped when served identity changes', async () => {
  const s = await scenario()
  await s.warm()
  s.record.served_account_id = 'another-account'
  await expect(s.send()).rejects.toMatchObject({ kind: 'identity-changed' })
  s.record.refuse = 'unavailable'
  await expect(s.send()).rejects.toMatchObject({ code: 'unavailable' })
})

test('kept 401 stops the account without retry or report until a fresh vault serve', async () => {
  const s = await scenario()
  await s.warm()
  s.record.refuse = 'unavailable'
  const gets = s.daemon.gets.length
  let dispatches = 0
  const response = await s.consumer.send(
    s.route,
    async () => {
      dispatches++
      return new Response(null, { status: 401 })
    },
    { site: 'model' },
  )
  expect(response.status).toBe(401)
  expect(dispatches).toBe(1)
  expect(s.daemon.gets.length - gets).toBe(1)
  expect(s.daemon.reports).toHaveLength(0)
  expect(s.logs.records).toContainEqual({
    level: 'debug',
    message: 'scoped 401 not reported',
    data: { routeId: s.route, reason: 'kept-receipt' },
  })
  await expect(s.send()).rejects.toMatchObject({ code: 'unavailable' })
  delete s.record.refuse
  await s.consumer.refresh()
  await s.send()
  s.record.refuse = 'unavailable'
  await s.send()
})

// A token the provider rejected must not come back from memory when the vault
// later goes down, whether or not the 401 report reached the vault.
for (const report of ['reported', 'report fails'] as const) {
  test(`a fresh receipt rejected with 401 is not kept for an outage (${report})`, async () => {
    const s = await scenario()
    await s.send()
    if (report === 'report fails')
      s.daemon.onReport = () => {
        void s.daemon.stop()
      }
    const response = await s.consumer
      .send(s.route, async () => new Response(null, { status: 401 }), {
        site: 'model',
      })
      .catch((error: unknown) => error)
    if (report === 'reported') {
      expect((response as Response).status).toBe(401)
      expect(s.daemon.reports).toHaveLength(1)
      s.record.refuse = 'unavailable'
    } else await s.daemon.stop()
    const before = s.sends.length
    await expect(s.send()).rejects.toBeDefined()
    expect(s.sends.length).toBe(before)
    expect(s.consumer.keptReceiptState().active).toBe(false)
  })
}

test('kept receipt never reaches logs or the state directory and is not shared with a new consumer', async () => {
  const s = await scenario()
  await s.warm()
  s.record.refuse = 'unavailable'
  await s.send()
  const peer = hooks.lifetime.manage(new ClaustrumConsumer(s.options))
  await peer.refresh()
  await expect(
    peer.send(s.route, async () => new Response('wrong'), { site: 'model' }),
  ).rejects.toMatchObject({ code: 'unavailable' })
  expect(JSON.stringify(s.consumer.keptReceiptState())).not.toContain(SECRET)
  expect(JSON.stringify(s.sends)).not.toContain(SECRET)
  const logs = JSON.stringify(s.logs.records)
  expect(logs).not.toContain(SECRET)
  expect(logs).not.toContain(s.record.account_id ?? '')
  for (const entry of await readdir(s.dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (entry.isFile()) {
      expect(
        await readFile(join(entry.parentPath, entry.name), 'utf8'),
      ).not.toContain(SECRET)
    }
  }
})

test('kept receipt discarded by another process decline cannot return after accept', async () => {
  const s = await scenario()
  await s.warm()
  await declineVaultRoute(s.options.rosterPath, s.route)
  await expect(s.send()).rejects.toMatchObject({ kind: 'route-declined' })
  await s.consumer.accept(s.route)
  s.record.refuse = 'unavailable'
  await expect(s.send()).rejects.toMatchObject({ code: 'unavailable' })
})

for (const failure of [
  'marked-connect',
  'native-connect',
  'closed-adapter',
] as const) {
  test(`injected adapter handles ${failure} without confusing shutdown with outage`, async () => {
    const s = await scenario()
    const connected = await s.options.connect()
    let connectFailure: Error | undefined
    const connect = async () => {
      if (connectFailure) throw connectFailure
      return connected
    }
    const client: ClaustrumScopedClient = {
      getScoped: async (input) => (await connect()).getScoped(input),
      listScoped: async (token) => (await connect()).listScoped(token),
      reportAuthFailureScoped: async (input) =>
        (await connect()).reportAuthFailureScoped(input),
      close: () => connected.close(),
    }
    const custody = hooks.lifetime.manage(
      new ClaustrumScopedCustody({
        client,
        family,
        tokenPath: s.options.tokenPath,
        now: s.now,
        logger: s.logs.logger,
      }),
    )
    const identity = {
      credentialId: ID,
      credentialType: 'oauth' as const,
      accountIdentity: s.record.account_id,
    }
    await custody.authorize(identity)
    connectFailure =
      failure === 'native-connect'
        ? Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' })
        : new ClaustrumUnreachableError()
    const kept = await custody.authorize(identity)
    expect(kept.accessToken).toBe(SECRET)
    expect(kept.recordVersion).toBe(7)
    if (failure === 'closed-adapter') {
      class NativeCustodyError extends Error {
        readonly kind = 'closed'
      }
      connectFailure = new NativeCustodyError('adapter closed')
      await expect(custody.discover()).rejects.toMatchObject({
        kind: 'unavailable',
      })
      await expect(custody.authorize(identity)).rejects.toMatchObject({
        kind: 'unavailable',
      })
      connectFailure = new ClaustrumUnreachableError()
      await expect(custody.authorize(identity)).rejects.toMatchObject({
        kind: 'unavailable',
      })
    }
  })
}
