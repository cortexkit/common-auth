import { join, resolve } from 'node:path'
import { FileReadCache } from '../fs/file-read-cache.js'
import type { ChannelLogger } from '../logger/engine.js'
import { watchSettings } from '../tui-prefs/watcher.js'
import type { SettingDeclaration, SettingsDefinition } from './define.js'
import { isJsonObject, type ValueOf } from './descriptors.js'
import { SettingsFs } from './fs.js'
import { parseSettings, type SettingsParseResult } from './parse.js'
import { type GetOptions, resolveSetting } from './resolve.js'
import {
  buildSettingsSnapshot,
  type ReportEntry,
  type SettingsSnapshot,
} from './snapshot.js'

export interface LegacyProjectSource {
  readonly path: string
  read(text: string): unknown
}

export interface OpenSettingsOptions {
  readonly file: string
  readonly log: Pick<ChannelLogger, 'warn' | 'info'>
  readonly separateInstall: boolean
  readonly createMissing?: boolean
  readonly lockTimeoutMs?: number
  readonly legacyProject?: (project: string) => LegacyProjectSource | undefined
}

export interface SettingsHandle<
  S extends Readonly<Record<string, SettingDeclaration>> = Readonly<
    Record<string, SettingDeclaration>
  >,
> {
  read(options?: { readonly project?: string }): Promise<void>
  get<K extends keyof S & string>(
    name: K,
    options: GetOptions,
  ): Promise<ValueOf<S[K]['value']>>
  report(): ReportEntry[]
  watch(onChange: () => void): () => void
}

type ReadOutcome =
  | { status: 'snapshot'; snapshot: SettingsSnapshot }
  | { status: 'missing' }
  | { status: 'unparseable' | 'unreadable' }

interface FileState {
  status: ReadOutcome['status']
  snapshot?: SettingsSnapshot
  entries: ReportEntry[]
}

const reportedKey = Symbol.for('cortexkit.common-auth.settings.reported.v1')

function reportedEntries(): Set<string> {
  let reported = Reflect.get(globalThis, reportedKey) as Set<string> | undefined
  if (!reported) {
    reported = new Set<string>()
    Reflect.set(globalThis, reportedKey, reported)
  }
  return reported
}

/** Internal test hook; not part of the settings package exports. */
export function resetSettingsReportedForTest(): void {
  reportedEntries().clear()
}

export function openSettings<
  S extends Readonly<Record<string, SettingDeclaration>>,
