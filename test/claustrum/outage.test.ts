import { expect } from 'bun:test'
import { join } from 'node:path'
import { ClaustrumCredentialError } from '@cortexkit/claustrum-client'
import { SubcClient } from '@cortexkit/subc-client'
import {
  ClaustrumConsumer,
  type ClaustrumScopedAttempt,
  type ClaustrumScopedClient,
  ClaustrumScopedCustody,
  connectClaustrumScopedClient,
} from '../../src/claustrum/index.ts'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import {
  captureLogger,
  cleanupDirs,
  clientWatches,
  fakeTimers,
  family,
  tempDir,
  unknownGrants,
  until,
  writeToken,
} from './helpers.ts'
import { type MockDaemon, startMockDaemon } from './mock-daemon.ts'

const { test, afterEach, lifetime } = lifetimeHooks()
const daemons: MockDaemon[] = []
afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await cleanupDirs()
})
const ID = 'oauth:test:work'
const identity = {
  credentialId: ID,
  credentialType: 'oauth' as const,
  accountIdentity: 'work',
}
const flush = async () => {
  for (let turn = 0; turn < 30; turn++) await Promise.resolve()
}

async function scenario() {
  const dir = await tempDir('claustrum-outage-')
  let now = 1_000_000
  const daemon = await startMockDaemon({
    directory: dir,
    credentials: {
      [ID]: {
        payload: 'kept',
        account_id: 'work',
        record_version: 1,
        expires_at_ms: now + 3_600_000,
      },
    },
  })
  daemons.push(daemon)
  const connected = await connectClaustrumScopedClient({
    connectionFile: daemon.connectionFile,
    connector: (options) =>
      SubcClient.connect({ ...options, sleep: async () => {} }),
    identity: { project_root: dir, harness: 'test', session: 'outage' },
    logger: () => {},
  })
  const timers = fakeTimers()
  const logs = captureLogger()
  const calls = { gets: 0, lists: 0 }
  let get: ClaustrumScopedClient['getScoped'] = (input) =>
    connected.getScoped(input)
  let list: ClaustrumScopedClient['listScoped'] = (token) =>
    connected.listScoped(token)
  const client: ClaustrumScopedClient = {
    getScoped: (input) => {
      calls.gets++
      return get(input)
    },
    listScoped: (token) => {
      calls.lists++
      return list(token)
    },
    reportAuthFailureScoped: (input) =>
      connected.reportAuthFailureScoped(input),
    close: () => connected.close(),
  }
  const custody = lifetime.manage(
    new ClaustrumScopedCustody({
      client,
      family,
      now: () => now,
      readToken: async () => ({ token: 'ab'.repeat(32), token_generation: 1 }),
      logger: logs.logger,
      ...timers,
    }),
  )
  return {
    custody,
    daemon,
    timers: {
      ...timers,
      fire(delay: number) {
        now += delay
        timers.fire(delay)
      },
    },
    logs,
    calls,
    dir,
    connected,
    advance: (ms: number) => {
      now += ms
    },
    setGet: (value: typeof get) => {
      get = value
    },
    setList: (value: typeof list) => {
      list = value
    },
  }
}

test('outage kept authorizations never wait for foreground or background transport', async () => {
  const s = await scenario()
  await s.custody.authorize(identity)
  s.daemon.outage = true
  await s.custody.authorize(identity)
  const gets = s.calls.gets
  // Neither foreground nor background transport can settle; memory must still serve.
  s.setGet(() => new Promise(() => {}))
  s.setList(() => new Promise(() => {}))
  for (let request = 0; request < 3; request++) {
    let settled = false
    let receipt: ClaustrumScopedAttempt | undefined
    void s.custody.authorize(identity).then((value) => {
      receipt = value
      settled = true
    })
    await flush()
    expect(settled).toBe(true)
    expect(s.calls.gets).toBe(gets)
    expect(receipt?.fromKeptReceipt).toBe(true)
    expect(receipt?.accessToken).toBe('kept')
  }
  expect(s.calls.lists).toBe(1)
  expect(s.timers.pending()).toEqual([2_000])
  expect(s.logs.records.filter((r) => r.level === 'warn')).toEqual([
    {
      level: 'warn',
      message: 'serving kept vault receipt',
      data: { reason: 'unreachable' },
    },
  ])
})

