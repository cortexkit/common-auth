import { createHash, randomUUID } from 'node:crypto'
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { LockOwnershipError, lockPathFor } from './with-lock.js'

const setRefreshLockRenewalTimeout = globalThis.setTimeout.bind(globalThis)
const clearRefreshLockRenewalTimeout = globalThis.clearTimeout.bind(globalThis)

// How a lease record changes hands safely.
//
// A path cannot be compared-and-swapped: any "read the path, check it, then
// rename or delete the path" leaves a gap in which a process that stalls (a
// starved event loop, a slow disk) can act on a record that is no longer the
// one it checked, and so replace or delete a successor's lease. This module
// therefore never changes a lease record by its path once the record exists:
//
// - The holder renews and gives up its lease by writing its own record in
//   place, through a file handle on which it has just read its own owner id.
//   A handle stays on the file it opened even if the path is later renamed or
//   unlinked, so a holder that stalls after its check and is replaced in the
//   meantime writes into its own discarded file and touches nothing of the
//   successor's. Nobody ever writes another holder's owner id into an
//   existing record (a new holder always creates a new file), so a file whose
//   owner id was ours when read through the handle is still ours later.
// - Release only expires its own record in place, as above, and leaves the
//   expired record at the path. Removing it would mean renaming or deleting
//   whatever the path names by then, which may already be a successor's.
// - A contender clears an expired record by renaming it to a private name and
//   judging that file, which is no longer reachable by the lock path; if it
//   turns out to be live, it goes back with link(), which fails instead of
//   replacing a record created meanwhile. A live record that cannot go back
//   is kept under its private name, never deleted, and removed only once it
//   has expired.
// - A new record is written in full under a private name and then linked to
//   the lock path, so the path never names a partly written record.
// - Every record has the same length, so an in-place rewrite is one write of
//   the same size and the file never has a moment at another length. Each
//   record also carries a short hash of its owner id and expiry (`check`). A
//   read that overlaps an in-place write could in principle see some old and
//   some new bytes: POSIX makes read() and write() on a regular file atomic
//   with respect to each other only between threads, and Linux's buffered
//   reads do not take the lock that writes take, so this is not relied on.
//   A record whose hash does not match, or a record of this length whose
//   keys are not exactly `ownerId`, `expiresAt` and `check`, is treated as
//   unreadable, which every reader already handles: contenders fall back to
//   the file's mtime, and an owner's assertOwned fails closed. Releases before
//   this one ignore the field and read `ownerId` and `expiresAt` as before;
//   the padding is JSON whitespace.
//
// Nothing is fsynced: a lease only means something while its holder runs, so
// after a crash or power loss there is no holder left for it to protect.
const LEASE_RECORD_BYTES = 128
// The expiry a released record is rewritten to: in the past for every clock.
const RELEASED_EXPIRES_AT = 0

interface LeaseRecord {
  readonly ownerId?: unknown
  readonly expiresAt?: unknown
  readonly check?: unknown
}

function leaseCheck(ownerId: unknown, expiresAt: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([ownerId, expiresAt]))
    .digest('hex')
    .slice(0, 16)
}

function serializeLease(ownerId: string, expiresAt: number): Buffer {
  const json = JSON.stringify({
    ownerId,
    expiresAt,
    check: leaseCheck(ownerId, expiresAt),
  })
  return Buffer.from(`${json.padEnd(LEASE_RECORD_BYTES - 1, ' ')}\n`, 'utf8')
}

/** A lease record that parsed but cannot be trusted to be what was written. */
class LeaseIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LeaseIntegrityError'
  }
}

const FIXED_WIDTH_KEYS = ['check', 'expiresAt', 'ownerId'].join()

/**
 * Parses a lease record and verifies its `check` when it has one. Records
 * written before the field existed have none and are read as they always were.
 * A record of exactly the fixed length is one this release wrote (older ones
 * are far shorter), so it must have exactly our three keys: a read that
 * mixed bytes of two records can still be valid JSON with a mangled key name
 * and no `check` at all, and must not pass as an old record. Throws, like a
 * JSON syntax error, when the record fails either test.
 */
