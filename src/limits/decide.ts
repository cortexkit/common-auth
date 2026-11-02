import type {
  DecisionFamily,
  LimitAxes,
  LimitHost,
  RefusalReason,
} from './axes.js'
import type { HostRetry } from './families.js'
import { MAX_SAME_ACCOUNT_HOLD_MS } from './hold.js'
import { holdDelayMs } from './jitter.js'
import type { RequestHistory } from './request-history.js'
import {
  isRequestExcluded,
  REQUEST_EXCLUSION_EFFECTS,
  reduceRequestHistory,
  sameAccount,
} from './request-history.js'
import type { Scope } from './scope.js'
import type { AccountKey, LimitSignal, LimitWindow } from './signal.js'

export interface TimedBlocker {
  readonly kind: 'hard' | 'cooldown' | 'soft'
  readonly until?: number
}

/** Admission is before timed marks; placement and readiness are separate facts. */
export interface LimitCandidate {
  readonly account: AccountKey
  readonly admitted: boolean
  readonly placementEligible: boolean
  readonly ready: boolean
  readonly blockers: readonly TimedBlocker[]
  readonly confirmedBlockers?: readonly LimitWindow[]
}

export interface ModeSelection {
  readonly account: AccountKey
  readonly pin: 'pin' | 'preserve' | 'detour'
}

export interface WaitCheckpoint {
  readonly accountKey: AccountKey
  readonly decidedAt: number
  readonly blockers: readonly {
    readonly window: string
    readonly resetAt: number
  }[]
}

/** Resolved via sameAccountHoldFacts; expiry uses the caller's epoch clock. */
export interface HoldFacts {
  readonly cacheExpiresAt: number
  readonly maxWaitMs: number
  readonly maxDelayMs?: number
}

/** Resolved metadata for a terminal refusal, not an account-selection instruction. */
export interface TerminalFacts {
  readonly source: 'pool' | 'vault'
  readonly reason: RefusalReason
  readonly family?: DecisionFamily
  readonly messageKey?: string
  readonly retryable?: boolean
  readonly hostRetry?: HostRetry
  readonly retryAfterMs?: number
  readonly resetAt?: number
}

export interface PolicyFacts {
  readonly phase: 'pre-send' | 'after-limit'
  readonly host: LimitHost
  readonly hostPhase?: 'request' | 'retry'
  readonly now: number
  readonly clockNow: number
  readonly sessionId: string
  readonly requestScope: Scope
  readonly history: RequestHistory
  readonly attempted?: AccountKey
  readonly signal?: LimitSignal
  readonly signalApplicable?: boolean
  readonly status?: number
  readonly failureRetryable?: boolean
  readonly delivery: {
    readonly owned: boolean
    readonly attributable: boolean
    readonly replayable: boolean
  }
  readonly candidates: readonly LimitCandidate[]
  readonly selection?: ModeSelection
  readonly affinity?: 'sticky' | 'broken' | 'none'
  readonly credentialRecovery?: { readonly retryMs?: number }
  readonly retryHintsMs?: readonly number[]
  readonly hold?: HoldFacts
  readonly remainingRetries?: number
  readonly terminal?: TerminalFacts
  readonly poolWaitBudgetMs?: number
}

interface DecisionBase {
  readonly retryable: boolean
  readonly hostRetry: HostRetry
  readonly history: RequestHistory
  readonly reason: string
}

export type LimitDecision = DecisionBase &
  (
    | {
        readonly action: 'reroute'
        readonly account: AccountKey
        readonly pin: ModeSelection['pin']
      }
    | {
        readonly action: 'hold'
        readonly account: AccountKey
        readonly delayMs: number
        readonly retryAfterMs: number
        readonly target: number
        readonly checkpoint: WaitCheckpoint
      }
    | {
        readonly action: 'retain'
        readonly account: AccountKey
        readonly retryMs?: number
      }
    | {
        readonly action: 'wait-then-reselect'
        readonly delayMs: number
        readonly resetAt?: number
      }
    | {
        readonly action: 'exclude-for-request'
        readonly account: AccountKey
        readonly scope: Scope
        readonly effects: typeof REQUEST_EXCLUSION_EFFECTS
      }
    | {
        readonly action: 'refuse'
        readonly reason: RefusalReason
        readonly family: DecisionFamily
        readonly messageKey: string
        readonly retryAfterMs?: number
        readonly resetAt?: number
      }
    | { readonly action: 'pass' }
  )

function finiteFuture(value: number | undefined, now: number): value is number {
  return value !== undefined && Number.isFinite(value) && value > now
}

