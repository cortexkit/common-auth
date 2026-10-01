// Admission: which candidate rows may be dispatched for one request.
//
// Pure: the caller passes the candidate rows with their quota maps, the
// request's scope, the window labels that scope requires, and the rate-limit
// marks and refresh backoff it holds. Nothing is read or written here.
//
// A marked or backed-off row is excluded before the gates. Stage 1 then
// judges each remaining row alone, in gate order:
//   1. an API-key row is admitted without consulting quota (a provider that
//      offers paid rows only after its OAuth rows are spent leaves them out
//      of `rows` until then);
//   2. an OAuth row whose projection resolves no entry for the scope needs a
//      first reading: refused, pull requested;
//   3. a required label with no entry is unknown: refused, pull requested;
//   4. a reading at or beyond 100% whose reset is missing, unparsable or not
//      after `now` cannot confirm the exhaustion, so the window is unknown:
//      refused, pull requested;
//   5. a reading at or beyond 100% with a future reset is exhausted: refused.
// Gates 4 and 5 look at every projected limit, not only the required labels.
// Stage 2 judges the credit budget across the stage-1 survivors: a row whose
// budget is known spent (reached, with a parsable future reset) is refused
// unless every survivor's budget is spent, in which case all of them stay
// admitted as the last path. Every missing, malformed or passed budget reset
// fails open. Stage-1 refusals have no last-path exception.

import {
  ALL_SCOPE,
  DEFAULT_REQUIRED_LABELS,
  type QuotaMap,
} from '../quota/map.js'
import {
  budgetExhaustedResetAt,
  futureResetAt,
  type ProjectedQuota,
  projectQuota,
  readsExhausted,
} from '../quota/projection.js'

export type RowKind = 'oauth' | 'api-key'

export interface RoutingRow {
  id: string
  kind: RowKind
  /** The row's stored quota map; absent is the same as an empty map. */
  quota?: QuotaMap
}

export interface WindowRef {
  scope: string
  label: string
}

export interface ExclusionInputs {
  /** Row id to the time (ms) a rate-limit mark expires. */
  rateLimitMarks?: ReadonlyMap<string, number>
  /** Row id to the time (ms) a failed refresh may be retried. */
  refreshBackoff?: ReadonlyMap<string, number>
}

export interface AdmissionInput extends ExclusionInputs {
  rows: readonly RoutingRow[]
  /** `all` (the default) or a model family. */
  scope?: string
  /** Labels the scope requires an entry for; defaults to `['primary']`. */
  requiredLabels?: readonly string[]
  now: number
  /**
   * Called synchronously, once per refusal at gates 2 to 4, with the row id.
   * Its return value is ignored and never awaited, so a pull the caller
   * starts from here cannot delay the refusal.
   */
  requestPull?: (rowId: string) => void
}

export type AdmissionRefusal =
  | {
      id: string
      stage: 1
      gate: 2
      reason: 'needs-first-reading'
      pullRequested: true
    }
  | {
      id: string
      stage: 1
      gate: 3
      reason: 'unknown-window'
      window: WindowRef
      pullRequested: true
    }
  | {
      id: string
      stage: 1
      gate: 4
      reason: 'unknown-reset'
      window: WindowRef
      pullRequested: true
    }
  | {
      id: string
      stage: 1
      gate: 5
      reason: 'exhausted'
      window: WindowRef
      resetsAt: string
      resetAtMs: number
    }
  | {
      id: string
      stage: 2
      reason: 'budget-spent'
      resetsAt: string
      resetAtMs: number
    }

export interface AdmissionExclusion {
  id: string
  reason: 'rate-limited' | 'refresh-backoff'
  until: number
}

export interface AdmittedRow {
  id: string
  kind: RowKind
  /** The projection admission judged; absent for API-key rows. */
  projection?: ProjectedQuota
  /** Set when a spent budget was kept because no other path survived. */
  lastPath?: true
}

export interface AdmissionResult {
  /** In input order. */
  admitted: AdmittedRow[]
  refused: AdmissionRefusal[]
  excluded: AdmissionExclusion[]
  /** Ids a pull was requested for, in input order. */
  pulls: string[]
}

