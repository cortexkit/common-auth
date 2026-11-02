import { describe, expect, test } from 'bun:test'
import type {
  AccountKey,
  LimitCandidate,
  LimitWindow,
  PolicyFacts,
} from '../../src/limits/index.js'
import {
  commitRequestExclusion,
  confirmedAffinity,
  createRequestHistory,
  decideAfterLimit,
  earliestPoolEngine,
} from '../../src/limits/index.js'
import { liftedWindowsForWake, waitCheckpoint } from '../../src/limits/wake.js'
import { admit } from '../../src/routing/index.js'
import { quotaMap, reading } from '../quota/helpers.js'
import { oauth } from '../routing/helpers.js'

const now = 1700000000000
const A: AccountKey = { namespace: 'pool', accountId: 'A', incarnation: '1' }
const B: AccountKey = { ...A, accountId: 'B' }
const scope = { kind: 'model', model: 'claude-sonnet' } as const
const reset = now + 600000

function window(
  resetAt: number | undefined = reset,
  name = 'primary',
): LimitWindow {
  return {
    window: name,
    confirmed: true,
    confirmedByReading: true,
    resetAt,
    observedAt: now,
    provenance: 'stored-reading',
  }
}

function candidate(patch: Partial<LimitCandidate> = {}): LimitCandidate {
  return {
    account: A,
    admitted: true,
    placementEligible: false,
    ready: false,
    blockers: [],
    confirmedBlockers: [window()],
    ...patch,
  }
}

function facts(patch: Partial<PolicyFacts> = {}): PolicyFacts {
  return {
    phase: 'pre-send',
    host: 'opencode2',
    hostPhase: 'request',
    now: reset + 16000,
    clockNow: 617000,
    sessionId: 'session-a',
    requestScope: scope,
    history: createRequestHistory({
      requestId: 'turn',
      originalUrl: '/messages',
      clockNow: 1000,
    }),
    attempted: A,
    delivery: { owned: true, attributable: true, replayable: true },
    candidates: [candidate()],
    hold: { cacheExpiresAt: now + 3600000, maxWaitMs: 900000 },
    wake: {
      checkpoint: waitCheckpoint(A, now, [window()]),
      target: reset + 16000,
    },
    terminal: { source: 'pool', reason: 'quota' },
    ...patch,
  }
}

const decide = (patch: Partial<PolicyFacts> = {}) =>
  decideAfterLimit(facts(patch), confirmedAffinity)

