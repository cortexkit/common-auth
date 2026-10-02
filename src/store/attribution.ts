import { PoolOperationError } from './errors.js'
import { type Progress, toFailure, withTransaction } from './mutate.js'
import { LockStack } from './refresh-lock.js'
import {
  refusal,
  requireBound,
  type StoreRuntime,
  unknownRow,
} from './runtime.js'
import { isCredentialEpoch } from './schema.js'

/**
 * What a pull or refresh captured about its row (named by id alongside) when
 * it was issued. A result applies only while the row with that id still has
 * this credential epoch and this recorded identity; a replaced credential bumps the epoch, so work issued
 * for the old one is discarded.
 */
export interface Attribution {
  credentialEpoch: number
  identity?: string
}

/**
 * Merges a quota observation into a row's stored map under the store locks,
 * after attribution passes. Needs no row lock, so it is permitted from
 * inside hooks. Clears needs-first-reading on success.
 */
export async function recordQuota(
  rt: StoreRuntime,
  id: string,
  attribution: Attribution,
  observation: unknown,
): Promise<void> {
  const { ctx } = rt
  const locks = new LockStack(ctx.lockDefaults, ctx.lockEnv)
  const progress: Progress = { writes: 0 }
  try {
    if (!isCredentialEpoch(attribution?.credentialEpoch))
      throw refusal(
        'pull',
        id,
        'invalid-input',
        'the credential epoch the reading was issued for must be a positive safe integer',
      )
    await withTransaction(
      ctx,
      locks,
      progress,
      { operation: 'pull', rowId: id },
      async (tx) => {
        const row = tx.row(id)
        if (!row) throw unknownRow('pull', id)
        if (row.invalid)
          throw refusal('pull', id, 'invalid-row', `row ${id} is invalid`)
        // A reading belongs to one (epoch, identity, credential). A row
        // holding no credential, or torn between the writes of a replace,
        // has no such triple on disk, so no reading is recorded for it.
        if (!row.credential)
          throw refusal(
            'pull',
            id,
            'no-credential',
            `row ${id} holds no credential`,
          )
        requireBound('pull', row)
        const entry = tx.entry(id)
        if (
          row.torn ||
          !entry ||
          entry.credentialEpoch !== attribution.credentialEpoch ||
          row.identity !== attribution.identity
        )
          throw new PoolOperationError({
            operation: 'pull',
            rowId: id,
            phase: 'pull',
            retryable: true,
            kind: 'attribution',
            message: `quota for ${id} was issued for a credential the row no longer holds`,
          })
        const merged = ctx.codec.merge(entry.quota, observation)
        if (!ctx.codec.validate(merged))
          throw refusal(
            'pull',
            id,
            'invalid-quota',
            'the quota codec rejected the merged map',
          )
        tx.setEntry(id, { ...entry, quota: merged, needsFirstReading: false })
        await tx.commitConfig()
      },
      // Recording a reading never completes a torn row: the fence above
      // refuses it, and the row's own next write completes it.
      { completeTorn: false },
    )
  } catch (error) {
    throw toFailure(error, 'pull', id, progress)
  } finally {
    await locks.releaseAll()
  }
}
