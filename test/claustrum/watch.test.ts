import { expect } from 'bun:test'
import { join } from 'node:path'
import {
  ClaustrumClient,
  ClaustrumCredentialError,
} from '@cortexkit/claustrum-client'
import {
  ClaustrumConsumer,
  type ClaustrumScopedAttempt,
  type ClaustrumScopedClient,
  connectClaustrumScopedClient,
  RESUBSCRIBE_BACKOFF_MS,
  SAFETY_POLL_MS,
  WATCH_RETRY_MS,
} from '../../src/claustrum/index.ts'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import {
  captureLogger,
  cleanupDirs,
  fakeTimers,
  family,
  tempDir,
  until,
  writeToken,
} from './helpers.ts'
import {
  type MockCredential,
  type MockDaemon,
  type MockWatchMode,
  startMockDaemon,
} from './mock-daemon.ts'

const { afterEach, test } = lifetimeHooks()
const consumers: ClaustrumConsumer[] = []
const daemons: MockDaemon[] = []
afterEach(async () => {
  for (const consumer of consumers.splice(0)) consumer.close()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await cleanupDirs()
})

/**
 * Whether the installed claustrum-client can watch (0.12.0 and later).
 * `check:claustrum-floor` also runs this file against 0.6.2, which cannot, so
 * the tests that need a real watching client are skipped there and the
 * fallback tests run instead.
 */
const clientWatches = 'watchScoped' in ClaustrumClient.prototype

const ID = 'oauth:test:work'
const POLL_MS = 5_000
const HOUR = 3_600_000

function credential(account: string): MockCredential {
  return {
    payload: `token-${account}`,
    account_id: account,
    record_version: 1,
    expires_at_ms: Date.now() + HOUR,
  }
}

async function scenario(
  options: {
    watch?: MockWatchMode
    active?: boolean
    /** Hide watchScoped, as a claustrum-client before 0.12.0 has none. */
    withoutWatch?: boolean
  } = {},
) {
  const dir = await tempDir('claustrum-watch-')
  const record = credential('account-work')
  const daemon = await startMockDaemon({
    directory: dir,
    credentials: { [ID]: record },
  })
  daemon.vaultWatch = options.watch ?? 'accept'
  daemons.push(daemon)
  const timers = fakeTimers()
  const errors: unknown[] = []
  const rosters: number[] = []
  const logs = captureLogger()
  let active = options.active ?? true
  let now = Date.now()
  const connect = async (): Promise<ClaustrumScopedClient> => {
    const client = await connectClaustrumScopedClient({
      connectionFile: daemon.connectionFile,
      identity: { project_root: dir, harness: 'test', session: 'watch' },
      logger: () => {},
    })
    if (!options.withoutWatch) return client
    return {
      listScoped: (token) => client.listScoped(token),
      getScoped: (input) => client.getScoped(input),
      reportAuthFailureScoped: (input) => client.reportAuthFailureScoped(input),
      close: () => client.close(),
    }
  }
  const consumer = new ClaustrumConsumer({
    rosterPath: join(dir, 'vault-roster.json'),
    tokenPath: await writeToken(dir),
    family,
    connect,
    isCustodyActive: () => active,
    now: () => now,
    onError: (error) => errors.push(error),
    onRoster: (roster) => rosters.push(roster.rows.length),
    logger: logs.logger,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  })
  consumers.push(consumer)
  const sends: ClaustrumScopedAttempt[] = []
  const send = (route: string) =>
    consumer.send(
      route,
      async (receipt) => {
        sends.push(receipt)
        return new Response('ok')
      },
      { site: 'model' },
    )
  return {
    daemon,
    consumer,
    timers,
    errors,
    rosters,
    record,
    sends,
    send,
    setActive: (value: boolean) => {
      active = value
    },
    advance: (ms: number) => {
      now += ms
    },
    /** Fire the armed poll tick and wait until the next one is armed. */
    tick: async () => {
      timers.fire(POLL_MS)
      await until(() => timers.pending().length > 0, 'next tick')
    },
    /** The open vault watch the mock accepted most recently. */
    watch: () => {
      const watch = daemon.vaultWatches.at(-1)
      if (!watch) throw new Error('no vault watch')
      return watch
    },
    /**
     * Serve once, then once more from the kept receipt while the vault
     * answers as unreachable, so a kept receipt is in use.
     */
    warmKeptReceipt: async () => {
      const route = consumer.snapshot()?.rows[0]?.routeId
      if (!route) throw new Error('missing vault route')
      await send(route)
      record.refuse = 'unavailable'
      await send(route)
      delete record.refuse
      expect(consumer.keptReceiptState().active).toBe(true)
    },
  }
}

