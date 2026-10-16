// The one quota wording every surface shows: the command menu's dialogs on
// OpenCode and Pi, the terminal auth menu, and the plugins' sidebars. Each of
// them calls `formatQuota`, `quotaTextParts`, or `quotaWindowParts`, so the
// wording cannot drift between plugins or between a dialog and a sidebar.
//
// The rules: a window is named by its length (`5h`, `7d`), or, for a window
// that binds only one model family, by the label the plugin stored it under.
// Every figure is "% left". A window the provider did not report (an absence
// record or a retirement tombstone) is left out rather than written as "not
// reported". A reset is a short time from now (`resets 2h`). A reading older
// than fifteen minutes says how old it is (`checked 3h ago`).
//
// Like the rest of this module it reads no clock: `now` is a parameter.

import { ALL_SCOPE } from './map.js'
import type { ProjectedLimit, ProjectedQuota } from './projection.js'

/** A reading older than this is marked with its age. */
export const QUOTA_STALE_AFTER_MS = 15 * 60_000

/** What `formatQuota` returns when there is no reading at all. */
export const NO_QUOTA_READING = 'no quota reading yet'

/**
 * What `formatQuota` returns when the provider answered but reported no
 * limit for any window (every window is an absence record or a tombstone).
 */
export const NO_LIMITS_REPORTED = 'no limits reported'

/**
 * `compact` fits a footer or a sidebar row: each window's figure, the credit
 * budget and the stale marker, without reset times. `full` adds each reset.
 */
export type QuotaTextForm = 'compact' | 'full'

export interface QuotaTextOptions {
  /** The current time in ms, for reset countdowns and the stale marker. */
  now: number
  /** Defaults to `full`. */
  form?: QuotaTextForm
  /** Defaults to `QUOTA_STALE_AFTER_MS`. */
  staleAfterMs?: number
}

export interface QuotaWindowPart {
  kind: 'window' | 'budget'
  /** The display name of a quota window, or `credits` for the budget. */
  name: string
  /** The shared figure wording, including `credits` for budget figures. */
  figure: string
  /** The unrounded remaining percentage, clamped to 0–100, when known. */
  remainingPercent?: number
  /** A bare relative reset span such as `4d`, only when the reset is future. */
  resetIn?: string
  checkedAt: number
  /** Whether the reset followed this reading and has arrived by `now`. */
  resetSinceReading: boolean
}

export interface QuotaParts {
  /** Reported windows in display order, followed by the budget when present. */
  windows: QuotaWindowPart[]
  /** The shared checked-age wording, present only when the reading is stale. */
  age?: string
}

/**
 * A time span in at most its two largest units: `45m`, `2h29m`, `5h`, `3d23h`,
 * `7d`. The span is rounded to whole minutes (never zero) and each larger unit
 * is whole, never rounded up, so a reset is never shown later than it is. A
 * zero second unit is left out.
 */
function shortSpan(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1440) {
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    return rest === 0 ? `${hours}h` : `${hours}h${rest}m`
  }
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  return hours === 0 ? `${days}d` : `${days}d${hours}h`
}

