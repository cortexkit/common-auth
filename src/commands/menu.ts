// One slash command per plugin: the menu a plugin creates once and serves to
// every invocation. It keeps no per-invocation state; each `open` and `apply`
// builds its sections afresh from the store and gets its own copy of the
// caller's context.

import { createLogger } from '../logger/index.js'
import type { PoolLockSpec, PoolStore } from '../store/index.js'
import {
  type AccountsSectionOptions,
  builtinSections,
  type LimitsSectionOptions,
  type QuotaSectionOptions,
  type RoutingSectionOptions,
} from './builtins.js'
import type {
  ActionDefinition,
  CommandApplyRequest,
  CommandApplyResult,
  CommandDialogPayload,
  CommandInvocation,
  KnobValue,
  KnobValues,
  MenuKnob,
  PluginExtraSection,
  PluginSection,
} from './model.js'
import {
  applyResult,
  confirmationOf,
  dialogPayload,
  type ResolvedSection,
  type SeamLogger,
} from './seam.js'

const BUILTIN_IDS = new Set([
  'accounts',
  'quota',
  'routing',
  'limits',
  'cache',
  'diagnostics',
])

export interface CommandMenuOptions {
  /** The slash command's name without the slash (`openai`, `claude`). */
  command: string
  /** The dialog title. */
  title: string
  store: PoolStore
  /** The plugin's legacy locks, passed to every store write the menu makes. */
  extraLocks?: readonly PoolLockSpec[]
  accounts?: AccountsSectionOptions
  quota?: QuotaSectionOptions
  routing?: RoutingSectionOptions
  limits?: LimitsSectionOptions
  /** The Cache section; omitted when the plugin has none. */
  cache?: PluginSection
  /** The Diagnostics section (dumps, logging); omitted when the plugin has none. */
  diagnostics?: PluginSection
  /** Provider extras, shown after every fixed section in this order. */
  extras?: readonly PluginExtraSection[]
  /** Receives the seam's warnings and failed actions; defaults to the library logger. */
  logger?: SeamLogger
  now?: () => number
}

export interface CommandMenu {
  readonly command: string
  /** The dialog payload for one invocation of the slash command. */
  open(invocation: CommandInvocation): Promise<CommandDialogPayload>
  /** Applies one action and returns its message and the refreshed menu. */
  apply(
    request: CommandApplyRequest,
    invocation: CommandInvocation,
  ): Promise<CommandApplyResult>
}

/**
 * A private copy of the caller's context, taken before the first await. Work
 * an invocation leaves running reports through this copy, so a host that
 * reuses and rebinds one context object for the next session cannot pull an
 * earlier invocation's feedback over to it.
 */
function ownInvocation(invocation: CommandInvocation): CommandInvocation {
  const { sessionId } = invocation
  const notify = invocation.notify.bind(invocation)
  return Object.freeze({
    ...(sessionId !== undefined ? { sessionId } : {}),
    notify,
  })
}

type Coerced = { values: KnobValues } | { problem: string }

function coerceOne(
  knob: MenuKnob,
  raw: KnobValue | undefined,
): { value: KnobValue } | { problem: string } {
  switch (knob.kind) {
    case 'choice': {
      const value = raw ?? knob.value
      if (
        typeof value === 'string' &&
        knob.choices.some((choice) => choice.value === value)
      )
        return { value }
      return { problem: `Choose one of the options for ${knob.label}.` }
    }
    case 'toggle': {
      const value = raw ?? knob.value
      return typeof value === 'boolean'
        ? { value }
        : { problem: `${knob.label} must be on or off.` }
    }
    case 'number': {
      const value = raw === undefined ? (knob.value ?? null) : raw
      if (value === null || value === '') {
        return knob.required
          ? { problem: `${knob.label} needs a number.` }
          : { value: null }
      }
      const number = typeof value === 'number' ? value : Number(value)
      if (typeof value === 'boolean' || !Number.isFinite(number))
        return { problem: `${knob.label} needs a number.` }
      if (knob.min !== undefined && number < knob.min)
        return { problem: `${knob.label} must be at least ${knob.min}.` }
      if (knob.max !== undefined && number > knob.max)
        return { problem: `${knob.label} must be at most ${knob.max}.` }
      return { value: number }
    }
    case 'text': {
      const value = raw === undefined ? (knob.value ?? null) : raw
      if (value === null || value === '')
        return knob.required
          ? { problem: `${knob.label} cannot be empty.` }
          : { value: null }
      return typeof value === 'string'
        ? { value }
        : { problem: `${knob.label} must be text.` }
    }
  }
}

/** The action's inputs, checked against its knobs; unknown names are ignored. */
function coerceValues(
  knobs: readonly MenuKnob[],
  raw: KnobValues | undefined,
): Coerced {
  const values: Record<string, KnobValue> = {}
  for (const knob of knobs) {
    const given = raw && Object.hasOwn(raw, knob.id) ? raw[knob.id] : undefined
    const result = coerceOne(knob, given)
    if ('problem' in result) return result
    values[knob.id] = result.value
  }
  return { values }
}

function findAction(
  sections: readonly ResolvedSection[],
  request: CommandApplyRequest,
): ActionDefinition | undefined {
  const section = sections.find((entry) => entry.id === request.sectionId)
  if (!section) return undefined
  const actions =
    request.itemId === undefined
      ? section.content.actions
      : section.content.items?.find((item) => item.id === request.itemId)
          ?.actions
  return actions?.find((action) => action.id === request.actionId)
}

