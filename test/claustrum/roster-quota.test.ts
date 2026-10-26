import { expect } from 'bun:test'
import { access, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  pendingVaultQuota,
  retainVaultQuotaWriter,
} from '../../src/claustrum/quota-writer.js'
import {
  drainVaultQuota,
  mutateVaultRoster,
  readVaultRoster,
  recordVaultAccountQuota,
  recordVaultQuota,
  refreshVaultRoster,
  type VaultRosterFile,
} from '../../src/claustrum/roster.js'
import {
  acquireRefreshFileLock,
  LockContentionError,
  lockPathFor,
} from '../../src/fs/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { manualQuotaTimer } from '../quota/commit-timer.js'
import { cleanupDirs, tempDir } from './helpers.js'

const hooks = lifetimeHooks()
const { test, afterEach } = hooks
afterEach(cleanupDirs)

const initial = (): VaultRosterFile => ({
  version: 1,
  complete: true,
  declined: [],
  rows: Array.from({ length: 4 }, (_, i) => ({
    routeId: `vault:${i}`,
    credentialId: `credential:${i}`,
    accountIdentity: String(i),
    credentialType: 'oauth',
    state: 'active',
    enabled: true,
    addedAt: 0,
    label: String(i),
  })),
})

const reading = (checkedAt: number, usedPercent = checkedAt) => ({
  checkedAt,
  readings: [{ label: 'primary', usedPercent }],
})
const receipt = {
  routeId: 'vault:0',
  credentialId: 'credential:0',
  accountIdentity: '0',
  accountIdentitySource: 'asserted' as const,
}

test('coalescing preserves last enqueue on equal timestamps across receipt sources', async () => {
  const path = await fixture()
  await recordVaultQuota(path, { ...receipt, observation: reading(100, 10) })
  await recordVaultAccountQuota(path, {
    routeId: receipt.routeId,
    accountIdentity: '0',
    observation: reading(100, 20),
  })
  await recordVaultQuota(path, { ...receipt, observation: reading(100, 30) })
  await drainVaultQuota(path)
  expect(
    (await readVaultRoster(path))?.rows[0]?.quota?.limits[0],
  ).toMatchObject({ checkedAt: 100, usedPercent: 30 })
})

test('enqueued observations snapshot mutable readings and receipt identities', async () => {
  const path = await fixture()
  const input = { ...receipt, observation: reading(100, 10) }
  await recordVaultQuota(path, input)
  input.accountIdentity = 'replacement'
  input.observation.readings[0]!.usedPercent = 90
  await drainVaultQuota(path)
  expect(
    (await readVaultRoster(path))?.rows[0]?.quota?.limits[0],
  ).toMatchObject({ checkedAt: 100, usedPercent: 10 })
})

async function fixture() {
  const path = join(await tempDir(), 'roster.json')
  await mutateVaultRoster(path, () => ({ next: initial(), result: undefined }))
  return path
}

test('50 roster publications within the commit interval make one commit with the newest fields', async () => {
  const path = await fixture()
  const timer = manualQuotaTimer()
  const release = retainVaultQuotaWriter(path, () => {}, timer.clock)
  hooks.lifetime.finish(release)
  await recordVaultQuota(path, { ...receipt, observation: reading(1) })
  await timer.advance(100)
  let inode = (await stat(path)).ino
  let commits = 0
  const countCommit = async () => {
    const next = (await stat(path)).ino
    if (next !== inode) commits++
    inode = next
  }
  for (let i = 1; i <= 50; i++) {
    await recordVaultQuota(path, {
      ...receipt,
      observation: {
        ...reading(i + 1, i),
        ...(i === 1 && { counters: { tokens: { checkedAt: 500, value: 42 } } }),
      },
    })
    await timer.advance(500)
    await countCommit()
  }
  expect(commits).toBe(0)
  const memory = pendingVaultQuota(path, await readVaultRoster(path))
  expect(memory?.rows[0]?.quota?.limits[0]).toMatchObject({
    checkedAt: 51,
    usedPercent: 50,
  })
  expect(memory?.rows[0]?.quota?.counters?.tokens).toEqual({
    checkedAt: 500,
    value: 42,
  })
  expect(
    (await readVaultRoster(path))?.rows[0]?.quota?.limits[0],
  ).toMatchObject({
    checkedAt: 1,
  })
  await timer.advance(5_000)
  await countCommit()
  expect(commits).toBe(1)
  expect((await readVaultRoster(path))?.rows[0]?.quota).toEqual(
    memory?.rows[0]?.quota,
  )

  await timer.advance(30_000)
  await recordVaultQuota(path, { ...receipt, observation: reading(100, 80) })
  await timer.advance(100)
  await countCommit()
  expect(commits).toBe(2)
  expect(
    (await readVaultRoster(path))?.rows[0]?.quota?.limits[0],
  ).toMatchObject({
    checkedAt: 100,
    usedPercent: 80,
  })
})

