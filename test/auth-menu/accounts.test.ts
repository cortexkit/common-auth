import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  type AccountMenuOptions,
  accountMenuActions,
  MENU_DISABLE_REASON,
  runAccountMenu,
} from '../../src/auth-menu/accounts.js'
import type { LoginAccount, MenuLogin } from '../../src/auth-menu/login.js'
import { quotaCodec } from '../../src/quota/index.js'
import { POOL_KEY } from '../../src/store/index.js'
import { oauth, type Scenario, scenario } from '../store/helpers.js'
import { choose, fakeTerminal, KEY, NO, YES } from './helpers.js'

let s: Scenario
beforeEach(async () => {
  s = await scenario('auth-menu-')
})
afterEach(() => s.cleanup())

/** Local-mode action order with a login and no doctor checks. */
const LOCAL = {
  add: 0,
  reauth: 1,
  remove: 2,
  toggle: 3,
  quotas: 4,
  deleteAll: 5,
} as const

async function seed(ids: readonly string[]) {
  const store = s.open()
  for (const id of ids)
    await store.add({
      id,
      credential: oauth(`refresh-${id}`),
      identity: `acct-${id}`,
    })
}

async function rosterIds(): Promise<string[]> {
  return (await s.config()).accounts.map((row: { id: string }) => row.id)
}

function loginReturning(account: LoginAccount): MenuLogin {
  return {
    begin: async () => ({
      url: 'https://auth.example/browser',
      instructions: 'Browser instructions',
      completion: Promise.resolve(account),
    }),
    openBrowser: () => true,
  }
}

function menu(
  keys: readonly string[],
  overrides: Partial<AccountMenuOptions> = {},
) {
  const fake = fakeTerminal(keys)
  const options: AccountMenuOptions = {
    title: 'Example accounts',
    store: s.open(),
    terminal: fake.terminal,
    login: loginReturning({ credential: oauth('refresh-new') }),
    ...overrides,
  }
  return { fake, run: () => runAccountMenu(options) }
}

const protectMain: AccountMenuOptions['protect'] = (id) =>
  id === 'main' ? 'main is the account the host signs in with' : undefined

describe('OpenCode auth menu', () => {
  test('opening and cancelling the menu performs no network calls', async () => {
    await seed(['fallback'])
    const before = await s.bytes()
    let networkCalls = 0
    const { run } = menu([KEY.ctrlC], {
      login: {
        begin: async () => {
          networkCalls += 1
          throw new Error('unexpected network call')
        },
      },
      pollQuota: async () => {
        networkCalls += 1
        throw new Error('unexpected network call')
      },
    })

    expect(await run()).toEqual({ status: 'cancelled' })
    expect(networkCalls).toBe(0)
    expect(await s.bytes()).toEqual(before)
  })

  test('Add account falls back to device flow when the browser opener throws', async () => {
    await seed(['existing'])
    const starts: boolean[] = []
    const login: MenuLogin = {
      begin: async (options) => {
        starts.push(options.headless)
        if (options.headless) {
          return {
            url: 'https://auth.example/device',
            instructions: 'Enter code: DEVICE-CODE',
            completion: Promise.resolve({
              id: 'device-account',
              credential: oauth('refresh-device'),
              identity: 'acct-device',
            }),
          }
        }
        return {
          url: 'https://auth.example/browser',
          instructions: 'Browser instructions',
          completion: new Promise<LoginAccount>((_resolve, reject) => {
            options.signal?.addEventListener('abort', () =>
              reject(new Error('Login cancelled')),
            )
          }),
        }
      },
      openBrowser: () => {
        throw new Error('no browser')
      },
    }
    const { fake, run } = menu(choose(LOCAL.add), { login })

    expect(await run()).toEqual({ status: 'ran', action: 'add-account' })

    expect(starts).toEqual([false, true])
    expect(fake.text()).toContain('https://auth.example/device')
    expect(fake.text()).toContain('Enter code: DEVICE-CODE')
    expect(fake.text()).toContain('Added account device-account.')
    expect(await rosterIds()).toEqual(['existing', 'device-account'])
    expect((await s.state()).accounts['device-account'].refresh).toBe(
      'refresh-device',
    )
  })

  test('Delete all removes every non-main raw id and prunes matching state', async () => {
    await seed(['main', 'a', 'b'])
    const { fake, run } = menu([KEY.up, KEY.enter, ...YES], {
      protect: protectMain,
    })

    expect(await run()).toEqual({ status: 'ran', action: 'delete-all' })

    expect(await rosterIds()).toEqual(['main'])
    const config = await s.config()
    expect(Object.keys(config[POOL_KEY].rows)).toEqual(['main'])
    expect(Object.keys((await s.state()).accounts)).toEqual(['main'])
    expect(fake.text()).toContain('Deleted 2 account(s).')
    expect(fake.text()).toContain(
      'Kept: main (main is the account the host signs in with).',
    )
  })

  test('declining Delete all leaves both files byte-unchanged', async () => {
    await seed(['main', 'a'])
    const before = await s.bytes()
    const { run } = menu([KEY.up, KEY.enter, ...NO], { protect: protectMain })

    expect(await run()).toEqual({ status: 'declined', action: 'delete-all' })
    expect(await s.bytes()).toEqual(before)
  })
})

