import { describe, expect, test } from 'bun:test'
import {
  type AccountKey,
  type BuiltRefusal,
  buildRefusal,
  confirmedAffinity,
  createRequestHistory,
  decideAfterLimit,
  formatReset,
  type LimitAxes,
  type LimitDecision,
  type PolicyFacts,
  registerLimitMessages,
  scanTerminalReset,
  statusVaultOrder,
  type TerminalCandidate,
  type TerminalScanFacts,
  type TerminalWindow,
} from '../../src/limits/index.js'

const now = 1_800_000_000_000
const A: AccountKey = { namespace: 'pool', accountId: 'A', incarnation: 'one' }
const B: AccountKey = { ...A, accountId: 'B' }
const hour = 3600000
const day = 24 * hour
const familyOf = (model: string) =>
  model.startsWith('claude') ? 'claude' : 'gemini'

function window(
  delayMs = 600000,
  patch: Partial<TerminalWindow> = {},
): TerminalWindow {
  return {
    window: 'primary',
    scope: { kind: 'pool' },
    blockedBy: 'exhausted',
    reset: { at: now + delayMs, observedAt: now },
    ...patch,
  }
}

function candidate(
  windows = [window()],
  patch: Partial<TerminalCandidate> = {},
): TerminalCandidate {
  return { account: A, readingAccount: A, windows, ...patch }
}

function scan(patch: Partial<TerminalScanFacts> = {}): TerminalScanFacts {
  return {
    candidates: [candidate()],
    effectiveModel: 'claude-opus',
    familyOf,
    maxAgeMs: 60000,
    accountKey: A,
    ...patch,
  }
}

function facts(input = scan(), patch: Partial<PolicyFacts> = {}): PolicyFacts {
  return {
    phase: 'pre-send',
    host: 'opencode1',
    now,
    clockNow: now,
    sessionId: 'terminal-session',
    requestScope: { kind: 'model', model: 'claude-opus' },
    history: createRequestHistory({
      requestId: 'request',
      originalUrl: 'https://provider.invalid',
      clockNow: now,
    }),
    attempted: A,
    delivery: { owned: true, attributable: true, replayable: true },
    candidates: [],
    terminal: { source: 'pool', reason: 'quota', scan: input },
    ...patch,
  }
}

function decide(
  input = scan(),
  patch: Partial<PolicyFacts> = {},
  axes = confirmedAffinity,
): LimitDecision {
  return decideAfterLimit(facts(input, patch), axes)
}

function wire(decision: LimitDecision) {
  if (
    decision.action !== 'refuse' ||
    (decision.family !== 'claude-429' &&
      decision.family !== 'json-412' &&
      decision.family !== 'pi-final')
  )
    throw new Error('Expected a shared refusal')
  return nonThrown(
    buildRefusal({
      family: decision.family,
      messageKey: decision.messageKey,
      now,
      resetAt: decision.resetAt,
      retryAfterMs: decision.retryAfterMs,
    }),
  )
}

function nonThrown(result: BuiltRefusal) {
  if (result.kind === 'throw') throw new Error('Unexpected thrown refusal')
  return result
}

