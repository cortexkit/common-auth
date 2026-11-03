import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type {
  LimitAxes,
  LimitMark,
  PolicyFacts,
} from '../../src/limits/index.js'
import {
  confirmedAffinity,
  createRequestHistory,
  decideAfterLimit,
  earliestPoolEngine,
  limitPresets,
  markFromSignal,
  marksAfterSuccess,
  statusVaultOrder,
  windowRouter,
} from '../../src/limits/index.js'

const now = 1700000000000
const A = { namespace: 'test', accountId: 'A', incarnation: '1' }
const B = { ...A, accountId: 'B' }
const scope = { kind: 'model', model: 'claude-sonnet' } as const

function facts(): PolicyFacts {
  return {
    phase: 'after-limit',
    host: 'opencode1',
    now,
    clockNow: 0,
    sessionId: 'session-a',
    requestScope: scope,
    history: createRequestHistory({
      requestId: 'turn-1',
      originalUrl: '/',
      clockNow: 0,
    }),
    attempted: A,
    signal: {
      account: A,
      kind: 'quota-exhausted',
      reason: 'quota',
      scope,
      status: 429,
      observedAt: now,
      windows: [
        {
          window: '5h',
          confirmed: true,
          confirmedByReading: true,
          resetAt: now + 1000,
          observedAt: now,
          provenance: 'test',
        },
      ],
    },
    delivery: { owned: true, attributable: true, replayable: true },
    candidates: [
      {
        account: A,
        admitted: true,
        placementEligible: true,
        ready: false,
        blockers: [{ kind: 'hard', until: now + 1000 }],
      },
      {
        account: B,
        admitted: true,
        placementEligible: true,
        ready: true,
        blockers: [],
      },
    ],
    selection: { account: B, pin: 'pin' },
  }
}

