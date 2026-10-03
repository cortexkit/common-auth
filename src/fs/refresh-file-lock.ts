import { createHash, randomUUID } from 'node:crypto'
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
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
// - A contender clears an expired record by renaming it to a private name and
//   judging that file, which is no longer reachable by the lock path; if it
//   turns out to be live, it goes back with link(), which fails instead of
//   replacing a record created meanwhile.
// - Every record has the same length, so an in-place rewrite is one write of
//   the same size and the file never has a moment at another length. Each
//   record also carries a short hash of its owner id and expiry (`check`). A
//   read that overlaps an in-place write could in principle see some old and
//   some new bytes: POSIX makes read() and write() on a regular file atomic
//   with respect to each other only between threads, and Linux's buffered
//   reads do not take the lock that writes take, so this is not relied on.
//   A record whose hash does not match is treated as unreadable, which every
//   reader already handles: contenders fall back to the file's mtime, and an
//   owner's assertOwned fails closed. Releases before this one ignore the
//   field and read `ownerId` and `expiresAt` as before; the padding is JSON
//   whitespace.
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

/**
 * Parses a lease record and verifies its `check` when it has one. Records
 * written before the field existed have none and are read as they always were.
 * Throws, like a JSON syntax error, when the check does not match.
 */
function parseLease(text: string): LeaseRecord {
  const record: unknown = JSON.parse(text)
  if (record === null || typeof record !== 'object') return {}
  const lease = record as LeaseRecord
  if (
    'check' in lease &&
    lease.check !== leaseCheck(lease.ownerId, lease.expiresAt)
  )
    throw new Error('Lease record failed its integrity check')
  return lease
}

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
  async function writeLeaseThrough(
    handle: FileHandle,
    expiresAt: number,
    size: number,
  ) {
    const bytes = serializeLease(ownerId, expiresAt)
    await handle.write(bytes, 0, bytes.length, 0)
    if (size > bytes.length) await handle.truncate(bytes.length)
  }

  // Gives up our lease in the file the handle has open: if the record there is
  // ours, its expiry moves into the past so a contender may take the lock at
  // once. A record that is not ours is left exactly as it is.
  async function expireThrough(handle: FileHandle) {
    const { record, size } = await readLeaseThrough(handle)
    if (record.ownerId !== ownerId) return false
    await writeLeaseThrough(handle, RELEASED_EXPIRES_AT, size)
    return true
  }

  // Expires the record now at the lock path if, read through the opened file,
  // it is ours. Reports whether it was.
  async function expireOwnRecordAtPath() {
    let handle: FileHandle
    try {
      handle = await open(lockPath, 'r+')
    } catch {
      // Missing, or a legacy directory: there is no record of ours to expire.
      return false
    }
    try {
      return await expireThrough(handle)
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

  async function tryAcquire() {
    try {
      await writeFile(
        lockPath,
        serializeLease(ownerId, now() + options.ttlMs),
        { mode: 0o600, flag: 'wx' },
      )
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST' || code === 'EISDIR') return false
      if (code === 'ENOENT') {
        // Reboots can clear runtime temp directories before the next lock acquisition.
        await mkdir(dirname(lockPath), { recursive: true })
        try {
          await writeFile(
            lockPath,
            serializeLease(ownerId, now() + options.ttlMs),
            { mode: 0o600, flag: 'wx' },
          )
          return true
        } catch (retryError) {
          const retryCode = (retryError as NodeJS.ErrnoException).code
          if (retryCode === 'EEXIST' || retryCode === 'EISDIR') return false
          throw retryError
        }
      }
      throw error
    }
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
      // it by when it was last written.
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
      await rm(asidePath, { recursive: true, force: true }).catch(() => {})
    }
    return !live
  }

  async function restoreLease(asidePath: string) {
    try {
      if ((await lstat(asidePath)).isDirectory()) {
        // Directories cannot be hard-linked. A rename back fails over a lock
        // file or a non-empty lock directory, which is every lock a holder
        // has finished creating.
        await rename(asidePath, lockPath)
      } else {
        await link(asidePath, lockPath)
      }
    } catch {
      // Someone created a lock while the path was empty; theirs stands.
    }
  }

  // Fail-closed: any read error means we do NOT own the marker.
  async function ownsEvictionMarker() {
    try {
      const owner = JSON.parse(await readFile(evictOwnerPath, 'utf8'))
      return owner?.ownerId === evictOwnerId
    } catch {
      return false
    }
  }

  async function releaseEvictionMarker() {
    if (await ownsEvictionMarker()) {
      await rm(evictPath, { recursive: true, force: true }).catch(() => {})
    }
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

  // Losing the eviction marker around a renewal write means another process
  // judged this holder stalled. Having stopped claiming the lease, expire our
  // own record so contenders need not wait for it to run out. This goes
  // through the renewal's handle: if a successor has replaced the record at
  // the path, the handle holds our discarded file and the successor's record
  // is never read, rewritten or removed.
  async function relinquishThrough(handle: FileHandle) {
    if (options.onStep) await options.onStep('relinquish-read')
    await expireThrough(handle).catch(() => false)
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
    if (!(await ownsEvictionMarker())) {
      recordLoss('marker-lost')
      await relinquishThrough(handle)
      return false
    }
    // Someone that takes no eviction marker (an older release, for one) may
    // have put another file at the path while we wrote; our write then went
    // to a file nobody reads. Notice now rather than at the next renewal.
    if (!(await handleIsAtLockPath(handle))) {
      recordLoss('taken-over', await readOwner().catch(() => undefined))
      return false
    }
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

  let acquired = await tryAcquire()
  if (!acquired) {
    for (let attempt = 0; attempt < MAX_STEAL_ATTEMPTS; attempt++) {
      acquired = await tryAcquire()
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
        const owner = await readOwner()
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
      // Give the lease up first, in place, through a handle on which our own
      // owner id was just read. That needs no marker and cannot touch a
      // successor's record, and from then on any contender may take the lock.
      if (!(await expireOwnRecordAtPath())) return
      // Then clear the expired record off the path so the next acquirer need
      // not. Clearing goes through the same rename-aside-and-judge step a
      // contender uses, so a release that stalls here and resumes after a
      // successor took the lock puts the successor's record back.
      for (let attempt = 0; attempt < MAX_STEAL_ATTEMPTS; attempt++) {
        try {
          const markerAcquired = await withEvictionMarker(async () => {
            if (options.onStep) await options.onStep('release-owner-confirmed')
            if (!(await ownsEvictionMarker())) return
            await reapExpiredLease()
          })
          if (markerAcquired) return
          await recoverStaleEvictionMarker()
        } catch {
          return
        }
        await backoff()
      }
      // Without the marker the expired record stays; contenders clear it.
    },
  }
}
