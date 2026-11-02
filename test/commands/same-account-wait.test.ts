import { beforeEach, describe, expect } from 'bun:test'
import {
  type CommandDialogPayload,
  runPiCommandMenu,
} from '../../src/commands/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import {
  apply,
  type MenuScenario,
  menuScenario,
  notes,
  populate,
} from './helpers.js'
import { fakePiUi } from './pi-ui.js'

const hooks = lifetimeHooks()
const { afterEach, it } = hooks

let m: MenuScenario
beforeEach(async () => {
  m = await menuScenario()
  await populate(m.store)
})
afterEach(() => m.cleanup())

const label = 'Longest wait on the same account'
const choices = [
  { value: '0', label: "Don't wait" },
  { value: '15', label: '15 minutes' },
  { value: 'max', label: 'Until the cache expires' },
]

function routing(payload: CommandDialogPayload) {
  const section = payload.menu.sections.find((entry) => entry.id === 'routing')
  if (!section) throw new Error('no routing section')
  return section
}

function waitKnob(payload: CommandDialogPayload) {
  const action = routing(payload).actions.find(
    (entry) => entry.id === 'maxSameAccountWait',
  )
  expect(action).toBeDefined()
  expect(action?.label).toBe(label)
  expect(action?.knobs).toHaveLength(1)
  return action?.knobs[0]
}

describe('same-account wait menu', () => {
  for (const [name, raw, expected] of [
    ['absent', undefined, '15'],
    ['zero', 0, '0'],
    ['fifteen', 15, '15'],
    ['max', 'max', 'max'],
    ['negative', -1, '15'],
    ['unsupported number', 30, '15'],
    ['string zero', '0', '15'],
    ['string fifteen', '15', '15'],
    ['unknown string', 'MAX', '15'],
    ['null', null, '15'],
    ['boolean', false, '15'],
    ['object', {}, '15'],
  ] as const) {
    it(`marks ${name} as ${expected} and offers exactly the three wait choices`, async () => {
      await m.store.updateSettings((settings) => {
        settings.routing = { maxSameAccountWait: raw }
        return undefined
      })
      const menu = m.menu({ routing: { sameAccountWait: true } })
      const payload = await menu.open(notes().invocation)
      expect(waitKnob(payload)).toEqual({
        kind: 'choice',
        id: 'maxSameAccountWait',
        label,
        choices,
        value: expected,
      })
      expect(routing(payload).lines).toContain(
        `${label}: ${choices.find((choice) => choice.value === expected)?.label}`,
      )
    })
  }

  it('defaults to 15 when routing settings are missing', async () => {
    const menu = m.menu({ routing: { sameAccountWait: true } })
    expect(waitKnob(await menu.open(notes().invocation))?.value).toBe('15')
  })

  it('persists 0, 15 and max through updateSettings with extraLocks and preserves other settings', async () => {
    await m.store.updateSettings((settings) => {
      settings.routing = { mode: 'sticky-balanced', pluginOption: 'kept' }
      settings.logging = { level: 'debug' }
      return undefined
    })
    const acquired: string[] = []
    const store = m.s.open({
      onLockEvent: (event) => {
        if (event.type === 'acquired') acquired.push(event.name)
      },
    })
    const menu = m.menu({
      store,
      extraLocks: [{ name: 'legacy-writer', path: m.s.statePath }],
      routing: { sameAccountWait: true },
    })
    const n = notes()
    for (const [value, persisted] of [
      ['0', 0],
      ['15', 15],
      ['max', 'max'],
    ] as const) {
      acquired.length = 0
      const result = await apply(menu, n.invocation, {
        sectionId: 'routing',
        actionId: 'maxSameAccountWait',
        values: { maxSameAccountWait: value },
      })
      expect(result.ok).toBe(true)
      expect(acquired).toEqual(['legacy-writer', 'save', 'save'])
      expect((await m.s.config()).routing).toEqual({
        mode: 'sticky-balanced',
        pluginOption: 'kept',
        maxSameAccountWait: persisted,
      })
      expect((await m.s.config()).logging).toEqual({ level: 'debug' })
      expect(waitKnob(result)?.value).toBe(value)
      expect(waitKnob(await menu.open(n.invocation))?.value).toBe(value)
    }
    const before = await m.s.bytes()
    const refused = await apply(menu, n.invocation, {
      sectionId: 'routing',
      actionId: 'maxSameAccountWait',
      values: { maxSameAccountWait: '30' },
    })
    expect(refused.ok).toBe(false)
    expect(await m.s.bytes()).toEqual(before)
  })

  it('leaves the menu unchanged unless sameAccountWait is true', async () => {
    await m.store.updateSettings((settings) => {
      settings.routing = { maxSameAccountWait: 0 }
      return undefined
    })
    const invocation = notes().invocation
    const original = await m.menu().open(invocation)
    const section = routing(original)
    expect(section.lines).toEqual([
      'Mode: Ordered (roster order)',
      'Roster order: a, b, k',
    ])
    expect(section.actions.map((action) => action.id)).toEqual([
      'mode',
      'order',
    ])
    for (const options of [{}, { sameAccountWait: false }]) {
      expect(await m.menu({ routing: options }).open(invocation)).toEqual(
        original,
      )
    }
    const refused = await apply(m.menu(), invocation, {
      sectionId: 'routing',
      actionId: 'maxSameAccountWait',
      values: { maxSameAccountWait: 'max' },
    })
    expect(refused.ok).toBe(false)
    expect((await m.s.config()).routing).toEqual({ maxSameAccountWait: 0 })
  })

  it('round-trips all wait choices and their current marks through the Pi renderer', async () => {
    const menu = m.menu({ routing: { sameAccountWait: true } })
    const ui = fakePiUi([
      { select: 'Routing' },
      { select: label },
      { select: "Don't wait" },
      { select: label },
      { select: 'Until the cache expires' },
      { select: label },
      { select: '15 minutes' },
      { select: label },
      { select: undefined },
    ])
    await runPiCommandMenu(menu, ui)
    expect(ui.remaining()).toBe(0)
    expect(
      ui.calls.filter((call) => call.startsWith(`select ${label} [`)),
    ).toEqual([
      `select ${label} [Don't wait | 15 minutes (current) | Until the cache expires]`,
      `select ${label} [Don't wait (current) | 15 minutes | Until the cache expires]`,
      `select ${label} [Don't wait | 15 minutes | Until the cache expires (current)]`,
      `select ${label} [Don't wait | 15 minutes (current) | Until the cache expires]`,
    ])
    expect(ui.notified.map((entry) => entry.type)).toEqual([
      'info',
      'info',
      'info',
    ])
    expect((await m.s.config()).routing).toEqual({ maxSameAccountWait: 15 })
    expect(waitKnob(await menu.open(notes().invocation))?.value).toBe('15')
  })
})
