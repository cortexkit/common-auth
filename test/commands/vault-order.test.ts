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

/** A vault roster of alpha then bravo, and the menu's view of its order. */
async function vaultRoster() {
  const path = join(await tempDir('command-vault-order-'), 'vault-roster.json')
  const roster = await refreshVaultRoster({
    path,
    custody: {
      discover: async () => ({
        view: 'v',
        credentials: [credential('bravo'), credential('alpha')],
        skipped: [],
      }),
    },
  })
  const ids = roster?.rows.map((row) => row.routeId) ?? []
  const [alpha, bravo] = ids
  if (!alpha || !bravo) throw new Error('no roster')
  // What a plugin in vault mode wires (a plugin with a ClaustrumConsumer
  // passes its `snapshot()` and `reorder` instead).
  const order = async (): Promise<VaultRoutingOrder> => ({
    ids: (await readVaultRoster(path))?.rows.map((row) => row.routeId) ?? [],
    reorder: (next) => reorderVaultRoster(path, next),
  })
  return { path, alpha, bravo, order }
}

describe('routing set order in vault mode', () => {
  it('shows and sets the vault accounts order through the roster, leaving the pool roster alone', async () => {
    await populate(m.store)
    const v = await vaultRoster()
    const menu = m.menu({ routing: { vaultOrder: v.order } })
    const n = notes()
    const routing = section(await menu.open(n.invocation), 'routing')
    expect(routing.lines).toEqual([
      'Mode: Ordered (roster order)',
      `Vault account order: ${v.alpha}, ${v.bravo}`,
    ])
    expect(
      routing.actions.find((action) => action.id === 'order')?.knobs[0],
    ).toMatchObject({
      label: 'Vault route ids, first to last',
      value: `${v.alpha}, ${v.bravo}`,
    })

    const ordered = await apply(menu, n.invocation, {
      sectionId: 'routing',
      actionId: 'order',
      values: { order: `${v.bravo} ${v.alpha}` },
    })
    expect(ordered).toMatchObject({
      ok: true,
      text: `Order set to ${v.bravo}, ${v.alpha}.`,
    })
    expect(
      (await readVaultRoster(v.path))?.rows.map((row) => row.routeId),
    ).toEqual([v.bravo, v.alpha])
    expect(await rosterIds(m.store)).toEqual(['a', 'b', 'k'])
    expect(
      ordered.menu.sections.find((entry) => entry.id === 'routing')?.lines,
    ).toContain(`Vault account order: ${v.bravo}, ${v.alpha}`)
  })

  it('a bad vault order is refused with its reason and writes nothing', async () => {
    const v = await vaultRoster()
    const menu = m.menu({ routing: { vaultOrder: v.order } })
    const before = await readFile(v.path, 'utf8')
    const missing = await apply(menu, notes().invocation, {
      sectionId: 'routing',
      actionId: 'order',
      values: { order: v.bravo },
    })
    expect(missing).toMatchObject({
      ok: false,
      text: 'the order leaves out 1 roster route id',
    })
    const unknown = await apply(menu, notes().invocation, {
      sectionId: 'routing',
      actionId: 'order',
      values: { order: `${v.bravo}, ${v.alpha}, vault:other` },
    })
    expect(unknown).toMatchObject({
      ok: false,
      text: 'route id vault:other is not in the roster',
    })
    expect(await readFile(v.path, 'utf8')).toBe(before)
  })

  it('outside vault mode the pool roster is shown and set as before', async () => {
    await populate(m.store)
    const v = await vaultRoster()
    const before = await readFile(v.path, 'utf8')
    const menu = m.menu({ routing: { vaultOrder: () => undefined } })
    const n = notes()
    expect(section(await menu.open(n.invocation), 'routing').lines).toEqual([
      'Mode: Ordered (roster order)',
      'Roster order: a, b, k',
    ])
    const ordered = await apply(menu, n.invocation, {
      sectionId: 'routing',
      actionId: 'order',
      values: { order: 'k, b, a' },
    })
    expect(ordered).toMatchObject({ ok: true, text: 'Order set to k, b, a.' })
    expect(await rosterIds(m.store)).toEqual(['k', 'b', 'a'])
    expect(await readFile(v.path, 'utf8')).toBe(before)
  })
})
