import { expect } from 'bun:test'
import { join } from 'node:path'
import { ClaustrumClient } from '@cortexkit/claustrum-client'
import {
  ClaustrumConsumer,
  type ClaustrumScopedClient,
  ClaustrumScopedCustody,
  type ClaustrumUsageReading,
  connectClaustrumScopedClient,
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
import { type MockDaemon, startMockDaemon } from './mock-daemon.ts'

const { afterEach, test } = lifetimeHooks()
const consumers: ClaustrumConsumer[] = []
const custodies: ClaustrumScopedCustody[] = []
const daemons: MockDaemon[] = []
afterEach(async () => {
  for (const consumer of consumers.splice(0)) consumer.close()
  for (const custody of custodies.splice(0)) custody.close()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await cleanupDirs()
})

const supportsUsage = 'reportUsageScoped' in ClaustrumClient.prototype
const first = 'oauth:test:work'
const second = 'oauth:test:home'
const reading = (observedAtMs: number): ClaustrumUsageReading => ({
  provider: 'codex',
  observedAtMs,
  headers: { 'x-codex-primary-used-percent': `${observedAtMs}` },
})

async function scenario(oldClient = false) {
  const dir = await tempDir('claustrum-usage-')
  const tokenPath = await writeToken(dir)
  const daemon = await startMockDaemon({
    directory: dir,
    credentials: Object.fromEntries(
      [first, second].map((id) => [
        id,
        {
          payload: 'reply-quota-token',
          account_id: id,
          record_version: 1,
          expires_at_ms: Date.now() + 600_000,
        },
      ]),
    ),
  })
  daemons.push(daemon)
  const timers = fakeTimers()
  const logs = captureLogger()
  let usageCalls = 0
  let client: ClaustrumScopedClient | undefined
  const connect = async () => {
    const real = await connectClaustrumScopedClient({
      connectionFile: daemon.connectionFile,
      identity: { project_root: dir, harness: 'test', session: 'usage' },
    })
    const reportUsage = real.reportUsageScoped?.bind(real)
    if (reportUsage)
      real.reportUsageScoped = (input) => {
        usageCalls++
        return reportUsage(input)
      }
    client = oldClient
      ? {
          listScoped: real.listScoped.bind(real),
          getScoped: real.getScoped.bind(real),
          reportAuthFailureScoped: real.reportAuthFailureScoped.bind(real),
          close: real.close.bind(real),
        }
      : real
    return client
  }
  const consumer = new ClaustrumConsumer({
    rosterPath: join(dir, 'roster.json'),
    tokenPath,
    family,
    connect,
    logger: logs.logger,
    ...timers,
  })
  consumers.push(consumer)
  await consumer.refresh()
  const route = (id: string) => {
    const row = consumer.snapshot()?.rows.find((row) => row.credentialId === id)
    if (!row) throw new Error(`no route for ${id}`)
    return row.routeId
  }
  const report = (id: string, value = reading(1)) =>
    consumer.reportUsage({
      routeId: route(id),
      credentialId: id,
      reading: value,
    })
  const idle = () =>
    until(() => !consumer.usageReportState().inFlight, 'usage flush')
  return {
    consumer,
    daemon,
    timers,
    logs,
    route,
    report,
    idle,
    tokenPath,
    usageCalls: () => usageCalls,
    client: () => {
      if (!client) throw new Error('not connected')
      return client
    },
  }
}

test.if(supportsUsage)(
  'usage returns synchronously while a daemon stalls and serializes sends',
  async () => {
    const s = await scenario()
    await s.consumer.authorize(s.route(first))
    await s.consumer.authorize(s.route(second))
    const held = Promise.withResolvers<void>()
    s.daemon.holdUsageReports = held.promise
    expect(s.report(first)).toBeUndefined()
    expect(s.daemon.usageReports).toHaveLength(0)
    expect(s.timers.pending()).toEqual([1_000])
    s.timers.fire(1_000)
    await until(() => s.daemon.usageReports.length === 1, 'first report')
    expect(s.report(second)).toBeUndefined()
    expect(s.report(first, reading(3))).toBeUndefined()
    expect(s.report(first, reading(2))).toBeUndefined()
    await Bun.sleep(20)
    expect(s.daemon.usageReports).toHaveLength(1)
    s.daemon.holdUsageReports = undefined
    held.resolve()
    await until(() => s.daemon.usageReports.length === 3, 'serialized reports')
    await s.idle()
    expect(
      s.daemon.usageReports.map((r) => [
        r.credential_id,
        r.reading?.observedAtMs,
      ]),
    ).toEqual([
      [first, 1],
      [second, 1],
      [first, 3],
    ])
  },
)

test.if(supportsUsage)(
  'usage coalesces each credential by observation time, not arrival order',
  async () => {
    const s = await scenario()
    await s.consumer.authorize(s.route(first))
    await s.consumer.authorize(s.route(second))
    const mutable = reading(30)
    s.report(first, reading(10))
    s.report(first, mutable)
    s.report(first, reading(20))
    s.report(second, reading(40))
    mutable.observedAtMs = 999
    s.timers.fire(1_000)
    await s.idle()
    expect(
      s.daemon.usageReports.map((r) => [
        r.credential_id,
        r.reading?.observedAtMs,
      ]),
    ).toEqual([
      [first, 30],
      [second, 40],
    ])
    expect(s.daemon.usageReports[0]?.enrollment_token).toBe('01'.repeat(32))
    s.report(first, reading(25))
    expect(s.consumer.usageReportState().pending).toBe(0)
  },
)

test.if(supportsUsage)(
  'usage never sends unserved, removed or wrong-route credentials',
  async () => {
    const s = await scenario()
    s.report(first)
    await s.consumer.authorize(s.route(second))
    s.consumer.reportUsage({
      routeId: s.route(first),
      credentialId: second,
      reading: reading(2),
    })
    s.report(second, reading(3))
    delete s.daemon.credentials[second]
    await s.consumer.refresh()
    await s.consumer.dispose()
    expect(s.daemon.usageReports).toHaveLength(0)
  },
)

test.if(supportsUsage)(
  'usage validates and counts malformed, forbidden and oversized readings locally',
  async () => {
    const s = await scenario()
    await s.consumer.authorize(s.route(first))
    const cyclic: Record<string, unknown> = { ...reading(1) }
    cyclic.frame = cyclic
    const invalid: unknown[] = [
      null,
      1,
      'reading',
      [],
      new Date(),
      Object.assign(Object.create({}), reading(1)),
      { ...reading(1), credentialId: first },
      { ...reading(1), vouched: false },
      { ...reading(1), headers: { limit: 'é'.repeat(7_680) } },
      cyclic,
      { ...reading(1), toJSON: () => ({ ...reading(1), vouched: true }) },
    ]
    for (const value of invalid) s.report(first, value as ClaustrumUsageReading)
    expect(s.consumer.usageReportState().dropped).toBe(invalid.length)
    const boundary = { ...reading(2), frame: '' }
    boundary.frame = 'a'.repeat(
      15_360 - Buffer.byteLength(JSON.stringify(boundary)),
    )
    expect(Buffer.byteLength(JSON.stringify(boundary))).toBe(15_360)
    s.report(first, boundary)
    await s.consumer.dispose()
    expect(s.daemon.usageReports).toHaveLength(1)
    expect(s.daemon.usageReports[0]?.reading?.observedAtMs).toBe(2)
  },
)

for (const failure of ['not_found', 'transport'] as const) {
  test.if(supportsUsage)(
    `usage drops ${failure} without throwing, retrying or logging contents`,
    async () => {
      const s = await scenario()
      await s.consumer.authorize(s.route(first))
      if (failure === 'transport') s.daemon.dropUsageReports = true
      else s.daemon.usageReportRefusal = failure
      expect(s.report(first)).toBeUndefined()
      s.timers.fire(1_000)
      await s.idle()
      expect(s.usageCalls()).toBe(1)
      const wireReports = s.daemon.usageReports.length
      expect(wireReports).toBeGreaterThanOrEqual(1)
      expect(s.consumer.usageReportState().dropped).toBe(1)
      expect(s.timers.pending()).toEqual([])
      await Bun.sleep(20)
      expect(s.usageCalls()).toBe(1)
      expect(s.daemon.usageReports).toHaveLength(wireReports)
      s.report(first, reading(2))
      s.timers.fire(1_000)
      await s.idle()
      expect(s.usageCalls()).toBe(2)
      const debug = s.logs.records.filter(
        (record) => record.message === 'claustrum usage report dropped',
      )
      expect(debug).toEqual([
        {
          level: 'debug',
          message: 'claustrum usage report dropped',
          data: {
            code: failure === 'not_found' ? 'not_found' : 'transport_error',
          },
        },
      ])
      expect(JSON.stringify(debug)).not.toContain(first)
      expect(JSON.stringify(debug)).not.toContain('x-codex')
      expect(JSON.stringify(debug)).not.toContain('reply-quota-token')
    },
  )
}

test('usage with a client without reportUsageScoped is a no-op', async () => {
  // With claustrum-client 0.6.2 this uses that actual installed client. With
  // newer clients the facade exposes only 0.6.2's mandatory scoped operations.
  const s = await scenario(supportsUsage)
  await s.consumer.authorize(s.route(first))
  expect(s.report(first)).toBeUndefined()
  expect(s.timers.pending()).toEqual([])
  expect(s.consumer.usageReportState()).toEqual({
    pending: 0,
    inFlight: false,
    dropped: 0,
  })
  await s.consumer.dispose()
  expect(s.daemon.usageReports).toHaveLength(0)
})

test.if(supportsUsage)(
  'usage dispose flushes the pending debounce and ignores reports afterward',
  async () => {
    const s = await scenario()
    await s.consumer.authorize(s.route(first))
    s.report(first)
    const routeId = s.route(first)
    await s.consumer.dispose()
    expect(s.daemon.usageReports).toHaveLength(1)
    expect(s.daemon.usageReports[0]?.reading).toEqual({ ...reading(1) })
    expect(s.timers.pending()).toEqual([])
    expect(
      s.consumer.reportUsage({
        routeId,
        credentialId: first,
        reading: reading(2),
      }),
    ).toBeUndefined()
    expect(s.consumer.usageReportState().pending).toBe(0)
    expect(s.consumer.usageReportState().inFlight).toBe(false)
    expect(s.daemon.usageReports).toHaveLength(1)
  },
)

test.if(supportsUsage)(
  'usage dispose bounds a stalled drain to two seconds and drops the rest',
  async () => {
    const s = await scenario()
    await s.consumer.authorize(s.route(first))
    await s.consumer.authorize(s.route(second))
    const held = Promise.withResolvers<void>()
    s.daemon.holdUsageReports = held.promise
    s.report(first)
    s.report(second)
    const started = performance.now()
    const disposing = s.consumer.dispose()
    await until(() => s.daemon.usageReports.length === 1, 'shutdown flush')
    await disposing
    expect(performance.now() - started).toBeLessThan(2_500)
    expect(s.consumer.usageReportState().pending).toBe(0)
    expect(s.consumer.usageReportState().dropped).toBeGreaterThanOrEqual(1)
    held.resolve()
    await Bun.sleep(20)
    expect(s.daemon.usageReports).toHaveLength(1)
  },
)

test.if(supportsUsage)(
  'scoped custody reports served credentials and applies roster retention',
  async () => {
    const s = await scenario()
    const custody = new ClaustrumScopedCustody({
      client: s.client(),
      family,
      tokenPath: s.tokenPath,
      ...s.timers,
    })
    custodies.push(custody)
    const identity = {
      credentialId: first,
      credentialType: 'oauth' as const,
      accountIdentity: first,
    }
    expect(
      custody.reportUsage({ credentialId: first, reading: reading(1) }),
    ).toBeUndefined()
    await custody.authorize(identity)
    custody.retain([{ ...identity, enabled: true, state: 'active' }])
    custody.reportUsage({ credentialId: first, reading: reading(2) })
    custody.retain([])
    custody.reportUsage({ credentialId: first, reading: reading(3) })
    await custody.authorize(identity)
    custody.reportUsage({ credentialId: first, reading: reading(4) })
    await custody.dispose()
    expect(s.daemon.usageReports.map((r) => r.reading?.observedAtMs)).toEqual([
      4,
    ])
    expect(
      custody.reportUsage({ credentialId: first, reading: reading(5) }),
    ).toBeUndefined()
    expect(s.daemon.usageReports).toHaveLength(1)
  },
)
