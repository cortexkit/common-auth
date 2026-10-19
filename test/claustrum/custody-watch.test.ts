// A plugin host that runs ClaustrumScopedCustody with its own roster, without
// a ClaustrumConsumer, watches the vault through custody.watchRoster.
import { expect } from 'bun:test'
import { ClaustrumCredentialError } from '@cortexkit/claustrum-client'
import { SubcClient } from '@cortexkit/subc-client'
import {
  type ClaustrumRosterWatch,
  type ClaustrumScopedClient,
  ClaustrumScopedCustody,
  connectClaustrumScopedClient,
  RESUBSCRIBE_BACKOFF_MS,
  WATCH_RETRY_MS,
  type WatchMode,
} from '../../src/claustrum/index.ts'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import {
  captureLogger,
  cleanupDirs,
  clientWatches,
  deferred,
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
const custodies: ClaustrumScopedCustody[] = []
const daemons: MockDaemon[] = []
afterEach(async () => {
  for (const custody of custodies.splice(0)) custody.close()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await cleanupDirs()
})

const ID = 'oauth:test:work'
const HOUR = 3_600_000
/** The enrollment token writeToken stores by default. */
const TOKEN = '01'.repeat(32)
/** The delay of custody's first outage recovery probe. */
const PROBE_MS = 2_000

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
    /** Hide watchScoped, as a claustrum-client before 0.12.0 has none. */
    withoutWatch?: boolean
    /**
     * The host's answer to onView. By default it runs its discovery, which
     * lists the vault through custody.
     */
    onView?: (view: string) => unknown
  } = {},
) {
  const dir = await tempDir('claustrum-custody-watch-')
  const record = credential('account-work')
  const daemon = await startMockDaemon({
    directory: dir,
    credentials: { [ID]: record },
  })
  daemon.vaultWatch = options.watch ?? 'accept'
  daemons.push(daemon)
  const connected = await connectClaustrumScopedClient({
    connectionFile: daemon.connectionFile,
    // Reconnect at once after a dropped connection.
    connector: (connect) =>
      SubcClient.connect({ ...connect, sleep: async () => {} }),
    identity: { project_root: dir, harness: 'test', session: 'custody-watch' },
    logger: () => {},
  })
  const client: ClaustrumScopedClient = options.withoutWatch
    ? {
        listScoped: (token) => connected.listScoped(token),
        getScoped: (input) => connected.getScoped(input),
        reportAuthFailureScoped: (input) =>
          connected.reportAuthFailureScoped(input),
        close: () => connected.close(),
      }
    : connected
  const timers = fakeTimers()
  const logs = captureLogger()
  const custody = new ClaustrumScopedCustody({
    client,
    family,
    tokenPath: await writeToken(dir),
    logger: logs.logger,
    ...timers,
  })
  custodies.push(custody)
  // The host's own discovery, run once at start-up as it does today.
  const first = await custody.discover()
  const views: string[] = []
  const modes: WatchMode[] = []
  const refusals: unknown[] = []
  const errors: unknown[] = []
  let watch: ClaustrumRosterWatch | undefined
  return {
    daemon,
    connected,
    custody,
    timers,
    logs,
    record,
    first,
    views,
    modes,
    refusals,
    errors,
    open: () => {
      watch = custody.watchRoster({
        onView: async (view) => {
          views.push(view)
          if (options.onView) await options.onView(view)
          else await custody.discover()
        },
        onMode: (mode) => modes.push(mode),
        onRefused: (error) => refusals.push(error),
        onError: (error) => errors.push(error),
      })
      return watch
    },
    /** The open vault watch the mock accepted most recently. */
    served: () => {
      const served = daemon.vaultWatches.at(-1)
      if (!served) throw new Error('no vault watch')
      return served
    },
    /**
     * Serve once, then once more from the kept receipt while the vault
     * answers as unreachable, so a kept receipt is in use.
     */
    warmKeptReceipt: async () => {
      const identity = {
        credentialId: ID,
        credentialType: 'oauth' as const,
        accountIdentity: 'account-work',
      }
      await custody.authorize(identity)
      record.refuse = 'unavailable'
      await custody.authorize(identity)
      delete record.refuse
      expect(custody.keptReceiptState().active).toBe(true)
    },
  }
}

