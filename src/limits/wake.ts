import type { WaitCheckpoint } from './decide.js'
import { sameAccount } from './request-history.js'
import type { AccountKey, LimitWindow } from './signal.js'

export interface WakeFacts {
  readonly checkpoint: WaitCheckpoint
  readonly target: number
  /**
   * Ordinary holds require this session/account's provider prompt cache to
   * remain valid; terminal waits instead wait for pool quota, without a cache.
   */
  readonly kind?: 'hold' | 'terminal'
}

/**
 * Snapshot exhaustion blockers only. A wait caused by a minimum-remaining quota
 * threshold supplies no windows: elapsed time cannot prove renewed headroom.
 */
export function waitCheckpoint(
  accountKey: AccountKey,
  decidedAt: number,
  windows: readonly LimitWindow[],
): WaitCheckpoint {
  return {
    accountKey: { ...accountKey },
    decidedAt,
    blockers: windows
      .filter((window) => window.confirmed && Number.isFinite(window.resetAt))
      .map((window) => ({
        window: window.window,
        resetAt: window.resetAt as number,
      })),
  }
}

/**
 * Match exhaustion evidence for one wake dispatch, without refreshing quota.
 * The caller must still check admission, other blockers and any cache bound.
 */
export function liftedWindowsForWake(
  wake: WakeFacts,
  account: AccountKey,
  windows: readonly LimitWindow[],
  now: number,
): readonly string[] {
  const { checkpoint, target } = wake
  if (
    !sameAccount(account, checkpoint.accountKey) ||
    !Number.isFinite(target) ||
    !Number.isFinite(checkpoint.decidedAt) ||
    target < checkpoint.decidedAt ||
    !Number.isFinite(now) ||
    now < target
  )
    return []
  const canLift = (window: LimitWindow) => {
    const resetAt = window.resetAt
    return (
      window.confirmed &&
      resetAt !== undefined &&
      Number.isFinite(resetAt) &&
      resetAt <= target &&
      checkpoint.blockers.some(
        (blocker) =>
          blocker.window === window.window &&
          Number.isFinite(blocker.resetAt) &&
          resetAt <= blocker.resetAt,
      )
    )
  }
  return windows
    .filter(
      (window) =>
        canLift(window) &&
        windows
          .filter((other) => other.confirmed && other.window === window.window)
          .every(canLift),
    )
    .map((window) => window.window)
}
