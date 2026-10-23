// ClaustrumDiscoveryHub: one vault connection, one watch and one list per
// refresh for several provider consumers, each with its own roster. Every
// test here runs in one process against a fake vault client.
import { expect, spyOn } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ScopedInventoryRow } from '@cortexkit/claustrum-client'
import {
  acceptVaultRoute,
  type ClassifyingClaustrumFamily,
  ClaustrumConsumer,
  type ClaustrumConsumerOptions,
  ClaustrumDiscoveryHub,
  type ClaustrumDiscoveryHubOptions,
  type ClaustrumHubMemberOptions,
  type ClaustrumScopedClient,
  ClaustrumScopedCustody,
  declineVaultRoute,
  drainVaultQuota,
  readVaultRoster,
  reorderVaultRoster,
  type ScopedWatchEnd,
  type ScopedWatchNoticeShape,
  type VaultRosterFile,
} from '../../src/claustrum/index.ts'
import { acquireRefreshFileLock } from '../../src/fs/index.js'
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

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await cleanupDirs()
})

const CATEGORY = 'llm-provider'
const MEMBERS = ['alpha', 'beta', 'gamma'] as const
type Member = (typeof MEMBERS)[number]
const TICK = 5_000

/** Rows naming a member provider are its own; `openai` is refused; others are not-mine. */
const hubFamily: ClassifyingClaustrumFamily<'reserved-provider'> = {
  category: CATEGORY,
  refusalCodes: ['reserved-provider'],
  classify: (facts) => {
    const provider = facts.providerIds?.[0]
    if (provider === 'openai')
      return { kind: 'refused', code: 'reserved-provider' }
    return provider && (MEMBERS as readonly string[]).includes(provider)
      ? { kind: 'mine', member: provider }
      : { kind: 'not-mine' }
  },
}

function keyRow(provider: string, account = 'main'): ScopedInventoryRow {
  return inventoryRow({
    id: `apikey:${provider}:${account}`,
    accountId: `${provider}-${account}`,
    categories: [CATEGORY],
    credentialType: 'api_key',
    refreshAdapter: undefined,
    providerIds: [provider],
    authMethod: 'apikey',
  })
}

function offline() {
  return Object.assign(new Error('offline'), { code: 'ECONNREFUSED' })
}

interface FakeConnection {
  readonly client: ClaustrumScopedClient
  closed: boolean
}

/**
 * A vault shared by every client the test connects. Counters say how often
 * the vault was listed, watched and asked for a credential; gates park a
 * list, a credential read or a connect until the test releases it.
 */
function fakeVault(options: { watch?: boolean } = {}) {
  const vault = {
    rows: [
      ...MEMBERS.map((provider) => keyRow(provider)),
      keyRow('openai'),
      keyRow('elsewhere'),
    ] as ScopedInventoryRow[],
    view: 'v1',
    grants: undefined as number | undefined,
    watch: options.watch ?? false,
    connects: 0,
    lists: 0,
    watches: 0,
    gets: [] as string[],
    reports: [] as string[],
    connections: [] as FakeConnection[],
    /** While set, a list waits for it after counting itself. */
    listGate: undefined as Promise<void> | undefined,
    /** While set, a credential read waits for it after counting itself. */
    getGate: undefined as Promise<void> | undefined,
    /** While set, a credential read throws it. */
    getFails: undefined as (() => unknown) | undefined,
    /** While set, each connect waits on its own entry in `held`. */
    holdConnects: false,
    held: [] as Array<ReturnType<typeof deferred<void>>>,
    listeners: [] as Array<(notice: ScopedWatchNoticeShape) => void>,
    seq: 0,
    closes: () => vault.connections.filter((each) => each.closed).length,
    /** Announce the current view on every open watch. */
    notify() {
      const notice = {
        kind: 'changed',
        epoch: 'epoch-1',
        seq: ++vault.seq,
        view: vault.view,
      }
      for (const listener of vault.listeners) listener(notice)
    },
    async connect(): Promise<ClaustrumScopedClient> {
      vault.connects++
      if (vault.holdConnects) {
        const held = deferred<void>()
        vault.held.push(held)
        await held.promise
      }
      const connection: FakeConnection = {
        closed: false,
        client: {
          listScoped: async () => {
            vault.lists++
            if (vault.listGate) await vault.listGate
            const listed = { rows: vault.rows, view: vault.view }
            return vault.grants === undefined
              ? { ...listed, ...unknownGrants }
              : {
                  ...listed,
                  grants: vault.grants,
                  grantTuples: [
                    {
                      selectorKind: 'category',
                      selector: CATEGORY,
                      operation: 'read',
                    },
                  ],
                }
          },
          getScoped: async (input) => {
            vault.gets.push(input.credentialId)
            if (vault.getGate) await vault.getGate
            if (vault.getFails) throw vault.getFails()
            return {
              credentialId: input.credentialId,
              accountId: vault.rows.find((row) => row.id === input.credentialId)
                ?.accountId,
              material: `secret-${input.credentialId}`,
              recordVersion: 1,
              expiresAtMs: null,
            }
          },
          reportAuthFailureScoped: async (input) => {
            vault.reports.push(input.credentialId)
          },
          close: () => {
            connection.closed = true
          },
          ...(vault.watch && {
            watchScoped: (
              onNotice: (notice: ScopedWatchNoticeShape) => void,
            ) => {
              vault.watches++
              vault.listeners.push(onNotice)
              const closed = deferred<ScopedWatchEnd>()
              return {
                stop: () => {
                  vault.listeners = vault.listeners.filter(
                    (listener) => listener !== onNotice,
                  )
                  closed.resolve({ kind: 'stopped' })
                },
                closed: closed.promise,
              }
            },
          }),
        },
      }
      vault.connections.push(connection)
      return connection.client
    },
  }
  return vault
}

