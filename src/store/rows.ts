import { randomUUID } from 'node:crypto'
import type { Attribution } from './attribution.js'
import { PoolOperationError } from './errors.js'
import { assertNotInsideHook, runInsideHook } from './hooks.js'
import {
  DUPLICATE_IDENTITY_REASON,
  disableIdentityDuplicates,
  disableIn,
  enableIn,
  recordIdentityIn,
} from './identity.js'
import {
  notReadyError,
  readPool,
  runOperation,
  type Transaction,
  withTransaction,
} from './mutate.js'
import {
  acceptProviderState,
  mergedProviderState,
  type ProviderStateWrite,
  planProviderStateIn,
  providerStateCoverage,
  type RowTransitionMutator,
  replacementProviderState,
  type UpdateProviderStateResult,
} from './provider-state.js'
import type { PoolLockSpec } from './refresh-lock.js'
import {
  readRow,
  refusal,
  requireBound,
  rowLockSpec,
  type StoreRuntime,
  unknownRow,
} from './runtime.js'
import {
  boundProviderStateDigest,
  CREDENTIAL_STAMP_KEY,
  type CredentialBinding,
  credentialProblem,
  fingerprintOf,
  idProblem,
  isCredentialEpoch,
  isRecord,
  type PoolCredential,
  type PoolRow,
  PROVIDER_STATE_KEY,
  type RotateCredential,
  rosterRowFor,
  rotationStamp,
  rowLockKey,
  type StoredCredential,
  stampFor,
  stateFieldsFor,
  storedCredential,
} from './schema.js'
import {
  applyTransition,
  bindReplacement,
  type StampedTransition,
  TRANSITION_STAMP_KEY,
} from './torn.js'

export type FailureHook = (
  rowId: string,
  error: PoolOperationError,
) => void | Promise<void>

export interface RowOperationOptions {
  /** Called once, awaited, on every non-success path, before locks release. */
  onFailure?: FailureHook
  /** The provider-wide lock, when an operation may change identity keying. */
  providerLock?: PoolLockSpec
  /**
   * Further locks taken after the row lock and the provider-wide lock, in
   * this order, before the store locks: the same place `refresh` takes its
   * extra locks, so a caller holding legacy locks around a row write and a
   * refresh of that row acquire them in one order and cannot deadlock.
   */
  extraLocks?: readonly PoolLockSpec[]
}

/**
 * Options of `disable`, `enable` and `remove`. The provider-wide lock guards
 * changes to the recorded identity a row lock is named by; none of these
 * three records an identity, so none takes it. The extra locks are taken
 * where every other row write takes them, after the row lock and before the
 * store locks.
 */
export type RowToggleOptions = Pick<
  RowOperationOptions,
  'onFailure' | 'extraLocks'
>

/** What a `remove` protect predicate is shown, read under every lock. */
export interface RemoveView {
  /**
   * The row as loaded; undefined when the roster no longer holds the id and
   * only its state-file entry is left (a removal interrupted between writes).
   */
  row: PoolRow | undefined
  /** The config file as read under the store locks. */
  config: Readonly<Record<string, unknown>>
  /** The state file as read under the store locks. */
  state: Readonly<Record<string, unknown>>
}

export interface RemoveOptions extends RowToggleOptions {
  /**
   * Awaited under every lock before anything is written; a reason refuses
   * the removal (kind `row-protected`) with both files unchanged. The store
   * keeps no record of a plugin's in-flight work, so this is where a plugin
   * refuses an id it reserves or one its own pending-operation record (kept
   * in the config or state file) still names: reading that record from the
   * locked files here cannot race a writer that holds the store locks.
   */
  protect?: (
    id: string,
    view: RemoveView,
  ) => string | undefined | Promise<string | undefined>
}

export type RemoveResult = {
  id: string
  /**
   * `removed`: the roster row was dropped (and its state entry, if any).
   * `completed`: only a state-file entry was left, by a removal interrupted
   * between its config and state writes, and it is now dropped.
   */
  outcome: 'removed' | 'completed'
}

/**
 * Options of `reorder`. It names no row, so its failure hook is handed only
 * the failure; it takes no row lock and no provider-wide lock, so the extra
 * locks are taken first, then the store locks.
 */
export interface ReorderOptions {
  /** Called once, awaited, on every non-success path, before the extra locks release. */
  onFailure?: (error: PoolOperationError) => void | Promise<void>
  /** Locks taken, in this order, before the store locks. */
  extraLocks?: readonly PoolLockSpec[]
}

export type ReorderResult = {
  /** The roster order now on disk. */
  ids: string[]
  /** `unchanged` when the roster was already in this order; nothing was written. */
  outcome: 'reordered' | 'unchanged'
}

export interface AddInput {
  id: string
  credential: PoolCredential
  identity?: string
  label?: string
  /**
   * Provider state for the credential, written in the same state write as
   * the credential (needs the store's provider-state codec). On an `add`
   * that rotates a row already holding this secret it is merged with the
   * row's value (`ProviderStateCodec.merge`); left out, that row keeps its
   * value.
   */
  providerState?: unknown
}

/** What `replace` and `rotate` take beside the credential. */
export interface CredentialWriteInput {
  identity?: string
  /**
   * Provider state written in the same state write as the credential. For
   * `rotate` it is merged with the row's value; left out, the row keeps its
   * value. For `replace` see `ProviderStateCodec.onReplace`.
   */
  providerState?: unknown
}

