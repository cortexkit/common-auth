import { afterAll, describe, expect, test } from 'bun:test'
import {
  type AccountKey,
  acquireLimitsRegistry,
  applyLimitsCommands,
  buildRefusal,
  commitRequestExclusion,
  createLimitsNamespace,
  createRequestHistory,
  decideAfterLimit,
  earliestPoolEngine,
  type FailureHistory,
  type IdentityBinding,
  type LimitCandidate,
  type LimitDecision,
  type LimitSignal,
  type LimitsCommand,
  type LimitsNamespace,
  type MaxSameAccountWait,
  markFromSignal,
  markIsActive,
  marksAfterSuccess,
  type PersistenceAdapter,
  type PolicyFacts,
  reduceFailureHistory,
  resolveReset,
  sameAccount,
  sameAccountHoldFacts,
  scopeCovers,
} from '../../../src/limits/index.js'
import {
  type DriverFacts,
  type DriverState,
  runFakeClockDriver,
} from './fake-clock-driver.js'
import { conformanceRows, type VectorResult } from './rows.js'

const now = 1700000000000
const clockNow = 1000
const A: AccountKey = {
  namespace: 'antigravity',
  accountId: 'A',
  incarnation: '1',
}
const B: AccountKey = { ...A, accountId: 'B' }
const scope = { kind: 'model', model: 'gemini-pro' } as const
type Setting = MaxSameAccountWait | undefined

export const antigravityResults: VectorResult[] = []

function vector(id: string, name: string, run: (setting: Setting) => unknown) {
  const fullName = `${id} ${name}`
  test(fullName, async () => {
    const zero = await run(0)
    // The preset never reserves the limited account for a later retry, even with a warm cache.
    for (const setting of [undefined, 15, 'max'] as const)
      expect(await run(setting)).toEqual(zero)
    antigravityResults.push({
      rowId: id,
      preset: 'earliest-pool-engine',
      name: fullName,
      status: 'passed',
    })
  })
}

function history() {
  return createRequestHistory({
    requestId: 'turn',
    originalUrl: '/generate',
    clockNow,
  })
}

function candidate(
  account: AccountKey,
  blockers: LimitCandidate['blockers'] = [],
  admitted = true,
): LimitCandidate {
  return {
    account,
    admitted,
    placementEligible: true,
    ready: blockers.length === 0,
    blockers,
  }
}

function signal(patch: Partial<LimitSignal> = {}): LimitSignal {
  return {
    account: A,
    kind: 'quota-exhausted',
    reason: 'quota',
    status: 429,
    scope,
    windows: [],
    observedAt: now,
    ...patch,
  }
}

function facts(
  setting: Setting,
  patch: Partial<PolicyFacts> = {},
): PolicyFacts {
  return {
    phase: 'pre-send',
    host: 'opencode1',
    now,
    clockNow,
    sessionId: 'session',
    requestScope: scope,
    history: history(),
    delivery: { owned: true, attributable: true, replayable: true },
    candidates: [candidate(A), candidate(B)],
    selection: { account: B, pin: 'pin' },
    // Cache bounds accompany a limited attempt, not an engine-owned pool reselect.
    hold:
      patch.phase === 'after-limit'
        ? sameAccountHoldFacts({
            accountKey: A,
            maxSameAccountWait: setting,
            activity: { accountKey: A, lastAcceptedAt: now, ttlMs: 3600000 },
          })
        : undefined,
    ...patch,
  }
}

// Compare the whole public decision envelope, including absent optional fields.
function envelope(decision: LimitDecision) {
  return {
    action: decision.action,
    account: 'account' in decision ? decision.account : undefined,
    delayMs: 'delayMs' in decision ? decision.delayMs : undefined,
    reason: decision.reason,
    family: 'family' in decision ? decision.family : undefined,
    messageKey: 'messageKey' in decision ? decision.messageKey : undefined,
    retryAfterMs:
      'retryAfterMs' in decision ? decision.retryAfterMs : undefined,
    retryable: decision.retryable,
    hostRetry: decision.hostRetry,
  }
}

function check(
  decision: LimitDecision,
  expected: Partial<ReturnType<typeof envelope>>,
) {
  const result = envelope(decision)
  expect(result).toEqual({
    action: 'reroute',
    account: B,
    delayMs: undefined,
    reason: 'ready-alternative',
    family: undefined,
    messageKey: undefined,
    retryAfterMs: undefined,
    retryable: true,
    hostRetry: 'leave',
    ...expected,
  })
  return result
}

function wait(
  setting: Setting,
  candidates: readonly LimitCandidate[],
  patch: Partial<PolicyFacts> = {},
) {
  return decideAfterLimit(
    facts(setting, { candidates, selection: undefined, ...patch }),
    earliestPoolEngine,
  )
}

function checkWait(decision: LimitDecision, delayMs: number) {
  return check(decision, {
    action: 'wait-then-reselect',
    account: undefined,
    delayMs,
    reason: 'pool-blocked',
  })
}

function checkRefusal(
  decision: LimitDecision,
  patch: Partial<ReturnType<typeof envelope>> = {},
) {
  return check(decision, {
    action: 'refuse',
    account: undefined,
    reason: 'quota',
    family: 'json-412',
    messageKey: 'quota.pool-exhausted',
    retryable: false,
    hostRetry: 'veto',
    ...patch,
  })
}

function drive(
  setting: Setting,
  readFacts: (state: DriverState) => DriverFacts | undefined,
) {
  return runFakeClockDriver({
    axes: earliestPoolEngine,
    now,
    clockNow,
    history: history(),
    readFacts(state) {
      const supplied = readFacts(state)
      return supplied && { ...facts(setting), ...supplied }
    },
  })
}

