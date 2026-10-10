// The four sections every plugin gets from the library: Accounts, Quota,
// Routing and Limits. They read the pool and the plugin's settings through
// the store and write only through store operations, so a menu action takes
// the same locks as any other writer of those files.

import {
  formatQuota,
  isQuotaMap,
  type ProjectedQuota,
  projectQuota,
  quotaWindowName,
} from '../quota/index.js'
import {
  DEFAULT_FORMER_MAIN_ID,
  orderForPlacement,
  resolveRoutingMode,
} from '../routing/index.js'
import type {
  AddInput,
  AddResult,
  PoolLoad,
  PoolLockSpec,
  PoolRow,
  PoolSettings,
  PoolStore,
  RemoveOptions,
} from '../store/index.js'
import type {
  ActionDefinition,
  CommandInvocation,
  KnobValues,
  MenuAccount,
  MenuChoice,
  MenuKnob,
} from './model.js'
import {
  projectFailure,
  type ResolvedItem,
  type ResolvedSection,
} from './seam.js'

/**
 * What a plugin's login hands back. `ready` adds the account now. `pending`
 * means the user must finish somewhere else (a browser, a device code):
 * `message` tells them how, and the account is added when `completion`
 * settles, with the result sent to the invocation that started it.
 */
export type LoginOutcome =
  | { status: 'ready'; account: AddInput }
  | {
      status: 'pending'
      message: string
      /** Resolves with the account to add, or undefined when the user gave up. */
      completion: Promise<AddInput | undefined>
    }
  | { status: 'cancelled'; message?: string }

export interface AccountsSectionOptions {
  /** What to show as an account's identity; defaults to its recorded identity. */
  describeIdentity?(row: PoolRow): string | undefined
  /** The plugin's login; without it the section offers no add action. */
  login?: {
    label?: string
    knobs?: MenuKnob[]
    run(
      values: KnobValues,
      invocation: CommandInvocation,
    ): Promise<LoginOutcome>
  }
  /** Passed to `store.remove`: a reason refuses removing that id. */
  protect?: RemoveOptions['protect']
}

export interface QuotaSectionOptions {
  /** The quota scope to show (`all` or a model family); defaults to `all`. */
  scope?: string
  /**
   * Checks quota now for the named rows. Without it, the menu asks the store
   * for a reading of each row and waits for the pulls to settle.
   */
  check?(ids: readonly string[], invocation: CommandInvocation): Promise<void>
}

export interface RoutingSectionOptions {
  /**
   * Further `routing.mode` values the plugin routes as `ordered` with the
   * former main row moved (`main-first`, `fallback-first`), offered between
   * `ordered` and `sticky-balanced`.
   */
  orderedVariants?: MenuChoice[]
  formerMainId?: string
}

export interface LimitsSectionOptions {
  /**
   * The quota window labels a floor can be set for. Defaults to every label
   * the pool's quota readings carry, or `primary` when there are none.
   */
  labels?: readonly string[]
}

export interface BuiltinOptions {
  store: PoolStore
  extraLocks?: readonly PoolLockSpec[]
  now: () => number
  accounts?: AccountsSectionOptions
  quota?: QuotaSectionOptions
  routing?: RoutingSectionOptions
  limits?: LimitsSectionOptions
}

/** `disabledReason` recorded when the user disables an account from the menu. */
export const MENU_DISABLED_REASON = 'disabled from the command menu'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {}
}

/** The rows the menu can name: one per id, in roster order. */
function distinctRows(load: PoolLoad): PoolRow[] {
  if (load.status !== 'ready') return []
  const seen = new Set<string>()
  return load.rows.filter((row) => {
    if (seen.has(row.id)) return false
    seen.add(row.id)
    return true
  })
}

function rowName(row: PoolRow, identity: string | undefined): string {
  return row.label ?? identity ?? row.id
}

function projected(row: PoolRow, scope: string): ProjectedQuota | undefined {
  return isQuotaMap(row.quota) ? projectQuota(row.quota, scope) : undefined
}

/** Real plurals for counts in summaries: `1 account`, `3 accounts`. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/** The header every section's own actions are listed under. */
const ACTIONS_GROUP = 'Actions'

