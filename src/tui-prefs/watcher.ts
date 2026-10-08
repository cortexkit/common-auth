import {
  readFileSync,
  realpathSync,
  type Stats,
  statSync,
  watch,
} from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { clearTimeout, setTimeout } from 'node:timers'

type Metadata = Pick<Stats, 'mtimeMs' | 'size' | 'ino' | 'dev'>

export interface TuiPreferencesWatchOptions {
  watchDirectory?: typeof watch
  /** Internal filesystem seam; the first subscriber supplies a shared watcher's I/O. */
  fs?: {
    readFileSync?: (file: string) => string
    readFile?: (file: string) => Promise<string>
    statSync?: (file: string) => Metadata
    stat?: (file: string) => Promise<Metadata>
  }
}

interface SharedWatcher {
  subscribe: (onChange: () => void) => () => void
}

function canonicalPath(file: string): string {
  const path = resolve(file)
  try {
    return realpathSync(path)
  } catch {
    // Resolve existing ancestors even when the preferences file is not yet present.
    const parent = dirname(path)
    return parent === path ? path : join(canonicalPath(parent), basename(path))
  }
}

function identity(info: Metadata | null): string | null {
  return info && `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}`
}

/**
 * Share one directory watcher and metadata poll per canonical path, including
 * across bundled copies. Native events use a 150 ms debounce; missed events
 * recover through a 1,000 ms stat probe (formerly a 100 ms full-file poll).
 * Watching the directory preserves atomic replacement and missing-file recovery.
 * Only changed raw text notifies; each subscriber is isolated and independently
 * disposable. The last unsubscribe stops both the native watcher and the poll.
 */
export function watchTuiPreferences(
  file: string,
  onChange: () => void,
  options: TuiPreferencesWatchOptions = {},
): () => void {
  const globals = globalThis as unknown as Record<
    symbol,
    Map<string, SharedWatcher> | undefined
  >
  const key = Symbol.for('cortexkit.common-auth.tui-prefs.watchers.v1')
  const registry = globals[key] ?? new Map<string, SharedWatcher>()
  globals[key] = registry
  const path = canonicalPath(file)
  const shared = registry.get(path)
  if (shared) return shared.subscribe(onChange)

  const name = basename(path)
  const read = options.fs?.readFile ?? ((file) => readFile(file, 'utf8'))
  const probe = options.fs?.stat ?? stat
  let timer: ReturnType<typeof setTimeout> | null = null
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let lastMetadata: string | null = null
  let lastSeen: string | null = null
  // Seed synchronously so an immediate write cannot be absorbed as the baseline.
  try {
    lastMetadata = identity((options.fs?.statSync ?? statSync)(path))
    lastSeen = (
      options.fs?.readFileSync ?? ((file) => readFileSync(file, 'utf8'))
    )(path)
  } catch {
    // Missing files and directories can be created later.
  }
  let disposed = false
  const subscribers = new Set<{ notify: () => void }>()
  let checking = Promise.resolve()
  const checkForChange = (native: boolean) => {
    // Serialize native and poll checks so an older read cannot roll back state.
    checking = checking.then(async () => {
      if (disposed) return
      const metadata = identity(await probe(path).catch(() => null))
      if (!native && metadata === lastMetadata) return
      // A missing file has nothing to read; remember that so the probe stays
      // quiet until it reappears.
      if (metadata === null) {
        lastMetadata = null
        return
      }
      const text = await read(path).catch(() => null)
      if (disposed) return
      // Record the metadata only once its contents were read. A failed read
      // leaves the old value, so the next probe sees a change and retries
      // instead of skipping a file whose new contents were never observed.
      if (text === null) return
      lastMetadata = metadata
      if (text === lastSeen) return
      lastSeen = text
      for (const subscriber of [...subscribers]) {
        if (!subscribers.has(subscriber)) continue
        try {
          subscriber.notify()
        } catch {
          // A broken subscriber must not prevent the others from observing a change.
        }
      }
    })
    return checking
  }
  const scheduleCheck = () => {
    if (disposed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void checkForChange(true)
    }, 150)
  }

  let watcher: ReturnType<typeof watch> | null = null
  try {
    watcher = (options.watchDirectory ?? watch)(
      dirname(path),
      (_event, filename) => {
        const eventName = filename?.toString()
        const isOurs =
          eventName === name ||
          (eventName?.startsWith(`${name}.`) && eventName.endsWith('.tmp'))
        if (eventName != null && !isOurs) return
        scheduleCheck()
      },
    )
    watcher.on('error', () => {
      // Polling continues if the native watcher fails after construction.
      watcher?.close()
      watcher = null
    })
  } catch {
    // The probe still recovers a later creation, even with no native watcher.
  }

  const schedulePoll = () => {
    if (disposed || pollTimer) return
    pollTimer = setTimeout(() => {
      pollTimer = null
      if (disposed) return
      void checkForChange(false).finally(schedulePoll)
    }, 1_000)
    pollTimer.unref()
  }
  const entry: SharedWatcher = {
    subscribe: (notify) => {
      const subscriber = { notify }
      subscribers.add(subscriber)
      return () => {
        if (!subscribers.delete(subscriber) || subscribers.size > 0) return
        disposed = true
        if (timer) clearTimeout(timer)
        if (pollTimer) clearTimeout(pollTimer)
        watcher?.close()
        if (registry.get(path) === entry) registry.delete(path)
      }
    },
  }
  registry.set(path, entry)
  schedulePoll()
  return entry.subscribe(onChange)
}
