import { disableIdentityDuplicates, type RowEditor } from './identity.js'
import {
  buildRawRows,
  CREDENTIAL_STAMP_KEY,
  type CredentialBinding,
  type CredentialStamp,
  credentialDigest,
  entryIn,
  isRecord,
  type PoolRow,
  parseStamp,
  type QuotaCodec,
  rosterRowIn,
  setEntryIn,
} from './schema.js'

/*
 * A replace changes both files: the state file gets the new credential and
 * the config gets the new epoch, identity or endpoint. It writes the state
 * file first, stamping the credential with the epoch it belongs to and the
 * binding (identity, endpoint) the config is about to get. A crash between
 * the two writes therefore leaves a credential whose stamp is ahead of the
 * config's epoch, and that is how every reader tells such a torn row from a
 * whole one. The stamp holds everything the config write would have written,
 * so a torn row is completed forward: readers are shown the completed row
 * (never a candidate until it is on disk) and the next store write on it
 * writes the config to match.
 *
 * A stamp counts only beside the credential it was written with (its digest
 * matches): a writer that does not know about stamps may put another
 * credential beside an old one, and that stamp then says nothing. A stamp at
 * or behind the config's epoch is never torn: this store's own writes leave
 * the state file ahead of the config, never behind it.
 */

/** Stamps of rows torn between the two writes of a replace, by row id. */
export function tornStamps(
  config: Record<string, unknown>,
  state: Record<string, unknown>,
  codec: QuotaCodec,
): Map<string, CredentialStamp & { binding: CredentialBinding }> {
  const accounts = isRecord(state.accounts) ? state.accounts : {}
  const torn = new Map<
    string,
    CredentialStamp & { binding: CredentialBinding }
  >()
  for (const row of buildRawRows(config, state, codec)) {
    if (row.invalid || !row.credential) continue
    const account = Object.hasOwn(accounts, row.id)
      ? accounts[row.id]
      : undefined
    if (!isRecord(account)) continue
    const stamp = parseStamp(account[CREDENTIAL_STAMP_KEY])
    if (!stamp?.binding) continue
    if (stamp.digest !== credentialDigest(row.credential)) continue
    // A row without an entry is at epoch 1, as everywhere else.
    if (stamp.credentialEpoch <= (row.credentialEpoch ?? 1)) continue
    torn.set(row.id, { ...stamp, binding: stamp.binding })
  }
  return torn
}

/**
 * The config half of a replacement: the row's entry moves to the new epoch,
 * loses its quota and needs a first reading; its roster row gets the new
 * identity (or loses the old one) and, for an API key, the new endpoint.
 * Disabling later rows that share the new identity is left to the caller
 * (`disableIdentityDuplicates`), so several rows can be bound first.
 */
export function bindReplacement(
  editor: RowEditor,
  id: string,
  credentialEpoch: number,
  binding: CredentialBinding,
): void {
  const entry = editor.entry(id) ?? {}
  const next: Record<string, unknown> = {
    ...entry,
    credentialEpoch,
    needsFirstReading: true,
  }
  delete next.quota
  editor.setEntry(id, next)
  const raw = editor.rosterRow(id)
  if (!raw) return
  if (binding.identity !== undefined) raw.accountId = binding.identity
  else delete raw.accountId
  if (binding.baseURL !== undefined) raw.baseURL = binding.baseURL
  if (binding.authHeader !== undefined) raw.authHeader = binding.authHeader
}

/**
 * The config with every torn row completed as its replace would have left
 * it, and the ids completed. The config passed in is not modified; when
 * nothing is torn it is returned as is.
 */
export function completeTornRows(
  config: Record<string, unknown>,
  state: Record<string, unknown>,
  codec: QuotaCodec,
): { config: Record<string, unknown>; torn: string[] } {
  const stamps = tornStamps(config, state, codec)
  if (stamps.size === 0) return { config, torn: [] }
  const next = structuredClone(config)
  const editor: RowEditor = {
    rows: () => buildRawRows(next, state, codec),
    rosterRow: (id) => rosterRowIn(next, id),
    entry: (id) => entryIn(next, id),
    setEntry: (id, entry) => setEntryIn(next, id, entry),
  }
  for (const [id, stamp] of stamps)
    bindReplacement(editor, id, stamp.credentialEpoch, stamp.binding)
  for (const stamp of stamps.values())
    if (stamp.binding.identity !== undefined)
      disableIdentityDuplicates(editor, stamp.binding.identity)
  return { config: next, torn: [...stamps.keys()] }
}

/**
 * The rows every reader gets. A torn row is shown completed (the identity,
 * endpoint and epoch its stamp names, beside the credential it stamps), is
 * marked `torn` and is never a candidate; every other row is as on disk.
 * With `requireCredentialStamps`, a row whose stamp is not `bound` is marked
 * `unbound` and is never a candidate either. A torn row is shown with the
 * replacement's stamp, which binds the completed row, so it is not unbound:
 * it stays out of routing only until its completion is written.
 */
export function loadRows(
  config: Record<string, unknown>,
  state: Record<string, unknown>,
  codec: QuotaCodec,
  options: { requireCredentialStamps?: boolean } = {},
): PoolRow[] {
  const { config: whole, torn } = completeTornRows(config, state, codec)
  const rows = buildRawRows(whole, state, codec)
  for (const row of rows) {
    if (torn.includes(row.id)) {
      row.torn = true
      row.candidate = false
    }
    if (options.requireCredentialStamps && row.stamp !== 'bound') {
      row.unbound = true
      row.candidate = false
    }
  }
  return rows
}