function loadProblem(load: PoolLoad): string | undefined {
  if (load.status === 'pending-migration')
    return 'The account pool has not been migrated yet.'
  if (load.status === 'error')
    return `The ${load.file} file cannot be read: ${load.reason}`
  return undefined
}

function addedText(name: string, result: AddResult): string {
  switch (result.outcome) {
    case 'added':
      return `Added ${name}.`
    case 'added-disabled':
      return `Added ${name}, disabled: another enabled account has the same identity.`
    case 'completed':
      return `Finished adding ${name}.`
    case 'rotated':
      return `${name} was already in the pool; its credential was updated.`
    case 'exists':
      return `${name} was already in the pool; its credential is unchanged.`
  }
}

/**
 * What the user is told about a failed late login: the projected message,
 * never the exception's own text, which can quote the login's request.
 */
function failureMessage(error: unknown): string {
  return projectFailure(error).text
}

/** What every built-in section reads, once per build. */
interface Snapshot {
  load: PoolLoad
  rows: PoolRow[]
  settings: PoolSettings
}

async function snapshot(store: PoolStore): Promise<Snapshot> {
  const load = await store.read()
  const read = await store.readSettings()
  return {
    load,
    rows: distinctRows(load),
    settings: read.status === 'error' ? {} : read.settings,
  }
}

function accountView(
  row: PoolRow,
  options: BuiltinOptions,
): { account: MenuAccount; name: string } {
  const identity = options.accounts?.describeIdentity
    ? options.accounts.describeIdentity(row)
    : row.identity
  // Copy only the fields the menu shows: the store row also carries its
  // credential and fingerprint, which must never reach a payload.
  const account: MenuAccount = {
    id: row.id,
    ...(row.label !== undefined ? { label: row.label } : {}),
    enabled: row.enabled,
    type: row.type,
    ...(identity !== undefined ? { identity } : {}),
  }
  return { account, name: rowName(row, identity) }
}