export type AddResult = {
  /** The row holding the credential; an existing row's id on a re-add. */
  id: string
  outcome: 'added' | 'added-disabled' | 'completed' | 'rotated'
  credential: StoredCredential
}

/** Fields of a state entry that belong to the credential it replaces. */
const CREDENTIAL_STATE_FIELDS = [
  'access',
  'refresh',
  'expires',
  'lastRefreshedAt',
  'apiKey',
]

/**
 * The endpoint an API-key roster row sends its key to, as `buildRawRows` loads
 * it: the trimmed `baseURL`, and a bearer header unless the row names
 * `x-api-key`.
 */
function rowEndpoint(raw: Record<string, unknown>): {
  baseURL: string
  authHeader: 'authorization-bearer' | 'x-api-key'
} {
  return {
    baseURL: String(raw.baseURL).trim(),
    authHeader:
      raw.authHeader === 'x-api-key' ? 'x-api-key' : 'authorization-bearer',
  }
}

/**
 * The credential as it will sit in the row. The state file holds only an API
 * key; its endpoint lives in the roster row. So an API key written into a row
 * is sent wherever that row says, and one given for another `baseURL` or
 * `authHeader` would silently be paired with an endpoint it was not issued
 * for. A part the caller leaves out is the row's; a part it gives must equal
 * the row's, else the write is refused (`endpoint-mismatch`) before anything
 * is written. Moving a row to another endpoint is a `replace`, which writes
 * the new endpoint first.
 */
function onRowEndpoint(
  tx: Transaction,
  id: string,
  credential: RotateCredential,
): PoolCredential {
  if (credential.type !== 'api') return credential
  const raw = tx.rosterRow(id)
  if (!isRecord(raw)) {
    if (credential.baseURL === undefined)
      throw refusal(
        tx.info.operation,
        id,
        'invalid-input',
        'api credential needs a valid baseURL',
      )
    return { ...credential, baseURL: credential.baseURL }
  }
  const endpoint = rowEndpoint(raw)
  const baseURL = credential.baseURL?.trim() ?? endpoint.baseURL
  const authHeader = credential.authHeader ?? endpoint.authHeader
  if (baseURL !== endpoint.baseURL || authHeader !== endpoint.authHeader)
    throw refusal(
      tx.info.operation,
      id,
      'endpoint-mismatch',
      `row ${id} sends its key to another endpoint or header; a key for another endpoint is a replacement`,
    )
  return { ...credential, baseURL, authHeader }
}

/**
 * The binding of a credential written into a row without a replace: the
 * config as it stands in `tx`, plus the identity the same operation is about
 * to record (`learnt`), if any. The identity is the roster row's recorded
 * one, read the way `buildRawRows` reads it. A learnt identity is stamped
 * before the config records it, so a crash between the two writes leaves a
 * stamp naming an identity the config lacks, which every reader completes
 * forward (see `torn.ts`); the reverse order would leave a config identity
 * no stamp proves. An API key's endpoint is the one it was checked against
 * (see `onRowEndpoint`).
 */
function bindingInTx(
  tx: Transaction,
  id: string,
  stored: StoredCredential,
  learnt?: string,
): CredentialBinding {
  const raw = tx.rosterRow(id)
  const identity =
    learnt ??
    (isRecord(raw) && typeof raw.accountId === 'string' && raw.accountId
      ? raw.accountId
      : undefined)
  return {
    ...(identity !== undefined ? { identity } : {}),
    ...(stored.type === 'api'
      ? {
          baseURL: stored.baseURL,
          authHeader: stored.authHeader ?? 'authorization-bearer',
        }
      : {}),
  }
}

/**
 * Writes a credential into the state file (one write), stamped with the
 * credential epoch the row's entry holds in `tx` (1 without an entry) and a
 * binding: for a replace, the one the config is about to get (and the stamp
 * is marked as a replace's); for every other write, the row's config as it
 * stands in `tx` with the identity the operation is about to record
 * (`identity`, see `bindingInTx`). A rotation is the same lineage: no epoch
 * bump, no identity or quota change. An API key must belong to the endpoint
 * the row holds in `tx` (see `onRowEndpoint`).
 */
export async function rotateIn(
  rt: StoreRuntime,
  tx: Transaction,
  id: string,
  given: RotateCredential,
  extra: {
    stamp?: number
    clearErrors?: boolean
    binding?: CredentialBinding
    identity?: string
    providerState?: ProviderStateWrite
  } = {},
): Promise<StoredCredential> {
  const credential = onRowEndpoint(tx, id, given)
  const prior = tx.stateAccount(id)
  const stateWrite = extra.providerState ?? { kind: 'keep' }
  const epoch = tx.entry(id)?.credentialEpoch
  const credentialEpoch = typeof epoch === 'number' ? epoch : 1
  // The provider state goes in the same state write as the credential and
  // its stamp, so no reader ever sees one without the other. A kept value is
  // bound by the new stamp only if the old one bound it to this row at the
  // epoch being written; a replace moves the epoch, so it never keeps one.
  const providerStateBinding = providerStateCoverage(
    rt.ctx.providerState,
    stateWrite,
    prior,
    prior && Object.hasOwn(prior, PROVIDER_STATE_KEY) ? tx.row(id) : undefined,
    credentialEpoch,
  )
  const priorStamp =
    typeof prior?.lastRefreshedAt === 'number'
      ? prior.lastRefreshedAt
      : undefined
  const stamp =
    credential.type === 'oauth'
      ? (extra.stamp ?? rotationStamp(priorStamp, rt.ctx.now()))
      : undefined
  const kept: Record<string, unknown> = { ...(prior ?? {}) }
  for (const field of CREDENTIAL_STATE_FIELDS) delete kept[field]
  if (extra.clearErrors) {
    delete kept.lastRefreshError
    delete kept.lastQuotaRefreshError
    delete kept.quota
  }
  if (stateWrite.kind === 'clear') delete kept[PROVIDER_STATE_KEY]
  else if (stateWrite.kind === 'set')
    kept[PROVIDER_STATE_KEY] = stateWrite.value
  const stored = storedCredential(credential, stamp)
  tx.setStateAccount(id, {
    ...kept,
    ...stateFieldsFor(credential, stamp),
    [CREDENTIAL_STAMP_KEY]: stampFor(
      stored,
      credentialEpoch,
      extra.binding ?? bindingInTx(tx, id, stored, extra.identity),
      {
        replace: extra.binding !== undefined,
        ...(providerStateBinding !== undefined
          ? { providerState: providerStateBinding }
          : {}),
      },
    ),
  })
  await tx.commitState(stored)
  return stored
}

