import { sameAccount } from './request-history.js'
import type { AccountKey } from './signal.js'

export interface SessionActivity {
  readonly accountKey: AccountKey
  readonly lastAcceptedAt: number
  readonly ttlMs: number
}

export interface AcceptedActivity {
  readonly sessionId: string
  readonly accountKey: AccountKey
  /** The authoritative account key at completion, not the key at request start. */
  readonly currentAccountKey: AccountKey
  readonly lastAcceptedAt: number
  /** TTLs of prompt segments cached by this response, or their single longest TTL. */
  readonly ttlMs?: number | readonly number[]
}

export interface SessionActivityStore {
  readonly size: number
  /** Call for accepted responses and successful (2xx) keep-warm prewarms. */
  recordAccepted(input: AcceptedActivity): boolean
  get(sessionId: string): SessionActivity | undefined
  /** Call both when forgetting a session and when the host deletes it. */
  forgetSession(sessionId: string): void
}

export function effectiveCacheTtlMs(ttlMs: number | undefined): number {
  return ttlMs !== undefined && Number.isFinite(ttlMs) && ttlMs >= 0
    ? ttlMs
    : 300000
}

/** One process-local cache record per session; no credential or store I/O. */
export function createSessionActivityStore(): SessionActivityStore {
  const records = new Map<string, SessionActivity>()
  return {
    get size() {
      return records.size
    },
    recordAccepted(input) {
      if (
        !sameAccount(input.accountKey, input.currentAccountKey) ||
        !Number.isFinite(input.lastAcceptedAt)
      )
        return false
      const previous = records.get(input.sessionId)
      // Late completions must not replace more recent accepted cache activity.
      if (previous && previous.lastAcceptedAt > input.lastAcceptedAt)
        return false
      const ttls = typeof input.ttlMs === 'number' ? [input.ttlMs] : input.ttlMs
      const ttlMs = ttls?.length
        ? Math.max(...ttls.map(effectiveCacheTtlMs))
        : effectiveCacheTtlMs(undefined)
      records.set(
        input.sessionId,
        Object.freeze({
          accountKey: Object.freeze({ ...input.accountKey }),
          lastAcceptedAt: input.lastAcceptedAt,
          ttlMs,
        }),
      )
      if (records.size > 256) {
        let oldest: string | undefined
        let acceptedAt = Number.POSITIVE_INFINITY
        for (const [sessionId, record] of records) {
          if (record.lastAcceptedAt < acceptedAt) {
            oldest = sessionId
            acceptedAt = record.lastAcceptedAt
          }
        }
        if (oldest !== undefined) records.delete(oldest)
      }
      return true
    },
    get(sessionId) {
      return records.get(sessionId)
    },
    forgetSession(sessionId) {
      records.delete(sessionId)
    },
  }
}
