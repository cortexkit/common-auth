import { expect } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  acquireInsulaQuotaSource,
  ClaustrumConsumer,
  connectClaustrumScopedClient,
  type InsulaQuotaMiss,
  type InsulaUsageEntry,
  recordVaultQuota,
} from '../../src/claustrum/index.ts'
import {
  mergeQuotaObservation,
  type QuotaObservation,
} from '../../src/quota/index.ts'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { cleanupDirs, family, tempDir, writeToken } from './helpers.ts'
import { type MockDaemon, startMockDaemon } from './mock-daemon.ts'

const { afterEach, test } = lifetimeHooks()
const consumers: Array<{ close(): void }> = []
const daemons: MockDaemon[] = []
afterEach(async () => {
  for (const consumer of consumers.splice(0)) consumer.close()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await cleanupDirs()
})

const NOW = Date.parse('2026-09-30T12:00:00Z')
function entry(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'codex',
    account: ' account-work ',
    source: 'vault',
    fetchedAt: new Date(NOW - 1_000).toISOString(),
    usage: { primary: { usedPercent: 20, rawUsedPercent: 80 } },
    ...overrides,
  }
}

async function scenario(entries = [entry()], refusal?: string) {
  const dir = await tempDir('insula-')
  const daemon = await startMockDaemon({
    directory: dir,
    credentials: {
      'oauth:test:work': {
        payload: 'access',
        account_id: 'account-work',
        record_version: 1,
        expires_at_ms: NOW + 3_600_000,
      },
      'oauth:test:other': {
        payload: 'other',
        account_id: 'account-other',
        record_version: 1,
        expires_at_ms: NOW + 3_600_000,
      },
    },
    insula: {
      response: { result: entries, completeProviders: ['codex'], pending: 0 },
      refusal,
    },
  })
  daemons.push(daemon)
  const tokenPath = await writeToken(dir)
  let now = NOW
  let active = true
  const seen: Array<{
    entry: InsulaUsageEntry
    fetchedAt: number
    source?: string
  }> = []
  const logs: Array<{ message: string; data: unknown }> = []
  const create = (project: string, token = tokenPath) => {
    const consumer = new ClaustrumConsumer({
      rosterPath: join(dir, `${project}-roster.json`),
      tokenPath: token,
      family,
      connect: () =>
        connectClaustrumScopedClient({
          connectionFile: daemon.connectionFile,
          identity: { project_root: dir, harness: 'test', session: project },
        }),
      isCustodyActive: () => active,
      now: () => now,
      logger: {
        debug() {},
        warn: (message, data) => logs.push({ message, data }),
      },
      insula: {
        provider: 'codex',
        normalize: (value, context): QuotaObservation | undefined => {
          seen.push({ entry: value, ...context })
          const window = value.usage?.primary
          if (!window) return undefined
          return {
            checkedAt: context.fetchedAt,
            readings: [
              {
                label: 'session',
                usedPercent: window.rawUsedPercent ?? window.usedPercent,
              },
            ],
          }
        },
      },
    })
    consumers.push(consumer)
    return consumer
  }
  const consumer = create('first')
  await consumer.refresh()
  const routeId = consumer
    .snapshot()!
    .rows.find((row) => row.accountIdentity === 'account-work')!.routeId
  const receipt = await consumer.authorize(routeId)
  const polls: string[] = []
  const poll = async (target = consumer, served = receipt) => {
    const cached = await target.cachedInsulaQuota(served)
    if (cached !== undefined) return cached
    polls.push(served.assertedAccountIdentity ?? 'unknown')
    return { checkedAt: now, readings: [{ label: 'session', usedPercent: 30 }] }
  }
  return {
    dir,
    daemon,
    consumer,
    receipt,
    routeId,
    polls,
    poll,
    seen,
    logs,
    create,
    tokenPath,
    setNow: (value: number) => {
      now = value
    },
    setActive: (value: boolean) => {
      active = value
    },
  }
}