/**
 * Restamps a bound row's credential, unchanged, so its stamp names the
 * identity the caller is about to record in the config (same epoch, same
 * credential, one state write). Written before the config for the reason
 * `bindingInTx` gives. A row whose stamp is not bound (possible only without
 * `requireCredentialStamps`) gets no new stamp, because a fresh stamp would
 * vouch for a credential this store never proved: its identity is recorded in
 * the config only, and the row keeps the stamp status it had.
 */
async function stampIdentityIn(
  tx: Transaction,
  row: PoolRow,
  identity: string,
): Promise<void> {
  if (!row.credential || row.stamp !== 'bound') return
  const account = tx.stateAccount(row.id)
  // The provider state stays bound across the identity being learnt: the old
  // stamp bound it to the row with no identity, the new one to the identity
  // the config is about to record.
  const providerState = boundProviderStateDigest(
    account,
    row.credential,
    row.credentialEpoch ?? 1,
    row.identity,
  )
  tx.setStateAccount(row.id, {
    ...(account ?? {}),
    [CREDENTIAL_STAMP_KEY]: stampFor(
      row.credential,
      row.credentialEpoch ?? 1,
      bindingInTx(tx, row.id, row.credential, identity),
      providerState !== undefined ? { providerState } : {},
    ),
  })
  await tx.commitState()
}

function checkInput(
  operation: 'add' | 'replace' | 'rotate',
  id: string,
  credential: RotateCredential,
): void {
  const idIssue = operation === 'add' ? idProblem(id) : undefined
  if (idIssue) throw refusal(operation, id, 'invalid-input', idIssue)
  const credentialIssue = credentialProblem(credential, {
    baseURLOptional: operation === 'rotate',
  })
  if (credentialIssue)
    throw refusal(operation, id, 'invalid-input', credentialIssue)
}

function requireUsableRow(
  operation: 'replace' | 'rotate' | 'recordIdentity' | 'disable' | 'enable',
  id: string,
  row: PoolRow | undefined,
  credential?: RotateCredential,
): PoolRow {
  if (!row) throw unknownRow(operation, id)
  if (row.invalid)
    throw refusal(operation, id, 'invalid-row', `row ${id} failed validation`)
  if (credential && credential.type !== row.type)
    throw refusal(
      operation,
      id,
      'type-mismatch',
      `row ${id} holds a ${row.type} credential`,
    )
  return row
}

/** The row is recorded for another account than the one given. */
function identityMismatch(
  operation: 'add' | 'rotate' | 'recordIdentity',
  id: string,
): PoolOperationError {
  return refusal(
    operation,
    id,
    'identity-mismatch',
    `row ${id} is recorded for another account; a credential of a different account is a replacement`,
  )
}

/** Keying changed between the unlocked read and the locked one: retry. */
function keyChanged(
  operation:
    | 'replace'
    | 'rotate'
    | 'recordIdentity'
    | 'disable'
    | 'enable'
    | 'remove',
  id: string,
) {
  return refusal(
    operation,
    id,
    'row-key-changed',
    `row ${id}'s wire identity changed while its lock was being taken`,
    true,
  )
}