function accountsSection(
  options: BuiltinOptions,
  snap: Snapshot,
): ResolvedSection {
  const { store, extraLocks } = options
  const locks = extraLocks ? { extraLocks } : {}
  const ids = snap.rows.map((row) => row.id)
  const problem = loadProblem(snap.load)
  const enabledCount = snap.rows.filter((row) => row.enabled).length
  const items: ResolvedItem[] = snap.rows.map((row, index) => {
    const { account, name } = accountView(row, options)
    // An Accounts row shows only the credential type, identity and any
    // disabled reason; the account's quota windows are shown in the Quota
    // section instead, so this row fits one line.
    const detail = [
      row.type === 'api' ? 'API key' : 'OAuth',
      ...(account.identity !== undefined ? [account.identity] : []),
      ...(!row.invalid && !row.enabled && row.disabledReason
        ? [`disabled: ${row.disabledReason}`]
        : []),
    ].join(' · ')
    const status = row.invalid
      ? 'invalid'
      : row.enabled
        ? 'enabled'
        : 'disabled'
    const actions: ActionDefinition[] = []
    if (!row.invalid && row.enabled)
      actions.push({
        id: 'disable',
        label: 'Disable',
        run: async () => {
          await store.disable(row.id, MENU_DISABLED_REASON, locks)
          return `Disabled ${name}.`
        },
      })
    if (!row.invalid && !row.enabled)
      actions.push({
        id: 'enable',
        label: 'Enable',
        run: async () => {
          await store.enable(row.id, locks)
          return `Enabled ${name}.`
        },
      })
    if (ids.length > 1)
      actions.push({
        id: 'move',
        label: 'Move',
        knobs: [
          {
            kind: 'choice',
            id: 'position',
            label: 'Position',
            choices: ids.map((_, at) => ({
              value: String(at + 1),
              label: String(at + 1),
            })),
            value: String(index + 1),
          },
        ],
        run: async ({ values }) => {
          const position = Number(values.position)
          const order = ids.filter((id) => id !== row.id)
          order.splice(position - 1, 0, row.id)
          const result = await store.reorder(order, locks)
          return result.outcome === 'unchanged'
            ? `${name} is already at position ${position}.`
            : `Moved ${name} to position ${position}.`
        },
      })
    actions.push({
      id: 'remove',
      label: 'Remove',
      irreversible: true,
      confirm: `Remove ${name}? Its stored credential is deleted.`,
      run: async () => {
        await store.remove(row.id, {
          ...locks,
          ...(options.accounts?.protect
            ? { protect: options.accounts.protect }
            : {}),
        })
        return `Removed ${name}.`
      },
    })
    return {
      id: row.id,
      label: name,
      detail,
      group: 'Accounts',
      status,
      account,
      actions,
    }
  })

  const login = options.accounts?.login
  const actions: ActionDefinition[] = []
  if (login && !problem)
    actions.push({
      id: 'add',
      label: login.label ?? 'Add account',
      group: ACTIONS_GROUP,
      knobs: login.knobs ?? [],
      run: async ({ values, invocation }) => {
        const outcome = await login.run(values, invocation)
        if (outcome.status === 'cancelled')
          return { ok: false, text: outcome.message ?? 'Login cancelled.' }
        if (outcome.status === 'ready') {
          const result = await store.add(outcome.account, locks)
          return addedText(outcome.account.label ?? result.id, result)
        }
        // The login finishes after this call returns: add the account then,
        // and send the outcome to the invocation that started the login.
        void outcome.completion
          .then(
            async (account) => {
              if (!account) {
                invocation.notify('Login cancelled.', 'warning')
                return
              }
              const result = await store.add(account, locks)
              invocation.notify(addedText(account.label ?? result.id, result))
            },
            (error) => {
              invocation.notify(
                `Adding the account failed: ${failureMessage(error)}`,
                'error',
              )
            },
          )
          .catch((error) => {
            invocation.notify(
              `Adding the account failed: ${failureMessage(error)}`,
              'error',
            )
          })
        return outcome.message
      },
    })

  return {
    id: 'accounts',
    slot: 'accounts',
    title: 'Accounts',
    content: {
      lines: problem
        ? [problem]
        : [
            snap.rows.length === 0
              ? 'No accounts yet'
              : `${count(snap.rows.length, 'account')}, ${enabledCount} enabled`,
          ],
      items: problem ? [] : items,
      actions,
    },
  }
}

function quotaSection(
  options: BuiltinOptions,
  snap: Snapshot,
): ResolvedSection {
  const scope = options.quota?.scope ?? 'all'
  const now = options.now()
  // A scoped menu names its model family in the header, since the quota
  // shown is that family's view of each account.
  const group = scope === 'all' ? 'Accounts' : `Accounts · ${scope}`
  // Checking quota asks the provider for a fresh reading. A plugin that
  // polls its accounts itself (its own HTTP quota call) supplies
  // `quota.check`; otherwise each row's reading is requested from the store,
  // which runs the plugin's pull for that row. Checking one account and
  // checking all use the same path.
  const check = async (
    ids: readonly string[],
    invocation: CommandInvocation,
  ): Promise<void> => {
    if (options.quota?.check) await options.quota.check(ids, invocation)
    else {
      for (const id of ids) options.store.requestReading(id)
      await options.store.pullsSettled()
    }
  }
  // Only a routing candidate (enabled, valid and holding a credential) is a
  // row, because a row must do something when chosen and its action checks
  // that account's quota. Any other account becomes a read-only line naming
  // why it can't be checked (disabled, invalid, no credential), followed by
  // its last stored quota reading.
  const candidates = snap.rows.filter((row) => row.candidate)
  const items: ResolvedItem[] = candidates.map((row) => {
    const { account, name } = accountView(row, options)
    const quota = projected(row, scope)
    return {
      id: row.id,
      label: name,
      group,
      status: formatQuota(quota, { now, form: 'compact' }),
      detail: formatQuota(quota, { now, form: 'full' }),
      account,
      actions: [
        {
          id: 'check',
          label: 'Check this account',
          run: async ({ invocation }) => {
            await check([row.id], invocation)
            return `Checked quota for ${name}.`
          },
        },
      ],
    }
  })
  const unchecked = snap.rows
    .filter((row) => !row.candidate)
    .map((row) => {
      const { name } = accountView(row, options)
      const reason = row.invalid
        ? 'invalid'
        : !row.enabled
          ? 'disabled'
          : row.credential === undefined
            ? 'no credential'
            : 'unavailable'
      const quota = formatQuota(projected(row, scope), {
        now,
        form: 'compact',
      })
      return `${name} (${reason}): ${quota}`
    })
  const actions: ActionDefinition[] = []
  if (candidates.length > 0)
    actions.push({
      id: 'check',
      label: 'Check now',
      description: 'Checks every account that can be checked.',
      group: ACTIONS_GROUP,
      run: async ({ invocation }) => {
        const ids = candidates.map((row) => row.id)
        await check(ids, invocation)
        return `Checked quota for ${count(ids.length, 'account')}.`
      },
    })
  return {
    id: 'quota',
    slot: 'quota',
    title: 'Quota',
    content: {
      lines: snap.rows.length === 0 ? ['No accounts yet'] : unchecked,
      items,
      actions,
    },
  }
}

