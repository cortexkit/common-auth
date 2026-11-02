export type ExclusionReason = 'plugin-transport' | 'out-of-phase'

export interface ConformanceExclusion {
  readonly rowId: string
  readonly reason: ExclusionReason
}

// Reproduced rows may be excluded only for transport-only publication or an
// explicit library non-goal, such as plugin adoption. The list is intentionally
// empty: plugin-owned transports still leave parsed signals, timed account-block
// records and shared routing decisions testable here. Missing vectors do not
// justify exclusion.
export const conformanceExclusions: readonly ConformanceExclusion[] = []
