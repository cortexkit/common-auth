import { conformanceExclusions } from './exclusions.js'

export const conformancePresets = [
  'confirmed-affinity',
  'earliest-pool-engine',
  'window-router',
  'status-vault-order',
] as const

export type ConformancePreset = (typeof conformancePresets)[number]
export type RowStatus = 'R' | 'B' | 'D'

export interface ConformanceRow {
  readonly id: string
  readonly preset: ConformancePreset
  readonly status: RowStatus
}

function range(
  preset: ConformancePreset,
  prefix: string,
  first: number,
  last: number,
  status: RowStatus,
): ConformanceRow[] {
  return Array.from({ length: last - first + 1 }, (_, index) => ({
    id: `${prefix}${prefix === 'AN' ? String(first + index).padStart(2, '0') : first + index}`,
    preset,
    status,
  }))
}

// The §7 map in shared-auth-policy-contracts.md plus the counted Anthropic rows,
// not a claim of test coverage. Keep B ranges explicit: an omitted R must not silently become B.
export const conformanceRows: readonly ConformanceRow[] = [
  ...range('confirmed-affinity', 'AN', 1, 27, 'R'),
  ...range('confirmed-affinity', 'AN', 28, 47, 'B'),
  ...range('confirmed-affinity', 'AN', 48, 60, 'R'),
  ...range('confirmed-affinity', 'AN', 61, 88, 'B'),
  ...range('confirmed-affinity', 'AN', 89, 94, 'R'),
  ...range('confirmed-affinity', 'AN', 95, 98, 'B'),
  ...range('confirmed-affinity', 'AN', 99, 100, 'R'),
  // Counted unconfirmed retries ported from anthropic-auth's core and host tests.
  ...range('confirmed-affinity', 'AN', 101, 110, 'R'),

  ...range('earliest-pool-engine', 'AG-WAIT-', 1, 21, 'R'),
  ...range('earliest-pool-engine', 'AG-INNER-', 1, 11, 'B'),
  ...range('earliest-pool-engine', 'AG-SKIP-', 1, 2, 'R'),
  ...range('earliest-pool-engine', 'AG-SKIP-', 3, 3, 'B'),
  ...range('earliest-pool-engine', 'AG-SKIP-', 4, 6, 'R'),
  ...range('earliest-pool-engine', 'AG-CLASS-', 1, 2, 'R'),
  ...range('earliest-pool-engine', 'AG-CLASS-', 3, 3, 'B'),
  ...range('earliest-pool-engine', 'AG-CLASS-', 4, 8, 'R'),
  ...range('earliest-pool-engine', 'AG-CLASS-', 9, 11, 'B'),
  ...range('earliest-pool-engine', 'AG-CLASS-', 12, 12, 'R'),
  ...range('earliest-pool-engine', 'AG-MARK-', 1, 21, 'R'),

  ...range('window-router', 'OA-', 1, 13, 'R'),
  ...range('window-router', 'OA-', 14, 15, 'B'),
  ...range('window-router', 'OA-', 16, 22, 'R'),
  ...range('window-router', 'OA-', 23, 23, 'D'),
  ...range('window-router', 'OA-', 24, 28, 'R'),
  ...range('window-router', 'OA-', 29, 30, 'B'),
  ...range('window-router', 'OA-', 31, 33, 'R'),
  ...range('window-router', 'OA-', 34, 35, 'B'),
  ...range('window-router', 'OA-', 36, 39, 'R'),
  ...range('window-router', 'OA-', 40, 48, 'B'),
  ...range('window-router', 'OA-', 49, 51, 'R'),
  ...range('window-router', 'OA-', 52, 52, 'B'),
  ...range('window-router', 'OA-', 53, 59, 'R'),
  ...range('window-router', 'OA-', 60, 60, 'B'),
  ...range('window-router', 'OA-', 61, 61, 'R'),
  ...range('window-router', 'OA-', 62, 62, 'B'),
  ...range('window-router', 'OA-', 63, 67, 'R'),
  ...range('window-router', 'OA-', 68, 70, 'B'),

  ...range('status-vault-order', 'CL-', 1, 12, 'R'),
  ...range('status-vault-order', 'CL-', 13, 13, 'B'),
  ...range('status-vault-order', 'CL-', 14, 14, 'R'),
  ...range('status-vault-order', 'CL-', 15, 15, 'D'),
  ...range('status-vault-order', 'CL-', 16, 24, 'R'),
  ...range('status-vault-order', 'CL-', 25, 25, 'B'),
  ...range('status-vault-order', 'CL-', 26, 26, 'R'),
  ...range('status-vault-order', 'CL-', 27, 27, 'B'),
  ...range('status-vault-order', 'CL-', 28, 29, 'R'),
  ...range('status-vault-order', 'CL-', 30, 30, 'B'),
  ...range('status-vault-order', 'CL-', 31, 31, 'R'),
  ...range('status-vault-order', 'CL-', 32, 32, 'B'),
  ...range('status-vault-order', 'CL-', 33, 33, 'R'),
  ...range('status-vault-order', 'CL-', 34, 34, 'B'),
  ...range('status-vault-order', 'CL-', 35, 37, 'R'),
  ...range('status-vault-order', 'CL-', 38, 41, 'B'),
  // Parsed payment signals and adopter facts; wire parsing remains plugin-owned.
  ...range('status-vault-order', 'CL-', 42, 69, 'R'),
]