const watching = (s: Awaited<ReturnType<typeof scenario>>) =>
  until(() => s.consumer.watchState().vault === 'watching', 'vault watch')

test.if(clientWatches)(
  'an accepted vault watch lists only when a notice carries a new view',
  async () => {
    const s = await scenario()
    s.consumer.start()
    await watching(s)
    // The start-up discovery already read this view, so seq 1 lists nothing,
    // and while the watch is open the poll ticks list nothing either.
    expect(s.daemon.lists).toBe(1)
    await until(() => s.timers.pending().length > 0, 'tick')
    await s.tick()
    await s.tick()
    expect(s.daemon.lists).toBe(1)
    expect(s.timers.pending()).toEqual([POLL_MS])
    s.watch().notify()
    s.watch().notify()
    s.daemon.credentials['oauth:test:home'] = credential('account-home')
    s.watch().notify()
    await until(() => s.daemon.lists === 2, 'discovery of the new view')
    await until(() => s.consumer.snapshot()?.rows.length === 2, 'roster')
    s.watch().notify()
    s.watch().notify()
    s.watch().notify()
    delete s.daemon.credentials['oauth:test:home']
    s.watch().notify()
    await until(() => s.consumer.snapshot()?.rows.length === 1, 'roster')
    await Bun.sleep(50)
    expect(s.daemon.lists).toBe(3)
    expect(s.rosters).toEqual([1, 2, 1])
    expect(s.daemon.vaultWatchRequests).toBe(1)
    expect(s.consumer.watchState()).toEqual({ vault: 'watching' })
    expect(s.errors).toEqual([])
  },
)

test.if(clientWatches)(
  'a sequence gap lists even when the view is unchanged',
  async () => {
    const s = await scenario()
    s.consumer.start()
    await watching(s)
    // seq 2 and 3 were shed: a change they announced may be missing.
    s.watch().notify({ seq: 4 })
    await until(() => s.daemon.lists === 2, 'discovery after the gap')
    s.watch().notify()
    s.watch().notify()
    await Bun.sleep(50)
    expect(s.daemon.lists).toBe(2)
  },
)

test.if(clientWatches)(
  'a new epoch lists even when the view is unchanged',
  async () => {
    const s = await scenario()
    s.consumer.start()
    await watching(s)
    // The vault restarted between two notices of one watch.
    s.watch().epoch = 'vault-epoch-2'
    s.watch().notify()
    await until(() => s.daemon.lists === 2, 'discovery after the restart')
    s.watch().notify()
    s.watch().notify()
    await Bun.sleep(50)
    expect(s.daemon.lists).toBe(2)
  },
)

test.if(clientWatches)(
  'a burst of notices during a discovery shares that discovery',
  async () => {
    const s = await scenario()
    s.consumer.start()
    await watching(s)
    const held = Promise.withResolvers<void>()
    s.daemon.holdLists = held.promise
    s.daemon.credentials['oauth:test:home'] = credential('account-home')
    for (let notice = 0; notice < 10; notice++) s.watch().notify()
    await until(() => s.daemon.lists === 2, 'discovery')
    await Bun.sleep(30)
    s.daemon.holdLists = undefined
    held.resolve()
    await until(() => s.consumer.snapshot()?.rows.length === 2, 'roster')
    await Bun.sleep(50)
    // One discovery in flight and at most one queued behind it; the queued
    // one finds the view already read and lists nothing.
    expect(s.daemon.lists).toBe(2)
  },
)