async function hubFixture(
  options: {
    watch?: boolean
    hub?: Partial<ClaustrumDiscoveryHubOptions>
  } = {},
) {
  const dir = await tempDir('claustrum-hub-')
  const tokenPath = await writeToken(dir)
  const vault = fakeVault({ watch: options.watch })
  const timers = fakeTimers()
  let active = true
  const errors: unknown[] = []
  const hub = hooks.lifetime.manage(
    new ClaustrumDiscoveryHub({
      stateDir: dir,
      hostGeneration: 'opencode2',
      members: MEMBERS,
      tokenPath,
      family: hubFamily,
      connect: () => vault.connect(),
      isCustodyActive: () => active,
      pollIntervalMs: TICK,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
      onError: (error) => errors.push(error),
      ...options.hub,
    }),
  )
  cleanups.push(() => hub.close())
  const rosters = {} as Record<Member, VaultRosterFile[]>
  const memberErrors = {} as Record<Member, unknown[]>
  const member = (
    provider: Member,
    memberOptions: ClaustrumHubMemberOptions = {},
  ) => {
    rosters[provider] = []
    memberErrors[provider] = []
    const consumer = hub.member(provider, {
      onRoster: (roster) => rosters[provider].push(roster),
      onError: (error) => memberErrors[provider].push(error),
      ...memberOptions,
    })
    cleanups.push(() => consumer.dispose())
    return consumer
  }
  const members = () => MEMBERS.map((provider) => member(provider))
  const route = (
    consumer: ClaustrumConsumer,
    provider: string,
    account = 'main',
  ) => {
    const id = consumer
      .snapshot()
      ?.rows.find(
        (row) => row.credentialId === `apikey:${provider}:${account}`,
      )?.routeId
    if (!id) throw new Error(`no route for ${provider}:${account}`)
    return id
  }
  /** Fire the hub's tick and wait until it has armed the next one. */
  const tick = async () => {
    timers.fire(TICK)
    await until(() => timers.pending().includes(TICK), 'the next hub tick')
  }
  /** Start the hub and wait for its first tick to finish. */
  const start = async () => {
    hub.start()
    await until(() => timers.pending().includes(TICK), 'the first hub tick')
  }
  return {
    dir,
    tokenPath,
    hub,
    vault,
    timers,
    errors,
    member,
    members,
    rosters,
    memberErrors,
    route,
    tick,
    start,
    setActive: (value: boolean) => {
      active = value
    },
  }
}

/** The error `run` throws; fails the test when it returns. */
function thrown(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('expected a throw')
}

/** Hold a member's roster write lock, as a slow writer elsewhere would. */
async function holdWriteLock(path: string) {
  const lock = await acquireRefreshFileLock({
    path,
    name: 'claustrum-roster-write',
    ttlMs: 10_000,
    renew: true,
  })
  if (!lock) throw new Error('could not take the roster write lock')
  cleanups.push(() => lock.release())
  return lock
}

// --- custody leases ---

test('hub leases: partial teardown keeps the shared connection until the hub releases its own lease', async () => {
  const f = await hubFixture()
  const [alpha, beta, gamma] = f.members()
  if (!alpha || !beta || !gamma) throw new Error('missing member')
  await alpha.refresh()
  await alpha.authorize(f.route(alpha, 'alpha'))
  await beta.authorize(f.route(beta, 'beta'))
  await gamma.authorize(f.route(gamma, 'gamma'))
  // The hub's own lease plus one per member.
  expect(f.hub.leaseState()).toEqual({ generation: 1, count: 4 })
  alpha.close()
  beta.close()
  const served = await gamma.authorize(f.route(gamma, 'gamma'))
  expect(served.accessToken).toBe('secret-apikey:gamma:main')
  expect(f.vault.connects).toBe(1)
  gamma.close()
  // Vault mode is on, so the hub keeps its own lease and the connection.
  expect(f.hub.leaseState()).toEqual({ generation: 1, count: 1 })
  expect(f.vault.closes()).toBe(0)
  f.hub.close()
  expect(f.vault.closes()).toBe(1)
  expect(f.vault.connections).toHaveLength(1)
})

