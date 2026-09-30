// `ordered` routing: admitted rows tried in a fixed order, moving to the next
// row only when a response carries one of the caller's retry statuses.

import {
  type AdmissionInput,
  type AdmissionResult,
  admit,
} from './admission.js'

export type RoutingMode = 'ordered' | 'sticky-balanced'

/** Where `ordered` routing places the former main row. */
export type OrderedPlacement = 'roster' | 'main-first' | 'fallback-first'

export interface ResolvedRoutingMode {
  mode: RoutingMode
  placement: OrderedPlacement
}

/** The former main row's id when the caller supplies none. */
export const DEFAULT_FORMER_MAIN_ID = 'main'

/**
 * Resolves a persisted `routing.mode` value. `main-first` and
 * `fallback-first` are aliases of `ordered` that move the former main row;
 * an absent or unrecognised value is `ordered` in roster order. The
 * persisted value is only read here, never rewritten.
 */
export function resolveRoutingMode(value: unknown): ResolvedRoutingMode {
  switch (value) {
    case 'sticky-balanced':
      return { mode: 'sticky-balanced', placement: 'roster' }
    case 'main-first':
      return { mode: 'ordered', placement: 'main-first' }
    case 'fallback-first':
      return { mode: 'ordered', placement: 'fallback-first' }
    default:
      return { mode: 'ordered', placement: 'roster' }
  }
}

/**
 * Orders `ids` (in roster order) for a placement: `main-first` moves the row
 * named `formerMainId` to the front, `fallback-first` to the back, and
 * `roster` (or a missing former main row) keeps roster order.
 */
export function orderForPlacement(
  ids: readonly string[],
  placement: OrderedPlacement,
  formerMainId: string = DEFAULT_FORMER_MAIN_ID,
): string[] {
  if (placement === 'roster' || !ids.includes(formerMainId)) return [...ids]
  const rest = ids.filter((id) => id !== formerMainId)
  return placement === 'main-first'
    ? [formerMainId, ...rest]
    : [...rest, formerMainId]
}

export interface OrderedRouteInput extends AdmissionInput {
  placement?: OrderedPlacement
  formerMainId?: string
  /** Killswitch verdict per row; `false` drops the row, a missing row passes. */
  killswitch?: ReadonlyMap<string, boolean>
}

export interface OrderedRoute {
  /** Admitted, non-killed row ids in the order they are to be tried. */
  order: string[]
  admission: AdmissionResult
}

export function routeOrdered(input: OrderedRouteInput): OrderedRoute {
  const admission = admit(input)
  const admitted = new Set(admission.admitted.map((row) => row.id))
  const order = orderForPlacement(
    input.rows.map((row) => row.id),
    input.placement ?? 'roster',
    input.formerMainId,
  ).filter((id) => admitted.has(id) && input.killswitch?.get(id) !== false)
  return { order, admission }
}

export interface OrderedAttempt {
  id: string
  /** The response status; undefined when no response arrived. */
  status?: number
}

/**
 * The next row to try, given the attempts so far: the first row when none
 * has been tried, the next untried row when the last attempt's status is one
 * of `retryStatuses`, and undefined otherwise (the last response stands) or
 * when every row has been tried.
 */
export function nextOrderedAttempt(
  order: readonly string[],
  attempts: readonly OrderedAttempt[],
  retryStatuses: readonly number[],
): string | undefined {
  const last = attempts.at(-1)
  if (last !== undefined) {
    if (last.status === undefined || !retryStatuses.includes(last.status)) {
      return undefined
    }
  }
  const tried = new Set(attempts.map((attempt) => attempt.id))
  return order.find((id) => !tried.has(id))
}
