import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { acquireRefreshFileLock } from '../../src/fs/refresh-file-lock.js'
import type { PoolStore } from '../../src/store/index.js'
import { deferred, oauth, type Scenario, scenario } from './helpers.js'

let s: Scenario
let clock: number
let renewals: Map<string, number>
beforeEach(async () => {
  s = await scenario()
  clock = Date.now()
  renewals = new Map()
})
afterEach(() => s.cleanup())

type Lock = { name: string; path: string }

async function expiresAt(lock: Lock): Promise<number> {
  const owner = JSON.parse(
    await readFile(`${lock.path}.${lock.name}.lock`, 'utf8'),
  )
  return Number(owner.expiresAt)
}

function open(renew: boolean): PoolStore {
  return s.open({
    now: () => clock,
    lockOptions: { ttlMs: 1_000, renewIntervalMs: 10, renew },
    onLockStep: (lock, step) => {
      if (step === 'renewal-finished')
        renewals.set(lock.name, (renewals.get(lock.name) ?? 0) + 1)
    },
  })
}

async function renewedTwice(names: string[]) {
  const start = names.map((name) => renewals.get(name) ?? 0)
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (
      names.every(
        (name, index) =>
          (renewals.get(name) ?? 0) >= (start[index] as number) + 2,
      )
    )
      return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`no renewal observed for ${names.join(', ')}`)
}

/**
 * Advances the injected clock in steps shorter than the remaining lease,
 * observing renewals between steps, until the summed advance exceeds the TTL.
 */
async function advancePastTtl(locks: Lock[]) {
  for (let step = 0; step < 4; step++) {
    clock += 400
    await renewedTwice(locks.map((lock) => lock.name))
  }
}

async function contenderAcquires(lock: Lock): Promise<boolean> {
  const contender = await acquireRefreshFileLock({
    ...lock,
    ttlMs: 10_000,
    now: () => clock,
  })
  await contender?.release()
  return contender !== null
}

describe('lock renewal', () => {
  for (const renew of [true, false]) {
    it(`the row and provider-wide locks across a paused provider call ${renew ? 'renew while a contender fails' : 'expire so a contender acquires when renewal is off'}`, async () => {
      await s.open().add({ id: 'a', credential: oauth('r-a') })
      const locks = [
        { name: 'row-a', path: s.statePath },
        { name: 'provider-openai', path: s.statePath },
      ]
      const entered = deferred()
      const release = deferred()
      const refresh = open(renew)
        .refresh('a', async () => {
          entered.resolve()
          await release.promise
          return { access: 'x', refresh: 'r-a2', expires: 4_000_000_000_000 }
        })
        .catch((error) => error)
      await entered.promise
      const before = await Promise.all(locks.map(expiresAt))
      if (renew) {
        await advancePastTtl(locks)
        const after = await Promise.all(locks.map(expiresAt))
        for (const [index, value] of after.entries())
          expect(value).toBeGreaterThan(before[index] as number)
        for (const lock of locks)
          expect(await contenderAcquires(lock)).toBe(false)
      } else {
        clock += 1_600
        for (const lock of locks)
          expect(await contenderAcquires(lock)).toBe(true)
      }
      release.resolve()
      await refresh
    })

    it(`the store-lock list across one read-modify-write ${renew ? 'renews while a contender fails' : 'expires so a contender acquires when renewal is off'}`, async () => {
      const locks = [
        { name: 'save', path: s.configPath },
        { name: 'save', path: s.statePath },
      ]
      const reached = deferred()
      const release = deferred()
      const store = s.open({
        now: () => clock,
        lockOptions: { ttlMs: 1_000, renewIntervalMs: 10, renew },
        onLockStep: (lock, step) => {
          if (step === 'renewal-finished') {
            const key = `${lock.name}@${lock.path}`
            renewals.set(key, (renewals.get(key) ?? 0) + 1)
          }
        },
        onStep: async (step) => {
          if (step === 'before-config-write') {
            reached.resolve()
            await release.promise
          }
        },
      })
      const add = store
        .add({ id: 'a', credential: oauth('r-a') })
        .catch((error) => error)
      await reached.promise
      const before = await Promise.all(locks.map(expiresAt))
      if (renew) {
        for (let step = 0; step < 4; step++) {
          clock += 400
          await renewedTwice(locks.map((lock) => `${lock.name}@${lock.path}`))
        }
        const after = await Promise.all(locks.map(expiresAt))
        for (const [index, value] of after.entries())
          expect(value).toBeGreaterThan(before[index] as number)
        for (const lock of locks)
          expect(await contenderAcquires(lock)).toBe(false)
      } else {
        clock += 1_600
        for (const lock of locks)
          expect(await contenderAcquires(lock)).toBe(true)
      }
      release.resolve()
      await add
    })
  }
})