describe('immutable orthogonal presets', () => {
  test('exactly four named bundles select the adopted bounds', () => {
    expect(Object.keys(limitPresets)).toEqual([
      'confirmed-affinity',
      'earliest-pool-engine',
      'window-router',
      'status-vault-order',
    ])
    expect(limitPresets['confirmed-affinity']).toBe(confirmedAffinity)
    for (const [name, axes] of Object.entries(limitPresets)) {
      expect(axes.retainBound).toBe('none')
      expect(axes.unconfirmedRetainLimit).toBe(
        name === 'confirmed-affinity' ? 2 : undefined,
      )
      expect(axes.shortLimit.holdBound).toBe(
        name === 'confirmed-affinity' ? 'cache-ttl' : 'disabled',
      )
      expect(axes.terminalMetadata).toBe(
        name === 'confirmed-affinity' ? 'setting-capped-fresh' : 'baseline',
      )
    }
    const unbounded: LimitAxes['retainBound'] = 'none'
    expect(unbounded).toBe('none')
    // @ts-expect-error The legacy retainBound field does not select counted retries.
    const bounded: LimitAxes['retainBound'] = 'count'
    expect(String(bounded)).toBe('count')
  })

  test('uncounted decisions and other presets ignore the new count fact byte-for-byte', () => {
    for (const host of ['opencode1', 'opencode2', 'pi'] as const) {
      const input = { ...facts(), host, affinity: 'sticky' as const }
      input.signal = { ...input.signal!, windows: [] }
      for (const axes of [earliestPoolEngine, windowRouter, statusVaultOrder]) {
        expect(axes).not.toHaveProperty('unconfirmedRetainLimit')
        expect(
          JSON.stringify(
            decideAfterLimit({ ...input, unconfirmedRetainCount: 2 }, axes),
          ),
        ).toBe(JSON.stringify(decideAfterLimit(input, axes)))
      }
      const { unconfirmedRetainLimit: _, ...legacy } = confirmedAffinity
      expect(JSON.stringify(decideAfterLimit(input, confirmedAffinity))).toBe(
        JSON.stringify(decideAfterLimit(input, legacy)),
      )
    }
  })

  test('counted retry limits follow the axis rather than a preset name', () => {
    const input = facts()
    for (const limit of [0, 1, 3]) {
      for (let count = 0; count <= limit; count++) {
        const decision = decideAfterLimit(
          {
            ...input,
            signal: { ...input.signal!, windows: [] },
            unconfirmedRetainCount: count,
          },
          { ...confirmedAffinity, unconfirmedRetainLimit: limit },
        )
        expect(decision.action).toBe(count < limit ? 'retain' : 'reroute')
        expect(decision.reason).toBe(
          count < limit ? 'unconfirmed-limit' : 'unconfirmed-retry-limit',
        )
      }
    }
  })

  test('all nested policy tables and arrays are frozen, not only the bundle shell', () => {
    function check(value: unknown): void {
      if (!value || typeof value !== 'object') return
      expect(Object.isFrozen(value)).toBe(true)
      for (const child of Object.values(value)) check(child)
    }
    check(limitPresets)
    expect(() => {
      ;(earliestPoolEngine.poolWaiting as { budgetMs: number }).budgetMs = 0
    }).toThrow()
    expect(() => {
      ;(windowRouter.advance.opencode1.statuses as number[]).push(500)
    }).toThrow()
  })

  test('decision core imports no presets and names no plugin or preset', () => {
    const source = readFileSync(
      new URL('../../src/limits/decide.ts', import.meta.url),
      'utf8',
    )
    expect(source).not.toMatch(/from ['"].*presets/)
    expect(source).not.toMatch(
      /confirmed-affinity|earliest-pool-engine|window-router|status-vault-order|anthropic-auth|antigravity-auth|openai-auth|claustrum-auth/,
    )
  })

  test('earliest-pool-engine success leaves a timed mark in place', () => {
    const input = facts()
    const mark = markFromSignal(
      input.signal,
      earliestPoolEngine.markers.opencode1,
      { now, random: 0.5 },
    )
    expect(mark).toEqual({ scope, until: now + 60000, mergeLaw: 'max-until' })
    if (!mark) throw new Error('Expected a timed mark')
    const marks = [mark]
    expect(
      marksAfterSuccess(marks, earliestPoolEngine, scope.model, () => 'claude'),
    ).toEqual([mark])
    expect(
      marksAfterSuccess(marks, earliestPoolEngine, scope.model, () => 'claude'),
    ).toBe(marks)
  })

  test('success clear on removes covered scopes only, not another model mark', () => {
    const marks: readonly LimitMark[] = [
      { scope: { kind: 'pool' }, until: now + 1000, mergeLaw: 'max-until' },
      {
        scope: { kind: 'family', family: 'claude' },
        until: now + 1000,
        mergeLaw: 'max-until',
      },
      { scope, until: now + 1000, mergeLaw: 'max-until' },
      {
        scope: { kind: 'model', model: 'gemini' },
        until: now + 1000,
        mergeLaw: 'max-until',
      },
    ]
    expect(
      marksAfterSuccess(marks, confirmedAffinity, scope.model, () => 'claude'),
    ).toEqual(marks.slice(3))
    expect(marks).toHaveLength(4)
  })

  test('marker tables preserve host differences and overwrite-zero semantics', () => {
    expect(windowRouter.markers.pi).toEqual({ kind: 'off' })
    expect(windowRouter.markers.opencode2).toMatchObject({
      kind: 'reset',
      mergeLaw: 'max-until',
    })
    expect(statusVaultOrder.markers.opencode1).toMatchObject({
      kind: 'hint',
      zero: 'accept',
      hintClock: 'signal',
      mergeLaw: 'overwrite',
    })
    expect(statusVaultOrder.markers.opencode2).toMatchObject({
      kind: 'hint',
      zero: 'accept',
      hintClock: 'marker',
      mergeLaw: 'overwrite',
    })
    expect(earliestPoolEngine.markers.opencode1).toMatchObject({
      kind: 'failure-ladder',
      quotaSteps: [60000, 300000, 1800000, 7200000],
    })
  })
})

describe('preset isolation from same-account setting bounds', () => {
  for (const [name, axes] of [
    ['earliest-pool-engine', earliestPoolEngine],
    ['window-router', windowRouter],
    ['status-vault-order', statusVaultOrder],
  ] as const) {
    test(`${name} reroutes unchanged under 0, 15 and max`, () => {
      const decisions = [0, 900000, Number.POSITIVE_INFINITY].map((maxWaitMs) =>
        decideAfterLimit(
          { ...facts(), hold: { cacheExpiresAt: now + 3600000, maxWaitMs } },
          axes,
        ),
      )
      for (const result of decisions)
        expect(result).toMatchObject({
          action: 'reroute',
          account: B,
          pin: 'pin',
        })
      expect(decisions[1]).toEqual(decisions[0])
      expect(decisions[2]).toEqual(decisions[0])
    })
  }

  test('OA-57 ordered Pi 429 reroutes B; OA-58 confirmed sticky Pi 429 moves pin', () => {
    const input = facts()
    expect(
      decideAfterLimit(
        { ...input, host: 'pi', signal: undefined, status: 429 },
        windowRouter,
      ),
    ).toMatchObject({
      action: 'reroute',
      account: B,
      pin: 'pin',
      retryable: true,
      hostRetry: 'leave',
    })
    expect(
      decideAfterLimit(
        { ...input, host: 'pi', affinity: 'sticky' },
        windowRouter,
      ),
    ).toMatchObject({
      action: 'reroute',
      account: B,
      pin: 'pin',
      retryable: true,
      hostRetry: 'leave',
    })
  })

  test('OA-59 unconfirmed sticky Pi 429 retains A with no timer even with B ready', () => {
    const input = facts()
    const result = decideAfterLimit(
      {
        ...input,
        host: 'pi',
        affinity: 'sticky',
        signal: input.signal && {
          ...input.signal,
          windows: [],
          retryAfterMs: 12000,
        },
      },
      windowRouter,
    )
    expect(result).toMatchObject({
      action: 'retain',
      account: A,
      retryable: true,
      hostRetry: 'leave',
    })
    expect(result).not.toHaveProperty('retryMs')
    expect(result).not.toHaveProperty('delayMs')
  })

  test('OC2 last-account policy is a host delay, not a timer or synthetic core response', () => {
    const input = facts()
    const noAlternative = {
      ...input,
      host: 'opencode2' as const,
      hostPhase: 'retry' as const,
      candidates: [input.candidates[0]!],
      selection: undefined,
    }
    expect(decideAfterLimit(noAlternative, windowRouter)).toMatchObject({
      action: 'retain',
      account: A,
      reason: 'host-delay',
      hostRetry: 'leave',
    })
    expect(decideAfterLimit(noAlternative, windowRouter)).not.toHaveProperty(
      'retryMs',
    )
    expect(decideAfterLimit(noAlternative, statusVaultOrder)).toMatchObject({
      action: 'pass',
      reason: 'host-delay',
      hostRetry: 'leave',
    })
  })
})