/** A stored window length in minutes as its exact name: `5h`, `7d`, `90m`. */
function lengthName(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

/**
 * The name a window is shown under. A general window (scope `all`) is named
 * by its stored length; a model-scoped window keeps the label the plugin
 * stored it under, which already names the model (`seven_day_opus`). A
 * general window stored without a length (a snapshot from before lengths
 * were recorded) falls back to its label.
 */
export function quotaWindowName(
  limit: Pick<ProjectedLimit, 'scope' | 'label' | 'windowMinutes'>,
): string {
  if (limit.scope !== ALL_SCOPE || limit.windowMinutes === undefined)
    return limit.label
  return lengthName(limit.windowMinutes)
}

function clampPercent(remaining: number): number {
  return Math.min(100, Math.max(0, remaining))
}

function percentLeft(remaining: number): string {
  return `${Math.round(clampPercent(remaining))}% left`
}

function resetDetails(
  resetsAt: string | undefined,
  checkedAt: number,
  now: number,
): { resetIn?: string; resetSinceReading: boolean } {
  const at = resetsAt === undefined ? Number.NaN : Date.parse(resetsAt)
  return {
    ...(Number.isFinite(at) && at > now
      ? { resetIn: shortSpan(at - now) }
      : {}),
    resetSinceReading: Number.isFinite(at) && at > checkedAt && at <= now,
  }
}

/** Shortest window first, so `5h` reads before `7d`; unknown lengths last. */
function displayOrder(left: ProjectedLimit, right: ProjectedLimit): number {
  const l = left.windowMinutes
  const r = right.windowMinutes
  if (l !== undefined && r !== undefined && l !== r) return l - r
  if ((l === undefined) !== (r === undefined)) return l === undefined ? 1 : -1
  if (left.scope !== right.scope) {
    if (left.scope === ALL_SCOPE) return -1
    if (right.scope === ALL_SCOPE) return 1
    return left.scope < right.scope ? -1 : 1
  }
  return left.label < right.label ? -1 : left.label > right.label ? 1 : 0
}

/**
 * Structured quota wording for layouts that need one row per window. The
 * windows use the same filtering and order as `quotaTextParts`; future resets
 * and the optional age keep the shared formatter's wording.
 */
export function quotaWindowParts(
  quota: ProjectedQuota | undefined,
  options: QuotaTextOptions,
): QuotaParts {
  if (!quota) return { windows: [] }
  const { now } = options
  const readings = quota.limits
    .filter(
      (limit) =>
        limit.kind === 'reading' && limit.remainingPercent !== undefined,
    )
    .sort(displayOrder)
  const windows: QuotaWindowPart[] = readings.map((limit) => {
    const remainingPercent = clampPercent(limit.remainingPercent ?? 0)
    return {
      kind: 'window',
      name: quotaWindowName(limit),
      figure: percentLeft(limit.remainingPercent ?? 0),
      remainingPercent,
      checkedAt: limit.checkedAt,
      ...resetDetails(limit.resetsAt, limit.checkedAt, now),
    }
  })
  const budget = quota.budget
  if (budget) {
    const remainingPercent = budget.remainingPercent
    const figure = budget.reached
      ? 'credits spent'
      : remainingPercent !== undefined
        ? `credits ${percentLeft(remainingPercent)}`
        : 'credits available'
    windows.push({
      kind: 'budget',
      name: 'credits',
      figure,
      ...(remainingPercent === undefined
        ? {}
        : { remainingPercent: clampPercent(remainingPercent) }),
      checkedAt: budget.checkedAt,
      ...resetDetails(budget.resetsAt, budget.checkedAt, now),
    })
  }

  if (windows.length > 0) {
    const age = now - Math.min(...windows.map((part) => part.checkedAt))
    if (age > (options.staleAfterMs ?? QUOTA_STALE_AFTER_MS)) {
      return { windows, age: `checked ${shortSpan(age)} ago` }
    }
  }
  return { windows }
}

/**
 * The pieces of a quota text, in order: one per reported window
 * (`5h 58% left, resets 2h`), then the credit budget when there is one, then
 * `checked 3h ago` when the oldest piece shown is stale. Empty when nothing
 * was reported; `formatQuota` turns that into a sentence. A caller printing
 * one line per window (the terminal auth menu) uses these directly.
 */
export function quotaTextParts(
  quota: ProjectedQuota | undefined,
  options: QuotaTextOptions,
): string[] {
  const parts = quotaWindowParts(quota, options)
  const full = (options.form ?? 'full') === 'full'
  const text = parts.windows.map((part) => {
    const reset = full && part.resetIn ? `, resets ${part.resetIn}` : ''
    return `${part.kind === 'budget' ? '' : `${part.name} `}${part.figure}${reset}`
  })
  return parts.age === undefined ? text : [...text, parts.age]
}

/**
 * A row's quota as one line: `5h 58% left · 7d 90% left` in the compact
 * form, with `, resets 2h` after each window in the full form. With nothing
 * reported it is `NO_QUOTA_READING`, or `NO_LIMITS_REPORTED` when the
 * provider answered without a limit for any window.
 */
export function formatQuota(
  quota: ProjectedQuota | undefined,
  options: QuotaTextOptions,
): string {
  const parts = quotaTextParts(quota, options)
  if (parts.length > 0) return parts.join(' · ')
  return quota && quota.limits.length > 0
    ? NO_LIMITS_REPORTED
    : NO_QUOTA_READING
}