test('current insula quota skips the own poll and retains source reading time', async () => {
  const s = await scenario()
  await s.consumer.refreshInsulaQuota()
  const reading = await s.poll()
  expect(s.polls).toEqual([])
  expect(reading).toEqual({
    checkedAt: NOW - 1_000,
    readings: [{ label: 'session', usedPercent: 80 }],
  })
  expect(s.seen[0]?.source).toBe('vault')
  const merged = mergeQuotaObservation(undefined, {
    checkedAt: NOW,
    readings: [{ label: 'session', usedPercent: 90 }],
  })
  expect(mergeQuotaObservation(merged, reading)).toEqual(merged)
})

async function lookupScenario(response: Record<string, unknown>) {
  const s = await scenario()
  s.daemon.insula!.response = response
  const client = await connectClaustrumScopedClient({
    connectionFile: s.daemon.connectionFile,
    identity: { project_root: s.dir, harness: 'test', session: 'lookup' },
  })
  consumers.push(client)
  const acquired = acquireInsulaQuotaSource(client.insula!, s.tokenPath)
  consumers.push({ close: () => acquired.release() })
  await acquired.source.refresh(NOW)
  return { ...s, source: acquired.source }
}

test('insula lookup classifies scripted misses and preserves current compatibility', async () => {
  const cases: Array<[Record<string, unknown>, InsulaQuotaMiss]> = [
    [{ result: [], completeProviders: [] }, 'cold'],
    [{ result: [], completeProviders: ['codex'] }, 'absent'],
    [{ result: [entry({ errorClass: 'upstream_failed' })] }, 'upstream-failed'],
    [
      {
        result: [
          entry({
            account: undefined,
            usage: undefined,
            errorClass: 'upstream_failed',
          }),
        ],
      },
      'upstream-failed',
    ],
    ...['credential_absent', 'credential_unusable', 'credential_rejected'].map(
      (errorClass): [Record<string, unknown>, InsulaQuotaMiss] => [
        { result: [entry({ errorClass })] },
        'credential',
      ],
    ),
    [
      { result: [entry({ fetchedAt: new Date(NOW - 240_000).toISOString() })] },
      'stale',
    ],
    [{ result: [entry({ stale: true })] }, 'stale'],
    [{ result: [entry({ errorClass: 'future_error' })] }, 'unreachable'],
    [{ result: [entry({ fetchedAt: 'invalid' })] }, 'unreachable'],
    [{ result: {} }, 'unreachable'],
    [{ error: { code: 'unavailable' } }, 'unreachable'],
  ]
  for (const [response, miss] of cases) {
    const s = await lookupScenario(response)
    expect(s.source.lookup('codex', 'account-work', NOW).miss).toBe(miss)
    expect(s.source.current('codex', 'account-work', NOW)).toBeUndefined()
    expect(
      await s.consumer.cachedInsulaQuotaForRoute(s.routeId),
    ).toBeUndefined()
  }
})

test('insula lookup returns dated stale readings and gives upstream failure precedence', async () => {
  const s = await lookupScenario({ result: [entry()] })
  const reading = s.source.current('codex', 'account-work', NOW)!
  expect(s.source.lookup('codex', 'account-work', NOW)).toEqual({ reading })
  expect(s.source.lookup('codex', 'account-work', NOW + 239_000)).toEqual({
    miss: 'stale',
    reading,
  })
  s.daemon.insula!.response = {
    result: [entry({ stale: true, errorClass: 'upstream_failed' })],
  }
  await s.source.refresh(NOW + 60_000)
  expect(s.source.lookup('codex', 'account-work', NOW + 60_000).miss).toBe(
    'upstream-failed',
  )
})