describe('wait checkpoints and completed-wait dispatch', () => {
  test('pool waits checkpoint the account defining the target, without pinning it', () => {
    const result = decideAfterLimit(
      facts({
        phase: 'after-limit',
        host: 'pi',
        now,
        clockNow: 1000,
        status: 429,
        wake: undefined,
        hold: undefined,
        candidates: [
          candidate({ blockers: [{ kind: 'hard', until: reset + 1000 }] }),
          candidate({
            account: B,
            blockers: [{ kind: 'hard', until: reset }],
            confirmedBlockers: [window()],
          }),
        ],
        poolWaitBudgetMs: 0,
      }),
      earliestPoolEngine,
    )
    expect(result).toMatchObject({
      action: 'wait-then-reselect',
      delayMs: 600000,
      target: reset,
      checkpoint: {
        accountKey: B,
        decidedAt: now,
        blockers: [{ window: 'primary', resetAt: reset }],
      },
    })
    expect(result).not.toHaveProperty('account')
  })

  test('OpenCode 2 hold wake with no new reading retains before mode placement', () => {
    const held = decide({
      phase: 'after-limit',
      hostPhase: 'retry',
      remainingRetries: 1,
      now,
      clockNow: 1000,
      status: 429,
      wake: undefined,
      selection: { account: B, pin: 'pin' },
      candidates: [
        candidate(),
        candidate({ account: B, ready: true, placementEligible: true }),
      ],
    })
    expect(held.action).toBe('hold')
    if (held.action !== 'hold') throw new Error('expected scheduled hold')
    expect(held.delayMs).toBe(616000)
    expect(held.checkpoint).toEqual({
      accountKey: A,
      decidedAt: now,
      blockers: [{ window: 'primary', resetAt: reset }],
    })
    expect(
      decide({ wake: { checkpoint: held.checkpoint, target: held.target } }),
    ).toMatchObject({
      action: 'retain',
      account: A,
      liftedWindows: ['primary'],
      reason: 'wait-elapsed',
    })
  })

  test('Pi AN54 elapsed dispatches A without a session pin and still requests its reading', () => {
    const wake = {
      checkpoint: waitCheckpoint(A, now, [window()]),
      target: reset,
      kind: 'terminal' as const,
    }
    const lifted = liftedWindowsForWake(wake, A, [window()], reset)
    const admission = admit({
      rows: [
        oauth(
          'A',
          quotaMap([
            reading('primary', 100, {
              resetsAt: new Date(reset).toISOString(),
            }),
          ]),
        ),
      ],
      now: reset,
      liftedWindows: new Map([
        ['A', lifted.map((label) => ({ scope: 'all', label }))],
      ]),
    })
    expect(admission.admitted.map((row) => row.id)).toEqual(['A'])
    expect(admission.pulls).toEqual(['A'])
    expect(
      decide({
        host: 'pi',
        hostPhase: undefined,
        hold: undefined,
        now: reset,
        attempted: undefined,
        selection: undefined,
        wake,
      }),
    ).toMatchObject({
      action: 'retain',
      account: A,
      liftedWindows: ['primary'],
      hostRetry: 'leave',
    })
  })

  test.each([reset, reset - 1000])(
    'a refreshed reading with reset %s still dispatches',
    (resetAt) => {
      expect(
        decide({
          candidates: [
            candidate({
              confirmedBlockers: [
                { ...window(resetAt), observedAt: reset + 16000 },
              ],
            }),
          ],
        }),
      ).toMatchObject({ action: 'retain', account: A })
    },
  )

  test.each([reset + 1000, reset + 20000])(
    'a later reset %s re-decides even before the jittered target',
    (resetAt) => {
      expect(
        decide({
          candidates: [candidate({ confirmedBlockers: [window(resetAt)] })],
        }),
      ).toMatchObject({ action: 'refuse', reason: 'quota' })
    },
  )

  test('a new blocker or an unknown reset is not lifted', () => {
    for (const blockers of [
      [window(), window(reset, 'weekly')],
      [window(Number.NaN)],
      [{ ...window(), resetAt: undefined }],
    ]) {
      expect(
        decide({ candidates: [candidate({ confirmedBlockers: blockers })] })
          .action,
      ).toBe('refuse')
    }
  })

  test('all checkpointed windows must pass, and a consumed wake grants no later dispatch', () => {
    const windows = [window(reset - 1000), window(reset, 'weekly')]
    const input = facts({
      candidates: [candidate({ confirmedBlockers: windows })],
      wake: { checkpoint: waitCheckpoint(A, now, windows), target: reset },
    })
    expect(decideAfterLimit(input, confirmedAffinity)).toMatchObject({
      action: 'retain',
      liftedWindows: ['primary', 'weekly'],
    })
    expect(
      decideAfterLimit({ ...input, wake: undefined }, confirmedAffinity).action,
    ).toBe('refuse')
  })
})

