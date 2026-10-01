// The one way out of the process for anything the command menu shows. Every
// payload a renderer receives (the dialog payload and every apply result) is
// produced here: each part is projected field by field from its definition,
// so action bodies and stray properties never travel, and the whole payload
// is then scrubbed of credential-shaped property names as a backstop. Nothing
// outside this module can build a payload without passing through
// `dialogPayload` or `applyResult`.

import type {
  ActionDefinition,
  CommandApplyResult,
  CommandDialogPayload,
  CommandMenuModel,
  ItemDefinition,
  MenuAccount,
  MenuAction,
  MenuChoice,
  MenuConfirmation,
  MenuItem,
  MenuKnob,
  MenuSection,
  SectionContent,
  SectionSlot,
} from './model.js'

/** Where a dropped field is reported. Names only, never values. */
export interface SeamLogger {
  warn(message: string, data?: unknown): void
}

/** A built-in item may carry the account it shows; plugin items cannot. */
export interface ResolvedItem extends ItemDefinition {
  account?: MenuAccount
}

/** A section with its bodies, as the menu holds it between builds. */
export interface ResolvedSection {
  id: string
  slot: SectionSlot
  title: string
  content: Omit<SectionContent, 'items'> & { items?: ResolvedItem[] }
}

/** The confirmation shown when an irreversible action names none. */
export const DEFAULT_IRREVERSIBLE_CONFIRMATION =
  'This cannot be undone. Continue?'

const CREDENTIAL_NAMES = new Set([
  'access',
  'refresh',
  'apikey',
  'password',
  'authheader',
  'credential',
  'credentials',
])

/**
 * True for a property name that looks like it holds a secret. Case, `-` and
 * `_` are ignored, so `api_key`, `API-Key` and `apiKey` all match. Any name
 * ending in `token`, `key` or `secret` matches: no menu field is named that
 * way, so a match is a leak whatever the rest of the name says.
 */
function isCredentialName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[-_]/g, '')
  return (
    CREDENTIAL_NAMES.has(normalized) ||
    normalized.endsWith('token') ||
    normalized.endsWith('key') ||
    normalized.endsWith('secret')
  )
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A copy of `value` without credential-shaped properties; their paths go to `found`. */
function scrub(value: unknown, path: string, found: string[]): unknown {
  if (Array.isArray(value))
    return value.map((entry, index) => scrub(entry, `${path}[${index}]`, found))
  if (!isPlainRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [name, entry] of Object.entries(value)) {
    if (isCredentialName(name)) {
      found.push(`${path}.${name}`)
      continue
    }
    Object.defineProperty(out, name, {
      value: scrub(entry, `${path}.${name}`, found),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return out
}

function sealed<T>(payload: T, command: string, logger: SeamLogger): T {
  const found: string[] = []
  const clean = scrub(payload, 'payload', found) as T
  if (found.length > 0)
    logger.warn('credential-shaped field dropped from a command payload', {
      command,
      fields: found,
    })
  return clean
}

function projectChoice(choice: MenuChoice): MenuChoice {
  return { value: String(choice.value), label: String(choice.label) }
}

function projectKnob(knob: MenuKnob): MenuKnob {
  switch (knob.kind) {
    case 'choice':
      return {
        kind: 'choice',
        id: knob.id,
        label: knob.label,
        choices: (knob.choices ?? []).map(projectChoice),
        ...(knob.value !== undefined ? { value: knob.value } : {}),
      }
    case 'toggle':
      return {
        kind: 'toggle',
        id: knob.id,
        label: knob.label,
        value: knob.value === true,
      }
    case 'number':
      return {
        kind: 'number',
        id: knob.id,
        label: knob.label,
        ...(knob.value !== undefined ? { value: knob.value } : {}),
        ...(knob.min !== undefined ? { min: knob.min } : {}),
        ...(knob.max !== undefined ? { max: knob.max } : {}),
        ...(knob.required ? { required: true } : {}),
      }
    case 'text':
      return {
        kind: 'text',
        id: knob.id,
        label: knob.label,
        ...(knob.value !== undefined ? { value: knob.value } : {}),
        ...(knob.placeholder !== undefined
          ? { placeholder: knob.placeholder }
          : {}),
        ...(knob.masked ? { masked: true } : {}),
        ...(knob.required ? { required: true } : {}),
      }
  }
}

/**
 * The confirmation an action must pass before it runs, or undefined. An
 * irreversible action always has one, even when its definition (built
 * outside the type checker) names none.
 */
export function confirmationOf(
  action: ActionDefinition,
): MenuConfirmation | undefined {
  if (action.irreversible === true)
    return {
      message: action.confirm || DEFAULT_IRREVERSIBLE_CONFIRMATION,
      irreversible: true,
    }
  if (action.confirm) return { message: action.confirm, irreversible: false }
  return undefined
}

function projectAction(action: ActionDefinition): MenuAction {
  const confirm = confirmationOf(action)
  return {
    id: action.id,
    label: action.label,
    ...(action.description !== undefined
      ? { description: action.description }
      : {}),
    knobs: (action.knobs ?? []).map(projectKnob),
    ...(confirm ? { confirm } : {}),
  }
}

/** The account fields a renderer may show; see `MenuAccount`. */
export function projectAccount(account: MenuAccount): MenuAccount {
  return {
    id: account.id,
    ...(account.label !== undefined ? { label: account.label } : {}),
    enabled: account.enabled,
    type: account.type,
    ...(account.identity !== undefined ? { identity: account.identity } : {}),
  }
}

function projectItem(item: ResolvedItem): MenuItem {
  return {
    id: item.id,
    label: item.label,
    ...(item.detail !== undefined ? { detail: item.detail } : {}),
    ...(item.account ? { account: projectAccount(item.account) } : {}),
    ...(item.facts !== undefined ? { facts: item.facts } : {}),
    actions: (item.actions ?? []).map(projectAction),
  }
}

function projectSection(section: ResolvedSection): MenuSection {
  const { content } = section
  return {
    id: section.id,
    slot: section.slot,
    title: section.title,
    lines: (content.lines ?? []).map(String),
    items: (content.items ?? []).map(projectItem),
    actions: (content.actions ?? []).map(projectAction),
    ...(content.facts !== undefined ? { facts: content.facts } : {}),
  }
}

function projectMenu(
  command: string,
  title: string,
  sections: readonly ResolvedSection[],
): CommandMenuModel {
  return { command, title, sections: sections.map(projectSection) }
}

/** The payload a host's TUI receives when the slash command opens. */
export function dialogPayload(
  command: string,
  title: string,
  sections: readonly ResolvedSection[],
  logger: SeamLogger,
): CommandDialogPayload {
  return sealed(
    { command, menu: projectMenu(command, title, sections) },
    command,
    logger,
  )
}

/** An apply's result: the message and the refreshed menu. */
export function applyResult(
  command: string,
  title: string,
  sections: readonly ResolvedSection[],
  outcome: { ok: boolean; text: string; needsConfirmation?: boolean },
  logger: SeamLogger,
): CommandApplyResult {
  return sealed(
    {
      command,
      ok: outcome.ok,
      text: outcome.text,
      ...(outcome.needsConfirmation ? { needsConfirmation: true } : {}),
      menu: projectMenu(command, title, sections),
    },
    command,
    logger,
  )
}
