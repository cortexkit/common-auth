import {
  type CommandApplyResult,
  type CommandInvocation,
  type CommandMenu,
  type CommandMenuOptions,
  createCommandMenu,
  type KnobValues,
  type NotifyKind,
} from '../../src/commands/index.js'
import { quotaCodec } from '../../src/quota/index.js'
import type { PoolStore } from '../../src/store/index.js'
import { apiKey, oauth, type Scenario, scenario } from '../store/helpers.js'

export { apiKey, oauth }

/** The secret strings the populated store holds; none may reach a payload. */
export const SECRETS = [
  'refresh-a',
  'access-refresh-a',
  'refresh-b',
  'access-refresh-b',
  'sk-key-k',
]

export const NOW = Date.parse('2026-10-01T12:00:00Z')

export interface Warning {
  message: string
  data: unknown
}

export interface MenuScenario {
  s: Scenario
  store: PoolStore
  warnings: Warning[]
  menu(overrides?: Partial<CommandMenuOptions>): CommandMenu
  cleanup(): void
}

export async function menuScenario(): Promise<MenuScenario> {
  const s = await scenario('command-menu-')
  const store = s.open({ quota: quotaCodec, now: () => NOW })
  const warnings: Warning[] = []
  return {
    s,
    store,
    warnings,
    menu: (overrides = {}) =>
      createCommandMenu({
        command: 'acme',
        title: 'Acme',
        store,
        now: () => NOW,
        logger: { warn: (message, data) => warnings.push({ message, data }) },
        ...overrides,
      }),
    cleanup: () => s.cleanup(),
  }
}

/**
 * Two OAuth rows with identities and quota readings (one with a credit
 * budget) and one api-key row. The rows' credentials are the `SECRETS`.
 */
export async function populate(store: PoolStore): Promise<void> {
  await store.add({
    id: 'a',
    credential: oauth('refresh-a'),
    identity: 'acct-a',
    label: 'Alice',
  })
  await store.add({
    id: 'b',
    credential: oauth('refresh-b'),
    identity: 'acct-b',
  })
  await store.add({ id: 'k', credential: apiKey('sk-key-k'), label: 'Keyed' })
  await store.recordQuota(
    'a',
    { credentialEpoch: 1, identity: 'acct-a' },
    {
      checkedAt: NOW - 60_000,
      readings: [
        {
          label: 'primary',
          usedPercent: 42,
          windowMinutes: 300,
          resetsAt: new Date(NOW + 90 * 60_000).toISOString(),
        },
        { label: 'secondary', usedPercent: 10, windowMinutes: 10_080 },
      ],
      budget: { kind: 'reading', reached: false, remainingPercent: 75 },
    },
  )
  await store.recordQuota(
    'b',
    { credentialEpoch: 1, identity: 'acct-b' },
    {
      checkedAt: NOW - 60_000,
      readings: [{ label: 'primary', usedPercent: 99, windowMinutes: 300 }],
    },
  )
}

export interface Notes {
  invocation: CommandInvocation
  sent: Array<{ message: string; kind: NotifyKind | undefined }>
}

export function notes(sessionId?: string): Notes {
  const sent: Notes['sent'] = []
  return {
    sent,
    invocation: {
      ...(sessionId !== undefined ? { sessionId } : {}),
      notify: (message, kind) => void sent.push({ message, kind }),
    },
  }
}

/** Every property name in `value` that names a credential, with its path. */
export function credentialPaths(value: unknown, path = '$'): string[] {
  if (Array.isArray(value))
    return value.flatMap((entry, index) =>
      credentialPaths(entry, `${path}[${index}]`),
    )
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([name, entry]) => {
    const normalized = name.toLowerCase().replace(/[-_]/g, '')
    const own =
      ['access', 'refresh', 'apikey', 'credential', 'fingerprint'].includes(
        normalized,
      ) ||
      normalized.endsWith('token') ||
      normalized.endsWith('key') ||
      normalized.endsWith('secret')
        ? [`${path}.${name}`]
        : []
    return [...own, ...credentialPaths(entry, `${path}.${name}`)]
  })
}

export async function apply(
  menu: CommandMenu,
  invocation: CommandInvocation,
  target: {
    sectionId: string
    actionId: string
    itemId?: string
    values?: KnobValues
    confirmed?: boolean
  },
): Promise<CommandApplyResult> {
  return menu.apply({ command: menu.command, ...target }, invocation)
}

export async function rosterIds(store: PoolStore): Promise<string[]> {
  const load = await store.read()
  if (load.status !== 'ready') throw new Error(`pool is ${load.status}`)
  return load.rows.map((row) => row.id)
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, resolve, reject }
}