test('insula cold expires after two sweeps and completeness resets the bound', async () => {
  const s = await lookupScenario({ result: [], completeProviders: [] })
  expect(s.source.lookup('codex', 'account-work', NOW)).toEqual({
    miss: 'cold',
  })
  expect(s.source.lookup('codex', 'account-other', NOW + 119_999)).toEqual({
    miss: 'cold',
  })
  expect(s.source.lookup('codex', 'account-work', NOW + 120_000)).toEqual({
    miss: 'unreachable',
  })
  expect(s.source.lookup('claude', 'account-work', NOW + 120_000)).toEqual({
    miss: 'cold',
  })
  s.daemon.insula!.response = { result: [], completeProviders: ['codex'] }
  await s.source.refresh(NOW + 180_000)
  s.daemon.insula!.response = { result: [], completeProviders: [] }
  await s.source.refresh(NOW + 240_000)
  expect(s.source.lookup('codex', 'account-work', NOW + 240_000)).toEqual({
    miss: 'cold',
  })
})

test('background insula wrapper skips cold and upstream failure with transition-only safe logs', async () => {
  const s = await lookupScenario({ result: [], completeProviders: [] })
  const route = s.routeId
  let polls = 0
  const fallback = async () => {
    polls++
    return { checkedAt: NOW, readings: [] }
  }
  expect(
    await s.consumer.pollInsulaQuotaForRoute(route, fallback),
  ).toBeUndefined()
  await s.consumer.pollInsulaQuotaForRoute(route, fallback)
  expect(polls).toBe(0)
  expect(s.logs).toEqual([
    { message: 'skipped insula provider poll', data: { reason: 'cold' } },
  ])
  s.daemon.insula!.response = {
    result: [entry({ errorClass: 'upstream_failed' })],
  }
  s.setNow(NOW + 60_000)
  await s.consumer.refreshInsulaQuota()
  await s.consumer.pollInsulaQuotaForRoute(route, fallback)
  await s.consumer.pollInsulaQuotaForRoute(route, fallback)
  expect(polls).toBe(0)
  expect(s.logs).toEqual([
    { message: 'skipped insula provider poll', data: { reason: 'cold' } },
    {
      message: 'skipped insula provider poll',
      data: { reason: 'upstream-failed' },
    },
  ])
  expect(
    await s.consumer.recordQuota(
      route,
      { checkedAt: NOW, readings: [] },
      s.receipt,
    ),
  ).toBe(true)
  s.daemon.insula!.response = { result: [], completeProviders: ['codex'] }
  s.setNow(NOW + 120_000)
  await s.consumer.refreshInsulaQuota()
  await s.consumer.pollInsulaQuotaForRoute(route, fallback)
  expect(polls).toBe(1)
  s.daemon.insula!.response = { result: [], completeProviders: [] }
  s.setNow(NOW + 180_000)
  await s.consumer.refreshInsulaQuota()
  await s.consumer.pollInsulaQuotaForRoute(route, fallback)
  expect(s.logs.at(-1)).toEqual({
    message: 'skipped insula provider poll',
    data: { reason: 'cold' },
  })
  expect(s.logs).toHaveLength(3)
  s.setNow(NOW + 300_000)
  await s.consumer.pollInsulaQuotaForRoute(route, fallback)
  expect(polls).toBe(2)
})

test('background insula wrapper polls only stale absent credential and unreachable misses', async () => {
  for (const response of [
    { result: [entry({ fetchedAt: new Date(NOW - 240_000).toISOString() })] },
    {
      result: [entry({ account: 'account-other' })],
      completeProviders: ['codex'],
    },
    { result: [entry({ errorClass: 'credential_rejected' })] },
    { error: { code: 'unavailable' } },
  ]) {
    const s = await lookupScenario(response)
    let polls = 0
    const quota = { checkedAt: NOW, readings: [] }
    expect(
      await s.consumer.pollInsulaQuotaForRoute(s.routeId, async () => {
        polls++
        return quota
      }),
    ).toEqual(quota)
    expect(polls).toBe(1)
    expect(s.logs).toEqual([])
    const lookup = await s.consumer.lookupInsulaQuotaForRoute(s.routeId)
    if (lookup.miss === 'stale')
      expect(lookup.reading?.checkedAt).toBe(NOW - 240_000)
  }
  const s = await lookupScenario({ result: [entry()] })
  let polls = 0
  expect(
    await s.consumer.pollInsulaQuotaForRoute(s.routeId, async () => {
      polls++
      return undefined
    }),
  ).toEqual({
    checkedAt: NOW - 1_000,
    readings: [{ label: 'session', usedPercent: 80 }],
  })
  expect(polls).toBe(0)
})

