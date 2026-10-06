import { beforeEach, describe, expect } from 'bun:test'
import { runPiCommandMenu } from '../../src/commands/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import {
  apiKey,
  type MenuScenario,
  menuScenario,
  populate,
  rosterIds,
} from './helpers.js'
import { fakePiUi } from './pi-ui.js'

const hooks = lifetimeHooks()
const { afterEach, it } = hooks

let m: MenuScenario
beforeEach(async () => {
  m = await menuScenario()
})
afterEach(() => m.cleanup())

describe('Pi renderer', () => {
  it('the Pi renderer drives add, reorder and remove through the same menu', async () => {
    await populate(m.store)
    const menu = m.menu({
      accounts: {
        login: {
          knobs: [
            {
              kind: 'text',
              id: 'paste',
              label: 'API key',
              masked: true,
              required: true,
            },
          ],
          run: async (values) => ({
            status: 'ready',
            account: {
              id: 'z',
              credential: apiKey(String(values.paste)),
              label: 'Zed',
            },
          }),
        },
      },
    })
    const ui = fakePiUi([
      { select: 'Accounts' },
      { select: 'Add account' },
      { input: 'sk-typed' },
      // Back in Accounts with the refreshed roster: move Zed to the top.
      { select: 'Zed' },
      { select: 'Move' },
      { select: '1' },
      // Then remove Alice, confirming.
      { select: 'Alice' },
      { select: 'Remove' },
      { confirm: true },
    ])
    await runPiCommandMenu(menu, ui, { sessionId: 'pi-1' })
    expect(ui.remaining()).toBe(0)
    expect(await rosterIds(m.store)).toEqual(['z', 'b', 'k'])
    expect(ui.notified).toEqual([
      { message: 'Added Zed.', type: 'info' },
      { message: 'Moved Zed to position 1.', type: 'info' },
      { message: 'Removed Alice.', type: 'info' },
    ])
    // The top level lists the sections in the fixed order.
    expect(ui.calls[0]).toStartWith(
      'select Acme [Accounts: 3 account(s), 3 enabled. | Quota: Scope: all. | Routing: Mode: Ordered (roster order). | Limits: Killswitch: off.]',
    )
    expect(ui.calls).toContain(
      'confirm Remove: Remove Alice? Its stored credential is deleted.',
    )
  })

  it('the Pi renderer does not apply an irreversible action the user declines', async () => {
    await populate(m.store)
    const ui = fakePiUi([
      { select: 'Accounts' },
      { select: 'Alice' },
      { select: 'Remove' },
      { confirm: false },
    ])
    await runPiCommandMenu(m.menu(), ui)
    expect(ui.remaining()).toBe(0)
    expect(await rosterIds(m.store)).toEqual(['a', 'b', 'k'])
    expect(ui.notified).toEqual([{ message: 'Cancelled.', type: undefined }])
  })
})