describe('fresh current-identity scope-covered terminal scan', () => {
  test('latest blocking reset per account, then earliest across accounts', () => {
    const windows = [window(2 * hour), window(4 * day, { window: 'weekly' })]
    const input = scan({ candidates: [candidate(windows)] })
    expect(scanTerminalReset(input, now)).toMatchObject({
      account: A,
      resetAt: now + 4 * day,
    })
    expect(decide(input)).toMatchObject({
      action: 'refuse',
      reason: 'quota',
      resetAt: now + 4 * day,
      retryAfterMs: 900000,
    })
    expect(
      scanTerminalReset(
        scan({
          candidates: [
            candidate(windows),
            candidate([window(3 * hour)], { account: B, readingAccount: B }),
          ],
        }),
        now,
      ),
    ).toMatchObject({ account: B, resetAt: now + 3 * hour })
  })

  test('scoped blockers never hide a later general exhausted reset', () => {
    const input = scan({
      candidates: [
        candidate([
          window(2 * hour, { scope: { kind: 'model', model: 'claude-opus' } }),
          window(4 * day, { window: 'general-weekly' }),
        ]),
      ],
    })
    expect(scanTerminalReset(input, now)?.resetAt).toBe(now + 4 * day)
  })

  test('unknown, stale or past blocking resets disqualify only their account', () => {
    for (const reset of [
      undefined,
      { at: now - 1, observedAt: now },
      { at: now, observedAt: now },
      { at: Number.NaN, observedAt: now },
      { at: now + day },
      { at: now + day, observedAt: now - 60001 },
    ]) {
      const blocked = candidate([
        window(2 * hour),
        window(day, { window: 'weekly', reset }),
      ])
      expect(
        scanTerminalReset(scan({ candidates: [blocked] }), now),
      ).toBeUndefined()
      expect(
        scanTerminalReset(
          scan({
            candidates: [
              blocked,
              candidate([window(3 * hour)], { account: B, readingAccount: B }),
            ],
          }),
          now,
        )?.account,
      ).toEqual(B)
    }
  })

  test('each reset uses its own provenance and caller maxAgeMs inclusively', () => {
    const input = scan({
      candidates: [
        candidate([
          window(600000, {
            reset: { at: now + 600000, checkedAt: now - 60000 },
          }),
        ]),
      ],
    })
    expect(scanTerminalReset(input, now)?.resetAt).toBe(now + 600000)
    expect(
      scanTerminalReset({ ...input, maxAgeMs: 59999 }, now),
    ).toBeUndefined()
    expect(
      scanTerminalReset({ ...input, maxAgeMs: Number.NaN }, now),
    ).toBeUndefined()
    expect(
      scanTerminalReset(
        scan({
          candidates: [
            candidate([
              window(600000, {
                reset: {
                  at: now + 600000,
                  observedAt: now - 60001,
                  checkedAt: now,
                },
              }),
            ]),
          ],
        }),
        now,
      ),
    ).toBeUndefined()
  })

  test('known identity mismatches and replaced incarnations are rejected; unknown identity matches', () => {
    for (const patch of [
      { identity: 'new', readingIdentity: 'old' },
      { readingAccount: { ...A, incarnation: 'old' } },
      { readingAccount: B },
    ])
      expect(
        scanTerminalReset(
          scan({ candidates: [candidate([window()], patch)] }),
          now,
        ),
      ).toBeUndefined()
    for (const patch of [
      { identity: 'known' },
      { readingIdentity: 'known' },
      { identity: 'same', readingIdentity: 'same' },
    ])
      expect(
        scanTerminalReset(
          scan({ candidates: [candidate([window()], patch)] }),
          now,
        )?.resetAt,
      ).toBe(now + 600000)
  })

  test('model and family scopes cover only the effective request; nonblockers do not extend the reset', () => {
    const windows = [
      window(),
      window(day, { scope: { kind: 'model', model: 'gemini-pro' } }),
      window(day, { scope: { kind: 'family', family: 'gemini' } }),
      window(day, { blockedBy: undefined }),
    ]
    expect(
      scanTerminalReset(scan({ candidates: [candidate(windows)] }), now)
        ?.resetAt,
    ).toBe(now + 600000)
    expect(
      scanTerminalReset(
        scan({
          candidates: [
            candidate([
              window(day, { scope: { kind: 'family', family: 'claude' } }),
            ]),
          ],
        }),
        now,
      )?.resetAt,
    ).toBe(now + day)
  })

  test('floor and killswitch-floor defining resets produce no lifted exhaustion windows', () => {
    for (const blockedBy of ['floor', 'killswitch-floor'] as const) {
      const input = scan({
        candidates: [
          candidate([window(), window(day, { window: 'weekly', blockedBy })]),
        ],
      })
      expect(scanTerminalReset(input, now)).toMatchObject({
        resetAt: now + day,
        checkpoint: { blockers: [] },
      })
    }
  })
})

