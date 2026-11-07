import type {
  CacheWarmStopReason,
  SessionCacheHours,
  SessionKeepWarmMode,
} from '../routing-accessor/cache-policy.js'

export type CacheKeepDecisionInput = {
  /** All times and the cache lifetime are in milliseconds. */
  now: number
  ttlMs: number
  lastRealRequestAt: number
  lastWarmAt?: number
  /** The caller resets the count and costs on every real request. */
  warmsSinceLastRealRequest: number
  /** Plugin-priced input-token equivalents; no prices are guessed here. */
  warmCostSoFar?: number
  nextWarmCost?: number
  rewriteCost?: number
} & (
  | { mode: 'hours'; hours: SessionCacheHours }
  | { mode: Exclude<SessionKeepWarmMode, 'hours'>; hours?: never }
)

export type CacheKeepDecision =
  | { action: 'warm'; at: number }
  | { action: 'wait'; until: number }
  | { action: 'stop'; reason: CacheWarmStopReason }

function withinHours(hours: SessionCacheHours, at: number): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: hours.tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const hour = parts.find((part) => part.type === 'hour')?.value
  const minute = parts.find((part) => part.type === 'minute')?.value
  const time = `${hour}:${minute}`
  return hours.from < hours.to
    ? time >= hours.from && time < hours.to
    : time >= hours.from || time < hours.to
}

/**
 * Decide the next idle or tool-wait warm using a validated mode/window. The
 * caller owns timers, session liveness and resetting counts/costs on real
 * requests. A warm is due before expiry, never in its final safety margin.
 *
 * Auto applies a cost cap only when all three plugin-priced costs are supplied;
 * without them this is timing only, and the plugin must apply its idle bounds.
 * No provider prices are inferred. Off returns unsupported; callers must not
 * report a stop for a session that never warmed.
 */
export function decideCacheKeep(
  input: CacheKeepDecisionInput,
): CacheKeepDecision {
  const {
    mode,
    now,
    ttlMs,
    lastRealRequestAt,
    lastWarmAt,
    warmsSinceLastRealRequest,
    warmCostSoFar,
    nextWarmCost,
    rewriteCost,
  } = input
  if (mode === 'off') return { action: 'stop', reason: 'unsupported' }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    return { action: 'stop', reason: 'unsupported' }
  }
  if (
    (mode === 'hours' || mode === 'always') &&
    warmsSinceLastRealRequest >= 24
  )
    return { action: 'stop', reason: 'count-cap' }
  if (
    mode === 'auto' &&
    warmCostSoFar !== undefined &&
    nextWarmCost !== undefined &&
    rewriteCost !== undefined &&
    warmCostSoFar + nextWarmCost >= rewriteCost
  )
    return { action: 'stop', reason: 'cost-cap' }

  const last = Math.max(lastRealRequestAt, lastWarmAt ?? lastRealRequestAt)
  const expiresAt = last + ttlMs
  const due = expiresAt - Math.min(30_000, ttlMs / 2)
  const at = Math.max(now, due)
  // Replaying inside the expiry margin risks paying for a cold cache rewrite.
  if (at >= expiresAt - Math.min(5_000, ttlMs / 10)) {
    return { action: 'stop', reason: 'cost-cap' }
  }
  if (
    mode === 'hours' &&
    (!withinHours(input.hours, due) || !withinHours(input.hours, at))
  )
    return { action: 'stop', reason: 'outside-hours' }
  return now < due ? { action: 'wait', until: due } : { action: 'warm', at }
}
