import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  apply,
  credentialPaths,
  type MenuScenario,
  menuScenario,
  notes,
  populate,
  SECRETS,
} from './helpers.js'

let m: MenuScenario
beforeEach(async () => {
  m = await menuScenario()
})
afterEach(() => m.cleanup())

describe('command payload seam', () => {
  it('no built-in section payload carries a credential field even when the store rows carry one', async () => {
    await populate(m.store)
    // The rows the sections are built from do carry credentials.
    const load = await m.store.read()
    if (load.status !== 'ready') throw new Error('expected ready')
    expect(load.rows.every((row) => row.credential !== undefined)).toBe(true)

    const payload = await m.menu().open(notes().invocation)
    const text = JSON.stringify(payload)
    for (const secret of SECRETS) expect(text).not.toContain(secret)
    expect(credentialPaths(payload)).toEqual([])
    // Built-in sections project accounts field by field, so the scrubbing
    // backstop never has anything to drop from them.
    expect(m.warnings).toEqual([])
    const accounts = payload.menu.sections.find((s) => s.id === 'accounts')
    expect(accounts?.items.map((item) => item.account)).toEqual([
      {
        id: 'a',
        label: 'Alice',
        enabled: true,
        type: 'oauth',
        identity: 'acct-a',
      },
      { id: 'b', enabled: true, type: 'oauth', identity: 'acct-b' },
      { id: 'k', label: 'Keyed', enabled: true, type: 'api' },
    ])
  })

  it('a plugin section leaking a credential-shaped field is scrubbed and the dropped names are warned, never the values', async () => {
    await populate(m.store)
    const menu = m.menu({
      diagnostics: {
        title: 'Diagnostics',
        build: () => ({
          facts: {
            level: 'info',
            apiKey: 'sk-leak-1',
            nested: { refresh_token: 'rt-leak-2', fine: 'yes' },
          },
          items: [
            {
              id: 'dump',
              label: 'Dumps',
              facts: { access: 'at-leak-3', 'Client-Secret': 'cs-leak-4' },
            },
          ],
        }),
      },
    })
    const payload = await menu.open(notes().invocation)
    const text = JSON.stringify(payload)
    for (const leak of ['sk-leak-1', 'rt-leak-2', 'at-leak-3', 'cs-leak-4'])
      expect(text).not.toContain(leak)
    const diagnostics = payload.menu.sections.find(
      (s) => s.id === 'diagnostics',
    )
    expect(diagnostics?.facts).toEqual({
      level: 'info',
      nested: { fine: 'yes' },
    })
    expect(diagnostics?.items[0]?.facts).toEqual({})
    expect(m.warnings).toHaveLength(1)
    expect(m.warnings[0]?.message).toBe(
      'credential-shaped field dropped from a command payload',
    )
    expect(m.warnings[0]?.data).toEqual({
      command: 'acme',
      fields: [
        'payload.menu.sections[4].items[0].facts.access',
        'payload.menu.sections[4].items[0].facts.Client-Secret',
        'payload.menu.sections[4].facts.apiKey',
        'payload.menu.sections[4].facts.nested.refresh_token',
      ],
    })
    expect(JSON.stringify(m.warnings)).not.toContain('leak')
  })

  it('an apply result passes through the same scrub as the dialog payload', async () => {
    const menu = m.menu({
      cache: {
        title: 'Cache',
        build: () => ({
          facts: { sessionToken: 'tok-leak' },
          actions: [
            { id: 'warm', label: 'Warm now', run: async () => 'Warmed.' },
          ],
        }),
      },
    })
    const result = await apply(menu, notes().invocation, {
      sectionId: 'cache',
      actionId: 'warm',
    })
    expect(result.ok).toBe(true)
    expect(result.text).toBe('Warmed.')
    expect(JSON.stringify(result)).not.toContain('tok-leak')
    expect(m.warnings.map((w) => w.data)).toContainEqual({
      command: 'acme',
      fields: ['payload.menu.sections[4].facts.sessionToken'],
    })
  })
})
