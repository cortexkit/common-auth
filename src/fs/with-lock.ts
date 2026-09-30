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

export class LockOwnershipError extends Error {
  readonly details: { target: string; name: string }
  constructor(details: { target: string; name: string }) {
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
