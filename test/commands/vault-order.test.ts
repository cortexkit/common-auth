import { beforeEach, describe, expect } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  readVaultRoster,
  refreshVaultRoster,
  reorderVaultRoster,
  type VaultCredential,
} from '../../src/claustrum/index.js'
import type {
  CommandDialogPayload,
  VaultRoutingOrder,
} from '../../src/commands/index.js'
import { cleanupDirs, tempDir } from '../claustrum/helpers.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import {
  apply,
  type MenuScenario,
  menuScenario,
  notes,
  populate,
  rosterIds,
} from './helpers.js'

const hooks = lifetimeHooks()
const { afterEach, it } = hooks

let m: MenuScenario
beforeEach(async () => {
  m = await menuScenario()
})
afterEach(async () => {
  m.cleanup()
  await cleanupDirs()
})

function section(payload: CommandDialogPayload, id: string) {
  const found = payload.menu.sections.find((entry) => entry.id === id)
  if (!found) throw new Error(`no section ${id}`)
  return found
}

const credential = (name: string): VaultCredential => ({
  credentialId: `oauth:test:${name}`,
  credentialType: 'oauth',
  accountIdentity: `provider-${name}`,
  state: 'active',
})

/**
 * A vault roster with one row per name, in name order (discovery sorts new
 * rows by credential id), and the menu's view of its order. `labels` maps a
 * name to the label the plugin shows; by default the label is the name.
 */
async function vaultRoster(
  names: readonly string[],
  labels: Record<string, string> = {},
) {
  const path = join(await tempDir('command-vault-order-'), 'vault-roster.json')
  const roster = await refreshVaultRoster({
    path,
    custody: {
      discover: async () => ({
        view: 'v',
        credentials: names.map(credential),
        skipped: [],
      }),
    },
    projection: {
      mapAccount: (vault) => {
        const name = vault.credentialId.split(':').at(-1) ?? ''
        return { label: labels[name] ?? name }
      },
    },
  })
  const route: Record<string, string> = {}
  for (const row of roster?.rows ?? [])
    route[row.credentialId.split(':').at(-1) ?? ''] = row.routeId
  // What a plugin in vault mode wires (a plugin with a ClaustrumConsumer
  // passes its `snapshot()` rows and `reorder` instead).
  const order = async (): Promise<VaultRoutingOrder> => ({
    rows:
      (await readVaultRoster(path))?.rows.map((row) => ({
        id: row.routeId,
        label: row.label,
      })) ?? [],
    reorder: (next) => reorderVaultRoster(path, next),
  })
  const onDisk = async () =>
    (await readVaultRoster(path))?.rows.map((row) => row.routeId)
  const id = (name: string) => {
    const found = route[name]
    if (!found) throw new Error(`no route for ${name}`)
    return found
  }
  return { path, id, order, onDisk }
}

function setOrder(menu: ReturnType<MenuScenario['menu']>, order: string) {
  return apply(menu, notes().invocation, {
    sectionId: 'routing',
    actionId: 'order',
    values: { order },
  })
}