test('hub leases: a late connect closes its client and builds no custody once its count reached zero or it was revoked', async () => {
  const f = await hubFixture()
  f.vault.holdConnects = true
  // Count back to zero: the only acquirer aborts while the connect is pending.
  const controller = new AbortController()
  const abandoned = f.hub.acquire(controller.signal)
  await until(() => f.vault.held.length === 1)
  controller.abort(new Error('caller gave up'))
  await expect(abandoned).rejects.toThrow('caller gave up')
  expect(f.hub.leaseState()).toEqual({ generation: undefined, count: 0 })
  f.vault.held[0]?.resolve()
  await until(() => f.vault.closes() === 1, 'the late client to close')
  // Revoked: vault mode goes off while the connect is pending.
  const revoked = f.hub.acquire()
  await until(() => f.vault.held.length === 2)
  f.setActive(false)
  await f.hub.refresh()
  await expect(revoked).rejects.toMatchObject({ kind: 'not-active' })
  f.vault.held[1]?.resolve()
  await until(() => f.vault.closes() === 2, 'the revoked client to close')
  // Neither late connect published a custody: the next acquire connects anew.
  f.setActive(true)
  f.vault.holdConnects = false
  await f.hub.refresh()
  const lease = await f.hub.acquire()
  expect(f.vault.connects).toBe(3)
  expect(f.vault.connections[2]?.closed).toBe(false)
  expect(f.hub.leaseState().generation).toBe(lease.generation)
})

test('hub leases: interleaved acquires and double releases never close a held client or hand out a closed one', async () => {
  const f = await hubFixture()
  const first = await f.hub.acquire()
  const [second, third] = await Promise.all([f.hub.acquire(), f.hub.acquire()])
  if (!second || !third) throw new Error('missing lease')
  expect(f.vault.connects).toBe(1)
  first.release()
  first.release()
  second.release()
  expect(f.hub.leaseState()).toEqual({ generation: 1, count: 1 })
  expect(f.vault.closes()).toBe(0)
  expect(third.custody.keptReceiptState()).toEqual({
    active: false,
    since: null,
  })
  expect(() => first.custody.keptReceiptState()).toThrow('closed')
  const fourth = await f.hub.acquire()
  expect(fourth.generation).toBe(1)
  third.release()
  third.release()
  expect(f.hub.leaseState()).toEqual({ generation: 1, count: 1 })
  expect(f.vault.closes()).toBe(0)
  fourth.release()
  // The last lease of generation 1 closes its client, exactly once.
  expect(f.vault.closes()).toBe(1)
  expect(() => fourth.custody.keptReceiptState()).toThrow('closed')
  const fifth = await f.hub.acquire()
  expect(fifth.generation).toBe(2)
  expect(f.vault.connects).toBe(2)
  expect(f.vault.connections[1]?.closed).toBe(false)
  fifth.release()
  fifth.release()
  expect(f.vault.closes()).toBe(2)
})

test('hub leases: an abort during connect gives its ticket back and leaves the other waiter waiting', async () => {
  const f = await hubFixture()
  f.vault.holdConnects = true
  const controller = new AbortController()
  const aborted = f.hub.acquire(controller.signal)
  const waiting = f.hub.acquire()
  await until(() => f.vault.held.length === 1)
  expect(f.hub.leaseState()).toEqual({ generation: 1, count: 2 })
  controller.abort(new Error('caller gave up'))
  await expect(aborted).rejects.toThrow('caller gave up')
  expect(f.hub.leaseState()).toEqual({ generation: 1, count: 1 })
  f.vault.held[0]?.resolve()
  const lease = await waiting
  expect(lease.generation).toBe(1)
  expect(f.hub.leaseState()).toEqual({ generation: 1, count: 1 })
  expect(f.vault.connects).toBe(1)
  expect(f.vault.closes()).toBe(0)
})

test('hub leases: a rejected connect rejects every waiter, gives every ticket back and the next acquire connects anew', async () => {
  const f = await hubFixture()
  f.vault.holdConnects = true
  const waiters = [f.hub.acquire(), f.hub.acquire(), f.hub.acquire()]
  await until(() => f.vault.held.length === 1)
  expect(f.hub.leaseState()).toEqual({ generation: 1, count: 3 })
  f.vault.held[0]?.reject(new Error('vault socket refused'))
  for (const waiter of waiters)
    await expect(waiter).rejects.toThrow('vault socket refused')
  expect(f.hub.leaseState()).toEqual({ generation: undefined, count: 0 })
  f.vault.holdConnects = false
  const lease = await f.hub.acquire()
  expect(f.vault.connects).toBe(2)
  expect(lease.generation).toBe(2)
  expect(f.vault.connections[0]?.closed).toBe(false)
})

