import type {
  CreditBudgetEntry,
  QuotaEntry,
  QuotaMap,
} from '../../src/quota/index.js'

export const now = Date.UTC(2026, 7, 10, 12, 0, 0)
export const HOUR = 3_600_000

export function at(offsetMs: number): string {
  return new Date(now + offsetMs).toISOString()
}

export function reading(
  label: string,
  usedPercent: number,
  options: {
    scope?: string
    checkedAt?: number
    resetsAt?: string
    windowMinutes?: number
  } = {},
): QuotaEntry {
  return {
    scope: options.scope ?? 'all',
    label,
    kind: 'reading',
    checkedAt: options.checkedAt ?? now,
    usedPercent,
    ...(options.resetsAt === undefined ? {} : { resetsAt: options.resetsAt }),
    ...(options.windowMinutes === undefined
      ? {}
      : { windowMinutes: options.windowMinutes }),
  }
}

export function retired(
  label: string,
  retiredAt: number,
  scope = 'all',
): QuotaEntry {
  return { scope, label, kind: 'retired', retiredAt }
}

export function absent(
  label: string,
  checkedAt: number,
  scope = 'all',
): QuotaEntry {
  return { scope, label, kind: 'absent', checkedAt }
}

export function spentBudget(
  resetsAt: string | undefined,
  checkedAt = now,
): CreditBudgetEntry {
  return {
    kind: 'reading',
    checkedAt,
    reached: true,
    usedPercent: 100,
    remainingPercent: 0,
    limit: 2500,
    used: 2500,
    remaining: 0,
    ...(resetsAt === undefined ? {} : { resetsAt }),
  }
}

export function quotaMap(
  limits: QuotaEntry[],
  budget?: CreditBudgetEntry,
): QuotaMap {
  return { limits, ...(budget === undefined ? {} : { budget }) }
}

/** A fresh (all, primary) reading at `usedPercent` resetting in a week. */
export function primaryAt(usedPercent: number, checkedAt = now): QuotaMap {
  return quotaMap([
    reading('primary', usedPercent, {
      checkedAt,
      resetsAt: at(7 * 24 * HOUR),
      windowMinutes: 10_080,
    }),
  ])
}

/** Round-trips a map through JSON, as a store write and reload would. */
export function reload<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
