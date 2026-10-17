import { beforeEach, expect } from 'bun:test'
import { LockContentionError, withLock } from '../../src/fs/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { observed } from '../fixtures/observed.js'
import { deferred, oauth, type Scenario, scenario } from './helpers.js'

const hooks = lifetimeHooks()
const { it } = hooks
let s: Scenario
beforeEach(async () => {
  s = hooks.lifetime.manage(await scenario())
})
hooks.afterEach(() => s.cleanup())

it('a synthetic store clock cannot let withLock evict a live pool-config lease', async () => {
  const held = deferred()
  const resume = deferred()
  hooks.lifetime.unpark(() => resume.resolve())
  const store = s.open({
    now: () => 1_000_000,
    lockOptions: { renew: false, ttlMs: 60_000 },
    onStep: async (step) => {
      if (step === 'before-config-write') {
        held.resolve()
        await resume.promise
      }
    },
  })
  const adding = hooks.lifetime.operation(
    store.add({ id: 'a', credential: oauth('a') }),
  )
  await observed(hooks.lifetime, held.promise)
  let entered = false
  let refusal: unknown
  try {
    await withLock(
      s.configPath,
      { name: 'save', ttlMs: 60_000, timeoutMs: 0 },
      async (lock) => {
        entered = true
        await lock.assertOwned()
      },
    )
  } catch (error) {
    refusal = error
  } finally {
    resume.resolve()
  }
  const outcome = await adding.then(
    () => 'added',
    () => 'lost-lease',
  )
  expect(entered).toBe(false)
  expect(refusal).toBeInstanceOf(LockContentionError)
  expect(outcome).toBe('added')
})

it('logical addedAt and refresh stamps still use the synthetic store clock', async () => {
  let clock = 1_000_000
  const store = s.open({ now: () => clock })
  await store.add({ id: 'a', credential: oauth('a') })
  expect((await s.config()).accounts[0].addedAt).toBe(1_000_000)
  clock = 1_000_100
  await store.refresh('a', async () => oauth('b'))
  expect((await s.state()).accounts.a.lastRefreshedAt).toBe(1_000_100)
})