describe('account actions', () => {
  test('Remove keeps a protected account and removes another after confirmation', async () => {
    await seed(['main', 'spare'])

    const protectedRun = menu([...choose(LOCAL.remove), KEY.enter, ...YES], {
      protect: protectMain,
    })
    await protectedRun.run()
    expect(protectedRun.fake.text()).toContain(
      'Account main was kept: main is the account the host signs in with',
    )
    expect(await rosterIds()).toEqual(['main', 'spare'])

    const declined = menu([...choose(LOCAL.remove), ...choose(1), ...NO])
    await declined.run()
    expect(await rosterIds()).toEqual(['main', 'spare'])

    const removed = menu([...choose(LOCAL.remove), ...choose(1), ...YES], {
      protect: protectMain,
    })
    await removed.run()
    expect(removed.fake.text()).toContain('Removed account spare.')
    expect(await rosterIds()).toEqual(['main'])
  })

  test('enable or disable toggles the chosen account through the store', async () => {
    await seed(['a', 'b'])

    await menu([...choose(LOCAL.toggle), ...choose(1)]).run()
    let load = await s.open().read()
    if (load.status !== 'ready') throw new Error(load.status)
    expect(load.rows.map((row) => [row.id, row.enabled])).toEqual([
      ['a', true],
      ['b', false],
    ])
    expect(load.rows[1]?.disabledReason).toBe(MENU_DISABLE_REASON)

    await menu([...choose(LOCAL.toggle), ...choose(1)]).run()
    load = await s.open().read()
    if (load.status !== 'ready') throw new Error(load.status)
    expect(load.rows.map((row) => row.enabled)).toEqual([true, true])
  })

  test('Re-authenticate replaces the chosen account credential', async () => {
    await seed(['a', 'b'])
    const { fake, run } = menu([...choose(LOCAL.reauth), ...choose(1)], {
      login: loginReturning({
        credential: oauth('refresh-b-again'),
        identity: 'acct-b',
      }),
    })

    await run()

    expect(fake.text()).toContain('Updated the sign-in of account b.')
    const state = await s.state()
    expect(state.accounts.b.refresh).toBe('refresh-b-again')
    expect(state.accounts.a.refresh).toBe('refresh-a')
  })

  test('Re-authenticate refuses a sign-in as a different account', async () => {
    await seed(['a'])
    const before = await s.bytes()
    const { fake, run } = menu([...choose(LOCAL.reauth), KEY.enter], {
      login: loginReturning({
        credential: oauth('refresh-other'),
        identity: 'acct-other',
      }),
    })

    await run()

    expect(fake.text()).toContain(
      'That sign-in is a different account from a; nothing was changed.',
    )
    expect(await s.bytes()).toEqual(before)
  })

  test('Check quotas polls each account once and prints its windows from the store', async () => {
    const quotaStore = () => s.open({ quota: quotaCodec })
    await seed(['a', 'b'])
    const polled: string[] = []
    const { fake, run } = menu(choose(LOCAL.quotas), {
      store: quotaStore(),
      pollQuota: async (row) => {
        polled.push(row.id)
        if (row.id === 'b') throw new Error('HTTP 503')
        return {
          checkedAt: 1_000,
          readings: [
            {
              label: 'primary',
              usedPercent: 42,
              windowMinutes: 300,
              resetsAt: '2030-01-01T00:00:00.000Z',
            },
          ],
        }
      },
    })

    expect(await run()).toEqual({ status: 'ran', action: 'check-quotas' })

    expect(polled).toEqual(['a', 'b'])
    expect(fake.text()).toContain(
      'a:\n  primary: 58% left, resets 2030-01-01T00:00:00.000Z\n',
    )
    expect(fake.text()).toContain(
      'b:\n  quota check failed: HTTP 503\n  no quota reading\n',
    )
    const load = await quotaStore().read()
    if (load.status !== 'ready') throw new Error(load.status)
    expect(load.rows[0]?.quota).toMatchObject({
      limits: [{ label: 'primary', usedPercent: 42 }],
    })
  })

  test('custody mode lists accounts read-only with enable and disable', async () => {
    await seed(['vaulted'])
    const options: AccountMenuOptions = {
      title: 'Example accounts',
      store: s.open(),
      login: loginReturning({ credential: oauth('refresh-new') }),
      doctor: [{ id: 'none', run: () => [] }],
    }

    const local = await accountMenuActions(options)
    expect(local.map((action) => action.id)).toEqual([
      'add-account',
      'reauthenticate',
      'remove-account',
      'toggle-account',
      'check-quotas',
      'doctor',
      'delete-all',
    ])

    const custody = await accountMenuActions({
      ...options,
      custody: () => true,
    })
    expect(custody.map((action) => action.id)).toEqual([
      'list-accounts',
      'toggle-account',
      'check-quotas',
      'doctor',
    ])

    const listing = menu(choose(0), { custody: () => true })
    await listing.run()
    expect(listing.fake.text()).toContain('Accounts come from the vault')
    expect(listing.fake.text()).toContain('vaulted: enabled\n')
  })
})
