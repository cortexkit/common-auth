import type { Scope } from './scope.js'
import type { AccountKey, LimitKind, LimitSignal } from './signal.js'

export type MergeLaw = 'latest-evidence' | 'max-until' | 'overwrite'

export interface LimitMark {
  readonly scope: Scope
  readonly until: number
  readonly mergeLaw: MergeLaw
}

export interface FailureLadderAxes {
  readonly kind: 'failure-ladder'
  readonly mergeLaw: MergeLaw
  readonly hintFloorMs: number
  readonly quotaSteps: readonly number[]
  readonly byKind: Readonly<Partial<Record<LimitKind, number>>>
  readonly byReason: Readonly<Record<string, number>>
  readonly capacity: {
    readonly baseMs: number
    /** Maximum displacement on either side of baseMs. */
    readonly spreadMs: number
  }
  readonly defaultMs: number
}

export const ANTIGRAVITY_FAILURE_LADDER: FailureLadderAxes = Object.freeze({
  kind: 'failure-ladder',
  mergeLaw: 'max-until',
  hintFloorMs: 2000,
  quotaSteps: Object.freeze([60000, 300000, 1800000, 7200000]),
  byKind: Object.freeze({ 'rate-limit': 30000 }),
  byReason: Object.freeze({ 'server-error': 20000, unknown: 60000 }),
  capacity: Object.freeze({ baseMs: 45000, spreadMs: 15000 }),
  defaultMs: 60000,
})

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
  | FailureLadderAxes

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

function ladderMs(
  signal: LimitSignal,
  axes: FailureLadderAxes,
  history: MarkerHistory,
): number {
  const hint = signal.retryAfterMs
  if (hint !== undefined && Number.isFinite(hint) && hint > 0) {
    return Math.max(axes.hintFloorMs, hint)
  }
  const reasonDuration = Object.hasOwn(axes.byReason, signal.reason)
    ? axes.byReason[signal.reason]
    : undefined
  if (reasonDuration !== undefined) return reasonDuration
  if (signal.kind === 'quota-exhausted') {
    const count = history.failures?.get(accountKey(signal.account))?.count ?? 1
    const index = Math.min(axes.quotaSteps.length - 1, Math.max(0, count - 1))
    const step = axes.quotaSteps[index]
    if (step !== undefined) return step
  }
  const duration = axes.byKind[signal.kind]
  if (duration !== undefined) return duration
  if (signal.kind === 'capacity') {
    return (
      axes.capacity.baseMs +
      (2 * (history.random ?? 0.5) - 1) * axes.capacity.spreadMs
    )
  }
  return axes.defaultMs
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
      until = history.now + ladderMs(signal, axes, history)
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
