import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { CommandDialogPayload } from '../../src/commands/index.js'
import {
  apply,
  type MenuScenario,
  menuScenario,
  notes,
  oauth,
  populate,
  rosterIds,
} from './helpers.js'

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

  it('accounts lists the roster in order with enabled state, identity and quota summary', async () => {
    await populate(m.store)
    await m.store.disable('b', 'manual')
    const accounts = section(
      await m.menu().open(notes().invocation),
      'accounts',
    )
    expect(accounts.lines).toEqual(['3 account(s), 2 enabled.'])
    expect(
      accounts.items.map((item) => [item.id, item.label, item.detail]),
    ).toEqual([
      [
        'a',
        'Alice',
        'OAuth · enabled · acct-a · secondary 90% left · primary 58% left · credits 75% left',
      ],
      ['b', 'acct-b', 'OAuth · disabled (manual) · acct-b · primary 1% left'],
      ['k', 'Keyed', 'API key · enabled · no quota reading yet'],
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
      detail: 'secondary 90% left · primary 58% left · credits 75% left',
      facts: {
        primary: '42% used, resets in 1h 30m',
        secondary: '10% used',
        credits: '75% left',
      },
    })
    const all = await apply(menu, notes().invocation, {
      sectionId: 'quota',
      actionId: 'check',
      values: { account: '*' },
    })
    expect(all).toMatchObject({
      ok: true,
      text: 'Checked quota for 3 account(s).',
    })
    const one = await apply(menu, notes().invocation, {
      sectionId: 'quota',
      actionId: 'check',
      values: { account: 'b' },
    })
    expect(one.ok).toBe(true)
    expect(polled).toEqual([['a', 'b', 'k'], ['b']])
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
      'Mode: Ordered (roster order).',
      'Roster order: a, b, k.',
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
      'Mode: Main first.',
      'Roster order: a, b, k.',
      'Tried in order: b, a, k.',
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
    expect(limits.lines[0]).toBe('Killswitch: off.')
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
      text: 'Minimum % left for primary must be at most 100.',
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
})