export async function addRow(
  rt: StoreRuntime,
  input: AddInput,
  options: RowOperationOptions = {},
): Promise<AddResult> {
  assertNotInsideHook('add')
  const { ctx } = rt
  const { id, credential, identity, label } = input
  const result = await runOperation(
    ctx,
    'add',
    id,
    options.onFailure,
    async (locks, progress) => {
      checkInput('add', id, credential)
      const incoming =
        input.providerState === undefined
          ? undefined
          : acceptProviderState(
              ctx.providerState,
              'add',
              id,
              input.providerState,
            )
      if (ctx.removedIds.has(id))
        throw refusal(
          'add',
          id,
          'id-removed',
          `id ${id} was removed from the roster in this process and is not reused`,
        )
      await locks.acquire(rowLockSpec(rt, { id, identity }))
      if (credential.type === 'oauth')
        await locks.acquire(options.providerLock ?? rt.providerLock)
      for (const extra of options.extraLocks ?? []) await locks.acquire(extra)
      return withTransaction(
        ctx,
        locks,
        progress,
        { operation: 'add', rowId: id },
        async (tx): Promise<AddResult> => {
          const rows = tx.rows()
          const fingerprint = fingerprintOf(credential)
          const same = rows.find(
            (row) =>
              row.invalid === undefined && row.fingerprint === fingerprint,
          )
          if (same) {
            // Re-adding a secret whose stamp is not proved would rotate it in
            // and keep the identity and quota recorded beside it, making that
            // unproved record look bound. The add is refused instead, and the
            // caller replaces the row, which starts a new credential epoch.
            requireBound('add', same)
            // The same secret is the same credential, so re-adding it rotates
            // that row. An identity or endpoint given with it must match the
            // row's; a different one is refused rather than silently replaced
            // by what the row already holds.
            if (
              identity !== undefined &&
              same.identity !== undefined &&
              identity !== same.identity
            )
              throw identityMismatch('add', same.id)
            const stored = await rotateIn(rt, tx, same.id, credential, {
              ...(incoming !== undefined
                ? {
                    providerState: mergedProviderState(
                      ctx.providerState,
                      'add',
                      same.id,
                      same.providerState,
                      incoming,
                    ),
                  }
                : {}),
            })
            return { id: same.id, outcome: 'rotated', credential: stored }
          }
          const existing = rows.find((row) => row.id === id)
          if (existing) {
            if (existing.invalid)
              throw refusal('add', id, 'invalid-row', `row ${id} is invalid`)
            if (existing.credential)
              throw refusal(
                'add',
                id,
                'id-exists',
                `row ${id} already holds a credential`,
              )
            // Completing a credential-less row keeps its epoch, identity and
            // quota; when stamps are required those belong to no proved
            // credential, so the row must be replaced instead.
            requireBound('add', existing)
            if (existing.type !== credential.type)
              throw refusal(
                'add',
                id,
                'type-mismatch',
                `row ${id} is a ${existing.type} row`,
              )
            if (
              identity !== undefined &&
              existing.identity !== undefined &&
              identity !== existing.identity
            )
              throw identityMismatch('add', id)
            // A roster row without a credential (left by another writer, or
            // by an add of an earlier version that stopped between its
            // writes): writing the credential now completes it at epoch 1.
            if (!existing.hasEntry)
              tx.setEntry(id, {
                credentialEpoch: 1,
                needsFirstReading: credential.type === 'oauth',
              })
            const stored = await rotateIn(rt, tx, id, credential, {
              clearErrors: true,
              ...(incoming !== undefined
                ? { providerState: { kind: 'set', value: incoming } }
                : {}),
            })
            if (!existing.hasEntry) await tx.commitConfig()
            return { id, outcome: 'completed', credential: stored }
          }
          tx.roster().push(
            rosterRowFor({
              id,
              credential,
              ...(identity !== undefined ? { identity } : {}),
              ...(label !== undefined ? { label } : {}),
              addedAt: ctx.now(),
            }),
          )
          tx.setEntry(id, {
            credentialEpoch: 1,
            needsFirstReading: credential.type === 'oauth',
          })
          let outcome: AddResult['outcome'] = 'added'
          if (identity !== undefined && credential.type === 'oauth') {
            // Same account, different credential: kept on disk, disabled.
            const holder = rows.find(
              (row) =>
                row.invalid === undefined &&
                row.type === 'oauth' &&
                row.enabled &&
                row.identity === identity,
            )
            if (holder) {
              disableIn(tx, id, DUPLICATE_IDENTITY_REASON)
              outcome = 'added-disabled'
            }
          }
          // The credential is written first. A crash before the config write
          // then leaves a state entry no roster row names, which no reader
          // loads and `remove` drops; written the other way round, the new
          // roster row could load beside a credential left under its id by an
          // interrupted removal. Nothing of such a leftover entry is kept.
          tx.dropStateAccount(id)
          const stored = await rotateIn(rt, tx, id, credential, {
            ...(incoming !== undefined
              ? { providerState: { kind: 'set', value: incoming } }
              : {}),
          })
          await tx.commitConfig()
          return { id, outcome, credential: stored }
        },
      )
    },
  )
  if (
    credential.type === 'oauth' &&
    (result.outcome === 'added' || result.outcome === 'completed')
  )
    rt.firePull(result.id, 'add')
  return result
}

