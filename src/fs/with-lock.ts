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
}

/**
 * Runs `fn` while holding the lock named `options.name` on `target`, waiting
 * up to `options.timeoutMs` for it, and releases the lock when `fn` settles.
 *
 * withLock does not check ownership for you. The lock is a lease: if this
 * process stalls past `ttlMs` (a starved event loop, a slow disk) another
 * process may take the lock while `fn` is still running. A caller that commits
 * a write inside `fn` must call `lock.assertOwned()` immediately before the
 * commit (for example as `writeJsonAtomic`'s `beforeRename`) and abandon the
 * write when it throws. Nothing is checked after `fn` returns, because by then
 * the work is already done.
 */
export async function withLock<T>(
  target: string,
  options: LockOptions,
  fn: (lock: { assertOwned(): Promise<void> }) => Promise<T>,
): Promise<T> {
  const started = performance.now()
  for (;;) {
    const lock = await acquireRefreshFileLock({
      path: target,
      name: options.name,
      ttlMs: options.ttlMs,
      renew: options.renew ?? false,
    })
    if (lock) {
      try {
        return await fn(lock)
      } finally {
        await lock.release()
      }
    }
    const remaining = options.timeoutMs - (performance.now() - started)
    if (remaining <= 0) {
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
