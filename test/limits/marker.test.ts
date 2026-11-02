import { describe, expect, test } from 'bun:test'
import {
  type AccountKey,
  ANTIGRAVITY_FAILURE_LADDER,
  type FailureHistory,
  type FailureLadderAxes,
  type LimitSignal,
  type MarkerAxes,
  markFromSignal,
  markIsActive,
  reduceFailureHistory,
  resolveNamedWindowReset,
  scopeCovers,
} from '../../src/limits/index.js'

const account: AccountKey = {
  namespace: 'test:pool',
  accountId: 'A',
  incarnation: '1',
}
function signal(changes: Partial<LimitSignal> = {}): LimitSignal {
  return {
    account,
    kind: 'quota-exhausted',
    reason: 'quota',
    scope: { kind: 'pool' },
    observedAt: 1000,
    windows: [],
    ...changes,
  }
}
const ladder: MarkerAxes = ANTIGRAVITY_FAILURE_LADDER
const hints: MarkerAxes = {
  kind: 'hint',
  mergeLaw: 'overwrite',
  defaultMs: 60000,
  minimumMs: 0,
  zero: 'accept',
  hintClock: 'marker',
}
function failure(
  history: FailureHistory,
  at: number,
  key = account,
  ttlMs?: number,
) {
  return reduceFailureHistory(
    history,
    { type: 'failure', account: key, at },
    ttlMs,
  )
}