export async function replaceRow(
  rt: StoreRuntime,
  id: string,
  credential: PoolCredential,
  input: CredentialWriteInput = {},
  options: RowOperationOptions = {},
): Promise<{
  id: string
  credential: StoredCredential
  credentialEpoch: number
}> {
  assertNotInsideHook('replace')
  const { ctx } = rt
  const result = await runOperation(
    ctx,
    'replace',
    id,
    options.onFailure,
    async (locks, progress) => {
      checkInput('replace', id, credential)
      const incoming =
        input.providerState === undefined
          ? undefined
          : acceptProviderState(
              ctx.providerState,
              'replace',
              id,
              input.providerState,
            )
      const { row: seen } = await readRow(rt, 'replace', id)
      await locks.acquire(rowLockSpec(rt, seen))
      if (credential.type === 'oauth')
        await locks.acquire(options.providerLock ?? rt.providerLock)
      for (const extra of options.extraLocks ?? []) await locks.acquire(extra)
      return withTransaction(
        ctx,
        locks,
        progress,
        { operation: 'replace', rowId: id },
        async (tx) => {
          const row = requireUsableRow('replace', id, tx.row(id), credential)
          if (rowLockKey(row) !== rowLockKey(seen))
            throw keyChanged('replace', id)
          const priorEpoch = tx.entry(id)?.credentialEpoch
          const credentialEpoch =
            (typeof priorEpoch === 'number' ? priorEpoch : 1) + 1
          // An epoch past the safe integer range could equal the one before
          // it, so readers could not tell the new credential from the old.
          // Refused before anything is written; the row keeps its credential.
          if (!isCredentialEpoch(credentialEpoch))
            throw refusal(
              'replace',
              id,
              'invalid-row',
              `row ${id}'s credential epoch cannot advance past ${Number.MAX_SAFE_INTEGER}; remove the row and add the new credential as a new row`,
            )
          // Decided before anything is written: a hook that throws or
          // returns a value the codec rejects leaves the row as it was.
          const providerState = replacementProviderState(
            ctx.providerState,
            row,
            credentialEpoch,
            input.identity,
            incoming,
          )
          const binding: CredentialBinding = {
            ...(input.identity !== undefined
              ? { identity: input.identity }
              : {}),
            ...(credential.type === 'api'
              ? {
                  baseURL: credential.baseURL.trim(),
                  authHeader: credential.authHeader ?? 'authorization-bearer',
                }
              : {}),
          }
          bindReplacement(tx, id, credentialEpoch, binding)
          if (input.identity !== undefined)
            disableIdentityDuplicates(tx, input.identity)
          // The new credential goes first, stamped with the new epoch and the
          // binding. A crash before the config write leaves the stamp ahead
          // of the config: every reader shows the row torn (completed, never
          // a candidate) and the next store write completes the config from
          // the stamp, so no reader pairs either credential with the other
          // account's identity or endpoint.
          const stored = await rotateIn(rt, tx, id, credential, {
            clearErrors: true,
            binding,
            providerState,
          })
          await tx.commitConfig()
          return { id, credential: stored, credentialEpoch }
        },
      )
    },
  )
  if (credential.type === 'oauth') rt.firePull(id, 'replace')
  return result
}

export async function rotateRow(
  rt: StoreRuntime,
  id: string,
  credential: RotateCredential,
  input: CredentialWriteInput = {},
  options: RowOperationOptions = {},
): Promise<{ id: string; credential: StoredCredential }> {
  assertNotInsideHook('rotate')
  const { ctx } = rt
  return runOperation(
    ctx,
    'rotate',
    id,
    options.onFailure,
    async (locks, progress) => {
      checkInput('rotate', id, credential)
      const incoming =
        input.providerState === undefined
          ? undefined
          : acceptProviderState(
              ctx.providerState,
              'rotate',
              id,
              input.providerState,
            )
      const { row: seen } = await readRow(rt, 'rotate', id)
      await locks.acquire(rowLockSpec(rt, seen))
      if (input.identity !== undefined && credential.type === 'oauth')
        await locks.acquire(options.providerLock ?? rt.providerLock)
      for (const extra of options.extraLocks ?? []) await locks.acquire(extra)
      return withTransaction(
        ctx,
        locks,
        progress,
        { operation: 'rotate', rowId: id },
        async (tx) => {
          const row = requireUsableRow('rotate', id, tx.row(id), credential)
          if (rowLockKey(row) !== rowLockKey(seen))
            throw keyChanged('rotate', id)
          // A rotation keeps the row's epoch, identity and quota, so it must
          // never be what stamps an unproved row as bound.
          requireBound('rotate', row)
          // A rotation stays with one account: it may record the first
          // identity the row learns, but a credential of another known
          // account is a replacement (new epoch, quota and errors dropped).
          if (
            input.identity !== undefined &&
            row.identity !== undefined &&
            input.identity !== row.identity
          )
            throw identityMismatch('rotate', id)
          const learnt =
            input.identity !== undefined && row.identity === undefined
              ? input.identity
              : undefined
          const stored = await rotateIn(rt, tx, id, credential, {
            identity: learnt,
            ...(incoming !== undefined
              ? {
                  providerState: mergedProviderState(
                    ctx.providerState,
                    'rotate',
                    id,
                    row.providerState,
                    incoming,
                  ),
                }
              : {}),
          })
          let configChanged = false
          if (!row.hasEntry) {
            tx.setEntry(id, {
              credentialEpoch: 1,
              needsFirstReading: row.type === 'oauth',
            })
            configChanged = true
          }
          if (input.identity !== undefined && row.identity !== input.identity) {
            recordIdentityIn(tx, id, input.identity)
            configChanged = true
          }
          if (configChanged) await tx.commitConfig()
          return { id, credential: stored }
        },
      )
    },
  )
}

/**
 * Options of `disable` and `enable`. A call that passes neither
 * `attribution` nor `providerState` behaves exactly as it did before 0.7.0.
 */
export interface RowTransitionOptions extends RowToggleOptions {
  /**
   * The credential epoch and recorded identity the caller's evidence for the
   * transition was obtained under (as `recordQuota`'s attribution: an
   * identity left out means the row had none). The call is refused
   * (`attribution`, retryable, nothing written) once the row holds another
   * epoch or identity, so a provider's late answer about a replaced
   * credential never disables, or switches back on, the row now holding its
   * successor.
   */
  attribution?: Attribution
  /**
   * A provider-state change made in the same transaction as the transition,
   * under the rules of `updateProviderState` (codec validation, the stamp
   * rebound to the value, `unbound-credential` for a row no stamp of this
   * store can bind it to); it requires `attribution`. The value and the
   * enabled flag land together: no reader, and no crash at any write point,
   * shows one without the other. Returning `DECLINE_TRANSITION` declines the
   * whole call and writes nothing.
   */
  providerState?: RowTransitionMutator
}

