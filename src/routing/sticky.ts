// `sticky-balanced` routing: openai-auth's quota-weighted session placement
// and pin-break classification, judged over the quota projection rather than
// openai-auth's fixed primary/secondary snapshot.

import {
  budgetExhaustedResetAt,
  type ProjectedLimit,
  type ProjectedQuota,
  projectQuota,
} from '../quota/projection.js'
import {
  type AdmissionInput,
  type AdmissionRefusal,
  type AdmissionResult,
  admit,
  type RoutingRow,
  type WindowRef,
} from './admission.js'
import { isPinValid, type StickyPin } from './pins.js'

export const QUOTA_STALENESS_MS = 15 * 60_000
export const MIN_RESET_HOURS = 1 / 60
export const MIN_WEIGHT = 1e-6
/**
 * How many window readings the selection primitives judge, as openai-auth's
 * primary and secondary slots did. The projection's first readings in its
 * order fill the slots; any further window is judged by admission only.
 */
export const STICKY_WINDOW_SLOTS = 2

/** The projection's time, else the caller's cache-entry time. */
export function snapshotCheckedAt(
  quota: ProjectedQuota | null | undefined,
  entryCheckedAt?: number,
): number | undefined {
  for (const checkedAt of [quota?.checkedAt, entryCheckedAt]) {
    if (typeof checkedAt === 'number' && Number.isFinite(checkedAt)) {
      return checkedAt
    }
  }
  return undefined
}

export type StickyBreakDecision =
  | { action: 'retain'; reason: 'unknown' | 'stale' | 'healthy' | 'transient' }
  | {
      action: 'migrate'
      reason: 'exhausted' | 'permanent' | 'killswitch'
      /** The exhausted limit, named by its (scope, label), not its position. */
      window?: WindowRef
      resetsAt?: string
    }

function slotReadings(quota: ProjectedQuota): ProjectedLimit[] {
  // Longest known window first, unknown lengths last, as openai-auth sorts.
  // Tombstones and absence records carry no capacity figure, so they occupy
  // no slot.
  return quota.limits
    .filter((limit) => limit.kind === 'reading')
    .sort((left, right) => {
      const leftKnown = left.windowMinutes !== undefined
      const rightKnown = right.windowMinutes !== undefined
      if (leftKnown !== rightKnown) return leftKnown ? -1 : 1
      if (leftKnown && rightKnown) {
        return (right.windowMinutes ?? 0) - (left.windowMinutes ?? 0)
      }
      return 0
    })
    .slice(0, STICKY_WINDOW_SLOTS)
}

/** Classifies whether a pinned session should leave its row after a failure. */
export function decideStickyBreak(input: {
  quota: ProjectedQuota | null | undefined
  quotaCheckedAt?: number
  status?: number
  now: number
  killswitchPasses?: boolean
}): StickyBreakDecision {
  if (input.status === 401 || input.status === 403) {
    return { action: 'migrate', reason: 'permanent' }
  }
  if (!input.quota) return { action: 'retain', reason: 'unknown' }

  const checkedAt = snapshotCheckedAt(input.quota, input.quotaCheckedAt)
  if (
    checkedAt === undefined ||
    !Number.isFinite(checkedAt) ||
    input.now - checkedAt > QUOTA_STALENESS_MS
  ) {
    return { action: 'retain', reason: 'stale' }
  }

  // After the stale check, so a stale snapshot never judges the account on a
  // reading the killswitch would consider below its floor.
  if (input.killswitchPasses === false) {
    return { action: 'migrate', reason: 'killswitch' }
  }

  for (const limit of slotReadings(input.quota)) {
    const remaining = limit.remainingPercent
    if (
      typeof remaining === 'number' &&
      Number.isFinite(remaining) &&
      remaining <= 0
    ) {
      return {
        action: 'migrate',
        reason: 'exhausted',
        window: { scope: limit.scope, label: limit.label },
        ...(typeof limit.resetsAt === 'string'
          ? { resetsAt: limit.resetsAt }
          : {}),
      }
    }
  }

  // A reached credit budget is exhaustion on its own axis, judged by the same
  // signal admission uses so the two never disagree on what "spent" means.
  const budgetReset = budgetExhaustedResetAt(input.quota, input.now)
  if (budgetReset) {
    return {
      action: 'migrate',
      reason: 'exhausted',
      resetsAt: budgetReset.resetsAt,
    }
  }

  if (
    input.status === undefined ||
    input.status === 0 ||
    !Number.isFinite(input.status) ||
    (input.status >= 500 && input.status <= 599) ||
    input.status === 429
  ) {
    return { action: 'retain', reason: 'transient' }
  }
  return { action: 'retain', reason: 'healthy' }
}

