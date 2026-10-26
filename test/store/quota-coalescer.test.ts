import { expect } from 'bun:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { type QuotaMap, quotaCodec } from '../../src/quota/index.js'
import type { PoolStore } from '../../src/store/index.js'
import { POOL_QUOTA_QUEUE_LIMIT } from '../../src/store/quota-writer.js'
import {
  acquirePoolLock,
  POOL_LOCK_DEFAULTS,
} from '../../src/store/refresh-lock.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { manualQuotaTimer } from '../quota/commit-timer.js'
import { deferred, oauth, scenario } from './helpers.js'

const hooks = lifetimeHooks()
const { test, afterEach } = hooks
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})
const fence = { credentialEpoch: 1 }
const reading = (checkedAt: number, usedPercent = 20) => ({
  checkedAt,
  readings: [{ label: '5h', usedPercent }],
})

async function fixture() {
  const s = hooks.lifetime.manage(await scenario())
  cleanups.push(() => s.cleanup())
  const plain = s.open({ quota: quotaCodec })
  await plain.add({ id: 'a', credential: oauth('a') })
  const warnings: string[] = []
  const store = s.open({
    quota: quotaCodec,
    coalesceQuota: true,
    logger: {
      warn: (message) => {
        warnings.push(message)
      },
    },
  })
  hooks.lifetime.finish(() => store.dispose())
  return { s, plain, store, warnings }
}

async function quota(store: PoolStore): Promise<QuotaMap | undefined> {
  const load = await store.read()
  if (load.status !== 'ready') throw new Error('pool not ready')
  return load.rows[0]?.quota as QuotaMap | undefined
}

test('50 pool publications within the commit interval make one commit with the newest fields', async () => {
  const { s, plain } = await fixture()
  const timer = manualQuotaTimer()
  let commits = 0
  const store = s.open({
    quota: quotaCodec,
    coalesceQuota: true,
    quotaCommitTimer: timer.clock,
    onStep: (step) => {
      if (step === 'after-config-write') commits++
    },
  })
  hooks.lifetime.finish(() => store.dispose())
  await store.recordQuota('a', fence, reading(1))
  await timer.advance(100)
  commits = 0
  for (let i = 1; i <= 50; i++) {
    await store.recordQuota('a', fence, {
      ...reading(i + 1, i),
      ...(i === 1 && { counters: { tokens: { checkedAt: 500, value: 42 } } }),
    })
    await timer.advance(500)
  }
  expect(commits).toBe(0)
  const memory = await quota(store)
  expect(memory?.limits[0]).toMatchObject({ checkedAt: 51, usedPercent: 50 })
  expect(memory?.counters?.tokens).toEqual({ checkedAt: 500, value: 42 })
  expect((await quota(plain))?.limits[0]).toMatchObject({ checkedAt: 1 })
  await timer.advance(5_000)
  expect(commits).toBe(1)
  expect(await quota(plain)).toEqual(memory)

  await timer.advance(30_000)
  await store.recordQuota('a', fence, reading(100, 80))
  await timer.advance(100)
  expect(commits).toBe(2)
  expect((await quota(plain))?.limits[0]).toMatchObject({
    checkedAt: 100,
    usedPercent: 80,
  })
  await store.recordQuota('a', fence, reading(101, 90))
  await store.dispose()
  expect(commits).toBe(3)
  expect((await quota(plain))?.limits[0]).toMatchObject({ checkedAt: 101 })
  expect(timer.clock.now()).toBe(60_200)
})

