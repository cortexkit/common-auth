import { chmod, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  LockContentionError,
  LockOwnershipError,
  WRITER_LOCK_CONSTANTS,
  withLock,
  writeJsonAtomic,
} from '../fs/index.js'

export interface SidebarFileHooks {
  /** Runs on the first merge attempt, before checking for older, unlocked writers. */
  beforeRecheck?: () => void | Promise<void>
  /** @internal Test seam after staging, before the ownership fence. */
  beforeCommit?: () => Promise<void>
  /** @internal Test seam after the rename, before ownership is checked again. */
  afterRename?: () => Promise<void>
}

/**
 * Rebuild a write after the lock was lost while it was being renamed into
 * place. `current` is the file as it is now, under a freshly taken lock: a
 * successor may have written it after taking over the lease. `written` is the
 * value this write committed. Return the value to write instead, typically
 * the successor's state with only the fields this write is the authority on
 * carried over, or undefined to leave the file as it is.
 */
export type SidebarRepair<T> = (current: T, written: T) => T | undefined

export interface SidebarWriteOptions<T> extends SidebarFileHooks {
  /** Repair for this write; overrides the file's `repair` option. */
  repair?: SidebarRepair<T>
  /**
   * Told how this write ended, before its promise resolves. A callback
   * rather than a resolved value, so `write` and `update` keep resolving to
   * nothing for callers that pass them on as `Promise<void>`.
   */
  onResult?: (result: SidebarWriteResult) => void
}

/**
 * How a write ended.
 *
 * - `skipped`: the merge returned undefined, so nothing was written.
 * - `written`: the value was renamed into place and the lock was still held
 *   afterwards, so no other writer can have taken over during the rename.
 * - `lost-after-rename`: the value was renamed into place, but by then the
 *   lock had been taken over; the value may have replaced a successor's
 *   state. `repair` says what was done about it: `none` (no repair was
 *   supplied), `written` (the repaired value was committed and the lock held),
 *   `skipped` (the repair returned undefined), `lock-unavailable` (the lock
 *   could not be retaken in time) or `lost-again` (the repaired value was
 *   committed but the lock was lost again; no further repair is tried).
 */
export type SidebarWriteResult =
  | { status: 'skipped' }
  | { status: 'written' }
  | {
      status: 'lost-after-rename'
      repair: 'none' | 'written' | 'skipped' | 'lock-unavailable' | 'lost-again'
    }

export interface SidebarFileOptions<T> {
  path: string
  defaultValue: T
  normalize: (parsed: unknown) => T
  timeoutMs?: number
  /**
   * Tighten an existing parent directory to 0o700 before each write. Defaults
   * to true. Pass false for a directory the user chose (an override path),
   * whose permissions are theirs to set. A parent this library has to create
   * is always created private, either way.
   */
  secureDir?: boolean
  logger?: {
    warn: (message: string, payload?: unknown) => void
    debug: (message: string, payload?: unknown) => void
  }
  /**
   * Runs once, under a newly taken lock, when a write finds after its rename
   * that the lock was lost. Without it such a write is only reported.
   */
  repair?: SidebarRepair<T>
  /**
   * Name of the lock writers coordinate on, as `<path>.<lockName>.lock`.
   * Defaults to `'sidebar-write'`. It names both the lock a write takes and
   * the lock whose ownership is checked before the rename, so a takeover of
   * this name refuses the write. A plugin keeping an existing writer's lock
   * identity passes that writer's name; mutual exclusion with that writer is
   * promised only while it holds a live lease of the same name in the same
   * lock-file format, not for its stale-lock reclamation or renewal.
   */
  lockName?: string
}