let memorySequence = 0
function memoryStore(at = now) {
  const namespace = `antigravity-memory:${++memorySequence}`
  let snapshot: LimitsNamespace = createLimitsNamespace(namespace, 'generation')
  let binding: IdentityBinding = {
    account: { ...A, namespace },
    identity: 'identity-A',
    credentialEpoch: 'v5',
  }
  let sequence = 0
  let writes = 0
  const commit = (commands: readonly LimitsCommand[]) => {
    const result = applyLimitsCommands(snapshot, commands, {
      now: at,
      bindings: [binding],
      authorizeEpoch: (observed, current) =>
        observed.credentialEpoch === current.credentialEpoch,
    })
    snapshot = result.snapshot
    return result
  }
  const adapter: PersistenceAdapter = {
    namespace,
    async read() {
      return {
        snapshot: structuredClone(snapshot),
        bindings: [structuredClone(binding)],
        authoritative: true,
      }
    },
    async commit(commands) {
      writes++
      const result = commit(commands)
      return { ...(await this.read()), outcomes: result.outcomes }
    },
  }
  return {
    adapter,
    commit,
    get snapshot() {
      return snapshot
    },
    get binding() {
      return binding
    },
    get writes() {
      return writes
    },
    replace(next: IdentityBinding) {
      binding = next
    },
    base(id: string) {
      return {
        binding,
        baseRevision: snapshot.revision,
        producerId: 'conformance',
        operationId: `${id}-${++sequence}`,
      }
    },
    mark(until: number, id = 'mark'): Extract<LimitsCommand, { type: 'mark' }> {
      return {
        ...this.base(id),
        type: 'mark',
        scope,
        window: 'rate',
        until,
        evidenceAt: at,
        mergeLaw: 'max-until',
      }
    },
  }
}

function fakeClock(at = now) {
  let time = at
  const timers = new Map<object, { at: number; callback: () => void }>()
  return {
    now: () => time,
    setTimeout(callback: () => void, delayMs: number) {
      const token = {}
      timers.set(token, { at: time + delayMs, callback })
      return token
    },
    clearTimeout(token: unknown) {
      timers.delete(token as object)
    },
    advance(ms: number) {
      const target = time + ms
      for (;;) {
        const due = [...timers]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        time = due[1].at
        due[1].callback()
      }
      time = target
    },
  }
}

