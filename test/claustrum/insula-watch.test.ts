import { expect } from 'bun:test'
import { join } from 'node:path'
import {
  acquireInsulaQuotaSource,
  ClaustrumConsumer,
  connectClaustrumScopedClient,
  type InsulaUsageTransport,
  RESUBSCRIBE_BACKOFF_MS,
  WATCH_RETRY_MS,
} from '../../src/claustrum/index.ts'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import {
  cleanupDirs,
  clientWatches,
  fakeTimers,
  family,
  tempDir,
  until,
  writeToken,
} from './helpers.ts'
import {
  type MockDaemon,
  type MockWatchMode,
  startMockDaemon,
} from './mock-daemon.ts'

const { afterEach, test } = lifetimeHooks()
const releases: Array<() => void> = []
const daemons: MockDaemon[] = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await cleanupDirs()
})

const NOW = Date.parse('2026-09-30T12:00:00Z')
const POLL_MS = 5_000
const entry = {
  provider: 'codex',
  account: 'account-work',
  source: 'vault',
  fetchedAt: new Date(NOW - 1_000).toISOString(),
  usage: { primary: { usedPercent: 20 } },
}

/** A real insula transport against the mock daemon, with its own source. */
async function realSource(watch: MockWatchMode) {
  const dir = await tempDir('insula-watch-')
  const daemon = await startMockDaemon({
    directory: dir,
    credentials: {},
    insula: { response: { result: [entry] } },
  })
  daemon.usageWatch = watch
  daemons.push(daemon)
  const client = await connectClaustrumScopedClient({
    connectionFile: daemon.connectionFile,
    identity: { project_root: dir, harness: 'test', session: 'watch' },
    logger: () => {},
  })
  releases.push(() => client.close())
  const transport = client.insula
  if (!transport) throw new Error('missing insula transport')
  const shared = acquireInsulaQuotaSource(transport, await writeToken(dir))
  releases.push(shared.release)
  const timers = fakeTimers()
  const watchUsage = () => {
    const release = shared.source.watch({
      provider: 'codex',
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    })
    releases.unshift(release)
    return release
  }
  return { daemon, source: shared.source, timers, watchUsage }
}

/**
 * A transport whose watch notices and usage.get replies the test drives
 * directly, so read counts do not depend on socket timing.
 */
async function fakeSource(options: { holdReads?: boolean } = {}) {
  const dir = await tempDir('insula-fake-')
  let onNotice: ((body: Uint8Array) => void) | undefined
  const watch = Promise.withResolvers<void>()
  const replies: Array<(value: unknown) => void> = []
  let reads = 0
  const transport: InsulaUsageTransport = {
    connectionFile: join(dir, 'insula-connection.json'),
    getUsage: () => {
      reads++
      if (!options.holdReads) return Promise.resolve({ result: [entry] })
      const reply = Promise.withResolvers<unknown>()
      replies.push(reply.resolve)
      return reply.promise
    },
    watchUsage: (notice) => {
      onNotice = notice
      return { stop: () => watch.resolve(), closed: watch.promise }
    },
  }
  const shared = acquireInsulaQuotaSource(transport, await writeToken(dir))
  releases.push(shared.release)
  releases.unshift(shared.source.watch({ provider: 'codex' }))
  return {
    source: shared.source,
    reads: () => reads,
    /** Answer the oldest held usage.get and let its follow-up start. */
    answer: async () => {
      replies.shift()?.({ result: [entry] })
      await Bun.sleep(0)
    },
    notice: (fields: Record<string, unknown>) => {
      if (!onNotice) throw new Error('no watch open')
      onNotice(
        new TextEncoder().encode(
          JSON.stringify({ kind: 'changed', ...fields }),
        ),
      )
    },
  }
}

test('notice seq 1 reads usage.get once, and later notices for this provider read again', async () => {
  const s = await realSource('accept')
  s.watchUsage()
  await until(() => s.source.watchMode() === 'watching', 'insula watch')
  await until(() => s.daemon.usageGets === 1, 'read on seq 1')
  await Bun.sleep(30)
  expect(s.daemon.usageGets).toBe(1)
  expect(s.source.current('codex', 'account-work', NOW)).toBeDefined()
  const watch = s.daemon.usageWatches[0]!
  watch.notify({ provider: 'codex', account: 'account-work' })
  await until(() => s.daemon.usageGets === 2, 'read on a codex notice')
  // A notice for another provider, in sequence, needs no read here.
  watch.notify({ provider: 'claude', account: 'other' })
  watch.notify({ provider: 'codex', account: 'account-work' })
  await until(() => s.daemon.usageGets === 3, 'read on a codex notice')
  await Bun.sleep(30)
  expect(s.daemon.usageGets).toBe(3)
  expect(s.daemon.usageWatchRequests).toBe(1)
})

