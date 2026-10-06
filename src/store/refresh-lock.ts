import { acquireRefreshFileLock } from '../fs/refresh-file-lock.js'
import { LockContentionError } from '../fs/with-lock.js'

type LockStep =
  NonNullable<Parameters<typeof acquireRefreshFileLock>[0]['onStep']> extends (
    step: infer S,
  ) => unknown
    ? S
    : never

/** Tuning shared by every lock the store takes; each field is overridable. */
export interface PoolLockOptions {
  ttlMs: number
  timeoutMs: number
  retryMs: number
  renew: boolean
  renewIntervalMs?: number
}

/** A lock: the (name, path) pair naming its file plus optional tuning. */
export interface PoolLockSpec extends Partial<PoolLockOptions> {
  name: string
  path: string
}

/**
 * Store lock defaults: a 15 000 ms bounded wait retried every 50 ms plus
 * jitter, and a renewed 10 000 ms lease.
 */
export const POOL_LOCK_DEFAULTS: Readonly<PoolLockOptions> = Object.freeze({
  ttlMs: 10_000,
  timeoutMs: 15_000,
  retryMs: 50,
  renew: true,
})

export type LockEvent = {
  type: 'acquired' | 'released' | 'contended'
  name: string
  path: string
}

export interface LockEnvironment {
  now: () => number
  onLockEvent?: (event: LockEvent) => void
  onLockStep?: (
    lock: { name: string; path: string },
    step: LockStep,
  ) => void | Promise<void>
}

export interface HeldLock {
  readonly name: string
  readonly path: string
  assertOwned(): Promise<void>
  release(): Promise<void>
}

/**
 * Takes one lock, retrying while a live holder has it until `timeoutMs` has
 * passed on the real clock, then throws `LockContentionError`. The lease is
 * asserted as owned once acquired, so a caller never proceeds on a lease that
 * expired during the wait.
 */
export async function acquirePoolLock(
  spec: PoolLockSpec,
  defaults: PoolLockOptions,
  env: LockEnvironment,
): Promise<HeldLock> {
  const emit = (type: LockEvent['type']) => {
    try {
      const result: unknown = env.onLockEvent?.({
        type,
        name: spec.name,
        path: spec.path,
      })
      if (
        result &&
        (typeof result === 'object' || typeof result === 'function') &&
        'then' in result &&
        typeof result.then === 'function'
      ) {
        void Promise.resolve(result).catch(() => {})
      }
    } catch {
      // Lock observers must not affect acquisition or release.
    }
  }
  const options = { ...defaults, ...definedOnly(spec) }
  const started = performance.now()
  for (;;) {
    const lock = await acquireRefreshFileLock({
      name: spec.name,
      path: spec.path,
      ttlMs: options.ttlMs,
      now: env.now,
      renew: options.renew,
      onContended: () => emit('contended'),
      ...(options.renewIntervalMs !== undefined
        ? { renewIntervalMs: options.renewIntervalMs }
        : {}),
      ...(env.onLockStep
        ? {
            onStep: (step: LockStep) =>
              env.onLockStep?.({ name: spec.name, path: spec.path }, step),
          }
        : {}),
    })
    if (lock) {
      emit('acquired')
      const held: HeldLock = {
        name: spec.name,
        path: spec.path,
        assertOwned: () => lock.assertOwned(),
        release: async () => {
          await lock.release()
          emit('released')
        },
      }
      try {
        await held.assertOwned()
      } catch (error) {
        await held.release()
        throw error
      }
      return held
    }
    const remaining = options.timeoutMs - (performance.now() - started)
    if (remaining <= 0) {
      throw new LockContentionError({
        target: spec.path,
        name: spec.name,
        timeoutMs: options.timeoutMs,
      })
    }
    const jitter = Math.floor(Math.random() * (options.retryMs + 1))
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(options.retryMs + jitter, remaining)),
    )
  }
}

function definedOnly(spec: PoolLockSpec): Partial<PoolLockOptions> {
  const out: Partial<PoolLockOptions> = {}
  if (spec.ttlMs !== undefined) out.ttlMs = spec.ttlMs
  if (spec.timeoutMs !== undefined) out.timeoutMs = spec.timeoutMs
  if (spec.retryMs !== undefined) out.retryMs = spec.retryMs
  if (spec.renew !== undefined) out.renew = spec.renew
  if (spec.renewIntervalMs !== undefined)
    out.renewIntervalMs = spec.renewIntervalMs
  return out
}

/**
 * Locks taken in order and released in reverse. Every acquisition re-asserts
 * the leases already held, because a wait is exactly when an earlier lease
 * can expire unnoticed.
 */
export class LockStack {
  readonly held: HeldLock[] = []

  constructor(
    private readonly defaults: PoolLockOptions,
    private readonly env: LockEnvironment,
  ) {}

  async acquire(spec: PoolLockSpec): Promise<HeldLock> {
    const lock = await acquirePoolLock(spec, this.defaults, this.env)
    this.held.push(lock)
    await this.assertAll()
    return lock
  }

  async assertAll(): Promise<void> {
    for (const lock of this.held) await lock.assertOwned()
  }

  /** Releases every lock taken after `mark` (a length of `held`), newest first. */
  async releaseTo(mark: number): Promise<void> {
    while (this.held.length > mark) {
      const lock = this.held.pop()
      await lock?.release().catch(() => {})
    }
  }

  async releaseAll(): Promise<void> {
    await this.releaseTo(0)
  }
}