function continuationRetry(facts: PolicyFacts, axes: LimitAxes): HostRetry {
  return axes.execution === 'engine' && facts.phase === 'after-limit'
    ? 'veto'
    : 'leave'
}

function refusal(
  facts: PolicyFacts,
  axes: LimitAxes,
  history: RequestHistory,
  reason: RefusalReason,
  metadata?: TerminalFacts,
): LimitDecision {
  const policy = axes.refusals[reason][facts.host]
  return {
    action: 'refuse',
    reason,
    family: metadata?.family ?? policy.family,
    messageKey: metadata?.messageKey ?? policy.messageKey,
    retryable: metadata?.retryable ?? policy.retryable,
    hostRetry: metadata?.hostRetry ?? policy.hostRetry,
    history,
    ...(metadata?.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: metadata.retryAfterMs }),
    ...(metadata?.resetAt === undefined ? {} : { resetAt: metadata.resetAt }),
  }
}

function hold(
  facts: PolicyFacts,
  axes: LimitAxes,
  history: RequestHistory,
  current: LimitCandidate | undefined,
  windows: readonly LimitWindow[],
): LimitDecision | undefined {
  const bound = facts.hold
  if (
    axes.shortLimit.holdBound === 'disabled' ||
    (facts.host === 'opencode2' &&
      (facts.hostPhase !== 'retry' ||
        facts.remainingRetries === undefined ||
        !(facts.remainingRetries >= 1))) ||
    !current?.admitted ||
    !bound ||
    bound.maxWaitMs <= 0 ||
    Number.isNaN(bound.maxWaitMs) ||
    !Number.isFinite(bound.cacheExpiresAt) ||
    (bound.maxDelayMs !== undefined &&
      (!Number.isFinite(bound.maxDelayMs) || bound.maxDelayMs < 0)) ||
    !windows.length ||
    windows.some((window) => !finiteFuture(window.resetAt, facts.now))
  )
    return undefined
  const resetAt = Math.max(...windows.map((window) => window.resetAt as number))
  const delayMs =
    axes.shortLimit.jitter === 'session-sha256'
      ? holdDelayMs(facts.sessionId, resetAt - facts.now)
      : resetAt - facts.now
  const target = facts.now + delayMs
  if (
    !Number.isFinite(target) ||
    target > Math.min(bound.cacheExpiresAt, facts.now + bound.maxWaitMs) ||
    (facts.host === 'opencode2' && delayMs > MAX_SAME_ACCOUNT_HOLD_MS) ||
    (bound.maxDelayMs !== undefined && delayMs > bound.maxDelayMs)
  )
    return undefined
  return {
    action: 'hold',
    account: current.account,
    delayMs,
    retryAfterMs: delayMs,
    target,
    checkpoint: {
      accountKey: { ...current.account },
      decidedAt: facts.now,
      blockers: windows.map((window) => ({
        window: window.window,
        resetAt: window.resetAt as number,
      })),
    },
    reason: 'confirmed-limit',
    retryable: true,
    hostRetry:
      facts.phase === 'pre-send' ? 'leave' : continuationRetry(facts, axes),
    history,
  }
}

function poolWait(
  facts: PolicyFacts,
  axes: LimitAxes,
  history: RequestHistory,
  candidates: readonly LimitCandidate[],
): LimitDecision | undefined {
  const policy = axes.poolWaiting
  if (policy.kind === 'off' || !candidates.length) return undefined
  history = reduceRequestHistory(history, {
    type: 'blocked',
    clockNow: facts.clockNow,
  })
  const times = candidates
    .map((candidate) => {
      const blockers = candidate.blockers.filter(
        (blocker) =>
          !(
            blocker.kind === 'soft' &&
            candidates.length === 1 &&
            policy.singleEligibleSoftExemption
          ),
      )
      if (blockers.some((blocker) => !finiteFuture(blocker.until, facts.now)))
        return undefined
      return blockers.length
        ? Math.max(...blockers.map((blocker) => blocker.until as number))
        : undefined
    })
    .filter((time): time is number => time !== undefined)
  const proposed = times.length
    ? Math.min(...times) - facts.now
    : candidates.some((candidate) =>
          candidate.blockers.some((blocker) => blocker.kind !== 'soft'),
        )
      ? policy.hardFallbackMs
      : undefined
  const budget = facts.poolWaitBudgetMs ?? policy.budgetMs
  const elapsed = facts.clockNow - (history.blockedSince ?? facts.clockNow)
  if (
    budget > 0 &&
    (elapsed >= budget || (proposed !== undefined && proposed > budget))
  )
    return refusal(facts, axes, history, 'quota', facts.terminal)
  const remaining =
    policy.requestDeadlineMs - (facts.clockNow - history.requestStartedAt)
  if (remaining <= 0) return refusal(facts, axes, history, 'incomplete')
  if (proposed === undefined)
    return refusal(facts, axes, history, 'quota', facts.terminal)
  return {
    action: 'wait-then-reselect',
    delayMs: Math.min(
      proposed,
      remaining,
      budget > 0 ? budget - elapsed : Number.POSITIVE_INFINITY,
    ),
    reason: 'pool-blocked',
    retryable: true,
    hostRetry: continuationRetry(facts, axes),
    history,
  }
}