test('roster shutdown drains pending readings before the commit interval ends', async () => {
  const path = await fixture()
  const timer = manualQuotaTimer()
  const release = retainVaultQuotaWriter(path, () => {}, timer.clock)
  hooks.lifetime.finish(release)
  await recordVaultQuota(path, { ...receipt, observation: reading(1) })
  await timer.advance(100)
  await recordVaultQuota(path, { ...receipt, observation: reading(2) })
  await release()
  expect(
    (await readVaultRoster(path))?.rows[0]?.quota?.limits[0],
  ).toMatchObject({
    checkedAt: 2,
  })
  expect(timer.clock.now()).toBe(100)
})

test('identical serialized quota leaves the roster file untouched', async () => {
  const path = await fixture()
  const timer = manualQuotaTimer()
  const release = retainVaultQuotaWriter(path, () => {}, timer.clock)
  hooks.lifetime.finish(release)
  await recordVaultQuota(path, { ...receipt, observation: reading(1) })
  await timer.advance(100)
  const inode = (await stat(path)).ino
  await recordVaultQuota(path, { ...receipt, observation: reading(1) })
  await timer.advance(30_000)
  expect((await stat(path)).ino).toBe(inode)
})

test('coalesced fields retain independent times coverage and receipt fences', async () => {
  const path = await fixture()
  await recordVaultQuota(path, {
    ...receipt,
    observation: {
      ...reading(100),
      readings: [...reading(100).readings, { label: 'gone', usedPercent: 40 }],
      counters: { resets: { checkedAt: 300, value: 3 } },
      credits: {
        checkedAt: 300,
        hasCredits: true,
        unlimited: false,
        balance: 30,
      },
      budget: { kind: 'reading', reached: false, usedPercent: 20 },
    },
  })
  await recordVaultQuota(path, {
    ...receipt,
    observation: {
      checkedAt: 200,
      coverage: [{ label: 'gone' }],
      readings: [{ label: 'weekly', usedPercent: 80 }],
      budget: { kind: 'cleared' },
    },
  })
  await recordVaultAccountQuota(path, {
    routeId: receipt.routeId,
    accountIdentity: '0',
    observation: {
      ...reading(50),
      counters: { resets: { checkedAt: 200, value: 2 } },
      credits: { checkedAt: 200, hasCredits: false, unlimited: false },
    },
  })
  // An invalid credential must not erase the valid account's pending fields.
  await recordVaultQuota(path, {
    ...receipt,
    credentialId: 'not-a-member',
    observation: reading(500),
  })
  await drainVaultQuota(path)
  const quota = (await readVaultRoster(path))?.rows[0]?.quota
  expect(quota?.limits).toEqual([
    { scope: 'all', label: 'gone', kind: 'retired', retiredAt: 200 },
    {
      scope: 'all',
      label: 'primary',
      kind: 'reading',
      checkedAt: 100,
      usedPercent: 100,
    },
    {
      scope: 'all',
      label: 'weekly',
      kind: 'reading',
      checkedAt: 200,
      usedPercent: 80,
    },
  ])
  expect(quota?.counters?.resets).toEqual({ checkedAt: 300, value: 3 })
  expect(quota?.credits).toMatchObject({ checkedAt: 300, balance: 30 })
  expect(quota?.budget).toEqual({ kind: 'cleared', checkedAt: 200 })
})

test('flush fences observations against the current identity and drops departed accounts', async () => {
  const path = await fixture()
  await recordVaultQuota(path, { ...receipt, observation: reading(100) })
  await recordVaultAccountQuota(path, {
    routeId: 'vault:1',
    accountIdentity: '1',
    observation: reading(200),
  })
  await mutateVaultRoster(path, (current) => ({
    next: {
      ...current!,
      rows: current!.rows
        .filter((row) => row.routeId !== 'vault:1')
        .map((row) =>
          row.routeId === 'vault:0'
            ? { ...row, accountIdentity: 'replacement' }
            : row,
        ),
    },
    result: undefined,
  }))
  await drainVaultQuota(path)
  expect(
    (await readVaultRoster(path))?.rows.every((row) => row.quota === undefined),
  ).toBe(true)
})

