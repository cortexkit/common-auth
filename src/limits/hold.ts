import type { SessionActivity } from './activity.js'
import { effectiveCacheTtlMs } from './activity.js'
import type { HoldFacts } from './decide.js'
import { sameAccount } from './request-history.js'
import type { AccountKey } from './signal.js'

export type MaxSameAccountWait = 0 | 15 | 'max'

export const MAX_SAME_ACCOUNT_HOLD_MS = 3_621_000

/** Pass routing.maxSameAccountWait without coercing persisted values. */
export function readMaxSameAccountWait(value: unknown): MaxSameAccountWait {
  return value === 0 || value === 15 || value === 'max' ? value : 15
}

/** Resolve a session snapshot into the pure reducer's same-account bounds. */
export function sameAccountHoldFacts(input: {
  readonly activity?: SessionActivity
  readonly accountKey: AccountKey
  readonly maxSameAccountWait?: unknown
}): HoldFacts | undefined {
  const setting = readMaxSameAccountWait(input.maxSameAccountWait)
  const record = input.activity
  if (
    setting === 0 ||
    !record ||
    !sameAccount(record.accountKey, input.accountKey) ||
    !Number.isFinite(record.lastAcceptedAt)
  )
    return undefined
  const ttlMs = effectiveCacheTtlMs(record.ttlMs)
  const cacheExpiresAt = record.lastAcceptedAt + ttlMs
  if (ttlMs === 0 || !Number.isFinite(cacheExpiresAt)) return undefined
  return {
    cacheExpiresAt,
    maxWaitMs: setting === 'max' ? Number.POSITIVE_INFINITY : 900000,
  }
}