export interface VectorResult {
  readonly rowId: string
  readonly preset: ConformancePreset
  readonly name: string
  readonly status: 'passed' | 'failed' | 'skipped'
}

export interface ConformanceReportInput {
  readonly covered: readonly VectorResult[]
  readonly witnesses: readonly VectorResult[]
}

export interface PresetReport {
  readonly rCovered: number
  readonly rExcluded: number
  readonly bRows: number
  readonly dWitnesses: number
  readonly total: number
}

const catalog = new Map(conformanceRows.map((row) => [row.id, row]))

function lookup(id: string): ConformanceRow {
  const row = catalog.get(id)
  if (!row) throw new Error(`Unknown conformance row: ${id}`)
  return row
}

// Accept strings here so an invalid reason fails at runtime too, not merely
// when the literal fixture is typechecked. The report always uses that fixture.
export function validateConformanceExclusions(
  entries: readonly { readonly rowId: string; readonly reason: string }[],
): ReadonlySet<string> {
  const excluded = new Set<string>()
  for (const entry of entries) {
    if (entry.reason !== 'plugin-transport' && entry.reason !== 'out-of-phase')
      throw new Error(
        `Invalid exclusion reason for ${entry.rowId}: ${entry.reason}`,
      )
    if (lookup(entry.rowId).status !== 'R')
      throw new Error(`Only R rows may be excluded: ${entry.rowId}`)
    if (excluded.has(entry.rowId))
      throw new Error(`Duplicate exclusion: ${entry.rowId}`)
    excluded.add(entry.rowId)
  }
  return excluded
}

/** Count executed results, never the design map itself, as R coverage. */
export function buildConformanceReport(
  input: ConformanceReportInput,
): Record<ConformancePreset, PresetReport> {
  if (catalog.size !== conformanceRows.length)
    throw new Error('Duplicate row in conformance catalog')
  const excluded = validateConformanceExclusions(conformanceExclusions)
  const validateResults = (
    results: readonly VectorResult[],
    status: 'R' | 'D',
  ) => {
    const rows = new Set<string>()
    const names = new Set<string>()
    for (const result of results) {
      const row = lookup(result.rowId)
      if (row.status !== status)
        throw new Error(
          `Expected ${status} result, got ${row.status}: ${row.id}`,
        )
      if (row.preset !== result.preset)
        throw new Error(`Wrong preset for ${row.id}: ${result.preset}`)
      if (!new RegExp(`(?:^|\\W)${row.id}(?=$|\\W)`).test(result.name))
        throw new Error(`Vector name must contain row id ${row.id}`)
      if (result.status !== 'passed')
        throw new Error(`Vector did not pass: ${row.id}: ${result.name}`)
      if (excluded.has(row.id))
        throw new Error(`Row is both covered and excluded: ${row.id}`)
      const key = `${row.id}\0${result.name}`
      if (names.has(key))
        throw new Error(`Duplicate vector: ${row.id}: ${result.name}`)
      names.add(key)
      rows.add(row.id)
    }
    return rows
  }
  const covered = validateResults(input.covered, 'R')
  const witnesses = validateResults(input.witnesses, 'D')
  const missingR = conformanceRows.filter(
    (row) =>
      row.status === 'R' && !covered.has(row.id) && !excluded.has(row.id),
  )
  if (missingR.length)
    throw new Error(
      `Missing R rows: ${missingR.map((row) => row.id).join(', ')}`,
    )
  const missingD = conformanceRows.filter(
    (row) => row.status === 'D' && !witnesses.has(row.id),
  )
  if (missingD.length)
    throw new Error(
      `Missing D witnesses: ${missingD.map((row) => row.id).join(', ')}`,
    )

  return Object.fromEntries(
    conformancePresets.map((preset) => {
      const rows = conformanceRows.filter((row) => row.preset === preset)
      const rCovered = rows.filter((row) => covered.has(row.id)).length
      const rExcluded = rows.filter((row) => excluded.has(row.id)).length
      const bRows = rows.filter((row) => row.status === 'B').length
      const dWitnesses = rows.filter((row) => witnesses.has(row.id)).length
      return [
        preset,
        {
          rCovered,
          rExcluded,
          bRows,
          dWitnesses,
          total: rCovered + rExcluded + bRows + dWitnesses,
        },
      ]
    }),
  ) as Record<ConformancePreset, PresetReport>
}