/** The exclusion that applies to `id` at `now`, if any. */
export function exclusionFor(
  id: string,
  inputs: ExclusionInputs,
  now: number,
): AdmissionExclusion | undefined {
  const markedUntil = inputs.rateLimitMarks?.get(id)
  if (markedUntil !== undefined && now < markedUntil) {
    return { id, reason: 'rate-limited', until: markedUntil }
  }
  const backoffUntil = inputs.refreshBackoff?.get(id)
  if (backoffUntil !== undefined && now < backoffUntil) {
    return { id, reason: 'refresh-backoff', until: backoffUntil }
  }
  return undefined
}

function judgeStageOne(
  id: string,
  projection: ProjectedQuota,
  requiredLabels: readonly string[],
  now: number,
): AdmissionRefusal | undefined {
  if (projection.limits.length === 0) {
    return {
      id,
      stage: 1,
      gate: 2,
      reason: 'needs-first-reading',
      pullRequested: true,
    }
  }
  for (const label of requiredLabels) {
    if (!projection.limits.some((limit) => limit.label === label)) {
      return {
        id,
        stage: 1,
        gate: 3,
        reason: 'unknown-window',
        window: { scope: projection.scope, label },
        pullRequested: true,
      }
    }
  }
  const exhausted = projection.limits.filter(readsExhausted)
  for (const limit of exhausted) {
    if (futureResetAt(limit, now) === undefined) {
      return {
        id,
        stage: 1,
        gate: 4,
        reason: 'unknown-reset',
        window: { scope: limit.scope, label: limit.label },
        pullRequested: true,
      }
    }
  }
  for (const limit of exhausted) {
    const resetAtMs = futureResetAt(limit, now)
    if (resetAtMs !== undefined && typeof limit.resetsAt === 'string') {
      return {
        id,
        stage: 1,
        gate: 5,
        reason: 'exhausted',
        window: { scope: limit.scope, label: limit.label },
        resetsAt: limit.resetsAt,
        resetAtMs,
      }
    }
  }
  return undefined
}

/** Runs both admission stages over `input.rows`. */
export function admit(input: AdmissionInput): AdmissionResult {
  const scope = input.scope ?? ALL_SCOPE
  const requiredLabels = input.requiredLabels ?? DEFAULT_REQUIRED_LABELS
  const excluded: AdmissionExclusion[] = []
  const refused: AdmissionRefusal[] = []
  const survivors: AdmittedRow[] = []
  for (const row of input.rows) {
    const exclusion = exclusionFor(row.id, input, input.now)
    if (exclusion) {
      excluded.push(exclusion)
      continue
    }
    if (row.kind === 'api-key') {
      survivors.push({ id: row.id, kind: row.kind })
      continue
    }
    const projection = projectQuota(row.quota, scope)
    const refusal = judgeStageOne(row.id, projection, requiredLabels, input.now)
    if (refusal) {
      refused.push(refusal)
      continue
    }
    survivors.push({ id: row.id, kind: row.kind, projection })
  }

  const spent = new Map(
    survivors.flatMap((row) => {
      const reset = budgetExhaustedResetAt(row.projection, input.now)
      return reset ? [[row.id, reset] as const] : []
    }),
  )
  const lastPath = spent.size > 0 && spent.size === survivors.length
  const admitted: AdmittedRow[] = []
  for (const row of survivors) {
    const reset = spent.get(row.id)
    if (reset === undefined) {
      admitted.push(row)
    } else if (lastPath) {
      admitted.push({ ...row, lastPath: true })
    } else {
      refused.push({ id: row.id, stage: 2, reason: 'budget-spent', ...reset })
    }
  }

  const order = new Map(input.rows.map((row, index) => [row.id, index]))
  const byInput = (left: { id: string }, right: { id: string }) =>
    (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0)
  refused.sort(byInput)
  const pulls = refused
    .filter((refusal) => 'pullRequested' in refusal)
    .map((refusal) => refusal.id)
  for (const id of pulls) input.requestPull?.(id)
  return { admitted, refused, excluded, pulls }
}
