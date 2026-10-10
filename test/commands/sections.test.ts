import { beforeEach, describe, expect } from 'bun:test'
import type { CommandDialogPayload } from '../../src/commands/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import {
  apply,
  type MenuScenario,
  menuScenario,
  notes,
  oauth,
  populate,
  rosterIds,
} from './helpers.js'

const hooks = lifetimeHooks()
const { afterEach, it } = hooks

let m: MenuScenario
beforeEach(async () => {
  m = await menuScenario()
})
afterEach(() => m.cleanup())

function section(payload: CommandDialogPayload, id: string) {
  const found = payload.menu.sections.find((entry) => entry.id === id)
  if (!found) throw new Error(`no section ${id}`)
  return found
}

async function rows() {
  const load = await m.store.read()
  if (load.status !== 'ready') throw new Error('expected ready')
  return load.rows
}

describe('command menu sections', () => {
  it('sections come in the fixed order whatever order the plugin supplies them in', async () => {
    const plugin = (title: string) => ({ title, build: () => ({}) })
    const menu = m.menu({
      extras: [
        { id: 'fast', ...plugin('Fast mode') },
        { id: 'prime', ...plugin('Prime') },
      ],
      diagnostics: plugin('Diagnostics'),
      cache: plugin('Cache'),
    })
    const payload = await menu.open(notes().invocation)
    expect(
      payload.menu.sections.map((entry) => [entry.id, entry.slot]),
    ).toEqual([
      ['accounts', 'accounts'],
      ['quota', 'quota'],
      ['routing', 'routing'],
      ['limits', 'limits'],
      ['cache', 'cache'],
      ['diagnostics', 'diagnostics'],
      ['fast', 'extra'],
      ['prime', 'extra'],
    ])
    expect(() => m.menu({ extras: [{ id: 'quota', ...plugin('X') }] })).toThrow(
      'extra section id quota is taken',
    )
  })

  it('accounts lists the roster in order with enabled state as status and type and identity as detail', async () => {
    await populate(m.store)
    await m.store.disable('b', 'manual')
    const accounts = section(
      await m.menu().open(notes().invocation),
      'accounts',
    )
    expect(accounts.lines).toEqual(['3 accounts, 2 enabled'])
    expect(
      accounts.items.map((item) => [
        item.id,
        item.label,
        item.status,
        item.detail,
      ]),
    ).toEqual([
      ['a', 'Alice', 'enabled', 'OAuth · acct-a'],
      ['b', 'acct-b', 'disabled', 'OAuth · acct-b · disabled: manual'],
      ['k', 'Keyed', 'enabled', 'API key'],
    ])
    expect(accounts.items.map((item) => item.actions.map((a) => a.id))).toEqual(
      [
        ['disable', 'move', 'remove'],
        ['enable', 'move', 'remove'],
        ['disable', 'move', 'remove'],
      ],
    )
  })

  it('add through a ready login adds the account to the store', async () => {
    const menu = m.menu({
      accounts: {
        login: {
          knobs: [{ kind: 'text', id: 'name', label: 'Name' }],
          run: async (values) => ({
            status: 'ready',
            account: {
              id: 'new',
              credential: oauth('refresh-new'),
              label: String(values.name),
            },
          }),
        },
      },
    })
    const result = await apply(menu, notes().invocation, {
      sectionId: 'accounts',
      actionId: 'add',
      values: { name: 'Newcomer' },
    })
    expect(result).toMatchObject({ ok: true, text: 'Added Newcomer.' })
    expect(await rosterIds(m.store)).toEqual(['new'])
    expect(result.menu.sections[0]?.items.map((item) => item.label)).toEqual([
      'Newcomer',
    ])
  })

  it('remove deletes the account from the store only once confirmed, and protect refuses an id', async () => {
    await populate(m.store)
    const menu = m.menu({
      accounts: {
        protect: (id) => (id === 'a' ? 'the main account stays' : undefined),
      },
    })
    const n = notes()
    const unconfirmed = await apply(menu, n.invocation, {
      sectionId: 'accounts',
      itemId: 'b',
      actionId: 'remove',
    })
    expect(unconfirmed).toMatchObject({
      ok: false,
      needsConfirmation: true,
      text: 'Remove acct-b? Its stored credential is deleted.',
    })
    expect(await rosterIds(m.store)).toEqual(['a', 'b', 'k'])
    const removed = await apply(menu, n.invocation, {
      sectionId: 'accounts',
      itemId: 'b',
      actionId: 'remove',
      confirmed: true,
    })
    expect(removed).toMatchObject({ ok: true, text: 'Removed acct-b.' })
    expect(await rosterIds(m.store)).toEqual(['a', 'k'])
    const refused = await apply(menu, n.invocation, {
      sectionId: 'accounts',
      itemId: 'a',
      actionId: 'remove',
      confirmed: true,
    })
    expect(refused.ok).toBe(false)
    expect(refused.text).toContain('the main account stays')
    expect(await rosterIds(m.store)).toEqual(['a', 'k'])
  })

  it('disable and enable toggle the account in the store', async () => {
    await populate(m.store)
    const menu = m.menu()
    const n = notes()
    const off = await apply(menu, n.invocation, {
      sectionId: 'accounts',
      itemId: 'a',
      actionId: 'disable',
    })
    expect(off).toMatchObject({ ok: true, text: 'Disabled Alice.' })
    expect((await rows()).find((row) => row.id === 'a')).toMatchObject({
      enabled: false,
      disabledReason: 'disabled from the command menu',
    })
    const on = await apply(menu, n.invocation, {
      sectionId: 'accounts',
      itemId: 'a',
      actionId: 'enable',
    })
    expect(on).toMatchObject({ ok: true, text: 'Enabled Alice.' })
    expect((await rows()).find((row) => row.id === 'a')?.enabled).toBe(true)
  })

  it('move and set order reorder the roster through store.reorder, and a bad order is refused', async () => {
    await populate(m.store)
    const menu = m.menu()
    const n = notes()
    const moved = await apply(menu, n.invocation, {
      sectionId: 'accounts',
      itemId: 'k',
      actionId: 'move',
      values: { position: '1' },
    })
    expect(moved).toMatchObject({
      ok: true,
      text: 'Moved Keyed to position 1.',
    })
    expect(await rosterIds(m.store)).toEqual(['k', 'a', 'b'])
    const ordered = await apply(menu, n.invocation, {
      sectionId: 'routing',
      actionId: 'order',
      values: { order: 'b, a k' },
    })
    expect(ordered).toMatchObject({ ok: true, text: 'Order set to b, a, k.' })
    expect(await rosterIds(m.store)).toEqual(['b', 'a', 'k'])
    const bad = await apply(menu, n.invocation, {
      sectionId: 'routing',
      actionId: 'order',
      values: { order: 'b, a' },
    })
    expect(bad).toMatchObject({
      ok: false,
      text: 'the order leaves out roster id(s) k',
    })
    expect(await rosterIds(m.store)).toEqual(['b', 'a', 'k'])
  })

  it('quota shows per-account windows and credit budget, and check now goes through the plugin poll', async () => {
    await populate(m.store)
    const polled: string[][] = []
    const menu = m.menu({
      quota: { check: async (ids) => void polled.push([...ids]) },
    })
    const quota = section(await menu.open(notes().invocation), 'quota')
    expect(quota.items[0]).toMatchObject({
      id: 'a',
      status: '5h 58% left · 7d 90% left · credits 75% left',
      detail: '5h 58% left, resets 2h · 7d 90% left · credits 75% left',
    })
    const all = await apply(menu, notes().invocation, {
      sectionId: 'quota',
      actionId: 'check',
    })
    expect(all).toMatchObject({
      ok: true,
      text: 'Checked quota for 3 accounts.',
    })
    expect(polled).toEqual([['a', 'b', 'k']])
  })

  it('an account row in quota checks exactly that account, through the plugin poll or a store pull', async () => {
    await populate(m.store)
    const polled: string[][] = []
    const menu = m.menu({
      quota: { check: async (ids) => void polled.push([...ids]) },
    })
    const quota = section(await menu.open(notes().invocation), 'quota')
    expect(
      quota.items.map((item) => item.actions.map((action) => action.label)),
    ).toEqual([
      ['Check this account'],
      ['Check this account'],
      ['Check this account'],
    ])
    const one = await apply(menu, notes().invocation, {
      sectionId: 'quota',
      itemId: 'b',
      actionId: 'check',
    })
    expect(one).toMatchObject({ ok: true, text: 'Checked quota for acct-b.' })
    expect(polled).toEqual([['b']])

    // Without a plugin poll, only that row's reading is requested.
    const requested: string[] = []
    const requestReading = m.store.requestReading.bind(m.store)
    m.store.requestReading = (id) => {
      requested.push(id)
      requestReading(id)
    }
    const pulled = await apply(m.menu(), notes().invocation, {
      sectionId: 'quota',
      itemId: 'k',
      actionId: 'check',
    })
    expect(pulled).toMatchObject({ ok: true, text: 'Checked quota for Keyed.' })
    expect(requested).toEqual(['k'])
  })

  it('no built-in section emits an item without actions, and an account that cannot be checked is a quota line', async () => {
    await populate(m.store)
    await m.store.disable('b', 'manual')
    const menu = m.menu({
      accounts: { login: { run: async () => ({ status: 'cancelled' }) } },
    })
    const payload = await menu.open(notes().invocation)
    for (const found of payload.menu.sections)
      for (const item of found.items)
        expect(
          item.actions.length,
          `${found.id}/${item.id} does nothing when chosen`,
        ).toBeGreaterThan(0)
    const quota = section(payload, 'quota')
    expect(quota.items.map((item) => item.id)).toEqual(['a', 'k'])
    expect(quota.lines).toEqual(['acct-b (disabled): 5h 1% left'])
  })

  it('routing mode writes routing.mode beside the pool', async () => {
    await populate(m.store)
    const menu = m.menu({
      routing: {
        orderedVariants: [{ value: 'main-first', label: 'Main first' }],
        formerMainId: 'b',
      },
    })
    const n = notes()
    const routing = section(await menu.open(n.invocation), 'routing')
    expect(routing.lines).toEqual([
      'Mode: Ordered (roster order)',
      'Roster order: a, b, k',
    ])
    expect(routing.actions[0]?.knobs[0]).toMatchObject({
      kind: 'choice',
      value: 'ordered',
      choices: [
        { value: 'ordered' },
        { value: 'main-first' },
        { value: 'sticky-balanced' },
      ],
    })
    const result = await apply(menu, n.invocation, {
      sectionId: 'routing',
      actionId: 'mode',
      values: { mode: 'main-first' },
    })
    expect(result).toMatchObject({
      ok: true,
      text: 'Routing mode set to Main first.',
    })
    expect((await m.s.config()).routing).toEqual({ mode: 'main-first' })
    expect(
      result.menu.sections.find((entry) => entry.id === 'routing')?.lines,
    ).toEqual([
      'Mode: Main first',
      'Roster order: a, b, k',
      'Tried in order: b, a, k',
    ])
    const refused = await apply(menu, n.invocation, {
      sectionId: 'routing',
      actionId: 'mode',
      values: { mode: 'random' },
    })
    expect(refused.ok).toBe(false)
    expect((await m.s.config()).routing).toEqual({ mode: 'main-first' })
  })

  it('limits toggles killswitch.enabled and writes per-account floors under killswitch.accounts', async () => {
    await populate(m.store)
    const menu = m.menu()
    const n = notes()
    const limits = section(await menu.open(n.invocation), 'limits')
    expect(limits.lines).toEqual(['Killswitch off'])
    expect(limits.items[0]?.actions[0]?.knobs.map((knob) => knob.id)).toEqual([
      'secondary',
      'primary',
    ])
    expect(
      await apply(menu, n.invocation, {
        sectionId: 'limits',
        actionId: 'killswitch',
        values: { enabled: true },
      }),
    ).toMatchObject({ ok: true, text: 'Killswitch on.' })
    const floors = await apply(menu, n.invocation, {
      sectionId: 'limits',
      itemId: 'a',
      actionId: 'floors',
      values: { primary: 10, secondary: null },
    })
    expect(floors).toMatchObject({
      ok: true,
      text: 'Floors updated for Alice.',
    })
    expect((await m.s.config()).killswitch).toEqual({
      enabled: true,
      accounts: { a: { primary: 10 } },
    })
    const tooHigh = await apply(menu, n.invocation, {
      sectionId: 'limits',
      itemId: 'a',
      actionId: 'floors',
      values: { primary: 140 },
    })
    expect(tooHigh).toMatchObject({
      ok: false,
      text: 'Minimum % left for 5h must be at most 100.',
    })
    // Clearing the last floor drops the account's entry.
    await apply(menu, n.invocation, {
      sectionId: 'limits',
      itemId: 'a',
      actionId: 'floors',
      values: { primary: null },
    })
    expect((await m.s.config()).killswitch).toEqual({ enabled: true })
    // The pool itself is untouched by every settings write.
    expect(await rosterIds(m.store)).toEqual(['a', 'b', 'k'])
  })

  it('built-in sections list accounts and then actions under group headers, with summaries only as short lines', async () => {
    await populate(m.store)
    const menu = m.menu({
      accounts: {
        login: {
          run: async () => ({ status: 'cancelled' }),
        },
      },
    })
    const payload = await menu.open(notes().invocation)
    // Each row's group, in drawing order: the items, then the section actions.
    const rows = (id: string) => {
      const found = section(payload, id)
      return [
        ...found.items.map((item) => [item.group, item.label, item.status]),
        ...found.actions.map((action) => [action.group, action.label]),
      ]
    }
    expect(rows('accounts')).toEqual([
      ['Accounts', 'Alice', 'enabled'],
      ['Accounts', 'acct-b', 'enabled'],
      ['Accounts', 'Keyed', 'enabled'],
      ['Actions', 'Add account'],
    ])
    expect(rows('quota')).toEqual([
      ['Accounts', 'Alice', '5h 58% left · 7d 90% left · credits 75% left'],
      ['Accounts', 'acct-b', '5h 1% left'],
      ['Accounts', 'Keyed', 'no quota reading yet'],
      ['Actions', 'Check now'],
    ])
    expect(section(payload, 'quota').actions[0]?.knobs).toEqual([])
    await apply(menu, notes().invocation, {
      sectionId: 'limits',
      itemId: 'a',
      actionId: 'floors',
      values: { primary: 10, secondary: 20 },
    })
    const limits = section(await menu.open(notes().invocation), 'limits')
    expect(
      limits.items.map((item) => [item.group, item.label, item.status]),
    ).toEqual([
      ['Floors · killswitch off', 'Alice', '7d ≥20% · 5h ≥10%'],
      ['Floors · killswitch off', 'acct-b', 'no floors'],
      ['Floors · killswitch off', 'Keyed', 'no floors'],
    ])
    expect(limits.actions).toMatchObject([
      {
        id: 'killswitch',
        group: 'Actions',
        description:
          'With the killswitch on, an account whose quota falls below one of its floors is not used.',
      },
    ])
    expect(
      limits.items[0]?.actions[0]?.knobs.map((knob) => knob.label),
    ).toEqual(['Minimum % left for 7d', 'Minimum % left for 5h'])
    for (const id of ['accounts', 'quota', 'routing', 'limits']) {
      const found = section(payload, id)
      // A summary or an explanation is a line, never a row a user can press.
      const labels = [
        ...found.items.map((item) => item.label),
        ...found.actions.map((action) => action.label),
      ]
      for (const line of found.lines) expect(labels).not.toContain(line)
      for (const line of found.lines) {
        expect(line.length).toBeLessThanOrEqual(32)
        expect(line).not.toContain('(s)')
        expect(line).not.toEndWith('.')
      }
    }
    expect(section(payload, 'quota').lines).toEqual([])
    expect(JSON.stringify(payload)).not.toContain('Scope:')
    expect(JSON.stringify(payload)).not.toContain('not reported')
  })
})