describe('hint and failure-ladder marker', () => {
  test('failure-ladder axes supply all duration choices', () => {
    const custom: FailureLadderAxes = {
      kind: 'failure-ladder',
      mergeLaw: 'overwrite',
      hintFloorMs: 17,
      quotaSteps: [11, 22],
      byKind: { 'rate-limit': 33, auth: 0 },
      byReason: { custom: 44, 'zero-reason': 0 },
      capacity: { baseMs: 66, spreadMs: 4 },
      defaultMs: 77,
    }
    expect(
      markFromSignal(signal({ retryAfterMs: 5, reason: 'custom' }), custom, {
        now: 1000,
      }),
    ).toEqual({ scope: { kind: 'pool' }, until: 1017, mergeLaw: 'overwrite' })
    expect(
      markFromSignal(signal({ retryAfterMs: 50 }), custom, { now: 1000 })
        ?.until,
    ).toBe(1050)
    expect(
      markFromSignal(signal({ retryAfterMs: 0, reason: 'custom' }), custom, {
        now: 1000,
      })?.until,
    ).toBe(1044)
    let failures: FailureHistory = new Map()
    for (const until of [1011, 1022, 1022, 1022]) {
      failures = failure(failures, 1000)
      expect(
        markFromSignal(signal(), custom, { now: 1000, failures })?.until,
      ).toBe(until)
    }
    expect(
      markFromSignal(signal({ kind: 'rate-limit' }), custom, { now: 1000 })
        ?.until,
    ).toBe(1033)
    expect(
      markFromSignal(signal({ kind: 'auth' }), custom, { now: 1000 })?.until,
    ).toBe(1000)
    expect(
      markFromSignal(signal({ reason: 'zero-reason' }), custom, { now: 1000 })
        ?.until,
    ).toBe(1000)
    for (const [random, until] of [
      [0, 1062],
      [0.5, 1066],
      [1, 1070],
    ] as const) {
      expect(
        markFromSignal(signal({ kind: 'capacity' }), custom, {
          now: 1000,
          random,
        })?.until,
      ).toBe(until)
    }
    for (const reason of ['server-error', 'unknown', 'toString']) {
      expect(
        markFromSignal(signal({ kind: 'model-unavailable', reason }), custom, {
          now: 1000,
        })?.until,
      ).toBe(1077)
    }
    expect(
      markFromSignal(signal(), { ...custom, quotaSteps: [] }, { now: 1000 })
        ?.until,
    ).toBe(1077)
  })

  test('AG-MARK-1 positive server hints win the reason ladder', () => {
    for (const [kind, retryAfterMs] of [
      ['quota-exhausted', 120000],
      ['rate-limit', 45000],
    ] as const) {
      expect(
        markFromSignal(signal({ kind, retryAfterMs }), ladder, { now: 1000 }),
      ).toEqual({
        scope: { kind: 'pool' },
        until: 1000 + retryAfterMs,
        mergeLaw: 'max-until',
      })
    }
  })

  test('AG-MARK-2 positive hints below two seconds clamp to two seconds', () => {
    for (const hint of [500, 1000, 1500]) {
      expect(
        markFromSignal(signal({ retryAfterMs: hint }), ladder, { now: 1000 })
          ?.until,
      ).toBe(3000)
    }
  })

  test('AG-MARK-3 quota failures use counts 1/2/3/4 and cap at two hours', () => {
    let failures: FailureHistory = new Map()
    for (const duration of [60000, 300000, 1800000, 7200000, 7200000]) {
      failures = failure(failures, 1000)
      expect(markFromSignal(signal(), ladder, { now: 1000, failures })).toEqual(
        {
          scope: { kind: 'pool' },
          until: 1000 + duration,
          mergeLaw: 'max-until',
        },
      )
    }
  })

  test('AG-MARK-4 rate marks stay at thirty seconds regardless of count', () => {
    let failures: FailureHistory = new Map()
    for (let index = 0; index < 6; index++) {
      failures = failure(failures, 1000)
      expect(
        markFromSignal(signal({ kind: 'rate-limit' }), ladder, {
          now: 1000,
          failures,
        })?.until,
      ).toBe(31000)
    }
  })

  test('AG-MARK-5 direct capacity uses the supplied random sample, not the inner wait', () => {
    for (const [random, duration] of [
      [0, 30000],
      [0.5, 45000],
      [1, 60000],
    ]) {
      expect(
        markFromSignal(signal({ kind: 'capacity' }), ladder, {
          now: 1000,
          random,
        })?.until,
      ).toBe(1000 + duration!)
    }
  })

  test('AG-MARK-6/7 direct server-error and unknown defaults', () => {
    expect(
      markFromSignal(signal({ reason: 'server-error' }), ladder, { now: 1000 })
        ?.until,
    ).toBe(21000)
    expect(
      markFromSignal(signal({ reason: 'unknown' }), ladder, { now: 1000 })
        ?.until,
    ).toBe(61000)
  })

  test('AG-MARK-8 history expires strictly beyond its TTL; default TTL is one hour', () => {
    const first = failure(new Map(), 0)
    expect(
      markFromSignal(signal(), ladder, {
        now: 3700000,
        failures: failure(first, 3700000),
      })?.until,
    ).toBe(3760000)
    expect(
      markFromSignal(signal(), ladder, {
        now: 1800000,
        failures: failure(first, 1800000),
      })?.until,
    ).toBe(2100000)
    expect(
      markFromSignal(signal(), ladder, {
        now: 2000,
        failures: failure(first, 2000, account, 1000),
      })?.until,
    ).toBe(62000)
  })

  test('AG-MARK-9 exact TTL equality retains the failure streak', () => {
    const failures = failure(failure(new Map(), 0), 3600000)
    expect(
      markFromSignal(signal(), ladder, { now: 3600000, failures }),
    ).toEqual({
      scope: { kind: 'pool' },
      until: 3900000,
      mergeLaw: 'max-until',
    })
  })

  test('AG-MARK-10 success resets account-wide history without clearing a timed mark', () => {
    let failures: FailureHistory = new Map()
    for (let count = 0; count < 5; count++) failures = failure(failures, 1000)
    const mark = markFromSignal(signal(), ladder, { now: 1000, failures })!
    failures = reduceFailureHistory(failures, { type: 'success', account })
    expect(failures.size).toBe(0)
    expect(markIsActive(mark, 1001)).toBe(true)
    expect(
      markFromSignal(signal(), ladder, {
        now: 1000,
        failures: failure(failures, 1000),
      })?.until,
    ).toBe(61000)
  })

  test('AG-MARK-11 stores the raw server hint, not the effective retry sleep', () => {
    const rawSignal = signal({ kind: 'rate-limit', retryAfterMs: 30000 })
    const effectiveRetrySleep = 60000
    expect(markFromSignal(rawSignal, ladder, { now: 1000 })?.until).toBe(31000)
    expect(markFromSignal(rawSignal, ladder, { now: 1000 })?.until).not.toBe(
      1000 + effectiveRetrySleep,
    )
  })

  test('AG-MARK-12/13 exact-model and family scope survive mark production', () => {
    const familyOf = (model: string) =>
      model === 'claude-sonnet' ? 'claude' : 'gemini'
    const modelMark = markFromSignal(
      signal({
        kind: 'rate-limit',
        scope: { kind: 'model', model: 'gemini-pro' },
      }),
      ladder,
      { now: 1000 },
    )!
    expect(modelMark).toEqual({
      scope: { kind: 'model', model: 'gemini-pro' },
      until: 31000,
      mergeLaw: 'max-until',
    })
    expect(scopeCovers(modelMark.scope, 'gemini-flash', familyOf)).toBe(false)
    const familyMark = markFromSignal(
      signal({
        scope: { kind: 'family', family: 'claude' },
        retryAfterMs: 2000,
      }),
      ladder,
      { now: 1000 },
    )!
    expect(familyMark).toEqual({
      scope: { kind: 'family', family: 'claude' },
      until: 3000,
      mergeLaw: 'max-until',
    })
    expect(scopeCovers(familyMark.scope, 'claude-sonnet', familyOf)).toBe(true)
    expect(scopeCovers(familyMark.scope, 'gemini-pro', familyOf)).toBe(false)
  })

  test('failure history is process-owned, account-wide and identity-keyed, with pure updates', () => {
    const original: FailureHistory = new Map()
    const other = { ...account, accountId: 'B' }
    const replaced = { ...account, incarnation: '2' }
    let failures = failure(original, 1000)
    failures = failure(failures, 1000, other)
    failures = failure(failures, 1000)
    expect(original.size).toBe(0)
    expect(
      markFromSignal(
        signal({ scope: { kind: 'model', model: 'another' } }),
        ladder,
        { now: 1000, failures },
      )?.until,
    ).toBe(301000)
    expect(
      markFromSignal(signal({ account: replaced }), ladder, {
        now: 1000,
        failures,
      })?.until,
    ).toBe(61000)
    const afterSuccess = reduceFailureHistory(failures, {
      type: 'success',
      account,
    })
    expect(failures.size).toBe(2)
    expect(afterSuccess.size).toBe(1)
    expect(
      markFromSignal(signal({ account: other }), ladder, {
        now: 1000,
        failures: failure(afterSuccess, 1000, other),
      })?.until,
    ).toBe(301000)
    expect(
      markFromSignal(signal(), ladder, { now: 1000, failures: new Map() })
        ?.until,
    ).toBe(61000)
  })
})

