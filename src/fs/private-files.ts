import { randomUUID } from 'node:crypto'
import { lstat, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { PosixOwnerOnlyPathAsyncOptions } from '@cortexkit/private-files'

export const windowsPrivateFiles = process.platform === 'win32'
type Backend = typeof import('@cortexkit/private-files')
type Kind = 'file' | 'directory'
const migrationNotices = new Set<string>()

function ioCode(detail: {
  code?: string
  win32Code?: number
  reason?: string
}): string {
  // Native errors retain their Win32 code. Only demonstrated absence/exclusive
  // collisions are normalized; access/sharing failures never become lost races.
  if (detail?.reason === 'io-error') {
    if (detail.win32Code === 2 || detail.win32Code === 3) return 'ENOENT'
    if (detail.win32Code === 80 || detail.win32Code === 183) return 'EEXIST'
  }
  return detail?.code ?? 'ERR_PRIVATE_FILE'
}

// Production loads this package only on Windows; POSIX keeps its own directory policy.
let backend: Promise<Backend> | undefined
/** Tests inject a backend here; production always imports the private-files package. */
export function setPrivateFilesBackendForTest(api?: Backend): void {
  backend = api ? Promise.resolve(api) : undefined
}
function loadBackend(): Promise<Backend> {
  backend ??= import('@cortexkit/private-files')
  return backend
}

export class PrivateFileError extends Error {
  readonly code: string
  readonly win32Code?: number
  readonly reason?: string
  published = false
  durabilityConfirmed = false
  fileDurable = false
  attempts = 0
  elapsedMs = 0
  orphanPath?: string

  constructor(
    readonly path: string,
    readonly stage: string,
    cause: unknown,
  ) {
    const detail = cause as {
      code?: string
      win32Code?: number
      reason?: string
    }
    super(
      `Private file refused at ${stage}: ${path} (${detail?.reason ?? detail?.code ?? 'io-error'}). Use a safe parent directory. Repair only a named secret file in safe ancestry whose owner the published policy trusts, without changing its owner or any existing directory. Previously exposed credentials may need rotation. Windows requires the private-files native prebuild and an ACL-persisting local filesystem such as NTFS.`,
      { cause },
    )
    this.name = 'PrivateFileError'
    this.code = ioCode(detail)
    this.win32Code = detail?.win32Code
    this.reason = detail?.reason
  }
}

export async function privateOperation<T>(
  path: string,
  stage: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation()
  } catch (cause) {
    if (cause instanceof PrivateFileError) throw cause
    throw new PrivateFileError(path, stage, cause)
  }
}

// Tests inject metadata into safe-parent checks, including checks deep inside
// callers that take no policy options. Production never sets this.
let safeParentOptionsForTest: PosixOwnerOnlyPathAsyncOptions | undefined
/** Tests only: policy options used by safe-parent checks that pass none. */
export function setSafeParentOptionsForTest(
  options?: PosixOwnerOnlyPathAsyncOptions,
): void {
  safeParentOptionsForTest = options
}

/** Existing containing directories use the shared entry-integrity policy, not secret-file permissions. */
export async function verifySafeDirectory(
  path: string,
  options?: PosixOwnerOnlyPathAsyncOptions,
): Promise<void> {
  path = resolve(path)
  options ??= safeParentOptionsForTest
  await privateOperation(path, 'safe-parent', async () => {
    const result = await (await loadBackend()).verifySafeParent(path, options)
    if (result.ok === false) {
      // Preserve an absent parent's ENOENT so callers can create it privately.
      if (result.reason === 'io-error' || result.reason === 'wrong-kind')
        await lstat(path)
      throw new PrivateFileError(result.level ?? result.path, 'safe-parent', {
        ...result,
        code: 'ERR_PRIVATE_FILES_SECURITY',
      })
    }
  })
}