test('hub leases: a connect of an ended generation is closed unpublished and leaves the next pending connect in place', async () => {
  const f = await hubFixture()
  f.vault.holdConnects = true
  const old = f.hub.acquire()
  await until(() => f.vault.held.length === 1)
  f.setActive(false)
  await f.hub.refresh()
  await expect(old).rejects.toMatchObject({ kind: 'not-active' })
  // On again: the hub's refresh starts generation 2 and its own connect.
  f.setActive(true)
  const refreshed = f.hub.refresh()
  await until(() => f.vault.held.length === 2)
  f.vault.held[0]?.resolve()
  await until(() => f.vault.closes() === 1, 'the old client to close')
  // The old connect's cleanup left generation 2's connect pending: a new
  // acquire joins it instead of connecting a third time.
  const joined = f.hub.acquire()
  expect(f.vault.connects).toBe(2)
  f.vault.held[1]?.resolve()
  await refreshed
  const lease = await joined
  expect(lease.generation).toBe(2)
  expect(f.vault.connects).toBe(2)
  expect(f.vault.connections[1]?.closed).toBe(false)
})

// --- hub-mode consumer: construction ---

test('hub members: consumers built from ClaustrumConsumerOptions still connect, list and watch on their own', async () => {
  const dir = await tempDir('claustrum-hub-plain-')
  const vault = fakeVault()
  const options: ClaustrumConsumerOptions = {
    rosterPath: join(dir, 'vault-roster.json'),
    tokenPath: await writeToken(dir),
    family,
    connect: () => vault.connect(),
    pollIntervalMs: 0,
  }
  const consumer = new ClaustrumConsumer(options)
  cleanups.push(() => consumer.dispose())
  vault.rows = [inventoryRow()]
  const roster = await consumer.refresh()
  expect(roster?.rows).toHaveLength(1)
  expect(vault.connects).toBe(1)
  expect(vault.lists).toBe(1)
  // A member's options carry nothing the hub owns.
  const memberOptions: ClaustrumHubMemberOptions = {
    routePrefix: 'vault:',
    // @ts-expect-error The hub owns every member's roster path.
    rosterPath: options.rosterPath,
  }
  expect(memberOptions.routePrefix).toBe('vault:')
})

test('hub members: the factory refuses an unknown provider, a second member and an insula option', async () => {
  const f = await hubFixture()
  expect(thrown(() => f.hub.member('delta', {}))).toMatchObject({
    kind: 'wrong-consumer',
  })
  expect(thrown(() => f.hub.rosterPath('delta'))).toMatchObject({
    kind: 'wrong-consumer',
  })
  f.member('alpha')
  expect(thrown(() => f.hub.member('alpha', {}))).toMatchObject({
    kind: 'wrong-consumer',
  })
  const withInsula = {
    insula: { provider: 'beta', normalize: () => undefined },
  } as unknown as ClaustrumHubMemberOptions
  expect(thrown(() => f.hub.member('beta', withInsula))).toMatchObject({
    kind: 'wrong-consumer',
  })
})

test('hub members: the quota writer, the authorize re-read and the committed file all use the hub roster path', async () => {
  const f = await hubFixture()
  const alpha = f.member('alpha')
  const path = f.hub.rosterPath('alpha')
  expect(path).toBe(join(f.dir, 'rosters', 'opencode2', 'alpha.json'))
  await alpha.refresh()
  const id = f.route(alpha, 'alpha')
  expect((await readVaultRoster(path))?.rows.map((row) => row.routeId)).toEqual(
    [id],
  )
  expect(
    await alpha.recordAccountQuota(id, 'alpha-main', {
      checkedAt: 100,
      readings: [{ label: 'primary', usedPercent: 20 }],
    }),
  ).toBe(true)
  await drainVaultQuota(path)
  expect(
    (await readVaultRoster(path))?.rows[0]?.quota?.limits[0],
  ).toMatchObject({ checkedAt: 100, usedPercent: 20 })
  // Declined in the file only: authorize re-reads that same file.
  await declineVaultRoute(path, id)
  await expect(alpha.authorize(id)).rejects.toMatchObject({
    kind: 'route-declined',
  })
  expect(f.vault.gets).toEqual([])
})

// --- hub-mode consumer: behaviour ---

test('hub members: a committed row is authorizable at once because the push lands before refresh resolves', async () => {
  const f = await hubFixture()
  const [alpha, beta] = f.members()
  if (!alpha || !beta) throw new Error('missing member')
  await alpha.refresh()
  // One hub refresh committed and pushed every member, beta included.
  expect(beta.snapshot()?.view).toBe('v1')
  const served = await beta.authorize(f.route(beta, 'beta'))
  expect(served.accessToken).toBe('secret-apikey:beta:main')
  f.vault.rows.push(keyRow('beta', 'second'))
  f.vault.view = 'v2'
  await alpha.refresh()
  const second = await beta.authorize(f.route(beta, 'beta', 'second'))
  expect(second.credentialId).toBe('apikey:beta:second')
  expect(f.vault.lists).toBe(2)
})

test('hub members: onRoster fires once per member per view change', async () => {
  const f = await hubFixture()
  const [alpha, beta, gamma] = f.members()
  if (!alpha || !beta || !gamma) throw new Error('missing member')
  await alpha.refresh()
  await beta.refresh()
  await f.hub.refresh()
  for (const provider of MEMBERS)
    expect(f.rosters[provider].map((roster) => roster.view)).toEqual(['v1'])
  f.vault.view = 'v2'
  await gamma.refresh()
  await gamma.refresh()
  for (const provider of MEMBERS)
    expect(f.rosters[provider].map((roster) => roster.view)).toEqual([
      'v1',
      'v2',
    ])
})

