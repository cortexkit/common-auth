import { join, resolve } from 'node:path'
import { FileReadCache } from '../fs/file-read-cache.js'
import type { ChannelLogger } from '../logger/engine.js'
import type { SettingDeclaration, SettingsDefinition } from './define.js'
import type { ValueOf } from './descriptors.js'
import { SettingsFs } from './fs.js'
import { parseSettings } from './parse.js'
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
  // Older project settings are not read through this callback yet.
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
}

type ReadOutcome =
  | { status: 'snapshot'; snapshot: SettingsSnapshot }
  | { status: 'missing' }
  | { status: 'unparseable' | 'unreadable' }

interface FileState {
  snapshot?: SettingsSnapshot
  entries: ReportEntry[]
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
    stat: SettingsFs.stat,
    lstat: SettingsFs.lstat,
  }
  const userCache = new FileReadCache<ReadOutcome>(cacheOptions)
  const projectCache = new FileReadCache<ReadOutcome>(cacheOptions)
  let user: FileState | undefined
  const projects = new Map<string, FileState>()
  let sequence = 0
  // Keep ordering metadata after eviction so an older in-flight read cannot win.
  const committedSequences = new Map<string, number>()
  const projectPath = (project: string): string =>
    resolve(join(project, '.cortexkit', `${definition.plugin}.jsonc`))

  async function load(file: ReportEntry['file']): Promise<void> {
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
      const parsed = parseSettings(text)
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
    const state: FileState = { snapshot, entries }
    if (file.kind === 'user') {
      user = state
    } else {
      // Cache hits do not refresh insertion order; changed files do.
      if (loaded) projects.delete(file.path)
      if (!projects.has(file.path) && projects.size >= 64) {
        const oldest = projects.keys().next().value
        if (oldest !== undefined) projects.delete(oldest)
      }
      projects.set(file.path, state)
    }
  }

  const handle: SettingsHandle<S> = {
    async read({ project } = {}) {
      if (options.separateInstall) return
      await Promise.all([
        load({ kind: 'user', path: userPath }),
        ...(project === undefined
          ? []
          : [load({ kind: 'project', path: projectPath(project) })]),
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
            : projects.get(projectPath(getOptions.project))?.snapshot,
      })
    },
    report() {
      return structuredClone([
        ...(user?.entries ?? []),
        ...Array.from(projects.values()).flatMap((state) => state.entries),
      ])
    },
  }
  return handle
}