export function sustainableWindowWeight(
  window: { remainingPercent: number; resetsAt?: string },
  reservePercent: number,
  now: number,
): number {
  const spendable = Math.max(0, window.remainingPercent - reservePercent)
  if (spendable <= 0) return 0
  if (!window.resetsAt) return spendable
  const resetMs = Date.parse(window.resetsAt)
  // A lapsed reset cannot yield a spend rate: the divisor would clamp to
  // MIN_RESET_HOURS and inflate the weight about sixty-fold on stale
  // information, so the un-rate-adjusted spendable capacity is used instead.
  if (!Number.isFinite(resetMs) || resetMs <= now) return spendable
  const hours = Math.max((resetMs - now) / 3_600_000, MIN_RESET_HOURS)
  return spendable / hours
}

export interface StickySelectionCandidate {
  accountId: string
  quota: ProjectedQuota | null | undefined
  quotaCheckedAt?: number
  /** Reserve percent per window label; a missing label reserves nothing. */
  reservePercent: Readonly<Record<string, number>>
  configuredOrder: number
  resetCreditsApplicable?: number
  /** `false` excludes the candidate from weighted and fallback placement. */
  killswitchPasses?: boolean
}

export interface StickySelectionInput {
  candidates: readonly StickySelectionCandidate[]
  pendingBytes: ReadonlyMap<string, number>
  requestBytes: number
  now: number
  onEmptyWeightedSet?: () => void
}

export interface StickySelection {
  accountId: string
  quotaCheckedAt?: number
  source: 'weighted' | 'mode-fallback'
}

type WeightedCandidate = {
  candidate: StickySelectionCandidate
  quotaCheckedAt: number
  weight: number
}