/** Repair only the specific owned secret file supplied by a caller, never an existing directory tree. */
export async function verifyPrivate(
  path: string,
  kind: Kind,
  migrate = false,
): Promise<void> {
  path = resolve(path)
  if (kind === 'directory') return verifySafeDirectory(path)
  await privateOperation(path, 'verify', async () => {
    const api = await loadBackend()
    const result = await api.verifyOwnerOnly(path)
    let repaired = false
    if (!result.ok) {
      const { reason } = result.refusal
      // The result API intentionally omits native IO codes. Use the throwing
      // API to preserve absence/collision details, never infer them from text.
      if (reason === 'io-error') await api.verifyPrivatePath(path, kind)
      // DACL replacement repairs permissions only, never ownership or unsafe ancestry.
      if (
        migrate &&
        [
          api.EXTRA_ACE,
          api.NOT_PROTECTED,
          api.NULL_DACL,
          api.EMPTY_DACL,
        ].includes(reason as typeof api.EXTRA_ACE)
      ) {
        await verifySafeDirectory(dirname(path))
        await api.securePrivatePath(path, kind)
        repaired = true
      } else {
        throw Object.assign(new Error('Owner-only verification refused'), {
          reason,
          code: 'ERR_PRIVATE_FILES_SECURITY',
        })
      }
    }
    // Verify the expected object kind and its permissions by handle after repair.
    await api.verifyPrivatePath(path, kind)
    if (repaired && !migrationNotices.has(path)) {
      migrationNotices.add(path)
      process.emitWarning(
        `Private permissions tightened: ${path}. This object may have been readable before; rotate credentials if needed.`,
        'PrivateFileMigration',
      )
    }
  })
}

/** Create missing components privately; inspect existing ancestors without modifying them. */
export async function ensurePrivateDirectory(
  path: string,
  _migrate = false,
  options?: PosixOwnerOnlyPathAsyncOptions,
): Promise<void> {
  path = resolve(path)
  await privateOperation(path, 'directory', async () => {
    const api = await loadBackend()
    try {
      await lstat(path)
      return await verifySafeDirectory(path, options)
    } catch (error) {
      if (ioCode(error as NodeJS.ErrnoException) !== 'ENOENT') throw error
    }
    const parent = dirname(path)
    if (parent === path)
      throw Object.assign(new Error('Missing root'), { code: 'ENOENT' })
    await ensurePrivateDirectory(parent, false, options)
    try {
      await api.createOwnerOnly(path, { kind: 'dir' })
    } catch (error) {
      if (ioCode(error as NodeJS.ErrnoException) !== 'EEXIST') throw error
    }
    await verifySafeDirectory(path, options)
  })
}

export async function readPrivateText(
  path: string,
  migrate = false,
): Promise<string> {
  if (!windowsPrivateFiles) return readFile(path, 'utf8')
  return (await readPrivateBuffer(path, migrate)).toString('utf8')
}

export async function readPrivateBuffer(
  path: string,
  migrate = false,
): Promise<Buffer> {
  if (!windowsPrivateFiles) return readFile(path)
  path = resolve(path)
  if (migrate) {
    await verifySafeDirectory(dirname(path))
    await verifyPrivate(path, 'file', true)
  }
  return privateOperation(path, 'read', async () =>
    (await loadBackend()).readOwnerOnly(path),
  )
}

export async function createPrivateBytes(
  path: string,
  bytes: string,
): Promise<void> {
  await verifySafeDirectory(dirname(resolve(path)))
  await privateOperation(path, 'create', async () => {
    // The backend verifies the creation handle while empty, before consuming bytes.
    await (await loadBackend()).createPrivateFile(resolve(path), bytes)
  })
}

export async function createPrivateDirectoryExclusive(
  path: string,
): Promise<void> {
  await verifySafeDirectory(dirname(resolve(path)))
  await privateOperation(path, 'directory-create', async () => {
    await (await loadBackend()).createOwnerOnly(resolve(path), { kind: 'dir' })
  })
}

export interface ReplaceOptions {
  beforeRename?: () => Promise<void>
  /** Absolute monotonic deadline, for an expiring lease. */
  deadline?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  rename?: typeof rename
}