export interface RowTransitionResult {
  id: string
  /** The provider-state mutator declined: nothing was written. */
  declined?: true
  /**
   * Set when a provider-state mutator ran and did not decline: what it did
   * to the value, as `updateProviderState` reports it.
   */
  providerStateOutcome?: UpdateProviderStateResult['outcome']
  /** The provider state the row now holds, when a mutator ran and left one. */
  providerState?: unknown
}

/**
 * The flag a `disable` or `enable` sets: disabled with a reason, or enabled.
 */
type RowFlag = { enabled: false; reason: string } | { enabled: true }

/**
 * `disable` and `enable` in one place. Takes the row lock, then the extra
 * locks, then the store locks, as every row write does, so it waits for a
 * refresh of the row instead of landing during its provider call.
 *
 * With a provider-state mutator that changes the value, the transition is
 * written as a replace is: the state file first, carrying the value and, in
 * the stamp, the transition itself; then the config, flipping the row and
 * recording the transition's mark (see `torn.ts`). A stop between the two
 * leaves a row every reader shows transitioned beside its new value. When
 * the config already says what the transition would write (an `enable` of
 * an enabled row), the value alone is written, in one state write.
 */
async function transitionRow(
  rt: StoreRuntime,
  operation: 'disable' | 'enable',
  id: string,
  flag: RowFlag,
  options: RowTransitionOptions,
): Promise<RowTransitionResult> {
  assertNotInsideHook(operation)
  const { ctx } = rt
  const codec = ctx.providerState
  const fence = options.attribution
  const mutator = options.providerState
  return runOperation(
    ctx,
    operation,
    id,
    options.onFailure,
    async (locks, progress) => {
      if (
        fence !== undefined &&
        !isCredentialEpoch(isRecord(fence) ? fence.credentialEpoch : undefined)
      )
        throw refusal(
          operation,
          id,
          'invalid-input',
          'the attribution must name a credential epoch that is a positive safe integer',
        )
      if (mutator !== undefined) {
        if (typeof mutator !== 'function')
          throw refusal(
            operation,
            id,
            'invalid-input',
            'the provider-state mutator must be a function',
          )
        // A provider-state value belongs to one credential, so a change to
        // it must say which credential it was decided for.
        if (fence === undefined)
          throw refusal(
            operation,
            id,
            'invalid-input',
            'a provider-state change needs the attribution of the credential it is for',
          )
        if (!codec)
          throw refusal(
            operation,
            id,
            'invalid-input',
            'the store was opened without a provider-state codec',
          )
      }
      const { row: seen } = await readRow(rt, operation, id)
      await locks.acquire(rowLockSpec(rt, seen))
      for (const extra of options.extraLocks ?? []) await locks.acquire(extra)
      return withTransaction(
        ctx,
        locks,
        progress,
        { operation, rowId: id },
        async (tx): Promise<RowTransitionResult> => {
          const loaded = tx.row(id)
          const row = flag.enabled
            ? requireUsableRow('enable', id, loaded)
            : loaded
          if (!row || !tx.rosterRow(id)) throw unknownRow(operation, id)
          if (rowLockKey(row) !== rowLockKey(seen))
            throw keyChanged(operation, id)
          if (fence !== undefined) {
            // An invalid entry has no epoch to compare the fence with.
            if (row.invalid)
              throw refusal(
                operation,
                id,
                'invalid-row',
                `row ${id} failed validation`,
              )
            if (
              (row.credentialEpoch ?? 1) !== fence.credentialEpoch ||
              row.identity !== fence.identity
            )
              throw refusal(
                operation,
                id,
                'attribution',
                `the ${operation} of ${id} was issued for a credential or account the row no longer holds`,
                true,
              )
          }
          // An enable of a row that is already enabled has nothing to write
          // to the config; a disable always rewrites it, as it always has.
          const writesConfig =
            !flag.enabled || !row.enabled || row.disabledReason !== undefined
          if (flag.enabled && writesConfig && row.type === 'oauth') {
            const holder =
              row.identity === undefined
                ? undefined
                : tx
                    .rows()
                    .find(
                      (other) =>
                        other.id !== id &&
                        other.invalid === undefined &&
                        other.type === 'oauth' &&
                        other.enabled &&
                        other.identity === row.identity,
                    )
            if (holder)
              throw refusal(
                'enable',
                id,
                'duplicate-identity',
                `row ${holder.id} is enabled with the same identity as row ${id}`,
              )
          }
          if (mutator === undefined || codec === undefined) {
            if (!writesConfig) return { id }
            if (flag.enabled) enableIn(tx, id)
            else disableIn(tx, id, flag.reason)
            await tx.commitConfig()
            return { id }
          }
          if (!row.credential)
            throw refusal(
              operation,
              id,
              'no-credential',
              `row ${id} holds no credential`,
            )
          // A strict store refuses here, but not for an attribution alone:
          // disabling or enabling a row whose credential the store cannot
          // prove is harmless (an unbound row is never a candidate), while
          // writing a provider state would vouch for that credential.
          requireBound(operation, row)
          const plan = await planProviderStateIn(
            tx,
            codec,
            operation,
            row,
            mutator,
            true,
          )
          if (plan.kind === 'declined') return { id, declined: true }
          const result: RowTransitionResult = {
            id,
            providerStateOutcome:
              plan.kind === 'unchanged'
                ? 'unchanged'
                : plan.value === undefined
                  ? 'cleared'
                  : 'updated',
            ...(plan.value !== undefined ? { providerState: plan.value } : {}),
          }
          if (plan.kind === 'unchanged') {
            if (writesConfig) {
              if (flag.enabled) enableIn(tx, id)
              else disableIn(tx, id, flag.reason)
              await tx.commitConfig()
            }
            return result
          }
          if (!writesConfig) {
            tx.setStateAccount(id, plan.account)
            await tx.commitState()
            return result
          }
          const transition: StampedTransition = flag.enabled
            ? { mark: randomUUID(), enabled: true }
            : { mark: randomUUID(), enabled: false, reason: flag.reason }
          const stamp = plan.account[CREDENTIAL_STAMP_KEY] as Record<
            string,
            unknown
          >
          tx.setStateAccount(id, {
            ...plan.account,
            [CREDENTIAL_STAMP_KEY]: {
              ...stamp,
              [TRANSITION_STAMP_KEY]: transition,
            },
          })
          await tx.commitState()
          applyTransition(tx, id, transition)
          await tx.commitConfig()
          return result
        },
      )
    },
  )
}