function compareAccountIds(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function candidateWeight(
  candidate: StickySelectionCandidate,
  now: number,
): WeightedCandidate | undefined {
  if (!candidate.quota) return undefined
  const quotaCheckedAt = snapshotCheckedAt(
    candidate.quota,
    candidate.quotaCheckedAt,
  )
  if (
    quotaCheckedAt === undefined ||
    now - quotaCheckedAt > QUOTA_STALENESS_MS
  ) {
    return undefined
  }
  // Missing reserve data must leave a window usable rather than silently
  // excluding its account.
  const weights = slotReadings(candidate.quota).map((limit) =>
    sustainableWindowWeight(
      {
        remainingPercent: limit.remainingPercent ?? Number.NaN,
        ...(limit.resetsAt === undefined ? {} : { resetsAt: limit.resetsAt }),
      },
      candidate.reservePercent[limit.label] ?? 0,
      now,
    ),
  )
  // The credit budget is a third pressure axis on its own reset clock. It has
  // no configured reserve, and a malformed reading is ignored rather than
  // allowed to zero the account's weight.
  const budget = candidate.quota.budget
  if (
    budget &&
    typeof budget.remainingPercent === 'number' &&
    Number.isFinite(budget.remainingPercent)
  ) {
    weights.push(
      sustainableWindowWeight(
        {
          remainingPercent: budget.remainingPercent,
          ...(budget.resetsAt === undefined
            ? {}
            : { resetsAt: budget.resetsAt }),
        },
        0,
        now,
      ),
    )
  }
  const weight = weights.length > 0 ? Math.min(...weights) : 0
  return weight > 0 ? { candidate, quotaCheckedAt, weight } : undefined
}

/**
 * Places a session: the lowest projected pressure among candidates with a
 * fresh positive weight, else (`mode-fallback`) the first candidate in
 * configured order, preferring one with an applicable reset credit.
 */
export function selectStickyCandidate(
  input: StickySelectionInput,
): StickySelection | undefined {
  // A candidate killed by the killswitch is excluded from BOTH weighted
  // placement and the fallback branch, which must never become a way to
  // spend on a killed account.
  const eligibleCandidates = input.candidates.filter(
    (candidate) => candidate.killswitchPasses !== false,
  )
  if (input.candidates.length === 0) {
    throw new Error(
      'Cannot select a sticky candidate: input.candidates is empty',
    )
  }
  if (eligibleCandidates.length === 0) return undefined

  const weighted = eligibleCandidates
    .map((candidate) => candidateWeight(candidate, input.now))
    .filter(
      (candidate): candidate is WeightedCandidate => candidate !== undefined,
    )

  if (weighted.length > 0) {
    weighted.sort((left, right) => {
      // MIN_WEIGHT only guards the division; every weight here is positive.
      const leftScore =
        ((input.pendingBytes.get(left.candidate.accountId) ?? 0) +
          input.requestBytes) /
        Math.max(left.weight, MIN_WEIGHT)
      const rightScore =
        ((input.pendingBytes.get(right.candidate.accountId) ?? 0) +
          input.requestBytes) /
        Math.max(right.weight, MIN_WEIGHT)
      return (
        leftScore - rightScore ||
        left.candidate.configuredOrder - right.candidate.configuredOrder ||
        compareAccountIds(left.candidate.accountId, right.candidate.accountId)
      )
    })
    const selected = weighted[0]
    if (selected) {
      return {
        accountId: selected.candidate.accountId,
        quotaCheckedAt: selected.quotaCheckedAt,
        source: 'weighted',
      }
    }
  }

  input.onEmptyWeightedSet?.()
  const fallback = [...eligibleCandidates].sort((left, right) => {
    const leftHasCredits = (left.resetCreditsApplicable ?? 0) > 0 ? 1 : 0
    const rightHasCredits = (right.resetCreditsApplicable ?? 0) > 0 ? 1 : 0
    return (
      rightHasCredits - leftHasCredits ||
      left.configuredOrder - right.configuredOrder ||
      compareAccountIds(left.accountId, right.accountId)
    )
  })[0]
  if (!fallback) {
    throw new Error(
      'Cannot select a sticky candidate: input.candidates is empty',
    )
  }
  return {
    accountId: fallback.accountId,
    quotaCheckedAt: snapshotCheckedAt(fallback.quota, fallback.quotaCheckedAt),
    source: 'mode-fallback',
  }
}

/** Reserve percent per window label; a missing label reserves nothing. */
export type ReservePercent = Readonly<Record<string, number>>

/**
 * Reserve percentages per row: a map keyed by row id, or a function of the
 * row. A row the map lacks, or for which the function returns undefined,
 * takes the shared `reservePercent`.
 */
export type RowReservePercent =
  | ReadonlyMap<string, ReservePercent>
  | ((row: RoutingRow) => ReservePercent | undefined)

/**
 * What a valid pin does when its row is not dispatched.
 *
 * `keep`: the pin is retained whatever kept its row from this request.
 *
 * `move-on-confirmed-exhaustion`: the pin moves to the row this request is
 * dispatched to when its own row was refused as confirmed exhausted (a spent
 * window with a future reset, or a spent credit budget) or killed by the
 * killswitch. A refusal for unknown quota (no reading yet, a missing window,
 * an exhausted reading without a usable reset) and an exclusion (rate-limit
 * mark, refresh backoff) keep the pin while this request is served elsewhere.
 * With no admissible row the pin is retained either way.
 */
export type RefusedPinPolicy = 'keep' | 'move-on-confirmed-exhaustion'

export interface StickyRouteInput extends AdmissionInput {
  requestBytes: number
  /** Bytes already committed per row, for example from other sessions' pins. */
  pendingBytes?: ReadonlyMap<string, number>
  /** Killswitch verdict per row; a missing row passes. */
  killswitch?: ReadonlyMap<string, boolean>
  /** Reserve percent per window label, for every row without its own. */
  reservePercent?: ReservePercent
  /** Per-row reserves, which replace `reservePercent` for the rows they cover. */
  rowReservePercent?: RowReservePercent
  /** Defaults to `keep`. */
  refusedPinPolicy?: RefusedPinPolicy
  resetCreditsApplicable?: ReadonlyMap<string, number>
  /** The session's current pin, if it has one. */
  pin?: StickyPin
  /** Each row's recorded wire identity; missing means unknown. */
  identities?: ReadonlyMap<string, string | undefined>
  onEmptyWeightedSet?: () => void
}

/**
 * What the caller does with the session's pin: keep it, replace it with
 * `pin`, or drop it. Under the default `keep` policy a valid pin is always
 * kept, even when this request was routed elsewhere because its row was
 * refused, excluded or killed; `refusedPinPolicy` can move it instead.
 */
export type PinAction =
  | { action: 'retain' }
  | { action: 'assign'; pin: StickyPin }
  | { action: 'clear' }
  | { action: 'none' }

export type StickyRoute =
  | {
      outcome: 'dispatch'
      accountId: string
      source: 'pin' | 'weighted' | 'mode-fallback'
      quotaCheckedAt?: number
      pin: PinAction
      /** Rows that selection chose and admission then refused, in selection order. */
      refusedSelections: AdmissionRefusal[]
      admission: AdmissionResult
    }
  | {
      outcome: 'no-admissible-account'
      pin: PinAction
      refusedSelections: AdmissionRefusal[]
      admission: AdmissionResult
    }

/**
 * Routes one request in `sticky-balanced` mode. A valid pin whose row is
 * admitted, not excluded and not killed is dispatched as is. Otherwise
 * selection runs over the non-excluded rows; each selected row admission
 * refused is removed and selection re-runs, so the loop ends either on an
 * admitted row or with no admissible account.
 */
export function routeSticky(input: StickyRouteInput): StickyRoute {
  const admission = admit(input)
  const admitted = new Map(admission.admitted.map((row) => [row.id, row]))
  const refusals = new Map(admission.refused.map((r) => [r.id, r]))
  const excluded = new Set(admission.excluded.map((row) => row.id))
  const validIds = new Set(input.rows.map((row) => row.id))
  const pinValid =
    input.pin !== undefined &&
    isPinValid(input.pin, validIds, input.identities?.get(input.pin.accountId))

  if (pinValid && input.pin) {
    const pinned = admitted.get(input.pin.accountId)
    if (pinned && input.killswitch?.get(pinned.id) !== false) {
      return {
        outcome: 'dispatch',
        accountId: pinned.id,
        source: 'pin',
        ...(pinned.projection?.checkedAt === undefined
          ? {}
          : { quotaCheckedAt: pinned.projection.checkedAt }),
        pin: { action: 'retain' },
        refusedSelections: [],
        admission,
      }
    }
  }

  // A spent window with a future reset, a spent credit budget and a killswitch
  // verdict all say the pinned row will not serve until some known later time,
  // so the pin may move. A row refused for want of a usable reading, or
  // excluded by a short rate-limit mark or refresh backoff, may serve again on
  // the next reading, so its pin stays.
  const pinRefusal = input.pin ? refusals.get(input.pin.accountId) : undefined
  const pinMoves =
    pinValid &&
    input.pin !== undefined &&
    input.refusedPinPolicy === 'move-on-confirmed-exhaustion' &&
    (input.killswitch?.get(input.pin.accountId) === false ||
      pinRefusal?.reason === 'exhausted' ||
      pinRefusal?.reason === 'budget-spent')

  const reserveFor = (row: RoutingRow): ReservePercent => {
    const perRow =
      typeof input.rowReservePercent === 'function'
        ? input.rowReservePercent(row)
        : input.rowReservePercent?.get(row.id)
    return perRow ?? input.reservePercent ?? {}
  }

  const scope = input.scope
  let candidates: StickySelectionCandidate[] = input.rows
    .map((row, configuredOrder) => ({ row, configuredOrder }))
    .filter(({ row }) => !excluded.has(row.id))
    .map(({ row, configuredOrder }) => {
      const killswitchPasses = input.killswitch?.get(row.id)
      const credits = input.resetCreditsApplicable?.get(row.id)
      return {
        accountId: row.id,
        quota:
          row.kind === 'api-key'
            ? undefined
            : (admitted.get(row.id)?.projection ??
              projectQuota(row.quota, scope)),
        reservePercent: reserveFor(row),
        configuredOrder,
        ...(credits === undefined ? {} : { resetCreditsApplicable: credits }),
        ...(killswitchPasses === undefined ? {} : { killswitchPasses }),
      }
    })

  const refusedSelections: AdmissionRefusal[] = []
  const unplaced: PinAction = pinValid
    ? { action: 'retain' }
    : input.pin
      ? { action: 'clear' }
      : { action: 'none' }
  while (candidates.length > 0) {
    const selection = selectStickyCandidate({
      candidates,
      pendingBytes: input.pendingBytes ?? new Map(),
      requestBytes: input.requestBytes,
      now: input.now,
      ...(input.onEmptyWeightedSet
        ? { onEmptyWeightedSet: input.onEmptyWeightedSet }
        : {}),
    })
    if (!selection) break
    const refusal = refusals.get(selection.accountId)
    if (refusal) {
      refusedSelections.push(refusal)
      candidates = candidates.filter(
        (candidate) => candidate.accountId !== selection.accountId,
      )
      continue
    }
    const identity = input.identities?.get(selection.accountId)
    return {
      outcome: 'dispatch',
      accountId: selection.accountId,
      source: selection.source,
      ...(selection.quotaCheckedAt === undefined
        ? {}
        : { quotaCheckedAt: selection.quotaCheckedAt }),
      pin:
        pinValid && !pinMoves
          ? { action: 'retain' }
          : {
              action: 'assign',
              pin: {
                accountId: selection.accountId,
                inputBytes: input.requestBytes,
                ...(identity === undefined ? {} : { wireIdentity: identity }),
                ...(selection.quotaCheckedAt === undefined
                  ? {}
                  : { quotaCheckedAt: selection.quotaCheckedAt }),
              },
            },
      refusedSelections,
      admission,
    }
  }
  return {
    outcome: 'no-admissible-account',
    pin: unplaced,
    refusedSelections,
    admission,
  }
}
