import {
  disableIdentityDuplicates,
  type RowEditor,
  recordIdentityIn,
} from './identity.js'
import {
  buildRawRows,
  CREDENTIAL_STAMP_KEY,
  type CredentialBinding,
  type CredentialStamp,
  credentialDigest,
  dispatchDigest,
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
 * or behind the config's epoch is never torn as a replace: this store's own
 * writes leave the state file ahead of the config, never behind it.
 *
 * Only a replace's stamp is ever completed as a replace. Since 0.4.4 every
 * stamp carries a binding, so a replace's says so itself (`replace: true`); a
 * stamp written by 0.4.3 or earlier has no dispatch digest, and those
 * versions wrote a binding only on replace, so such a stamp with a binding is
 * a replace's. A stamp from any other write that sits ahead of the config was
 * not left by a crash (those writes keep the row's epoch), and completing it
 * would rewrite the row's identity and drop its quota on a foreign writer's
 * say-so. With `requireCredentialStamps` a 0.4.3-shaped replace stamp is not
 * completed either: it proves nothing about the token sent, so the strict
 * store leaves the row as it is on disk (`legacy`, unbound) rather than act
 * on it; a store without the option completes it as before.
 *
 * A write that gives a row its first identity (`recordIdentity`, or a
 * `rotate` or refresh that learns one) follows the same order: the stamp
 * naming the identity first, then the config recording it. A crash between
 * leaves a stamp at the row's epoch, matching the credential beside it
 * exactly (digest and dispatch digest), that names an identity the config
 * does not record; that is completed forward the same way, by recording the
 * identity.
 */

/** Whether a well-formed stamp was written by a replace. */
function isReplaceStamp(stamp: CredentialStamp): boolean {
  if (!stamp.binding) return false
  return stamp.replace === true || stamp.dispatch === undefined
}

/** How a row left between the two writes of an operation is completed. */
export type TornCompletion =
  | {
      kind: 'replace'
      stamp: CredentialStamp & { binding: CredentialBinding }
    }
  | { kind: 'identity'; identity: string }

/** Rows left between the two writes of an operation, by row id. */
export function tornStamps(
  config: Record<string, unknown>,
  state: Record<string, unknown>,
  codec: QuotaCodec,
  options: { requireCredentialStamps?: boolean } = {},
): Map<string, TornCompletion> {
  const accounts = isRecord(state.accounts) ? state.accounts : {}
  const torn = new Map<string, TornCompletion>()
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
    const epoch = row.credentialEpoch ?? 1
    if (stamp.credentialEpoch > epoch) {
      if (!isReplaceStamp(stamp)) continue
      if (options.requireCredentialStamps && stamp.dispatch === undefined)
        continue
      torn.set(row.id, {
        kind: 'replace',
        stamp: { ...stamp, binding: stamp.binding },
      })
    } else if (
      stamp.credentialEpoch === epoch &&
      stamp.dispatch !== undefined &&
      stamp.dispatch === dispatchDigest(row.credential) &&
      stamp.binding.identity !== undefined &&
      row.identity === undefined
    ) {
      torn.set(row.id, { kind: 'identity', identity: stamp.binding.identity })
    }
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
 * The config with every torn row completed as its interrupted write would
 * have left it, and the ids completed. The config passed in is not modified;
 * when nothing is torn it is returned as is.
 */
export function completeTornRows(
  config: Record<string, unknown>,
  state: Record<string, unknown>,
  codec: QuotaCodec,
  options: { requireCredentialStamps?: boolean } = {},
): { config: Record<string, unknown>; torn: string[] } {
  const completions = tornStamps(config, state, codec, options)
  if (completions.size === 0) return { config, torn: [] }
  const next = structuredClone(config)
  const editor: RowEditor = {
    rows: () => buildRawRows(next, state, codec),
    rosterRow: (id) => rosterRowIn(next, id),
    entry: (id) => entryIn(next, id),
    setEntry: (id, entry) => setEntryIn(next, id, entry),
  }
  for (const [id, completion] of completions)
    if (completion.kind === 'replace')
      bindReplacement(
        editor,
        id,
        completion.stamp.credentialEpoch,
        completion.stamp.binding,
      )
  for (const [id, completion] of completions) {
    if (completion.kind === 'identity')
      recordIdentityIn(editor, id, completion.identity)
    else if (completion.stamp.binding.identity !== undefined)
      disableIdentityDuplicates(editor, completion.stamp.binding.identity)
  }
  return { config: next, torn: [...completions.keys()] }
}

/**
 * The rows every reader gets. A torn row is shown completed (the identity,
 * endpoint and epoch its stamp names, beside the credential it stamps), is
 * marked `torn` and is never a candidate; every other row is as on disk.
 * With `requireCredentialStamps`, a row whose stamp is not `bound` is marked
 * `unbound` and is never a candidate either. A torn row is shown with the
 * stamp of the interrupted write, which binds the completed row, so it is not
 * unbound; once a store write puts its completion on disk it is no longer
 * torn and is a candidate again like any other row.
 */
export function loadRows(
  config: Record<string, unknown>,
  state: Record<string, unknown>,
  codec: QuotaCodec,
  options: { requireCredentialStamps?: boolean } = {},
): PoolRow[] {
  const { config: whole, torn } = completeTornRows(
    config,
    state,
    codec,
    options,
  )
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
