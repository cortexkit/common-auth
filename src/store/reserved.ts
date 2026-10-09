import { type PoolOperation, PoolOperationError } from './errors.js'

/** A stored marker reserves the row even when the rest of its entry is invalid. */
export function assertNotReserved(
  operation: PoolOperation,
  id: string,
  reservation: unknown,
): void {
  if (reservation !== undefined)
    throw new PoolOperationError({
      operation,
      rowId: id,
      kind: 'row-staged',
      phase: operation === 'pull' ? 'pull' : 'before-first-write',
      retryable: false,
      message: `row ${id} is reserved for roster publication`,
    })
}