describe('wake fences and terminal wait boundaries', () => {
  const alternative = candidate({
    account: B,
    ready: true,
    placementEligible: true,
    confirmedBlockers: [],
  })

  test.each(['access', 'identity', 'custody', 'floor', 'control'])(
    '%s rejection re-decides instead of retaining',
    () => {
      const invalid = candidate({ admitted: false })
      expect(decide({ candidates: [invalid] })).toMatchObject({
        action: 'refuse',
      })
      expect(
        decide({
          candidates: [invalid, alternative],
          selection: { account: B, pin: 'pin' },
        }),
      ).toMatchObject({ action: 'reroute', account: B })
    },
  )

  test.each([
    { ...A, incarnation: 'replacement' },
    { ...A, namespace: 'other' },
    B,
  ])('a different full account key %s cannot inherit lifting', (account) => {
    expect(
      liftedWindowsForWake(facts().wake!, account, [window()], reset + 16000),
    ).toEqual([])
    expect(decide({ candidates: [candidate({ account })] }).action).toBe(
      'refuse',
    )
  })

  test('an excluded account and an active timed blocker cannot be lifted', () => {
    const history = commitRequestExclusion(facts().history, {
      account: A,
      scope,
      attemptId: 'attempt',
    }).history
    expect(decide({ history }).action).toBe('refuse')
    expect(
      decide({
        candidates: [
          candidate({ blockers: [{ kind: 'hard', until: reset + 20000 }] }),
        ],
      }).action,
    ).toBe('refuse')
    expect(
      decide({
        candidates: [candidate({ blockers: [{ kind: 'hard', until: reset }] })],
      }).action,
    ).toBe('retain')
  })

  test('a hold wake with no current cache record cannot dispatch the held account', () => {
    expect(decide({ hold: undefined })).toMatchObject({ action: 'refuse' })
    expect(
      decide({
        hold: undefined,
        candidates: [candidate(), alternative],
        selection: { account: B, pin: 'detour' },
      }),
    ).toMatchObject({ action: 'reroute', account: B })
  })

  test('changed cache bounds re-decide, rather than granting a fresh wait budget', () => {
    for (const hold of [
      { cacheExpiresAt: reset + 15999, maxWaitMs: 900000 },
      { cacheExpiresAt: now + 3600000, maxWaitMs: 600000 },
    ])
      expect(decide({ hold }).action).toBe('refuse')
    expect(decide({ now: now + 3600001 }).action).toBe('refuse')
  })

  test('a wake before its target or an invalid target lifts nothing', () => {
    for (const target of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      now - 1,
      reset + 16001,
    ]) {
      const wake = { checkpoint: waitCheckpoint(A, now, [window()]), target }
      expect(liftedWindowsForWake(wake, A, [window()], reset + 16000)).toEqual(
        [],
      )
      expect(decide({ wake }).action).toBe('refuse')
    }
  })

  test('a capped terminal wait cannot lift the reset still beyond its target', () => {
    const target = now + 900000
    const windows = [window(now + 4 * 86400000)]
    const wake = {
      checkpoint: waitCheckpoint(A, now, windows),
      target,
      kind: 'terminal' as const,
    }
    expect(liftedWindowsForWake(wake, A, windows, target)).toEqual([])
    expect(
      decide({
        host: 'pi',
        now: target,
        hold: undefined,
        wake,
        candidates: [candidate({ confirmedBlockers: windows })],
      }),
    ).toMatchObject({ action: 'refuse', reason: 'quota' })
  })

  test('a floor-defined wait lifts nothing and ends in final refusal after the full wait', () => {
    const target = reset
    const checkpoint = waitCheckpoint(A, now, [])
    expect(checkpoint.blockers).toEqual([])
    const wake = { checkpoint, target, kind: 'terminal' as const }
    const refused = decide({
      host: 'pi',
      now: target,
      hold: undefined,
      wake,
      candidates: [candidate({ admitted: false })],
      terminal: {
        source: 'pool',
        reason: 'quota',
        retryable: false,
        hostRetry: 'veto',
      },
    })
    expect(liftedWindowsForWake(wake, A, [window()], target)).toEqual([])
    expect(refused).toMatchObject({
      action: 'refuse',
      retryable: false,
      hostRetry: 'veto',
    })
    expect(refused).not.toHaveProperty('target')
    expect(refused).not.toHaveProperty('delayMs')
    expect(
      decide({
        host: 'pi',
        now: target,
        hold: undefined,
        wake,
        candidates: [candidate({ ready: true, confirmedBlockers: [] })],
      }),
    ).toMatchObject({ action: 'retain', account: A, liftedWindows: [] })
  })
})
