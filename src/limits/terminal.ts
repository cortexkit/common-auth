import type { SessionActivity } from './activity.js'
import { effectiveCacheTtlMs } from './activity.js'
import type { LimitAxes } from './axes.js'
import type {
  LimitDecision,
  PolicyFacts,
  TerminalFacts,
  WaitCheckpoint,
} from './decide.js'
import { MAX_SAME_ACCOUNT_HOLD_MS, readMaxSameAccountWait } from './hold.js'
import type { RequestHistory } from './request-history.js'
import { sameAccount } from './request-history.js'
import type { FamilyOf, Scope } from './scope.js'
import { scopeCovers } from './scope.js'
import type { AccountKey } from './signal.js'

export interface TerminalWindow {
  readonly window: string
  readonly scope: Scope
  /** The caller evaluates quota thresholds, not just provider exhaustion. */
  readonly blockedBy?: 'exhausted' | 'floor' | 'killswitch-floor'
  readonly reset?: {
    readonly at: number
    /** Provenance of this reset field, never the enclosing row's update time. */
    readonly observedAt?: number
    readonly checkedAt?: number
  }
}

export interface TerminalCandidate {
  readonly account: AccountKey
  readonly readingAccount: AccountKey
  readonly identity?: string
  readonly readingIdentity?: string
  readonly windows: readonly TerminalWindow[]
}

export interface TerminalScanFacts {
  /** Candidate keys come from the caller's scoped/general terminal scan. */
  readonly candidates: readonly TerminalCandidate[]
  readonly effectiveModel: string
  readonly familyOf: FamilyOf
  readonly maxAgeMs: number
  readonly maxSameAccountWait?: unknown
  readonly activity?: SessionActivity
  /** Current session account, used to reject another account's cache record. */
  readonly accountKey?: AccountKey
}

export interface TerminalReset {
  readonly account: AccountKey
  readonly resetAt: number
  readonly checkpoint: WaitCheckpoint
}

/**
 * Take each account's latest blocking reset, then the earliest across accounts.
 * A missing identity is compatible, but readings from before re-login are not.
 */
export function scanTerminalReset(
  input: TerminalScanFacts,
  now: number,
): TerminalReset | undefined {
  if (!Number.isFinite(input.maxAgeMs) || input.maxAgeMs < 0) return undefined
  let best: TerminalReset | undefined
  for (const candidate of input.candidates) {
    if (
      !sameAccount(candidate.account, candidate.readingAccount) ||
      (candidate.identity !== undefined &&
        candidate.readingIdentity !== undefined &&
        candidate.identity !== candidate.readingIdentity)
    )
      continue
    const blockers = candidate.windows.filter(
      (window) =>
        window.blockedBy &&
        scopeCovers(window.scope, input.effectiveModel, input.familyOf),
    )
    if (!blockers.length) continue
    const resets = blockers.map((window) => {
      const reset = window.reset
      const capturedAt = reset?.observedAt ?? reset?.checkedAt
      return reset &&
        capturedAt !== undefined &&
        Number.isFinite(capturedAt) &&
        now - capturedAt <= input.maxAgeMs &&
        Number.isFinite(reset.at) &&
        reset.at > now
        ? reset.at
        : undefined
    })
    // One unknown blocking window means this account has no known release time.
    if (resets.some((reset) => reset === undefined)) continue
    const resetAt = Math.max(...(resets as number[]))
    if (best && best.resetAt <= resetAt) continue
    const floorDefined = blockers.some(
      (window) =>
        window.blockedBy !== 'exhausted' && window.reset?.at === resetAt,
    )
    best = {
      account: candidate.account,
      resetAt,
      checkpoint: {
        accountKey: { ...candidate.account },
        decidedAt: now,
        blockers: floorDefined
          ? []
          : blockers.flatMap((window) =>
              window.blockedBy === 'exhausted' && window.reset
                ? [
                    {
                      window: window.window,
                      resetAt: window.reset.at,
                    },
                  ]
                : [],
            ),
      },
    }
  }
  return best
}

function applies(metadata: TerminalFacts, axes: LimitAxes): boolean {
  return (
    metadata.source === 'pool' &&
    metadata.reason === 'quota' &&
    axes.terminalMetadata === 'setting-capped-fresh'
  )
}

export function terminalWaitDisabled(
  metadata: TerminalFacts,
  axes: LimitAxes,
): boolean {
  return (
    applies(metadata, axes) &&
    readMaxSameAccountWait(metadata.scan?.maxSameAccountWait) === 0
  )
}

/**
 * When no account is ready, cap the wait by the setting rather than cache expiry.
 * Unlike a same-account hold, this wait may proceed without a cache activity record.
 */
export function terminalRefusalDecision(
  facts: PolicyFacts,
  axes: LimitAxes,
  history: RequestHistory,
  metadata: TerminalFacts,
): LimitDecision | undefined {
  if (!applies(metadata, axes)) return undefined
  const scan = metadata.scan
  const setting = readMaxSameAccountWait(scan?.maxSameAccountWait)
  const kept = scan && scanTerminalReset(scan, facts.now)
  const base = kept ? kept.resetAt - facts.now : 300000
  const record = scan?.activity
  const account = scan?.accountKey ?? facts.attempted
  const ttl =
    record && account && sameAccount(record.accountKey, account)
      ? effectiveCacheTtlMs(record.ttlMs) || 300000
      : 300000
  const delayMs = Math.min(base, setting === 'max' ? ttl : 900000)
  const final =
    setting === 0 || (facts.host === 'pi' && facts.wake?.kind === 'terminal')
  const retryAfterMs = final ? (kept ? base : undefined) : delayMs
  const policy = axes.refusals.quota[facts.host]
  const refuse: LimitDecision = {
    action: 'refuse',
    reason: 'quota',
    family:
      facts.host === 'pi' ? 'pi-final' : final ? 'json-412' : policy.family,
    messageKey: metadata.messageKey ?? policy.messageKey,
    retryable: facts.host !== 'pi' && !final,
    hostRetry: facts.host === 'pi' || final ? 'veto' : 'leave',
    history,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(kept ? { resetAt: kept.resetAt } : {}),
  }
  if (!kept || final || facts.host === 'opencode1') return refuse
  const wait = {
    delayMs,
    retryAfterMs: delayMs,
    resetAt: kept.resetAt,
    target: facts.now + delayMs,
    checkpoint: kept.checkpoint,
    waitKind: 'terminal' as const,
    reason: 'terminal-quota',
    retryable: true,
    hostRetry: 'leave' as const,
    history,
  }
  if (facts.host === 'pi') return { ...wait, action: 'wait-then-reselect' }
  if (facts.hostPhase !== 'retry') return refuse
  if (facts.remainingRetries !== undefined && facts.remainingRetries < 1)
    return {
      action: 'pass',
      reason: 'host-retries-exhausted',
      retryable: true,
      hostRetry: 'leave',
      history,
    }
  if (
    facts.remainingRetries === undefined ||
    delayMs > MAX_SAME_ACCOUNT_HOLD_MS
  )
    return refuse
  return { ...wait, action: 'hold', account: kept.account }
}