async function backedOffOutage() {
  const s = await scenario()
  await s.custody.authorize(identity)
  s.custody.transportLost()
  s.setList(async () => {
    throw Object.assign(new Error('transport lost'), { code: 'ECONNREFUSED' })
  })
  for (const delay of [2_000, 4_000, 8_000, 16_000]) {
    s.timers.fire(delay)
    await flush()
  }
  expect(s.timers.pending()).toEqual([30_000])
  return s
}

test('outage send probe honors grant refusal within one second despite idle backoff', async () => {
  const s = await backedOffOutage()
  const refusal = new ClaustrumCredentialError(
    'grant_denied',
    'permanent',
    'gone',
  )
  let rejectList: (error: unknown) => void = () => {}
  s.setList(
    () =>
      new Promise((_resolve, reject) => {
        rejectList = reject
      }),
  )
  s.setGet(async () => {
    throw refusal
  })
  s.advance(999)
  expect((await s.custody.authorize(identity)).fromKeptReceipt).toBe(true)
  expect(s.calls.lists).toBe(4)
  s.advance(1)
  expect((await s.custody.authorize(identity)).fromKeptReceipt).toBe(true)
  await flush()
  expect(s.calls.lists).toBe(5)
  rejectList(refusal)
  await flush()
  expect(s.timers.pending()).toEqual([])
  await expect(s.custody.authorize(identity)).rejects.toBe(refusal)
  expect(s.custody.keptReceiptState().active).toBe(false)
  // Re-entering an outage cannot resurrect receipts discarded by the refusal.
  s.custody.transportLost()
  s.setGet(async () => {
    throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' })
  })
  await expect(s.custody.authorize(identity)).rejects.toMatchObject({
    kind: 'unavailable',
  })
})

test('outage send probe resumes fresh authorization within one second despite idle backoff', async () => {
  const s = await backedOffOutage()
  s.setList(async () => ({ rows: [], view: 'recovered', ...unknownGrants }))
  s.daemon.credentials[ID] = {
    payload: 'recovered',
    account_id: 'work',
    record_version: 2,
    expires_at_ms: 5_000_000,
  }
  s.advance(1_000)
  expect((await s.custody.authorize(identity)).fromKeptReceipt).toBe(true)
  await flush()
  expect(s.calls.lists).toBe(5)
  expect(s.timers.pending()).toEqual([])
  const next = await s.custody.authorize(identity)
  expect(next.fromKeptReceipt).toBeUndefined()
  expect(next.recordVersion).toBe(2)
  expect(next.accessToken).toBe('recovered')
})

test('outage send probes are limited to one per second across bursts of fifty', async () => {
  const s = await scenario()
  await s.custody.authorize(identity)
  s.custody.transportLost()
  s.setList(async () => {
    throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' })
  })
  for (let second = 0; second < 3; second++) {
    for (let request = 0; request < 50; request++) {
      expect((await s.custody.authorize(identity)).fromKeptReceipt).toBe(true)
      await flush()
      expect(s.calls.lists).toBe(second + 1)
      s.advance(20)
    }
  }
  expect(s.calls.gets).toBe(1)
  // Failed send probes neither grow nor restart the idle timer's backoff.
  expect(s.timers.pending()).toEqual([2_000])
  s.timers.fire(2_000)
  await flush()
  expect(s.calls.lists).toBe(4)
  expect(s.timers.pending()).toEqual([4_000])
})

test('outage send probes share a single flight with the idle timer', async () => {
  const s = await scenario()
  await s.custody.authorize(identity)
  s.custody.transportLost()
  let rejectList: (error: unknown) => void = () => {}
  s.setList(
    () =>
      new Promise((_resolve, reject) => {
        rejectList = reject
      }),
  )
  expect((await s.custody.authorize(identity)).fromKeptReceipt).toBe(true)
  await flush()
  expect(s.calls.lists).toBe(1)
  s.timers.fire(2_000)
  for (let request = 0; request < 50; request++) {
    s.advance(1_000)
    expect((await s.custody.authorize(identity)).fromKeptReceipt).toBe(true)
    await flush()
    expect(s.calls.lists).toBe(1)
  }
  rejectList(Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }))
  await flush()
  expect(s.timers.pending()).toEqual([2_000])
  expect((await s.custody.authorize(identity)).fromKeptReceipt).toBe(true)
  await flush()
  expect(s.calls.lists).toBe(2)
})

