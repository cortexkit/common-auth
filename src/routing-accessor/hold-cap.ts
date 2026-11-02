import type { SessionActivity } from '../limits/activity.js'
import { sameAccountHoldFacts } from '../limits/hold.js'
import type { AccountKey } from '../limits/signal.js'

export function routingHandle(
  sessionId: string,
): Record<string, unknown> | undefined {
  // The bridge can load after the auth plugin, so never cache the accessor.
  const routing: unknown = Reflect.get(
    globalThis,
    Symbol.for('cortexkit.routing'),
  )
  if (typeof routing !== 'function') return undefined
  const handle: unknown = routing(sessionId)
  return typeof handle === 'object' && handle !== null
    ? (handle as Record<string, unknown>)
    : undefined
}

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