test('hub members: watchState follows the hub watch', async () => {
  const f = await hubFixture({ watch: true })
  const [alpha, beta] = f.members()
  if (!alpha || !beta) throw new Error('missing member')
  expect(alpha.watchState()).toEqual({ vault: 'polling' })
  await f.start()
  await until(() => f.vault.watches === 1, 'the hub watch')
  f.vault.notify()
  await until(() => f.hub.watchState() === 'watching', 'the watch to open')
  expect(alpha.watchState()).toEqual({ vault: 'watching' })
  expect(beta.watchState()).toEqual({ vault: 'watching' })
  const fallback = await hubFixture()
  const member = fallback.member('alpha')
  await fallback.start()
  expect(fallback.hub.watchState()).toBe('fallback')
  expect(member.watchState()).toEqual({ vault: 'fallback' })
})

test('hub members: a post-401 refresh costs one list for every member and pushes each roster', async () => {
  const f = await hubFixture()
  const [alpha, beta, gamma] = f.members()
  if (!alpha || !beta || !gamma) throw new Error('missing member')
  await alpha.refresh()
  expect(f.vault.lists).toBe(1)
  const response = await alpha.send(
    f.route(alpha, 'alpha'),
    async () => {
      // The vault drops the rejected key once the 401 is reported.
      f.vault.rows = f.vault.rows.filter(
        (row) => row.id !== 'apikey:alpha:main',
      )
      f.vault.view = 'v2'
      return new Response(null, { status: 401 })
    },
    { site: 'model' },
  )
  expect(response.status).toBe(401)
  expect(f.vault.reports).toEqual(['apikey:alpha:main'])
  await until(() => gamma.snapshot()?.view === 'v2', 'the post-401 refresh')
  expect(alpha.snapshot()?.rows).toEqual([])
  expect(beta.snapshot()?.view).toBe('v2')
  expect(gamma.snapshot()?.view).toBe('v2')
  expect(f.vault.lists).toBe(2)
})

test('hub members: keptReceiptState of a member holding no lease shows the shared custody', async () => {
  const f = await hubFixture()
  const [alpha, beta] = f.members()
  if (!alpha || !beta) throw new Error('missing member')
  await alpha.refresh()
  await alpha.authorize(f.route(alpha, 'alpha'))
  f.vault.getFails = offline
  const kept = await alpha.authorize(f.route(alpha, 'alpha'))
  expect(kept.fromKeptReceipt).toBe(true)
  const state = alpha.keptReceiptState()
  expect(state.active).toBe(true)
  // Beta never authorized, so it holds no lease of its own.
  expect(beta.keptReceiptState()).toEqual(state)
  expect(f.hub.keptReceiptState()).toEqual(state)
})

test('hub members: reportFailure goes only through the lease that issued the receipt', async () => {
  const f = await hubFixture()
  const [alpha, beta] = f.members()
  if (!alpha || !beta) throw new Error('missing member')
  await alpha.refresh()
  const id = f.route(alpha, 'alpha')
  const attempt = await alpha.authorize(id)
  await alpha.reportFailure(attempt, 401, 'direct')
  expect(f.vault.reports).toEqual(['apikey:alpha:main'])
  // No lease of beta issued it.
  await expect(
    beta.reportFailure(attempt, 401, 'direct'),
  ).rejects.toMatchObject({ kind: 'no-receipt' })
  const old = await alpha.authorize(id)
  f.setActive(false)
  await f.hub.refresh()
  f.setActive(true)
  await alpha.refresh()
  await alpha.authorize(f.route(alpha, 'alpha'))
  // Generation 1 ended, so its receipt is never reported, not even through
  // the lease alpha now holds in generation 2.
  await expect(alpha.reportFailure(old, 401, 'direct')).rejects.toMatchObject({
    kind: 'closed',
  })
  expect(f.vault.reports).toEqual(['apikey:alpha:main'])
})

test('hub members: one member failing its first commit stays local', async () => {
  const f = await hubFixture()
  // A directory where beta's roster file belongs: every beta commit throws.
  await mkdir(f.hub.rosterPath('beta'), { recursive: true })
  const [alpha, beta, gamma] = f.members()
  if (!alpha || !beta || !gamma) throw new Error('missing member')
  const [first, second, third] = await Promise.allSettled([
    alpha.refresh(),
    beta.refresh(),
    gamma.refresh(),
  ])
  expect(first?.status).toBe('fulfilled')
  expect(second?.status).toBe('rejected')
  expect(third?.status).toBe('fulfilled')
  expect(f.vault.lists).toBe(1)
  await alpha.authorize(f.route(alpha, 'alpha'))
  await gamma.authorize(f.route(gamma, 'gamma'))
  await expect(beta.authorize('vault:any')).rejects.toMatchObject({
    kind: 'route-unavailable',
  })
  // Nothing shared was torn down: same connection, same leases, and alpha's
  // kept receipt still serves through an outage.
  expect(f.vault.closes()).toBe(0)
  expect(f.vault.connects).toBe(1)
  expect(f.hub.leaseState()).toEqual({ generation: 1, count: 3 })
  f.vault.getFails = offline
  const kept = await alpha.authorize(f.route(alpha, 'alpha'))
  expect(kept.fromKeptReceipt).toBe(true)
  expect(gamma.snapshot()?.view).toBe('v1')
})