describe('AN54 and AN56 terminal host matrix', () => {
  for (const host of ['opencode1', 'opencode2', 'pi'] as const)
    for (const setting of [0, 15, 'max'] as const)
      for (const [row, resetDelay] of [
        ['AN54', 600000],
        ['AN56', 4 * day],
      ] as const)
        for (const evidence of [
          'fresh',
          'stale',
          'no-record',
          'no-candidate',
        ] as const)
          test(`${row} ${host} ${setting} ${evidence}`, () => {
            const input = scan({
              maxSameAccountWait: setting,
              activity:
                evidence === 'no-record'
                  ? undefined
                  : { accountKey: A, lastAcceptedAt: now, ttlMs: hour },
              candidates:
                evidence === 'no-candidate'
                  ? []
                  : [
                      candidate([
                        window(resetDelay, {
                          reset: {
                            at: now + resetDelay,
                            observedAt:
                              evidence === 'stale' ? now - 60001 : now,
                          },
                        }),
                      ]),
                    ],
            })
            const result = decide(input, {
              host,
              hostPhase: 'retry',
              remainingRetries: 1,
            })
            const kept = evidence === 'fresh' || evidence === 'no-record'
            const expectedDelay =
              setting === 0
                ? kept
                  ? resetDelay
                  : undefined
                : kept
                  ? Math.min(
                      resetDelay,
                      setting === 15
                        ? 900000
                        : evidence === 'no-record'
                          ? 300000
                          : hour,
                    )
                  : 300000
            expect(result).toMatchObject({
              reason:
                result.action === 'hold' ||
                result.action === 'wait-then-reselect'
                  ? 'terminal-quota'
                  : 'quota',
            })
            if (kept) expect(result).toHaveProperty('resetAt', now + resetDelay)
            else expect(result).not.toHaveProperty('resetAt')
            if (setting !== 0 && kept && host !== 'opencode1') {
              expect(result).toMatchObject({
                action: host === 'opencode2' ? 'hold' : 'wait-then-reselect',
                delayMs: expectedDelay,
                retryAfterMs: expectedDelay,
                target: now + expectedDelay!,
                waitKind: 'terminal',
                checkpoint: {
                  accountKey: A,
                  blockers: [{ window: 'primary', resetAt: now + resetDelay }],
                },
              })
              expect(result).toMatchObject({
                retryable: true,
                hostRetry: 'leave',
              })
            } else {
              expect(result).toMatchObject({
                action: 'refuse',
                family:
                  host === 'pi'
                    ? 'pi-final'
                    : setting === 0
                      ? 'json-412'
                      : 'claude-429',
                retryable: host !== 'pi' && setting !== 0,
                hostRetry: host === 'pi' || setting === 0 ? 'veto' : 'leave',
              })
              if (expectedDelay === undefined)
                expect(result).not.toHaveProperty('retryAfterMs')
              else expect(result).toHaveProperty('retryAfterMs', expectedDelay)
              for (const key of ['target', 'checkpoint', 'account', 'delayMs'])
                expect(result).not.toHaveProperty(key)
              const rendered = wire(result)
              if (rendered.kind === 'http')
                expect(rendered.headers.get('retry-after')).toBe(
                  expectedDelay === undefined
                    ? null
                    : String(Math.ceil(expectedDelay / 1000)),
                )
            }
          })
})