test('200 rapid pool publications commit early at the cap without waiting for the interval', async () => {
  const { s } = await fixture()
  const plain = s.open()
  const timer = manualQuotaTimer()
  let commits = 0
  const store = s.open({
    coalesceQuota: true,
    quotaCommitTimer: timer.clock,
    onStep: (step) => {
      if (step === 'after-config-write') commits++
    },
  })
  hooks.lifetime.finish(() => store.dispose())
  await store.recordQuota('a', fence, reading(0))
  await timer.advance(100)
  commits = 0
  for (let i = 1; i <= 200; i++) await store.recordQuota('a', fence, reading(i))
  expect(timer.clock.now()).toBe(100)
  expect(commits).toBe(1)
  const memory = await store.read()
  const disk = await plain.read()
  if (memory.status !== 'ready' || disk.status !== 'ready')
    throw new Error('pool not ready')
  expect(memory.rows[0]?.quota).toMatchObject({
    readings: Array.from({ length: 201 }, (_, i) => reading(i)),
  })
  expect(disk.rows[0]?.quota).toMatchObject({
    readings: Array.from({ length: 129 }, (_, i) => reading(i)),
  })
  await timer.advance(30_000)
  expect(commits).toBe(2)
  expect(await plain.read()).toEqual(memory)
})

test('pool mailbox merges poll fields across headers in memory and on disk', async () => {
  const { store, plain } = await fixture()
  await plain.recordQuota('a', fence, {
    checkedAt: 10,
    readings: [{ scope: 'model:stored', label: '7d', usedPercent: 15 }],
  })
  await store.recordQuota('a', fence, {
    checkedAt: 100,
    readings: [
      { scope: 'model:poll', label: '7d', usedPercent: 35 },
      { label: 'extra', usedPercent: 45 },
    ],
    counters: { tokens: { checkedAt: 300, value: 12 } },
    credits: {
      checkedAt: 300,
      hasCredits: true,
      unlimited: false,
      balance: 25,
    },
    budget: { kind: 'reading', reached: false, usedPercent: 8 },
  })
  await store.recordQuota('a', fence, {
    ...reading(200),
    readings: [...reading(200).readings, { label: '7d', usedPercent: 30 }],
  })
  const memory = await quota(store)
  expect(memory?.limits).toHaveLength(5)
  expect(memory?.counters?.tokens).toEqual({ checkedAt: 300, value: 12 })
  expect(memory?.credits?.balance).toBe(25)
  expect(memory?.budget).toMatchObject({ checkedAt: 100, usedPercent: 8 })
  expect((await quota(plain))?.limits).toHaveLength(1)
  await store.dispose()
  expect(await quota(plain)).toEqual(memory)
})

test('pool mailbox keeps newer observation times when an older poll arrives late', async () => {
  const { store, plain } = await fixture()
  await store.recordQuota('a', fence, reading(200, 60))
  await store.recordQuota('a', fence, reading(100, 10))
  expect((await quota(store))?.limits[0]).toMatchObject({
    checkedAt: 200,
    usedPercent: 60,
  })
  expect(await quota(plain)).toBeUndefined()
  await store.dispose()
  expect((await quota(plain))?.limits[0]).toMatchObject({
    checkedAt: 200,
    usedPercent: 60,
  })
})

test('pool mailbox fences replaced identities and epochs without merging bindings', async () => {
  const { store, plain, warnings } = await fixture()
  await store.recordQuota('a', fence, {
    checkedAt: 100,
    readings: [{ label: 'old-only', usedPercent: 80 }],
  })
  await plain.replace('a', oauth('replacement'), { identity: 'new' })
  await store.recordQuota(
    'a',
    { credentialEpoch: 2, identity: 'new' },
    reading(200),
  )
  await store.dispose()
  expect((await quota(plain))?.limits.map((entry) => entry.label)).toEqual([
    '5h',
  ])
  expect(warnings).toEqual([
    'pool quota publication dropped; account binding changed',
  ])

  const second = await fixture()
  await second.store.recordQuota('a', fence, reading(100))
  await second.plain.replace('a', oauth('same-identity'))
  await second.store.dispose()
  expect(await quota(second.plain)).toBeUndefined()
  expect(second.warnings).toEqual([
    'pool quota publication dropped; account binding changed',
  ])

  const third = await fixture()
  await third.store.recordQuota('a', fence, reading(100))
  await third.plain.recordIdentity('a', 'learned-identity', fence)
  await third.store.dispose()
  expect(await quota(third.plain)).toBeUndefined()
  expect(third.warnings).toEqual([
    'pool quota publication dropped; account binding changed',
  ])
})

