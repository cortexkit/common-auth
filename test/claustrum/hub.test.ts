// ClaustrumDiscoveryHub: one vault connection, one watch and one list per
// refresh for several provider consumers, each with its own roster. Every
// test here runs in one process against a fake vault client.
import { expect, spyOn } from 'bun:test'
import {
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ScopedInventoryRow } from '@cortexkit/claustrum-client'
import * as enrollmentModule from '../../src/claustrum/enrollment.js'
import {
  acceptVaultRoute,
  type ClassifyingClaustrumFamily,
  ClaustrumConsumer,
  ClaustrumConsumerError,
  type ClaustrumConsumerOptions,
  ClaustrumDiscoveryHub,
  type ClaustrumDiscoveryHubOptions,
  type ClaustrumHubMemberOptions,
  type ClaustrumScopedClient,
  ClaustrumScopedCustody,
  ClaustrumUnreachableError,
  DEFAULT_CONNECT_TIMEOUT_MS,
  declineVaultRoute,
  drainVaultQuota,
  readVaultRoster,
  reorderVaultRoster,
  type ScopedWatchEnd,
  type ScopedWatchNoticeShape,
  type VaultRosterFile,
} from '../../src/claustrum/index.ts'
import * as rosterModule from '../../src/claustrum/roster.ts'
import { isVaultRosterLockRefusal } from '../../src/claustrum/roster.ts'
import {
  acquireRefreshFileLock,
  LockContentionError,
  LockOwnershipError,
  PrivateFileError,
  writeJsonAtomic,
} from '../../src/fs/index.js'
import * as lockModule from '../../src/fs/with-lock.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import {
  captureLogger,
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
const { afterEach } = hooks

interface PhaseTrace {
  mark(phase: string): void
  dump(): void
  events: string[]
}

const traces: PhaseTrace[] = []
const commitTraces = new Map<
  string,
  Array<{ provider: string; trace: PhaseTrace }>
>()
let restoreCommitTrace: (() => void) | undefined
let failed = false

/** Keep phase timings quiet unless the body or teardown fails. */
function test(name: string, body: () => Promise<void>, timeout?: number) {
  hooks.test(
    name,
    async () => {
      const cancelled = () => {
        failed = true
      }
      hooks.lifetime.signal.addEventListener('abort', cancelled, { once: true })
      try {
        await body()
      } catch (error) {
        failed = true
        throw error
      } finally {
        hooks.lifetime.signal.removeEventListener('abort', cancelled)
      }
    },
    timeout,
  )
}

function phaseTrace(label: string): PhaseTrace {
  const start = performance.now()
  const events: string[] = []
  const trace = {
    events,
    mark(phase: string) {
      events.push(`+${(performance.now() - start).toFixed(1)} ms ${phase}`)
    },
    dump() {
      console.error(`Hub phases (${label}):\n${events.join('\n')}`)
    },
  }
  traces.push(trace)
  return trace
}

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  const errors: unknown[] = []
  try {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup()
      } catch (error) {
        errors.push(error)
      }
    }
  } finally {
    try {
      for (const trace of traces)
        trace.mark('cleanup: remove directories begin')
      await cleanupDirs()
      for (const trace of traces) trace.mark('cleanup: remove directories done')
    } catch (error) {
      errors.push(error)
    } finally {
      restoreCommitTrace?.()
      restoreCommitTrace = undefined
      commitTraces.clear()
      failed ||= errors.length > 0
      if (failed) for (const trace of traces) trace.dump()
      traces.length = 0
      failed = false
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Hub cleanup failed')
})