// --- authority: vault mode off, and on again ---

test('hub authority: vault mode off revokes every lease, closes the client once and resets every member; on again starts a new generation', async () => {
  const f = await hubFixture({ watch: true })
  const [alpha, beta, gamma] = f.members()
  if (!alpha || !beta || !gamma) throw new Error('missing member')
  await f.start()
  await until(() => f.vault.watches === 1, 'the first watch')
  const id = f.route(alpha, 'alpha')
  await alpha.authorize(id)
  await beta.authorize(f.route(beta, 'beta'))
  const direct = await f.hub.acquire()
  expect(f.hub.refusals()?.view).toBe('v1')
  f.setActive(false)
  await f.tick()
  // Every lease is revoked, the client closed once, every member reset.
  expect(() => direct.custody.keptReceiptState()).toThrow('closed')
  expect(f.vault.closes()).toBe(1)
  expect(f.hub.leaseState()).toEqual({ generation: undefined, count: 0 })
  for (const consumer of [alpha, beta, gamma])
    expect(consumer.snapshot()).toBeUndefined()
  expect(f.hub.refusals()).toBeUndefined()
  expect(f.hub.grantReach()).toBeUndefined()
  expect(f.hub.keptReceiptState()).toEqual({ active: false, since: null })
  await expect(alpha.authorize(id)).rejects.toMatchObject({
    kind: 'not-active',
  })
  // Later ticks make no vault call at all.
  const calls = {
    connects: f.vault.connects,
    lists: f.vault.lists,
    gets: f.vault.gets.length,
  }
  await f.tick()
  await f.tick()
  expect({
    connects: f.vault.connects,
    lists: f.vault.lists,
    gets: f.vault.gets.length,
  }).toEqual(calls)
  expect(f.vault.closes()).toBe(1)
  // On again: a new client, one list, the push and a new watch.
  f.setActive(true)
  await f.tick()
  expect(f.vault.connects).toBe(2)
  expect(f.vault.lists).toBe(calls.lists + 1)
  expect(alpha.snapshot()?.view).toBe('v1')
  await until(() => f.vault.watches === 2, 'the new watch')
  const served = await alpha.authorize(id)
  expect(served.accessToken).toBe('secret-apikey:alpha:main')
  expect(f.hub.leaseState().generation).toBe(2)
  expect(f.vault.closes()).toBe(1)
})

// --- generation fencing of work in flight ---

test('hub generations: a list in flight when vault mode goes off yields no inventory', async () => {
  const f = await hubFixture()
  const [alpha, beta] = f.members()
  if (!alpha || !beta) throw new Error('missing member')
  await alpha.refresh()
  const gate = deferred<void>()
  hooks.lifetime.unpark(() => gate.resolve())
  f.vault.listGate = gate.promise
  f.vault.view = 'v2'
  const pending = alpha.refresh()
  await until(() => f.vault.lists === 2, 'the second list')
  f.setActive(false)
  await expect(beta.authorize(f.route(beta, 'beta'))).rejects.toMatchObject({
    kind: 'not-active',
  })
  expect(await pending).toBeUndefined()
  gate.resolve()
  f.vault.listGate = undefined
  expect(alpha.snapshot()).toBeUndefined()
  expect(f.rosters.alpha.map((roster) => roster.view)).toEqual(['v1'])
  expect((await readVaultRoster(f.hub.rosterPath('alpha')))?.view).toBe('v1')
})

test('hub generations: a fan-out whose list returned before vault mode went off writes, pushes and retains nothing', async () => {
  const f = await hubFixture()
  const [alpha, beta] = f.members()
  if (!alpha || !beta) throw new Error('missing member')
  await alpha.refresh()
  const lock = await holdWriteLock(f.hub.rosterPath('alpha'))
  f.vault.view = 'v2'
  const pending = alpha.refresh()
  await until(() => f.vault.lists === 2, 'the second list')
  f.setActive(false)
  await expect(beta.authorize(f.route(beta, 'beta'))).rejects.toMatchObject({
    kind: 'not-active',
  })
  const retain = spyOn(ClaustrumScopedCustody.prototype, 'retain')
  try {
    await lock.release()
    expect(await pending).toBeUndefined()
    expect(retain).not.toHaveBeenCalled()
  } finally {
    retain.mockRestore()
  }
  for (const provider of MEMBERS) {
    expect((await readVaultRoster(f.hub.rosterPath(provider)))?.view).toBe('v1')
    expect(f.rosters[provider].map((roster) => roster.view)).toEqual(['v1'])
  }
  expect(alpha.snapshot()).toBeUndefined()
  expect(f.hub.refusals()).toBeUndefined()
})