function parseLease(text: string): LeaseRecord {
  const record: unknown = JSON.parse(text)
  const fixedWidth = Buffer.byteLength(text, 'utf8') === LEASE_RECORD_BYTES
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    if (fixedWidth)
      throw new LeaseIntegrityError('Lease record is not an object')
    return {}
  }
  const lease = record as LeaseRecord
  if (fixedWidth && Object.keys(lease).sort().join() !== FIXED_WIDTH_KEYS)
    throw new LeaseIntegrityError('Lease record has unexpected keys')
  if (
    'check' in lease &&
    lease.check !== leaseCheck(lease.ownerId, lease.expiresAt)
  )
    throw new LeaseIntegrityError('Lease record failed its integrity check')
  return lease
}

// Whether a read failed because the bytes did not parse or verify, as a torn
// read of an in-place write would, rather than because of a filesystem error.
function isIntegrityFailure(error: unknown): boolean {
  return error instanceof SyntaxError || error instanceof LeaseIntegrityError
}

// The private names a lock's records take beside it: `.reaping` for one moved
// off the lock path to be judged, `.creating` for one being written before it
// is linked into place. Both end in a random UUID's name part.
const LEFTOVER_SUFFIX = /^[0-9a-f-]{36}\.(?:reaping|creating)$/

// Errors link() gives on filesystems that have no hard links.
const HARD_LINKS_UNSUPPORTED = new Set([
  'EPERM',
  'ENOTSUP',
  'EOPNOTSUPP',
  'ENOSYS',
])

// A concurrent contender renaming the freshly-created eviction-marker directory
// away surfaces the vanished parent differently per platform: ENOENT on Linux,
// EINVAL or ENOTDIR on macOS/APFS. All three mean the marker is no longer ours
// to hold — a lost race the caller should retry, not a fatal lock error.
export function isLostMarkerRaceError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'EINVAL' || code === 'ENOTDIR'
}

export interface LockLoss {
  readonly reason:
    | 'taken-over'
    | 'expired'
    | 'unreadable'
    | 'renewal-failed'
    | 'marker-lost'
  readonly expectedOwnerId: string
  readonly observedOwnerId?: string
  readonly observedExpiresAt?: number
}

/**
 * A live lease record a contender moved off the lock path and could not put
 * back. It is kept under `path`, a private name nothing reads as the lock, and
 * removed by a later contender once it has expired. `reason` is
 * `lock-path-taken` when another record was created at the lock path while
 * this one was off it (the expected race), and `put-back-failed` for any
 * other error from the put-back, which is in `error`.
 */
export interface KeptAsideRecord {
  readonly path: string
  readonly lockPath: string
  readonly reason: 'lock-path-taken' | 'put-back-failed'
  readonly error: unknown
}

export interface RefreshFileLock {
  readonly ownerId: string
  assertOwned(): Promise<void>
  release(): Promise<void>
  /** Resolves once on detected loss; remains pending after an owner's release. */
  whenLost(): Promise<LockLoss>
  hasLost(): boolean
}

