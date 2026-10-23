import { expect } from 'bun:test'
import type { QuotaCodec } from '../../src/quota/index.js'
import type { PoolStore } from '../../src/store/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { oauth, scenario } from './helpers.js'

// The coalescer must work with any pool codec, not only one that stores
// /quota's QuotaObservation. This codec is shaped like anthropic-auth's native
// one: the stored map and the observation have the same shape, closed at the
// top level, with no top-level checkedAt, provider metadata that has no
// QuotaObservation field,
// an account identity it checks on every merge, and merge rules of its own
// (a header reading folds into the stored map; a poll replaces it unless the
// stored map is newer). Splitting such a reading into QuotaObservation parts
// would lose the metadata, so the coalescer has to hand whole readings to the
// codec's own merge.

type Source = 'headers' | 'poll'

interface Window {
  scope: string
  label: string
  kind: 'reading'
  checkedAt: number
  usedPercent: number
}

interface NativeLike {
  limits: Window[]
  provider: {
    version: 1
    source: Source
    accountIdentity: string
    remainingPercent: Record<string, number>
    scoped?: Array<{ id: string; title: string; modelName: string }>
    extraUsage?: {
      enabled: boolean
      used: { amount: number; currency: string }
    }
    fieldSources: Record<string, Source>
  }
  budget?: { kind: 'reading'; reached: boolean; usedPercent: number }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function closed(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function isNativeLike(value: unknown): value is NativeLike {
  if (!isRecord(value) || !closed(value, ['limits', 'provider', 'budget']))
    return false
  const { limits, provider } = value
  return (
    Array.isArray(limits) &&
    limits.every(
      (entry) =>
        isRecord(entry) &&
        entry.kind === 'reading' &&
        typeof entry.label === 'string' &&
        typeof entry.checkedAt === 'number' &&
        typeof entry.usedPercent === 'number',
    ) &&
    isRecord(provider) &&
    provider.version === 1 &&
    (provider.source === 'headers' || provider.source === 'poll') &&
    typeof provider.accountIdentity === 'string' &&
    isRecord(provider.remainingPercent) &&
    isRecord(provider.fieldSources)
  )
}

const newest = (map: NativeLike) =>
  Math.max(...map.limits.map((entry) => entry.checkedAt))

let merges = 0
const nativeLikeCodec: QuotaCodec = {
  validate: isNativeLike,
  merge(stored, observation) {
    merges++
    if (!isNativeLike(observation)) throw new Error('observation is invalid')
    const incoming = structuredClone(observation)
    if (stored === undefined) return incoming
    if (!isNativeLike(stored)) throw new Error('stored map is invalid')
    if (stored.provider.accountIdentity !== incoming.provider.accountIdentity)
      throw new Error('quota belongs to another account')
    if (incoming.provider.source === 'poll')
      return newest(stored) > newest(incoming) ? stored : incoming
    // A header reading contributes only its account-wide windows and their
    // remaining percentages: fold those in and keep every other stored field.
    const next = structuredClone(stored)
    for (const window of incoming.limits) {
      const index = next.limits.findIndex(
        (entry) => entry.scope === window.scope && entry.label === window.label,
      )
      if (index >= 0 && next.limits[index]!.checkedAt > window.checkedAt)
        continue
      if (index >= 0) next.limits[index] = window
      else next.limits.push(window)
      const remaining = incoming.provider.remainingPercent[window.label]
      if (remaining !== undefined)
        next.provider.remainingPercent[window.label] = remaining
      next.provider.fieldSources[window.label] = 'headers'
    }
    return next
  },
}

const hooks = lifetimeHooks()
const { test, afterEach } = hooks
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})
const fence = { credentialEpoch: 1 }

const window = (
  label: string,
  checkedAt: number,
  usedPercent: number,
  scope = 'all',
): Window => ({ scope, label, kind: 'reading', checkedAt, usedPercent })

