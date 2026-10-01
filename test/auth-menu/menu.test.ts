import { describe, expect, mock, test } from 'bun:test'
import { confirm } from '../../src/auth-menu/confirm.js'
import { type MenuAction, runMenu } from '../../src/auth-menu/menu.js'
import {
  menuAuthorize,
  menuCompletedResult,
} from '../../src/auth-menu/opencode-v1.js'
import { choose, fakeTerminal, KEY, NO, YES } from './helpers.js'

function action(id: string, overrides: Partial<MenuAction> = {}) {
  const run = mock(async () => {})
  return {
    run,
    action: { id, label: `Action ${id}`, run, ...overrides } as MenuAction,
  }
}

async function expectMenuCompletionFailed(result: unknown) {
  expect(result).toMatchObject({ url: '', instructions: '', method: 'auto' })
  const callback = (result as { callback: () => Promise<unknown> }).callback
  expect(await callback()).toEqual({ type: 'failed' })
}

describe('menu runtime', () => {
  test('renders full-screen and moves the selection with the arrow keys', async () => {
    const first = action('first')
    const second = action('second', { hint: 'the second one' })
    const third = action('third')
    const fake = fakeTerminal([KEY.down, KEY.down, KEY.up, KEY.enter])

    const outcome = await runMenu({
      title: 'Example accounts',
      status: ['main: enabled'],
      actions: [first.action, second.action, third.action],
      terminal: fake.terminal,
    })

    expect(outcome).toEqual({ status: 'ran', action: 'second' })
    expect(second.run).toHaveBeenCalledTimes(1)
    expect(first.run).not.toHaveBeenCalled()
    expect(third.run).not.toHaveBeenCalled()
    const frames = fake.frames()
    expect(frames).toHaveLength(4)
    expect(frames[0]).toContain('Example accounts')
    expect(frames[0]).toContain('main: enabled')
    expect(frames[0]).toContain('● Action first')
    expect(frames[0]).toContain('○ Action second the second one')
    expect(frames[1]).toContain('● Action second')
    expect(frames[2]).toContain('● Action third')
    expect(frames[3]).toContain('● Action second')
    expect(frames[3]).toContain('○ Action third')
  })

  test('Escape cancels the menu, runs nothing and restores the terminal', async () => {
    const only = action('only')
    const fake = fakeTerminal([KEY.escape])

    const outcome = await runMenu({
      title: 'Example accounts',
      actions: [only.action, action('other').action],
      terminal: fake.terminal,
    })

    expect(outcome).toEqual({ status: 'cancelled' })
    expect(only.run).not.toHaveBeenCalled()
    expect(fake.rawModes).toEqual([true, false])
    expect(fake.listening()).toBe(0)
  })

  test('a non-interactive terminal gets a plain list and nothing runs', async () => {
    const add = action('add', { hint: 'sign in' })
    const remove = action('remove', { destructive: true })
    const fake = fakeTerminal([KEY.enter], { tty: false })

    const outcome = await runMenu({
      title: 'Example accounts',
      status: ['main: enabled'],
      actions: [add.action, remove.action],
      terminal: fake.terminal,
    })

    expect(outcome).toEqual({ status: 'not-interactive' })
    expect(add.run).not.toHaveBeenCalled()
    expect(remove.run).not.toHaveBeenCalled()
    expect(fake.rawModes).toEqual([])
    expect(fake.text()).toBe(
      [
        'Example accounts',
        '  main: enabled',
        '',
        'Actions:',
        '  - Action add (sign in)',
        '  - Action remove',
        '',
        'This menu needs an interactive terminal to choose an action; nothing was changed.',
        '',
      ].join('\n'),
    )
  })

  test('a destructive action does not run when its confirmation is declined', async () => {
    const wipe = action('wipe', { destructive: true, confirm: 'Wipe it?' })
    const fake = fakeTerminal([...choose(0), ...NO])

    const outcome = await runMenu({
      title: 'Example accounts',
      actions: [wipe.action, action('other').action],
      terminal: fake.terminal,
    })

    expect(outcome).toEqual({ status: 'declined', action: 'wipe' })
    expect(wipe.run).not.toHaveBeenCalled()
    expect(fake.text()).toContain('Wipe it?')
  })

  test('a destructive action runs after an explicit yes', async () => {
    const wipe = action('wipe', { destructive: true })
    const fake = fakeTerminal([...choose(0), ...YES])

    const outcome = await runMenu({
      title: 'Example accounts',
      actions: [wipe.action, action('other').action],
      terminal: fake.terminal,
    })

    expect(outcome).toEqual({ status: 'ran', action: 'wipe' })
    expect(wipe.run).toHaveBeenCalledTimes(1)
    expect(fake.text()).toContain('Action wipe?')
  })

  test('confirm answers no without an interactive terminal', async () => {
    const fake = fakeTerminal([KEY.down, KEY.enter], { tty: false })
    expect(await confirm(fake.terminal, 'Delete?')).toBe(false)
    expect(fake.pending()).toBe(2)
  })

  test('an action that throws is reported and the menu still completes', async () => {
    const broken = action('broken', {
      run: async () => {
        throw new Error('store is locked')
      },
    })
    const fake = fakeTerminal(choose(0))

    const outcome = await runMenu({
      title: 'Example accounts',
      actions: [broken.action, action('other').action],
      terminal: fake.terminal,
    })

    expect(outcome.status).toBe('failed')
    expect(fake.text()).toContain('Action broken failed: store is locked')
  })
})

describe('OpenCode v1 authorize contract', () => {
  test('the menu-completed result is an empty automatic login whose callback fails', async () => {
    const result = menuCompletedResult()
    expect(Object.keys(result).sort()).toEqual([
      'callback',
      'instructions',
      'method',
      'url',
    ])
    await expectMenuCompletionFailed(result)
  })

  test('keeps TUI login and first CLI login on the original browser flow', async () => {
    const browser = { url: 'https://auth.example/browser' }
    const login = mock(async () => browser)
    const hasCredential = mock(async () => false)
    const openMenu = mock(async () => {})
    const authorize = menuAuthorize({ login, hasCredential, openMenu })

    expect(await authorize()).toBe(browser)
    expect(hasCredential).not.toHaveBeenCalled()
    expect(openMenu).not.toHaveBeenCalled()

    expect(await authorize({})).toBe(browser)
    expect(hasCredential).toHaveBeenCalledTimes(1)
    expect(openMenu).not.toHaveBeenCalled()
  })

  // The state every ordinary user is in: signed in, no extra accounts yet.
  // Gating the menu on the account roster hid it from exactly the person who
  // came to add their first one. The predicate here answers from the host's
  // credential while the roster is empty.
  test('opens for a signed-in user who has no fallback accounts yet', async () => {
    const roster: string[] = []
    const hostCredential = { type: 'oauth', refresh: 'main-refresh' }
    const login = mock(async () => ({ url: 'https://auth.example/browser' }))
    const openMenu = mock(async () => {})
    const authorize = menuAuthorize({
      login,
      hasCredential: () => hostCredential !== undefined || roster.length > 0,
      openMenu,
    })

    const result = await authorize({})

    expect(openMenu).toHaveBeenCalledTimes(1)
    expect(login).not.toHaveBeenCalled()
    await expectMenuCompletionFailed(result)
  })
})
