import { beforeEach, expect } from 'bun:test'
import {
  projectQuota,
  type QuotaMap,
  quotaCodec,
} from '../../src/quota/index.js'
import { admit } from '../../src/routing/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import * as published from '../quota/fixtures/quota-0.22.0/map.js'
import * as publishedMerge from '../quota/fixtures/quota-0.22.0/merge.js'
import { oauth, type Scenario, scenario } from './helpers.js'

const hooks = lifetimeHooks()
const { afterEach, test } = hooks

let s: Scenario
beforeEach(async () => {
  s = hooks.lifetime.manage(await scenario())
})
afterEach(() => s.cleanup())

// The store's own tests use a trivial codec; this one opens it with the real
// quota model so the two subpaths are proven to fit: a pulled observation is
// merged, persisted, reloaded, and read by admission.
test('the store persists observations through the quota codec and admission reads them back', async () => {
  const store = s.open({
    quota: quotaCodec,
    pull: async () => ({
      checkedAt: 1_000,
      readings: [{ label: 'primary', usedPercent: 40, windowMinutes: 300 }],
      coverage: [{ label: 'secondary' }],
    }),
  })
  await store.add({ id: 'a', credential: oauth('r-a') })
  await store.pullsSettled()

  const reopened = s.open({ quota: quotaCodec })
  const load = await reopened.read()
  if (load.status !== 'ready') throw new Error('expected ready')
  const row = load.rows.find((candidate) => candidate.id === 'a')
  expect(row?.needsFirstReading).toBe(false)
  const map = row?.quota as QuotaMap
  expect(quotaCodec.validate(map)).toBe(true)
  const projection = projectQuota(map)
  expect(projection.limits.map((limit) => [limit.label, limit.kind])).toEqual([
    ['primary', 'reading'],
    ['secondary', 'absent'],
  ])

  const verdict = admit({
    rows: [{ id: 'a', kind: 'oauth', quota: map }],
    now: 2_000,
  })
  expect(verdict.admitted.map((candidate) => candidate.id)).toEqual(['a'])
})

test('the store round trips counters and drops malformed counts without losing the row', async () => {
  const store = s.open({ quota: quotaCodec })
  await store.add({ id: 'a', credential: oauth('r-a') })
  await store.recordQuota(
    'a',
    { credentialEpoch: 1 },
    {
      checkedAt: 100,
      counters: { resetCredits: { value: 5, checkedAt: 200 } },
    },
  )
  const reopened = s.open({ quota: quotaCodec })
  const first = await reopened.read()
  if (first.status !== 'ready') throw new Error('expected ready')
  expect((first.rows[0]?.quota as QuotaMap | undefined)?.counters).toEqual({
    resetCredits: { value: 5, checkedAt: 200 },
  })
  const config = await s.config()
  config.commonAuthPool.rows.a.quota.counters.bad = {
    value: -1,
    checkedAt: 300,
  }
  await s.writeConfig(config)
  const bytes = await s.bytes()
  const read = await reopened.read()
  if (read.status !== 'ready') throw new Error('expected ready')
  expect(read.rows).toHaveLength(1)
  expect((read.rows[0]?.quota as QuotaMap | undefined)?.counters).toEqual({
    resetCredits: { value: 5, checkedAt: 200 },
  })
  expect(await s.bytes()).toEqual(bytes)
})

test('a later quota write drops a malformed stored counter instead of refusing', async () => {
  const store = s.open({ quota: quotaCodec })
  await store.add({ id: 'a', credential: oauth('r-a') })
  await store.recordQuota(
    'a',
    { credentialEpoch: 1 },
    {
      checkedAt: 100,
      counters: { resetCredits: { value: 5, checkedAt: 200 } },
    },
  )
  const config = await s.config()
  config.commonAuthPool.rows.a.quota.counters.bad = {
    value: -1,
    checkedAt: 300,
  }
  await s.writeConfig(config)
  // Reads already hide the bad counter; a write must not be refused for it.
  await store.recordQuota(
    'a',
    { credentialEpoch: 1 },
    {
      checkedAt: 400,
      counters: { resetCredits: { value: 4, checkedAt: 400 } },
    },
  )
  const stored = (await s.config()).commonAuthPool.rows.a.quota
  expect(stored.counters).toEqual({
    resetCredits: { value: 4, checkedAt: 400 },
  })
})

test('the store round trips credits and a later write drops a malformed stored record', async () => {
  const store = s.open({ quota: quotaCodec })
  await store.add({ id: 'a', credential: oauth('r-a') })
  const credits = {
    hasCredits: true,
    unlimited: false,
    balance: 40,
    checkedAt: 100,
  }
  await store.recordQuota(
    'a',
    { credentialEpoch: 1 },
    {
      checkedAt: 100,
      readings: [{ label: 'primary', usedPercent: 20 }],
      credits,
    },
  )
  const first = await s.open({ quota: quotaCodec }).read()
  if (first.status !== 'ready') throw new Error('expected ready')
  expect((first.rows[0]?.quota as QuotaMap | undefined)?.credits).toEqual(
    credits,
  )
  const config = await s.config()
  config.commonAuthPool.rows.a.quota.credits = { hasCredits: 'yes' }
  await s.writeConfig(config)
  const read = await s.open({ quota: quotaCodec }).read()
  if (read.status !== 'ready') throw new Error('expected ready')
  const quota = read.rows[0]?.quota as QuotaMap | undefined
  expect(quota?.credits).toBeUndefined()
  expect(quota?.limits).toHaveLength(1)
  // Reads already hide the bad record; a write must not be refused for it.
  await store.recordQuota('a', { credentialEpoch: 1 }, { checkedAt: 200 })
  const stored = (await s.config()).commonAuthPool.rows.a.quota
  expect(stored.credits).toBeUndefined()
  expect(stored.limits).toHaveLength(1)
})

test('a store opened with the 0.22 quota codec keeps credits a newer plugin wrote', async () => {
  const legacyCodec = {
    validate: published.isQuotaMap,
    decode: published.decodeQuotaMap,
    merge: publishedMerge.mergeQuotaObservation,
  }
  const credits = { hasCredits: true, unlimited: true, checkedAt: 100 }
  const store = s.open({ quota: quotaCodec })
  await store.add({ id: 'a', credential: oauth('r-a') })
  await store.recordQuota(
    'a',
    { credentialEpoch: 1 },
    { checkedAt: 100, credits },
  )
  const legacy = s.open({ quota: legacyCodec })
  const read = await legacy.read()
  if (read.status !== 'ready') throw new Error('expected ready')
  expect((read.rows[0]?.quota as QuotaMap | undefined)?.credits).toEqual(
    credits,
  )
  await legacy.recordQuota(
    'a',
    { credentialEpoch: 1 },
    {
      checkedAt: 200,
      readings: [{ label: 'primary', usedPercent: 30 }],
    },
  )
  expect((await s.config()).commonAuthPool.rows.a.quota.credits).toEqual(
    credits,
  )
  const current = await s.open({ quota: quotaCodec }).read()
  if (current.status !== 'ready') throw new Error('expected ready')
  expect((current.rows[0]?.quota as QuotaMap | undefined)?.credits).toEqual(
    credits,
  )
})