test('route lookup hits a receipt-bound roster account without authorizing on the background path', async () => {
  const s = await scenario()
  s.daemon.credentials['oauth:test:work']!.wire = { account_id: undefined }
  const consumer = s.create('bound')
  await consumer.refresh()
  const row = consumer
    .snapshot()!
    .rows.find((row) => row.credentialId === 'oauth:test:work')!
  expect(row.accountIdentity).toBeUndefined()
  const receipt = await consumer.authorize(row.routeId)
  expect(
    await consumer.recordQuota(
      row.routeId,
      { checkedAt: NOW, readings: [] },
      receipt,
    ),
  ).toBe(true)
  expect(
    consumer.snapshot()!.rows.find((value) => value.routeId === row.routeId)
      ?.accountIdentity,
  ).toBe('account-work')
  await consumer.refreshInsulaQuota()
  const gets = s.daemon.gets.length
  const usageGets = s.daemon.usageGets
  expect(await consumer.cachedInsulaQuotaForRoute(row.routeId)).toEqual({
    checkedAt: NOW - 1_000,
    readings: [{ label: 'session', usedPercent: 80 }],
  })
  expect(s.daemon.gets).toHaveLength(gets)
  expect(s.daemon.usageGets).toBe(usageGets)
})

test('route lookup misses an unbound roster account without authorizing', async () => {
  const s = await scenario()
  s.daemon.credentials['oauth:test:work']!.wire = { account_id: undefined }
  const consumer = s.create('unbound')
  await consumer.refresh()
  await consumer.refreshInsulaQuota()
  const row = consumer
    .snapshot()!
    .rows.find((value) => value.credentialId === 'oauth:test:work')!
  const gets = s.daemon.gets.length
  expect(await consumer.cachedInsulaQuotaForRoute(row.routeId)).toBeUndefined()
  expect(s.daemon.gets).toHaveLength(gets)
  expect(s.daemon.usageGets).toBe(1)
})

test('route lookup misses after a peer commits a known account replacement', async () => {
  const s = await scenario()
  await s.consumer.refreshInsulaQuota()
  const row = s.consumer
    .snapshot()!
    .rows.find((value) => value.accountIdentity === 'account-work')!
  expect(await s.consumer.cachedInsulaQuotaForRoute(row.routeId)).toBeDefined()
  const peer = new ClaustrumConsumer({
    rosterPath: join(s.dir, 'first-roster.json'),
    tokenPath: s.tokenPath,
    family,
    connect: () =>
      connectClaustrumScopedClient({
        connectionFile: s.daemon.connectionFile,
        identity: {
          project_root: s.dir,
          harness: 'test',
          session: 'replacement-peer',
        },
      }),
    now: () => NOW,
  })
  consumers.push(peer)
  s.daemon.credentials['oauth:test:work']!.account_id = 'replacement-account'
  await peer.refresh()
  const replacement = peer
    .snapshot()!
    .rows.find((value) => value.accountIdentity === 'replacement-account')!
  expect(replacement.routeId).not.toBe(row.routeId)
  expect(
    s.consumer.snapshot()!.rows.find((value) => value.routeId === row.routeId)
      ?.accountIdentity,
  ).toBe('account-work')
  const gets = s.daemon.gets.length
  expect(
    await s.consumer.cachedInsulaQuotaForRoute(row.routeId),
  ).toBeUndefined()
  expect(
    await s.consumer.cachedInsulaQuotaForRoute(replacement.routeId),
  ).toBeUndefined()
  expect(s.daemon.gets).toHaveLength(gets)
  expect(s.daemon.usageGets).toBe(1)
})