>(
  definition: SettingsDefinition<S>,
  options: OpenSettingsOptions,
): SettingsHandle<S> {
  options = { createMissing: false, lockTimeoutMs: 2_000, ...options }
  const userPath = resolve(options.file)
  const cacheOptions = {
    followSymlinks: true,
    // Read SettingsFs at call time so setSettingsFsForTest reaches open handles.
    stat: (path: string) => SettingsFs.stat(path),
    lstat: (path: string) => SettingsFs.lstat(path),
  }
  const userCache = new FileReadCache<ReadOutcome>(cacheOptions)
  const projectCache = new FileReadCache<ReadOutcome>(cacheOptions)
  let user: FileState | undefined
  const projects = new Map<string, FileState>()
  // A project's report and resolution use only the source selected by its read.
  const projectLevels = new Map<string, string>()
  const projectSequences = new Map<string, number>()
  let sequence = 0
  // Keep ordering metadata after eviction so an older in-flight read cannot win.
  const committedSequences = new Map<string, number>()
  const projectPath = (project: string): string =>
    resolve(join(project, '.cortexkit', `${definition.plugin}.jsonc`))

  async function load(
    file: ReportEntry['file'],
    reader?: LegacyProjectSource['read'],
  ): Promise<void> {
    const currentSequence = ++sequence
    const cache = file.kind === 'user' ? userCache : projectCache
    let loaded = false
    const outcome = await cache.read([file.path], async ([path]) => {
      loaded = true
      let text: string
      try {
        text = await SettingsFs.readFile(path as string, 'utf8')
      } catch (error) {
        return {
          status:
            (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? 'missing'
              : 'unreadable',
        }
      }
      let parsed: SettingsParseResult
      if (reader) {
        let value: unknown
        try {
          value = reader(text)
        } catch {
          return { status: 'unreadable' }
        }
        if (!isJsonObject(value)) return { status: 'unparseable' }
        // Legacy readers return an object keyed by setting name, not JSONC text.
        parsed = {
          parseable: true,
          text,
          hasBom: false,
          tree: undefined,
          value,
          duplicateKeyPaths: [],
          hasDuplicates: false,
        }
      } else {
        parsed = parseSettings(text)
      }
      return parsed.parseable
        ? {
            status: 'snapshot',
            snapshot: buildSettingsSnapshot(
              definition as SettingsDefinition,
              file,
              parsed,
            ),
          }
        : { status: 'unparseable' }
    })
    const key = JSON.stringify([file.kind, file.path])
    if (currentSequence <= (committedSequences.get(key) ?? 0)) return
    committedSequences.set(key, currentSequence)
    const previous = file.kind === 'user' ? user : projects.get(file.path)
    const snapshot =
      outcome.status === 'snapshot'
        ? outcome.snapshot
        : outcome.status === 'missing'
          ? undefined
          : previous?.snapshot
    const entries = [...(snapshot?.entries ?? [])]
    if (outcome.status === 'unparseable' || outcome.status === 'unreadable') {
      entries.unshift({
        file: { ...file },
        keyPath: [],
        reason: outcome.status,
      })
    }
    const state: FileState = { status: outcome.status, snapshot, entries }
    if (file.kind === 'user') {
      user = state
    } else {
      // Cache hits do not refresh insertion order; changed files do.
      if (loaded) projects.delete(file.path)
      if (!projects.has(file.path) && projects.size >= 64) {
        const oldest = projects.keys().next().value
        if (oldest !== undefined) {
          projects.delete(oldest)
          for (const [project, selected] of projectLevels) {
            if (selected === oldest) projectLevels.delete(project)
          }
        }
      }
      projects.set(file.path, state)
    }
    const reported = reportedEntries()
    for (const entry of entries) {
      const identity = JSON.stringify([
        entry.file.path,
        entry.keyPath,
        entry.reason,
      ])
      if (reported.has(identity)) continue
      reported.add(identity)
      options.log.warn(
        `Settings ${entry.reason}: ${entry.file.path} (${entry.keyPath.join('.') || '<root>'})`,
        structuredClone(entry),
      )
    }
  }

  async function readProject(project: string): Promise<void> {
    const path = projectPath(project)
    const currentSequence = ++sequence
    await load({ kind: 'project', path })
    if (currentSequence <= (projectSequences.get(path) ?? 0)) return
    let selected = path
    if (projects.get(path)?.status === 'missing') {
      const source = options.legacyProject?.(project)
      if (source) {
        selected = resolve(source.path)
        await load({ kind: 'legacy-project', path: selected }, (text) =>
          source.read(text),
        )
      }
    }
    // A slow legacy reader must not replace a newer read's project-file choice.
    if (currentSequence <= (projectSequences.get(path) ?? 0)) return
    projectSequences.set(path, currentSequence)
    projectLevels.set(path, selected)
  }

  const handle: SettingsHandle<S> = {
    async read({ project } = {}) {
      if (options.separateInstall) return
      await Promise.all([
        load({ kind: 'user', path: userPath }),
        ...(project === undefined ? [] : [readProject(project)]),
      ])
    },
    async get(name, getOptions) {
      if (!Object.hasOwn(definition.settings, name)) {
        throw new TypeError(`Undeclared setting: ${name}`)
      }
      await handle.read({ project: getOptions.project })
      return resolveSetting(definition, name, getOptions, {
        user: user?.snapshot,
        project:
          getOptions.project === undefined
            ? undefined
            : projects.get(
                projectLevels.get(projectPath(getOptions.project)) ?? '',
              )?.snapshot,
      })
    },
    report() {
      return structuredClone([
        ...(user?.entries ?? []),
        ...Array.from(new Set(projectLevels.values())).flatMap(
          (path) => projects.get(path)?.entries ?? [],
        ),
      ])
    },
    watch(onChange) {
      if (options.separateInstall) return () => {}
      return watchSettings(userPath, onChange, {
        fs: {
          stat: (path) => SettingsFs.stat(path),
          readFile: (path) => SettingsFs.readFile(path, 'utf8'),
        },
      })
    },
  }
  return handle
}
