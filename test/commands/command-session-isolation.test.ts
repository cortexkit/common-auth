import { beforeEach, describe, expect } from 'bun:test'
import type { CommandInvocation } from '../../src/commands/index.js'
import type { AddInput } from '../../src/store/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { observed } from '../fixtures/observed.js'
import {
  apply,
  deferred,
  type MenuScenario,
  menuScenario,
  oauth,
  rosterIds,
} from './helpers.js'

const hooks = lifetimeHooks()
const { afterEach, it } = hooks

let m: MenuScenario
beforeEach(async () => {
  m = await menuScenario()
})
afterEach(() => m.cleanup())

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// The add flow's login is awaited before the account exists, and an OAuth
// login completes later still. A host that keeps one context object and
// rebinds its session and notifier for each command would, if the menu read
// that object lazily, route the first session's "added" message to whichever
// session ran a command in between. The menu copies the context when each
// invocation starts and reports through that copy.
describe('command hook session isolation', () => {
  it('a second session interleaving inside the add await-window does not steal the add notification', async () => {
    const loginGate = deferred<void>()
    hooks.lifetime.unpark(() => loginGate.resolve())
    const enteredLogin = deferred<void>()
    const notified = deferred<void>()
    const completion = deferred<AddInput | undefined>()
    const menu = m.menu({
      accounts: {
        login: {
          run: async () => {
            enteredLogin.resolve()
            await loginGate.promise
            return {
              status: 'pending',
              message: 'Open the login page to finish.',
              completion: completion.promise,
            }
          },
        },
      },
    })
    const delivered: Array<{ session: string; message: string }> = []
    const notifierFor = (session: string) => (message: string) => {
      delivered.push({ session, message })
      notified.resolve()
    }
    // One context object the host rebinds per command: the race's setup.
    const shared: CommandInvocation = {
      sessionId: 'sess-A',
      notify: notifierFor('sess-A'),
    }

    // Session A: add, suspended inside the plugin's login.
    const aDone = apply(menu, shared, {
      sectionId: 'accounts',
      actionId: 'add',
    })
    await observed(hooks.lifetime, enteredLogin.promise)

    // Session B: the host rebinds the shared context and runs a command.
    shared.sessionId = 'sess-B'
    shared.notify = notifierFor('sess-B')
    expect((await menu.open(shared)).command).toBe('acme')

    loginGate.resolve()
    expect(await aDone).toMatchObject({
      ok: true,
      text: 'Open the login page to finish.',
    })

    // The login completes: the "added" message must reach session A.
    completion.resolve({
      id: 'fallback-A',
      credential: oauth('refresh-new'),
      label: 'Account A',
    })
    await observed(hooks.lifetime, notified.promise)
    expect(delivered).toEqual([
      { session: 'sess-A', message: 'Added Account A.' },
    ])
    expect(await rosterIds(m.store)).toEqual(['fallback-A'])
  })

  it('concurrent invocations each get their own apply result', async () => {
    const gates = { one: deferred<void>(), two: deferred<void>() }
    const menu = m.menu({
      extras: [
        {
          id: 'echo',
          title: 'Echo',
          build: () => ({
            actions: [
              {
                id: 'say',
                label: 'Say',
                knobs: [{ kind: 'text', id: 'word', label: 'Word' }],
                run: async ({ values, invocation }) => {
                  const word = values.word === 'one' ? 'one' : 'two'
                  await gates[word].promise
                  return `${invocation.sessionId}:${word}`
                },
              },
            ],
          }),
        },
      ],
    })
    const say = (session: string, word: string) =>
      apply(
        menu,
        { sessionId: session, notify: () => {} },
        { sectionId: 'echo', actionId: 'say', values: { word } },
      )
    const first = say('sess-1', 'one')
    const second = say('sess-2', 'two')
    await tick()
    // Finish in the opposite order from the one they started in.
    gates.two.resolve()
    gates.one.resolve()
    expect((await first).text).toBe('sess-1:one')
    expect((await second).text).toBe('sess-2:two')
  })
})