const CATEGORY = 'llm-provider'
const MEMBERS = ['alpha', 'beta', 'gamma'] as const
type Member = (typeof MEMBERS)[number]
const TICK = 5_000
/** What the test plugin hands its classifier; part of the roster key. */
const CLASSIFIER_INPUT = {
  classifier: 'hub-test',
  version: 1,
  providers: [{ id: 'alpha', integration: 'openai-compatible' }],
}

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
function fakeVault(
  options: { watch?: boolean; mark?: (phase: string) => void } = {},
) {
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
    /** Observe entry before a list parks on its gate. */
    onList: undefined as (() => void) | undefined,
    /** While set, a credential read waits for it after counting itself. */
    getGate: undefined as Promise<void> | undefined,
    /** While set, a credential read throws it. */
    getFails: undefined as (() => unknown) | undefined,
    /** While set, a list throws it after counting itself. */
    listFails: undefined as (() => unknown) | undefined,
    /** While set, opening a watch throws it. */
    watchFails: undefined as (() => unknown) | undefined,
    /** One entry per watch opened; resolving it ends that watch. */
    ends: [] as Array<ReturnType<typeof deferred<ScopedWatchEnd>>>,
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
    /** End every open watch the way `end` says. */
    endWatches(end: ScopedWatchEnd) {
      vault.listeners = []
      for (const each of vault.ends.splice(0)) each.resolve(end)
    },
    async connect(): Promise<ClaustrumScopedClient> {
      vault.connects++
      options.mark?.(`connect ${vault.connects} begin`)
      if (vault.holdConnects) {
        const held = deferred<void>()
        hooks.lifetime.unpark(() => held.resolve())
        vault.held.push(held)
        await held.promise
      }
      const connection: FakeConnection = {
        closed: false,
        client: {
          listScoped: async () => {
            vault.lists++
            options.mark?.(`list ${vault.lists} begin`)
            vault.onList?.()
            if (vault.listGate) await vault.listGate
            if (vault.listFails) {
              options.mark?.(`list ${vault.lists} failed`)
              throw vault.listFails()
            }
            const listed = { rows: vault.rows, view: vault.view }
            options.mark?.(`list ${vault.lists} done`)
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
            options.mark?.('connection closed')
          },
          ...(vault.watch && {
            watchScoped: (
              onNotice: (notice: ScopedWatchNoticeShape) => void,
            ) => {
              if (vault.watchFails) throw vault.watchFails()
              vault.watches++
              vault.listeners.push(onNotice)
              const closed = deferred<ScopedWatchEnd>()
              vault.ends.push(closed)
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
      options.mark?.(`connect ${vault.connects} done`)
      return connection.client
    },
  }
  return vault
}

async function hubFixture(
  options: {
    watch?: boolean
    /** Share another fixture's state directory, as a second process would. */
    dir?: string
    hub?: Partial<ClaustrumDiscoveryHubOptions>
  } = {},
) {
  const dir = options.dir ?? (await tempDir('claustrum-hub-'))
  const trace = phaseTrace(dir)
  trace.mark('fixture: write token begin')
  const tokenPath = await writeToken(dir)
  trace.mark('fixture: write token done')
  const vault = fakeVault({ watch: options.watch, mark: trace.mark })
  const timers = fakeTimers()
  let tickArmed = deferred<void>()
  let active = true
  const errors: unknown[] = []
  const hub = hooks.lifetime.manage(
    new ClaustrumDiscoveryHub({
      stateDir: dir,
      hostGeneration: 'opencode2',
      classifierInput: CLASSIFIER_INPUT,
      members: MEMBERS,
      tokenPath,
      family: hubFamily,
      connect: () => vault.connect(),
      isCustodyActive: () => active,
      pollIntervalMs: TICK,
      setTimeoutImpl: ((run: () => void, delay: number) => {
        if (delay === TICK) {
          trace.mark('tick re-armed')
          tickArmed.resolve()
        }
        return timers.setTimeoutImpl(run, delay)
      }) as typeof setTimeout,
      clearTimeoutImpl: timers.clearTimeoutImpl,
      onError: (error) => errors.push(error),
      ...options.hub,
    }),
  )
  const consumers: Array<{ provider: Member; consumer: ClaustrumConsumer }> = []
  for (const provider of MEMBERS) {
    const path = hub.rosterPath(provider)
    const entries = commitTraces.get(path) ?? []
    entries.push({ provider, trace })
    commitTraces.set(path, entries)
  }
  if (!restoreCommitTrace) {
    const refreshRoster = rosterModule.refreshVaultRoster
    const commit = spyOn(rosterModule, 'refreshVaultRoster').mockImplementation(
      async (options) => {
        const entries = commitTraces.get(options.path) ?? []
        const mark = (phase: string) => {
          for (const { provider, trace } of entries)
            trace.mark(`member ${provider} commit ${phase}`)
        }
        mark('begin')
        try {
          const roster = await refreshRoster(options)
          mark('done')
          return roster
        } catch (error) {
          mark(`failed: ${String(error)}`)
          throw error
        }
      },
    )
    restoreCommitTrace = () => commit.mockRestore()
  }
  cleanups.push(async () => {
    trace.mark('cleanup: hub close begin')
    hub.close()
    trace.mark('cleanup: hub close done')
    try {
      const results = await Promise.allSettled(
        consumers.map(async ({ provider, consumer }) => {
          trace.mark(`cleanup: member ${provider} dispose begin`)
          await consumer.dispose()
          trace.mark(`cleanup: member ${provider} dispose done`)
        }),
      )
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      )
      if (errors.length)
        throw new AggregateError(errors, 'Member cleanup failed')
    } finally {
      trace.mark('cleanup: hub drain begin')
      await hub.dispose()
      trace.mark('cleanup: hub drain done')
    }
  })
  const rosters = {} as Record<Member, VaultRosterFile[]>
  const memberErrors = {} as Record<Member, unknown[]>
  const member = (
    provider: Member,
    memberOptions: ClaustrumHubMemberOptions = {},
  ) => {
    rosters[provider] = []
    memberErrors[provider] = []
    const consumer = hub.member(provider, {
      ...memberOptions,
      onRoster: (roster) => {
        trace.mark(`member ${provider} published: ${roster.view}`)
        if (memberOptions.onRoster) memberOptions.onRoster(roster)
        else rosters[provider].push(roster)
      },
      onError: (error) => {
        trace.mark(`member ${provider} error: ${String(error)}`)
        if (memberOptions.onError) memberOptions.onError(error)
        else memberErrors[provider].push(error)
      },
    })
    consumers.push({ provider, consumer })
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
    trace.mark('tick begin')
    tickArmed = deferred<void>()
    timers.fire(TICK)
    await waitForTick()
  }
  // The hub re-arms only after all tick work finishes. Let the test's own
  // deadline cancel this wait, rather than racing real private-file I/O with
  // a second, shorter wall-clock budget.
  const waitForTick = async () => {
    const signal = hooks.lifetime.signal
    signal.throwIfAborted()
    const cancelled = deferred<never>()
    const abort = () => cancelled.reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    try {
      await Promise.race([tickArmed.promise, cancelled.promise])
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }
  /** Start the hub and wait for its first tick to finish. */
  const start = async () => {
    trace.mark('start begin')
    tickArmed = deferred<void>()
    hub.start()
    await waitForTick()
  }
  return {
    dir,
    tokenPath,
    hub,
    vault,
    timers,
    errors,
    trace,
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

/** The fingerprint directory a hub keeps its member rosters in. */
function rosterKey(hub: ClaustrumDiscoveryHub, provider = 'alpha'): string {
  const key = basename(dirname(hub.rosterPath(provider)))
  expect(key).toMatch(/^[0-9a-f]{16}$/)
  return key
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

/** Model an authority reader whose file handle outlives synchronous close(). */
function heldAuthority(path: () => string) {
  const lifetime = hooks.lifetime
  const entered = deferred<void>()
  const release = deferred<void>()
  lifetime.unpark(() => {
    release.resolve()
    entered.resolve()
  })
  let closed = false
  return {
    entered: entered.promise.then(() => lifetime.signal.throwIfAborted()),
    release: () => release.resolve(),
    closed: () => closed,
    async read() {
      const handle = await open(path(), 'r').catch((error: unknown) => {
        entered.reject(error)
        throw error
      })
      entered.resolve()
      try {
        await release.promise
        return true
      } finally {
        await handle.close()
        closed = true
      }
    },
  }
}

test('hub fixture: first tick waits for completion beyond the socket wait budget', async () => {
  const f = await hubFixture({
    hub: {
      isCustodyActive: async () => {
        // Deliberately longer than helpers.until's socket-traffic deadline.
        await Bun.sleep(2_100)
        return false
      },
    },
  })
  await f.start()
  expect(f.timers.pending()).toEqual([TICK])
  expect(f.vault.connects).toBe(0)
}, 10_000)

test('hub fixture: phase trace includes each member commit even without a view change', async () => {
  const f = await hubFixture()
  f.members()
  await f.start()
  await f.tick()
  for (const provider of MEMBERS) {
    for (const phase of ['begin', 'done']) {
      expect(
        f.trace.events.filter((event) =>
          event.endsWith(`member ${provider} commit ${phase}`),
        ),
      ).toHaveLength(2)
    }
    expect(f.rosters[provider]).toHaveLength(1)
  }
})

test('hub disposal: joins a detached tick holding a file before directory removal', async () => {
  let tokenPath = ''
  const authority = heldAuthority(() => tokenPath)
  const f = await hubFixture({ hub: { isCustodyActive: authority.read } })
  tokenPath = f.tokenPath
  f.members()
  f.hub.start()
  await authority.entered
  f.hub.close()
  let done = false
  const disposed = f.hub.dispose().then(() => {
    done = true
  })
  try {
    await Bun.sleep(0)
    expect(done).toBe(false)
    expect(authority.closed()).toBe(false)
  } finally {
    authority.release()
    await disposed
  }
  expect(authority.closed()).toBe(true)
  expect(f.vault.connects).toBe(0)
  expect(f.timers.pending()).toEqual([])
  await rm(f.dir, { recursive: true })
})

test('hub disposal: a plain consumer joins its detached tick before directory removal', async () => {
  const dir = await tempDir('claustrum-hub-plain-disposal-')
  const tokenPath = await writeToken(dir)
  const authority = heldAuthority(() => tokenPath)
  const vault = fakeVault()
  const timers = fakeTimers()
  const consumer = new ClaustrumConsumer({
    rosterPath: join(dir, 'plain.json'),
    tokenPath,
    family,
    connect: () => vault.connect(),
    isCustodyActive: authority.read,
    ...timers,
  })
  cleanups.push(() => consumer.dispose())
  consumer.start()
  await authority.entered
  let done = false
  const disposed = consumer.dispose().then(() => {
    done = true
  })
  try {
    await Bun.sleep(0)
    expect(done).toBe(false)
    expect(authority.closed()).toBe(false)
  } finally {
    authority.release()
    await disposed
  }
  expect(authority.closed()).toBe(true)
  expect(vault.connects).toBe(0)
  expect(timers.pending()).toEqual([])
  await rm(dir, { recursive: true })
})

test('hub disposal: custody joins a watch-opening token read before directory removal', async () => {
  const dir = await tempDir('claustrum-hub-watch-disposal-')
  const tokenPath = await writeToken(dir)
  const tokenRead = heldAuthority(() => tokenPath)
  const vault = fakeVault({ watch: true })
  const custody = new ClaustrumScopedCustody({
    client: await vault.connect(),
    family,
    readToken: async () => {
      await tokenRead.read()
      return { token: '01'.repeat(32), token_generation: 1 }
    },
  })
  cleanups.push(() => custody.dispose())
  custody.watchRoster({ onView: async () => {} })
  await tokenRead.entered
  let done = false
  const disposed = custody.dispose().then(() => {
    done = true
  })
  try {
    await Bun.sleep(0)
    expect(done).toBe(false)
    expect(tokenRead.closed()).toBe(false)
  } finally {
    tokenRead.release()
    await disposed
  }
  expect(tokenRead.closed()).toBe(true)
  expect(vault.watches).toBe(0)
  expect(vault.closes()).toBe(1)
  await rm(dir, { recursive: true })
})

/** Bound the test's wait; callers release held operations in their own finally blocks. */
async function boundedDisposal(pending: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('timed out waiting for bounded disposal')),
          4_000,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

test('hub disposal deadline: a stuck connect returns and warns once with only the pending count', async () => {
  const log = captureLogger()
  const f = await hubFixture({ hub: { logger: log.logger } })
  f.vault.holdConnects = true
  const waiting = f.hub.acquire().catch((error: unknown) => error)
  await until(() => f.vault.held.length === 1, 'the held connect')
  const disposed = f.hub.dispose()
  try {
    await boundedDisposal(
      Promise.all([disposed, f.hub.dispose()]).then(() => {}),
    )
    await f.hub.dispose()
    expect(log.records.filter((record) => record.level === 'warn')).toEqual([
      {
        level: 'warn',
        message: 'claustrum shutdown drain timed out',
        data: { pendingOperations: 1 },
      },
    ])
  } finally {
    f.vault.held[0]?.resolve()
    await waiting
    await disposed
  }
  await until(() => f.vault.closes() === 1, 'the late client to close')
})

test('hub disposal deadline: a plain consumer stuck connecting returns and warns once with only the pending count', async () => {
  const dir = await tempDir('claustrum-hub-plain-deadline-')
  const tokenPath = await writeToken(dir)
  const log = captureLogger()
  const vault = fakeVault()
  vault.holdConnects = true
  const consumer = new ClaustrumConsumer({
    rosterPath: join(dir, 'plain.json'),
    tokenPath,
    family,
    connect: () => vault.connect(),
    logger: log.logger,
  })
  cleanups.push(() => consumer.dispose())
  consumer.start()
  await until(() => vault.held.length === 1, 'the held plain connect')
  const disposed = consumer.dispose()
  try {
    await boundedDisposal(
      Promise.all([disposed, consumer.dispose()]).then(() => {}),
    )
    await consumer.dispose()
    expect(log.records.filter((record) => record.level === 'warn')).toEqual([
      {
        level: 'warn',
        message: 'claustrum shutdown drain timed out',
        data: { pendingOperations: 1 },
      },
    ])
  } finally {
    vault.held[0]?.resolve()
    await disposed
  }
  await until(() => vault.closes() === 1, 'the late plain client to close')
})

test('hub disposal deadline: a custody token read that never settles returns and warns once with only the pending count', async () => {
  const log = captureLogger()
  const vault = fakeVault({ watch: true })
  const token = deferred<{ token: string; token_generation: number }>()
  hooks.lifetime.unpark(() =>
    token.resolve({ token: '01'.repeat(32), token_generation: 1 }),
  )
  const entered = deferred<void>()
  const custody = new ClaustrumScopedCustody({
    client: await vault.connect(),
    family,
    logger: log.logger,
    readToken: () => {
      entered.resolve()
      return token.promise
    },
  })
  cleanups.push(() => custody.dispose())
  custody.watchRoster({ onView: async () => {} })
  await entered.promise
  const disposed = custody.dispose()
  try {
    await boundedDisposal(
      Promise.all([disposed, custody.dispose()]).then(() => {}),
    )
    await custody.dispose()
    expect(log.records.filter((record) => record.level === 'warn')).toEqual([
      {
        level: 'warn',
        message: 'claustrum shutdown drain timed out',
        data: { pendingOperations: 1 },
      },
    ])
  } finally {
    token.resolve({ token: '01'.repeat(32), token_generation: 1 })
    await disposed
  }
  expect(vault.watches).toBe(0)
  expect(vault.closes()).toBe(1)
})

test('hub disposal cancellation: a roster write-lock wait observes shutdown before the deadline', async () => {
  const log = captureLogger()
  const f = await hubFixture({ hub: { logger: log.logger } })
  const alpha = f.member('alpha')
  await alpha.refresh()
  const path = f.hub.rosterPath('alpha')
  const lock = await holdWriteLock(path)
  const entered = deferred<void>()
  hooks.lifetime.unpark(() => entered.resolve())
  const withLock = lockModule.withLock
  const attempt = spyOn(lockModule, 'withLock').mockImplementation(
    (target, options, run) => {
      if (target === path && options.name === 'claustrum-roster-write')
        entered.resolve()
      return withLock(target, options, run)
    },
  )
  f.vault.view = 'v2'
  const refreshing = f.hub.refresh()
  try {
    await entered.promise
    const disposed = f.hub.dispose()
    await boundedDisposal(disposed)
    expect(log.records.filter((record) => record.level === 'warn')).toEqual([])
    await refreshing
    expect(alpha.snapshot()?.view).toBe('v1')
  } finally {
    await lock.release()
    await refreshing
    attempt.mockRestore()
  }
}, 15_000)

for (const owner of ['hub', 'plain consumer'] as const) {
  test(`hub disposal deadline: ${owner} shares one warning with its stuck custody read`, async () => {
    const log = captureLogger()
    const entered = deferred<void>()
    const gate = deferred<void>()
    hooks.lifetime.unpark(() => {
      gate.resolve()
      entered.resolve()
    })
    const readToken = enrollmentModule.readClaustrumEnrollmentToken
    const read = spyOn(
      enrollmentModule,
      'readClaustrumEnrollmentToken',
    ).mockImplementation(async (...args) => {
      entered.resolve()
      await gate.promise
      return readToken(...args)
    })
    let dispose: (() => Promise<void>) | undefined
    let refreshing: Promise<unknown> | undefined
    try {
      if (owner === 'hub') {
        const f = await hubFixture({ hub: { logger: log.logger } })
        f.members()
        dispose = () => f.hub.dispose()
        refreshing = f.hub.refresh().catch(() => {})
      } else {
        const dir = await tempDir('claustrum-hub-plain-token-deadline-')
        const vault = fakeVault()
        const consumer = new ClaustrumConsumer({
          rosterPath: join(dir, 'plain.json'),
          tokenPath: await writeToken(dir),
          family,
          connect: () => vault.connect(),
          logger: log.logger,
        })
        dispose = () => consumer.dispose()
        cleanups.push(dispose)
        refreshing = consumer.refresh().catch(() => {})
      }
      await entered.promise
      hooks.lifetime.signal.throwIfAborted()
      await boundedDisposal(dispose())
      expect(log.records.filter((record) => record.level === 'warn')).toEqual([
        {
          level: 'warn',
          message: 'claustrum shutdown drain timed out',
          data: { pendingOperations: 1 },
        },
      ])
    } finally {
      gate.resolve()
      await refreshing
      read.mockRestore()
    }
  }, 15_000)

  test(`hub disposal cancellation: ${owner} list wait cancels without a deadline warning`, async () => {
    const log = captureLogger()
    const entered = deferred<void>()
    const gate = deferred<void>()
    hooks.lifetime.unpark(() => {
      gate.resolve()
      entered.resolve()
    })
    let vault: ReturnType<typeof fakeVault>
    let dispose: () => Promise<void>
    if (owner === 'hub') {
      const f = await hubFixture({ hub: { logger: log.logger } })
      f.members()
      vault = f.vault
      dispose = () => f.hub.dispose()
      vault.onList = () => entered.resolve()
      vault.listGate = gate.promise
      f.hub.start()
    } else {
      const dir = await tempDir('claustrum-hub-plain-list-cancel-')
      vault = fakeVault()
      const consumer = new ClaustrumConsumer({
        rosterPath: join(dir, 'plain.json'),
        tokenPath: await writeToken(dir),
        family,
        connect: () => vault.connect(),
        logger: log.logger,
      })
      dispose = () => consumer.dispose()
      cleanups.push(dispose)
      vault.onList = () => entered.resolve()
      vault.listGate = gate.promise
      consumer.start()
    }
    try {
      await entered.promise
      hooks.lifetime.signal.throwIfAborted()
      await boundedDisposal(dispose())
      expect(log.records.filter((record) => record.level === 'warn')).toEqual(
        [],
      )
      expect(vault.closes()).toBe(1)
    } finally {
      gate.resolve()
      await dispose()
    }
  }, 15_000)
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

test('hub leases: a connect that never settles times out for every waiter and the next acquire connects anew', async () => {
  const f = await hubFixture()
  f.vault.holdConnects = true
  const waiters = [f.hub.acquire(), f.hub.acquire()]
  await until(() => f.vault.held.length === 1, 'the held connect')
  expect(f.vault.connects).toBe(1)
  // One shared connect is bounded by the default limit, not by any retry:
  // without that bound neither waiter would ever be answered.
  f.timers.fire(DEFAULT_CONNECT_TIMEOUT_MS)
  const outcomes = await Promise.race([
    Promise.all(
      waiters.map((waiter) =>
        waiter.then(
          () => 'connected',
          (error: unknown) => error,
        ),
      ),
    ),
    // Neither waiter may still be waiting when the answer is read.
    new Promise<never>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error('a lease waiter is still waiting')),
        1_000,
      ),
    ),
  ])
  for (const outcome of outcomes) {
    expect(outcome).not.toBe('connected')
    expect(outcome).toBeInstanceOf(ClaustrumUnreachableError)
  }
  expect(f.hub.leaseState()).toEqual({ generation: undefined, count: 0 })
  // The stalled attempt did not stay latched: a later acquire connects again.
  f.vault.holdConnects = false
  const recovered = await f.hub.refresh()
  expect(recovered).toBeUndefined()
  const lease = await f.hub.acquire()
  expect(f.vault.connects).toBe(2)
  expect(lease.generation).toBe(2)
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

test('hub connections: several directories in one process open one connection each, and a closed directory gives its own back', async () => {
  const stateDir = await tempDir('claustrum-hub-leak-')
  const vault = fakeVault()
  const timers = fakeTimers()
  const hubs: ClaustrumDiscoveryHub[] = []
  const tokenPaths: string[] = []
  const openHubs = async (count: number) => {
    for (let index = 0; index < count; index++) {
      tokenPaths.push(
        await writeToken(stateDir, '01'.repeat(32), `token-${index}.json`),
      )
      const hub = new ClaustrumDiscoveryHub({
        stateDir,
        hostGeneration: 'opencode2',
        classifierInput: CLASSIFIER_INPUT,
        members: MEMBERS,
        tokenPath: tokenPaths[index] as string,
        family: hubFamily,
        connect: () => vault.connect(),
        pollIntervalMs: 0,
        ...timers,
      })
      hubs.push(hub)
      cleanups.push(() => hub.dispose())
    }
  }
  // Each project directory runs its own hub: one connection per directory,
  // opened once and shared by every member of that hub.
  await openHubs(3)
  for (const hub of hubs) {
    await hub.refresh()
    const lease = await hub.acquire()
    lease.release()
  }
  expect(vault.connects).toBe(3)
  expect(vault.closes()).toBe(0)
  // In vault mode every directory keeps its connection while it serves.
  expect(vault.connects - vault.closes()).toBe(3)
  // Closing one directory gives back only that directory's connection.
  await hubs[0]?.dispose()
  hubs.shift()
  await until(() => vault.closes() === 1, 'the closed directory connection')
  expect(vault.connects - vault.closes()).toBe(2)
  await Promise.all(hubs.map((hub) => hub.dispose()))
  hubs.length = 0
  await until(() => vault.closes() === 3, 'every directory connection')
  // Nothing was left open, and nothing was opened behind this count.
  expect(vault.connects).toBe(3)
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
    reservedRouteIds: () => ['local'],
    // @ts-expect-error The hub owns every member's roster path.
    rosterPath: options.rosterPath,
  }
  expect([...(memberOptions.reservedRouteIds?.() ?? [])]).toEqual(['local'])
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
  // The route prefix is part of the roster key, so only the hub takes it.
  const withPrefix = {
    routePrefix: 'mine:',
  } as unknown as ClaustrumHubMemberOptions
  expect(thrown(() => f.hub.member('gamma', withPrefix))).toMatchObject({
    kind: 'wrong-consumer',
  })
})

test('hub members: the quota writer, the authorize re-read and the committed file all use the hub roster path', async () => {
  const f = await hubFixture()
  const alpha = f.member('alpha')
  const path = f.hub.rosterPath('alpha')
  expect(path).toBe(
    join(f.dir, 'rosters', 'opencode2', rosterKey(f.hub), 'alpha.json'),
  )
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

// --- roster keys, seeding, pending members, other processes, faults ---

type HubFixture = Awaited<ReturnType<typeof hubFixture>>

/** Start a hub with a watching vault and wait until its watch is accepted. */
async function startWatching(f: HubFixture) {
  await f.start()
  await until(() => f.vault.watches === 1, 'the hub watch')
  f.vault.notify()
  await until(() => f.hub.watchState() === 'watching', 'the watch to open')
}

/** Fire `count` hub ticks; the ticks (1-based) on which the hub listed. */
async function listingTicks(f: HubFixture, count: number) {
  const listed: number[] = []
  for (let tick = 1; tick <= count; tick++) {
    const before = f.vault.lists
    await f.tick()
    if (f.vault.lists > before) listed.push(tick)
  }
  return listed
}

/** As the test family, but `credentialId` is refused, as a newer classifier might. */
function refusing(
  credentialId: string,
): ClassifyingClaustrumFamily<'reserved-provider'> {
  return {
    ...hubFamily,
    classify: (facts) =>
      facts.credentialId === credentialId
        ? { kind: 'refused', code: 'reserved-provider' }
        : hubFamily.classify(facts),
  }
}

function refusal() {
  return Object.assign(new Error('enrollment not found'), { code: 'not_found' })
}

test('hub keys: the roster directory is the host generation plus a fingerprint of the classifier input, the member set and the projection inputs', async () => {
  const dir = await tempDir('claustrum-hub-keys-')
  const tokenPath = await writeToken(dir)
  const build = (options: Partial<ClaustrumDiscoveryHubOptions> = {}) => {
    const hub = new ClaustrumDiscoveryHub({
      stateDir: dir,
      hostGeneration: 'opencode2',
      classifierInput: CLASSIFIER_INPUT,
      members: MEMBERS,
      tokenPath,
      family: hubFamily,
      connect: () => Promise.reject(new Error('never connects')),
      ...options,
    })
    cleanups.push(() => hub.dispose())
    return hub
  }
  const hub = build()
  const key = rosterKey(hub)
  expect(dirname(dirname(hub.rosterPath('alpha')))).toBe(
    join(dir, 'rosters', 'opencode2'),
  )
  // Equal inputs give one key, whatever the order of object keys or members.
  const reordered = build({
    classifierInput: {
      providers: [{ integration: 'openai-compatible', id: 'alpha' }],
      version: 1,
      classifier: 'hub-test',
    },
    members: ['gamma', 'alpha', 'beta'],
  })
  expect(rosterKey(reordered)).toBe(key)
  // Anything the classifier or the projection could see gives another key.
  const different = [
    build({
      classifierInput: {
        ...CLASSIFIER_INPUT,
        providers: [{ id: 'alpha', integration: 'anthropic' }],
      },
    }),
    build({ members: ['alpha', 'beta'] }),
    build({ routePrefix: 'mine:' }),
    build({ mapAccount: (credential) => ({ label: credential.credentialId }) }),
  ]
  const keys = new Set([key, ...different.map((each) => rosterKey(each))])
  expect(keys.size).toBe(5)
  expect(rosterKey(build({ hostGeneration: 'pi' }))).toBe(key)
  expect(build({ hostGeneration: 'pi' }).rosterPath('alpha')).toBe(
    join(dir, 'rosters', 'pi', key, 'alpha.json'),
  )
  // An input that is not plain JSON has no stable fingerprint: refused.
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  for (const classifierInput of [
    undefined,
    { at: new Date(0) },
    { count: Number.NaN },
    { classify: () => 'mine' },
    [1, undefined],
    cycle,
  ])
    expect(thrown(() => build({ classifierInput }))).toMatchObject({
      kind: 'invalid-state',
    })
})

test('hub keys: every lock of a member roster stays inside its key directory', async () => {
  const f = await hubFixture()
  const alpha = f.member('alpha')
  await alpha.refresh()
  const path = f.hub.rosterPath('alpha')
  // Hold both of alpha's roster locks, as a commit in flight does.
  const lease = await acquireRefreshFileLock({
    path,
    name: 'claustrum-roster',
    ttlMs: 30_000,
  })
  if (!lease) throw new Error('could not take the discovery lease')
  cleanups.push(() => lease.release())
  await holdWriteLock(path)
  const entries = await readdir(join(f.dir, 'rosters'), { recursive: true })
  const key = join('opencode2', rosterKey(f.hub))
  expect(entries.length).toBeGreaterThan(3)
  for (const entry of entries)
    expect(entry === 'opencode2' || entry.startsWith(key)).toBe(true)
})

test('hub seeding: a new key starts from the older key declines and order only, writes its first file with the view unchanged, and never writes under the old key', async () => {
  const old = await hubFixture()
  old.vault.rows.push(keyRow('alpha', 'second'), keyRow('alpha', 'third'))
  const before = old.member('alpha')
  await before.refresh()
  const main = old.route(before, 'alpha')
  const second = old.route(before, 'alpha', 'second')
  const third = old.route(before, 'alpha', 'third')
  await before.reorder([second, main, third])
  await before.decline(main)
  const oldPath = old.hub.rosterPath('alpha')
  const oldDir = dirname(oldPath)
  const oldEntries = (await readdir(oldDir)).sort()
  const oldText = await readFile(oldPath, 'utf8')
  const oldModified = (await stat(oldPath)).mtimeMs
  // A newer plugin build: another classifier version, which refuses `third`.
  const next = await hubFixture({
    dir: old.dir,
    hub: {
      classifierInput: { ...CLASSIFIER_INPUT, version: 2 },
      family: refusing('apikey:alpha:third'),
    },
  })
  next.vault.rows = old.vault.rows
  const alpha = next.member('alpha')
  await alpha.refresh()
  const path = next.hub.rosterPath('alpha')
  expect(dirname(path)).not.toBe(oldDir)
  const file = await readVaultRoster(path)
  // Same vault view as the old key's last commit, and still a first file.
  expect(file?.view).toBe('v1')
  expect(
    file?.rows.map((row) => [row.credentialId, row.enabled, row.routeId]),
  ).toEqual([
    ['apikey:alpha:second', true, second],
    ['apikey:alpha:main', false, main],
  ])
  expect(file?.declined).toEqual([
    { credentialId: 'apikey:alpha:main', accountIdentity: 'alpha-main' },
  ])
  expect(alpha.routingRows().map((row) => row.id)).toEqual([second])
  // The old key's active `third` is neither in the new file nor routable.
  await expect(alpha.authorize(third)).rejects.toMatchObject({
    kind: 'route-unavailable',
  })
  expect((await readdir(oldDir)).sort()).toEqual(oldEntries)
  expect(await readFile(oldPath, 'utf8')).toBe(oldText)
  expect((await stat(oldPath)).mtimeMs).toBe(oldModified)
})

test('hub seeding: the layout before fingerprints seeds a new key too, and the newest older roster wins', async () => {
  const old = await hubFixture()
  old.vault.rows.push(keyRow('alpha', 'second'))
  const before = old.member('alpha')
  await before.refresh()
  const main = old.route(before, 'alpha')
  const second = old.route(before, 'alpha', 'second')
  await before.decline(second)
  const oldPath = old.hub.rosterPath('alpha')
  // The same roster in the layout without a fingerprint, declining `main`
  // instead, and written later.
  const file = await readVaultRoster(oldPath)
  if (!file) throw new Error('no old roster')
  const legacy = join(old.dir, 'rosters', 'opencode2', 'alpha.json')
  await writeJsonAtomic(legacy, {
    ...file,
    rows: file.rows.map((row) => ({ ...row, enabled: row.routeId !== main })),
    declined: [
      { credentialId: 'apikey:alpha:main', accountIdentity: 'alpha-main' },
    ],
  })
  const past = new Date(Date.now() - 60_000)
  await utimes(oldPath, past, past)
  const next = await hubFixture({
    dir: old.dir,
    hub: { classifierInput: { ...CLASSIFIER_INPUT, version: 2 } },
  })
  next.vault.rows = old.vault.rows
  const alpha = next.member('alpha')
  await alpha.refresh()
  expect(
    (await readVaultRoster(next.hub.rosterPath('alpha')))?.declined,
  ).toEqual([
    { credentialId: 'apikey:alpha:main', accountIdentity: 'alpha-main' },
  ])
  expect(alpha.routingRows().map((row) => row.id)).toEqual([second])
})

test('hub pending: a member whose commit failed is listed for on the next tick, with the watch watching and no notice', async () => {
  const f = await hubFixture({ watch: true })
  const [alpha, beta, gamma] = f.members()
  if (!alpha || !beta || !gamma) throw new Error('missing member')
  await startWatching(f)
  const lists = f.vault.lists
  // A directory where beta's roster file belongs: beta's commit throws.
  const path = f.hub.rosterPath('beta')
  await rm(path)
  await mkdir(path)
  f.vault.view = 'v2'
  f.vault.notify()
  await until(() => gamma.snapshot()?.view === 'v2', 'the noticed change')
  expect(f.memberErrors.beta).toHaveLength(1)
  expect(f.vault.lists).toBe(lists + 1)
  expect(alpha.snapshot()?.view).toBe('v2')
  expect(gamma.snapshot()?.view).toBe('v2')
  expect(beta.snapshot()?.view).toBe('v1')
  expect(f.hub.refusals()?.view).toBe('v1')
  expect(f.memberErrors.alpha).toEqual([])
  expect(f.memberErrors.gamma).toEqual([])
  expect(f.errors).toEqual([])
  // Beta's file is writable again; nothing announces anything.
  await rm(path, { recursive: true })
  await f.tick()
  expect(f.vault.lists).toBe(lists + 2)
  expect(beta.snapshot()?.view).toBe('v2')
  expect(f.hub.refusals()?.view).toBe('v2')
  // Committed: the next tick is quiet again.
  await f.tick()
  expect(f.vault.lists).toBe(lists + 2)
})

test('hub pending: a member that fails on every list backs off to the safety poll, and a notice still lists at once', async () => {
  const f = await hubFixture({ watch: true })
  const [alpha, , gamma] = f.members()
  if (!alpha || !gamma) throw new Error('missing member')
  await startWatching(f)
  const path = f.hub.rosterPath('beta')
  await rm(path)
  await mkdir(path)
  f.vault.view = 'v2'
  f.vault.notify()
  await until(() => gamma.snapshot()?.view === 'v2', 'the noticed change')
  expect(f.memberErrors.beta).toHaveLength(1)
  // Due on each of the next three ticks, then after 2, 4, 8 ... ticks, up
  // to the safety poll's 60 ticks of 5 s.
  expect(await listingTicks(f, 130)).toEqual([1, 2, 3, 5, 9, 17, 33, 65, 125])
  // A change notice is a reason of its own and lists at once.
  const lists = f.vault.lists
  f.vault.view = 'v3'
  f.vault.notify()
  await until(() => alpha.snapshot()?.view === 'v3', 'the noticed change')
  expect(f.vault.lists).toBe(lists + 1)
}, 20_000)

test('hub pending: a member whose discovery lease a stopped process still holds is listed for again until it commits', async () => {
  const f = await hubFixture({ watch: true })
  const [alpha, , gamma] = f.members()
  if (!alpha || !gamma) throw new Error('missing member')
  await startWatching(f)
  // A process that stopped in the middle of alpha's commit still holds its
  // discovery lease.
  const lease = await acquireRefreshFileLock({
    path: f.hub.rosterPath('alpha'),
    name: 'claustrum-roster',
    ttlMs: 30_000,
  })
  if (!lease) throw new Error('could not take the discovery lease')
  cleanups.push(() => lease.release())
  const lists = f.vault.lists
  f.vault.view = 'v2'
  f.vault.notify()
  // Gamma is the last member the hub commits, so the whole list is done.
  await until(() => gamma.snapshot()?.view === 'v2', 'the noticed change')
  // Alpha served the roster the lease holder left, not this list.
  expect(alpha.snapshot()?.view).toBe('v1')
  expect(f.memberErrors.alpha).toEqual([])
  expect(f.hub.refusals()?.view).toBe('v1')
  await f.tick()
  expect(f.vault.lists).toBe(lists + 2)
  expect(alpha.snapshot()?.view).toBe('v1')
  await lease.release()
  await f.tick()
  expect(f.vault.lists).toBe(lists + 3)
  expect(alpha.snapshot()?.view).toBe('v2')
  expect(f.hub.refusals()?.view).toBe('v2')
  await f.tick()
  expect(f.vault.lists).toBe(lists + 3)
  // Four ticks of real roster commits for three members: on a Windows runner
  // each private-file commit can take over a second, so the default 5 s limit
  // ends this test while it is still progressing, like its neighbours above.
}, 20_000)

test('hub pending: a first commit refused by another writer holding the roster is no member error and is retried', async () => {
  const f = await hubFixture()
  const [alpha, beta] = f.members()
  if (!alpha || !beta) throw new Error('missing member')
  const lease = await acquireRefreshFileLock({
    path: f.hub.rosterPath('alpha'),
    name: 'claustrum-roster',
    ttlMs: 30_000,
  })
  if (!lease) throw new Error('could not take the discovery lease')
  cleanups.push(() => lease.release())
  await f.start()
  // No roster existed to serve, so alpha's commit was refused roster-busy.
  expect(beta.snapshot()?.view).toBe('v1')
  expect(alpha.snapshot()).toBeUndefined()
  await expect(alpha.authorize('vault:any')).rejects.toMatchObject({
    kind: 'route-unavailable',
  })
  expect(f.memberErrors.alpha).toEqual([])
  expect(f.errors).toEqual([])
  await lease.release()
  await f.tick()
  expect(alpha.snapshot()?.view).toBe('v1')
  expect(f.memberErrors.alpha).toEqual([])
})

test('hub commits: a list older than another process commit never replaces it', async () => {
  const f = await hubFixture()
  const alpha = f.member('alpha')
  await alpha.refresh()
  // Another process on the same profile and key, listing its own vault.
  const peer = await hubFixture({ dir: f.dir })
  peer.vault.rows.push(keyRow('alpha', 'second'))
  peer.vault.view = 'v3'
  const peerAlpha = peer.member('alpha')
  // This process lists v2 and is held before it commits ...
  const gate = deferred<void>()
  hooks.lifetime.unpark(() => gate.resolve())
  f.vault.listGate = gate.promise
  f.vault.view = 'v2'
  const pending = alpha.refresh()
  await until(() => f.vault.lists === 2, 'the held list')
  // ... while the other process lists v3 and commits it.
  await peerAlpha.refresh()
  gate.resolve()
  f.vault.listGate = undefined
  await pending
  const path = f.hub.rosterPath('alpha')
  expect((await readVaultRoster(path))?.view).toBe('v3')
  // This process takes the newer roster and does not count it as its own.
  expect(alpha.snapshot()?.view).toBe('v3')
  expect(alpha.snapshot()?.rows).toHaveLength(2)
  expect(f.hub.refusals()?.view).toBe('v1')
  expect(f.memberErrors.alpha).toEqual([])
})

test('hub install: another process same-view preference change is installed, and its different view is listed for', async () => {
  const f = await hubFixture({ watch: true })
  f.vault.rows.push(keyRow('alpha', 'second'))
  const alpha = f.member('alpha')
  await startWatching(f)
  const peer = await hubFixture({ dir: f.dir })
  peer.vault.rows = f.vault.rows
  const peerAlpha = peer.member('alpha')
  await peerAlpha.refresh()
  const lists = f.vault.lists
  const main = f.route(alpha, 'alpha')
  const second = f.route(alpha, 'alpha', 'second')
  // The other process declines under the same view: installed, no list.
  await peerAlpha.decline(main)
  await f.tick()
  expect(alpha.routingRows().map((row) => row.id)).toEqual([second])
  await expect(alpha.authorize(main)).rejects.toMatchObject({
    kind: 'route-declined',
  })
  expect(f.vault.lists).toBe(lists)
  // The other process commits a new view this process was not told about.
  f.vault.rows.push(keyRow('alpha', 'third'))
  f.vault.view = 'v2'
  peer.vault.view = 'v2'
  await peerAlpha.refresh()
  await f.tick()
  expect(f.vault.lists).toBe(lists + 1)
  expect(alpha.snapshot()?.view).toBe('v2')
  expect(alpha.snapshot()?.rows.map((row) => row.enabled)).toEqual([
    false,
    true,
    true,
  ])
  expect(f.rosters.alpha.map((roster) => roster.view)).toEqual(['v1', 'v2'])
  await f.tick()
  expect(f.vault.lists).toBe(lists + 1)
})

test('hub install: a roster whose route id is a local row here is never installed; the hub lists and renames that route', async () => {
  const f = await hubFixture({ watch: true })
  f.vault.rows.push(keyRow('alpha', 'second'))
  const reserved = new Set<string>()
  const alpha = f.member('alpha', { reservedRouteIds: () => reserved })
  await startWatching(f)
  const lists = f.vault.lists
  const main = f.route(alpha, 'alpha')
  const second = f.route(alpha, 'alpha', 'second')
  // This process now has a local row with the id of a vault route, and
  // another writer rewrites the roster under the same view.
  reserved.add(second)
  const path = f.hub.rosterPath('alpha')
  await reorderVaultRoster(path, [second, main])
  await f.tick()
  expect(f.vault.lists).toBe(lists + 1)
  const routes = alpha.routingRows().map((row) => row.id)
  expect(routes).toHaveLength(2)
  expect(routes).not.toContain(second)
  expect(
    (await readVaultRoster(path))?.rows.map((row) => row.routeId),
  ).not.toContain(second)
})

test('hub faults: a failed list reaches the hub and every member once; a member commit error reaches only that member', async () => {
  const f = await hubFixture()
  f.members()
  await f.start()
  f.vault.listFails = refusal
  await f.tick()
  expect(f.errors).toHaveLength(1)
  for (const provider of MEMBERS)
    expect(f.memberErrors[provider]).toHaveLength(1)
  f.vault.listFails = undefined
  const path = f.hub.rosterPath('beta')
  await rm(path)
  await mkdir(path)
  await f.tick()
  expect(f.errors).toHaveLength(1)
  expect(f.memberErrors.alpha).toHaveLength(1)
  expect(f.memberErrors.gamma).toHaveLength(1)
  // The tick's re-read and beta's commit both failed on its file.
  expect(f.memberErrors.beta).toHaveLength(3)
})

test('hub faults: watch-only loss falls back to a list on every tick and keeps every kept receipt', async () => {
  const f = await hubFixture({ watch: true })
  const [alpha, beta] = f.members()
  if (!alpha || !beta) throw new Error('missing member')
  await startWatching(f)
  await alpha.authorize(f.route(alpha, 'alpha'))
  const lists = f.vault.lists
  // The watch closes and cannot be opened again; listing still works.
  f.vault.watchFails = () => new Error('watch broken')
  f.vault.endWatches({ kind: 'ended' })
  await until(() => f.hub.watchState() !== 'watching', 'the watch to close')
  f.timers.fire(1_000)
  await until(() => f.errors.length === 1, 'the watch error')
  expect(await listingTicks(f, 2)).toEqual([1, 2])
  expect(f.vault.lists).toBe(lists + 2)
  expect(f.memberErrors.alpha).toEqual([])
  expect(f.memberErrors.beta).toEqual([])
  expect(f.vault.closes()).toBe(0)
  f.vault.getFails = offline
  const kept = await alpha.authorize(f.route(alpha, 'alpha'))
  expect(kept.fromKeptReceipt).toBe(true)
})

test('hub faults: transport loss is one outage for every member, and the first answer ends it for all', async () => {
  // A clock of the test's own, so the probe's one-a-second limit is exact.
  let clock = 1_000_000
  const f = await hubFixture({ hub: { now: () => clock } })
  const [alpha, beta, gamma] = f.members()
  if (!alpha || !beta || !gamma) throw new Error('missing member')
  await f.start()
  await alpha.authorize(f.route(alpha, 'alpha'))
  f.vault.listFails = offline
  f.vault.getFails = offline
  await f.tick()
  const probes = () => f.timers.pending().filter((delay) => delay !== TICK)
  expect(probes()).toEqual([2_000])
  const kept = await alpha.authorize(f.route(alpha, 'alpha'))
  expect(kept.fromKeptReceipt).toBe(true)
  await expect(beta.authorize(f.route(beta, 'beta'))).rejects.toBeInstanceOf(
    ClaustrumUnreachableError,
  )
  expect(probes()).toHaveLength(1)
  // The vault answers again: the one probe ends the outage for everyone.
  f.vault.listFails = undefined
  f.vault.getFails = undefined
  const lists = f.vault.lists
  clock += 2_000
  f.timers.fire(probes()[0] ?? 0)
  await until(() => f.vault.lists === lists + 1, 'the probe')
  await until(() => probes().length === 0, 'the outage to end')
  const fresh = await beta.authorize(f.route(beta, 'beta'))
  expect(fresh.fromKeptReceipt).toBeUndefined()
  const again = await alpha.authorize(f.route(alpha, 'alpha'))
  expect(again.fromKeptReceipt).toBeUndefined()
  await gamma.authorize(f.route(gamma, 'gamma'))
  expect(f.vault.connects).toBe(1)
  expect(f.vault.closes()).toBe(0)
})

test('hub faults: a confirming refusal drops every kept receipt and reaches each member once, with no inactive transition', async () => {
  const f = await hubFixture({ watch: true })
  const [alpha, beta, gamma] = f.members()
  if (!alpha || !beta || !gamma) throw new Error('missing member')
  await startWatching(f)
  await alpha.authorize(f.route(alpha, 'alpha'))
  await beta.authorize(f.route(beta, 'beta'))
  const path = f.hub.rosterPath('alpha')
  const roster = await readFile(path, 'utf8')
  const lists = f.vault.lists
  // The vault refuses the watch, and every list after it.
  f.vault.listFails = refusal
  f.vault.endWatches({ kind: 'refused', error: refusal() })
  await until(() => f.errors.length === 1, 'the refusal')
  for (const provider of MEMBERS)
    expect(f.memberErrors[provider]).toHaveLength(1)
  // No inactive transition: same connection and leases, rosters kept.
  expect(f.vault.closes()).toBe(0)
  expect(f.hub.leaseState()).toEqual({ generation: 1, count: 3 })
  expect(alpha.snapshot()?.view).toBe('v1')
  // The refused watch fell back, so the next tick lists, refused again.
  await f.tick()
  expect(f.vault.lists).toBe(lists + 1)
  expect(f.errors).toHaveLength(2)
  for (const provider of MEMBERS)
    expect(f.memberErrors[provider]).toHaveLength(2)
  expect(await readFile(path, 'utf8')).toBe(roster)
  // Every kept receipt is gone: an unreachable vault now serves nothing.
  f.vault.listFails = undefined
  f.vault.getFails = offline
  await expect(alpha.authorize(f.route(alpha, 'alpha'))).rejects.toBeInstanceOf(
    ClaustrumUnreachableError,
  )
  await expect(beta.authorize(f.route(beta, 'beta'))).rejects.toBeInstanceOf(
    ClaustrumUnreachableError,
  )
})

test('hub faults: a private-files error on a roster lock counts as the same refusal as a lost lock', async () => {
  const dir = await tempDir('claustrum-hub-refusal-')
  const path = join(dir, 'alpha.json')
  const other = join(dir, 'beta.json')
  const io = { code: 'EBUSY' }
  const refused = (error: unknown) => isVaultRosterLockRefusal(path, error)
  expect(
    refused(new LockOwnershipError({ target: path, name: 'claustrum-roster' })),
  ).toBe(true)
  expect(
    refused(
      new LockContentionError({
        target: path,
        name: 'claustrum-roster-write',
        timeoutMs: 5_000,
      }),
    ),
  ).toBe(true)
  expect(
    refused(new ClaustrumConsumerError('roster-busy', 'discovery in progress')),
  ).toBe(true)
  // On Windows the lock steps reject with PrivateFileError: the lease file,
  // its eviction marker and its staged owner record.
  for (const failed of [
    `${path}.claustrum-roster.lock`,
    join(`${path}.claustrum-roster-write.lock.evicting`, 'owner.json'),
    `${path}.claustrum-roster.lock.0f1e2d3c.tmp`,
  ])
    expect(refused(new PrivateFileError(failed, 'read', io))).toBe(true)
  // The roster file itself failing is the member's own error, and another
  // roster's locks are not this roster's.
  expect(refused(new PrivateFileError(path, 'write', io))).toBe(false)
  expect(
    refused(new PrivateFileError(`${other}.claustrum-roster.lock`, 'read', io)),
  ).toBe(false)
  expect(
    refused(
      new LockOwnershipError({ target: other, name: 'claustrum-roster' }),
    ),
  ).toBe(false)
  expect(refused(new ClaustrumConsumerError('invalid-state', 'bad'))).toBe(
    false,
  )
  expect(refused(Object.assign(new Error('io'), { code: 'EIO' }))).toBe(false)
})

// --- two hubs in two processes on one profile ---

/** A hub in a child process, driven one command per line (fixtures/hub-process.ts). */
function hubProcess(args: string[]) {
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL('../fixtures/hub-process.ts', import.meta.url)),
      ...args,
    ],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  )
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const line = async (): Promise<string> => {
    for (;;) {
      const end = buffer.indexOf('\n')
      if (end >= 0) {
        const next = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        return next
      }
      const { value, done } = await reader.read()
      if (done)
        throw new Error(
          `hub process ended: ${await new Response(child.stderr).text()}`,
        )
      buffer += decoder.decode(value, { stream: true })
    }
  }
  const send = (command: string) => {
    child.stdin.write(`${command}\n`)
    void child.stdin.flush()
  }
  const close = async () => {
    send('exit')
    child.stdin.end()
    expect(await child.exited).toBe(0)
  }
  cleanups.push(() => {
    if (child.exitCode === null) child.kill()
  })
  return {
    send,
    line,
    close,
    refresh: async () => {
      send('refresh')
      return JSON.parse(await line()) as {
        path: string
        view?: string
        rows?: [string, boolean][]
      }
    },
  }
}

test('hub processes: two hubs in separate processes commit independently, a decline and an accept both survive the other process concurrent list, and another fingerprint keeps its own directory', async () => {
  const f = await hubFixture()
  const vaultPath = join(f.dir, 'vault.json')
  const goPath = join(f.dir, 'go')
  const publish = () =>
    writeFile(
      vaultPath,
      JSON.stringify({ view: f.vault.view, rows: f.vault.rows }),
    )
  await publish()
  const other = hubProcess([f.dir, f.tokenPath, vaultPath, '1', goPath])
  const alpha = f.member('alpha')
  await alpha.refresh()
  const path = f.hub.rosterPath('alpha')
  const main = f.route(alpha, 'alpha')
  // Same key, so the other process commits into the same file.
  expect((await other.refresh()).path).toBe(path)
  /**
   * The other process lists a new view and holds its roster write lock in
   * the middle of committing it while this process changes a preference.
   */
  const concurrently = async (change: () => Promise<unknown>) => {
    await publish()
    other.send('hold')
    other.send('refresh')
    expect(await other.line()).toBe('holding')
    const changed = change()
    // Long enough for an unlocked write to land before the other commit.
    await Bun.sleep(300)
    await writeFile(goPath, '')
    const committed = JSON.parse(await other.line()) as { view?: string }
    await changed
    await rm(goPath)
    return committed
  }
  f.vault.rows.push(keyRow('alpha', 'second'))
  f.vault.view = 'v2'
  expect((await concurrently(() => alpha.decline(main))).view).toBe('v2')
  let file = await readVaultRoster(path)
  expect(file?.view).toBe('v2')
  expect(file?.rows.map((row) => [row.credentialId, row.enabled])).toEqual([
    ['apikey:alpha:main', false],
    ['apikey:alpha:second', true],
  ])
  f.vault.rows.push(keyRow('alpha', 'third'))
  f.vault.view = 'v3'
  expect((await concurrently(() => alpha.accept(main))).view).toBe('v3')
  file = await readVaultRoster(path)
  expect(file?.view).toBe('v3')
  expect(file?.rows.map((row) => [row.credentialId, row.enabled])).toEqual([
    ['apikey:alpha:main', true],
    ['apikey:alpha:second', true],
    ['apikey:alpha:third', true],
  ])
  // This process lists and commits on its own too, over the other's commit,
  // and the other process takes that roster as it is.
  f.vault.rows.push(keyRow('alpha', 'fourth'))
  f.vault.view = 'v4'
  await alpha.refresh()
  expect((await readVaultRoster(path))?.view).toBe('v4')
  await publish()
  const taken = await other.refresh()
  expect(taken.view).toBe('v4')
  expect(taken.rows).toHaveLength(4)
  await other.close()
  // A process whose classifier input differs keeps a directory of its own.
  const text = await readFile(path, 'utf8')
  const elsewhere = hubProcess([f.dir, f.tokenPath, vaultPath, '2', goPath])
  const separate = await elsewhere.refresh()
  expect(dirname(separate.path)).not.toBe(dirname(path))
  expect(dirname(dirname(separate.path))).toBe(dirname(dirname(path)))
  expect(separate.view).toBe('v4')
  expect(await readFile(path, 'utf8')).toBe(text)
  await elsewhere.close()
}, 30_000)