function routingSection(
  options: BuiltinOptions,
  snap: Snapshot,
): ResolvedSection {
  const { store, extraLocks } = options
  const locks = extraLocks ? { extraLocks } : {}
  const choices: MenuChoice[] = [
    { value: 'ordered', label: 'Ordered (roster order)' },
    ...(options.routing?.orderedVariants ?? []),
    { value: 'sticky-balanced', label: 'Sticky balanced' },
  ]
  const raw = record(snap.settings.routing).mode
  const current =
    typeof raw === 'string' && choices.some((choice) => choice.value === raw)
      ? raw
      : 'ordered'
  const resolved = resolveRoutingMode(current)
  const ids = snap.rows.map((row) => row.id)
  const tried = orderForPlacement(
    ids,
    resolved.placement,
    options.routing?.formerMainId ?? DEFAULT_FORMER_MAIN_ID,
  )
  const label =
    choices.find((choice) => choice.value === current)?.label ?? current
  const lines = [`Mode: ${label}`]
  if (ids.length > 0) lines.push(`Roster order: ${ids.join(', ')}`)
  if (resolved.mode === 'ordered' && tried.join() !== ids.join())
    lines.push(`Tried in order: ${tried.join(', ')}`)
  const actions: ActionDefinition[] = [
    {
      id: 'mode',
      label: 'Change mode',
      group: ACTIONS_GROUP,
      knobs: [
        { kind: 'choice', id: 'mode', label: 'Mode', choices, value: current },
      ],
      run: async ({ values }) => {
        const mode = String(values.mode)
        await store.updateSettings((settings) => {
          settings.routing = { ...record(settings.routing), mode }
          return undefined
        }, locks)
        return `Routing mode set to ${choices.find((choice) => choice.value === mode)?.label ?? mode}.`
      },
    },
  ]
  if (ids.length > 1)
    actions.push({
      id: 'order',
      label: 'Set order',
      group: ACTIONS_GROUP,
      knobs: [
        {
          kind: 'text',
          id: 'order',
          label: 'Account ids, first to last',
          value: ids.join(', '),
          required: true,
        },
      ],
      run: async ({ values }) => {
        const order = String(values.order)
          .split(/[\s,]+/)
          .filter((id) => id.length > 0)
        const result = await store.reorder(order, locks)
        return result.outcome === 'unchanged'
          ? 'The order is unchanged.'
          : `Order set to ${result.ids.join(', ')}.`
      },
    })
  return {
    id: 'routing',
    slot: 'routing',
    title: 'Routing',
    content: { lines, actions },
  }
}

function floorLabels(options: BuiltinOptions, snap: Snapshot): string[] {
  if (options.limits?.labels) return [...options.limits.labels]
  const scope = options.quota?.scope ?? 'all'
  const labels: string[] = []
  for (const row of snap.rows)
    for (const limit of projected(row, scope)?.limits ?? [])
      if (!labels.includes(limit.label)) labels.push(limit.label)
  return labels.length > 0 ? labels : ['primary']
}

