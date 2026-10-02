import { PoolOperationError } from './errors.js'
import { assertNotInsideHook, runInsideHook } from './hooks.js'
import { recordIdentityIn } from './identity.js'
import { type Progress, runOperation, withTransaction } from './mutate.js'
import type { PoolLockSpec } from './refresh-lock.js'
import { type FailureHook, rotateIn } from './rows.js'
import {
  readRow,
  refusal,
  requireBound,
  rowLockSpec,
  type StoreRuntime,
} from './runtime.js'
import {
  type OAuthCredential,
  type PoolRow,
  rotationStamp,
  rotationStampUntrusted,
  rowLockKey,
  type StoredCredential,
} from './schema.js'

/** What the injected provider refresh function returns. */
export interface ProviderRefreshResult {
  access: string
  refresh: string
  expires: number
  expiresIn?: number
  /** The account's wire identity, when the provider reports one. */
  identity?: string
}

export type ProviderRefresh = (
  credential: OAuthCredential & { lastRefreshedAt?: number },
  row: PoolRow,
) => Promise<ProviderRefreshResult>

export interface RefreshOptions {
  /** The one provider-wide lock serialising every provider call. */
  providerLock?: PoolLockSpec
  /** Taken after the provider-wide lock in this order, released in reverse. */
  extraLocks?: readonly PoolLockSpec[]
  /** Awaited once the rotation is persisted and the store locks released. */
  onPersisted?: (
    rowId: string,
    credential: StoredCredential,
  ) => void | Promise<void>
  onFailure?: FailureHook
  /**
   * Awaited before any lock is taken, on the locked re-read, and at commit
   * time under the store locks; a reason refuses the refresh there, leaving
   * the stored credential untouched and discarding any rotated material.
   */
  refuse?: (row: PoolRow) => string | undefined | Promise<string | undefined>
}

export type RefreshOutcome =
  | {
      status: 'rotated'
      rowId: string
      credential: StoredCredential
      identity?: string
    }
  | { status: 'refused'; rowId: string; reason: string }

type Captured = {
  row: PoolRow
  credential: OAuthCredential & { lastRefreshedAt?: number }
  credentialEpoch: number
  identity: string | undefined
}

function requireRefreshable(id: string, row: PoolRow | undefined): PoolRow {
  if (!row)
    throw refusal('refresh', id, 'unknown-row', `no row ${id} in the pool`)
  if (row.invalid)
    throw refusal('refresh', id, 'invalid-row', `row ${id} is invalid`)
  if (row.type !== 'oauth' || row.credential?.type !== 'oauth')
    throw refusal(
      'refresh',
      id,
      'no-credential',
      `row ${id} holds no OAuth credential`,
    )
  if (!row.enabled)
    throw refusal('refresh', id, 'row-disabled', `row ${id} is disabled`)
  return row
}

function stampAhead(id: string): PoolOperationError {
  return refusal(
    'refresh',
    id,
    'refresh-stamp-ahead',
    `row ${id}'s stored refresh stamp is ahead of the clock; a rotation now could not be stamped newer within the trust bound`,
    true,
  )
}

/**
 * Refreshes one OAuth row. Locks are taken in the fixed order row lock,
 * provider-wide lock, extra locks, and the store locks only around the
 * capture and the commit; ownership of every held lease is asserted after
 * each wait, immediately before the provider call and before each write.
 */