describe('hint, reset and disabled production axes', () => {
  test('CL-1/2/4/8/9 hint, zero and no-hint default preserve pool overwrite marks', () => {
    for (const [retryAfterMs, until] of [
      [17000, 18000],
      [0, 1000],
      [undefined, 61000],
    ] as const) {
      expect(
        markFromSignal(signal({ retryAfterMs }), hints, { now: 1000 }),
      ).toEqual({ scope: { kind: 'pool' }, until, mergeLaw: 'overwrite' })
    }
  })

  test('CL-3 absolute-date and event-relative markers keep their distinct clock samples', () => {
    const refused = signal({ retryAfterMs: 10000 })
    expect(
      markFromSignal(refused, { ...hints, hintClock: 'signal' }, { now: 1500 })
        ?.until,
    ).toBe(11000)
    expect(markFromSignal(refused, hints, { now: 1500 })?.until).toBe(11500)
  })

  test('CL-10/11 a shorter or zero mark requests overwrite rather than max-until', () => {
    expect(
      markFromSignal(signal({ retryAfterMs: 1000 }), hints, { now: 1000 }),
    ).toEqual({ scope: { kind: 'pool' }, until: 2000, mergeLaw: 'overwrite' })
    expect(
      markFromSignal(signal({ retryAfterMs: 0 }), hints, { now: 1000 }),
    ).toEqual({ scope: { kind: 'pool' }, until: 1000, mergeLaw: 'overwrite' })
  })

  test('CL-12 equality and later are expired, only earlier is active', () => {
    const mark = markFromSignal(signal({ retryAfterMs: 1000 }), hints, {
      now: 1000,
    })!
    expect(markIsActive(mark, 1999)).toBe(true)
    expect(markIsActive(mark, 2000)).toBe(false)
    expect(markIsActive(mark, 2001)).toBe(false)
  })

  test('OA-10/11/12 reset resolver feeds whole-account max-until production', () => {
    for (const [explicitResetAt, window, cached, until] of [
      [901000, 'primary', { primary: 301000 }, 901000],
      [undefined, 'secondary', { primary: 401000, secondary: 301000 }, 301000],
      [1000, 'primary', { secondary: 301000 }, 61000],
    ] as const) {
      const reset = resolveNamedWindowReset({
        now: 1000,
        explicitResetAt,
        window,
        lendable: ['primary', 'secondary'],
        cached,
        defaultMs: 60000,
      })!
      const refused = signal({
        windows: [
          {
            window,
            confirmed: false,
            confirmedByReading: false,
            observedAt: 1000,
            provenance: 'resolver',
            resetAt: reset.resetAt,
            resetSource: reset.source,
          },
        ],
      })
      expect(
        markFromSignal(
          refused,
          { kind: 'reset', defaultMs: 60000, mergeLaw: 'max-until' },
          { now: 1000 },
        ),
      ).toEqual({ scope: { kind: 'pool' }, until, mergeLaw: 'max-until' })
    }
  })

  test('no signal or disabled production yields no mark; reduction mutates no inputs', () => {
    expect(markFromSignal(undefined, ladder, { now: 1000 })).toBeUndefined()
    expect(
      markFromSignal(signal(), { kind: 'off' }, { now: 1000 }),
    ).toBeUndefined()
    const refused = Object.freeze(signal({ retryAfterMs: 0 }))
    const axes = Object.freeze({
      ...hints,
      mergeLaw: 'latest-evidence' as const,
    })
    expect(markFromSignal(refused, axes, { now: 1000 })).toEqual({
      scope: { kind: 'pool' },
      until: 1000,
      mergeLaw: 'latest-evidence',
    })
    expect(refused.retryAfterMs).toBe(0)
    expect(
      markFromSignal(
        signal({ retryAfterMs: 0 }),
        { ...hints, zero: 'skip' },
        { now: 1000 },
      )?.until,
    ).toBe(61000)
  })
})
