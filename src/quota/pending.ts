import type { QuotaObservation } from './merge.js'

export interface QuotaPublication {
  observation: QuotaObservation
}

export interface QuotaField<P extends QuotaPublication> {
  at: number
  order: number
  publication: P
  priorReading?: P
}

// Use the same independently dated parts as mergeQuotaObservation. A header
// reading cannot erase a poll-only window, counter, credits record or budget.
export function quotaFields<P extends QuotaPublication>(
  publication: P,
  witness = '',
): Map<string, QuotaField<P>> {
  const result = new Map<string, QuotaField<P>>()
  const { observation } = publication
  const add = (key: string, at: number, part: QuotaObservation) =>
    result.set(`${witness}:${key}`, {
      at,
      order: 0,
      publication: { ...publication, observation: part },
    })
  const keyFor = (scope: string | undefined, label: string) =>
    JSON.stringify([scope ?? 'all', label])
  const read = new Set<string>()
  for (const reading of observation.readings ?? []) {
    const key = keyFor(reading.scope, reading.label)
    read.add(key)
    add(key, observation.checkedAt, {
      checkedAt: observation.checkedAt,
      readings: [{ ...reading }],
    })
  }
  for (const pair of observation.coverage ?? []) {
    const key = keyFor(pair.scope, pair.label)
    if (!read.has(key))
      add(key, observation.checkedAt, {
        checkedAt: observation.checkedAt,
        coverage: [{ ...pair }],
      })
  }
  if (observation.budget)
    add('budget', observation.checkedAt, {
      checkedAt: observation.checkedAt,
      budget: { ...observation.budget },
    })
  for (const [name, counter] of Object.entries(observation.counters ?? {})) {
    add(`counter:${name}`, counter.checkedAt, {
      checkedAt: observation.checkedAt,
      counters: { [name]: { ...counter } },
    })
  }
  if (observation.credits)
    add('credits', observation.credits.checkedAt, {
      checkedAt: observation.checkedAt,
      credits: { ...observation.credits },
    })
  if (!result.size)
    add('empty', observation.checkedAt, { checkedAt: observation.checkedAt })
  return result
}
