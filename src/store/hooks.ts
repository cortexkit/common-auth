import { AsyncLocalStorage } from 'node:async_hooks'
import { type PoolOperation, PoolReentryError } from './errors.js'

/**
 * Set while a store hook runs, recording whether its store locks are released.
 * Async context is inherited by every timer, promise and continuation inside the hook,
 * so work a hook schedules is inside the guarded region too.
 */
const insideHook = new AsyncLocalStorage<{
  operation: PoolOperation
  storeLocksReleased: boolean
}>()
const insideCodec = new AsyncLocalStorage<boolean>()

/** Refuses a row operation or refresh called from inside a hook. */
export function assertNotInsideHook(operation: PoolOperation): void {
  if (insideHook.getStore() !== undefined) throw new PoolReentryError(operation)
}

/** Namespace writes need only the store locks, not the row lock a hook may retain. */
export function assertLimitsWriteAllowed(): void {
  if (
    insideHook.getStore()?.storeLocksReleased === false ||
    insideCodec.getStore()
  )
    throw new PoolReentryError('updateLimitsNamespace')
}

/** Codecs may run under store locks even when no asynchronous hook is active. */
export function runInsideCodec<T>(fn: () => T): T {
  return insideCodec.run(true, fn)
}

export function runInsideHook<T>(
  operation: PoolOperation,
  fn: () => Promise<T> | T,
  storeLocksReleased = false,
): Promise<T> {
  return insideHook.run(
    {
      operation,
      storeLocksReleased:
        storeLocksReleased &&
        insideHook.getStore()?.storeLocksReleased !== false,
    },
    async () => await fn(),
  )
}

export interface PoolLogger {
  warn(message: string, data?: unknown): void
}

/**
 * Runs a failure hook. A hook that throws never replaces the failure it was
 * handed: its exception is logged and discarded.
 */
export async function callFailureHook<E, R extends string | undefined>(
  operation: PoolOperation,
  hook: ((rowId: R, error: E) => void | Promise<void>) | undefined,
  rowId: R,
  error: E,
  logger: PoolLogger | undefined,
): Promise<void> {
  if (!hook) return
  try {
    await runInsideHook(operation, () => hook(rowId, error), true)
  } catch (hookError) {
    logger?.warn('store failure hook threw; the original failure stands', {
      operation,
      rowId,
      error: hookError instanceof Error ? hookError.message : String(hookError),
    })
  }
}