export async function refreshRow(
  rt: StoreRuntime,
  id: string,
  provider: ProviderRefresh,
  options: RefreshOptions = {},
): Promise<RefreshOutcome> {
  assertNotInsideHook('refresh')
  const { ctx } = rt
  return runOperation(
    ctx,
    'refresh',
    id,
    options.onFailure,
    async (locks, progress): Promise<RefreshOutcome> => {
      const { row: seen } = await readRow(rt, 'refresh', id)
      requireRefreshable(id, seen)
      const early = await options.refuse?.(seen)
      if (early !== undefined)
        return { status: 'refused', rowId: id, reason: early }

      let key = rowLockKey(seen)
      let captured: Captured | undefined
      for (let attempt = 0; ; attempt++) {
        await locks.acquire(
          rowLockSpec(rt, { id, identity: key === id ? undefined : key }),
        )
        await locks.acquire(options.providerLock ?? rt.providerLock)
        for (const extra of options.extraLocks ?? []) await locks.acquire(extra)
        // The capture may write the config once, to give a row its per-row
        // entry. That write is setup, not the rotation, so it is counted apart
        // and never makes a later failure report `after-first-write`.
        const captureProgress: Progress = { writes: 0 }
        const read = await withTransaction(
          ctx,
          locks,
          captureProgress,
          { operation: 'refresh', rowId: id },
          async (
            tx,
          ): Promise<Captured | { keyNow: string } | { refused: string }> => {
            let row = requireRefreshable(id, tx.row(id))
            requireBound('refresh', row)
            if (!row.hasEntry) {
              tx.setEntry(id, { credentialEpoch: 1, needsFirstReading: true })
              await tx.commitConfig()
              row = requireRefreshable(id, tx.row(id))
            }
            if (rowLockKey(row) !== key) return { keyNow: rowLockKey(row) }
            const reason = await options.refuse?.(row)
            if (reason !== undefined) return { refused: reason }
            return {
              row,
              credential: row.credential as Captured['credential'],
              credentialEpoch: row.credentialEpoch as number,
              identity: row.identity,
            }
          },
        )
        if ('refused' in read)
          return { status: 'refused', rowId: id, reason: read.refused }
        if ('keyNow' in read) {
          await locks.releaseAll()
          if (attempt >= 1)
            throw refusal(
              'refresh',
              id,
              'row-key-changed',
              `row ${id}'s wire identity changed twice while its lock was held`,
              true,
            )
          key = read.keyNow
          continue
        }
        captured = read
        break
      }

      if (
        rotationStampUntrusted(captured.credential.lastRefreshedAt, ctx.now())
      )
        throw stampAhead(id)
      await ctx.hold?.('refresh-before-provider', id)
      await locks.assertAll()
      let result: ProviderRefreshResult
      try {
        result = await provider(captured.credential, captured.row)
      } catch (cause) {
        throw new PoolOperationError({
          operation: 'refresh',
          rowId: id,
          phase: 'before-first-write',
          retryable: true,
          kind: 'provider',
          message: 'the provider refresh failed',
          cause,
        })
      }
      if (typeof result?.refresh !== 'string' || !result.refresh.trim())
        throw refusal(
          'refresh',
          id,
          'provider',
          'the provider returned no refresh token',
          true,
        )

      const commit = await withTransaction(
        ctx,
        locks,
        progress,
        { operation: 'refresh', rowId: id },
        async (tx) => {
          const current = tx.row(id)
          const entry = tx.entry(id)
          if (
            !current ||
            current.invalid ||
            !entry ||
            entry.credentialEpoch !== captured.credentialEpoch ||
            current.identity !== captured.identity
          )
            throw new PoolOperationError({
              operation: 'refresh',
              rowId: id,
              phase: 'before-first-write',
              retryable: true,
              kind: 'attribution',
              message: `row ${id} changed credential while its refresh was in flight; the rotation is discarded`,
            })
          // The epoch fence above does not see a credential another writer
          // swapped in under the same epoch; the stamp does, and committing
          // the rotation would stamp the swapped row as bound.
          requireBound('refresh', current)
          const reason = await options.refuse?.(current)
          if (reason !== undefined) return { refused: reason } as const
          const now = ctx.now()
          const prior =
            current.credential?.type === 'oauth'
              ? current.credential.lastRefreshedAt
              : undefined
          if (rotationStampUntrusted(prior, now)) throw stampAhead(id)
          const credential: OAuthCredential = {
            type: 'oauth',
            access: result.access,
            refresh: result.refresh,
            expires: result.expires,
          }
          const learnt =
            current.identity === undefined && result.identity
              ? result.identity
              : undefined
          // The rotated credential's stamp names a learnt identity before the
          // config records it, so a crash between the two writes is completed
          // forward rather than leaving an identity no stamp proves.
          const stored = await rotateIn(rt, tx, id, credential, {
            stamp: rotationStamp(prior, now),
            identity: learnt,
          })
          let identity = current.identity
          if (learnt !== undefined) {
            recordIdentityIn(tx, id, learnt)
            identity = learnt
            await tx.commitConfig()
          }
          return { stored, identity, refused: undefined }
        },
      )
      if (commit.refused !== undefined)
        return { status: 'refused', rowId: id, reason: commit.refused }

      if (options.onPersisted) {
        try {
          const persisted = options.onPersisted
          await runInsideHook('refresh', () => persisted(id, commit.stored))
        } catch (cause) {
          throw new PoolOperationError({
            operation: 'refresh',
            rowId: id,
            phase: 'after-first-write',
            retryable: false,
            kind: 'after-persist-hook',
            committed: commit.stored,
            message:
              'the after-persist hook threw; the rotation stays committed',
            cause,
          })
        }
      }
      return {
        status: 'rotated',
        rowId: id,
        credential: commit.stored,
        ...(commit.identity !== undefined ? { identity: commit.identity } : {}),
      }
    },
  )
}
