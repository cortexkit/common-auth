import { describe, expect, test } from 'bun:test'
import {
  type AccountKey,
  confirmedAffinity,
  createRequestHistory,
  earliestPoolEngine,
  type LimitCandidate,
  type LimitWindow,
  windowRouter,
} from '../../../src/limits/index.js'
import { conformanceExclusions } from './exclusions.js'
import {
  type DriverFacts,
  type DriverState,
  runFakeClockDriver,
} from './fake-clock-driver.js'
import {
  buildConformanceReport,
  type ConformanceReportInput,
  conformancePresets,
  conformanceRows,
  type VectorResult,
  validateConformanceExclusions,
} from './rows.js'

// These entries test report accounting, not provider behavior. They must not be
// imported as coverage by the real row-vector suites.
function syntheticReportInput(): ConformanceReportInput {
  const synthetic = (status: 'R' | 'D'): VectorResult[] =>
    conformanceRows
      .filter(
        (row) =>
          row.status === status &&
          !conformanceExclusions.some((entry) => entry.rowId === row.id),
      )
      .map((row) => ({
        rowId: row.id,
        preset: row.preset,
        name: `synthetic ${row.id} bookkeeping only`,
        status: 'passed',
      }))
  return { covered: synthetic('R'), witnesses: synthetic('D') }
}

describe('conformance catalog and closed exclusions', () => {
  test('catalog has exactly the 320 supplied row ids and their R/B/D counts', () => {
    const expectedIds = [
      ...Array.from(
        { length: 110 },
        (_, i) => `AN${String(i + 1).padStart(2, '0')}`,
      ),
      ...Array.from({ length: 21 }, (_, i) => `AG-WAIT-${i + 1}`),
      ...Array.from({ length: 11 }, (_, i) => `AG-INNER-${i + 1}`),
      ...Array.from({ length: 6 }, (_, i) => `AG-SKIP-${i + 1}`),
      ...Array.from({ length: 12 }, (_, i) => `AG-CLASS-${i + 1}`),
      ...Array.from({ length: 21 }, (_, i) => `AG-MARK-${i + 1}`),
      ...Array.from({ length: 70 }, (_, i) => `OA-${i + 1}`),
      ...Array.from({ length: 69 }, (_, i) => `CL-${i + 1}`),
    ]
    expect(conformanceRows.map((row) => row.id)).toEqual(expectedIds)
    expect(new Set(expectedIds).size).toBe(320)
    expect(
      conformancePresets.map((preset) =>
        ['R', 'B', 'D'].map(
          (status) =>
            conformanceRows.filter(
              (row) => row.preset === preset && row.status === status,
            ).length,
        ),
      ),
    ).toEqual([
      [58, 52, 0],
      [55, 16, 0],
      [48, 21, 1],
      [58, 10, 1],
    ])
    expect(
      conformanceRows.filter((row) => row.status === 'D').map((row) => row.id),
    ).toEqual(['OA-23', 'CL-15'])
  })

  test('closed fixture contains only unique R rows with permitted reasons', () => {
    expect(() =>
      validateConformanceExclusions(conformanceExclusions),
    ).not.toThrow()
    for (const entry of conformanceExclusions) {
      expect(['plugin-transport', 'out-of-phase']).toContain(entry.reason)
      expect(
        conformanceRows.find((row) => row.id === entry.rowId)?.status,
      ).toBe('R')
    }
  })

  test.each(['boundary', 'not-implemented', '', 'plugin_transport'])(
    'synthetic exclusion rejects any unapproved reason: %j',
    (reason) => {
      expect(() =>
        validateConformanceExclusions([{ rowId: 'AN01', reason }]),
      ).toThrow('Invalid exclusion reason for AN01')
    },
  )

  test.each(['plugin-transport', 'out-of-phase'])(
    'synthetic exclusion validator accepts the closed reason %s for an R row',
    (reason) => {
      expect([
        ...validateConformanceExclusions([{ rowId: 'AN01', reason }]),
      ]).toEqual(['AN01'])
    },
  )

  test.each(['plugin-transport', 'out-of-phase'])(
    'synthetic exclusions never accept B or D even with approved reason %s',
    (reason) => {
      for (const row of conformanceRows.filter((row) => row.status !== 'R'))
        expect(() =>
          validateConformanceExclusions([{ rowId: row.id, reason }]),
        ).toThrow(`Only R rows may be excluded: ${row.id}`)
    },
  )

  test('synthetic exclusions reject unknown rows and duplicate ids', () => {
    expect(() =>
      validateConformanceExclusions([
        { rowId: 'AN111', reason: 'plugin-transport' },
      ]),
    ).toThrow('Unknown conformance row: AN111')
    expect(() =>
      validateConformanceExclusions([
        { rowId: 'AN01', reason: 'plugin-transport' },
        { rowId: 'AN01', reason: 'out-of-phase' },
      ]),
    ).toThrow('Duplicate exclusion: AN01')
  })
})