type Scenario = Awaited<ReturnType<typeof scenario>>

const watching = (s: Scenario, watch: ClaustrumRosterWatch) =>
  until(() => watch.mode === 'watching', 'vault watch')

const logged = (s: Scenario, message: string) =>
  s.logs.records.some((record) => record.message === message)

test.if(clientWatches)(
  'a custody watch calls onView for a new view and not for an unchanged one',
  async () => {
    const s = await scenario()
    const watch = s.open()
    await watching(s, watch)
    // Seq 1 carries the view the start-up discovery already read.
    s.served().notify()
    await Bun.sleep(50)
    expect(s.views).toEqual([])
    expect(s.daemon.lists).toBe(1)
    s.daemon.credentials['oauth:test:home'] = credential('account-home')
    s.served().notify()
    await until(() => s.views.length === 1, 'onView for the new view')
    await until(() => s.daemon.lists === 2, 'discovery of the new view')
    expect(s.views[0]).not.toBe(s.first.view)
    // The host's discovery read that view, so repeating it calls nothing.
    s.served().notify()
    s.served().notify()
    await Bun.sleep(50)
    expect(s.views).toHaveLength(1)
    expect(s.daemon.lists).toBe(2)
    expect(s.modes).toEqual(['watching'])
    expect(s.daemon.vaultWatchRequests).toBe(1)
    expect(s.errors).toEqual([])
  },
)

test.if(clientWatches)(
  'a burst of notices during onView shares that call',
  async () => {
    const gate = deferred<void>()
    let custody: ClaustrumScopedCustody | undefined
    const s = await scenario({
      onView: async () => {
        await gate.promise
        await custody?.discover()
      },
    })
    custody = s.custody
    const watch = s.open()
    await watching(s, watch)
    s.daemon.credentials['oauth:test:home'] = credential('account-home')
    for (let notice = 0; notice < 10; notice++) s.served().notify()
    await until(() => s.views.length === 1, 'onView')
    await Bun.sleep(30)
    expect(s.views).toHaveLength(1)
    gate.resolve()
    await until(() => s.daemon.lists === 2, 'discovery')
    await Bun.sleep(50)
    // The queued follow-up finds the view already discovered.
    expect(s.views).toHaveLength(1)
    expect(s.daemon.lists).toBe(2)
  },
)

test.if(clientWatches)(
  'a custody watch closed before any notice reads once and does not loop',
  async () => {
    // The vault answers the watch instead of holding it open, as a draining
    // vault does; the client confirms with one list_scoped.
    const s = await scenario({ watch: { refuse: 'daemon_draining' } })
    const watch = s.open()
    await until(() => watch.mode === 'fallback', 'fallback')
    await Bun.sleep(50)
    expect(s.daemon.vaultWatchRequests).toBe(1)
    expect(s.daemon.lists).toBe(2)
    // One new watch is tried only after the long retry wait.
    expect(s.timers.pending()).toEqual([WATCH_RETRY_MS])
    expect(s.modes).toEqual(['fallback'])
    expect(s.views).toEqual([])
    expect(s.refusals).toEqual([])
  },
)

test.if(clientWatches)(
  'a vault answering unknown_method reports fallback with no retry',
  async () => {
    const s = await scenario({ watch: 'unknown_method' })
    const watch = s.open()
    await until(() => watch.mode === 'fallback', 'fallback')
    await Bun.sleep(30)
    expect(s.modes).toEqual(['fallback'])
    expect(s.timers.pending()).toEqual([])
    expect(s.daemon.vaultWatchRequests).toBe(1)
  },
)

test('a client without watchScoped reports fallback and opens nothing', async () => {
  const s = await scenario({ withoutWatch: true })
  const watch = s.open()
  expect(watch.mode).toBe('fallback')
  expect(s.modes).toEqual(['fallback'])
  await Bun.sleep(30)
  expect(s.timers.pending()).toEqual([])
  expect(s.daemon.vaultWatchRequests).toBe(0)
})