test('pool mailbox dispose drains and bounds a locked shutdown', async () => {
  const { store, plain, s, warnings } = await fixture()
  await store.recordQuota('a', fence, reading(100))
  expect(await quota(plain)).toBeUndefined()
  await store.dispose()
  expect((await quota(plain))?.limits[0]).toMatchObject({ checkedAt: 100 })
  const blocked = s.open({
    quota: quotaCodec,
    coalesceQuota: true,
    quotaDrainTimeoutMs: 50,
    logger: {
      warn: (m) => {
        warnings.push(m)
      },
    },
  })
  hooks.lifetime.finish(() => blocked.dispose())
  const lock = await acquirePoolLock(
    { name: 'save', path: s.configPath },
    POOL_LOCK_DEFAULTS,
    {},
  )
  try {
    await blocked.recordQuota('a', fence, reading(200))
    const started = performance.now()
    await blocked.close()
    expect(performance.now() - started).toBeLessThan(500)
    expect(warnings).toContain(
      'pool quota drain timed out; pending readings left',
    )
  } finally {
    await lock.release()
  }
  expect((await quota(plain))?.limits[0]).toMatchObject({ checkedAt: 100 })
})

test('pool mailbox refuses stale or invalid readings before queueing with the original errors', async () => {
  const { store, plain, s } = await fixture()
  let acquired = 0
  const fast = s.open({
    quota: quotaCodec,
    coalesceQuota: true,
    onLockEvent: (event) => {
      if (event.type === 'acquired') acquired++
    },
  })
  hooks.lifetime.finish(() => fast.dispose())
  expect(await fast.recordQuota('a', fence, reading(100))).toBeUndefined()
  expect(acquired).toBe(0)
  for (const candidate of [store, plain]) {
    await expect(
      candidate.recordQuota('a', { credentialEpoch: 0 }, reading(100)),
    ).rejects.toMatchObject({ kind: 'invalid-input', operation: 'pull' })
    await expect(
      candidate.recordQuota('a', { credentialEpoch: 2 }, reading(100)),
    ).rejects.toMatchObject({
      kind: 'attribution',
      phase: 'pull',
      retryable: true,
    })
    await expect(
      candidate.recordQuota('missing', fence, reading(100)),
    ).rejects.toMatchObject({ kind: 'unknown-row' })
    await expect(
      candidate.recordQuota('a', fence, { checkedAt: 'bad' }),
    ).rejects.toMatchObject({ operation: 'pull' })
  }
  await plain.replace('a', oauth('next'))
  await expect(
    store.recordQuota('a', fence, reading(200)),
  ).rejects.toMatchObject({ kind: 'attribution' })
  expect(await quota(store)).toBeUndefined()
})

test('pool mailbox snapshots inputs and retains retirement history and independent field times', async () => {
  const { store, plain } = await fixture()
  const input = {
    ...reading(100),
    readings: [
      ...reading(100).readings,
      { label: 'snapshot', usedPercent: 15 },
    ],
    counters: { tokens: { checkedAt: 500, value: 7 } },
  }
  const binding = { credentialEpoch: 1 }
  const accepted = store.recordQuota('a', binding, input)
  binding.credentialEpoch = 9
  input.readings[1]!.usedPercent = 90
  await accepted
  await store.recordQuota('a', fence, {
    checkedAt: 200,
    coverage: [{ label: '5h' }],
  })
  await store.recordQuota('a', fence, {
    ...reading(50),
    counters: { tokens: { checkedAt: 400, value: 1 } },
  })
  expect(await quota(plain)).toBeUndefined()
  await store.dispose()
  const saved = await quota(plain)
  expect(saved?.limits).toEqual([
    { scope: 'all', label: '5h', kind: 'retired', retiredAt: 200 },
    {
      scope: 'all',
      label: 'snapshot',
      kind: 'reading',
      checkedAt: 100,
      usedPercent: 15,
    },
  ])
  expect(saved?.counters?.tokens).toEqual({ checkedAt: 500, value: 7 })
})

