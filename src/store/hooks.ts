import { AsyncLocalStorage } from 'node:async_hooks'
import { type PoolOperation, PoolReentryError } from './errors.js'

/**
 * Set while a hook of a lock-holding operation runs. Async context is
 * inherited by every timer, promise and continuation created inside the hook,
 * so work a hook schedules is inside the guarded region too.
 */
const insideHook = new AsyncLocalStorage<PoolOperation>()

/** Refuses a row operation or refresh called from inside a hook. */
export function assertNotInsideHook(operation: PoolOperation): void {
  if (insideHook.getStore() !== undefined) throw new PoolReentryError(operation)
}

export function runInsideHook<T>(
  operation: PoolOperation,
  fn: () => Promise<T> | T,
): Promise<T> {
  return insideHook.run(operation, async () => await fn())
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
    await runInsideHook(operation, () => hook(rowId, error))
  } catch (hookError) {
    logger?.warn('store failure hook threw; the original failure stands', {
      operation,
      rowId,
      error: hookError instanceof Error ? hookError.message : String(hookError),
    })
  }
}