/** The caller supplies clocks, admission, delivery ownership and parsed evidence. */
export function decideAfterLimit(
  facts: PolicyFacts,
  axes: LimitAxes,
): LimitDecision {
  let history = facts.history
  const pass = (
    reason: string,
    retryable = facts.phase === 'pre-send'
      ? true
      : (facts.failureRetryable ?? true),
    hostRetry: HostRetry = 'leave',
  ): LimitDecision => ({
    action: 'pass',
    reason,
    retryable,
    hostRetry,
    history,
  })
  if (
    facts.phase === 'after-limit' &&
    facts.host === 'opencode2' &&
    (!facts.delivery.owned || !facts.delivery.attributable)
  )
    return pass('not-owned')
  const status = facts.status ?? facts.signal?.status
  if (facts.phase === 'after-limit' && facts.attempted)
    history = reduceRequestHistory(history, {
      type: 'response',
      account: facts.attempted,
      scope: facts.requestScope,
      status,
    })
  if (facts.phase === 'after-limit' && !facts.delivery.replayable)
    return pass('unsafe-output', false, 'veto')
  const admitted = facts.candidates.filter((candidate) => candidate.admitted)
  const candidates = admitted.filter(
    (candidate) =>
      !isRequestExcluded(history, candidate.account, facts.requestScope),
  )
  const current = candidates.find(
    (candidate) =>
      facts.attempted && sameAccount(candidate.account, facts.attempted),
  )
  const signal =
    facts.signalApplicable !== false &&
    facts.signal &&
    facts.attempted &&
    sameAccount(facts.signal.account, facts.attempted)
      ? facts.signal
      : undefined
  if (
    axes.requestExclusion === 'on' &&
    signal?.kind === 'model-unavailable' &&
    current
  ) {
    return {
      action: 'exclude-for-request',
      account: current.account,
      scope: facts.requestScope,
      effects: REQUEST_EXCLUSION_EFFECTS,
      reason: 'model-unavailable',
      retryable: true,
      hostRetry: continuationRetry(facts, axes),
      history,
    }
  }
  if (admitted.length && !candidates.length)
    return refusal(facts, axes, history, 'model-unavailable')
  if (
    facts.host === 'opencode2' &&
    facts.hostPhase === 'retry' &&
    axes.execution === 'host' &&
    facts.remainingRetries !== undefined &&
    facts.remainingRetries < 1
  ) {
    return facts.terminal?.retryable === false
      ? refusal(facts, axes, history, facts.terminal.reason, facts.terminal)
      : pass('host-retries-exhausted')
  }
  if (facts.credentialRecovery && current) {
    return {
      action: 'retain',
      account: current.account,
      reason: 'credential-recovery',
      ...(facts.credentialRecovery.retryMs === undefined
        ? {}
        : { retryMs: facts.credentialRecovery.retryMs }),
      retryable: true,
      hostRetry: continuationRetry(facts, axes),
      history,
    }
  }
  const advance = axes.advance[facts.host]
  if (
    facts.phase === 'after-limit' &&
    !signal &&
    !facts.terminal &&
    (advance.attributedLimitOnly ||
      status === undefined ||
      !advance.statuses.includes(status))
  )
    return pass('unhandled-failure')
  const selected = candidates.find(
    (candidate) =>
      facts.selection &&
      sameAccount(candidate.account, facts.selection.account) &&
      candidate.placementEligible,
  )
  const selectedReady =
    selected &&
    (selected.ready ||
      (axes.poolWaiting.kind === 'earliest' &&
        axes.poolWaiting.singleEligibleSoftExemption &&
        candidates.length === 1 &&
        selected.blockers.length > 0 &&
        selected.blockers.every((blocker) => blocker.kind === 'soft')))
  const alternative =
    selectedReady &&
    (!facts.attempted || !sameAccount(selected.account, facts.attempted))
      ? selected
      : undefined
  const reroute = (candidate: LimitCandidate): LimitDecision => ({
    action: 'reroute',
    account: candidate.account,
    pin: facts.selection?.pin ?? 'preserve',
    reason: 'ready-alternative',
    retryable: true,
    hostRetry: continuationRetry(facts, axes),
    history: reduceRequestHistory(history, { type: 'selected' }),
  })
  const windows = (current?.confirmedBlockers ?? signal?.windows ?? []).filter(
    (window) => window.confirmed,
  )
  if (facts.phase === 'after-limit' && windows.length) {
    if (axes.shortLimit.preference === 'ready-alternative-first' && alternative)
      return reroute(alternative)
    const held = hold(facts, axes, history, current, windows)
    if (held) return held
  }
  const unknown = axes.unknown[facts.host]
  const unconfirmed =
    facts.phase === 'after-limit' &&
    !windows.length &&
    (status === 429 ||
      signal?.kind === 'rate-limit' ||
      signal?.kind === 'quota-exhausted' ||
      signal?.kind === 'capacity')
  if (
    unconfirmed &&
    current &&
    (unknown.affinity === 'always' || facts.affinity === 'sticky')
  ) {
    if (unknown.action === 'pass') return pass('unconfirmed-limit')
    if (unknown.action === 'retain') {
      const hints = [
        ...(facts.retryHintsMs ?? []),
        signal?.retryAfterMs,
      ].filter(
        (hint): hint is number =>
          hint !== undefined && Number.isFinite(hint) && hint >= 0,
      )
      return {
        action: 'retain',
        account: current.account,
        reason: 'unconfirmed-limit',
        ...(unknown.hint === 'minimum'
          ? { retryMs: Math.min(unknown.defaultMs, ...hints) }
          : {}),
        retryable: true,
        hostRetry: continuationRetry(facts, axes),
        history,
      }
    }
  }
  if (alternative) return reroute(alternative)
  if (facts.phase === 'pre-send' && selectedReady) return reroute(selected)
  if (
    facts.host === 'opencode2' &&
    facts.hostPhase === 'request' &&
    axes.markedPool.requestEscape === 'ignore-timed-marks-if-all-marked' &&
    selected &&
    candidates.every((candidate) => !candidate.ready) &&
    candidates.every(
      (candidate) =>
        candidate.blockers.length > 0 &&
        candidate.blockers.every((blocker) => blocker.kind === 'hard'),
    )
  )
    return reroute(selected)
  const waited = poolWait(facts, axes, history, candidates)
  if (waited) return waited
  if (facts.phase === 'pre-send' && !candidates.length)
    return refusal(facts, axes, history, 'auth', facts.terminal)
  if (
    facts.host === 'opencode2' &&
    facts.hostPhase === 'retry' &&
    !facts.terminal
  ) {
    if (axes.markedPool.retryExhaustion === 'host-delay')
      return pass('host-delay')
    if (axes.markedPool.retryExhaustion === 'same-host-delay' && current)
      return {
        action: 'retain',
        account: current.account,
        reason: 'host-delay',
        retryable: true,
        hostRetry: 'leave',
        history,
      }
  }
  if (
    axes.terminalPolicy === 'status-history' &&
    facts.host !== 'opencode2' &&
    !facts.terminal
  ) {
    const allMarked =
      facts.phase === 'pre-send' &&
      candidates.length > 0 &&
      candidates.every((candidate) => !candidate.ready)
    if (allMarked || (status === 401 && history.saw429)) {
      const deadlines = candidates
        .flatMap((candidate) =>
          candidate.blockers.map((blocker) => blocker.until),
        )
        .filter((until): until is number => finiteFuture(until, facts.now))
      return refusal(facts, axes, history, 'quota', {
        source: 'pool',
        reason: 'quota',
        retryAfterMs: deadlines.length
          ? Math.max(1000, Math.min(...deadlines) - facts.now)
          : 60000,
      })
    }
    return pass('original-response')
  }
  if (facts.terminal)
    return refusal(facts, axes, history, facts.terminal.reason, facts.terminal)
  if (signal?.kind === 'auth' || signal?.kind === 'account-access')
    return refusal(facts, axes, history, 'auth')
  if (
    signal ||
    status === 429 ||
    candidates.some((candidate) => candidate.blockers.length)
  )
    return refusal(facts, axes, history, 'quota')
  return pass('no-override')
}
