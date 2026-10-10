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
      'select Acme [Accounts: 3 accounts, 3 enabled | Quota | Routing: Mode: Ordered (roster order) | Limits: Killswitch off]',
    )
    expect(ui.calls).toContain(
      'confirm Remove: Remove Alice? Its stored credential is deleted.',
    )
  })

  it('the Pi renderer shows group headers and rows without actions as title text it cannot select', async () => {
    await populate(m.store)
    const menu = m.menu()
    // A header is not an option, so choosing it fails the scripted run.
    await expect(
      runPiCommandMenu(
        menu,
        fakePiUi([{ select: 'Quota' }, { select: 'Accounts' }]),
      ),
    ).rejects.toThrow('no option starts with Accounts')

    const ui = fakePiUi([
      { select: 'Quota' },
      { select: 'Back' },
      { select: 'Accounts' },
      { select: 'Back' },
      { select: 'Limits' },
    ])
    await runPiCommandMenu(menu, ui)
    expect(ui.remaining()).toBe(0)
    expect(ui.calls.filter((call) => !call.startsWith('select Acme'))).toEqual([
      // Quota's accounts have no actions: they are text, not options.
      'select Quota [Check now | Back]',
      // Accounts' rows do something, so they are options with their status.
      'select Accounts [Alice · enabled | acct-b · enabled | Keyed · enabled | Back]',
      'select Limits [Alice · no floors | acct-b · no floors | Keyed · no floors | Turn killswitch on | Back]',
    ])
    const titles = ui.titles.filter((title) => !title.startsWith('Acme'))
    expect(titles).toEqual([
      [
        'Quota',
        'Accounts',
        '  Alice · 5h 58% left · 7d 90% left · credits 75% left',
        '  acct-b · 5h 1% left',
        '  Keyed · no quota reading yet',
      ].join('\n'),
      'Accounts\n3 accounts, 3 enabled',
      'Limits\nKillswitch off',
    ])
    expect(ui.notified).toEqual([])
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
