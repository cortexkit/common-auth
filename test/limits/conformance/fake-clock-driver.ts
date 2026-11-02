import {
  type AccountKey,
  commitRequestExclusion,
  decideAfterLimit,
  type LimitAxes,
  type LimitDecision,
  type PolicyFacts,
  type RequestHistory,
  reduceRequestHistory,
  sameAccount,
} from '../../../src/limits/index.js'

type WaitDecision = Extract<
  LimitDecision,
  { action: 'hold' | 'wait-then-reselect' }
>
type SendDecision = Extract<LimitDecision, { action: 'reroute' | 'retain' }>
type ExcludeDecision = Extract<LimitDecision, { action: 'exclude-for-request' }>

export type DriverEvent =
  | { readonly type: 'start' }
  | { readonly type: 'wake'; readonly decision: WaitDecision }
  | { readonly type: 'excluded'; readonly decision: ExcludeDecision }
  | { readonly type: 'sent'; readonly decision: SendDecision }

export interface DriverState {
  readonly now: number
  readonly clockNow: number
  readonly history: RequestHistory
  readonly event: DriverEvent
}

// A fixture resupplies live admission, placement and evidence after every event.
// The driver owns elapsed time, committed history and the wait checkpoint.
export type DriverFacts = Omit<
  PolicyFacts,
  'now' | 'clockNow' | 'history' | 'wake'
>

export interface DriverTrace {
  readonly stop: 'sent' | 'refuse' | 'pass' | 'deadline'
  readonly decisions: Array<DriverState & { readonly decision: LimitDecision }>
  readonly sleeps: Array<{
    readonly now: number
    readonly clockNow: number
    readonly delayMs: number
  }>
  readonly sends: Array<{
    readonly now: number
    readonly clockNow: number
    readonly account: AccountKey
  }>
  readonly exclusions: Array<{
    readonly account: AccountKey
    readonly effects: ExcludeDecision['effects']
  }>
  history: RequestHistory
}

/** Execute reducer decisions without real timers, network sends or global mocks. */
export function runFakeClockDriver(input: {
  readonly axes: LimitAxes
  readonly now: number
  readonly clockNow: number
  readonly history: RequestHistory
  /** Returning undefined after a send means the response was accepted. */
  readonly readFacts: (state: DriverState) => DriverFacts | undefined
  readonly maxDecisions?: number
}): DriverTrace {
  const maxDecisions = input.maxDecisions ?? 100
  if (!Number.isInteger(maxDecisions) || maxDecisions < 1)
    throw new Error('maxDecisions must be a positive integer')
  if (!Number.isFinite(input.now) || !Number.isFinite(input.clockNow))
    throw new Error('Driver clocks must be finite')
  const trace: Omit<DriverTrace, 'stop'> = {
    decisions: [],
    sleeps: [],
    sends: [],
    exclusions: [],
    history: input.history,
  }
  let now = input.now
  let clockNow = input.clockNow
  let event: DriverEvent = { type: 'start' }
  let refundSwitch = false
  const deadline =
    input.axes.poolWaiting.kind === 'earliest'
      ? input.history.requestStartedAt +
        input.axes.poolWaiting.requestDeadlineMs
      : Infinity
  const finish = (stop: DriverTrace['stop']): DriverTrace => ({
    ...trace,
    stop,
  })

  for (;;) {
    // The engine deadline aborts a pending wait before any wake selection, even
    // when a quota budget also expires or a candidate becomes ready at equality.
    if (clockNow >= deadline) return finish('deadline')
    const state: DriverState = { now, clockNow, history: trace.history, event }
    const supplied = input.readFacts(state)
    if (!supplied) {
      if (event.type === 'sent') return finish('sent')
      throw new Error(`Missing facts after ${event.type}`)
    }
    if (trace.decisions.length >= maxDecisions)
      throw new Error(`Driver exceeded ${maxDecisions} decisions`)
    const facts: PolicyFacts = {
      ...supplied,
      now,
      clockNow,
      history: trace.history,
      ...(event.type === 'wake'
        ? {
            phase: 'pre-send',
            hostPhase: 'request',
            wake: {
              checkpoint: event.decision.checkpoint,
              target: event.decision.target,
              kind: event.decision.waitKind,
            },
          }
        : event.type === 'excluded'
          ? { phase: 'pre-send', hostPhase: 'request' }
          : {}),
    }
    const decision = decideAfterLimit(facts, input.axes)
    trace.decisions.push({ ...state, decision })
    trace.history = decision.history
    const attemptId = `driver-${trace.sends.length}`

    switch (decision.action) {
      case 'hold':
      case 'wait-then-reselect': {
        if (!Number.isFinite(decision.delayMs) || decision.delayMs < 0)
          throw new Error('Reducer returned an invalid sleep')
        const delayMs = Math.min(decision.delayMs, deadline - clockNow)
        trace.sleeps.push({ now, clockNow, delayMs })
        now += delayMs
        clockNow += delayMs
        event = { type: 'wake', decision }
        break
      }
      case 'exclude-for-request': {
        const committed = commitRequestExclusion(trace.history, {
          account: decision.account,
          scope: decision.scope,
          attemptId,
        })
        trace.history = committed.history
        if (committed.effects)
          trace.exclusions.push({
            account: decision.account,
            effects: committed.effects,
          })
        refundSwitch = true
        event = { type: 'excluded', decision }
        break
      }
      case 'reroute':
      case 'retain':
        // A timed retain is a host retry hint, not an engine wait checkpoint.
        // Refuse to fabricate its transport timing or send before that retry.
        if (decision.action === 'retain' && decision.retryMs !== undefined)
          throw new Error('Timed retain requires a host retry driver')
        if (
          decision.action === 'reroute' &&
          facts.attempted &&
          !sameAccount(facts.attempted, decision.account) &&
          !refundSwitch
        )
          trace.history = reduceRequestHistory(trace.history, {
            type: 'switch',
            attemptId,
          })
        if (
          decision.action === 'retain' &&
          decision.reason === 'unconfirmed-limit'
        )
          trace.history = reduceRequestHistory(trace.history, {
            type: 'retain',
            cause: 'unconfirmed-limit',
            account: decision.account,
            attemptId,
            clockNow,
          })
        refundSwitch = false
        trace.sends.push({ now, clockNow, account: decision.account })
        event = { type: 'sent', decision }
        break
      case 'refuse':
      case 'pass':
        return finish(decision.action)
    }
  }
}