test.if(clientWatches)(
  'a revocation ends the custody watch as a refused discovery',
  async () => {
    const s = await scenario()
    const watch = s.open()
    await watching(s, watch)
    await s.warmKeptReceipt()
    // The vault revokes the enrollment: the open watch ends with not_found,
    // and from then on list_scoped refuses the same way.
    s.daemon.revoked = true
    s.served().refuse('not_found')
    await until(
      () => s.timers.pending().includes(RESUBSCRIBE_BACKOFF_MS),
      'backoff',
    )
    s.timers.fire(RESUBSCRIBE_BACKOFF_MS)
    await until(() => s.refusals.length === 1, 'refusal')
    const [refusal] = s.refusals
    expect(refusal).toBeInstanceOf(ClaustrumCredentialError)
    expect((refusal as ClaustrumCredentialError).code).toBe('not_found')
    expect(s.custody.keptReceiptState()).toEqual({ active: false, since: null })
    expect(watch.mode).toBe('fallback')
    expect(s.daemon.vaultWatchRequests).toBe(2)
    expect(s.views).toEqual([])
  },
)

test.if(clientWatches)(
  'a lost watch transport starts the custody outage and its next first notice ends it',
  async () => {
    // onView lists nothing here, so only the watch can end the outage.
    const s = await scenario({ onView: () => {} })
    const watch = s.open()
    await watching(s, watch)
    s.served().drop()
    await until(() => logged(s, 'serving kept vault receipt'), 'outage')
    expect(watch.mode).toBe('polling')
    expect(s.timers.pending().sort((a, b) => a - b)).toEqual([
      RESUBSCRIBE_BACKOFF_MS,
      PROBE_MS,
    ])
    // The client reconnects only for a call of its own; make one outside
    // custody, as the host's fallback poll would, so custody stays in its
    // outage until the watch hears from the vault.
    await s.connected.listScoped(TOKEN).catch(() => {})
    await s.connected.listScoped(TOKEN)
    expect(logged(s, 'vault receipt serving resumed')).toBe(false)
    s.timers.fire(RESUBSCRIBE_BACKOFF_MS)
    await until(() => logged(s, 'vault receipt serving resumed'), 'outage end')
    expect(watch.mode).toBe('watching')
    // Recovery cancelled the outage probe.
    expect(s.timers.pending()).toEqual([])
    expect(s.daemon.vaultWatchRequests).toBe(2)
  },
)

test.if(clientWatches)(
  'an outage probe listing a new view does not stand in for the host discovery',
  async () => {
    const s = await scenario()
    const watch = s.open()
    await watching(s, watch)
    s.custody.transportLost()
    s.daemon.credentials['oauth:test:home'] = credential('account-home')
    s.timers.fire(PROBE_MS)
    await until(() => logged(s, 'vault receipt serving resumed'), 'probe')
    expect(s.daemon.lists).toBe(2)
    // The probe listed the new view but committed nothing; the notice for it
    // still asks the host to discover.
    s.served().notify()
    await until(() => s.views.length === 1, 'onView after the probe')
  },
)

test.if(clientWatches)('closing the custody watch stops it', async () => {
  const s = await scenario()
  const watch = s.open()
  await watching(s, watch)
  const served = s.served()
  watch.close()
  await until(() => served.closed, 'watch closed')
  watch.close()
  expect(s.timers.pending()).toEqual([])
  expect(s.daemon.vaultWatchRequests).toBe(1)
})

test.if(clientWatches)(
  'closing the custody stops its watch and cancels its re-subscribe',
  async () => {
    const s = await scenario()
    const watch = s.open()
    await watching(s, watch)
    s.served().end()
    await until(
      () => s.timers.pending().includes(RESUBSCRIBE_BACKOFF_MS),
      'backoff',
    )
    s.custody.close()
    expect(s.timers.pending()).toEqual([])
    expect(() => s.custody.watchRoster({ onView: () => {} })).toThrow(
      'Claustrum scoped custody is closed',
    )
  },
)