export function createCommandMenu(options: CommandMenuOptions): CommandMenu {
  const logger: SeamLogger = options.logger ?? createLogger('commands')
  const now = options.now ?? Date.now
  const extras = options.extras ?? []
  const seen = new Set<string>()
  for (const extra of extras) {
    if (BUILTIN_IDS.has(extra.id) || seen.has(extra.id))
      throw new Error(`extra section id ${extra.id} is taken`)
    seen.add(extra.id)
  }

  async function plugin(
    id: string,
    slot: ResolvedSection['slot'],
    section: PluginSection,
    invocation: CommandInvocation,
  ): Promise<ResolvedSection> {
    try {
      return {
        id,
        slot,
        title: section.title,
        content: await section.build(invocation),
      }
    } catch (error) {
      // One broken plugin section must not take the whole menu down.
      logger.warn('command menu section failed to build', {
        command: options.command,
        section: id,
        error: error instanceof Error ? error.message : String(error),
      })
      return {
        id,
        slot,
        title: section.title,
        content: { lines: ['This section could not be loaded.'] },
      }
    }
  }

  /** Every section, in the fixed slot order. */
  async function sections(
    invocation: CommandInvocation,
  ): Promise<ResolvedSection[]> {
    const out = await builtinSections({
      store: options.store,
      now,
      ...(options.extraLocks ? { extraLocks: options.extraLocks } : {}),
      ...(options.accounts ? { accounts: options.accounts } : {}),
      ...(options.quota ? { quota: options.quota } : {}),
      ...(options.routing ? { routing: options.routing } : {}),
      ...(options.limits ? { limits: options.limits } : {}),
    })
    if (options.cache)
      out.push(await plugin('cache', 'cache', options.cache, invocation))
    if (options.diagnostics)
      out.push(
        await plugin(
          'diagnostics',
          'diagnostics',
          options.diagnostics,
          invocation,
        ),
      )
    for (const extra of extras)
      out.push(await plugin(extra.id, 'extra', extra, invocation))
    return out
  }

  return {
    command: options.command,
    async open(invocation) {
      const own = ownInvocation(invocation)
      return dialogPayload(
        options.command,
        options.title,
        await sections(own),
        logger,
      )
    },
    async apply(request, invocation) {
      const own = ownInvocation(invocation)
      const finish = async (outcome: {
        ok: boolean
        text: string
        needsConfirmation?: boolean
      }) =>
        applyResult(
          options.command,
          options.title,
          await sections(own),
          outcome,
          logger,
        )
      const action =
        request.command === options.command
          ? findAction(await sections(own), request)
          : undefined
      if (!action)
        return finish({
          ok: false,
          text: 'That action is no longer available.',
        })
      const confirmation = confirmationOf(action)
      if (confirmation && request.confirmed !== true)
        return finish({
          ok: false,
          text: confirmation.message,
          needsConfirmation: true,
        })
      const coerced = coerceValues(action.knobs ?? [], request.values)
      if ('problem' in coerced)
        return finish({ ok: false, text: coerced.problem })
      let outcome: { ok: boolean; text: string }
      try {
        const result = await action.run({
          values: coerced.values,
          ...(request.itemId !== undefined ? { itemId: request.itemId } : {}),
          invocation: own,
        })
        outcome =
          typeof result === 'string' ? { ok: true, text: result } : result
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn('command menu action failed', {
          command: options.command,
          section: request.sectionId,
          action: request.actionId,
          error: message,
        })
        outcome = { ok: false, text: message }
      }
      return finish(outcome)
    },
  }
}

function isKnobValue(value: unknown): value is KnobValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
}

/**
 * Checks an apply request that arrived over the loopback RPC; undefined when
 * it is not one. Only the request's own fields are kept.
 */
export function parseApplyRequest(
  value: unknown,
): CommandApplyRequest | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return undefined
  const raw = value as Record<string, unknown>
  if (
    typeof raw.command !== 'string' ||
    typeof raw.sectionId !== 'string' ||
    typeof raw.actionId !== 'string'
  )
    return undefined
  if (raw.itemId !== undefined && typeof raw.itemId !== 'string')
    return undefined
  if (raw.sessionId !== undefined && typeof raw.sessionId !== 'string')
    return undefined
  if (raw.confirmed !== undefined && typeof raw.confirmed !== 'boolean')
    return undefined
  const values: Record<string, KnobValue> = {}
  if (raw.values !== undefined) {
    if (
      raw.values === null ||
      typeof raw.values !== 'object' ||
      Array.isArray(raw.values)
    )
      return undefined
    for (const [name, entry] of Object.entries(raw.values)) {
      if (!isKnobValue(entry)) return undefined
      Object.defineProperty(values, name, {
        value: entry,
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
  }
  return {
    command: raw.command,
    sectionId: raw.sectionId,
    actionId: raw.actionId,
    ...(typeof raw.itemId === 'string' ? { itemId: raw.itemId } : {}),
    ...(raw.values !== undefined ? { values } : {}),
    ...(raw.confirmed === true ? { confirmed: true } : {}),
    ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}),
  }
}