test('an account quota write lands on its bound route without a vault call and is visible at once', async () => {
  const s = await scenario()
  const row = s.consumer
    .snapshot()!
    .rows.find((value) => value.accountIdentity === 'account-work')!
  const gets = s.daemon.gets.length
  const lists = s.daemon.lists
  expect(
    await s.consumer.recordAccountQuota(row.routeId, 'account-work', {
      checkedAt: NOW - 1_000,
      readings: [{ label: 'session', usedPercent: 80 }],
    }),
  ).toBe(true)
  expect(
    s.consumer.snapshot()!.rows.find((value) => value.routeId === row.routeId)
      ?.quota,
  ).toBeDefined()
  expect(s.daemon.gets).toHaveLength(gets)
  expect(s.daemon.lists).toBe(lists)
})

test('account and served-vault counter writes persist for a second consumer', async () => {
  const s = await scenario()
  const path = join(s.dir, 'first-roster.json')
  const routeId = s.consumer
    .snapshot()!
    .rows.find((row) => row.accountIdentity === 'account-work')!.routeId
  const counter = { resetCredits: { value: 4, checkedAt: NOW - 1_000 } }
  expect(
    await s.consumer.recordAccountQuota(routeId, 'account-work', {
      checkedAt: NOW,
      counters: counter,
    }),
  ).toBe(true)
  expect(
    JSON.parse(await readFile(path, 'utf8')).rows.find(
      (row: { routeId: string }) => row.routeId === routeId,
    ).quota.counters,
  ).toEqual(counter)
  const peer = s.create('first')
  await peer.refresh()
  expect(
    peer.snapshot()!.rows.find((row) => row.routeId === routeId)?.quota
      ?.counters,
  ).toEqual(counter)
  const newer = { resetCredits: { value: 2, checkedAt: NOW } }
  expect(
    await recordVaultQuota(path, {
      ...s.receipt,
      routeId,
      observation: { checkedAt: NOW - 2_000, counters: newer },
    }),
  ).toBe(true)
  expect(
    JSON.parse(await readFile(path, 'utf8')).rows.find(
      (row: { routeId: string }) => row.routeId === routeId,
    ).quota.counters,
  ).toEqual(newer)
  await peer.refresh()
  expect(
    peer.routingRows().find((row) => row.id === routeId)?.quota?.counters,
  ).toEqual(newer)
})

test('an account quota write is refused for another account or an unbound route', async () => {
  const s = await scenario()
  s.daemon.credentials['oauth:test:work']!.wire = { account_id: undefined }
  const consumer = s.create('account-fence')
  await consumer.refresh()
  const unbound = consumer
    .snapshot()!
    .rows.find((value) => value.credentialId === 'oauth:test:work')!
  expect(unbound.accountIdentity).toBeUndefined()
  const reading = { checkedAt: NOW, readings: [] }
  expect(
    await consumer.recordAccountQuota(unbound.routeId, 'account-work', reading),
  ).toBe(false)
  const bound = consumer
    .snapshot()!
    .rows.find((value) => value.accountIdentity !== undefined)!
  expect(
    await consumer.recordAccountQuota(bound.routeId, 'someone-else', reading),
  ).toBe(false)
  expect(
    consumer.snapshot()!.rows.find((value) => value.routeId === bound.routeId)
      ?.quota,
  ).toEqual(bound.quota)
})