test('pool mailbox keeps a newer enqueue while an older flush waits for the real lock', async () => {
  const { s, plain } = await fixture()
  const contended = deferred()
  const store = s.open({
    quota: quotaCodec,
    coalesceQuota: true,
    onLockEvent: (event) => {
      if (event.type === 'contended') contended.resolve()
    },
  })
  hooks.lifetime.finish(() => store.dispose())
  const lock = await acquirePoolLock(
    { name: 'save', path: s.configPath },
    POOL_LOCK_DEFAULTS,
    {},
  )
  try {
    await store.recordQuota('a', fence, reading(100, 10))
    await contended.promise
    await store.recordQuota('a', fence, reading(200, 70))
    expect((await quota(store))?.limits[0]).toMatchObject({
      checkedAt: 200,
      usedPercent: 70,
    })
  } finally {
    await lock.release()
  }
  await store.dispose()
  expect((await quota(plain))?.limits[0]).toMatchObject({
    checkedAt: 200,
    usedPercent: 70,
  })
})

const full = (label: string) =>
  Array.from({ length: POOL_QUOTA_QUEUE_LIMIT }, (_, index) => ({
    checkedAt: index + 1,
    readings: [{ label: `${label}:${index}`, usedPercent: index }],
  }))

test('pool mailbox holds a reading past a full row queue for room instead of dropping one', async () => {
  const { s, plain } = await fixture()
  const contended = deferred()
  const store = s.open({
    quota: quotaCodec,
    coalesceQuota: true,
    onLockEvent: (event) => {
      if (event.type === 'contended') contended.resolve()
    },
  })
  hooks.lifetime.finish(() => store.dispose())
  const lock = await acquirePoolLock(
    { name: 'save', path: s.configPath },
    POOL_LOCK_DEFAULTS,
    {},
  )
  let extra: Promise<void> | undefined
  try {
    for (const observation of full('queued'))
      await store.recordQuota('a', fence, observation)
    await contended.promise
    let settled = false
    extra = store.recordQuota('a', fence, reading(1_000, 50))
    void extra.then(() => {
      settled = true
    })
    await Bun.sleep(300)
    expect(settled).toBe(false)
    expect((await quota(store))?.limits).toHaveLength(POOL_QUOTA_QUEUE_LIMIT)
  } finally {
    await lock.release()
  }
  await extra
  expect((await quota(store))?.limits).toHaveLength(POOL_QUOTA_QUEUE_LIMIT + 1)
  await store.dispose()
  expect((await quota(plain))?.limits).toHaveLength(POOL_QUOTA_QUEUE_LIMIT + 1)
})

test('pool mailbox refuses a reading past a full row queue with lock contention after the lock budget', async () => {
  const { s, plain } = await fixture()
  const store = s.open({
    quota: quotaCodec,
    coalesceQuota: true,
    lockOptions: { timeoutMs: 200 },
  })
  hooks.lifetime.finish(() => store.dispose())
  const lock = await acquirePoolLock(
    { name: 'save', path: s.configPath },
    POOL_LOCK_DEFAULTS,
    {},
  )
  try {
    for (const observation of full('queued'))
      await store.recordQuota('a', fence, observation)
    const started = performance.now()
    await expect(
      store.recordQuota('a', fence, reading(1_000, 50)),
    ).rejects.toMatchObject({
      kind: 'lock-contention',
      operation: 'pull',
      retryable: true,
    })
    expect(performance.now() - started).toBeLessThan(2_000)
  } finally {
    await lock.release()
  }
  await store.dispose()
  const saved = await quota(plain)
  expect(saved?.limits).toHaveLength(POOL_QUOTA_QUEUE_LIMIT)
  expect(saved?.limits.some((entry) => entry.label === '5h')).toBe(false)
})

