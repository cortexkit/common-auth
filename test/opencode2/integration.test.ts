import { describe, expect } from 'bun:test'
import type { Credential } from '@opencode/plugin'
import {
  isPlaceholderCredential,
  PLACEHOLDER_LIFETIME_MS,
  placeholderCredential,
  placeholderSecret,
  registerOpenCode2AuthMethods,
} from '../../src/opencode2/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { observed } from '../fixtures/observed.js'

const hooks = lifetimeHooks()
const { test } = hooks

type Registered = {
  integrationID: string
  method: { id: string; type: string; label: string }
  authorize: (answer: Record<string, unknown>) => Promise<any>
  refresh?: (credential: Credential.OAuth) => Promise<Credential.OAuth>
  label?: (credential: Credential.OAuth) => string | undefined
}

/** Captures what the plugin registers through `integration.transform`. */
function fakeIntegration() {
  const registered: Registered[] = []
  let disposed = false
  const ctx = {
    integration: {
      transform: async (callback: (editor: any) => void) => {
        callback({
          method: {
            update: (input: Registered) => {
              registered.push(input)
            },
          },
        })
        return {
          dispose: async () => {
            disposed = true
          },
        }
      },
    },
  }
  return {
    ctx: ctx as any,
    registered,
    get disposed() {
      return disposed
    },
  }
}

const NOW = 1_800_000_000_000

function setup(
  onLogin: (result: string, context: unknown) => void | Promise<void>,
) {
  const host = fakeIntegration()
  const logins: Array<{ result: string; context: unknown }> = []
  const registration = registerOpenCode2AuthMethods<string>(host.ctx, {
    integrationID: 'acme',
    now: () => NOW,
    label: 'Accounts managed by the plugin',
    onLogin: async (result, context) => {
      await onLogin(result, context)
      logins.push({ result, context })
    },
    methods: [
      {
        method: { id: 'acme-code', type: 'oauth', label: 'Paste a code' },
        authorize: async (answer) => ({
          url: `https://login.invalid/?hint=${answer.hint ?? ''}`,
          instructions: 'Paste the code',
          mode: 'code',
          callback: async (code) => `tokens-for-${code}`,
        }),
      },
      {
        method: { id: 'acme-browser', type: 'oauth', label: 'Browser' },
        authorize: async () => ({
          url: 'https://login.invalid/browser',
          instructions: 'Finish in the browser',
          expiresAt: NOW + 60_000,
          mode: 'auto',
          callback: Promise.resolve('tokens-from-browser'),
        }),
      },
    ],
  })
  return { host, logins, registration }
}

describe('registerOpenCode2AuthMethods', () => {
  test('a code login writes into the pool and leaves the host a placeholder', async () => {
    const { host, logins, registration } = setup(() => {})
    await observed(hooks.lifetime, registration)
    expect(
      host.registered.map((entry) => [entry.integrationID, entry.method.id]),
    ).toEqual([
      ['acme', 'acme-code'],
      ['acme', 'acme-browser'],
    ])
    const pending = await host.registered[0]!.authorize({ hint: 'me' })
    expect(pending.mode).toBe('code')
    expect(pending.url).toBe('https://login.invalid/?hint=me')
    const stored = await pending.callback('1234')
    expect(logins).toEqual([
      {
        result: 'tokens-for-1234',
        context: { integrationID: 'acme', methodID: 'acme-code' },
      },
    ])
    expect(stored).toEqual(
      placeholderCredential({
        integrationID: 'acme',
        methodID: 'acme-code',
        now: NOW,
      }),
    )
    expect(JSON.stringify(stored)).not.toContain('tokens-for-1234')
    expect(host.registered[0]!.label?.(stored)).toBe(
      'Accounts managed by the plugin',
    )
  })

  test('an automatic login resolves to a placeholder only after the pool write', async () => {
    const order: string[] = []
    const { host, registration } = setup(async (result) => {
      // A slow pool write: the host must still wait for it.
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push(`pool:${result}`)
    })
    await observed(hooks.lifetime, registration)
    const pending = await host.registered[1]!.authorize({})
    expect(pending.mode).toBe('auto')
    expect(pending.expiresAt).toBe(NOW + 60_000)
    const stored = await pending.callback
    order.push('host')
    expect(order).toEqual(['pool:tokens-from-browser', 'host'])
    expect(isPlaceholderCredential(stored, 'acme')).toBe(true)
    expect(stored.methodID).toBe('acme-browser')
  })

  test('a failed pool write fails the host login', async () => {
    const { host, registration } = setup(() => {
      throw new Error('pool locked')
    })
    await observed(hooks.lifetime, registration)
    const pending = await host.registered[0]!.authorize({})
    await expect(pending.callback('1234')).rejects.toThrow('pool locked')
  })

  test("host refresh renews only this integration's placeholder", async () => {
    let poolCalls = 0
    const { host, registration } = setup(() => {
      poolCalls += 1
    })
    await observed(hooks.lifetime, registration)
    const expired = placeholderCredential({
      integrationID: 'acme',
      methodID: 'acme-code',
      now: NOW - 1,
    })
    const refreshed = await host.registered[0]!.refresh!(expired)
    expect(poolCalls).toBe(0)
    expect(refreshed).not.toBe(expired)
    expect(refreshed).toEqual(
      placeholderCredential({
        integrationID: 'acme',
        methodID: 'acme-code',
        now: NOW,
      }),
    )
    expect(refreshed.expires).toBe(NOW + PLACEHOLDER_LIFETIME_MS)
  })

  test('host refresh refuses a real OAuth credential with the same method ID', async () => {
    let poolCalls = 0
    const { host, registration } = setup(() => {
      poolCalls += 1
    })
    await observed(hooks.lifetime, registration)
    const realCredential: Credential.OAuth = {
      type: 'oauth',
      methodID: 'acme-code' as Credential.OAuth['methodID'],
      access: 'real-access',
      refresh: 'real-refresh',
      expires: NOW - 1,
    }

    await expect(host.registered[0]!.refresh!(realCredential)).rejects.toThrow(
      "This login method refreshes only its pool placeholder; sign in again with the plugin's login method.",
    )
    expect(poolCalls).toBe(0)
  })

  test("host refresh refuses another integration's placeholder", async () => {
    let poolCalls = 0
    const { host, registration } = setup(() => {
      poolCalls += 1
    })
    await observed(hooks.lifetime, registration)
    const otherPlaceholder = placeholderCredential({
      integrationID: 'other',
      methodID: 'acme-code',
      now: NOW - 1,
    })

    await expect(
      host.registered[0]!.refresh!(otherPlaceholder),
    ).rejects.toThrow(
      "This login method refreshes only its pool placeholder; sign in again with the plugin's login method.",
    )
    expect(poolCalls).toBe(0)
  })

  test('placeholder credentials are recognised and carry no routable secret', () => {
    const credential = placeholderCredential({
      integrationID: 'acme',
      methodID: 'acme-code',
      now: NOW,
    })
    expect(credential.access).toBe(placeholderSecret('acme'))
    expect(credential.refresh).toBe(placeholderSecret('acme'))
    expect(isPlaceholderCredential(credential)).toBe(true)
    expect(isPlaceholderCredential(credential, 'acme')).toBe(true)
    expect(isPlaceholderCredential(credential, 'other')).toBe(false)
    expect(
      isPlaceholderCredential({ ...credential, access: 'real-access' }, 'acme'),
    ).toBe(false)
    expect(isPlaceholderCredential({ type: 'key', key: 'k' })).toBe(false)
    expect(isPlaceholderCredential(undefined)).toBe(false)
  })
})
