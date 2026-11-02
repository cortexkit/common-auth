import { join, resolve } from 'node:path'
import {
  isWindowsSharingViolation,
  type PrivateFileError,
} from './private-files.js'
import { acquireRefreshFileLock } from './refresh-file-lock.js'

export function lockPathFor(target: string, name: string): string {
  return `${target}.${name}.lock`
}

export class LockContentionError extends Error {
  readonly details: { target: string; name: string; timeoutMs: number }
  constructor(details: { target: string; name: string; timeoutMs: number }) {
    super(`Timed out acquiring ${details.name} lock for ${details.target}`)
    this.name = 'LockContentionError'
    this.details = details
  }
}

export interface LockOwnershipDetails {
  target: string
  name: string
  expectedOwnerId?: string
  observedOwnerId?: string
  observedExpiresAt?: number
}

export class LockOwnershipError extends Error {
  readonly details: LockOwnershipDetails
  constructor(details: LockOwnershipDetails) {
    super(`Lost ${details.name} lock for ${details.target}`)
    this.name = 'LockOwnershipError'
    this.details = details
  }
}

export interface LockOptions {
  name: string
  ttlMs: number
  timeoutMs: number
  renew?: boolean
  signal?: AbortSignal
  onStep?: Parameters<typeof acquireRefreshFileLock>[0]['onStep']
  onRenewalTimer?: Parameters<
    typeof acquireRefreshFileLock
  >[0]['onRenewalTimer']
}

function isChangingLockRead(
  error: unknown,
  target: string,
  name: string,
): error is PrivateFileError {
  if (
    !isWindowsSharingViolation(error) ||
    (error.stage !== 'read' && error.stage !== 'verify')
  )
    return false
  const path = resolve(lockPathFor(target, name))
  return error.path === path || error.path === join(path, 'owner.json')
}

export async function withLock<T>(
  target: string,
  options: LockOptions,
  fn: (lock: { assertOwned(): Promise<void> }) => Promise<T>,
): Promise<T> {
  const started = performance.now()
  for (;;) {
    options.signal?.throwIfAborted()
    let lock: Awaited<ReturnType<typeof acquireRefreshFileLock>>
    let changingReadError: PrivateFileError | undefined
    try {
      lock = await acquireRefreshFileLock({
        path: target,
        name: options.name,
        ttlMs: options.ttlMs,
        renew: options.renew ?? false,
        ...(options.onStep ? { onStep: options.onStep } : {}),
        ...(options.onRenewalTimer
          ? { onRenewalTimer: options.onRenewalTimer }
          : {}),
      })
    } catch (error) {
      if (!isChangingLockRead(error, target, options.name)) throw error
      // Sharing violations (32) and delete-pending opens (303) do not reveal
      // ownership or expiry. Retry exclusive creation, never infer a stale lock.
      lock = null
      changingReadError = error
    }
    if (lock) {
      try {
        options.signal?.throwIfAborted()
        return await fn(lock)
      } finally {
        await lock.release(options.signal)
      }
    }
    const remaining = options.timeoutMs - (performance.now() - started)
    if (remaining <= 0) {
      // Keep persistent native IO failures distinguishable from a live holder.
      if (changingReadError) throw changingReadError
      throw new LockContentionError({
        target,
        name: options.name,
        timeoutMs: options.timeoutMs,
      })
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(25, Math.ceil(remaining))),
    )
  }
}
