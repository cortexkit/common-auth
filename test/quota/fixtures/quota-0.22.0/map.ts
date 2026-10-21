// A frozen copy of `src/quota/map.ts` exactly as published in
// @cortexkit/common-auth 0.22.0 (git blob e971a48af097431d2ac1471fbcdc65b1bba669f8
// at tag v0.22.0).
// Tests run it as a 0.22 reader to show that quota written by a newer version
// keeps fields 0.22 does not know about. Never edit the code below this comment.

// The per-row quota map: what the pool knows about one row's limits.
//
// A row's quota is a set of keyed limits. Each key is a (scope, window label)
// pair: the scope is `all` for a limit that binds every request, or a model
// family name for a limit that binds only that family; the label names the
// window the provider reports (for example `primary` or `secondary`). Each key
// holds one entry, which is either a reading, a retirement tombstone (the key
// held a reading until an authoritative observation stopped reporting it), or
// an absence record (an authoritative observation reported the key as having
// no limit before any reading was seen). Tombstones and absence records are
// evidence that the key is known to be unlimited; a missing key is unknown.
//
// Beside the limits sits the credit budget, a third pressure axis with its own
// reset clock. It is a tri-state: absent (never reported), a reading, or
// cleared (the provider reported that no budget exists).
//
// The map is plain JSON so the store can persist it without interpreting it.

/** The scope of a limit that binds every request regardless of model. */
export const ALL_SCOPE = 'all'

/** The window label required when an admission call supplies none. */
export const DEFAULT_REQUIRED_LABELS: readonly string[] = Object.freeze([
  'primary',
])

export interface QuotaReadingEntry {
  scope: string
  label: string
  kind: 'reading'
  checkedAt: number
  usedPercent: number
  /** ISO timestamp at which the window resets, as the provider reported it. */
  resetsAt?: string
  /** Window length in minutes, when the provider reported one. */
  windowMinutes?: number
}

export interface QuotaRetiredEntry {
  scope: string
  label: string
  kind: 'retired'
  retiredAt: number
}

export interface QuotaAbsentEntry {
  scope: string
  label: string
  kind: 'absent'
  checkedAt: number
}

export type QuotaEntry =
  | QuotaReadingEntry
  | QuotaRetiredEntry
  | QuotaAbsentEntry

export interface CreditBudgetReading {
  kind: 'reading'
  checkedAt: number
  /** The provider's own verdict that the budget is spent. */
  reached: boolean
  remainingPercent?: number
  usedPercent?: number
  resetsAt?: string
  limit?: number
  used?: number
  remaining?: number
  unit?: string
}

export interface CreditBudgetCleared {
  kind: 'cleared'
  checkedAt: number
}

export type CreditBudgetEntry = CreditBudgetReading | CreditBudgetCleared

export interface QuotaCounter {
  value: number
  checkedAt: number
}

export interface QuotaMap {
  limits: QuotaEntry[]
  /** Absent means no observation has reported on the budget yet. */
  budget?: CreditBudgetEntry
  /** Provider-named counts, each with its own observation time. */
  counters?: Record<string, QuotaCounter>
}

export function emptyQuotaMap(): QuotaMap {
  return { limits: [] }
}

/** The time an entry speaks for: its reading, retirement or absence time. */
export function entryTime(entry: QuotaEntry): number {
  return entry.kind === 'retired' ? entry.retiredAt : entry.checkedAt
}

export function limitKey(scope: string, label: string): string {
  // JSON-encoding the pair keeps keys unambiguous for any scope or label text.
  return JSON.stringify([scope, label])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function optional(
  record: Record<string, unknown>,
  key: string,
  check: (value: unknown) => boolean,
): boolean {
  return record[key] === undefined || check(record[key])
}

function isPositiveFinite(value: unknown): boolean {
  return isFiniteNumber(value) && value > 0
}

function isString(value: unknown): boolean {
  return typeof value === 'string'
}

function isQuotaEntry(value: unknown): value is QuotaEntry {
  if (!isRecord(value) || !isName(value.scope) || !isName(value.label)) {
    return false
  }
  switch (value.kind) {
    case 'reading':
      return (
        isFiniteNumber(value.checkedAt) &&
        isFiniteNumber(value.usedPercent) &&
        optional(value, 'resetsAt', isString) &&
        optional(value, 'windowMinutes', isPositiveFinite)
      )
    case 'retired':
      return isFiniteNumber(value.retiredAt)
    case 'absent':
      return isFiniteNumber(value.checkedAt)
    default:
      return false
  }
}

export function isCreditBudgetEntry(
  value: unknown,
): value is CreditBudgetEntry {
  if (!isRecord(value) || !isFiniteNumber(value.checkedAt)) return false
  if (value.kind === 'cleared') return true
  return (
    value.kind === 'reading' &&
    typeof value.reached === 'boolean' &&
    optional(value, 'remainingPercent', isFiniteNumber) &&
    optional(value, 'usedPercent', isFiniteNumber) &&
    optional(value, 'resetsAt', isString) &&
    optional(value, 'limit', isFiniteNumber) &&
    optional(value, 'used', isFiniteNumber) &&
    optional(value, 'remaining', isFiniteNumber) &&
    optional(value, 'unit', isString)
  )
}

function isQuotaCounter(value: unknown): value is QuotaCounter {
  return (
    isRecord(value) &&
    isFiniteNumber(value.value) &&
    Number.isInteger(value.value) &&
    value.value >= 0 &&
    isFiniteNumber(value.checkedAt)
  )
}

export function isQuotaCounters(
  value: unknown,
): value is Record<string, QuotaCounter> {
  return isRecord(value) && Object.values(value).every(isQuotaCounter)
}

/** Keep usable counters without letting one malformed count hide a quota map. */
export function readQuotaCounters(
  value: unknown,
): Record<string, QuotaCounter> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value).filter(([, entry]) =>
    isQuotaCounter(entry),
  )
  return entries.length === 0
    ? undefined
    : (Object.fromEntries(entries) as Record<string, QuotaCounter>)
}

/** Decode persisted quota, dropping malformed counters but not limit evidence. */
export function decodeQuotaMap(value: unknown): QuotaMap | undefined {
  // A valid map is returned as the same object, so stored quota keeps the
  // identity it had before counters existed; only a map with a malformed
  // counter is copied without it.
  if (isQuotaMap(value)) return value
  if (!isRecord(value)) return undefined
  const { counters: rawCounters, ...rest } = value
  if (!isQuotaMap(rest)) return undefined
  const counters = readQuotaCounters(rawCounters)
  return { ...rest, ...(counters === undefined ? {} : { counters }) }
}

/**
 * True when `value` is a well-formed quota map. Unrecognised top-level keys
 * are tolerated (and preserved by merge) so a newer writer's additions
 * survive; a malformed entry, a duplicated (scope, label) key or a malformed
 * budget makes the whole map invalid.
 */
export function isQuotaMap(value: unknown): value is QuotaMap {
  if (!isRecord(value) || !Array.isArray(value.limits)) return false
  const seen = new Set<string>()
  for (const entry of value.limits) {
    if (!isQuotaEntry(entry)) return false
    const key = limitKey(entry.scope, entry.label)
    if (seen.has(key)) return false
    seen.add(key)
  }
  return (
    optional(value, 'budget', isCreditBudgetEntry) &&
    optional(value, 'counters', isQuotaCounters)
  )
}