test('while the insula watch is open the background poll reads nothing', async () => {
  const s = await realSource('accept')
  s.watchUsage()
  await until(() => s.daemon.usageGets === 1, 'read on seq 1')
  await s.source.refresh(NOW)
  await s.source.refresh(NOW + 60_000)
  await s.source.refresh(NOW + 120_000)
  expect(s.daemon.usageGets).toBe(1)
})

test('a burst of ten notices reads usage.get at most twice', async () => {
  const s = await fakeSource({ holdReads: true })
  s.notice({ epoch: 'e', seq: 1 })
  expect(s.reads()).toBe(1)
  for (let seq = 2; seq <= 11; seq++)
    s.notice({ epoch: 'e', seq, provider: 'codex', account: 'work' })
  expect(s.reads()).toBe(1)
  await s.answer()
  // One read in flight, one queued behind it, however many notices came.
  expect(s.reads()).toBe(2)
  await s.answer()
  await Bun.sleep(10)
  expect(s.reads()).toBe(2)
})

test('a sequence gap re-reads everything, even for another provider', async () => {
  const s = await fakeSource()
  s.notice({ epoch: 'e', seq: 1 })
  s.notice({ epoch: 'e', seq: 2, provider: 'claude' })
  expect(s.reads()).toBe(1)
  // seq 3 was shed: whatever it announced is unknown.
  s.notice({ epoch: 'e', seq: 4, provider: 'claude' })
  await Bun.sleep(0)
  expect(s.reads()).toBe(2)
  s.notice({ epoch: 'e', seq: 5, provider: 'claude' })
  await Bun.sleep(0)
  expect(s.reads()).toBe(2)
})

test('a new epoch re-reads everything, even for another provider', async () => {
  const s = await fakeSource()
  s.notice({ epoch: 'e', seq: 1 })
  s.notice({ epoch: 'e', seq: 2, provider: 'claude' })
  expect(s.reads()).toBe(1)
  // insula restarted between two notices.
  s.notice({ epoch: 'f', seq: 3, provider: 'claude' })
  await Bun.sleep(0)
  expect(s.reads()).toBe(2)
  s.notice({ epoch: 'f', seq: 4, provider: 'claude' })
  await Bun.sleep(0)
  expect(s.reads()).toBe(2)
})

test('an insula watch closed after notices is re-subscribed once and reads again', async () => {
  const s = await realSource('accept')
  s.watchUsage()
  await until(() => s.daemon.usageGets === 1, 'read on seq 1')
  s.daemon.usageWatches[0]!.end()
  await until(
    () => s.timers.pending().includes(RESUBSCRIBE_BACKOFF_MS),
    'backoff',
  )
  expect(s.source.watchMode()).toBe('polling')
  expect(s.daemon.usageWatchRequests).toBe(1)
  s.timers.fire(RESUBSCRIBE_BACKOFF_MS)
  await until(() => s.daemon.usageGets === 2, 'read on the new seq 1')
  expect(s.source.watchMode()).toBe('watching')
  expect(s.daemon.usageWatchRequests).toBe(2)
  expect(s.timers.pending()).toEqual([])
})

test.each([
  ['the watch limit', { refuse: 'usage_watch_limit' }, 0],
  ['an insula without the method', 'unknown_method', 0],
  // Any other refusal insula answered, invalid_request included, reads once
  // to learn whether insula answers at all.
  ['an answered refusal', { refuse: 'invalid_request' }, 1],
] as const)(
  '%s keeps polling as before, without re-subscribing',
  async (_name, refusal, reads) => {
    const s = await realSource(refusal)
    s.watchUsage()
    await until(() => s.source.watchMode() === 'fallback', 'fallback')
    await Bun.sleep(30)
    expect(s.daemon.usageGets).toBe(reads)
    expect(s.timers.pending()).toEqual([])
    // Polling is the same as without a watch: at most one usage.get a minute.
    await s.source.refresh(NOW)
    await s.source.refresh(NOW + 59_999)
    expect(s.daemon.usageGets).toBe(reads + 1)
    await s.source.refresh(NOW + 60_000)
    expect(s.daemon.usageGets).toBe(reads + 2)
    expect(s.daemon.usageWatchRequests).toBe(1)
  },
)