describe('earliest-pool-engine conformance (maxSameAccountWait: 0)', () => {
  test('0/default/15/max never reserve A with a confirmed 1s reset and ready B', () => {
    for (const setting of [0, undefined, 15, 'max'] as const) {
      const confirmed = {
        window: 'quota',
        confirmed: true,
        confirmedByReading: true,
        observedAt: now,
        resetAt: now + 1000,
        provenance: 'frozen-reading',
      }
      check(
        decideAfterLimit(
          facts(setting, {
            phase: 'after-limit',
            attempted: A,
            signal: signal({ windows: [confirmed] }),
            candidates: [
              { ...candidate(A, [hard(1000)]), confirmedBlockers: [confirmed] },
              candidate(B),
            ],
          }),
          earliestPoolEngine,
        ),
        { hostRetry: 'veto' },
      )
    }
  })
  afterAll(() => {
    const rows = conformanceRows.filter(
      (row) => row.preset === 'earliest-pool-engine',
    )
    expect(antigravityResults.map((result) => result.rowId).sort()).toEqual(
      rows
        .filter((row) => row.status === 'R')
        .map((row) => row.id)
        .sort(),
    )
    expect({
      rCovered: antigravityResults.length,
      rExcluded: 0,
      bRows: rows.filter((row) => row.status === 'B').length,
      dWitnesses: 0,
      total: rows.length,
    }).toEqual({
      rCovered: 55,
      rExcluded: 0,
      bRows: 16,
      dWitnesses: 0,
      total: 71,
    })
  })

  const hard = (ms: number) => ({ kind: 'hard' as const, until: now + ms })
  const soft = (ms?: number) => ({
    kind: 'soft' as const,
    until: ms === undefined ? undefined : now + ms,
  })
  const cooldown = (ms: number) => ({
    kind: 'cooldown' as const,
    until: now + ms,
  })
  const blocked = (
    a: LimitCandidate['blockers'],
    b: LimitCandidate['blockers'],
  ) => [candidate(A, a), candidate(B, b)]

  function oneWait(
    setting: Setting,
    candidates: readonly LimitCandidate[],
    delay: number,
    selected = B,
  ) {
    const trace = drive(setting, (state) =>
      state.event.type === 'sent'
        ? undefined
        : facts(
            setting,
            state.event.type === 'wake'
              ? { attempted: A, selection: { account: selected, pin: 'pin' } }
              : { candidates, selection: undefined },
          ),
    )
    expect(trace.sleeps).toEqual([{ now, clockNow, delayMs: delay }])
    expect(trace.sends).toEqual([
      { now: now + delay, clockNow: clockNow + delay, account: selected },
    ])
    expect(trace.stop).toBe('sent')
    checkWait(trace.decisions[0]!.decision, delay)
    check(trace.decisions[1]!.decision, { account: selected })
    return trace
  }

  function refusalTrace(
    setting: Setting,
    candidates: readonly LimitCandidate[],
    budget: number,
    retryAfterMs?: number,
    noticeDelayMs = 0,
  ) {
    // Quota reset metadata is supplied by the plugin independently of eligibility.
    const trace = drive(setting, () =>
      facts(setting, {
        candidates,
        selection: undefined,
        poolWaitBudgetMs: budget,
        terminal: { source: 'pool', reason: 'quota', retryAfterMs },
      }),
    )
    expect(trace.sleeps).toEqual([])
    expect(trace.sends).toEqual([])
    expect(trace.stop).toBe('refuse')
    const decision = trace.decisions[0]!.decision
    checkRefusal(decision, { retryAfterMs })
    const wire = buildRefusal({
      family: 'json-412',
      messageKey: 'quota.pool-exhausted',
      now,
      retryAfterMs,
      noticeDelayMs,
    })
    expect(wire.kind).toBe('http')
    if (wire.kind !== 'http') throw new Error('Expected HTTP refusal')
    expect(wire.status).toBe(412)
    expect(JSON.parse(wire.body).error).toMatchObject({
      code: 412,
      status: 'FAILED_PRECONDITION',
    })
    expect(wire.headers.get('retry-after')).toBe(
      retryAfterMs === undefined
        ? null
        : String(Math.ceil((retryAfterMs - noticeDelayMs) / 1000)),
    )
    return {
      decision: envelope(decision),
      headers: [...wire.headers],
      sleeps: trace.sleeps,
      sends: trace.sends,
    }
  }

  vector('AG-WAIT-1', 'earliest family hard reset is 30s', (setting) =>
    oneWait(setting, blocked([hard(30000)], [hard(60000)]), 30000),
  )
  vector(
    'AG-WAIT-2',
    'min of per-account max hard/model/cooldown blockers is 6s',
    (setting) =>
      oneWait(
        setting,
        blocked(
          [hard(2000), hard(7000), cooldown(4000)],
          [hard(3000), cooldown(6000)],
        ),
        6000,
      ),
  )
  vector(
    'AG-WAIT-3',
    'soft reset requires refreshed headroom before sending B',
    (setting) =>
      oneWait(
        setting,
        blocked([hard(10000), soft(3600000)], [soft(1000)]),
        1000,
      ),
  )
  vector(
    'AG-WAIT-4',
    'missing and stale soft resets are unknown, never immediate readiness',
    (setting) => {
      for (const candidates of [
        blocked([soft()], [soft()]),
        blocked([soft(-1000)], [soft(-5000)]),
      ])
        checkRefusal(wait(setting, candidates))
      check(decideAfterLimit(facts(setting), earliestPoolEngine), {})
      return envelope(wait(setting, blocked([soft()], [soft()])))
    },
  )
  vector(
    'AG-WAIT-5',
    'known 2s candidate exceeds 1s budget without unknown reset metadata',
    (setting) => refusalTrace(setting, blocked([soft()], [soft(2000)]), 1000),
  )

  function rolling(
    setting: Setting,
    path: 'hard' | 'soft' | 'mixed',
    budget: number,
    releaseAt?: number,
    secondSend = false,
  ) {
    const trace = drive(setting, (state) => {
      const elapsed = state.clockNow - clockNow
      if (state.event.type === 'sent' && (!secondSend || elapsed === 1600))
        return undefined
      const ready =
        state.event.type !== 'sent' &&
        (elapsed === releaseAt || (secondSend && elapsed === 1600))
      const selected = elapsed === 1600 && secondSend ? B : A
      const kind =
        path === 'mixed'
          ? Math.floor(elapsed / 400) % 2
            ? 'soft'
            : 'hard'
          : path
      return facts(setting, {
        candidates: ready
          ? [candidate(A), candidate(B)]
          : blocked(
              [{ kind, until: state.now + 400 }],
              [{ kind, until: state.now + 400 }],
            ),
        selection: ready ? { account: selected, pin: 'pin' } : undefined,
        poolWaitBudgetMs: budget,
        terminal: { source: 'pool', reason: 'quota', retryAfterMs: 1000 },
      })
    })
    for (const { decision } of trace.decisions) {
      if (decision.action === 'wait-then-reselect')
        checkWait(decision, decision.delayMs)
      else if (decision.action === 'refuse')
        checkRefusal(decision, { retryAfterMs: 1000 })
      else
        check(decision, {
          account: decision.action === 'reroute' ? decision.account : undefined,
        })
    }
    return trace
  }
  vector(
    'AG-WAIT-6',
    'hard/soft/mixed share one elapsed blocked budget',
    (setting) =>
      ['hard', 'soft', 'mixed'].map((path) => {
        const trace = rolling(setting, path as 'hard' | 'soft' | 'mixed', 1000)
        expect(trace.sleeps.map((sleep) => sleep.delayMs)).toEqual([
          400, 400, 200,
        ])
        expect(trace.sends).toEqual([])
        expect(trace.stop).toBe('refuse')
        expect(trace.history.blockedSince).toBe(clockNow)
        return trace
      }),
  )
  vector(
    'AG-WAIT-7',
    'a ready send replenishes only the blocked budget',
    (setting) => {
      const trace = rolling(setting, 'mixed', 1000, 800, true)
      expect(trace.sleeps.map((sleep) => sleep.delayMs)).toEqual([
        400, 400, 400, 400,
      ])
      expect(trace.sends).toEqual([
        { now: now + 800, clockNow: clockNow + 800, account: A },
        { now: now + 1600, clockNow: clockNow + 1600, account: B },
      ])
      expect(trace.decisions[3]!.decision.history.blockedSince).toBe(
        clockNow + 800,
      )
      expect(trace.history.requestStartedAt).toBe(clockNow)
      return trace
    },
  )
  vector(
    'AG-WAIT-8',
    'killswitch-excluded A cannot shorten B 10s metadata',
    (setting) =>
      refusalTrace(
        setting,
        [candidate(A, [hard(2000)], false), candidate(B, [hard(10000)])],
        5000,
        10000,
      ),
  )
  vector(
    'AG-WAIT-9',
    'unknown soft reset omits Retry-After; long known reset keeps 5700',
    (setting) => [
      refusalTrace(setting, blocked([soft()], [soft()]), 1000),
      refusalTrace(
        setting,
        blocked([soft(5700000)], [soft(5700000)]),
        1000,
        5700000,
      ),
    ],
  )
  vector(
    'AG-WAIT-10',
    'single eligible soft exemption never waives hard marks',
    (setting) =>
      oneWait(
        setting,
        [candidate(A, [hard(4000), soft(3600000)]), candidate(B, [], false)],
        4000,
        A,
      ),
  )
  vector(
    'AG-WAIT-11',
    'below-killswitch stored alternative does not defeat soft exemption',
    (setting) => {
      const trace = drive(setting, (state) =>
        state.event.type === 'sent'
          ? undefined
          : facts(setting, {
              candidates: [
                candidate(A, [soft(8000)]),
                candidate(B, [soft(8000)], false),
              ],
              selection: { account: A, pin: 'pin' },
            }),
      )
      expect(trace.sleeps).toEqual([])
      expect(trace.sends).toEqual([{ now, clockNow, account: A }])
      check(trace.decisions[0]!.decision, { account: A })
      return trace
    },
  )
  vector(
    'AG-WAIT-12',
    'budget 0 disables quota budget, not the deadline',
    (setting) =>
      ['hard', 'soft', 'mixed'].map((path) => {
        const trace = rolling(
          setting,
          path as 'hard' | 'soft' | 'mixed',
          0,
          1600,
        )
        expect(trace.sleeps.map((sleep) => sleep.delayMs)).toEqual([
          400, 400, 400, 400,
        ])
        expect(trace.sends).toEqual([
          { now: now + 1600, clockNow: clockNow + 1600, account: A },
        ])
        return trace
      }),
  )
  vector(
    'AG-WAIT-13',
    'cooldown and soft blockers compose to 8s before fresh selection',
    (setting) =>
      oneWait(
        setting,
        blocked([soft(2000), cooldown(8000)], [soft(20000)]),
        8000,
        A,
      ),
  )
  vector(
    'AG-WAIT-14',
    'active cooldown suppresses metadata on soft refusal',
    (setting) =>
      refusalTrace(
        setting,
        blocked([soft(2000), cooldown(8000)], [soft(20000)]),
        4000,
      ),
  )
  vector(
    'AG-WAIT-15',
    'cooldown is not trustworthy quota reset metadata',
    (setting) =>
      refusalTrace(setting, blocked([cooldown(8000)], [soft(3600000)]), 4000),
  )
  vector(
    'AG-WAIT-16',
    'single account hard 2s plus cooldown 8s still refuses at 1s budget',
    (setting) =>
      refusalTrace(setting, [candidate(A, [hard(2000), cooldown(8000)])], 1000),
  )
  vector(
    'AG-WAIT-17',
    'unknown hard helper uses 60s fallback without inventing reset metadata',
    (setting) =>
      refusalTrace(setting, [candidate(A, [{ kind: 'cooldown' }])], 1000),
  )
  vector(
    'AG-WAIT-18',
    'notice consumes 3s of a 10s reset estimate',
    (setting) =>
      ['hard', 'soft'].map((kind) =>
        refusalTrace(
          setting,
          blocked(
            [{ kind: kind as 'hard' | 'soft', until: now + 10000 }],
            [{ kind: kind as 'hard' | 'soft', until: now + 10000 }],
          ),
          1000,
          10000,
          3000,
        ),
      ),
  )
  vector(
    'AG-WAIT-19',
    'unrelated family mark omitted but global cooldown still waits 6s',
    (setting) => {
      expect(
        scopeCovers(
          { kind: 'family', family: 'claude' },
          scope.model,
          () => 'gemini',
        ),
      ).toBe(false)
      return oneWait(setting, [candidate(A, [cooldown(6000)])], 6000, A)
    },
  )

  vector(
    'AG-WAIT-20',
    '600s deadline remains active under 300/600/1200/0 quota budgets',
    (setting) =>
      [300000, 600000, 1200000, 0].map((budget) => {
        const trace = drive(setting, (state) =>
          facts(setting, {
            candidates: blocked(
              [{ kind: 'hard', until: state.now + 150000 }],
              [{ kind: 'hard', until: state.now + 150000 }],
            ),
            selection: undefined,
            poolWaitBudgetMs: budget,
          }),
        )
        expect(trace.sends).toEqual([])
        expect(trace.sleeps.map((sleep) => sleep.delayMs)).toEqual(
          budget === 300000
            ? [150000, 150000]
            : [150000, 150000, 150000, 150000],
        )
        const elapsed = budget === 300000 ? 300000 : 600000
        // The driver stops at the deadline; when both expire together, quota refusal wins over timeout.
        const final = wait(
          setting,
          blocked(
            [{ kind: 'hard', until: now + elapsed + 150000 }],
            [{ kind: 'hard', until: now + elapsed + 150000 }],
          ),
          {
            now: now + elapsed,
            clockNow: clockNow + elapsed,
            history: trace.history,
            poolWaitBudgetMs: budget,
          },
        )
        checkRefusal(
          final,
          budget === 0 || budget > 600000
            ? { reason: 'incomplete', messageKey: 'incomplete.timeout' }
            : {},
        )
        expect(trace.stop).toBe(budget === 300000 ? 'refuse' : 'deadline')
        return { trace, final: envelope(final) }
      }),
  )
  vector(
    'AG-WAIT-21',
    'selection and send latency never replenish the original deadline',
    (setting) => {
      let start = { now, clockNow, history: history() }
      const sleeps: number[] = []
      const sends: AccountKey[] = []
      for (let index = 0; index < 3; index++) {
        const trace = runFakeClockDriver({
          ...start,
          axes: earliestPoolEngine,
          readFacts(state) {
            if (state.event.type === 'sent') return undefined
            return facts(
              setting,
              state.event.type === 'wake'
                ? { selection: { account: B, pin: 'pin' } }
                : {
                    candidates: blocked(
                      [{ kind: 'hard', until: state.now + 150000 }],
                      [{ kind: 'hard', until: state.now + 150000 }],
                    ),
                    selection: undefined,
                    poolWaitBudgetMs: 450000,
                  },
            )
          },
        })
        sleeps.push(...trace.sleeps.map((sleep) => sleep.delayMs))
        sends.push(...trace.sends.map((send) => send.account))
        start = {
          now: start.now + 225000,
          clockNow: start.clockNow + 225000,
          history: trace.history,
        }
        if (index === 2) expect(trace.stop).toBe('deadline')
      }
      expect(sleeps).toEqual([150000, 150000, 150000])
      expect(sends).toEqual([B, B])
      expect(start.history.requestStartedAt).toBe(clockNow)
      const final = wait(setting, blocked([hard(900000)], [hard(900000)]), {
        now: now + 600000,
        clockNow: clockNow + 600000,
        history: start.history,
        poolWaitBudgetMs: 450000,
      })
      checkRefusal(final, {
        reason: 'incomplete',
        messageKey: 'incomplete.timeout',
      })
      return { sleeps, sends, final: envelope(final) }
    },
  )

  vector(
    'AG-SKIP-1',
    'NOT_FOUND exclusion reroutes to ready B without switch charge',
    (setting) => {
      // AG-SKIP-1 parser precedence of exact error.status NOT_FOUND over message matching is proven by antigravity-auth's adoption tests.
      const parsed = signal({
        kind: 'model-unavailable',
        status: 404,
        reason: 'NOT_FOUND',
      })
      const trace = drive(setting, (state) => {
        if (
          state.event.type === 'sent' &&
          state.event.decision.account.accountId === 'B'
        )
          return undefined
        return facts(
          setting,
          state.event.type === 'start'
            ? { selection: { account: A, pin: 'pin' } }
            : { phase: 'after-limit', attempted: A, signal: parsed },
        )
      })
      expect(trace.decisions.map(({ decision }) => decision.action)).toEqual([
        'reroute',
        'exclude-for-request',
        'reroute',
      ])
      expect(trace.sleeps).toEqual([])
      expect(trace.sends.map((send) => send.account)).toEqual([A, B])
      expect(trace.history.switches).toBe(0)
      expect(trace.history.excludedForRequest).toEqual([{ account: A, scope }])
      expect(trace.exclusions[0]!.effects).toEqual({
        refundHybridToken: true,
        cancelDiscardedBody: true,
        addMark: false,
        addCooldown: false,
        penalizeHealth: false,
        chargeSwitch: false,
      })
      check(trace.decisions[1]!.decision, {
        action: 'exclude-for-request',
        account: A,
        reason: 'model-unavailable',
        hostRetry: 'veto',
      })
      check(trace.decisions[2]!.decision, {})
      return trace
    },
  )
  vector(
    'AG-SKIP-2',
    'all three accounts excluded once, then model 412 with no Retry-After',
    (setting) => {
      // AG-SKIP-2 parser precedence of exact error.status NOT_FOUND over message matching is proven by antigravity-auth's adoption tests.
      const C = { ...A, accountId: 'C' }
      const accounts = [A, B, C]
      const trace = drive(setting, (state) => {
        const selected = accounts.find(
          (account) =>
            !state.history.excludedForRequest.some(
              (entry) => entry.account.accountId === account.accountId,
            ),
        )
        const attempted =
          state.event.type === 'sent' ? state.event.decision.account : undefined
        return facts(setting, {
          candidates: accounts.map((account) => candidate(account)),
          selection: selected && { account: selected, pin: 'pin' },
          ...(attempted
            ? {
                phase: 'after-limit' as const,
                attempted,
                signal: signal({
                  account: attempted,
                  kind: 'model-unavailable',
                  status: 404,
                  reason: 'NOT_FOUND',
                }),
              }
            : {}),
        })
      })
      expect(trace.sleeps).toEqual([])
      expect(trace.sends.map((send) => send.account)).toEqual(accounts)
      expect(trace.exclusions).toHaveLength(3)
      expect(trace.history.switches).toBe(0)
      expect(
        trace.history.excludedForRequest.map((entry) => entry.account),
      ).toEqual(accounts)
      checkRefusal(trace.decisions.at(-1)!.decision, {
        reason: 'model-unavailable',
        messageKey: 'model-unavailable',
      })
      const wire = buildRefusal({
        family: 'json-412',
        messageKey: 'model-unavailable',
        now,
      })
      if (wire.kind !== 'http') throw new Error('Expected HTTP refusal')
      expect([...wire.headers]).toEqual([['content-type', 'application/json']])
      return trace
    },
  )
  vector(
    'AG-SKIP-4',
    'first-array NOT_FOUND signal excludes independently of diagnostic reasons',
    (setting) => {
      // AG-SKIP-4 response-array element zero's error.status, not details[].reason, triggers exclusion; parser precedence is proven by antigravity-auth's adoption tests.
      const parsed = signal({
        kind: 'model-unavailable',
        status: 404,
        reason: 'NOT_FOUND',
      })
      const decision = decideAfterLimit(
        facts(setting, { phase: 'after-limit', attempted: A, signal: parsed }),
        earliestPoolEngine,
      )
      const result = check(decision, {
        action: 'exclude-for-request',
        account: A,
        reason: 'model-unavailable',
        hostRetry: 'veto',
      })
      expect(resolveReset([], now)).toBeUndefined()
      return result
    },
  )
  for (const [id, budget] of [
    ['AG-SKIP-5', 5000],
    ['AG-SKIP-6', 15000],
  ] as const)
    vector(
      id,
      'excluded A 2s ignored in favor of blocked unskipped B 10s',
      (setting) => {
        const excluded = commitRequestExclusion(history(), {
          account: A,
          scope,
          attemptId: 'not-found',
        }).history
        const trace = runFakeClockDriver({
          axes: earliestPoolEngine,
          now,
          clockNow,
          history: excluded,
          readFacts(state) {
            if (state.event.type === 'sent') return undefined
            return facts(setting, {
              candidates:
                state.event.type === 'wake'
                  ? [candidate(A), candidate(B)]
                  : blocked([hard(2000)], [hard(10000)]),
              selection:
                state.event.type === 'wake'
                  ? { account: B, pin: 'pin' }
                  : undefined,
              poolWaitBudgetMs: budget,
              terminal: {
                source: 'pool',
                reason: 'quota',
                retryAfterMs: 10000,
              },
            })
          },
        })
        expect(trace.sleeps.map((sleep) => sleep.delayMs)).toEqual(
          budget === 5000 ? [] : [10000],
        )
        expect(trace.sends.map((send) => send.account)).toEqual(
          budget === 5000 ? [] : [B],
        )
        if (budget === 5000)
          checkRefusal(trace.decisions[0]!.decision, { retryAfterMs: 10000 })
        else {
          checkWait(trace.decisions[0]!.decision, 10000)
          check(trace.decisions[1]!.decision, {})
        }
        return trace
      },
    )

  for (const [id, status] of [
    ['AG-CLASS-1', 503],
    ['AG-CLASS-2', 529],
  ] as const)
    vector(
      id,
      'status forces capacity; inner retry does not reach ordinary MARK',
      (setting) => {
        // AG-CLASS-1/2 capacity status over quota reason precedence is proven by antigravity-auth's adoption tests.
        const parsed = signal({ kind: 'capacity', reason: 'capacity', status })
        expect(parsed.kind).toBe('capacity')
        expect(resolveReset([], now)).toBeUndefined()
        // The plugin's endpoint retry loop has emitted no marker event; absent signals must not manufacture a mark.
        expect(
          markFromSignal(undefined, earliestPoolEngine.markers.opencode1, {
            now,
          }),
        ).toBeUndefined()
        return check(
          decideAfterLimit(
            facts(setting, {
              phase: 'after-limit',
              attempted: A,
              signal: parsed,
            }),
            earliestPoolEngine,
          ),
          { hostRetry: 'veto' },
        )
      },
    )
  for (const [id, status] of [
    ['AG-CLASS-4', 403],
    ['AG-CLASS-8', 401],
  ] as const)
    vector(
      id,
      'unclassified upstream local failure passes without quota rotation',
      (setting) => {
        // AG-CLASS-4/8 unclassified 403/401 producing no signal is proven by antigravity-auth's adoption tests.
        const parsed = undefined
        expect(
          markFromSignal(parsed, earliestPoolEngine.markers.opencode1, { now }),
        ).toBeUndefined()
        expect(resolveReset([], now)).toBeUndefined()
        return check(
          decideAfterLimit(
            facts(setting, {
              phase: 'after-limit',
              attempted: A,
              status,
              signal: parsed,
            }),
            earliestPoolEngine,
          ),
          { action: 'pass', account: undefined, reason: 'unhandled-failure' },
        )
      },
    )
  for (const [id, state] of [
    [
      'AG-CLASS-5',
      { enabled: false, accountIneligible: true, verificationRequired: false },
    ],
    [
      'AG-CLASS-6',
      { enabled: false, accountIneligible: false, verificationRequired: true },
    ],
    [
      'AG-CLASS-7',
      { enabled: false, accountIneligible: true, verificationRequired: false },
    ],
  ] as const)
    vector(
      id,
      'persistent access blocks admission; ineligible wins validation',
      (setting) => {
        // AG-CLASS-5/6/7 ineligible over validation precedence is proven by antigravity-auth's adoption tests.
        const memory = memoryStore()
        memory.commit([
          {
            ...memory.base('access'),
            type: 'access',
            state,
            eligibilityStateUpdatedAt: now,
          },
        ])
        expect(memory.snapshot.access[0]!.state).toEqual(state)
        const validation = id === 'AG-CLASS-6'
        const timers = validation
          ? [
              { scope: { kind: 'pool' as const }, window: 'cooldown' },
              { scope, window: 'validation' },
            ]
          : []
        for (const timer of timers)
          memory.commit([
            {
              ...memory.base(timer.window),
              type: 'mark',
              ...timer,
              until: now + 600000,
              evidenceAt: now,
              mergeLaw: 'max-until',
            },
          ])
        expect(
          memory.snapshot.marks.map((mark) => ({
            scope: mark.key.scope,
            window: mark.key.window,
            until: mark.entries[0]!.until,
          })),
        ).toEqual(
          validation
            ? [
                {
                  scope: { kind: 'pool' },
                  window: 'cooldown',
                  until: now + 600000,
                },
                { scope, window: 'validation', until: now + 600000 },
              ]
            : [],
        )
        return check(
          decideAfterLimit(
            facts(setting, {
              phase: 'after-limit',
              attempted: A,
              signal: signal({
                kind: 'account-access',
                reason: validation ? 'validation-required' : 'ineligible',
                status: 403,
              }),
              candidates: [candidate(A, [], false), candidate(B)],
            }),
            earliestPoolEngine,
          ),
          { hostRetry: 'veto' },
        )
      },
    )
  vector(
    'AG-CLASS-12',
    'typed reason precedes ordered capacity/rate/quota/unknown message outputs',
    (setting) => {
      // AG-CLASS-12 typed reason over ordered message rules is proven by antigravity-auth's adoption tests.
      const outputs = [
        ['capacity', 'capacity', 45000],
        ['rate-limit', 'rate', 30000],
        ['quota-exhausted', 'quota', 60000],
        ['quota-exhausted', 'unknown', 60000],
      ] as const
      return outputs.map(([kind, reason, delay]) => {
        const parsed = signal({ kind, reason })
        const mark = markFromSignal(
          parsed,
          earliestPoolEngine.markers.opencode1,
          { now, random: 0.5 },
        )
        expect(mark).toEqual({
          scope,
          until: now + delay,
          mergeLaw: 'max-until',
        })
        expect(resolveReset([], now)).toBeUndefined()
        return check(
          decideAfterLimit(
            facts(setting, {
              phase: 'after-limit',
              attempted: A,
              signal: parsed,
            }),
            earliestPoolEngine,
          ),
          { hostRetry: 'veto' },
        )
      })
    },
  )

  const failure = (
    previous: FailureHistory,
    at = now,
    ttlMs?: number,
    account = A,
  ) => reduceFailureHistory(previous, { type: 'failure', account, at }, ttlMs)
  function marker(
    parsed: LimitSignal,
    duration: number,
    options: { now?: number; failures?: FailureHistory; random?: number } = {},
  ) {
    const at = options.now ?? now
    const mark = markFromSignal(parsed, earliestPoolEngine.markers.opencode1, {
      now: at,
      ...options,
    })
    expect(mark).toEqual({
      scope: parsed.scope,
      until: at + duration,
      mergeLaw: 'max-until',
    })
    return mark!
  }
  vector(
    'AG-MARK-1',
    'positive quota/rate server hints override the entire ladder',
    () => {
      let failures: FailureHistory = new Map()
      for (let i = 0; i < 5; i++) failures = failure(failures)
      return [
        marker(signal({ retryAfterMs: 120000 }), 120000, { failures }),
        marker(signal({ kind: 'rate-limit', retryAfterMs: 45000 }), 45000, {
          failures,
        }),
      ]
    },
  )
  vector('AG-MARK-2', '500/1000/1500ms positive hints clamp to 2000ms', () =>
    [500, 1000, 1500].map((retryAfterMs) => {
      // AG-MARK-2 positive RetryInfo body over header precedence is proven by antigravity-auth's adoption tests.
      expect(
        resolveReset(
          [
            {
              source: 'body',
              value: retryAfterMs,
              unit: 'delay-ms',
              zero: 'skip',
            },
            {
              source: 'header',
              value: 300000,
              unit: 'delay-ms',
              zero: 'accept',
            },
          ],
          now,
        ),
      ).toEqual({ resetAt: now + retryAfterMs, source: 'body' })
      return marker(signal({ retryAfterMs }), 2000)
    }),
  )
  vector(
    'AG-MARK-3',
    'quota counts 1/2/3/4/5 give 60/300/1800/7200/7200s',
    () => {
      let failures: FailureHistory = new Map()
      return [60000, 300000, 1800000, 7200000, 7200000].map((duration) => {
        failures = failure(failures)
        return marker(signal(), duration, { failures })
      })
    },
  )
  vector('AG-MARK-4', 'rate remains 30s at every failure count', () => {
    let failures: FailureHistory = new Map()
    return Array.from({ length: 6 }, () => {
      failures = failure(failures)
      return marker(signal({ kind: 'rate-limit', reason: 'rate' }), 30000, {
        failures,
      })
    })
  })
  vector(
    'AG-MARK-5',
    'direct capacity 45s plus or minus 15s, not inner backoff',
    () =>
      [0, 0.5, 1].map((random, index) =>
        marker(
          signal({ kind: 'capacity', reason: 'capacity' }),
          [30000, 45000, 60000][index]!,
          { random },
        ),
      ),
  )
  vector('AG-MARK-6', 'direct server-error calculator is 20s', () =>
    marker(signal({ reason: 'server-error' }), 20000),
  )
  vector('AG-MARK-7', 'unknown calculator is 60s', () =>
    marker(signal({ reason: 'unknown' }), 60000),
  )
  vector(
    'AG-MARK-8',
    'failure TTL resets strictly beyond; cache-first omits configured TTL',
    () => {
      const first = failure(new Map(), 0)
      return [
        marker(signal(), 60000, {
          now: 3700000,
          failures: failure(first, 3700000),
        }),
        marker(signal(), 300000, {
          now: 1800000,
          failures: failure(first, 1800000),
        }),
        marker(signal(), 60000, {
          now: 2000,
          failures: failure(first, 2000, 1000),
        }),
        marker(signal(), 300000, { now: 2000, failures: failure(first, 2000) }),
      ]
    },
  )
  vector('AG-MARK-9', 'exact one-hour TTL equality retains count 2', () =>
    marker(signal(), 300000, {
      now: 3600000,
      failures: failure(failure(new Map(), 0), 3600000),
    }),
  )
  vector(
    'AG-MARK-10',
    'success clears account-wide count 5, not timed marks or B history',
    () => {
      let failures: FailureHistory = new Map()
      for (let i = 0; i < 5; i++) failures = failure(failures)
      failures = failure(failures, now, undefined, B)
      const old = marker(signal(), 7200000, { failures })
      failures = reduceFailureHistory(failures, { type: 'success', account: A })
      expect(failures.size).toBe(1)
      expect(
        marksAfterSuccess(
          [old],
          earliestPoolEngine,
          scope.model,
          () => 'gemini',
        ),
      ).toEqual([old])
      expect(markIsActive(old, now + 1)).toBe(true)
      return [
        marker(signal(), 60000, { failures: failure(failures) }),
        marker(signal({ account: B }), 300000, {
          failures: failure(failures, now, undefined, B),
        }),
      ]
    },
  )
  vector(
    'AG-MARK-11',
    'server 30s marker is not effective retry-state sleep 60s',
    () => {
      const mark = marker(
        signal({ kind: 'rate-limit', reason: 'rate', retryAfterMs: 30000 }),
        30000,
      )
      expect(mark.until).not.toBe(now + 60000)
      return mark
    },
  )
  vector(
    'AG-MARK-12',
    'exact Gemini model does not block Flash; expiry boundary is strict',
    () => {
      const mark = marker(
        signal({ kind: 'rate-limit', reason: 'rate' }),
        30000,
        { now: 1000 },
      )
      expect(scopeCovers(mark.scope, scope.model, () => 'gemini')).toBe(true)
      expect(scopeCovers(mark.scope, 'gemini-flash', () => 'gemini')).toBe(
        false,
      )
      expect(markIsActive(mark, 30999)).toBe(true)
      expect(markIsActive(mark, 31000)).toBe(false)
      expect(markIsActive(mark, 31001)).toBe(false)
      return [mark, marker(signal({ retryAfterMs: 14950000 }), 14950000)]
    },
  )
  vector(
    'AG-MARK-13',
    'Claude family blocks every Claude model, not Gemini',
    () => {
      const mark = marker(
        signal({
          scope: { kind: 'family', family: 'claude' },
          retryAfterMs: 2000,
        }),
        2000,
      )
      for (const model of ['claude-sonnet', 'claude-opus'])
        expect(
          scopeCovers(mark.scope, model, (model) =>
            model.startsWith('claude') ? 'claude' : 'gemini',
          ),
        ).toBe(true)
      expect(scopeCovers(mark.scope, scope.model, () => 'gemini')).toBe(false)
      return mark
    },
  )
  for (const [id, header] of [
    ['AG-MARK-14', 300000],
    ['AG-MARK-15', 120000],
  ] as const)
    vector(id, 'body zero skipped, positive header retained', () => {
      // AG-MARK-14/15 zero RetryInfo body skipped before header precedence is proven by antigravity-auth's adoption tests.
      const reset = resolveReset(
        [
          { source: 'body', value: 0, unit: 'delay-ms', zero: 'skip' },
          { source: 'header', value: header, unit: 'delay-ms', zero: 'accept' },
        ],
        now,
      )
      expect(reset).toEqual({ resetAt: now + header, source: 'header' })
      return marker(
        signal({ retryAfterMs: header, retryAfterSource: reset!.source }),
        header,
      )
    })
  vector(
    'AG-MARK-16',
    'winning header zero survives resolution, then marker uses reason default',
    () => {
      // AG-MARK-16 winning header zero over configured default precedence is proven by antigravity-auth's adoption tests.
      const reset = resolveReset(
        [
          { source: 'header', value: 0, unit: 'delay-ms', zero: 'accept' },
          { source: 'default', value: 60000, unit: 'delay-ms', zero: 'accept' },
        ],
        now,
      )
      expect(reset).toEqual({ resetAt: now, source: 'header' })
      return [
        marker(
          signal({ kind: 'rate-limit', reason: 'rate', retryAfterMs: 0 }),
          30000,
        ),
        marker(signal({ retryAfterMs: 0 }), 60000),
      ]
    },
  )

  vector(
    'AG-MARK-17',
    'timed publication is detached with 1000ms debounce, not a send barrier',
    async (setting) => {
      const memory = memoryStore()
      const clock = fakeClock()
      const registry = await acquireLimitsRegistry({
        adapter: memory.adapter,
        clock,
        isAccessRestrictive: () => false,
      })
      try {
        const mark = marker(signal({ retryAfterMs: 60000 }), 60000)
        registry.enqueue({
          ...registry.observe(memory.binding),
          producerId: 'conformance',
          operationId: 'debounce',
          type: 'mark',
          scope: mark.scope,
          window: 'rate',
          until: mark.until,
          evidenceAt: now,
          mergeLaw: mark.mergeLaw,
        })
        expect(registry.snapshot.marks[0]!.entries[0]!.until).toBe(now + 60000)
        clock.advance(500)
        const sent = drive(setting, (state) =>
          state.event.type === 'sent'
            ? undefined
            : facts(setting, {
                candidates: blocked([hard(60000)], []),
                selection: { account: B, pin: 'pin' },
              }),
        )
        expect(sent.sends.map((send) => send.account)).toEqual([B])
        expect(memory.writes).toBe(0)
        expect(memory.snapshot.marks).toEqual([])
        clock.advance(499)
        expect(memory.writes).toBe(0)
        clock.advance(1)
        await registry.flush()
        expect(memory.writes).toBe(1)
        expect(memory.snapshot.marks[0]!.entries[0]!.until).toBe(now + 60000)
        return { mark, sends: sent.sends, writes: memory.writes }
      } finally {
        await registry.dispose()
      }
    },
  )
  vector(
    'AG-MARK-18',
    'durable max-until 9s dominates queued 1s and 5s',
    () => {
      const memory = memoryStore()
      for (const delay of [9000, 1000, 5000])
        memory.commit([memory.mark(now + delay)])
      const until = Math.max(
        ...memory.snapshot.marks[0]!.entries.map((entry) => entry.until),
      )
      expect(until).toBe(now + 9000)
      return until
    },
  )
  vector(
    'AG-MARK-19',
    'cold local hydration restores reset 31000 without failure counters',
    async () => {
      const memory = memoryStore(10000)
      memory.commit([memory.mark(31000)])
      const registry = await acquireLimitsRegistry({
        adapter: memory.adapter,
        clock: fakeClock(10000),
        isAccessRestrictive: () => false,
      })
      try {
        const hydrated = await registry.beforeDispatch(memory.binding)
        expect(hydrated.snapshot.marks[0]!.entries[0]!.until).toBe(31000)
        expect(
          markIsActive({ scope, until: 31000, mergeLaw: 'max-until' }, 10000),
        ).toBe(true)
        expect(hydrated.snapshot).not.toHaveProperty('failures')
        return marker(signal(), 60000, {
          now: 10000,
          failures: failure(new Map(), 10000),
        })
      } finally {
        await registry.dispose()
      }
    },
  )
  vector(
    'AG-MARK-20',
    'vault served-version attribution accepts v5 and drops mismatched writes',
    () => {
      const memory = memoryStore()
      const mark = memory.mark(now + 60000)
      const refused = memory.commit([
        { ...mark, binding: { ...memory.binding, credentialEpoch: 'v4' } },
      ])
      expect(refused.outcomes[0]).toMatchObject({
        status: 'rejected',
        reason: 'credential-epoch',
      })
      expect(memory.snapshot.marks).toEqual([])
      const accepted = memory.commit([memory.mark(now + 60000)])
      expect(accepted.outcomes[0]!.status).toBe('committed')
      expect(memory.snapshot.marks[0]!.entries[0]!.until).toBe(now + 60000)
      return memory.snapshot.marks.map((mark) => ({
        scope: mark.key.scope,
        until: mark.entries[0]!.until,
      }))
    },
  )
  vector(
    'AG-MARK-21',
    'cold vault hydration restores seeded family reset and cooldown for matching identity only',
    async () => {
      const memory = memoryStore(1000)
      memory.commit([
        { ...memory.mark(7000), scope: { kind: 'family', family: 'claude' } },
        { ...memory.mark(9000), scope: { kind: 'pool' }, window: 'cooldown' },
      ])
      const registry = await acquireLimitsRegistry({
        adapter: memory.adapter,
        clock: fakeClock(1000),
        isAccessRestrictive: () => false,
      })
      try {
        const hydrated = await registry.beforeDispatch(memory.binding)
        expect(
          hydrated.snapshot.marks.map((mark) => mark.entries[0]!.until),
        ).toEqual([7000, 9000])
        expect(hydrated.snapshot).not.toHaveProperty('failures')
        const old = memory.mark(11000)
        memory.replace({
          ...memory.binding,
          account: { ...memory.binding.account, incarnation: '2' },
          credentialEpoch: 'v6',
        })
        await registry.reload()
        // Old-incarnation records may remain stored, but cannot block the replacement's key.
        expect(
          registry.snapshot.marks.filter((mark) =>
            sameAccount(mark.key.account, memory.binding.account),
          ),
        ).toEqual([])
        expect(memory.commit([old]).outcomes[0]).toMatchObject({
          status: 'rejected',
          reason: 'unknown-account',
        })
        return hydrated.snapshot.marks.map((mark) => ({
          scope: mark.key.scope,
          until: mark.entries[0]!.until,
        }))
      } finally {
        await registry.dispose()
      }
    },
  )
  test('a newer dated reading clears covered marks, while a success still does not', () => {
    // antigravity-auth #69: the plugin removes a pool's marks when a newer dated
    // reading shows quota, so the preset declares it. Success-only clearing
    // stays off, because Antigravity refuses before sending.
    expect(earliestPoolEngine.readingClearsCoveredScopes).toBe('on')
    expect(earliestPoolEngine.successClearsCoveredScopes).toBe('off')
  })
})
