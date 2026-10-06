import { beforeEach, describe, expect } from 'bun:test'
import {
  CommandError,
  type CommandMenuOptions,
} from '../../src/commands/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { apply, type MenuScenario, menuScenario, notes } from './helpers.js'

const hooks = lifetimeHooks()
const { afterEach, it } = hooks

let m: MenuScenario
beforeEach(async () => {
  m = await menuScenario()
})
afterEach(() => m.cleanup())

const BEARER = 'Bearer synthetic-audit-secret'
const ARBITRARY_KEY = 'AQ.Ab8RN6Lq0synthetic9arbitrary0key'
const REQUEST_SECRET = 'a1'.repeat(32)

/** A cache section whose one action does whatever `run` does. */
function withAction(
  run: () => Promise<string | { ok: boolean; text: string; code?: string }>,
  extra: Partial<CommandMenuOptions> = {},
) {
  return m.menu({
    cache: {
      title: 'Cache',
      build: () => ({ actions: [{ id: 'go', label: 'Go', run }] }),
    },
    ...extra,
  })
}

async function go(menu: ReturnType<typeof withAction>) {
  return apply(menu, notes().invocation, { sectionId: 'cache', actionId: 'go' })
}

describe('command failure projection', () => {
  it('a thrown failure quoting a bearer token shows only the generic code and message', async () => {
    const result = await go(
      withAction(async () => {
        throw new Error(`upstream said 401 for Authorization: ${BEARER}`)
      }),
    )
    expect(result).toMatchObject({
      ok: false,
      code: 'action-failed',
      text: 'That action failed.',
    })
    expect(JSON.stringify(result)).not.toContain('synthetic-audit-secret')
    // The log keeps the reason, with the token masked.
    const logged = JSON.stringify(m.warnings)
    expect(logged).toContain('upstream said 401')
    expect(logged).not.toContain('synthetic-audit-secret')
  })

  it('a thrown failure quoting an arbitrary API key never reaches the result', async () => {
    const result = await go(
      withAction(async () => {
        throw new Error(`key ${ARBITRARY_KEY} was refused`)
      }),
    )
    expect(result.code).toBe('action-failed')
    expect(JSON.stringify(result)).not.toContain(ARBITRARY_KEY)
  })

  it('a thrown failure quoting an enrollment request secret never reaches the result', async () => {
    const result = await go(
      withAction(async () => {
        throw new Error(
          `enroll poll failed: {"requestSecret":"${REQUEST_SECRET}"}`,
        )
      }),
    )
    expect(result.code).toBe('action-failed')
    expect(JSON.stringify(result)).not.toContain(REQUEST_SECRET)
    expect(JSON.stringify(m.warnings)).not.toContain(REQUEST_SECRET)
  })

  it('a CommandError shows its own code and message, redacted', async () => {
    const result = await go(
      withAction(async () => {
        throw new CommandError(
          'vault-refused',
          `The vault refused the request (requestSecret=${REQUEST_SECRET}, ${BEARER}).`,
        )
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.code).toBe('vault-refused')
    expect(result.text).toStartWith('The vault refused the request')
    expect(result.text).not.toContain(REQUEST_SECRET)
    expect(result.text).not.toContain('synthetic-audit-secret')
  })

  it('a store refusal keeps the store message and names its kind as the code', async () => {
    const result = await go(
      withAction(async () => {
        await m.store.disable('missing', 'test')
        return 'unreachable'
      }),
    )
    expect(result).toMatchObject({
      ok: false,
      code: 'pool-unknown-row',
      text: 'no row missing in the pool',
    })
  })

  it('an outcome text quoting secrets is masked, using the plugin pattern for its key shape', async () => {
    const result = await go(
      withAction(
        async () => ({
          ok: false,
          text: `refused ${BEARER} key ${ARBITRARY_KEY} client_secret=s3cr3t-value`,
        }),
        { redaction: { extraValuePatterns: [/\bAQ\.[\w-]+/] } },
      ),
    )
    expect(result.code).toBe('refused')
    for (const secret of [
      'synthetic-audit-secret',
      ARBITRARY_KEY,
      's3cr3t-value',
    ])
      expect(result.text).not.toContain(secret)
    expect(m.warnings.map((w) => w.message)).toContain(
      'secret-shaped text masked in a command payload',
    )
  })

  it('a notification sent by an action is redacted before it reaches the host', async () => {
    const n = notes()
    const menu = m.menu({
      cache: {
        title: 'Cache',
        build: () => ({
          actions: [
            {
              id: 'go',
              label: 'Go',
              run: async ({ invocation }) => {
                invocation.notify(`using ${BEARER}`, 'info')
                return 'Done.'
              },
            },
          ],
        }),
      },
    })
    await apply(menu, n.invocation, { sectionId: 'cache', actionId: 'go' })
    expect(n.sent).toEqual([{ message: 'using ***REDACTED***', kind: 'info' }])
  })

  it('a late login failure is reported by its projected message, not its exception text', async () => {
    const n = notes()
    let fail!: (error: unknown) => void
    const menu = m.menu({
      accounts: {
        login: {
          run: async () => ({
            status: 'pending',
            message: 'Finish in the browser.',
            completion: new Promise((_, reject) => {
              fail = reject
            }),
          }),
        },
      },
    })
    await apply(menu, n.invocation, { sectionId: 'accounts', actionId: 'add' })
    fail(new Error(`token exchange failed with key ${ARBITRARY_KEY}`))
    const deadline = Date.now() + 2_000
    while (n.sent.length === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 0))
    expect(n.sent).toEqual([
      {
        message: 'Adding the account failed: That action failed.',
        kind: 'error',
      },
    ])
  })

  it('a credential-valued knob default is withheld when masked and redacted otherwise', async () => {
    let received: unknown
    const menu = m.menu({
      cache: {
        title: 'Cache',
        build: () => ({
          actions: [
            {
              id: 'set',
              label: 'Set key',
              knobs: [
                {
                  kind: 'text',
                  id: 'key',
                  label: 'Key',
                  masked: true,
                  value: ARBITRARY_KEY,
                },
                {
                  kind: 'text',
                  id: 'header',
                  label: 'Header',
                  value: BEARER,
                },
              ],
              run: async ({ values }) => {
                received = values
                return 'Saved.'
              },
            },
          ],
        }),
      },
    })
    const payload = await menu.open(notes().invocation)
    const text = JSON.stringify(payload)
    expect(text).not.toContain(ARBITRARY_KEY)
    expect(text).not.toContain('synthetic-audit-secret')
    const knobs = payload.menu.sections.find((s) => s.id === 'cache')
      ?.actions[0]?.knobs
    expect(knobs).toEqual([
      { kind: 'text', id: 'key', label: 'Key', masked: true },
      { kind: 'text', id: 'header', label: 'Header', value: '***REDACTED***' },
    ])
    // An apply that sends no value for the masked `key` input still gives
    // the action that input's current value.
    await apply(menu, notes().invocation, {
      sectionId: 'cache',
      actionId: 'set',
    })
    expect(received).toEqual({ key: ARBITRARY_KEY, header: BEARER })
  })
})