describe('terminal bounds, delivery and baseline isolation', () => {
  test('setting zero advertises 5700 seconds uncapped, and never invents a stale estimate', () => {
    const input = scan({
      maxSameAccountWait: 0,
      candidates: [candidate([window(5700000)])],
    })
    for (const host of ['opencode1', 'opencode2'] as const) {
      const result = decide(input, {
        host,
        hostPhase: 'retry',
        remainingRetries: 0,
      })
      expect(result).toMatchObject({
        action: 'refuse',
        family: 'json-412',
        retryAfterMs: 5700000,
        retryable: false,
        hostRetry: 'veto',
      })
      const built = wire(result)
      if (built.kind !== 'http') throw new Error('Expected HTTP refusal')
      expect(built.status).toBe(412)
      expect(built.headers.get('retry-after')).toBe('5700')
      expect(built.body).not.toContain('Retry in')
      expect(built.body).toContain('Reset at')
      expect(
        decide(
          { ...input, candidates: [] },
          { host, hostPhase: 'retry', remainingRetries: 0 },
        ),
      ).not.toHaveProperty('retryAfterMs')
    }
  })

  test('max caps by TTL rather than remaining cache life, and uses 300 seconds for unusable records', () => {
    const base = scan({
      maxSameAccountWait: 'max',
      candidates: [candidate([window(day)])],
    })
    expect(
      decide({
        ...base,
        activity: {
          accountKey: A,
          lastAcceptedAt: now - 2 * hour,
          ttlMs: hour,
        },
      }),
    ).toMatchObject({ retryAfterMs: hour })
    for (const activity of [
      undefined,
      { accountKey: A, lastAcceptedAt: now, ttlMs: 0 },
      { accountKey: A, lastAcceptedAt: now, ttlMs: Number.NaN },
      { accountKey: B, lastAcceptedAt: now, ttlMs: hour },
      {
        accountKey: { ...A, incarnation: 'old' },
        lastAcceptedAt: now,
        ttlMs: hour,
      },
    ]) {
      expect(decide({ ...base, activity })).toMatchObject({
        retryAfterMs: 300000,
      })
    }
    const activity = { accountKey: A, lastAcceptedAt: now, ttlMs: 120000 }
    expect(decide({ ...base, activity, candidates: [] })).toMatchObject({
      retryAfterMs: 120000,
    })
    expect(
      decide({ ...base, activity: { ...activity, ttlMs: 0 }, candidates: [] }),
    ).toMatchObject({ retryAfterMs: 300000 })
  })

  test('OpenCode 2 max is one full terminal hold and budget exhaustion leaves the host alone', () => {
    const input = scan({
      maxSameAccountWait: 'max',
      candidates: [candidate([window(day)])],
      activity: { accountKey: A, lastAcceptedAt: now, ttlMs: hour },
    })
    expect(
      decide(input, {
        host: 'opencode2',
        hostPhase: 'retry',
        remainingRetries: 1,
      }),
    ).toMatchObject({
      action: 'hold',
      delayMs: hour,
      target: now + hour,
      waitKind: 'terminal',
    })
    expect(
      decide(input, {
        host: 'opencode2',
        hostPhase: 'retry',
        remainingRetries: 0,
      }),
    ).toMatchObject({ action: 'pass', hostRetry: 'leave' })
    expect(
      decide(
        {
          ...input,
          activity: { accountKey: A, lastAcceptedAt: now, ttlMs: 3622000 },
        },
        { host: 'opencode2', hostPhase: 'retry', remainingRetries: 1 },
      ),
    ).toMatchObject({ action: 'refuse' })
    expect(
      decide(input, { host: 'opencode2', hostPhase: 'request' }),
    ).toMatchObject({ action: 'refuse' })
  })

  test('terminal holds target the account defining the true reset, even without activity', () => {
    const input = scan({
      candidates: [
        candidate([window(day)]),
        candidate([window()], { account: B, readingAccount: B }),
      ],
    })
    expect(
      decide(input, {
        host: 'opencode2',
        hostPhase: 'retry',
        remainingRetries: 1,
      }),
    ).toMatchObject({
      action: 'hold',
      account: B,
      delayMs: 600000,
      checkpoint: { accountKey: B },
    })
  })

  test('Pi waits once, then a capped or floor-defined wake refuses without another wait', () => {
    for (const blockedBy of ['exhausted', 'floor'] as const) {
      const input = scan({
        maxAgeMs: day,
        candidates: [candidate([window(day, { blockedBy })])],
      })
      const waited = decide(input, { host: 'pi' })
      if (waited.action !== 'wait-then-reselect')
        throw new Error('Expected Pi wait')
      expect(waited.delayMs).toBe(900000)
      const final = decide(input, {
        host: 'pi',
        now: waited.target,
        clockNow: waited.target,
        wake: {
          checkpoint: waited.checkpoint,
          target: waited.target,
          kind: waited.waitKind,
        },
      })
      expect(final).toMatchObject({
        action: 'refuse',
        family: 'pi-final',
        retryable: false,
        hostRetry: 'veto',
        resetAt: now + day,
      })
      expect(final).not.toHaveProperty('target')
      expect(wire(final).body).not.toContain('Retry in')
    }
  })

  test('AN54 terminal wake retains with no activity, rather than waiting again', () => {
    const input = scan({ maxAgeMs: hour })
    for (const host of ['opencode2', 'pi'] as const) {
      const waited = decide(input, {
        host,
        hostPhase: 'retry',
        remainingRetries: 1,
      })
      if (waited.action !== 'hold' && waited.action !== 'wait-then-reselect')
        throw new Error('Expected terminal wait')
      expect(waited.delayMs).toBe(600000)
      const result = decide(input, {
        host,
        now: waited.target,
        clockNow: waited.target,
        wake: {
          checkpoint: waited.checkpoint,
          target: waited.target,
          kind: waited.waitKind,
        },
        candidates: [
          {
            account: A,
            admitted: true,
            placementEligible: false,
            ready: false,
            blockers: [],
            confirmedBlockers: [
              {
                window: 'primary',
                confirmed: true,
                confirmedByReading: true,
                observedAt: now,
                provenance: 'poll',
                resetAt: now + 600000,
              },
            ],
          },
        ],
      })
      expect(result).toMatchObject({
        action: 'retain',
        account: A,
        reason: 'wait-elapsed',
        liftedWindows: ['primary'],
      })
    }
  })

  test('AN60 vault retains 180000 and its recorded text under every setting', () => {
    const text =
      'No vault account currently satisfies quota policy: Opus scoped limit. Open /claude → Killswitch / Quota to change these limits. Retry in 3m 0s.'
    const messages = registerLimitMessages({
      retryable: { 'vault.scoped': () => text },
    })
    for (const setting of [0, 15, 'max'] as const) {
      for (const host of ['opencode1', 'opencode2', 'pi'] as const) {
        const input = scan({
          maxSameAccountWait: setting,
          candidates: [candidate([window(120000)])],
        })
        const result = decide(input, {
          host,
          terminal: {
            source: 'vault',
            reason: 'quota',
            family: 'native-vault-refusal',
            messageKey: 'vault.scoped',
            retryAfterMs: 180000,
            scan: input,
          },
        })
        expect(result).toMatchObject({
          action: 'refuse',
          reason: 'quota',
          family: 'native-vault-refusal',
          messageKey: 'vault.scoped',
          retryAfterMs: 180000,
          retryable: true,
          hostRetry: 'leave',
        })
        expect(
          nonThrown(
            buildRefusal({
              family: 'claude-429',
              messageKey: 'vault.scoped',
              messages,
              now,
              retryAfterMs:
                result.action === 'refuse' ? result.retryAfterMs : undefined,
            }),
          ).body,
        ).toBe(
          JSON.stringify({
            type: 'error',
            error: { type: 'rate_limit_error', message: text },
          }),
        )
        expect(decide(input, { host: 'opencode1' })).toMatchObject({
          retryAfterMs: 120000,
        })
      }
    }
  })

  test('baseline metadata axes never acquire the setting-capped scan', () => {
    const input = scan({ maxSameAccountWait: 0 })
    const axes: LimitAxes = {
      ...confirmedAffinity,
      terminalMetadata: 'baseline',
    }
    expect(
      decide(
        input,
        {
          terminal: {
            source: 'pool',
            reason: 'quota',
            retryAfterMs: 660000,
            scan: input,
          },
        },
        axes,
      ),
    ).toMatchObject({
      action: 'refuse',
      retryAfterMs: 660000,
      retryable: true,
      family: 'claude-429',
    })
  })

  test('status-history terminal floor and default come from axes, not reducer constants', () => {
    const axes: LimitAxes = {
      ...statusVaultOrder,
      terminalStatusHistory: { minRetryMs: 7000, defaultRetryMs: 42000 },
    }
    const input = facts(scan(), {
      terminal: undefined,
      candidates: [
        {
          account: A,
          admitted: true,
          placementEligible: true,
          ready: false,
          blockers: [{ kind: 'hard', until: now + 100 }],
        },
      ],
    })
    expect(decideAfterLimit(input, axes)).toMatchObject({
      action: 'refuse',
      retryAfterMs: 7000,
    })
    expect(
      decideAfterLimit(
        { ...input, candidates: [{ ...input.candidates[0]!, blockers: [] }] },
        axes,
      ),
    ).toMatchObject({ action: 'refuse', retryAfterMs: 42000 })
  })
})