for (const recovered of [true, false]) {
  test(`outage account without a kept receipt tries fresh with recovered=${recovered}`, async () => {
    const s = await scenario()
    await s.custody.authorize(identity)
    s.custody.transportLost()
    const unreachable = Object.assign(new Error('offline'), {
      code: 'ECONNREFUSED',
    })
    // Use a classified vault error to verify the original unreachable error survives.
    const failure = new ClaustrumCredentialError(
      'unavailable',
      'transient',
      'retry',
    )
    s.setGet(async (input) => {
      if (!recovered) throw failure
      return {
        credentialId: input.credentialId,
        accountId: 'work',
        material: 'new-account',
        recordVersion: 2,
        expiresAtMs: 5_000_000,
      }
    })
    const fresh = s.custody.authorize({
      ...identity,
      credentialId: 'oauth:test:new',
    })
    if (recovered) {
      expect((await fresh).fromKeptReceipt).toBeUndefined()
      expect(s.timers.pending()).toEqual([])
      expect(
        (await s.custody.authorize(identity)).fromKeptReceipt,
      ).toBeUndefined()
      expect(s.calls.gets).toBe(3)
    } else {
      await expect(fresh).rejects.toBe(failure)
      expect(s.calls.gets).toBe(2)
      expect(s.timers.pending()).toEqual([2_000])
      s.setList(async () => {
        throw unreachable
      })
      expect((await s.custody.authorize(identity)).fromKeptReceipt).toBe(true)
    }
  })
}

test('outage close stops send probes and ignores an in flight recovery answer', async () => {
  const s = await scenario()
  await s.custody.authorize(identity)
  s.custody.transportLost()
  let resolveList: (
    value: Awaited<ReturnType<ClaustrumScopedClient['listScoped']>>,
  ) => void = () => {}
  s.setList(
    () =>
      new Promise((resolve) => {
        resolveList = resolve
      }),
  )
  await s.custody.authorize(identity)
  await flush()
  expect(s.calls.lists).toBe(1)
  s.custody.close()
  resolveList({ rows: [], view: 'too-late', ...unknownGrants })
  await flush()
  s.advance(30_000)
  await expect(s.custody.authorize(identity)).rejects.toMatchObject({
    kind: 'closed',
  })
  expect(s.timers.pending()).toEqual([])
  expect(s.calls.lists).toBe(1)
  expect(s.logs.records.filter((r) => r.level === 'info')).toEqual([])
})