describe('routing set order in vault mode', () => {
  it('shows labels and sets the vault order from typed labels, leaving the pool roster alone', async () => {
    await populate(m.store)
    const v = await vaultRoster(['alpha', 'bravo', 'charlie'], {
      alpha: 'work',
      bravo: 'personal account',
      charlie: 'side',
    })
    const menu = m.menu({ routing: { vaultOrder: v.order } })
    const routing = section(await menu.open(notes().invocation), 'routing')
    expect(routing.lines).toEqual([
      'Mode: Ordered (roster order)',
      'Vault account order: work, personal account, side',
    ])
    expect(
      routing.actions.find((action) => action.id === 'order')?.knobs[0],
    ).toMatchObject({
      label: 'Vault accounts, first to last, separated by commas',
      value: 'work, personal account, side',
    })

    const ordered = await setOrder(menu, 'side, work,personal account')
    expect(ordered).toMatchObject({
      ok: true,
      text: 'Order set to side, work, personal account.',
    })
    expect(await v.onDisk()).toEqual([
      v.id('charlie'),
      v.id('alpha'),
      v.id('bravo'),
    ])
    expect(await rosterIds(m.store)).toEqual(['a', 'b', 'k'])
    expect(
      ordered.menu.sections.find((entry) => entry.id === 'routing')?.lines,
    ).toContain('Vault account order: side, work, personal account')
  })

  it('accepts labels and route ids mixed in one order', async () => {
    const v = await vaultRoster(['alpha', 'bravo', 'charlie'])
    const menu = m.menu({ routing: { vaultOrder: v.order } })
    const ordered = await setOrder(
      menu,
      `bravo, ${v.id('charlie')}, ${v.id('alpha')}`,
    )
    expect(ordered).toMatchObject({
      ok: true,
      text: 'Order set to bravo, charlie, alpha.',
    })
    expect(await v.onDisk()).toEqual([
      v.id('bravo'),
      v.id('charlie'),
      v.id('alpha'),
    ])
  })

  it('an unknown entry, a repeated account or a left-out account refuses, naming only what was typed, and writes nothing', async () => {
    const v = await vaultRoster(['alpha', 'bravo'])
    const menu = m.menu({ routing: { vaultOrder: v.order } })
    const before = await readFile(v.path, 'utf8')
    expect(await setOrder(menu, 'bravo, alpha, nobody')).toMatchObject({
      ok: false,
      code: 'vault-invalid-order',
      text: '"nobody" is not a vault account.',
    })
    expect(
      await setOrder(menu, `alpha, bravo, ${v.id('alpha')}`),
    ).toMatchObject({
      ok: false,
      code: 'vault-invalid-order',
      text: `"${v.id('alpha')}" names an account already in the order.`,
    })
    expect(await setOrder(menu, 'bravo')).toMatchObject({
      ok: false,
      code: 'vault-invalid-order',
      text: 'the order leaves out 1 roster route id',
    })
    expect(await readFile(v.path, 'utf8')).toBe(before)
  })

  it('a label two accounts share refuses as ambiguous and writes nothing; their route ids still work', async () => {
    const v = await vaultRoster(['alpha', 'bravo', 'charlie'], {
      alpha: 'team',
      charlie: 'team',
    })
    const menu = m.menu({ routing: { vaultOrder: v.order } })
    const routing = section(await menu.open(notes().invocation), 'routing')
    expect(routing.lines).toContain('Vault account order: team, bravo, team')
    // The input starts with route ids for the two accounts a label cannot
    // tell apart, so its default is an order that can be applied as is.
    expect(
      routing.actions.find((action) => action.id === 'order')?.knobs[0],
    ).toMatchObject({
      value: `${v.id('alpha')}, bravo, ${v.id('charlie')}`,
    })
    const before = await readFile(v.path, 'utf8')
    expect(await setOrder(menu, 'bravo, team, team')).toMatchObject({
      ok: false,
      code: 'vault-invalid-order',
      text: '"team" matches more than one vault account; enter those accounts by route id.',
    })
    expect(await readFile(v.path, 'utf8')).toBe(before)
    expect(
      await setOrder(menu, `${v.id('charlie')}, bravo, ${v.id('alpha')}`),
    ).toMatchObject({ ok: true, text: 'Order set to team, bravo, team.' })
    expect(await v.onDisk()).toEqual([
      v.id('charlie'),
      v.id('bravo'),
      v.id('alpha'),
    ])
  })

  it('outside vault mode the pool roster is shown and set as before', async () => {
    await populate(m.store)
    const v = await vaultRoster(['alpha', 'bravo'])
    const before = await readFile(v.path, 'utf8')
    const menu = m.menu({ routing: { vaultOrder: () => undefined } })
    expect(
      section(await menu.open(notes().invocation), 'routing').lines,
    ).toEqual(['Mode: Ordered (roster order)', 'Roster order: a, b, k'])
    expect(await setOrder(menu, 'k b, a')).toMatchObject({
      ok: true,
      text: 'Order set to k, b, a.',
    })
    expect(await rosterIds(m.store)).toEqual(['k', 'b', 'a'])
    expect(await readFile(v.path, 'utf8')).toBe(before)
  })
})