describe('shared terminal rendering', () => {
  test('AN56 retry clause uses the cap, reset clause the true multi-day reset; zero has reset only', () => {
    const input = scan({ candidates: [candidate([window(4 * day)])] })
    const rendered = wire(decide(input))
    expect(rendered.body).toContain('Retry in 15m.')
    expect(rendered.body).toContain('Reset at 4d 0h 0m.')
    const noRetry = wire(decide({ ...input, maxSameAccountWait: 0 }))
    expect(noRetry.body).not.toContain('Retry in')
    expect(noRetry.body).toContain('Reset at 4d 0h 0m.')
  })

  test('true reset uses the registered formatReset formatter', () => {
    const result = decide(scan({ candidates: [candidate([window(4 * day)])] }))
    if (result.action !== 'refuse') throw new Error('Expected refusal')
    const messages = registerLimitMessages({
      formatReset: ({ resetAt, now: at }) =>
        `in ${formatReset({ resetAt, now: at })}`,
    })
    const rendered = nonThrown(
      buildRefusal({
        family: 'claude-429',
        messageKey: result.messageKey,
        messages,
        now,
        retryAfterMs: result.retryAfterMs,
        resetAt: result.resetAt,
      }),
    )
    expect(rendered.body).toContain('Reset at in 4d 0h 0m.')
    expect(rendered.body).toContain('Retry in 15m.')
  })

  test('fuzz multi-day resets and boundary widths never renders host status digit runs', () => {
    const delays = [
      429000,
      500000,
      502000,
      503000,
      504000,
      524000,
      429 * 60000,
      500 * 60000,
      524 * 60000,
    ]
    let seed = 17
    for (let index = 0; index < 1500; index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      delays.push(1 + (seed % (30 * day)))
    }
    for (const delay of delays)
      for (const setting of [0, 15, 'max'] as const) {
        const input = scan({
          maxSameAccountWait: setting,
          candidates: [candidate([window(delay)])],
        })
        expect(wire(decide(input)).body).not.toMatch(/429|500|502|503|504|524/)
        expect(
          wire(
            decide(input, {
              host: 'pi',
              wake: {
                checkpoint: { accountKey: A, decidedAt: now - 1, blockers: [] },
                target: now,
                kind: 'terminal',
              },
            }),
          ).body,
        ).not.toMatch(/429|500|502|503|504|524/)
      }
  })
})
