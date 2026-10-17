import { beforeEach, describe, expect } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { acquireRefreshFileLock } from '../../src/fs/refresh-file-lock.js'
import type { PoolStore } from '../../src/store/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { observedState } from '../fixtures/observed.js'
import {
  deferred,
  expireLease,
  oauth,
  type Scenario,
  scenario,
} from './helpers.js'

const hooks = lifetimeHooks()
const { afterEach, it } = hooks

let s: Scenario
let renewals: Map<string, number>
beforeEach(async () => {
  s = hooks.lifetime.manage(await scenario())
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
    lockOptions: { ttlMs: 1_000, renewIntervalMs: 10, renew },
    onLockStep: (lock, step) => {
      if (step === 'renewal-finished')
        renewals.set(lock.name, (renewals.get(lock.name) ?? 0) + 1)
    },
  })
}

async function renewedTwice(names: string[]) {
  const start = names.map((name) => renewals.get(name) ?? 0)
  await observedState(hooks.lifetime, () =>
    names.every(
      (name, index) =>
        (renewals.get(name) ?? 0) >= (start[index] as number) + 2,
    ),
  )
}

/** Observe renewal past the original wall-time deadline, not the store's logical clock. */
async function advancePastTtl(deadlines: number[], names: string[]) {
  await observedState(hooks.lifetime, () => Date.now() > Math.max(...deadlines))
  await renewedTwice(names)
}

async function contenderAcquires(lock: Lock): Promise<boolean> {
  const contender = await acquireRefreshFileLock({
    ...lock,
    ttlMs: 10_000,
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
      hooks.lifetime.unpark(() => release.resolve())
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
        await advancePastTtl(
          before,
          locks.map((lock) => lock.name),
        )
        const after = await Promise.all(locks.map(expiresAt))
        for (const [index, value] of after.entries())
          expect(value).toBeGreaterThan(before[index] as number)
        for (const lock of locks)
          expect(await contenderAcquires(lock)).toBe(false)
      } else {
        for (const lock of locks) {
          await expireLease(lock.path, lock.name)
          expect(await contenderAcquires(lock)).toBe(true)
        }
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
      hooks.lifetime.unpark(() => release.resolve())
      const store = s.open({
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
        await advancePastTtl(
          before,
          locks.map((lock) => `${lock.name}@${lock.path}`),
        )
        const after = await Promise.all(locks.map(expiresAt))
        for (const [index, value] of after.entries())
          expect(value).toBeGreaterThan(before[index] as number)
        for (const lock of locks)
          expect(await contenderAcquires(lock)).toBe(false)
      } else {
        for (const lock of locks) {
          await expireLease(lock.path, lock.name)
          expect(await contenderAcquires(lock)).toBe(true)
        }
      }
      release.resolve()
      await add
    })
  }
})