test('hub generations: off then on publishes nothing of the old generation fan-out', async () => {
  const f = await hubFixture()
  const [alpha, beta] = f.members()
  if (!alpha || !beta) throw new Error('missing member')
  await alpha.refresh()
  const lock = await holdWriteLock(f.hub.rosterPath('alpha'))
  f.vault.view = 'v2'
  const old = alpha.refresh()
  await until(() => f.vault.lists === 2, 'the old generation list')
  f.setActive(false)
  await expect(beta.authorize(f.route(beta, 'beta'))).rejects.toMatchObject({
    kind: 'not-active',
  })
  // On again: generation 2 connects and lists, held at its list.
  f.setActive(true)
  const gate = deferred<void>()
  hooks.lifetime.unpark(() => gate.resolve())
  f.vault.listGate = gate.promise
  f.vault.view = 'v3'
  const current = f.hub.refresh()
  await until(() => f.vault.lists === 3, 'the new generation list')
  // The old fan-out now finishes during generation 2.
  await lock.release()
  expect(await old).toBeUndefined()
  expect((await readVaultRoster(f.hub.rosterPath('alpha')))?.view).toBe('v1')
  expect(alpha.snapshot()).toBeUndefined()
  gate.resolve()
  f.vault.listGate = undefined
  await current
  for (const provider of MEMBERS)
    expect((await readVaultRoster(f.hub.rosterPath(provider)))?.view).toBe('v3')
  expect(f.rosters.alpha.map((roster) => roster.view)).toEqual(['v1', 'v3'])
  expect(alpha.snapshot()?.view).toBe('v3')
  expect(f.hub.refusals()?.view).toBe('v3')
})

test('hub generations: an authorize waiting on get_scoped when vault mode goes off rejects not-active', async () => {
  const f = await hubFixture()
  const [alpha, beta] = f.members()
  if (!alpha || !beta) throw new Error('missing member')
  await alpha.refresh()
  const gate = deferred<void>()
  hooks.lifetime.unpark(() => gate.resolve())
  f.vault.getGate = gate.promise
  const settled = (pending: Promise<unknown>) =>
    pending.then(
      () => 'resolved',
      (error: unknown) => error,
    )
  const pending = settled(alpha.authorize(f.route(alpha, 'alpha')))
  const lease = await f.hub.acquire()
  const direct = settled(
    lease.custody.authorize({
      credentialId: 'apikey:gamma:main',
      credentialType: 'api_key',
      accountIdentity: 'gamma-main',
    }),
  )
  await until(() => f.vault.gets.length === 2, 'both credential reads')
  f.setActive(false)
  await expect(beta.authorize(f.route(beta, 'beta'))).rejects.toMatchObject({
    kind: 'not-active',
  })
  // Custody answers closed; the member, seeing vault mode off, not-active.
  expect(await direct).toMatchObject({ kind: 'closed' })
  expect(await pending).toMatchObject({ kind: 'not-active' })
  gate.resolve()
  f.vault.getGate = undefined
})

// --- install versus notify (one process) ---

test('hub install: same-view file changes reach routing within one tick without onRoster, and a view change notifies once', async () => {
  const f = await hubFixture({ watch: true })
  f.vault.rows.push(keyRow('alpha', 'second'))
  const alpha = f.member('alpha')
  await f.start()
  await until(() => f.vault.watches === 1, 'the watch')
  f.vault.notify()
  await until(() => f.hub.watchState() === 'watching', 'the watch to open')
  const lists = f.vault.lists
  const path = f.hub.rosterPath('alpha')
  const main = f.route(alpha, 'alpha')
  const second = f.route(alpha, 'alpha', 'second')
  expect(alpha.routingRows().map((row) => row.id)).toEqual([main, second])
  // Another writer reorders, declines and accepts under the same view; each
  // reaches this process on the next tick, which lists nothing.
  await reorderVaultRoster(path, [second, main])
  await f.tick()
  expect(alpha.routingRows().map((row) => row.id)).toEqual([second, main])
  await declineVaultRoute(path, second)
  await f.tick()
  expect(alpha.routingRows().map((row) => row.id)).toEqual([main])
  expect(alpha.snapshot()?.rows[0]?.enabled).toBe(false)
  await expect(alpha.authorize(second)).rejects.toMatchObject({
    kind: 'route-declined',
  })
  await acceptVaultRoute(path, second)
  await f.tick()
  expect(alpha.routingRows().map((row) => row.id)).toEqual([second, main])
  expect(f.vault.lists).toBe(lists)
  expect(f.rosters.alpha.map((roster) => roster.view)).toEqual(['v1'])
  // A view change lists once and notifies once.
  f.vault.rows.push(keyRow('alpha', 'third'))
  f.vault.view = 'v2'
  f.vault.notify()
  await until(() => alpha.snapshot()?.view === 'v2', 'the watched change')
  await f.tick()
  expect(f.vault.lists).toBe(lists + 1)
  expect(f.rosters.alpha.map((roster) => roster.view)).toEqual(['v1', 'v2'])
})