/** Retry Windows rename sharing/access errors within a budget; they never prove lease contention. */
export async function replaceWindowsFile(
  from: string,
  to: string,
  options: ReplaceOptions = {},
): Promise<{ attempts: number; elapsedMs: number }> {
  from = resolve(from)
  to = resolve(to)
  const now = options.now ?? (() => performance.now())
  const start = now()
  const deadline = Math.min(start + 500, options.deadline ?? Infinity)
  const delays = [0, 10, 20, 40, 80, 100]
  let original: unknown
  let attempts = 0
  for (const delay of delays) {
    if (now() >= deadline) break
    if (delay)
      await (options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(
        Math.min(delay, Math.max(0, deadline - now())),
      )
    if (now() >= deadline) break
    await options.beforeRename?.()
    if (now() >= deadline) break
    attempts++
    try {
      await (options.rename ?? rename)(from, to)
      return { attempts, elapsedMs: now() - start }
    } catch (error) {
      original ??= error
      const detail = error as {
        code?: string
        win32Code?: number
        reason?: string
      }
      const candidate =
        detail.win32Code !== undefined
          ? detail.win32Code === 32 || detail.win32Code === 33
          : ['EBUSY', 'EPERM', 'EACCES'].includes(detail.code ?? '') &&
            !detail.reason
      if (!candidate) break
    }
  }
  const error = new PrivateFileError(
    to,
    'rename',
    original ??
      Object.assign(new Error('Publication deadline expired'), {
        code: 'ETIMEDOUT',
      }),
  )
  error.attempts = attempts
  error.elapsedMs = now() - start
  throw error
}

export interface PrivateWriteOutcome {
  path: string
  stage: string
  published: boolean
  fileDurable: boolean
  durabilityConfirmed: boolean
  attempts: number
  elapsedMs: number
  code?: string
  win32Code?: number
}

export async function writePrivateAtomic(
  path: string,
  bytes: string,
  options: ReplaceOptions & {
    stagePath?: string
    onRenamed?: () => void
    durable?: boolean
    durability?: 'file-only-on-windows'
    onOutcome?: (outcome: PrivateWriteOutcome) => void
  } = {},
): Promise<void> {
  path = resolve(path)
  await ensurePrivateDirectory(dirname(path))
  try {
    await verifyPrivate(path, 'file', true)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const stage = resolve(options.stagePath ?? `${path}.${randomUUID()}.tmp`)
  if (dirname(stage) !== dirname(path))
    throw new PrivateFileError(path, 'stage-directory', { code: 'EXDEV' })
  let created = false
  let published = false
  let outcome = { attempts: 0, elapsedMs: 0 }
  let stageName = 'stage-create'
  const reportOutcome = (error?: PrivateFileError) => {
    try {
      options.onOutcome?.({
        path,
        stage: error?.stage ?? 'published',
        published,
        fileDurable: published,
        durabilityConfirmed: false,
        attempts: error?.attempts ?? outcome.attempts,
        elapsedMs: error?.elapsedMs ?? outcome.elapsedMs,
        ...(error && { code: error.code, win32Code: error.win32Code }),
      })
    } catch {
      // Outcome observers cannot change whether publication succeeded.
    }
  }
  try {
    await createPrivateBytes(stage, bytes)
    created = true
    stageName = 'before-rename'
    outcome = await replaceWindowsFile(stage, path, options)
    created = false
    published = true
    stageName = 'published-callback'
    options.onRenamed?.()
    stageName = 'published-verify'
    await verifyPrivate(path, 'file')
    // createPrivateFile flushes the file. Directory metadata durability has not
    // been qualified on Windows, so never promise the POSIX directory fsync.
    if (options.durable && options.durability !== 'file-only-on-windows')
      throw new PrivateFileError(path, 'directory-sync-unsupported', {
        code: 'ENOTSUP',
      })
    reportOutcome()
  } catch (cause) {
    const error =
      cause instanceof PrivateFileError
        ? cause
        : new PrivateFileError(path, stageName, cause)
    error.published = published
    error.fileDurable = published
    if (published) Object.assign(error, outcome)
    if (created) {
      try {
        await unlink(stage)
      } catch {
        error.orphanPath = stage
      }
      created = false
    }
    reportOutcome(error)
    throw error
  } finally {
    if (created) await unlink(stage).catch(() => {})
  }
}