test.if(clientWatches)(
  'the safety poll still lists the roster every five minutes while watching',
  async () => {
    const s = await scenario()
    s.consumer.start()
    await watching(s)
    await until(() => s.timers.pending().length > 0, 'tick')
    s.advance(SAFETY_POLL_MS - 1)
    await s.tick()
    expect(s.daemon.lists).toBe(1)
    s.advance(1)
    await s.tick()
    expect(s.daemon.lists).toBe(2)
    await s.tick()
    expect(s.daemon.lists).toBe(2)
    expect(s.daemon.vaultWatchRequests).toBe(1)
  },
)

test.if(clientWatches)(
  'a watch closed before any notice reads once and is not re-subscribed',
  async () => {
    // The vault answers the watch with a reply instead of holding it open, as
    // a draining vault does; the client confirms with one list_scoped.
    const s = await scenario({ watch: { refuse: 'daemon_draining' } })
    s.consumer.start()
    await until(() => s.consumer.watchState().vault === 'fallback', 'fallback')
    await Bun.sleep(50)
    expect(s.daemon.vaultWatchRequests).toBe(1)
    expect(s.daemon.lists).toBe(2)
    // Polling resumes at the usual interval; one new watch is tried only
    // after the long retry wait, never right away.
    expect(s.timers.pending().sort((a, b) => a - b)).toEqual([
      POLL_MS,
      WATCH_RETRY_MS,
    ])
    s.timers.fire(POLL_MS)
    await until(() => s.daemon.lists === 3, 'poll')
    expect(s.daemon.vaultWatchRequests).toBe(1)
  },
)

test.if(clientWatches)(
  'a watch closed after notices is re-subscribed once and lists again',
  async () => {
    const s = await scenario()
    s.consumer.start()
    await watching(s)
    expect(s.daemon.lists).toBe(1)
    s.watch().end()
    await until(
      () => s.timers.pending().includes(RESUBSCRIBE_BACKOFF_MS),
      'backoff',
    )
    expect(s.consumer.watchState().vault).toBe('polling')
    expect(s.daemon.vaultWatchRequests).toBe(1)
    s.timers.fire(RESUBSCRIBE_BACKOFF_MS)
    await watching(s)
    // The new watch's seq 1 carries the same view, yet it lists: nothing was
    // watched between the two watches.
    await until(() => s.daemon.lists === 2, 'discovery on the new seq 1')
    await Bun.sleep(50)
    expect(s.daemon.lists).toBe(2)
    expect(s.daemon.vaultWatchRequests).toBe(2)
    expect(s.timers.pending()).toEqual([POLL_MS])
  },
)

test.if(clientWatches)(
  'a vault without the watch method keeps polling at the usual interval',
  async () => {
    const s = await scenario({ watch: 'unknown_method' })
    s.consumer.start()
    await until(() => s.consumer.watchState().vault === 'fallback', 'fallback')
    await until(() => s.timers.pending().length === 1, 'tick')
    expect(s.timers.pending()).toEqual([POLL_MS])
    s.timers.fire(POLL_MS)
    await until(() => s.daemon.lists === 2, 'poll')
    await until(() => s.timers.pending().length === 1, 'tick')
    expect(s.timers.pending()).toEqual([POLL_MS])
    expect(s.daemon.vaultWatchRequests).toBe(1)
  },
)

test('a client without watchScoped keeps polling at the usual interval', async () => {
  const s = await scenario({ withoutWatch: true })
  s.consumer.start()
  await until(() => s.timers.pending().length === 1, 'tick')
  expect(s.consumer.watchState()).toEqual({ vault: 'fallback' })
  expect(s.timers.pending()).toEqual([POLL_MS])
  s.timers.fire(POLL_MS)
  await until(() => s.daemon.lists === 2, 'poll')
  await until(() => s.timers.pending().length === 1, 'tick')
  expect(s.timers.pending()).toEqual([POLL_MS])
  expect(s.daemon.vaultWatchRequests).toBe(0)
})

