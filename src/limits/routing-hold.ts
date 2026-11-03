import { routingHandle } from '../routing-accessor/handle.js'
import type { SessionActivity } from './activity.js'
import { sameAccountHoldFacts } from './hold.js'
import type { AccountKey } from './signal.js'

/**
 * Cap routing advice by the current account's accepted prompt-cache activity.
 * Pass the authoritative account key so a replacement cannot reuse an old cache.
 * Without a usable routing handle, leave the optional advice cap unset.
 */
export function holdWaitMaxS(input: {
  readonly sessionId: string
  /** Snapshot from the activity store's get(sessionId). */
  readonly activity?: SessionActivity
  readonly accountKey: AccountKey
  /** Pass routing.maxSameAccountWait without coercing persisted values. */
  readonly maxSameAccountWait?: unknown
  readonly now: number
}): number | undefined {
  try {
    const handle = routingHandle(input.sessionId)
    if (!handle || typeof handle.accountFor !== 'function') return undefined
  } catch {
    // An optional bridge failure must not break authentication.
    return undefined
  }
  const hold = sameAccountHoldFacts(input)
  if (!hold || !Number.isFinite(input.now)) return 0
  return Math.floor(
    Math.max(0, Math.min(hold.maxWaitMs, hold.cacheExpiresAt - input.now)) /
      1000,
  )
}