interface Metrics {
  readings: number
  accepted: number
  timeouts: number
  acquisitions: number
  retries: number
}

async function contention(mode: 'plain' | 'coalesced') {
  const { s, plain } = await fixture()
  const lock = await acquirePoolLock(
    { name: 'save', path: s.configPath },
    POOL_LOCK_DEFAULTS,
    {},
  )
  const children = Array.from({ length: 4 }, (_, index) => {
    const queued = deferred<Metrics>()
    const retry = deferred()
    const done = deferred<Metrics>()
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL('../fixtures/pool-quota-process.ts', import.meta.url),
        ),
        s.configPath,
        s.statePath,
        mode,
        String(index),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    let output = ''
    let stderr = ''
    let metrics: Metrics
    child.stdout.on('data', (chunk) => {
      output += chunk.toString()
      while (output.includes('\n')) {
        const newline = output.indexOf('\n')
        const message = JSON.parse(output.slice(0, newline))
        output = output.slice(newline + 1)
        if (message.type === 'queued') {
          metrics = message
          queued.resolve(metrics)
        }
        if (message.type === 'retry') retry.resolve()
        if (message.type === 'done') metrics = { ...metrics, ...message }
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.once('error', (error) => {
      queued.reject(error)
      retry.reject(error)
      done.reject(error)
    })
    const exited = new Promise<void>((resolve) =>
      child.once('close', (code) => {
        if (code !== 0 || stderr) {
          const error = new Error(`pool child exited ${code}: ${stderr}`)
          queued.reject(error)
          retry.reject(error)
          done.reject(error)
        } else done.resolve(metrics)
        resolve()
      }),
    )
    // Observe all channels even if an earlier assertion ends the test.
    for (const pending of [queued.promise, retry.promise, done.promise])
      void pending.catch(() => {})
    return { child, queued, retry, done, exited }
  })
  try {
    const queued = await Promise.all(
      children.map((child) => child.queued.promise),
    )
    if (mode === 'coalesced') {
      expect(
        queued.every((row) => row.accepted === 120 && row.timeouts === 0),
      ).toBe(true)
      await Promise.all(children.map((child) => child.retry.promise))
    }
    await lock.release()
    for (const { child } of children) child.stdin.end('drain\n')
    const results = await Promise.all(
      children.map((child) => child.done.promise),
    )
    console.log(`pool contention ${mode}`, JSON.stringify(results))
    const saved = await quota(plain)
    if (mode === 'coalesced') {
      expect(saved?.limits).toHaveLength(480)
      expect(
        saved?.limits.every(
          (entry) =>
            entry.kind === 'reading' &&
            entry.checkedAt === Number(entry.label.split(':')[1]) + 1,
        ),
      ).toBe(true)
      expect(saved?.counters).toEqual(
        Object.fromEntries(
          Array.from({ length: 4 }, (_, index) => [
            String(index),
            { checkedAt: 120, value: 120 },
          ]),
        ),
      )
      expect(
        results.every((row) => row.acquisitions < 10 && row.retries === 1),
      ).toBe(true)
    } else expect(saved).toBeUndefined()
    return results
  } finally {
    await lock.release()
    for (const { child } of children) child.kill()
    await Promise.all(children.map((child) => child.exited))
  }
}

test('four processes retain every pool reading with zero returned lock timeouts versus plain writes', async () => {
  const plain = await contention('plain')
  const coalesced = await contention('coalesced')
  expect(plain.reduce((sum, row) => sum + row.timeouts, 0)).toBe(480)
  expect(coalesced.reduce((sum, row) => sum + row.timeouts, 0)).toBe(0)
}, 15_000)