const poll = (identity = 'acct-1'): NativeLike => ({
  limits: [
    window('five_hour', 1000, 10),
    window('seven_day', 1000, 20),
    window('weekly', 1000, 70, 'model:fable'),
  ],
  provider: {
    version: 1,
    source: 'poll',
    accountIdentity: identity,
    remainingPercent: { five_hour: 90.4, seven_day: 80.2 },
    scoped: [{ id: 'fable', title: 'Fable weekly', modelName: 'Fable' }],
    extraUsage: { enabled: true, used: { amount: 12.5, currency: 'USD' } },
    fieldSources: { five_hour: 'poll', seven_day: 'poll', weekly: 'poll' },
  },
  budget: { kind: 'reading', reached: false, usedPercent: 35 },
})

const header: NativeLike = {
  limits: [window('five_hour', 2000, 40), window('seven_day', 2000, 25)],
  provider: {
    version: 1,
    source: 'headers',
    accountIdentity: 'acct-1',
    remainingPercent: { five_hour: 60.1, seven_day: 74.9 },
    fieldSources: { five_hour: 'headers', seven_day: 'headers' },
  },
}

// Written out by hand rather than computed with the codec, so a wrong merge
// cannot agree with itself.
const merged: NativeLike = {
  limits: [
    window('five_hour', 2000, 40),
    window('seven_day', 2000, 25),
    window('weekly', 1000, 70, 'model:fable'),
  ],
  provider: {
    version: 1,
    source: 'poll',
    accountIdentity: 'acct-1',
    remainingPercent: { five_hour: 60.1, seven_day: 74.9 },
    scoped: [{ id: 'fable', title: 'Fable weekly', modelName: 'Fable' }],
    extraUsage: { enabled: true, used: { amount: 12.5, currency: 'USD' } },
    fieldSources: {
      five_hour: 'headers',
      seven_day: 'headers',
      weekly: 'poll',
    },
  },
  budget: { kind: 'reading', reached: false, usedPercent: 35 },
}

async function fixture() {
  const s = hooks.lifetime.manage(await scenario())
  cleanups.push(() => s.cleanup())
  const plain = s.open({ quota: nativeLikeCodec })
  await plain.add({ id: 'a', credential: oauth('a') })
  await plain.add({ id: 'b', credential: oauth('b') })
  const warnings: string[] = []
  const store = s.open({
    quota: nativeLikeCodec,
    coalesceQuota: true,
    logger: { warn: (message) => void warnings.push(message) },
  })
  hooks.lifetime.finish(() => store.dispose())
  return { plain, store, warnings }
}

async function quota(store: PoolStore, id = 'a') {
  const load = await store.read()
  if (load.status !== 'ready') throw new Error('pool not ready')
  return load.rows.find((row) => row.id === id)?.quota
}

test('pool mailbox coalesces whole readings of a codec that stores its own map', async () => {
  const { store, plain } = await fixture()
  merges = 0
  await store.recordQuota('a', fence, poll())
  await store.recordQuota('a', fence, header)
  // Accepted readings show at once, merged by the codec in arrival order.
  expect(await quota(store)).toEqual(merged)
  expect(await quota(plain)).toBeUndefined()
  const loaded = await store.load()
  if (loaded.status !== 'ready') throw new Error('pool not ready')
  expect(loaded.rows.find((row) => row.id === 'a')?.quota).toEqual(merged)
  merges = 0
  await store.dispose()
  // The flush merged both readings through the codec: the first into the
  // empty row, the header into the poll.
  expect(merges).toBe(2)
  expect(await quota(plain)).toEqual(merged)
})

test('pool mailbox drops one reading its codec refuses at flush and lands the rest', async () => {
  const { store, plain, warnings } = await fixture()
  await store.recordQuota('a', fence, header)
  await store.recordQuota('b', fence, poll())
  // Another writer records a different account's quota on row a after the
  // header was accepted, so the codec refuses to merge the header into it.
  await plain.recordQuota('a', fence, poll('acct-2'))
  await store.dispose()
  expect(await quota(plain, 'a')).toEqual(poll('acct-2'))
  expect(await quota(plain, 'b')).toEqual(poll())
  expect(warnings).toEqual([
    'pool quota publication dropped; the quota codec refused it',
  ])
})
