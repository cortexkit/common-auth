import { type PoolOperation, PoolOperationError } from './errors.js'
import {
  notReadyError,
  type ReadResult,
  readPool,
  type StoreContext,
} from './mutate.js'
import type { PoolLockOptions, PoolLockSpec } from './refresh-lock.js'
import { type PoolRow, rowLockKey } from './schema.js'

/** Where a pull was fired from; `load` fires at most once per process per row. */
export type PullReason = 'load' | 'add' | 'replace' | 'admission'

/** What every operation module shares. */
export interface StoreRuntime {
  ctx: StoreContext
  providerLock: PoolLockSpec
  rowLockOptions: Partial<PoolLockOptions>
  firePull(id: string, reason: PullReason): void
}

/**
 * The row lock's (name, path): keyed by the row's recorded wire identity when
 * known, else its local id, beside the state file. The key is prefixed and
 * URL-encoded so it can never name a store lock or leave the directory.
 */
export function rowLockSpec(
  rt: StoreRuntime,
  row: Pick<PoolRow, 'id' | 'identity'>,
): PoolLockSpec {
  return {
    ...rt.rowLockOptions,
    name: `row-${encodeURIComponent(rowLockKey(row))}`,
    path: rt.ctx.statePath,
  }
}

/** An unlocked read that must find a ready pool holding the row. */
export async function readRow(
  rt: StoreRuntime,
  operation: PoolOperation,
  id: string,
): Promise<{ result: Extract<ReadResult, { status: 'ready' }>; row: PoolRow }> {
  const result = await readPool(rt.ctx)
  if (result.status !== 'ready') throw notReadyError(result, operation, id)
  const row = result.rows.find((candidate) => candidate.id === id)
  if (!row) throw unknownRow(operation, id)
  return { result, row }
}

export function unknownRow(
  operation: PoolOperation,
  id: string,
): PoolOperationError {
  return new PoolOperationError({
    operation,
    rowId: id,
    phase: operation === 'pull' ? 'pull' : 'before-first-write',
    retryable: false,
    kind: 'unknown-row',
    message: `no row ${id} in the pool`,
  })
}

export function refusal(
  operation: PoolOperation,
  id: string,
  kind: PoolOperationError['kind'],
  message: string,
  retryable = false,
): PoolOperationError {
  return new PoolOperationError({
    operation,
    rowId: id,
    phase: operation === 'pull' ? 'pull' : 'before-first-write',
    retryable,
    kind,
    message,
  })
}
