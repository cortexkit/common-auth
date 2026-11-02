import type { Scope } from './scope.js'
import type { AccountKey, LimitSignal } from './signal.js'

export type MergeLaw = 'latest-evidence' | 'max-until' | 'overwrite'

export interface LimitMark {
  readonly scope: Scope
  readonly until: number
  readonly mergeLaw: MergeLaw
}

export type MarkerAxes =
  | { readonly kind: 'off' }
  | {
      readonly kind: 'hint'
      readonly mergeLaw: MergeLaw
      readonly defaultMs: number
      readonly minimumMs: number
      readonly zero: 'accept' | 'skip'
      /** Core absolute dates and host event-relative hints use different samples. */
      readonly hintClock: 'signal' | 'marker'
    }
  | {
      readonly kind: 'reset'
      readonly mergeLaw: MergeLaw
      readonly defaultMs: number
    }
  | { readonly kind: 'failure-ladder'; readonly mergeLaw: MergeLaw }

export interface FailureStreak {
  readonly count: number
  readonly lastFailureAt: number
}

/** Owned by the process, not a persisted registry snapshot. */
export type FailureHistory = ReadonlyMap<string, FailureStreak>

export type FailureEvent =
  | {
      readonly type: 'failure'
      readonly account: AccountKey
      readonly at: number
    }
  | { readonly type: 'success'; readonly account: AccountKey }

function accountKey(account: AccountKey): string {
  return JSON.stringify([
    account.namespace,
    account.accountId,
    account.incarnation,
  ])
}

/** Feed committed marker events, not repeated reducer evaluations, into history. */
export function reduceFailureHistory(
  history: FailureHistory,
  event: FailureEvent,
  ttlMs = 3600000,
): FailureHistory {
  const next = new Map(history)
  const key = accountKey(event.account)
  if (event.type === 'success') {
    next.delete(key)
  } else {
    const previous = history.get(key)
    const count =
      !previous || event.at - previous.lastFailureAt > ttlMs
        ? 1
        : previous.count + 1
    next.set(key, { count, lastFailureAt: event.at })
  }
  return next
}

export interface MarkerHistory {
  readonly now: number
  /** Includes the current failure event; success removes only that account's streak. */
  readonly failures?: FailureHistory
  /** Uniform sample in [0, 1] for the capacity fallback duration; omitted means midpoint. */
  readonly random?: number
}

function ladderMs(signal: LimitSignal, history: MarkerHistory): number {
  const hint = signal.retryAfterMs
  if (hint !== undefined && Number.isFinite(hint) && hint > 0) {
    return Math.max(2000, hint)
  }
  if (signal.reason === 'server-error') return 20000
  if (signal.reason === 'unknown') return 60000
  switch (signal.kind) {
    case 'quota-exhausted': {
      const count =
        history.failures?.get(accountKey(signal.account))?.count ?? 1
      if (count <= 1) return 60000
      if (count === 2) return 300000
      if (count === 3) return 1800000
      return 7200000
    }
    case 'rate-limit':
      return 30000
    case 'capacity':
      return 45000 + 30000 * (history.random ?? 0.5) - 15000
    default:
      return 60000
  }
}

/** No clocks, random draws, state updates or I/O occur while producing a mark. */
export function markFromSignal(
  signal: LimitSignal | undefined,
  axes: MarkerAxes,
  history: MarkerHistory,
): LimitMark | undefined {
  if (!signal || axes.kind === 'off') return undefined
  let until: number
  switch (axes.kind) {
    case 'failure-ladder':
      until = history.now + ladderMs(signal, history)
      break
    case 'hint': {
      const hint = signal.retryAfterMs
      const usable =
        hint !== undefined &&
        Number.isFinite(hint) &&
        (hint > 0 || (hint === 0 && axes.zero === 'accept'))
      until = usable
        ? (axes.hintClock === 'signal' ? signal.observedAt : history.now) +
          Math.max(axes.minimumMs, hint)
        : history.now + axes.defaultMs
      break
    }
    case 'reset': {
      const resets = signal.windows
        .map((window) => window.resetAt)
        .filter(
          (reset): reset is number =>
            reset !== undefined &&
            Number.isFinite(reset) &&
            reset > history.now,
        )
      until = resets.length ? Math.max(...resets) : history.now + axes.defaultMs
      break
    }
  }
  return Number.isFinite(until)
    ? { scope: signal.scope, until, mergeLaw: axes.mergeLaw }
    : undefined
}

export function markIsActive(mark: LimitMark, now: number): boolean {
  return now < mark.until
}
