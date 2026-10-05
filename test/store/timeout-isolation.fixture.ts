// Copied to a scratch *.test.ts by the parent test. Its first failure is
// intentional: the child runner must time out without abandoning teardown.
import { afterEach, beforeAll, beforeEach, expect, it } from 'bun:test'
import { deferred, oauth, type Scenario, scenario } from './helpers.js'
import { TestLifetime } from './test-lifetime.js'

let s: Scenario
let lifetime: TestLifetime
let refresh: Promise<unknown>
let count = 0
let terminal = false
let finalToken = ''
const entered = deferred()
const released = deferred()
const readAllowed = deferred()

beforeAll(async () => {
  lifetime = new TestLifetime()
  s = lifetime.manage(await scenario())
  await s.open().add({ id: 'a', credential: oauth('before') })
  lifetime.unpark(() => released.resolve())
  refresh = s.open().refresh('a', async () => {
    entered.resolve()
    await released.promise
    // Keep real store work outstanding past the old teardown's 50 ms sleep.
    // This delay creates the fault; no assertion treats speed as correctness.
    setTimeout(() => readAllowed.resolve(), 100)
    await readAllowed.promise
    return { access: 'after', refresh: 'after', expires: 4_000_000_000_000 }
  })
  await entered.promise
})
beforeEach(async () => {
  if (count++ === 0) return
  lifetime = new TestLifetime()
  s = lifetime.manage(await scenario())
  await s.open().add({ id: 'a', credential: oauth('successor') })
})
afterEach(async () => {
  const current = s
  const pending = lifetime
  await pending.drain(() => current.cleanup())
})
it(
  'intentional parked refresh timeout',
  () =>
    lifetime.tracked(async () => {
      await refresh
      finalToken = (await s.state()).accounts.a.refresh
      terminal = true
    }),
  20,
)
it('successor sees only its own scenario after the timed-out body is terminal', () =>
  lifetime.tracked(async () => {
    expect(terminal).toBe(true)
    expect(finalToken).toBe('after')
    expect((await s.state()).accounts.a.refresh).toBe('successor')
  }))