/**
 * The display name for each floor. A floor is keyed by the quota window
 * label the plugin stores readings under (`primary`, `five_hour`). When some
 * account's stored quota reading records that window's length, the floor is
 * shown under the same name `formatQuota` gives the window (`5h`, `7d`);
 * otherwise under the label itself. The settings file keeps the label.
 */
function floorNames(
  options: BuiltinOptions,
  snap: Snapshot,
): (label: string) => string {
  const scope = options.quota?.scope ?? 'all'
  const names = new Map<string, string>()
  for (const row of snap.rows)
    for (const limit of projected(row, scope)?.limits ?? [])
      if (limit.windowMinutes !== undefined && !names.has(limit.label))
        names.set(limit.label, quotaWindowName(limit))
  return (label) => names.get(label) ?? label
}

function limitsSection(
  options: BuiltinOptions,
  snap: Snapshot,
): ResolvedSection {
  const { store, extraLocks } = options
  const locks = extraLocks ? { extraLocks } : {}
  const killswitch = record(snap.settings.killswitch)
  const enabled = killswitch.enabled === true
  const floors = record(killswitch.accounts)
  const labels = floorLabels(options, snap)
  const nameOf = floorNames(options, snap)
  const state = enabled ? 'on' : 'off'
  const items: ResolvedItem[] = snap.rows.map((row) => {
    const { account, name } = accountView(row, options)
    const own = record(floors[row.id])
    const set = labels.filter((label) => typeof own[label] === 'number')
    return {
      id: row.id,
      label: name,
      group: `Floors · killswitch ${state}`,
      // A floor is the least "% left" the account may fall to.
      status:
        set.length === 0
          ? 'no floors'
          : set.map((label) => `${nameOf(label)} ≥${own[label]}%`).join(' · '),
      account,
      actions: [
        {
          id: 'floors',
          label: 'Set floors',
          knobs: labels.map(
            (label): MenuKnob => ({
              kind: 'number',
              id: label,
              label: `Minimum % left for ${nameOf(label)}`,
              min: 0,
              max: 100,
              ...(typeof own[label] === 'number'
                ? { value: own[label] as number }
                : {}),
            }),
          ),
          run: async ({ values }) => {
            await store.updateSettings((settings) => {
              const next = record(settings.killswitch)
              const accounts = record(next.accounts)
              const mine = record(accounts[row.id])
              for (const label of labels) {
                const value = values[label]
                if (typeof value === 'number') mine[label] = value
                else if (value === null) delete mine[label]
              }
              if (Object.keys(mine).length > 0) accounts[row.id] = mine
              else delete accounts[row.id]
              if (Object.keys(accounts).length > 0) next.accounts = accounts
              else delete next.accounts
              settings.killswitch = next
              return undefined
            }, locks)
            return `Floors updated for ${name}.`
          },
        },
      ],
    }
  })
  return {
    id: 'limits',
    slot: 'limits',
    title: 'Limits',
    content: {
      lines: [`Killswitch ${state}`],
      items,
      actions: [
        {
          id: 'killswitch',
          label: enabled ? 'Turn killswitch off' : 'Turn killswitch on',
          description:
            'With the killswitch on, an account whose quota falls below one of its floors is not used.',
          group: ACTIONS_GROUP,
          knobs: [
            {
              kind: 'toggle',
              id: 'enabled',
              label: 'Killswitch',
              value: !enabled,
            },
          ],
          run: async ({ values }) => {
            const on = values.enabled === true
            await store.updateSettings((settings) => {
              settings.killswitch = {
                ...record(settings.killswitch),
                enabled: on,
              }
              return undefined
            }, locks)
            return `Killswitch ${on ? 'on' : 'off'}.`
          },
        },
      ],
    },
  }
}

/** The four built-in sections, in their fixed order, from one read of the store. */
export async function builtinSections(
  options: BuiltinOptions,
): Promise<ResolvedSection[]> {
  const snap = await snapshot(options.store)
  return [
    accountsSection(options, snap),
    quotaSection(options, snap),
    routingSection(options, snap),
    limitsSection(options, snap),
  ]
}