test('a pending insula deadline does not keep an otherwise idle host process alive', async () => {
  const started = Date.now()
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    import { insulaUsageTransport } from ${JSON.stringify(new URL('../../src/claustrum/insula.ts', import.meta.url).href)}
    const transport = insulaUsageTransport({
      connectionFile: '/unused',
      identity: { project_root: '/unused', harness: 'test', session: 'idle' },
      connector: () => { console.log('connector entered'); return new Promise(() => {}) },
    })
    void transport.getUsage().catch(() => {})
  `,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code).toBe(0)
    expect(stdout).toContain('connector entered')
    expect(stderr).toBe('')
    expect(Date.now() - started).toBeLessThan(2_000)
  } finally {
    child.kill()
  }
})

test.each([
  ['stale', entry({ stale: false })],
  ['old', entry({ fetchedAt: new Date(NOW - 240_000).toISOString() })],
  [
    'degraded',
    entry({
      errorClass: 'credential_rejected',
      error: 'not a freshness signal',
    }),
  ],
  [
    'wrong account_id',
    entry({ account: 'different', accountInfo: { email: 'account-work' } }),
  ],
  [
    'email-only',
    entry({ account: undefined, accountInfo: { email: 'account-work' } }),
  ],
  ['wrong provider', entry({ provider: 'claude' })],
  ['missing timestamp', entry({ fetchedAt: undefined })],
  ['malformed timestamp', entry({ fetchedAt: 'not-a-date' })],
] as const)(
  '%s insula quota falls back to the own poll',
  async (_kind, value) => {
    const s = await scenario([value])
    await s.consumer.refreshInsulaQuota()
    await s.poll()
    expect(s.polls).toEqual(['account-work'])
    expect(s.seen).toEqual([])
  },
)

test.each([{ completeProviders: [] }, { completeProviders: ['codex'] }])(
  'missing insula account falls back only for that account with completeProviders %j',
  async ({ completeProviders }) => {
    const s = await scenario()
    s.daemon.insula!.response.completeProviders = completeProviders
    await s.consumer.refreshInsulaQuota()
    await s.poll()
    const other = await s.consumer.authorize(
      s.consumer
        .snapshot()!
        .rows.find((row) => row.accountIdentity === 'account-other')!.routeId,
    )
    await s.poll(s.consumer, other)
    expect(s.polls).toEqual(['account-other'])
  },
)

test.each([
  'unknown_module',
  'module_removed',
  'module_warming',
  'target_unavailable',
  'module_reloading',
  'capability_denied',
])(
  'insula refusal %s falls back immediately without retry',
  async (refusal) => {
    const s = await scenario([entry()], refusal)
    await s.consumer.refreshInsulaQuota()
    await s.poll()
    expect(s.polls).toEqual(['account-work'])
    expect(s.daemon.insulaOpens).toBe(1)
    expect(s.daemon.usageGets).toBe(0)
    expect(await s.consumer.lookupInsulaQuotaForRoute(s.routeId)).toEqual({
      miss: 'unreachable',
    })
  },
)

test('insula refusal invalidates a previously current cache', async () => {
  const s = await scenario()
  await s.consumer.refreshInsulaQuota()
  s.daemon.insula!.refusal = 'module_removed'
  s.setNow(NOW + 60_000)
  await s.consumer.refreshInsulaQuota()
  await s.poll()
  expect(s.polls).toEqual(['account-work'])
})

test('several projects share one insula usage.get per minute and release independently', async () => {
  const s = await scenario()
  const second = s.create('second')
  const third = s.create('third')
  await Promise.all([second.refresh(), third.refresh()])
  await Promise.all([
    s.consumer.refreshInsulaQuota(),
    second.refreshInsulaQuota(),
    third.refreshInsulaQuota(),
  ])
  expect(s.daemon.usageGets).toBe(1)
  s.consumer.close()
  s.setNow(NOW + 59_999)
  await second.refreshInsulaQuota()
  await s.poll(second)
  expect(s.daemon.usageGets).toBe(1)
  expect(s.polls).toEqual([])
  s.setNow(NOW + 60_000)
  await third.refreshInsulaQuota()
  expect(s.daemon.usageGets).toBe(2)
})

test('on demand takes only cached insula quota and ages it by the injected clock', async () => {
  const s = await scenario()
  await s.poll()
  expect(s.daemon.usageGets).toBe(0)
  await s.consumer.refreshInsulaQuota()
  await s.poll()
  expect(s.polls).toEqual(['account-work'])
  s.setNow(NOW + 239_000)
  await s.poll()
  expect(s.polls).toEqual(['account-work', 'account-work'])
  expect(s.daemon.usageGets).toBe(1)
})

test('standalone and not enrolled consumers never call insula', async () => {
  const s = await scenario()
  s.setActive(false)
  await s.consumer.refreshInsulaQuota()
  await s.poll()
  s.setActive(true)
  const unenrolled = s.create('unenrolled', join(s.dir, 'absent-token.json'))
  await unenrolled.refreshInsulaQuota()
  await s.poll(unenrolled)
  expect(s.polls).toEqual(['account-work', 'account-work'])
  expect(s.daemon.insulaOpens).toBe(0)
})

test('parsed or expected receipt identity is not a vault account_id for insula', async () => {
  const s = await scenario()
  await s.consumer.refreshInsulaQuota()
  await s.poll(s.consumer, {
    ...s.receipt,
    assertedAccountIdentity: undefined,
    accountIdentitySource: 'parsed',
  })
  expect(s.polls).toEqual(['unknown'])
})

test.each(['open', 'usage'] as const)(
  'hung insula %s falls back within the whole-call deadline and closes its socket',
  async (hang) => {
    const s = await scenario()
    s.daemon.insula!.hang = hang
    const closed = new Promise<void>((resolve) => {
      s.daemon.onInsulaClose = resolve
    })
    const started = Date.now()
    await s.consumer.refreshInsulaQuota()
    await s.poll()
    expect(Date.now() - started).toBeLessThan(4_500)
    expect(s.polls).toEqual(['account-work'])
    await closed
    expect(s.daemon.insulaOpens).toBe(1)
    expect(s.daemon.usageGets).toBe(hang === 'usage' ? 1 : 0)
    expect(await s.consumer.lookupInsulaQuotaForRoute(s.routeId)).toEqual({
      miss: 'unreachable',
    })
  },
)

test('different enrollment token paths never share insula cache or minute budget', async () => {
  const s = await scenario()
  await s.consumer.refreshInsulaQuota()
  const otherDir = await tempDir('insula-principal-')
  const other = s.create('other-principal', await writeToken(otherDir))
  await other.refresh()
  await s.poll(other)
  expect(s.polls).toEqual(['account-work'])
  await other.refreshInsulaQuota()
  await s.poll(other)
  expect(s.polls).toEqual(['account-work'])
  expect(s.daemon.usageGets).toBe(2)
})

test('closing the last project does not reset the insula minute budget', async () => {
  const s = await scenario()
  await s.consumer.refreshInsulaQuota()
  s.consumer.close()
  const replacement = s.create('replacement')
  await replacement.refreshInsulaQuota()
  await s.poll(replacement)
  expect(s.polls).toEqual(['account-work'])
  expect(s.daemon.usageGets).toBe(1)
  s.setNow(NOW + 60_000)
  await replacement.refreshInsulaQuota()
  await s.poll(replacement)
  expect(s.polls).toEqual(['account-work'])
  expect(s.daemon.usageGets).toBe(2)
})

test('insula module errors and malformed envelopes fall back without caching a reading', async () => {
  for (const response of [
    { error: { code: 'unavailable' } },
    { result: {} },
    { result: [entry()], error: { code: 'refused' } },
  ]) {
    const s = await scenario()
    s.daemon.insula!.response = response
    await s.consumer.refreshInsulaQuota()
    await s.poll()
    expect(s.polls).toEqual(['account-work'])
  }
})

test('the existing consumer tick drives insula without a separate timer', async () => {
  const s = await scenario()
  let scheduled = 0
  const consumer = new ClaustrumConsumer({
    rosterPath: join(s.dir, 'tick-roster.json'),
    tokenPath: s.tokenPath,
    family,
    connect: () =>
      connectClaustrumScopedClient({
        connectionFile: s.daemon.connectionFile,
        identity: { project_root: s.dir, harness: 'test', session: 'tick' },
      }),
    now: () => NOW,
    insula: { provider: 'codex', normalize: () => undefined },
    setTimeoutImpl: (() => {
      scheduled++
      done()
      return { unref() {} }
    }) as unknown as typeof setTimeout,
    clearTimeoutImpl: (() => {}) as typeof clearTimeout,
  })
  consumers.push(consumer)
  let done!: () => void
  const tick = new Promise<void>((resolve) => {
    done = resolve
  })
  consumer.start()
  await tick
  expect(scheduled).toBe(1)
  expect(s.daemon.usageGets).toBe(1)
})

test('a plugin normalizer may refuse an antigravity echo using source and fetchedAt', async () => {
  const s = await scenario([
    entry({ provider: 'antigravity', source: 'plugin' }),
  ])
  let now = NOW
  const consumer = new ClaustrumConsumer({
    rosterPath: join(s.dir, 'echo-roster.json'),
    tokenPath: s.tokenPath,
    family,
    connect: () =>
      connectClaustrumScopedClient({
        connectionFile: s.daemon.connectionFile,
        identity: { project_root: s.dir, harness: 'test', session: 'echo' },
      }),
    now: () => now,
    insula: {
      provider: 'antigravity',
      normalize: (_entry, context) =>
        context.source === 'vault' || context.fetchedAt > NOW
          ? { checkedAt: context.fetchedAt }
          : undefined,
    },
  })
  consumers.push(consumer)
  await consumer.refreshInsulaQuota()
  await s.poll(consumer)
  expect(s.polls).toEqual(['account-work'])
  s.daemon.insula!.response = {
    result: [entry({ provider: 'antigravity', source: 'vault' })],
  }
  now += 60_000
  await consumer.refreshInsulaQuota()
  await s.poll(consumer)
  expect(s.polls).toEqual(['account-work'])
  expect(s.daemon.usageGets).toBe(2)
  s.daemon.insula!.response = {
    result: [
      entry({
        provider: 'antigravity',
        source: 'plugin',
        fetchedAt: new Date(NOW + 50_000).toISOString(),
      }),
    ],
  }
  now += 60_000
  await consumer.refreshInsulaQuota()
  await s.poll(consumer)
  expect(s.polls).toEqual(['account-work'])
})

// A plugin whose vault mode runs on ClaustrumScopedCustody reads insula through
// the public source alone, with no ClaustrumConsumer: the same freshness gate
// and the same one-call-per-minute budget, and no scoped credential call.
test('the public insula source serves a plugin without a ClaustrumConsumer', async () => {
  const dir = await tempDir('insula-reader-')
  const daemon = await startMockDaemon({
    directory: dir,
    credentials: {},
    insula: {
      response: {
        result: [
          entry(),
          entry({ account: 'account-stale', stale: true }),
          entry({
            account: 'account-old',
            fetchedAt: new Date(NOW - 4 * 60_000).toISOString(),
          }),
        ],
      },
    },
  })
  daemons.push(daemon)
  const tokenPath = await writeToken(dir)
  const client = await connectClaustrumScopedClient({
    connectionFile: daemon.connectionFile,
    identity: { project_root: dir, harness: 'test', session: 'reader' },
  })
  consumers.push(client)
  const first = acquireInsulaQuotaSource(client.insula!, tokenPath)
  const second = acquireInsulaQuotaSource(client.insula!, tokenPath)
  try {
    expect(second.source).toBe(first.source)
    await first.source.refresh(NOW)
    await second.source.refresh(NOW + 1_000)
    expect(daemon.usageGets).toBe(1)
    const hit = first.source.current('codex', 'account-work', NOW)
    expect(hit?.context.fetchedAt).toBe(NOW - 1_000)
    expect(hit?.entry.usage?.primary?.rawUsedPercent).toBe(80)
    expect(first.source.current('codex', 'account-stale', NOW)).toBeUndefined()
    expect(first.source.current('codex', 'account-old', NOW)).toBeUndefined()
    expect(first.source.current('claude', 'account-work', NOW)).toBeUndefined()
  } finally {
    first.release()
    second.release()
  }
})