export interface SidebarFile<T> {
  read(): Promise<T>
  write(value: T, options?: SidebarWriteOptions<T>): Promise<void>
  update(
    merge: (latest: T) => T | undefined,
    options?: SidebarWriteOptions<T>,
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
  const enqueue = (
    operation: () => Promise<SidebarWriteResult>,
    writeOptions: SidebarWriteOptions<T> | undefined,
  ): Promise<void> => {
    const result = chain
      .then(operation)
      .then((outcome) => writeOptions?.onResult?.(outcome))
    // Keep the next operation runnable without hiding this caller's rejection.
    chain = result.catch(() => {})
    return result
  }
  const lockOptions = {
    ...WRITER_LOCK_CONSTANTS.sidebar,
    name: options.lockName ?? WRITER_LOCK_CONSTANTS.sidebar.name,
    timeoutMs: options.timeoutMs ?? WRITER_LOCK_CONSTANTS.sidebar.timeoutMs,
  }
  /**
   * Rename `value` into place under `lock`, then report whether the lock was
   * still held. The fence before the rename stops a write whose lock is
   * already gone; the check after it catches a lock lost while the rename
   * itself was in flight, which no check before it can see.
   */
  const commitUnder = async (
    lock: { assertOwned(): Promise<void> },
    value: T,
    hooks: SidebarFileHooks | undefined,
  ): Promise<boolean> => {
    await writeJsonAtomic(path, value, {
      serialize: JSON.stringify,
      beforeRename: async () => {
        await hooks?.beforeCommit?.()
        await lock.assertOwned()
      },
    })
    await hooks?.afterRename?.()
    try {
      await lock.assertOwned()
      return true
    } catch (error) {
      if (error instanceof LockOwnershipError) return false
      throw error
    }
  }
  /**
   * One repair, under a new lock, of a write that lost its lock during the
   * rename. Bounded to a single attempt: if the repair loses its lock too,
   * the newer holder is writing and its state stands.
   */
  const repairLostWrite = async (
    repair: SidebarRepair<T>,
    written: T,
    hooks: SidebarFileHooks | undefined,
  ): Promise<SidebarWriteResult> => {
    options.logger?.warn('sidebar lock lost after rename; repairing write', {
      path,
    })
    try {
      const outcome = await withLock(path, lockOptions, async (lock) => {
        const next = repair(await read(), written)
        if (next === undefined) return 'skipped' as const
        return (await commitUnder(lock, next, hooks))
          ? ('written' as const)
          : ('lost-again' as const)
      })
      if (outcome === 'lost-again') {
        options.logger?.warn('sidebar repair lost its lock after rename', {
          path,
        })
      }
      return { status: 'lost-after-rename', repair: outcome }
    } catch (error) {
      if (!(error instanceof LockContentionError)) throw error
      options.logger?.warn('sidebar repair lock unavailable; repair skipped', {
        path,
      })
      return { status: 'lost-after-rename', repair: 'lock-unavailable' }
    }
  }
  const persist = async (
    merge: (latest: T) => T | undefined,
    writeOptions?: SidebarWriteOptions<T>,
  ): Promise<SidebarWriteResult> => {
    const hooks: SidebarFileHooks | undefined = writeOptions
    const parent = dirname(path)
    const secureDir = options.secureDir ?? true
    await mkdir(parent, { recursive: true, mode: 0o700 })
    if (secureDir) {
      await chmod(parent, 0o700).catch((error: unknown) => {
        options.logger?.warn(
          'sidebar directory permission remediation failed',
          { error: error instanceof Error ? error.message : String(error) },
        )
      })
    }
    const committed = await withLock(path, lockOptions, async (lock) => {
      const commit = async (value: T) => ({
        value,
        held: await commitUnder(lock, value, hooks),
      })
      // Older processes may ignore the lock; remerge if their bytes changed.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const raw = await readRaw()
        const next = merge(parse(raw))
        if (next === undefined) return undefined
        if (attempt === 0) await hooks?.beforeRecheck?.()
        if ((await readRaw()) !== raw) continue
        return await commit(next)
      }
      const next = merge(await read())
      return next === undefined ? undefined : await commit(next)
    })
    if (committed === undefined) return { status: 'skipped' }
    if (committed.held) return { status: 'written' }
    // The first lock is released by now; the repair takes its own.
    const repair = writeOptions?.repair ?? options.repair
    if (!repair) {
      options.logger?.warn(
        'sidebar lock lost after rename; write not repaired',
        {
          path,
        },
      )
      return { status: 'lost-after-rename', repair: 'none' }
    }
    return await repairLostWrite(repair, committed.value, hooks)
  }
  return {
    read,
    write: (value, writeOptions) =>
      enqueue(() => persist(() => value, writeOptions), writeOptions),
    update: (merge, writeOptions) =>
      enqueue(() => persist(merge, writeOptions), writeOptions),
  }
}
