import type { Attribution } from './attribution.js'
import { PoolOperationError } from './errors.js'
import { assertNotInsideHook, runInsideHook } from './hooks.js'
import {
  DUPLICATE_IDENTITY_REASON,
  disableIdentityDuplicates,
  disableIn,
  recordIdentityIn,
} from './identity.js'
import {
  notReadyError,
  readPool,
  runOperation,
  type Transaction,
  withTransaction,
} from './mutate.js'
import type { PoolLockSpec } from './refresh-lock.js'
import {
  readRow,
  refusal,
  rowLockSpec,
  type StoreRuntime,
  unknownRow,
} from './runtime.js'
import {
  CREDENTIAL_STAMP_KEY,
  type CredentialBinding,
  credentialProblem,
  fingerprintOf,
  idProblem,
  isRecord,
  type PoolCredential,
  type PoolRow,
  rosterRowFor,
  rotationStamp,
  rowLockKey,
  type StoredCredential,
  stampFor,
  stateFieldsFor,
  storedCredential,
} from './schema.js'
import { bindReplacement } from './torn.js'

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
 * Writes a credential into the state file (one write), stamped with the
 * credential epoch the row's entry holds in `tx` (1 without an entry) and,
 * for a replace, the binding the config is about to get. A rotation is the
 * same lineage: no epoch bump, no identity or quota change.
 */
export async function rotateIn(
  rt: StoreRuntime,
  tx: Transaction,
  id: string,
  credential: PoolCredential,
  extra: {
    stamp?: number
    clearErrors?: boolean
    binding?: CredentialBinding
  } = {},
): Promise<StoredCredential> {
  const prior = tx.stateAccount(id)
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
  const raw = tx.rosterRow(id)
  const stored =
    credential.type === 'api' && isRecord(raw)
      ? storedCredential(
          {
            ...credential,
            baseURL: String(raw.baseURL ?? credential.baseURL),
            ...(raw.authHeader === 'x-api-key' ||
            raw.authHeader === 'authorization-bearer'
              ? { authHeader: raw.authHeader }
              : {}),
          },
          stamp,
        )
      : storedCredential(credential, stamp)
  const epoch = tx.entry(id)?.credentialEpoch
  tx.setStateAccount(id, {
    ...kept,
    ...stateFieldsFor(credential, stamp),
    [CREDENTIAL_STAMP_KEY]: stampFor(
      stored,
      typeof epoch === 'number' ? epoch : 1,
      extra.binding,
    ),
  })
  await tx.commitState(stored)
  return stored
}

function checkInput(
  operation: 'add' | 'replace' | 'rotate',
  id: string,
  credential: PoolCredential,
): void {
  const idIssue = operation === 'add' ? idProblem(id) : undefined
  if (idIssue) throw refusal(operation, id, 'invalid-input', idIssue)
  const credentialIssue = credentialProblem(credential)
  if (credentialIssue)
    throw refusal(operation, id, 'invalid-input', credentialIssue)
}

function requireUsableRow(
  operation: 'replace' | 'rotate' | 'recordIdentity' | 'disable' | 'enable',
  id: string,
  row: PoolRow | undefined,
  credential?: PoolCredential,
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
  operation: 'rotate' | 'recordIdentity',
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
            const stored = await rotateIn(rt, tx, same.id, credential)
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
            if (existing.type !== credential.type)
              throw refusal(
                'add',
                id,
                'type-mismatch',
                `row ${id} is a ${existing.type} row`,
              )
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
          const stored = await rotateIn(rt, tx, id, credential)
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
  input: { identity?: string } = {},
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
  credential: PoolCredential,
  input: { identity?: string } = {},
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
          // A rotation stays with one account: it may record the first
          // identity the row learns, but a credential of another known
          // account is a replacement (new epoch, quota and errors dropped).
          if (
            input.identity !== undefined &&
            row.identity !== undefined &&
            input.identity !== row.identity
          )
            throw identityMismatch('rotate', id)
          const stored = await rotateIn(rt, tx, id, credential)
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
 * Marks a row disabled. Since 0.2.3 it takes the row lock and the caller's
 * extra locks before the store locks, as the other row writes do, so it waits
 * for a refresh of the row instead of landing during its provider call.
 */
export async function disableRow(
  rt: StoreRuntime,
  id: string,
  reason: string,
  options: RowToggleOptions = {},
): Promise<{ id: string }> {
  assertNotInsideHook('disable')
  return runOperation(
    rt.ctx,
    'disable',
    id,
    options.onFailure,
    async (locks, progress) => {
      const { row: seen } = await readRow(rt, 'disable', id)
      await locks.acquire(rowLockSpec(rt, seen))
      for (const extra of options.extraLocks ?? []) await locks.acquire(extra)
      return withTransaction(
        rt.ctx,
        locks,
        progress,
        { operation: 'disable', rowId: id },
        async (tx) => {
          const row = tx.row(id)
          if (!row || !tx.rosterRow(id)) throw unknownRow('disable', id)
          if (rowLockKey(row) !== rowLockKey(seen))
            throw keyChanged('disable', id)
          disableIn(tx, id, reason)
          await tx.commitConfig()
          return { id }
        },
      )
    },
  )
}

/**
 * Clears a row's `enabled: false` and its `disabledReason` in one config
 * write. An OAuth row whose recorded identity another enabled OAuth row holds
 * stays disabled and the call refuses (`duplicate-identity`): the same rule
 * that makes `add` store such a row disabled. Enabling a row that is already
 * enabled writes nothing.
 */
export async function enableRow(
  rt: StoreRuntime,
  id: string,
  options: RowToggleOptions = {},
): Promise<{ id: string }> {
  assertNotInsideHook('enable')
  return runOperation(
    rt.ctx,
    'enable',
    id,
    options.onFailure,
    async (locks, progress) => {
      const { row: seen } = await readRow(rt, 'enable', id)
      await locks.acquire(rowLockSpec(rt, seen))
      for (const extra of options.extraLocks ?? []) await locks.acquire(extra)
      return withTransaction(
        rt.ctx,
        locks,
        progress,
        { operation: 'enable', rowId: id },
        async (tx) => {
          const row = requireUsableRow('enable', id, tx.row(id))
          if (rowLockKey(row) !== rowLockKey(seen))
            throw keyChanged('enable', id)
          if (row.enabled && row.disabledReason === undefined) return { id }
          if (row.type === 'oauth' && row.identity !== undefined) {
            const holder = tx
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
          const raw = tx.rosterRow(id) as Record<string, unknown>
          raw.enabled = true
          const entry = tx.entry(id)
          if (entry && 'disabledReason' in entry) {
            const next = { ...entry }
            delete next.disabledReason
            tx.setEntry(id, next)
          }
          await tx.commitConfig()
          return { id }
        },
      )
    },
  )
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
      if (
        typeof captured !== 'number' ||
        !Number.isInteger(captured) ||
        captured < 1
      )
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
          const disabled = recordIdentityIn(tx, id, identity)
          await tx.commitConfig()
          return { id, disabled }
        },
      )
    },
  )
}