const epoch = 1_700_000_000_000
const initialClock = 1000
const A: AccountKey = {
  namespace: 'synthetic',
  accountId: 'A',
  incarnation: '1',
}
const B: AccountKey = { ...A, accountId: 'B' }
const scope = { kind: 'model', model: 'claude-sonnet' } as const

function syntheticHistory() {
  return createRequestHistory({
    requestId: 'synthetic-turn',
    originalUrl: '/synthetic',
    clockNow: initialClock,
  })
}

function candidate(
  account: AccountKey,
  patch: Partial<LimitCandidate> = {},
): LimitCandidate {
  return {
    account,
    admitted: true,
    placementEligible: true,
    ready: true,
    blockers: [],
    ...patch,
  }
}

function syntheticFacts(patch: Partial<DriverFacts> = {}): DriverFacts {
  return {
    phase: 'pre-send',
    host: 'opencode1',
    sessionId: 'session-a',
    requestScope: scope,
    delivery: { owned: true, attributable: true, replayable: true },
    candidates: [candidate(A), candidate(B)],
    selection: { account: A, pin: 'pin' },
    ...patch,
  }
}

const driverStart = () => ({
  now: epoch,
  clockNow: initialClock,
  history: syntheticHistory(),
})

describe('synthetic fake-clock executor inputs (not real row vectors)', () => {
  test('synthetic pool waits reselect live alternatives and reset the blocked period after sends', () => {
    const trace = runFakeClockDriver({
      ...driverStart(),
      axes: earliestPoolEngine,
      readFacts(state) {
        if (state.event.type === 'sent' && state.now === epoch + 5000)
          return undefined
        if (state.event.type === 'wake')
          return syntheticFacts({
            attempted: state.now === epoch + 2000 ? A : B,
            selection: {
              account: state.now === epoch + 2000 ? B : A,
              pin: 'pin',
            },
          })
        const first = state.event.type === 'start'
        return syntheticFacts({
          phase: first ? 'pre-send' : 'after-limit',
          attempted: first ? undefined : B,
          status: first ? undefined : 429,
          candidates: [
            candidate(A, {
              ready: false,
              blockers: [
                { kind: 'hard', until: epoch + (first ? 2000 : 5000) },
              ],
            }),
            candidate(B, {
              ready: false,
              blockers: [
                { kind: 'hard', until: epoch + (first ? 5000 : 7000) },
              ],
            }),
          ],
        })
      },
    })
    expect(trace.decisions.map(({ decision }) => decision.action)).toEqual([
      'wait-then-reselect',
      'reroute',
      'wait-then-reselect',
      'reroute',
    ])
    expect(trace.sleeps).toEqual([
      { now: epoch, clockNow: 1000, delayMs: 2000 },
      { now: epoch + 2000, clockNow: 3000, delayMs: 3000 },
    ])
    expect(trace.sends).toEqual([
      { now: epoch + 2000, clockNow: 3000, account: B },
      { now: epoch + 5000, clockNow: 6000, account: A },
    ])
    expect(trace.decisions[0]!.decision.history.blockedSince).toBe(1000)
    expect(trace.decisions[2]!.decision.history.blockedSince).toBe(3000)
    expect(trace.history.blockedSince).toBeUndefined()
    expect(trace.history.requestStartedAt).toBe(1000)
    expect(trace.history.switches).toBe(2)
  })

  test('synthetic elapsed time does not make stale blocked evidence ready', () => {
    const trace = runFakeClockDriver({
      ...driverStart(),
      axes: earliestPoolEngine,
      readFacts: () =>
        syntheticFacts({
          poolWaitBudgetMs: 3000,
          candidates: [
            candidate(A, {
              ready: false,
              blockers: [{ kind: 'hard', until: epoch + 2000 }],
            }),
          ],
        }),
    })
    expect(trace.decisions.map(({ decision }) => decision.action)).toEqual([
      'wait-then-reselect',
      'refuse',
    ])
    expect(trace.sleeps).toEqual([
      { now: epoch, clockNow: 1000, delayMs: 2000 },
    ])
    expect(trace.sends).toEqual([])
    expect(trace.decisions.at(-1)!.decision).toMatchObject({
      action: 'refuse',
      reason: 'quota',
    })
  })

  test.each([0, 600000])(
    'synthetic immutable deadline aborts before a ready wake, with blocked budget %d',
    (poolWaitBudgetMs) => {
      let reads = 0
      const trace = runFakeClockDriver({
        ...driverStart(),
        axes: earliestPoolEngine,
        readFacts(state) {
          reads++
          return syntheticFacts({
            poolWaitBudgetMs,
            candidates: [
              candidate(A, {
                ready: state.event.type === 'wake',
                blockers:
                  state.event.type === 'wake'
                    ? []
                    : [{ kind: 'hard', until: epoch + 600000 }],
              }),
            ],
          })
        },
      })
      expect(trace.stop).toBe('deadline')
      expect(reads).toBe(1)
      expect(trace.decisions.map(({ decision }) => decision.action)).toEqual([
        'wait-then-reselect',
      ])
      expect(trace.sleeps).toEqual([
        { now: epoch, clockNow: 1000, delayMs: 600000 },
      ])
      expect(trace.sends).toEqual([])
      expect(trace.history.requestStartedAt).toBe(1000)
    },
  )

  test('synthetic accepted send ends the pre-response deadline without a later timer', () => {
    const trace = runFakeClockDriver({
      ...driverStart(),
      now: epoch + 599999,
      clockNow: initialClock + 599999,
      axes: earliestPoolEngine,
      readFacts: (state) =>
        state.event.type === 'sent' ? undefined : syntheticFacts(),
    })
    expect(trace.stop).toBe('sent')
    expect(trace.sends).toEqual([
      { now: epoch + 599999, clockNow: 600999, account: A },
    ])
    expect(trace.sleeps).toEqual([])
  })

  const window: LimitWindow = {
    window: '5h',
    confirmed: true,
    confirmedByReading: true,
    resetAt: epoch + 1000,
    observedAt: epoch,
    provenance: 'synthetic-reading',
  }
  function heldFacts(state: DriverState, patch: Partial<LimitCandidate> = {}) {
    return syntheticFacts({
      phase: state.event.type === 'start' ? 'after-limit' : 'pre-send',
      host: 'opencode2',
      hostPhase: 'retry',
      remainingRetries: 1,
      status: 429,
      attempted: A,
      signal:
        state.event.type === 'start'
          ? {
              account: A,
              kind: 'quota-exhausted',
              reason: 'synthetic-exhaustion',
              status: 429,
              scope,
              windows: [window],
              observedAt: epoch,
            }
          : undefined,
      hold: { cacheExpiresAt: epoch + 3600000, maxWaitMs: 900000 },
      candidates: [
        candidate(A, {
          ready: false,
          placementEligible: false,
          confirmedBlockers: [window],
          ...patch,
        }),
        candidate(B),
      ],
      selection: { account: B, pin: 'pin' },
    })
  }

  test('synthetic hold sleeps once and supplies its checkpoint before sending to A', () => {
    const events: string[] = []
    const trace = runFakeClockDriver({
      ...driverStart(),
      axes: confirmedAffinity,
      readFacts(state) {
        events.push(state.event.type)
        return state.event.type === 'sent' ? undefined : heldFacts(state)
      },
    })
    expect(events).toEqual(['start', 'wake', 'sent'])
    expect(trace.decisions.map(({ decision }) => decision.action)).toEqual([
      'hold',
      'retain',
    ])
    expect(trace.sleeps).toEqual([
      { now: epoch, clockNow: 1000, delayMs: 17000 },
    ])
    expect(trace.decisions[0]!.decision).toMatchObject({
      target: epoch + 17000,
      checkpoint: {
        accountKey: A,
        decidedAt: epoch,
        blockers: [{ window: '5h', resetAt: epoch + 1000 }],
      },
    })
    expect(trace.decisions[1]!.decision).toMatchObject({
      action: 'retain',
      account: A,
      liftedWindows: ['5h'],
      reason: 'wait-elapsed',
    })
    expect(trace.sends).toEqual([
      { now: epoch + 17000, clockNow: 18000, account: A },
    ])
    expect(trace.history.retains).toEqual([])
  })

  test.each(['admission-revoked', 'identity-replaced'])(
    'synthetic wake refreshes live facts before sends: %s',
    (change) => {
      const trace = runFakeClockDriver({
        ...driverStart(),
        axes: confirmedAffinity,
        readFacts(state) {
          if (state.event.type === 'sent') return undefined
          return heldFacts(
            state,
            state.event.type === 'wake'
              ? change === 'admission-revoked'
                ? { admitted: false }
                : { account: { ...A, incarnation: 'replacement' } }
              : {},
          )
        },
      })
      expect(trace.decisions.map(({ decision }) => decision.action)).toEqual([
        'hold',
        'reroute',
      ])
      expect(trace.sends).toEqual([
        { now: epoch + 17000, clockNow: 18000, account: B },
      ])
      expect(trace.sleeps).toHaveLength(1)
    },
  )

  test('synthetic model exclusions commit effects once, send B without a switch charge, then refuse', () => {
    const trace = runFakeClockDriver({
      ...driverStart(),
      axes: earliestPoolEngine,
      readFacts(state) {
        const excluded = state.event.type === 'excluded'
        const attempted =
          state.event.type === 'start'
            ? A
            : state.event.type === 'sent'
              ? state.event.decision.account
              : state.event.type === 'excluded'
                ? state.event.decision.account
                : A
        return syntheticFacts({
          phase: excluded ? 'pre-send' : 'after-limit',
          attempted,
          signal: excluded
            ? undefined
            : {
                account: attempted,
                kind: 'model-unavailable',
                reason: 'NOT_FOUND',
                scope,
                windows: [],
                observedAt: state.now,
              },
          selection: { account: excluded ? B : A, pin: 'pin' },
        })
      },
    })
    expect(trace.decisions.map(({ decision }) => decision.action)).toEqual([
      'exclude-for-request',
      'reroute',
      'exclude-for-request',
      'refuse',
    ])
    expect(trace.sleeps).toEqual([])
    expect(trace.sends).toEqual([{ now: epoch, clockNow: 1000, account: B }])
    expect(trace.exclusions).toEqual(
      [A, B].map((account) => ({
        account,
        effects: {
          refundHybridToken: true,
          cancelDiscardedBody: true,
          addMark: false,
          addCooldown: false,
          penalizeHealth: false,
          chargeSwitch: false,
        },
      })),
    )
    expect(
      trace.history.excludedForRequest.map((entry) => entry.account),
    ).toEqual([A, B])
    expect(trace.history.switches).toBe(0)
    expect(trace.decisions.at(-1)!.decision).toMatchObject({
      action: 'refuse',
      reason: 'model-unavailable',
    })
  })

  test('synthetic untimed retain records a send and committed history, with no timer', () => {
    const trace = runFakeClockDriver({
      ...driverStart(),
      axes: windowRouter,
      readFacts(state) {
        if (state.event.type === 'sent') return undefined
        return syntheticFacts({
          phase: 'after-limit',
          host: 'pi',
          affinity: 'sticky',
          status: 429,
          attempted: A,
        })
      },
    })
    expect(trace.decisions[0]!.decision).toMatchObject({
      action: 'retain',
      account: A,
    })
    expect(trace.decisions[0]!.decision).not.toHaveProperty('retryMs')
    expect(trace.sleeps).toEqual([])
    expect(trace.sends).toEqual([{ now: epoch, clockNow: 1000, account: A }])
    expect(trace.history.retains).toEqual([
      { account: A, count: 1, startedAt: 1000, lastRetainedAt: 1000 },
    ])
  })

  test('synthetic timed retain cannot fabricate a send without a host retry carrier', () => {
    expect(() =>
      runFakeClockDriver({
        ...driverStart(),
        axes: confirmedAffinity,
        readFacts: () =>
          syntheticFacts({
            phase: 'after-limit',
            status: 429,
            attempted: A,
            signal: {
              account: A,
              kind: 'rate-limit',
              reason: 'synthetic-unknown-limit',
              status: 429,
              scope,
              windows: [],
              observedAt: epoch,
            },
          }),
      }),
    ).toThrow('Timed retain requires a host retry driver')
  })

  test('synthetic pass leaves transport to the host and records no send', () => {
    const trace = runFakeClockDriver({
      ...driverStart(),
      axes: confirmedAffinity,
      readFacts: () => syntheticFacts({ phase: 'after-limit', status: 500 }),
    })
    expect(trace.decisions[0]!.decision.action).toBe('pass')
    expect(trace.sleeps).toEqual([])
    expect(trace.sends).toEqual([])
  })

  test('synthetic endless waits fail at the decision bound rather than hang', () => {
    expect(() =>
      runFakeClockDriver({
        ...driverStart(),
        axes: earliestPoolEngine,
        maxDecisions: 2,
        readFacts: (state) =>
          syntheticFacts({
            candidates: [
              candidate(A, {
                ready: false,
                blockers: [{ kind: 'hard', until: state.now + 1000 }],
              }),
            ],
          }),
      }),
    ).toThrow('Driver exceeded 2 decisions')
  })

  test('synthetic missing wake facts fail rather than imply a successful dispatch', () => {
    expect(() =>
      runFakeClockDriver({
        ...driverStart(),
        axes: confirmedAffinity,
        readFacts: (state) =>
          state.event.type === 'start' ? heldFacts(state) : undefined,
      }),
    ).toThrow('Missing facts after wake')
  })

  test('synthetic invalid clocks, bounds and missing initial facts fail immediately', () => {
    const input = {
      ...driverStart(),
      axes: confirmedAffinity,
      readFacts: () => undefined,
    }
    expect(() => runFakeClockDriver(input)).toThrow('Missing facts after start')
    expect(() => runFakeClockDriver({ ...input, now: Number.NaN })).toThrow(
      'Driver clocks must be finite',
    )
    expect(() => runFakeClockDriver({ ...input, clockNow: Infinity })).toThrow(
      'Driver clocks must be finite',
    )
    for (const maxDecisions of [0, -1, 1.5, Infinity])
      expect(() => runFakeClockDriver({ ...input, maxDecisions })).toThrow(
        'maxDecisions must be a positive integer',
      )
  })
})

