import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  type ActionDefinition,
  DEFAULT_IRREVERSIBLE_CONFIRMATION,
  parseApplyRequest,
} from '../../src/commands/index.js'
import { apply, type MenuScenario, menuScenario, notes } from './helpers.js'

let m: MenuScenario
beforeEach(async () => {
  m = await menuScenario()
})
afterEach(() => m.cleanup())

describe('confirmations and requests', () => {
  it('an irreversible action is refused without a confirmation and carries one even when its definition names none', async () => {
    let wiped = 0
    // Built outside the type checker, as a plain-JS plugin would: the type
    // requires `confirm` on an irreversible action, the menu enforces it.
    const wipe = {
      id: 'wipe',
      label: 'Wipe dumps',
      irreversible: true,
      run: async () => {
        wiped++
        return 'Wiped.'
      },
    } as unknown as ActionDefinition
    const menu = m.menu({
      diagnostics: { title: 'Diagnostics', build: () => ({ actions: [wipe] }) },
    })
    const payload = await menu.open(notes().invocation)
    const shown = payload.menu.sections.find((s) => s.id === 'diagnostics')
    expect(shown?.actions[0]?.confirm).toEqual({
      message: DEFAULT_IRREVERSIBLE_CONFIRMATION,
      irreversible: true,
    })
    const refused = await apply(menu, notes().invocation, {
      sectionId: 'diagnostics',
      actionId: 'wipe',
    })
    expect(refused).toMatchObject({
      ok: false,
      needsConfirmation: true,
      text: DEFAULT_IRREVERSIBLE_CONFIRMATION,
    })
    expect(wiped).toBe(0)
    const done = await apply(menu, notes().invocation, {
      sectionId: 'diagnostics',
      actionId: 'wipe',
      confirmed: true,
    })
    expect(done).toMatchObject({ ok: true, text: 'Wiped.' })
    expect(wiped).toBe(1)
  })

  it('parseApplyRequest keeps a well-formed request and refuses a malformed one', () => {
    expect(
      parseApplyRequest({
        command: 'acme',
        sectionId: 'accounts',
        itemId: 'a',
        actionId: 'remove',
        values: { position: '2', on: true, n: 3, cleared: null },
        confirmed: true,
        sessionId: 's-1',
        extra: 'dropped',
      }),
    ).toEqual({
      command: 'acme',
      sectionId: 'accounts',
      itemId: 'a',
      actionId: 'remove',
      values: { position: '2', on: true, n: 3, cleared: null },
      confirmed: true,
      sessionId: 's-1',
    })
    for (const bad of [
      null,
      [],
      { command: 'acme', sectionId: 'accounts' },
      { command: 'acme', sectionId: 'accounts', actionId: 1 },
      { command: 'acme', sectionId: 'a', actionId: 'b', values: [] },
      { command: 'acme', sectionId: 'a', actionId: 'b', values: { x: {} } },
      { command: 'acme', sectionId: 'a', actionId: 'b', confirmed: 'yes' },
    ])
      expect(parseApplyRequest(bad)).toBeUndefined()
  })
})