/**
 * Marks a row disabled with a reason. See `RowTransitionOptions` for the
 * attributed form, which may change the provider state with it.
 */
export function disableRow(
  rt: StoreRuntime,
  id: string,
  reason: string,
  options: RowTransitionOptions = {},
): Promise<RowTransitionResult> {
  return transitionRow(rt, 'disable', id, { enabled: false, reason }, options)
}

/**
 * Clears a row's `enabled: false` and its `disabledReason` in one config
 * write. An OAuth row whose recorded identity another enabled OAuth row holds
 * stays disabled and the call refuses (`duplicate-identity`): the same rule
 * that makes `add` store such a row disabled. Enabling a row that is already
 * enabled writes nothing. See `RowTransitionOptions` for the attributed
 * form, which may change the provider state with it.
 */
export function enableRow(
  rt: StoreRuntime,
  id: string,
  options: RowTransitionOptions = {},
): Promise<RowTransitionResult> {
  return transitionRow(rt, 'enable', id, { enabled: true }, options)
}

/**
 * Deletes a row: its roster row and per-row entry (quota, epoch; the identity
 * lives in the roster row) in one config write, then its credential and
 * runtime fields in one state write. The config goes first, so a crash
 * between the two leaves a row every reader already sees as removed, with
 * only an orphaned state entry that no reader loads; calling `remove` again
 * drops that entry (`completed`). As with every id the store drops, the id is
 * not reused by `add` in this process.
 */
export async function removeRow(
  rt: StoreRuntime,
  id: string,
  options: RemoveOptions = {},
): Promise<RemoveResult> {
  assertNotInsideHook('remove')
  const { ctx } = rt
  return runOperation(
    ctx,
    'remove',
    id,
    options.onFailure,
    async (locks, progress) => {
      // Only a non-string or empty id is refused: a roster row whose id the
      // older readers would trim is invalid, and removing it is a repair.
      if (typeof id !== 'string' || id.length === 0)
        throw refusal('remove', id, 'invalid-input', 'id must be non-empty')
      const result = await readPool(ctx)
      if (result.status !== 'ready') throw notReadyError(result, 'remove', id)
      const seen = result.rows.find((row) => row.id === id)
      if (!seen && !hasStateAccount(result.state, id))
        throw unknownRow('remove', id)
      const seenKey = rowLockKey(seen ?? { id })
      await locks.acquire(rowLockSpec(rt, seen ?? { id }))
      for (const extra of options.extraLocks ?? []) await locks.acquire(extra)
      return withTransaction(
        ctx,
        locks,
        progress,
        { operation: 'remove', rowId: id },
        async (tx): Promise<RemoveResult> => {
          const row = tx.row(id)
          const orphan = hasStateAccount(tx.state, id)
          if (!row && !orphan) throw unknownRow('remove', id)
          if (rowLockKey(row ?? { id }) !== seenKey)
            throw keyChanged('remove', id)
          const protect = options.protect
          if (protect) {
            const view: RemoveView = {
              row,
              config: tx.snapshot.config,
              state: tx.snapshot.state,
            }
            const reason = await runInsideHook('remove', () =>
              protect(id, view),
            )
            if (reason !== undefined)
              throw refusal('remove', id, 'row-protected', reason)
          }
          if (row) {
            tx.dropRosterRows(id)
            await tx.commitConfig()
          }
          if (orphan) {
            tx.dropStateAccount(id)
            await tx.commitState()
          }
          return { id, outcome: row ? 'removed' : 'completed' }
        },
      )
    },
  )
}

function hasStateAccount(state: Record<string, unknown>, id: string): boolean {
  const accounts = state.accounts
  return isRecord(accounts) && Object.hasOwn(accounts, id)
}

/** The id a roster row carries, or undefined for a row that names none. */
function rosterIdOf(raw: unknown): string | undefined {
  return isRecord(raw) && typeof raw.id === 'string' ? raw.id : undefined
}

/**
 * Why `ids` is not an order of this roster: it must name every distinct
 * roster id exactly once and nothing else.
 */
function orderProblem(
  roster: readonly unknown[],
  ids: readonly unknown[],
): string | undefined {
  if (!Array.isArray(ids)) return 'ids must be an array of roster ids'
  const rosterIds = new Set<string>()
  for (const raw of roster) {
    const id = rosterIdOf(raw)
    if (id !== undefined) rosterIds.add(id)
  }
  const given = new Set<string>()
  for (const id of ids) {
    if (typeof id !== 'string') return 'ids must be an array of roster ids'
    if (given.has(id)) return `id ${id} appears more than once`
    if (!rosterIds.has(id)) return `id ${id} is not in the roster`
    given.add(id)
  }
  const missing = [...rosterIds].filter((id) => !given.has(id))
  if (missing.length > 0)
    return `the order leaves out roster id(s) ${missing.join(', ')}`
  return undefined
}