describe('synthetic conformance report inputs (not real row coverage)', () => {
  test('synthetic complete inputs report AN 110, AG 71, OA 70, CL 69: total 320', () => {
    const report = buildConformanceReport(syntheticReportInput())
    expect(report).toEqual({
      'confirmed-affinity': {
        rCovered: 58,
        rExcluded: 0,
        bRows: 52,
        dWitnesses: 0,
        total: 110,
      },
      'earliest-pool-engine': {
        rCovered: 55,
        rExcluded: 0,
        bRows: 16,
        dWitnesses: 0,
        total: 71,
      },
      'window-router': {
        rCovered: 48,
        rExcluded: 0,
        bRows: 21,
        dWitnesses: 1,
        total: 70,
      },
      'status-vault-order': {
        rCovered: 58,
        rExcluded: 0,
        bRows: 10,
        dWitnesses: 1,
        total: 69,
      },
    })
    expect(
      Object.values(report).reduce((sum, preset) => sum + preset.total, 0),
    ).toBe(320)
  })

  test('synthetic input with even one R row missing from both lists fails', () => {
    const input = syntheticReportInput()
    expect(input.covered.some((entry) => entry.rowId === 'AN03')).toBe(true)
    expect(() =>
      buildConformanceReport({
        ...input,
        covered: input.covered.filter((entry) => entry.rowId !== 'AN03'),
      }),
    ).toThrow('Missing R rows: AN03')
  })

  test('synthetic empty coverage cannot treat the R design map as executed tests', () => {
    expect(() =>
      buildConformanceReport({ covered: [], witnesses: [] }),
    ).toThrow('Missing R rows: AN01')
  })

  test('synthetic input requires both D behavior-change witnesses', () => {
    const input = syntheticReportInput()
    for (const id of ['OA-23', 'CL-15'])
      expect(() =>
        buildConformanceReport({
          ...input,
          witnesses: input.witnesses.filter((entry) => entry.rowId !== id),
        }),
      ).toThrow(`Missing D witnesses: ${id}`)
  })

  test.each(['failed', 'skipped'] as const)(
    'synthetic %s vector is never counted as coverage or a D witness',
    (status) => {
      const input = syntheticReportInput()
      for (const key of ['covered', 'witnesses'] as const) {
        const result = input[key][0]!
        expect(() =>
          buildConformanceReport({
            ...input,
            [key]: [{ ...result, status }, ...input[key].slice(1)],
          }),
        ).toThrow(`Vector did not pass: ${result.rowId}`)
      }
    },
  )

  test('synthetic results reject unknown, boundary, misplaced and unnamed rows', () => {
    const input = syntheticReportInput()
    const first = input.covered[0]!
    for (const [patch, message] of [
      [{ rowId: 'AN111' }, 'Unknown conformance row: AN111'],
      [{ rowId: 'AN28' }, 'Expected R result, got B: AN28'],
      [{ rowId: 'OA-23' }, 'Expected R result, got D: OA-23'],
      [{ preset: 'window-router' }, 'Wrong preset for AN01'],
      [
        { name: 'synthetic AN010 is not AN01s row id' },
        'Vector name must contain row id AN01',
      ],
    ] as const)
      expect(() =>
        buildConformanceReport({
          ...input,
          covered: [{ ...first, ...patch }, ...input.covered.slice(1)],
        }),
      ).toThrow(message)
    expect(() =>
      buildConformanceReport({
        ...input,
        witnesses: [{ ...first }, ...input.witnesses],
      }),
    ).toThrow('Expected D result, got R: AN01')
  })

  test('synthetic host variants count a row once, but duplicate results fail', () => {
    const input = syntheticReportInput()
    const first = input.covered[0]!
    expect(
      buildConformanceReport({
        ...input,
        covered: [
          ...input.covered,
          { ...first, name: `synthetic ${first.rowId} other host` },
        ],
      }),
    ).toEqual(buildConformanceReport(input))
    expect(() =>
      buildConformanceReport({
        ...input,
        covered: [...input.covered, first],
      }),
    ).toThrow('Duplicate vector: AN01')
  })
})
