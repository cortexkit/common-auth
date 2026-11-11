import type { SettingDeclaration, SettingsDefinition } from './define.js'
import {
  isJsonObject,
  type ValueDescriptor,
  type ValueOf,
} from './descriptors.js'
import { defineSettingsKey } from './parse.js'
import type { SettingsSnapshot } from './snapshot.js'

export interface GetOptions {
  readonly host: string
  readonly model?: string
  readonly project?: string
}

/** The caller selects the project snapshot for the requested project, if any. */
export interface ResolutionSnapshots {
  readonly user?: SettingsSnapshot
  readonly project?: SettingsSnapshot
}

function valueAtLevel(
  declaration: SettingDeclaration,
  name: string,
  snapshot: SettingsSnapshot | undefined,
  options: GetOptions,
): unknown {
  if (!snapshot || !Object.hasOwn(snapshot.settings, name)) return undefined
  const value = snapshot.settings[name]
  if (declaration.overrides === undefined || !isJsonObject(value)) return value

  const { model, host } = options
  if (
    declaration.overrides.model &&
    model !== undefined &&
    model !== 'default' &&
    model !== 'opencode' &&
    model !== 'pi' &&
    Object.hasOwn(value, model)
  ) {
    return value[model]
  }
  if (
    declaration.overrides.host &&
    (host === 'opencode' || host === 'pi') &&
    Object.hasOwn(value, host)
  ) {
    return value[host]
  }
  return Object.hasOwn(value, 'default') ? value.default : undefined
}

/** Snapshot validation has already removed unusable values and unknown fields. */
function resolveValue(descriptor: ValueDescriptor, levels: unknown[]): unknown {
  if (descriptor.kind !== 'object') {
    return levels.find((value) => value !== undefined)
  }

  const result: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(descriptor.fields)) {
    const candidates = levels.map((value) =>
      isJsonObject(value) && Object.hasOwn(value, key) ? value[key] : undefined,
    )
    defineSettingsKey(result, key, resolveValue(field, candidates))
  }
  return result
}

/** Resolve sanitized snapshots without reading files or adding report entries. */
export function resolveSetting<
  S extends Readonly<Record<string, SettingDeclaration>>,
  K extends keyof S & string,
>(
  definition: SettingsDefinition<S>,
  name: K,
  options: GetOptions,
  snapshots: ResolutionSnapshots = {},
): ValueOf<S[K]['value']> {
  if (!Object.hasOwn(definition.settings, name)) {
    throw new TypeError(`Undeclared setting: ${name}`)
  }
  const declaration = definition.settings[name]
  const levels: unknown[] = []
  if (declaration.project === 'allowed' && options.project !== undefined) {
    levels.push(valueAtLevel(declaration, name, snapshots.project, options))
  }
  levels.push(valueAtLevel(declaration, name, snapshots.user, options))
  levels.push(declaration.default)

  // Clone even a whole-list or whole-record winner so callers cannot mutate it.
  return structuredClone(resolveValue(declaration.value, levels)) as ValueOf<
    S[K]['value']
  >
}
