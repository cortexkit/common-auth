import type { Transaction } from './mutate.js'
import type { PoolRow } from './schema.js'

/** The reason recorded on a row disabled because an earlier row is the same account. */
export const DUPLICATE_IDENTITY_REASON = 'duplicate-identity'

/**
 * Enabled OAuth rows holding a credential whose wire identity is not yet
 * known. API-key rows and disabled rows never count.
 */
export function countUnknownIdentityRows(rows: readonly PoolRow[]): number {
  return rows.filter(
    (row) =>
      row.invalid === undefined &&
      row.type === 'oauth' &&
      row.enabled &&
      row.credential !== undefined &&
      row.identity === undefined,
  ).length
}

/**
 * Marks a row disabled with a reason: `enabled: false` in the roster row,
 * which older readers honour, and the reason in the per-row entry. A row
 * without an entry gets one at epoch 1. Nothing is ever deleted.
 */
export function disableIn(tx: Transaction, id: string, reason: string): void {
  const raw = tx.rosterRow(id)
  if (!raw) return
  raw.enabled = false
  const entry = tx.entry(id) ?? { credentialEpoch: 1, needsFirstReading: true }
  tx.setEntry(id, { ...entry, disabledReason: reason })
}

/**
 * Two enabled OAuth rows with one wire identity are the same account: the
 * earlier row in roster order stays enabled and every later one is disabled
 * with a reason. Returns the ids it disabled.
 */
export function disableIdentityDuplicates(
  tx: Transaction,
  identity: string,
): string[] {
  const holders = tx
    .rows()
    .filter(
      (row) =>
        row.invalid === undefined &&
        row.type === 'oauth' &&
        row.enabled &&
        row.identity === identity,
    )
  const disabled: string[] = []
  for (const row of holders.slice(1)) {
    disableIn(tx, row.id, DUPLICATE_IDENTITY_REASON)
    disabled.push(row.id)
  }
  return disabled
}

/** Records a row's wire identity in its roster row, then applies dedupe. */
export function recordIdentityIn(
  tx: Transaction,
  id: string,
  identity: string,
): string[] {
  const raw = tx.rosterRow(id)
  if (!raw) return []
  raw.accountId = identity
  return disableIdentityDuplicates(tx, identity)
}