test('standalone disposal drains queued observations and bounds a contended shutdown', async () => {
  const path = await fixture()
  await recordVaultQuota(path, { ...receipt, observation: reading(100) })
  await drainVaultQuota(path)
  expect(
    (await readVaultRoster(path))?.rows[0]?.quota?.limits[0],
  ).toMatchObject({ checkedAt: 100 })
  const lock = await acquireRefreshFileLock({
    path,
    name: 'claustrum-roster-write',
    ttlMs: 10_000,
    renew: true,
  })
  if (!lock) throw new Error('holder failed')
  try {
    await recordVaultQuota(path, { ...receipt, observation: reading(200) })
    const start = performance.now()
    await drainVaultQuota(path, 60)
    expect(performance.now() - start).toBeLessThan(500)
    expect(
      (await readVaultRoster(path))?.rows[0]?.quota?.limits[0],
    ).toMatchObject({ checkedAt: 100 })
  } finally {
    await lock.release()
  }
})

test('a slow roster writer renews its real lock and releases it after rejection', async () => {
  const path = await fixture()
  const failure = new Error('callback failed after the original lease expired')
  await expect(
    mutateVaultRoster(path, async (_current, context) => {
      await Bun.sleep(10_100)
      const contender = await acquireRefreshFileLock({
        path,
        name: 'claustrum-roster-write',
        ttlMs: 10_000,
      })
      try {
        expect(contender).toBeNull()
      } finally {
        await contender?.release()
      }
      await context.assertOwned()
      throw failure
    }),
  ).rejects.toBe(failure)
  expect(
    await access(lockPathFor(path, 'claustrum-roster-write')).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
}, 15_000)

test('a refresh retains discovered credential state after a write lock timeout', async () => {
  const path = await fixture()
  const lock = await acquireRefreshFileLock({
    path,
    name: 'claustrum-roster-write',
    ttlMs: 10_000,
    renew: true,
  })
  if (!lock) throw new Error('holder failed')
  let lists = 0
  const custody = {
    discover: async () => {
      if (++lists > 1) throw new Error('the already discovered state was lost')
      return {
        view: 'new-state',
        skipped: [],
        credentials: [
          {
            credentialId: 'credential:0',
            credentialType: 'oauth' as const,
            accountIdentity: '0',
            state: 'needs_login',
          },
        ],
      }
    },
  }
  try {
    await expect(refreshVaultRoster({ path, custody })).rejects.toBeInstanceOf(
      LockContentionError,
    )
  } finally {
    await lock.release()
  }
  const refreshed = await refreshVaultRoster({ path, custody })
  expect(lists).toBe(1)
  expect(refreshed?.view).toBe('new-state')
  expect(refreshed?.rows[0]?.state).toBe('needs_login')
}, 8_000)

async function multiProcess(contended: boolean) {
  const path = join(await tempDir(), 'roster.json')
  await mutateVaultRoster(path, () => ({ next: initial(), result: undefined }))
  const lock = contended
    ? await acquireRefreshFileLock({
        path,
        name: 'claustrum-roster-write',
        ttlMs: 10_000,
        renew: true,
      })
    : undefined
  if (contended && !lock) throw new Error('holder failed to acquire')
  const start = Date.now() + 500
  const release = lock
    ? setTimeout(
        () => {
          void lock.release()
        },
        start + 8_000 - Date.now(),
      )
    : undefined
  const children = Array.from({ length: 4 }, (_, i) =>
    Bun.spawn(
      [
        process.execPath,
        fileURLToPath(
          new URL('../fixtures/roster-quota-process.ts', import.meta.url),
        ),
        path,
        String(i),
        String(start),
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    ),
  )
  try {
    const results = await Promise.all(
      children.map(async (child) => {
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        expect(stderr).toBe('')
        expect(exit).toBe(0)
        return JSON.parse(stdout) as {
          account: string
          readings: number
          acquisitions: number
          dropped: number
          retries: number
        }
      }),
    )
    const persisted = await readVaultRoster(path)
    console.log('roster contention metrics', JSON.stringify(results))
    expect(results.reduce((sum, result) => sum + result.dropped, 0)).toBe(0)
    for (const result of results) {
      expect(result.readings).toBeGreaterThan(100)
      expect(
        persisted?.rows.find((row) => row.accountIdentity === result.account)
          ?.quota?.limits[0],
      ).toMatchObject({
        checkedAt: result.readings,
        usedPercent: result.readings,
      })
      expect(result.acquisitions / result.readings).toBeLessThan(0.15)
      expect(result.retries).toBe(contended ? 1 : 0)
    }
  } finally {
    clearTimeout(release)
    await lock?.release()
    for (const child of children) child.kill()
    await Promise.all(children.map((child) => child.exited))
  }
}

test(
  'four processes coalesce quota readings and retain the newest through lock contention',
  () => multiProcess(true),
  20_000,
)
test(
  'four processes use far fewer roster locks than quota readings without contention',
  () => multiProcess(false),
  20_000,
)