// --- cost ---

test('hub cost: one watch and one list per refresh for N members, against N plain consumers, in fallback and watching', async () => {
  const n = MEMBERS.length
  // N plain consumers: each connects, lists and watches for itself.
  const plainDir = await tempDir('claustrum-hub-plain-cost-')
  const plainVault = fakeVault({ watch: true })
  plainVault.rows = [inventoryRow()]
  const plainTimers = fakeTimers()
  const plain = await Promise.all(
    MEMBERS.map(async (provider) => {
      const consumer = new ClaustrumConsumer({
        rosterPath: join(plainDir, `${provider}.json`),
        tokenPath: await writeToken(plainDir),
        family,
        connect: () => plainVault.connect(),
        pollIntervalMs: TICK,
        ...plainTimers,
      })
      cleanups.push(() => consumer.dispose())
      return consumer
    }),
  )
  for (const consumer of plain) consumer.start()
  await until(() => plainVault.watches === n, 'every plain watch')
  expect(plainVault.lists).toBe(n)
  plainVault.view = 'v2'
  plainVault.notify()
  await until(() => plainVault.lists === 2 * n, 'every plain list')

  // Fallback: the hub lists once per tick for all N members, and watches nothing.
  const fallback = await hubFixture()
  fallback.members()
  await fallback.start()
  expect(fallback.vault.lists).toBe(1)
  for (let round = 2; round <= 4; round++) {
    await fallback.tick()
    expect(fallback.vault.lists).toBe(round)
  }
  expect(fallback.vault.watches).toBe(0)
  expect(fallback.hub.watchState()).toBe('fallback')

  // Watching: one watch, and one list per change notice for all N members.
  const watching = await hubFixture({ watch: true })
  const members = watching.members()
  await watching.start()
  await until(() => watching.vault.watches === 1, 'the hub watch')
  watching.vault.notify()
  await until(() => watching.hub.watchState() === 'watching', 'watching')
  expect(watching.vault.lists).toBe(1)
  await watching.tick()
  await watching.tick()
  expect(watching.vault.lists).toBe(1)
  watching.vault.view = 'v2'
  watching.vault.notify()
  await until(
    () => members.every((member) => member.snapshot()?.view === 'v2'),
    'every member to see v2',
  )
  expect(watching.vault.lists).toBe(2)
  expect(watching.vault.watches).toBe(1)
  expect(watching.vault.connects).toBe(1)
  console.log(
    `cost for ${n} members: plain consumers ${plainVault.lists / 2} lists and ${plainVault.watches} watches per change; hub 1 list per tick in fallback, 1 list per change and ${watching.vault.watches} watch while watching`,
  )
})

test('hub cost: retain takes the union, so one member kept receipt survives another member refresh and decline', async () => {
  const f = await hubFixture()
  f.vault.rows.push(keyRow('beta', 'second'))
  const [alpha, beta] = f.members()
  if (!alpha || !beta) throw new Error('missing member')
  await alpha.refresh()
  await alpha.authorize(f.route(alpha, 'alpha'))
  await beta.refresh()
  await beta.decline(f.route(beta, 'beta', 'second'))
  f.vault.getFails = offline
  const kept = await alpha.authorize(f.route(alpha, 'alpha'))
  expect(kept.fromKeptReceipt).toBe(true)
  expect(kept.credentialId).toBe('apikey:alpha:main')
})

test('hub accessors: refusals and grant reach follow the committed view', async () => {
  const f = await hubFixture()
  f.vault.grants = 1
  const [alpha, beta] = f.members()
  if (!alpha || !beta) throw new Error('missing member')
  expect(f.hub.refusals()).toBeUndefined()
  expect(f.hub.grantReach()).toBeUndefined()
  await alpha.refresh()
  const reach = {
    grants: 1,
    tuples: [
      { selectorKind: 'category', selector: CATEGORY, operation: 'read' },
    ],
  }
  expect(f.hub.refusals()).toEqual({
    view: 'v1',
    refused: [
      { credentialId: 'apikey:openai:main', code: 'reserved-provider' },
    ],
    notMine: 1,
  })
  expect(f.hub.grantReach()).toEqual(reach)
  expect(alpha.grantReach()).toEqual(reach)
  // Beta cannot commit v2, so the committed view stays v1: the hub keeps the
  // v1 summary, and alpha, now on v2, no longer matches it.
  await rm(f.hub.rosterPath('beta'))
  await mkdir(f.hub.rosterPath('beta'))
  f.vault.view = 'v2'
  await expect(beta.refresh()).rejects.toBeDefined()
  expect(alpha.snapshot()?.view).toBe('v2')
  expect(f.hub.refusals()?.view).toBe('v1')
  expect(alpha.grantReach()).toBeUndefined()
  expect(beta.grantReach()).toEqual(reach)
})
