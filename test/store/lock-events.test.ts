import { beforeEach, expect } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { acquireRefreshFileLock } from '../../src/fs/refresh-file-lock.js'
import {
  acquirePoolLock,
  type LockEvent,
  POOL_LOCK_DEFAULTS,
} from '../../src/store/refresh-lock.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { observed } from '../fixtures/observed.js'
import { blocked, deferred, type Scenario, scenario } from './helpers.js'

const hooks = lifetimeHooks()
const { it } = hooks
let s: Scenario
beforeEach(async () => {
  s = hooks.lifetime.manage(await scenario())
})

it('contended events distinguish live owners from stale takeovers and successful attempts', async () => {
  const spec = { name: 'event-lock', path: s.statePath }
  const holder = await acquireRefreshFileLock({ ...spec, ttlMs: 60_000 })
  expect(holder).not.toBeNull()
  hooks.lifetime.unpark(() => {
    void holder?.release()
  })
  const refused = deferred()
  const events: LockEvent[] = []
  const contender = acquirePoolLock(spec, POOL_LOCK_DEFAULTS, {
    now: Date.now,
    onLockEvent: (event) => {
      events.push(event)
      if (event.type === 'contended') refused.resolve()
    },
  })
  await blocked(hooks.lifetime, contender, refused.promise)
  expect(events.length).toBeGreaterThan(0)
  expect(events.every((event) => event.type === 'contended')).toBe(true)
  expect(events[0]).toEqual({ type: 'contended', ...spec })
  await holder?.release()
  const lock = await observed(hooks.lifetime, contender)
  await lock.release()
  expect(events.slice(-2).map((event) => event.type)).toEqual([
    'acquired',
    'released',
  ])

  events.length = 0
  await writeFile(
    `${spec.path}.${spec.name}.lock`,
    JSON.stringify({ ownerId: 'stale', expiresAt: 0 }),
  )
  const takeover = await acquirePoolLock(spec, POOL_LOCK_DEFAULTS, {
    now: Date.now,
    onLockEvent: (event) => {
      events.push(event)
    },
  })
  await takeover.release()
  expect(events.map((event) => event.type)).toEqual(['acquired', 'released'])
})

it('throwing lock event observers cannot affect contention acquisition or release', async () => {
  const spec = { name: 'throwing-observer', path: s.statePath }
  const holder = await acquireRefreshFileLock({ ...spec, ttlMs: 60_000 })
  hooks.lifetime.unpark(() => {
    void holder?.release()
  })
  const refused = deferred()
  const contender = acquirePoolLock(spec, POOL_LOCK_DEFAULTS, {
    now: Date.now,
    onLockEvent: (event) => {
      if (event.type === 'contended') refused.resolve()
      throw new Error('observer failure')
    },
  })
  await blocked(hooks.lifetime, contender, refused.promise)
  await holder?.release()
  await (await observed(hooks.lifetime, contender)).release()
  const next = await acquirePoolLock(spec, POOL_LOCK_DEFAULTS, {
    now: Date.now,
  })
  await next.release()
})

it('lock event observer promises are not awaited', async () => {
  const pending = deferred()
  hooks.lifetime.unpark(() => pending.resolve())
  const spec = { name: 'async-observer', path: s.statePath }
  const holder = await acquireRefreshFileLock({ ...spec, ttlMs: 60_000 })
  hooks.lifetime.unpark(() => {
    void holder?.release()
  })
  const refused = deferred()
  const contender = acquirePoolLock(spec, POOL_LOCK_DEFAULTS, {
    now: Date.now,
    onLockEvent: (event) => {
      if (event.type === 'contended') refused.resolve()
      return pending.promise
    },
  })
  await blocked(hooks.lifetime, contender, refused.promise)
  await holder?.release()
  await (await observed(hooks.lifetime, contender)).release()
})
