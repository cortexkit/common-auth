import type { PoolOperationError } from './errors.js'
import { assertNotInsideHook } from './hooks.js'
import {
  DUPLICATE_IDENTITY_REASON,
  disableIdentityDuplicates,
  disableIn,
  recordIdentityIn,
} from './identity.js'
import { runOperation, type Transaction, withTransaction } from './mutate.js'
import type { PoolLockSpec } from './refresh-lock.js'
import {
  readRow,
  refusal,
  rowLockSpec,
  type StoreRuntime,
  unknownRow,
} from './runtime.js'
import {
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
  stateFieldsFor,
  storedCredential,
} from './schema.js'

export type FailureHook = (
  rowId: string,
  error: PoolOperationError,
) => void | Promise<void>

export interface RowOperationOptions {
  /** Called once, awaited, on every non-success path, before locks release. */
  onFailure?: FailureHook
  /** The provider-wide lock, when an operation may change identity keying. */
  providerLock?: PoolLockSpec
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
 * Writes a rotated credential into the state file (one write). A rotation is
 * the same lineage: no epoch bump, no identity or quota change.
 */
export async function rotateIn(
  rt: StoreRuntime,
  tx: Transaction,
  id: string,
  credential: PoolCredential,
  extra: { stamp?: number; clearErrors?: boolean } = {},
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
  tx.setStateAccount(id, { ...kept, ...stateFieldsFor(credential, stamp) })
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
  operation: 'replace' | 'rotate' | 'recordIdentity' | 'disable',
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

/** Keying changed between the unlocked read and the locked one: retry. */
function keyChanged(
  operation: 'replace' | 'rotate' | 'recordIdentity',
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
            // Completes an add interrupted between its two writes.
            if (!existing.hasEntry) {
              tx.setEntry(id, {
                credentialEpoch: 1,
                needsFirstReading: credential.type === 'oauth',
              })
              await tx.commitConfig()
            }
            const stored = await rotateIn(rt, tx, id, credential, {
              clearErrors: true,
            })
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
          await tx.commitConfig()
          const stored = await rotateIn(rt, tx, id, credential)
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
      return withTransaction(
        ctx,
        locks,
        progress,
        { operation: 'replace', rowId: id },
        async (tx) => {
          const row = requireUsableRow('replace', id, tx.row(id), credential)
          if (rowLockKey(row) !== rowLockKey(seen))
            throw keyChanged('replace', id)
          const entry = tx.entry(id) ?? {}
          const priorEpoch =
            typeof entry.credentialEpoch === 'number'
              ? entry.credentialEpoch
              : 1
          const credentialEpoch = priorEpoch + 1
          const nextEntry: Record<string, unknown> = {
            ...entry,
            credentialEpoch,
            needsFirstReading: true,
          }
          delete nextEntry.quota
          tx.setEntry(id, nextEntry)
          const raw = tx.rosterRow(id) as Record<string, unknown>
          if (input.identity !== undefined) raw.accountId = input.identity
          else delete raw.accountId
          if (credential.type === 'api') {
            raw.baseURL = credential.baseURL.trim()
            raw.authHeader = credential.authHeader ?? 'authorization-bearer'
          }
          if (input.identity !== undefined)
            disableIdentityDuplicates(tx, input.identity)
          await tx.commitConfig()
          const stored = await rotateIn(rt, tx, id, credential, {
            clearErrors: true,
          })
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
      return withTransaction(
        ctx,
        locks,
        progress,
        { operation: 'rotate', rowId: id },
        async (tx) => {
          const row = requireUsableRow('rotate', id, tx.row(id), credential)
          if (rowLockKey(row) !== rowLockKey(seen))
            throw keyChanged('rotate', id)
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

export async function disableRow(
  rt: StoreRuntime,
  id: string,
  reason: string,
  options: Pick<RowOperationOptions, 'onFailure'> = {},
): Promise<{ id: string }> {
  assertNotInsideHook('disable')
  return runOperation(
    rt.ctx,
    'disable',
    id,
    options.onFailure,
    async (locks, progress) =>
      withTransaction(
        rt.ctx,
        locks,
        progress,
        { operation: 'disable', rowId: id },
        async (tx) => {
          if (!tx.rosterRow(id)) throw unknownRow('disable', id)
          disableIn(tx, id, reason)
          await tx.commitConfig()
          return { id }
        },
      ),
  )
}

export async function recordRowIdentity(
  rt: StoreRuntime,
  id: string,
  identity: string,
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
      const { row: seen } = await readRow(rt, 'recordIdentity', id)
      await locks.acquire(rowLockSpec(rt, seen))
      await locks.acquire(options.providerLock ?? rt.providerLock)
      return withTransaction(
        rt.ctx,
        locks,
        progress,
        { operation: 'recordIdentity', rowId: id },
        async (tx) => {
          const row = requireUsableRow('recordIdentity', id, tx.row(id))
          if (rowLockKey(row) !== rowLockKey(seen))
            throw keyChanged('recordIdentity', id)
          const disabled = recordIdentityIn(tx, id, identity)
          await tx.commitConfig()
          return { id, disabled }
        },
      )
    },
  )
}