/**
 * The roster in the new order. Every roster row is kept as the same object,
 * so its serialized bytes are unchanged. Rows that carry an id fill the
 * positions such rows held before, in the order of `ids`; a second row with
 * an already-seen id (invalid, but preserved) travels right after the first.
 * A row that names no id cannot be ordered by id, so it keeps its position.
 */
function reorderedRoster(
  roster: readonly unknown[],
  ids: readonly string[],
): unknown[] {
  const byId = new Map<string, unknown[]>()
  for (const raw of roster) {
    const id = rosterIdOf(raw)
    if (id === undefined) continue
    const group = byId.get(id)
    if (group) group.push(raw)
    else byId.set(id, [raw])
  }
  const sequence = ids.flatMap((id) => byId.get(id) ?? [])
  let next = 0
  return roster.map((raw) =>
    rosterIdOf(raw) === undefined ? raw : sequence[next++],
  )
}

/**
 * Sets the roster order in one config write. `ids` must name every roster id
 * exactly once; anything else refuses (`invalid-order`) before writing. The
 * roster rows, the per-row entries and the state file are left as they are:
 * only the order of the legacy `accounts` array changes, which older readers
 * load as is. It takes the extra locks, then the store locks, and no row or
 * provider-wide lock, since no row's credential, identity or quota changes.
 * An order equal to the current one writes nothing.
 */
export async function reorderRows(
  rt: StoreRuntime,
  ids: readonly string[],
  options: ReorderOptions = {},
): Promise<ReorderResult> {
  assertNotInsideHook('reorder')
  const { ctx } = rt
  const onFailure = options.onFailure
  return runOperation(
    ctx,
    'reorder',
    undefined,
    onFailure && ((_rowId, error) => onFailure(error)),
    async (locks, progress) => {
      for (const extra of options.extraLocks ?? []) await locks.acquire(extra)
      return withTransaction(
        ctx,
        locks,
        progress,
        { operation: 'reorder', rowId: undefined },
        async (tx): Promise<ReorderResult> => {
          const roster = tx.roster()
          const problem = orderProblem(roster, ids)
          if (problem)
            throw new PoolOperationError({
              operation: 'reorder',
              phase: 'before-first-write',
              retryable: false,
              kind: 'invalid-order',
              message: problem,
            })
          const order = [...ids]
          const next = reorderedRoster(roster, order)
          if (next.every((raw, index) => raw === roster[index]))
            return { ids: order, outcome: 'unchanged' }
          tx.config.accounts = next
          await tx.commitConfig()
          return { ids: order, outcome: 'reordered' }
        },
        // A reorder keeps every roster row and entry byte for byte, so it
        // leaves a torn row for a write on that row to complete.
        { completeTorn: false },
      )
    },
  )
}

/**
 * Records the wire identity an identity lookup found for a row's credential.
 * `attribution` is the credential epoch the lookup was issued for (a row
 * without an entry is at epoch 1): a lookup that completes after the row was
 * replaced is refused (`attribution`), as a quota reading would be, so the
 * first credential's account is never recorded on the second credential. A
 * row already recorded for another account refuses (`identity-mismatch`):
 * that is a replacement, not something learnt about the same credential.
 */
export async function recordRowIdentity(
  rt: StoreRuntime,
  id: string,
  identity: string,
  attribution: Pick<Attribution, 'credentialEpoch'>,
  options: RowOperationOptions = {},
): Promise<{ id: string; disabled: string[] }> {
  assertNotInsideHook('recordIdentity')
  return runOperation(
    rt.ctx,
    'recordIdentity',
    id,
    options.onFailure,
    async (locks, progress) => {
      if (typeof identity !== 'string' || identity.length === 0)
        throw refusal(
          'recordIdentity',
          id,
          'invalid-input',
          'identity must be non-empty',
        )
      const captured = isRecord(attribution)
        ? attribution.credentialEpoch
        : undefined
      if (!isCredentialEpoch(captured))
        throw refusal(
          'recordIdentity',
          id,
          'invalid-input',
          'the credential epoch the identity lookup was issued for is required',
        )
      const { row: seen } = await readRow(rt, 'recordIdentity', id)
      await locks.acquire(rowLockSpec(rt, seen))
      await locks.acquire(options.providerLock ?? rt.providerLock)
      for (const extra of options.extraLocks ?? []) await locks.acquire(extra)
      return withTransaction(
        rt.ctx,
        locks,
        progress,
        { operation: 'recordIdentity', rowId: id },
        async (tx) => {
          const row = requireUsableRow('recordIdentity', id, tx.row(id))
          if (rowLockKey(row) !== rowLockKey(seen))
            throw keyChanged('recordIdentity', id)
          requireBound('recordIdentity', row)
          if ((row.credentialEpoch ?? 1) !== captured)
            throw refusal(
              'recordIdentity',
              id,
              'attribution',
              `the identity for ${id} was looked up for a credential the row no longer holds`,
              true,
            )
          if (row.identity !== undefined && row.identity !== identity)
            throw identityMismatch('recordIdentity', id)
          // The stamp names the identity first; a crash before the config
          // write leaves a row every reader completes forward.
          if (row.identity === undefined)
            await stampIdentityIn(tx, row, identity)
          const disabled = recordIdentityIn(tx, id, identity)
          await tx.commitConfig()
          return { id, disabled }
        },
      )
    },
  )
}