test('a watch that never opens reads once, polls, and tries again much later', async () => {
  const s = await realSource('accept')
  // The insula route refuses to open: the watch closes before any notice.
  s.daemon.insula!.refusal = 'module_reloading'
  s.watchUsage()
  await until(() => s.source.watchMode() === 'fallback', 'fallback')
  await until(() => s.timers.pending().length > 0, 'retry')
  expect(s.timers.pending()).toEqual([WATCH_RETRY_MS])
  expect(s.daemon.usageWatchRequests).toBe(0)
  delete s.daemon.insula!.refusal
  s.timers.fire(WATCH_RETRY_MS)
  await until(() => s.source.watchMode() === 'watching', 'insula watch')
  expect(s.daemon.usageWatchRequests).toBe(1)
})

async function consumerScenario(options: { active: boolean }) {
  const dir = await tempDir('insula-watch-consumer-')
  const daemon = await startMockDaemon({
    directory: dir,
    credentials: {
      'oauth:test:work': {
        payload: 'access',
        account_id: 'account-work',
        record_version: 1,
        expires_at_ms: NOW + 3_600_000,
      },
    },
    insula: { response: { result: [entry] } },
  })
  daemon.vaultWatch = 'accept'
  daemon.usageWatch = 'accept'
  daemons.push(daemon)
  const timers = fakeTimers()
  let now = NOW
  const consumer = new ClaustrumConsumer({
    rosterPath: join(dir, 'vault-roster.json'),
    tokenPath: await writeToken(dir),
    family,
    connect: () =>
      connectClaustrumScopedClient({
        connectionFile: daemon.connectionFile,
        identity: { project_root: dir, harness: 'test', session: 'consumer' },
        logger: () => {},
      }),
    isCustodyActive: () => options.active,
    now: () => now,
    insula: { provider: 'codex', normalize: () => undefined },
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  })
  releases.push(() => consumer.close())
  return {
    daemon,
    consumer,
    timers,
    advance: (ms: number) => {
      now += ms
    },
    tick: async () => {
      timers.fire(POLL_MS)
      await until(() => timers.pending().includes(POLL_MS), 'next tick')
    },
  }
}

// The vault half needs a client with watchScoped (claustrum-client 0.12.0).
test.if(clientWatches)(
  'an idle watching consumer makes no vault or insula read between safety polls',
  async () => {
    const s = await consumerScenario({ active: true })
    s.consumer.start()
    await until(
      () =>
        s.consumer.watchState().vault === 'watching' &&
        s.consumer.watchState().insula === 'watching',
      'both watches',
    )
    await until(() => s.timers.pending().includes(POLL_MS), 'tick')
    // Start-up made one list and one usage.get, and insula's seq 1 one more.
    await until(() => s.daemon.usageGets === 2, 'read on insula seq 1')
    expect(s.daemon.lists).toBe(1)
    const lists = s.daemon.lists
    const usageGets = s.daemon.usageGets
    for (let minute = 0; minute < 4; minute++) {
      s.advance(60_000)
      await s.tick()
    }
    expect(s.daemon.lists).toBe(lists)
    expect(s.daemon.usageGets).toBe(usageGets)
    expect(s.consumer.watchState()).toEqual({
      vault: 'watching',
      insula: 'watching',
    })
  },
)

test('a consumer in local mode opens no insula watch', async () => {
  const s = await consumerScenario({ active: false })
  s.consumer.start()
  await until(() => s.timers.pending().includes(POLL_MS), 'tick')
  await s.tick()
  await Bun.sleep(20)
  expect(s.daemon.insulaOpens).toBe(0)
  expect(s.daemon.usageWatchRequests).toBe(0)
  expect(s.daemon.usageGets).toBe(0)
  expect(s.consumer.watchState()).toEqual({
    vault: 'polling',
    insula: 'polling',
  })
})