// Against the oldest client the peer range admits (0.6.2, in
// check:claustrum-floor), the real client has no watchScoped at all.
test.if(!clientWatches)(
  'the installed client cannot watch, so the consumer keeps polling',
  async () => {
    const s = await scenario()
    s.consumer.start()
    await until(() => s.timers.pending().length === 1, 'tick')
    expect(s.consumer.watchState()).toEqual({ vault: 'fallback' })
    expect(s.timers.pending()).toEqual([POLL_MS])
    expect(s.daemon.vaultWatchRequests).toBe(0)
  },
)

test.if(clientWatches)(
  'a revocation ends the watch and is handled as a refused list_scoped',
  async () => {
    const s = await scenario()
    s.consumer.start()
    await watching(s)
    await s.warmKeptReceipt()
    // The vault revokes the enrollment: the open watch ends with not_found,
    // and from then on list_scoped refuses the same way.
    s.daemon.revoked = true
    s.watch().refuse('not_found')
    await until(
      () => s.timers.pending().includes(RESUBSCRIBE_BACKOFF_MS),
      'backoff',
    )
    s.timers.fire(RESUBSCRIBE_BACKOFF_MS)
    await until(() => s.errors.length === 1, 'refusal')
    const [refusal] = s.errors
    expect(refusal).toBeInstanceOf(ClaustrumCredentialError)
    expect((refusal as ClaustrumCredentialError).code).toBe('not_found')
    expect(s.consumer.keptReceiptState()).toEqual({
      active: false,
      since: null,
    })
    expect(s.consumer.watchState().vault).toBe('fallback')
    expect(s.daemon.vaultWatchRequests).toBe(2)
    // Polling resumes and meets the same refusal, exactly as before watches.
    expect(s.timers.pending()).toContain(POLL_MS)
    s.timers.fire(POLL_MS)
    await until(() => s.errors.length === 2, 'polled refusal')
    expect((s.errors[1] as ClaustrumCredentialError).code).toBe('not_found')
    expect(s.daemon.vaultWatchRequests).toBe(2)
  },
)

test.if(clientWatches)(
  'a watched roster change that removes the account drops its kept receipt',
  async () => {
    const s = await scenario()
    s.consumer.start()
    await watching(s)
    await s.warmKeptReceipt()
    delete s.daemon.credentials[ID]
    s.watch().notify()
    await until(() => s.consumer.snapshot()?.rows.length === 0, 'roster')
    expect(s.consumer.keptReceiptState()).toEqual({
      active: false,
      since: null,
    })
    expect(s.daemon.lists).toBe(2)
  },
)

test('local mode opens no watch and sends no request', async () => {
  const s = await scenario({ active: false })
  s.consumer.start()
  await until(() => s.timers.pending().length === 1, 'tick')
  s.timers.fire(POLL_MS)
  await until(() => s.timers.pending().length === 1, 'tick')
  await Bun.sleep(20)
  expect(s.daemon.lists).toBe(0)
  expect(s.daemon.vaultWatchRequests).toBe(0)
  expect(s.consumer.watchState()).toEqual({ vault: 'polling' })
})

test.if(clientWatches)(
  'switching to local mode closes the open watch',
  async () => {
    const s = await scenario()
    s.consumer.start()
    await watching(s)
    const watch = s.watch()
    await until(() => s.timers.pending().length > 0, 'tick')
    s.setActive(false)
    await s.tick()
    await until(() => watch.closed, 'watch closed')
    expect(s.consumer.watchState()).toEqual({ vault: 'polling' })
    await s.tick()
    expect(s.daemon.lists).toBe(1)
    expect(s.daemon.vaultWatchRequests).toBe(1)
  },
)
