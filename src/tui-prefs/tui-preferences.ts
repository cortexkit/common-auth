import { readFile } from 'node:fs/promises'
import { applyEdits, modify, type ParseError, parse } from 'jsonc-parser'
import { writeJsonAtomic } from '../fs/atomic-write.js'
import { WRITER_LOCK_CONSTANTS } from '../fs/lock-constants.js'
import { withLock } from '../fs/with-lock.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Malformed or missing user-edited files are treated as an empty root. */
export async function readTuiPreferencesFile(
  file: string,
): Promise<Record<string, unknown>> {
  try {
    const errors: ParseError[] = []
    const root: unknown = parse(await readFile(file, 'utf8'), errors, {
      allowTrailingComma: true,
    })
    return errors.length === 0 && isRecord(root) ? root : {}
  } catch {
    return {}
  }
}

export interface TuiPreferencesReaderOptions<T> {
  file: string
  pluginKey: string
  defaults: T
  /** The caller owns validation, clamping, and merging of its settings. */
  schema: (entry: unknown, defaults: T) => T
}

export async function readTuiPreferences<T>(
  options: TuiPreferencesReaderOptions<T>,
): Promise<T> {
  const root = await readTuiPreferencesFile(options.file)
  const entry = Object.hasOwn(root, options.pluginKey)
    ? root[options.pluginKey]
    : undefined
  return options.schema(entry, options.defaults)
}

export type PreferenceValue =
  | string
  | number
  | boolean
  | null
  | PreferenceValue[]
  | { [key: string]: PreferenceValue }

export interface TuiPreferenceWriterOptions {
  file: string
  pluginKey: string
  timeoutMs?: number
  /** @internal Runs after staging, before the writer's ownership fence. */
  beforeCommit?: () => Promise<void>
}

export interface TuiPreferenceWriter {
  queueTuiPreferenceUpdate(
    path: readonly (string | number)[],
    value: PreferenceValue,
  ): Promise<void>
}

const TEMPLATE = `// Shared preferences for TUI plugins.
// Plugins update individual keys in place and preserve comments.
{}
`

/** Each instance serializes updates; the file lock also excludes other processes. */
export function createTuiPreferenceWriter(
  options: TuiPreferenceWriterOptions,
): TuiPreferenceWriter {
  const { file, pluginKey, beforeCommit } = options
  const lockOptions = {
    ...WRITER_LOCK_CONSTANTS.preferences,
    timeoutMs: options.timeoutMs ?? WRITER_LOCK_CONSTANTS.preferences.timeoutMs,
  }
  let chain: Promise<void> = Promise.resolve()

  async function writePreference(
    path: readonly (string | number)[],
    value: PreferenceValue,
  ): Promise<void> {
    await withLock(file, lockOptions, async (lock) => {
      let text: string
      try {
        text = await readFile(file, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        text = ''
      }
      if (text.trim() === '') text = TEMPLATE
      const next = applyEdits(
        text,
        modify(text, [pluginKey, ...path], value, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        }),
      )
      await writeJsonAtomic(file, next, {
        serialize: (value) => String(value),
        beforeRename: async () => {
          await beforeCommit?.()
          await lock.assertOwned()
        },
      })
    })
  }

  return {
    queueTuiPreferenceUpdate(path, value) {
      // Snapshot inputs so queued callers cannot change an update before it runs.
      const savedPath = [...path]
      const savedValue = structuredClone(value)
      const update = chain.then(() => writePreference(savedPath, savedValue))
      // Recover only the stored tail; the caller still sees the original rejection.
      chain = update.catch(() => {})
      return update
    },
  }
}