test('outage probe is single flight and backs off from two to thirty seconds', async () => {
  const s = await scenario()
  await s.custody.authorize(identity)
  s.daemon.outage = true
  await s.custody.authorize(identity)
  let rejectList: (error: unknown) => void = () => {}
  s.setList(
    () =>
      new Promise((_resolve, reject) => {
        rejectList = reject
      }),
  )
  for (const delay of [2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    expect(s.timers.pending()).toEqual([delay])
    const before = s.calls.lists
    s.timers.fire(delay)
    await flush()
    expect(s.calls.lists).toBe(before + 1)
    s.custody.transportLost()
    await s.custody.authorize(identity)
    expect(s.timers.pending()).toEqual([])
    expect(s.calls.lists).toBe(before + 1)
    rejectList(
      Object.assign(new Error('transport lost'), { code: 'ECONNREFUSED' }),
    )
    await flush()
  }
  expect(s.timers.pending()).toEqual([30_000])
})

test('outage cannot overlap a pending probe from an earlier outage', async () => {
  const s = await scenario()
  s.custody.transportLost()
  let rejectList: (error: unknown) => void = () => {}
  s.setList(
    () =>
      new Promise((_resolve, reject) => {
        rejectList = reject
      }),
  )
  s.timers.fire(2_000)
  await flush()
  s.custody.reachable()
  s.custody.transportLost()
  expect(s.timers.pending()).toEqual([])
  expect(s.calls.lists).toBe(1)
  rejectList(
    Object.assign(new Error('transport lost'), { code: 'ECONNREFUSED' }),
  )
  await flush()
  expect(s.timers.pending()).toEqual([4_000])
})

// Needs a claustrum-client with watchScoped (0.12.0); the floor job runs 0.6.2,
// which has no watch, so this path can't occur there.
test.if(clientWatches)(
  'outage watch transport loss enters fallback before the next authorization',
  async () => {
    const s = await scenario()
    s.daemon.vaultWatch = 'accept'
    const consumer = lifetime.manage(
      new ClaustrumConsumer({
        rosterPath: join(s.dir, 'roster.json'),
        tokenPath: await writeToken(s.dir),
        family,
        connect: async () => s.connected,
        now: () => 1_000_000,
        logger: s.logs.logger,
        ...s.timers,
      }),
    )
    await consumer.refresh()
    consumer.start()
    await until(() => consumer.watchState().vault === 'watching')
    const route = consumer.snapshot()?.rows[0]?.routeId
    if (!route) throw new Error('missing route')
    await consumer.authorize(route)
    await s.daemon.stop()
    await until(() => s.logs.records.some((r) => r.level === 'warn'))
    expect(s.timers.pending()).toContain(2_000)
    const kept = await consumer.authorize(route)
    expect(kept.fromKeptReceipt).toBe(true)
  },
)

test('outage probe recovery makes the next authorization fresh at the new version', async () => {
  const s = await scenario()
  await s.custody.authorize(identity)
  s.daemon.outage = true
  await s.custody.authorize(identity)
  s.timers.fire(2_000)
  await until(() => s.timers.pending().includes(4_000))
  s.daemon.outage = false
  const record = s.daemon.credentials[ID]
  if (!record) throw new Error('missing record')
  record.payload = 'fresh'
  record.record_version = 2
  s.timers.fire(4_000)
  await until(() => s.logs.records.some((r) => r.level === 'info'))
  const fresh = await s.custody.authorize(identity)
  expect(fresh.fromKeptReceipt).toBeUndefined()
  expect(fresh.recordVersion).toBe(2)
  expect(fresh.accessToken).toBe('fresh')
  expect(s.calls.gets).toBe(3)
  expect(s.calls.lists).toBe(2)
  expect(s.timers.pending()).toEqual([])
  expect(s.logs.records.filter((r) => r.level === 'info')).toEqual([
    {
      level: 'info',
      message: 'vault receipt serving resumed',
      data: { reason: 'reachable' },
    },
  ])
  s.daemon.outage = true
  await s.custody.authorize(identity)
  expect(s.timers.pending()).toEqual([2_000])
})

test('outage probe refusal drops receipts and ends transport fallback', async () => {
  const s = await scenario()
  await s.custody.authorize(identity)
  s.daemon.outage = true
  await s.custody.authorize(identity)
  s.daemon.outage = false
  s.daemon.revoked = true
  s.timers.fire(2_000)
  await until(() => s.logs.records.some((r) => r.level === 'info'))
  await flush()
  expect(s.timers.pending()).toEqual([])
  s.daemon.outage = true
  await expect(s.custody.authorize(identity)).rejects.toMatchObject({
    code: 'transport_error',
  })
  expect(s.calls.gets).toBe(3)
  expect(s.custody.keptReceiptState().active).toBe(false)
})

test('outage list failure enters fallback and any successful call cancels its probe', async () => {
  const s = await scenario()
  await s.custody.authorize(identity)
  s.daemon.outage = true
  await expect(s.custody.discover()).rejects.toBeDefined()
  s.setGet(() => new Promise(() => {}))
  let settled = false
  void s.custody.authorize(identity).then(() => {
    settled = true
  })
  await flush()
  expect(settled).toBe(true)
  expect(s.calls.gets).toBe(1)
  s.daemon.outage = false
  await s.custody.discover()
  expect(s.timers.pending()).toEqual([])
})

test('outage close cancels the probe and an in flight probe cannot rearm it', async () => {
  for (const inFlight of [false, true]) {
    const s = await scenario()
    s.custody.transportLost()
    let rejectList: (error: unknown) => void = () => {}
    s.setList(
      () =>
        new Promise((_resolve, reject) => {
          rejectList = reject
        }),
    )
    if (inFlight) {
      s.timers.fire(2_000)
      await flush()
    }
    s.custody.close()
    rejectList(
      Object.assign(new Error('transport lost'), { code: 'ECONNREFUSED' }),
    )
    await flush()
    expect(s.timers.pending()).toEqual([])
  }
})

test('outage probe timer is unreferenced', async () => {
  const s = await scenario()
  let timer: ReturnType<typeof setTimeout> | undefined
  const custody = lifetime.manage(
    new ClaustrumScopedCustody({
      client: {
        getScoped: async () => {
          throw new Error('unused')
        },
        listScoped: async () => {
          throw new Error('unused')
        },
        reportAuthFailureScoped: async () => {},
        close() {},
      },
      family,
      readToken: async () => ({ token: 'ab'.repeat(32), token_generation: 1 }),
      setTimeoutImpl: ((run: () => void, delay: number) => {
        timer = setTimeout(run, delay)
        return timer
      }) as typeof setTimeout,
      logger: s.logs.logger,
    }),
  )
  custody.transportLost()
  expect(timer?.hasRef()).toBe(false)
})
