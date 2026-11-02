import type { MergeLaw } from './marker.js'

export interface TimedMarkEntry {
  readonly until: number
  readonly evidenceAt: number
  readonly baseRevision: number
  readonly committedRevision: number
}

/** Apply supersession before expiry, so a short or zero overwrite removes a long mark. */
export function mergeTimedMarkEntries(
  law: MergeLaw,
  entries: readonly TimedMarkEntry[],
  now: number,
  clearRevision = 0,
): readonly TimedMarkEntry[] {
  const candidates = entries.filter((e) => e.baseRevision >= clearRevision)
  if (law !== 'max-until') {
    const winner = candidates.reduce<TimedMarkEntry | undefined>((best, e) => {
      if (!best) return e
      if (law === 'latest-evidence' && e.evidenceAt !== best.evidenceAt) {
        return e.evidenceAt > best.evidenceAt ? e : best
      }
      return e.committedRevision > best.committedRevision ? e : best
    }, undefined)
    return winner && now < winner.until ? [winner] : []
  }

  return candidates
    .filter(
      (e, i) =>
        now < e.until &&
        !candidates.some(
          (other, j) =>
            j !== i &&
            other.until >= e.until &&
            other.baseRevision >= e.baseRevision &&
            (other.until > e.until ||
              other.baseRevision > e.baseRevision ||
              other.committedRevision > e.committedRevision ||
              (other.committedRevision === e.committedRevision && j < i)),
        ),
    )
    .sort((a, b) => a.committedRevision - b.committedRevision)
}

export interface AccessOrder {
  readonly eligibilityStateUpdatedAt: number
  readonly committedRevision: number
}

export function mergeAccessState<T extends AccessOrder>(a: T, b: T): T {
  if (a.eligibilityStateUpdatedAt !== b.eligibilityStateUpdatedAt) {
    return a.eligibilityStateUpdatedAt > b.eligibilityStateUpdatedAt ? a : b
  }
  return a.committedRevision > b.committedRevision ? a : b
}
