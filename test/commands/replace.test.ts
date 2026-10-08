// A plugin whose accounts are not pool rows (a single host login, or rows it
// must not expose by id) replaces the built-in store sections with its own,
// keeping their slots and the fixed order, and needs no store at all.
import { describe, expect, test } from 'bun:test'
import {
  type CommandMenuOptions,
  createCommandMenu,
  type PluginSection,
} from '../../src/commands/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { apply, menuScenario, notes, populate } from './helpers.js'

const hooks = lifetimeHooks()
const { it } = hooks

function provider(title: string, ran: string[]): PluginSection {
  return {
    title,
    build: () => ({
      lines: [`${title} from the plugin`],
      items: [
        {
          id: 'opaque-1',
          label: 'Account 1',
          actions: [
            {
              id: 'use',
              label: 'Use',
              run: async ({ itemId }) => {
                ran.push(`${title}:${itemId}`)
                return `${title} used`
              },
            },
          ],
        },
      ],
    }),
  }
}

const base = {
  command: 'acme',
  title: 'Acme',
  logger: { warn: () => {} },
} satisfies Partial<CommandMenuOptions>

describe('replacing the built-in store sections', () => {
  it('a menu with all four slots replaced needs no store and keeps the fixed order', async () => {
    const ran: string[] = []
    const menu = createCommandMenu({
      ...base,
      replace: {
        accounts: provider('Accounts', ran),
        quota: provider('Quota', ran),
        routing: provider('Routing', ran),
        limits: provider('Limits', ran),
      },
      cache: provider('Cache', ran),
      extras: [{ id: 'extra', ...provider('Extra', ran) }],
    })
    const { invocation } = notes()
    const payload = await menu.open(invocation)
    expect(payload.menu.sections.map((entry) => entry.id)).toEqual([
      'accounts',
      'quota',
      'routing',
      'limits',
      'cache',
      'extra',
    ])
    const accounts = payload.menu.sections[0]
    expect(accounts?.slot).toBe('accounts')
    expect(accounts?.lines).toEqual(['Accounts from the plugin'])
    expect(accounts?.items.map((item) => item.id)).toEqual(['opaque-1'])
    const result = await apply(menu, invocation, {
      sectionId: 'routing',
      itemId: 'opaque-1',
      actionId: 'use',
    })
    expect(result.ok).toBe(true)
    expect(result.text).toBe('Routing used')
    expect(ran).toEqual(['Routing:opaque-1'])
  })

  it('a replaced slot takes the built-in one’s place while the others still read the store', async () => {
    const m = await menuScenario()
    try {
      await populate(m.store)
      const menu = m.menu({ replace: { accounts: provider('Accounts', []) } })
      const payload = await menu.open(notes().invocation)
      expect(payload.menu.sections.map((entry) => entry.id)).toEqual([
        'accounts',
        'quota',
        'routing',
        'limits',
      ])
      const accounts = payload.menu.sections[0]
      expect(
        accounts?.items.map((item) => item.id),
        'no pool row ids',
      ).toEqual(['opaque-1'])
      const quota = payload.menu.sections[1]
      expect(
        quota?.lines.join('\n') + JSON.stringify(quota?.items),
        'the built-in quota section still reads the store',
      ).toContain('42')
    } finally {
      m.cleanup()
    }
  })

  test('a built-in slot without a store is refused when the menu is created', () => {
    expect(() =>
      createCommandMenu({
        ...base,
        replace: { accounts: provider('Accounts', []) },
      }),
    ).toThrow(
      'a store is required for the built-in quota, routing, limits sections',
    )
  })

  test('a replaced slot cannot also take its built-in options', async () => {
    const m = await menuScenario()
    try {
      expect(() =>
        m.menu({
          replace: { accounts: provider('Accounts', []) },
          accounts: {},
        }),
      ).toThrow('the accounts section is replaced')
    } finally {
      m.cleanup()
    }
  })
})