export async function acquireRefreshFileLock(options: {
  name: string
  ttlMs: number
  /**
   * File the lock is named after. Required: the lock and the write it guards
   * must target the same file, and a default resolved in here could only ever
   * be one host's path.
   */
  path: string
  now?: () => number
  renew?: boolean
  renewIntervalMs?: number
  /**
   * Told when this process, clearing an expired lock, moved a record that
   * turned out to be live off the lock path and could not put it back.
   * Errors it throws are ignored.
   */
  onRecordKeptAside?: (kept: KeptAsideRecord) => void
  onStep?: (
    step:
      | 'stale-marker-stat'
      | 'stale-marker-claimed'
      | 'stale-lock-confirmed'
      | 'stale-lock-moved-aside'
      | 'eviction-marker-acquired'
      | 'renewal-owner-confirmed'
      | 'renewal-marker-unavailable'
      | 'renewal-write-fenced'
      | 'renewal-write-ready'
      | 'renewal-marker-lost'
      // Not emitted since 0.8.1 (marker loss no longer gives the lease up);
      // kept so handlers written against 0.8.0 still type-check.
      | 'relinquish-read'
      | 'renewal-finished'
      | 'release-owner-confirmed',
  ) => void | Promise<void>
}): Promise<RefreshFileLock | null> {
  const lockPath = lockPathFor(options.path, options.name)
  const ownerId = randomUUID()
  const now = options.now ?? Date.now
  let renewTimer: ReturnType<typeof setTimeout> | null = null
  let released = false
  let loss: LockLoss | undefined
  let resolveLoss!: (loss: LockLoss) => void
  const lostPromise = new Promise<LockLoss>((resolve) => {
    resolveLoss = resolve
  })

  function recordLoss(
    reason: LockLoss['reason'],
    owner?: { ownerId?: unknown; expiresAt?: unknown },
  ) {
    if (loss || released) return
    loss = Object.freeze({
      reason,
      expectedOwnerId: ownerId,
      ...(typeof owner?.ownerId === 'string'
        ? { observedOwnerId: owner.ownerId }
        : {}),
      ...(typeof owner?.expiresAt === 'number'
        ? { observedExpiresAt: owner.expiresAt }
        : {}),
    })
    if (renewTimer) {
      clearRefreshLockRenewalTimeout(renewTimer)
      renewTimer = null
    }
    resolveLoss(loss)
  }
  let renewalInFlight: Promise<void> | null = null
  // The in-place write of our record that is under way, if any. assertOwned
  // waits for it, because a read that overlaps it can see a mix of old and
  // new bytes, which would otherwise look like a damaged record.
  let writeInFlight: Promise<unknown> | null = null
  // Only the owner of this exclusively-created marker may remove or renew a
  // lock. A contender recovering a stale marker can accidentally rename a newer
  // marker instead; checking its owner file before each mutation prevents the
  // displaced owner from continuing to act on the lock.
  const evictPath = `${lockPath}.evicting`
  const evictOwnerPath = join(evictPath, 'owner.json')
  const evictOwnerId = randomUUID()
  const EVICT_TTL = 5_000
  const MAX_STEAL_ATTEMPTS = 8

  // Reads a record by pathname. Used to look, never to decide a change: the
  // path may name a different record by the time anything acts on it.
  async function readLeaseAt(path: string): Promise<LeaseRecord> {
    try {
      return parseLease(await readFile(path, 'utf8'))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EISDIR') throw error
      // Very old releases made the lock a directory holding owner.json.
      return parseLease(await readFile(join(path, 'owner.json'), 'utf8'))
    }
  }

  function readOwner() {
    return readLeaseAt(lockPath)
  }

  // Reads the record in the file the handle has open, wherever that file now
  // is, with one positioned read of the whole file.
  async function readLeaseThrough(handle: FileHandle) {
    const { size } = await handle.stat()
    const buffer = Buffer.alloc(size)
    const { bytesRead } = await handle.read(buffer, 0, size, 0)
    return {
      record: parseLease(buffer.toString('utf8', 0, bytesRead)),
      size,
    }
  }

  // Rewrites the file the handle has open with our record. Callers first read
  // our own owner id through the same handle, so this only ever overwrites a
  // record of ours. `size` is the length that read saw; our records all have
  // the same length, so the truncate only runs on a file someone else edited.
  // A write that stores fewer than all the bytes leaves a mix of the new and
  // the old record, which fails its check: readers treat it as unreadable, so
  // the write is reported as failed rather than completed.
  async function writeLeaseThrough(
    handle: FileHandle,
    expiresAt: number,
    size: number,
  ) {
    const bytes = serializeLease(ownerId, expiresAt)
    const write = handle.write(bytes, 0, bytes.length, 0)
    const settled = write.then(
      () => {},
      () => {},
    )
    writeInFlight = settled
    try {
      const { bytesWritten } = await write
      if (bytesWritten !== bytes.length) {
        throw new Error(
          `Lease write stored ${bytesWritten} of ${bytes.length} bytes`,
        )
      }
    } finally {
      if (writeInFlight === settled) writeInFlight = null
    }
    if (size > bytes.length) await handle.truncate(bytes.length)
  }

  // Gives up our lease in the file the handle has open: if the record there is
  // ours, its expiry moves into the past so a contender may take the lock at
  // once. A record that is not ours is left exactly as it is.
  async function expireThrough(
    handle: FileHandle,
    confirmedStep?: 'release-owner-confirmed',
  ) {
    const { record, size } = await readLeaseThrough(handle)
    if (record.ownerId !== ownerId) return false
    if (confirmedStep && options.onStep) await options.onStep(confirmedStep)
    await writeLeaseThrough(handle, RELEASED_EXPIRES_AT, size)
    return true
  }

  // Expires the record now at the lock path if, read through the opened file,
  // it is ours. Reports whether it was.
  async function expireOwnRecordAtPath(
    confirmedStep?: 'release-owner-confirmed',
  ) {
    let handle: FileHandle
    try {
      handle = await open(lockPath, 'r+')
    } catch {
      // Missing, or a legacy directory: there is no record of ours to expire.
      return false
    }
    try {
      return await expireThrough(handle, confirmedStep)
    } catch {
      return false
    } finally {
      await handle.close().catch(() => {})
    }
  }

  // Whether the file the handle has open is still the one at the lock path.
  async function handleIsAtLockPath(handle: FileHandle) {
    try {
      const [opened, current] = await Promise.all([
        handle.stat({ bigint: true }),
        stat(lockPath, { bigint: true }),
      ])
      return opened.ino === current.ino && opened.dev === current.dev
    } catch {
      return false
    }
  }

  // Publishes a complete record of ours at the lock path, only if the path is
  // free. The record is written in full under a private name first and then
  // hard-linked to the lock path: link() fails if the path exists, and the
  // record is complete the moment the path names it. (Creating the lock path
  // itself with an exclusive open and then writing would leave an empty file
  // there for as long as this process paused between the two; a contender
  // would judge that file dead by its age, clear it, and take the lock while
  // this process still went on to report the lock as acquired.)
  async function publishRecord(): Promise<boolean> {
    const bytes = serializeLease(ownerId, now() + options.ttlMs)
    const stagedPath = `${lockPath}.${randomUUID()}.creating`
    await writeFile(stagedPath, bytes, { mode: 0o600, flag: 'wx' })
    try {
      await link(stagedPath, lockPath)
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') return false
      if (code && HARD_LINKS_UNSUPPORTED.has(code)) {
        // Without hard links, fall back to an exclusive create of the lock
        // path, which has the empty-file gap described above.
        await writeFile(lockPath, bytes, { mode: 0o600, flag: 'wx' })
        return true
      }
      throw error
    } finally {
      // Only the private name goes; the lock path keeps its own link.
      await rm(stagedPath, { force: true }).catch(() => {})
    }
  }

  async function tryAcquire() {
    try {
      return await publishRecord()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST' || code === 'EISDIR') return false
      if (code === 'ENOENT') {
        // Reboots can clear runtime temp directories before the next lock acquisition.
        await mkdir(dirname(lockPath), { recursive: true })
        try {
          return await publishRecord()
        } catch (retryError) {
          const retryCode = (retryError as NodeJS.ErrnoException).code
          if (retryCode === 'EEXIST' || retryCode === 'EISDIR') return false
          throw retryError
        }
      }
      throw error
    }
  }

  async function evictionMarkerExists() {
    try {
      await lstat(evictPath)
      return true
    } catch (error) {
      // Anything but a clear "not there" counts as there: fail closed.
      return (error as NodeJS.ErrnoException).code !== 'ENOENT'
    }
  }

  // An acquisition attempt made without holding the eviction marker. A lock
  // path can be empty because a contender holding the marker has just moved
  // a record off it to judge it, and that record may turn out to be live and
  // need to go back. A record created in that moment would keep it from going
  // back and admit this process beside the record's holder. So when a marker
  // exists right after our create, we give the new record up in place and
  // report the lock as not acquired; the caller tries again. This cannot help
  // when the contender's marker has already been taken from it and removed
  // by the time it moves the record.
  async function tryAcquireWithoutMarker() {
    if (!(await tryAcquire())) return false
    if (!(await evictionMarkerExists())) return true
    await expireOwnRecordAtPath()
    return false
  }

  async function backoff() {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.floor(Math.random() * 4)),
    )
  }

  async function leaseIsLiveAt(path: string) {
    try {
      const currentOwner = await readLeaseAt(path)
      return Number(currentOwner.expiresAt) > now()
    } catch {
      // Unreadable, including a record that fails its integrity check: judge
      // it by when it was last written, against our own ttlMs (the record
      // does not say what its writer's was).
      try {
        const current = await stat(path)
        return current.mtimeMs + options.ttlMs > now()
      } catch {
        // Lock doesn't exist — safe to acquire.
        return false
      }
    }
  }

  function lockIsLive() {
    return leaseIsLiveAt(lockPath)
  }

  // Clears an expired record off the lock path so the exclusive create can
  // succeed, and reports whether the path is now free. The record is renamed
  // to a private name first, which takes exactly the file at the path at that
  // instant, and liveness is judged on that file. If it is live (this
  // contender paused after its own liveness check, and someone's lease is
  // there now) it goes back with link(), which, unlike rename(), fails rather
  // than replace a record another contender created while the path was empty.
  // In that last case the displaced holder finds its record missing or
  // foreign at its next assertOwned or renewal and stops.
  async function reapExpiredLease() {
    const asidePath = `${lockPath}.${randomUUID()}.reaping`
    try {
      await rename(lockPath, asidePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      throw error
    }
    let live = true
    try {
      if (options.onStep) await options.onStep('stale-lock-moved-aside')
      live = await leaseIsLiveAt(asidePath)
    } finally {
      if (live) await restoreLease(asidePath)
      else await rm(asidePath, { recursive: true, force: true }).catch(() => {})
    }
    return !live
  }

  // Puts a live record back at the lock path. If it cannot go back, the record
  // stays under its private name: nothing reads it as the lock there, and its
  // holder finds its record gone at its next check. It is removed once it has
  // expired (see sweepLeftovers).
  async function restoreLease(asidePath: string) {
    try {
      if ((await lstat(asidePath)).isDirectory()) {
        // Directories cannot be hard-linked. A rename back fails over a lock
        // file or a non-empty lock directory, which is every lock a holder
        // has finished creating.
        await rename(asidePath, lockPath)
        return
      }
      await link(asidePath, lockPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      try {
        options.onRecordKeptAside?.({
          path: asidePath,
          lockPath,
          reason: code === 'EEXIST' ? 'lock-path-taken' : 'put-back-failed',
          error,
        })
      } catch {
        // The observer's errors must not change what the lock does.
      }
      return
    }
    // The record is back at the lock path; drop only the private second name.
    await rm(asidePath, { force: true }).catch(() => {})
  }

  // Removes leftovers of this lock that nothing will act on any more: records
  // kept aside after a failed put-back, and those left by processes that died
  // between renaming a record aside or writing a new one and finishing. Only
  // ones that are not live are removed, so a record kept aside stays until
  // its lease has run out. Each is a private name, never the lock path, so
  // removing it cannot touch the lock anyone holds.
  async function sweepLeftovers() {
    const directory = dirname(lockPath)
    const prefix = `${basename(lockPath)}.`
    let names: string[]
    try {
      names = await readdir(directory)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.startsWith(prefix)) continue
      if (!LEFTOVER_SUFFIX.test(name.slice(prefix.length))) continue
      const path = join(directory, name)
      if (await leaseIsLiveAt(path)) continue
      await rm(path, { recursive: true, force: true }).catch(() => {})
    }
  }

  async function evictionMarkerOwnerAt(path: string) {
    try {
      const owner = JSON.parse(
        await readFile(join(path, 'owner.json'), 'utf8'),
      ) as { ownerId?: unknown; createdAt?: unknown } | null
      return owner ?? undefined
    } catch {
      return undefined
    }
  }

  // Fail-closed: any read error means we do NOT own the marker.
  async function ownsEvictionMarker() {
    return (await evictionMarkerOwnerAt(evictPath))?.ownerId === evictOwnerId
  }

  // Whether a marker directory is younger than the marker lifetime, by its
  // mtime or by the creation time its owner recorded.
  async function evictionMarkerIsFreshAt(path: string) {
    let mtimeMs: number
    try {
      mtimeMs = (await stat(path)).mtimeMs
    } catch {
      return false
    }
    if (mtimeMs + EVICT_TTL > now()) return true
    const createdAt = (await evictionMarkerOwnerAt(path))?.createdAt
    return typeof createdAt === 'number' && createdAt + EVICT_TTL > now()
  }

  // Returns a marker this process moved aside to the marker path. rename()
  // replaces an empty directory, so it is only tried when nothing is at the
  // marker path. If something is, the marker aside has been superseded: its
  // owner already finds the marker path not its own, so it is removed.
  async function putEvictionMarkerBack(asidePath: string) {
    try {
      await lstat(evictPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          await rename(asidePath, evictPath)
          return
        } catch {
          // Taken meanwhile; fall through and remove ours.
        }
      }
    }
    await rm(asidePath, { recursive: true, force: true }).catch(() => {})
  }

  // Removes our marker. The marker is moved to a private name first and its
  // owner read there, so the directory removed is the one verified as ours;
  // checking the marker path and then removing it by path could remove a
  // newer marker that replaced ours in between. One that turns out not to be
  // ours goes back.
  async function releaseEvictionMarker() {
    if (!(await ownsEvictionMarker())) return
    const asidePath = `${evictPath}.${randomUUID()}.releasing`
    try {
      await rename(evictPath, asidePath)
    } catch {
      return
    }
    if ((await evictionMarkerOwnerAt(asidePath))?.ownerId === evictOwnerId) {
      await rm(asidePath, { recursive: true, force: true }).catch(() => {})
      return
    }
    await putEvictionMarkerBack(asidePath)
  }

  async function tryAcquireEvictionMarker() {
    await mkdir(evictPath)
    try {
      await writeFile(
        evictOwnerPath,
        `${JSON.stringify({ ownerId: evictOwnerId, createdAt: now() })}\n`,
        { encoding: 'utf8', mode: 0o600, flag: 'wx' },
      )
    } catch (error) {
      // A competing contender can rename our just-created marker directory
      // away between the mkdir above and this write (the stale-marker steal
      // path below does exactly that). That is a lost race, not a failure, so
      // report it as such and let the caller back off and retry rather than
      // failing the whole lock acquisition.
      if (isLostMarkerRaceError(error)) return false
      await releaseEvictionMarker()
      throw error
    }
    if (options.onStep) await options.onStep('eviction-marker-acquired')
    return true
  }

  // Takes away a marker older than the marker lifetime, whose owner is taken
  // to have stalled or died. The marker is judged by stat and then renamed,
  // and a pause in between can let a newer marker replace the stale one, so
  // the marker actually renamed is judged again; a fresh one goes back and
  // the attempt counts as having found a fresh marker.
  async function recoverStaleEvictionMarker(): Promise<
    'fresh' | 'missing' | 'recovered'
  > {
    let evictStat: Awaited<ReturnType<typeof stat>>
    try {
      evictStat = await stat(evictPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
      throw error
    }
    if (evictStat.mtimeMs + EVICT_TTL > now()) return 'fresh'

    if (options.onStep) await options.onStep('stale-marker-stat')
    const claimedPath = `${evictPath}.${randomUUID()}`
    try {
      await rename(evictPath, claimedPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
      throw error
    }
    if (await evictionMarkerIsFreshAt(claimedPath)) {
      await putEvictionMarkerBack(claimedPath)
      return 'fresh'
    }
    if (options.onStep) await options.onStep('stale-marker-claimed')
    await rm(claimedPath, { recursive: true, force: true }).catch(() => {})
    return 'recovered'
  }

  async function withEvictionMarker(action: () => Promise<void>) {
    try {
      if (!(await tryAcquireEvictionMarker())) return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }

    try {
      await action()
    } finally {
      await releaseEvictionMarker()
    }
    return true
  }

  // One renewal under the eviction marker. Every check and the write go
  // through the one handle, so the write lands in the file whose owner id was
  // checked, whatever the lock path holds by then. Returns false when renewal
  // must stop.
  async function renewThrough(handle: FileHandle): Promise<boolean> {
    const { record: owner } = await readLeaseThrough(handle)
    const currentNow = now()
    if (released || loss) return false
    if (owner.ownerId !== ownerId) {
      recordLoss('taken-over', owner)
      return false
    }
    // An expired lease is no longer ours to extend; a contender may
    // already be eligible to acquire it.
    if (!(Number(owner.expiresAt) > currentNow)) {
      recordLoss('expired', owner)
      return false
    }
    if (options.onStep) await options.onStep('renewal-owner-confirmed')
    if (released || loss) return false
    if (!(await ownsEvictionMarker())) return true
    if (options.onStep) await options.onStep('renewal-write-fenced')
    if (released || loss) return false
    if (!(await ownsEvictionMarker())) return true
    // Read once more right before the write: a pause above may have
    // outlived the lease, and a lapsed lease must not be revived.
    const { record: latest, size } = await readLeaseThrough(handle)
    if (latest.ownerId !== ownerId) {
      recordLoss('taken-over', latest)
      return false
    }
    if (!(Number(latest.expiresAt) > now())) {
      recordLoss('expired', latest)
      return false
    }
    if (options.onStep) await options.onStep('renewal-write-ready')
    if (released || loss) return false
    await writeLeaseThrough(handle, now() + options.ttlMs, size)
    // The write went into the file whose owner id and expiry we had just
    // checked, so losing the marker meanwhile changes nothing about what we
    // wrote. What matters is whether that file is still the one at the lock
    // path: if it is, the lease stands as written (giving it up here would
    // let a successor in while the caller is still working); if it is not,
    // someone has taken the lock.
    const markerKept = await ownsEvictionMarker()
    if (!(await handleIsAtLockPath(handle))) {
      if (markerKept)
        recordLoss('taken-over', await readOwner().catch(() => undefined))
      else recordLoss('marker-lost')
      return false
    }
    if (!markerKept && options.onStep)
      await options.onStep('renewal-marker-lost')
    return true
  }

  function scheduleRenewal() {
    if (!options.renew || released || loss) return
    const intervalMs =
      options.renewIntervalMs ?? Math.max(1_000, Math.floor(options.ttlMs / 3))
    renewTimer = setRefreshLockRenewalTimeout(() => {
      const renewal = (async () => {
        let shouldReschedule = !released
        try {
          const markerAcquired = await withEvictionMarker(async () => {
            const handle = await open(lockPath, 'r+')
            try {
              if (!(await renewThrough(handle))) shouldReschedule = false
            } finally {
              await handle.close().catch(() => {})
            }
          })
          if (!markerAcquired && options.onStep) {
            await options.onStep('renewal-marker-unavailable')
          }
        } catch {
          // Retry transient failures only while the lease can still be verified.
          try {
            const owner = await readOwner()
            if (owner.ownerId !== ownerId) recordLoss('taken-over', owner)
            else if (!(Number(owner.expiresAt) > now()))
              recordLoss('expired', owner)
          } catch {
            recordLoss('renewal-failed')
          }
        } finally {
          if (options.onStep) {
            try {
              await options.onStep('renewal-finished')
            } catch {
              // Errors from the onStep observer must not reject the renewal.
            }
          }
          if (shouldReschedule && !released && !loss) scheduleRenewal()
        }
      })()
      renewalInFlight = renewal
      void renewal.finally(() => {
        if (renewalInFlight === renewal) renewalInFlight = null
      })
    }, intervalMs)
    if ('unref' in renewTimer) renewTimer.unref()
  }

  let acquired = await tryAcquireWithoutMarker()
  if (!acquired) {
    for (let attempt = 0; attempt < MAX_STEAL_ATTEMPTS; attempt++) {
      acquired = await tryAcquireWithoutMarker()
      if (acquired) break
      if (await lockIsLive()) return null

      try {
        if (!(await tryAcquireEvictionMarker())) {
          await backoff()
          continue
        }
      } catch (evictError) {
        const code = (evictError as NodeJS.ErrnoException).code
        if (code !== 'EEXIST') throw evictError

        const recovered = await recoverStaleEvictionMarker()
        if (recovered === 'fresh') return null
        await backoff()
        continue
      }

      try {
        if (await lockIsLive()) return null
        // Verify marker ownership before removing a lock found not live.
        if (!(await ownsEvictionMarker())) return null
        if (options.onStep) await options.onStep('stale-lock-confirmed')
        // The onStep callback can pause while another contender renames
        // our marker, so verify ownership again after the callback.
        if (!(await ownsEvictionMarker())) return null
        if (!(await reapExpiredLease())) return null
        await sweepLeftovers()
        // Fence check 3: re-verify ownership after removing the stale lock.
        if (!(await ownsEvictionMarker())) return null
        acquired = await tryAcquire()
        if (!acquired) return null
        // Fence check 4: re-verify ownership after acquiring the lock. If the
        // marker was stolen between tryAcquire and this check, give up the
        // just-acquired lease and return null (fail-closed). Expiring it in
        // place rather than deleting the path cannot touch anyone else's.
        if (!(await ownsEvictionMarker())) {
          await expireOwnRecordAtPath()
          acquired = false
          return null
        }
        break
      } finally {
        await releaseEvictionMarker()
      }
    }
  }

  if (!acquired) return null

  scheduleRenewal()

  return {
    ownerId,
    whenLost: () => lostPromise,
    hasLost: () => loss !== undefined,
    assertOwned: async () => {
      let observed: { ownerId?: unknown; expiresAt?: unknown } | undefined
      try {
        // A read overlapping our own in-place renewal write could see a mix
        // of its old and new bytes; wait for the write, and read again once
        // if the record still does not verify (a renewal can start between
        // the wait and the read).
        while (writeInFlight) await writeInFlight
        let owner: LeaseRecord
        try {
          owner = await readOwner()
        } catch (error) {
          if (!isIntegrityFailure(error)) throw error
          while (writeInFlight) await writeInFlight
          owner = await readOwner()
        }
        observed = owner
        if (
          !released &&
          !loss &&
          owner?.ownerId === ownerId &&
          Number(owner?.expiresAt) > now()
        )
          return
        recordLoss(owner?.ownerId !== ownerId ? 'taken-over' : 'expired', owner)
      } catch {
        // Unreadable ownership is not evidence of a valid lease.
        recordLoss('unreadable')
      }
      throw new LockOwnershipError({
        target: options.path,
        name: options.name,
        expectedOwnerId: ownerId,
        ...(typeof observed?.ownerId === 'string'
          ? { observedOwnerId: observed.ownerId }
          : {}),
        ...(typeof observed?.expiresAt === 'number'
          ? { observedExpiresAt: observed.expiresAt }
          : {}),
      })
    },
    release: async () => {
      released = true
      if (renewTimer) {
        clearRefreshLockRenewalTimeout(renewTimer)
        renewTimer = null
      }
      await renewalInFlight
      // Give the lease up in place, through a handle on which our own owner id
      // was just read. That needs no marker and cannot touch a successor's
      // record, and from then on any contender may take the lock. The expired
      // record stays at the path for the next contender to clear: removing it
      // here would mean renaming or deleting whatever the path names by then,
      // and that may already be a successor's record.
      await expireOwnRecordAtPath('release-owner-confirmed')
    },
  }
}
