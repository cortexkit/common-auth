import { beforeEach, expect } from 'bun:test'
import type {
  ProviderStateCodec,
  ProviderStateReplacement,
} from '../../src/store/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { observed } from '../fixtures/observed.js'
import { blocked, deferred, oauth, type Scenario, scenario } from './helpers.js'

const hooks = lifetimeHooks()
const { afterEach, test } = hooks
let s: Scenario
beforeEach(async () => {
  s = hooks.lifetime.manage(await scenario())
})
afterEach(() => s.cleanup())

function recorder() {
  const replacements: ProviderStateReplacement[] = []
  const providerState: ProviderStateCodec = {
    validate: (value) => value !== null && typeof value === 'object',
    onReplace: (_previous, replacement) => {
      replacements.push(replacement)
      return undefined
    },
  }
  return { replacements, providerState }
}

test('onReplace receives the previous recorded identity beside the incoming identity', async () => {
  const { replacements, providerState } = recorder()
  const store = s.open({ providerState })
  await store.add({ id: 'a', credential: oauth('r-a'), identity: 'acct-a' })
  await store.replace('a', oauth('r-b'), { identity: 'acct-b' })
  expect(replacements).toEqual([
    {
      id: 'a',
      credentialEpoch: 2,
      previousIdentity: 'acct-a',
      identity: 'acct-b',
    },
  ])
})

test('onReplace omits previousIdentity when the row recorded none', async () => {
  const { replacements, providerState } = recorder()
  const store = s.open({ providerState })
  await store.add({ id: 'a', credential: oauth('r-a') })
  await store.replace('a', oauth('r-b'), { identity: 'acct-b' })
  expect(replacements).toEqual([
    { id: 'a', credentialEpoch: 2, identity: 'acct-b' },
  ])
  expect(Object.hasOwn(replacements[0] ?? {}, 'previousIdentity')).toBe(false)
})

test('onReplace sees an identity recorded while replace waited for its row lock', async () => {
  await s.open().add({ id: 'a', credential: oauth('r-a') })
  const entered = deferred()
  const release = deferred()
  hooks.lifetime.unpark(() => release.resolve())
  const learner = s.open({
    onStep: async (step) => {
      if (step === 'before-state-write') {
        entered.resolve()
        await release.promise
      }
    },
  })
  // Learning an identity equal to the local id keeps the lock key unchanged,
  // isolating the locked identity read from the separate row-key-changed guard.
  const learning = learner.recordIdentity('a', 'a', { credentialEpoch: 1 })
  await observed(hooks.lifetime, entered.promise)
  const { replacements, providerState } = recorder()
  const replacing = s
    .open({ providerState })
    .replace('a', oauth('r-b'), { identity: 'acct-b' })
  await blocked(hooks.lifetime, replacing, s.contended(hooks.lifetime, 'row-a'))
  release.resolve()
  await Promise.all([learning, replacing])
  expect(replacements).toEqual([
    { id: 'a', credentialEpoch: 2, previousIdentity: 'a', identity: 'acct-b' },
  ])
})
