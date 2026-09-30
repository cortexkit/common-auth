import { chmod, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  WRITER_LOCK_CONSTANTS,
  withLock,
  writeJsonAtomic,
} from '../fs/index.js'

export interface SidebarFileHooks {
  /** Runs on the first merge attempt, before checking for older, unlocked writers. */
  beforeRecheck?: () => void | Promise<void>
  /** @internal Test seam after staging, before the ownership fence. */
  beforeCommit?: () => Promise<void>
}

export interface SidebarFileOptions<T> {
  path: string
  defaultValue: T
  normalize: (parsed: unknown) => T
  timeoutMs?: number
  /**
   * Create the parent directory private and tighten it to 0o700 before each
   * write. Defaults to true. Pass false for a directory the user chose (an
   * override path), whose permissions are theirs to set.
   */
  secureDir?: boolean
  logger?: {
    warn: (message: string, payload?: unknown) => void
    debug: (message: string, payload?: unknown) => void
  }
}

export interface SidebarFile<T> {
  read(): Promise<T>
  write(value: T, hooks?: SidebarFileHooks): Promise<void>
  update(
    merge: (latest: T) => T | undefined,
    hooks?: SidebarFileHooks,
  ): Promise<void>
}

/** Binds generic persistence to a caller's path and normalization policy. */
export function createSidebarFile<T>(
  options: SidebarFileOptions<T>,
): SidebarFile<T> {
  const { path, defaultValue, normalize } = options
  let chain: Promise<void> = Promise.resolve()

  const parse = (raw: string): T => {
    if (raw === '') return defaultValue
    try {
      return normalize(JSON.parse(raw))
    } catch {
      return defaultValue
    }
  }
  const readRaw = async (): Promise<string> => {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    }
  }
  const read = async (): Promise<T> => {
    try {
      return parse(await readRaw())
    } catch {
      return defaultValue
    }
  }
  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const result = chain.then(operation)
    // Keep the next operation runnable without hiding this caller's rejection.
    chain = result.catch(() => {})
    return result
  }
  const persist = async (
    merge: (latest: T) => T | undefined,
    hooks?: SidebarFileHooks,
  ): Promise<void> => {
    const parent = dirname(path)
    const secureDir = options.secureDir ?? true
    await mkdir(parent, {
      recursive: true,
      mode: secureDir ? 0o700 : undefined,
    })
    if (secureDir) {
      await chmod(parent, 0o700).catch((error: unknown) => {
        options.logger?.warn(
          'sidebar directory permission remediation failed',
          { error: error instanceof Error ? error.message : String(error) },
        )
      })
    }
    await withLock(
      path,
      {
        ...WRITER_LOCK_CONSTANTS.sidebar,
        timeoutMs: options.timeoutMs ?? WRITER_LOCK_CONSTANTS.sidebar.timeoutMs,
      },
      async (lock) => {
        const commit = (value: T) =>
          writeJsonAtomic(path, value, {
            serialize: JSON.stringify,
            beforeRename: async () => {
              await hooks?.beforeCommit?.()
              await lock.assertOwned()
            },
          })
        // Older processes may ignore the lock; remerge if their bytes changed.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const raw = await readRaw()
          const next = merge(parse(raw))
          if (next === undefined) return
          if (attempt === 0) await hooks?.beforeRecheck?.()
          if ((await readRaw()) !== raw) continue
          await commit(next)
          return
        }
        const next = merge(await read())
        if (next !== undefined) await commit(next)
      },
    )
  }
  return {
    read,
    write: (value, hooks) => enqueue(() => persist(() => value, hooks)),
    update: (merge, hooks) => enqueue(() => persist(merge, hooks)),
  }
}
