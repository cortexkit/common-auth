import type { Scope } from './scope.js'
import type { AccountKey } from './signal.js'

export function sameAccount(a: AccountKey, b: AccountKey): boolean {
  return (
    a.namespace === b.namespace &&
    a.accountId === b.accountId &&
    a.incarnation === b.incarnation
  )
}

function sameScope(a: Scope, b: Scope): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'model') return b.kind === 'model' && a.model === b.model
  if (a.kind === 'family') return b.kind === 'family' && a.family === b.family
  return true
}

export interface RequestExclusion {
  readonly account: AccountKey
  readonly scope: Scope
}

export interface RetainHistory {
  readonly account: AccountKey
  readonly count: number
  readonly startedAt: number
  readonly lastRetainedAt: number
}

export interface RequestHistory {
  /** A request/turn token, not a session id. */
  readonly requestId: string
  readonly originalUrl: string
  readonly requestStartedAt: number
  readonly saw429: boolean
  readonly lastStatus?: number
  readonly tried: readonly RequestExclusion[]
  readonly excludedForRequest: readonly RequestExclusion[]
  readonly retains: readonly RetainHistory[]
  readonly retainedAttempts: readonly string[]
  readonly excludedAttempts: readonly string[]
  readonly switchedAttempts: readonly string[]
  readonly switches: number
  readonly blockedSince?: number
}

export function createRequestHistory(input: {
  readonly requestId: string
  readonly originalUrl: string
  readonly clockNow: number
}): RequestHistory {
  return {
    requestId: input.requestId,
    originalUrl: input.originalUrl,
    requestStartedAt: input.clockNow,
    saw429: false,
    tried: [],
    excludedForRequest: [],
    retains: [],
    retainedAttempts: [],
    excludedAttempts: [],
    switchedAttempts: [],
    switches: 0,
  }
}

export function isRequestExcluded(
  history: RequestHistory,
  account: AccountKey,
  scope: Scope,
): boolean {
  return history.excludedForRequest.some(
    (entry) =>
      sameAccount(entry.account, account) && sameScope(entry.scope, scope),
  )
}

export type RequestHistoryEvent =
  | {
      readonly type: 'response'
      readonly account: AccountKey
      readonly scope: Scope
      readonly status?: number
    }
  | {
      readonly type: 'retain'
      readonly account: AccountKey
      readonly attemptId: string
      readonly clockNow: number
      readonly cause: 'unconfirmed-limit' | 'credential-recovery'
    }
  | {
      readonly type: 'exclude'
      readonly account: AccountKey
      readonly scope: Scope
      readonly attemptId: string
    }
  | { readonly type: 'switch'; readonly attemptId: string }
  | { readonly type: 'blocked'; readonly clockNow: number }
  | { readonly type: 'selected' }

/** Retain/exclude/switch events are committed by the executor, not by polling. */
export function reduceRequestHistory(
  history: RequestHistory,
  event: RequestHistoryEvent,
): RequestHistory {
  switch (event.type) {
    case 'response': {
      const tried = history.tried.some(
        (entry) =>
          sameAccount(entry.account, event.account) &&
          sameScope(entry.scope, event.scope),
      )
        ? history.tried
        : [
            ...history.tried,
            { account: { ...event.account }, scope: { ...event.scope } },
          ]
      return {
        ...history,
        tried,
        saw429: history.saw429 || event.status === 429,
        lastStatus: event.status,
      }
    }
    case 'retain': {
      if (
        event.cause === 'credential-recovery' ||
        history.retainedAttempts.includes(event.attemptId)
      )
        return history
      const previous = history.retains.find((entry) =>
        sameAccount(entry.account, event.account),
      )
      return {
        ...history,
        retainedAttempts: [...history.retainedAttempts, event.attemptId],
        retains: [
          ...history.retains.filter(
            (entry) => !sameAccount(entry.account, event.account),
          ),
          {
            account: { ...event.account },
            count: (previous?.count ?? 0) + 1,
            startedAt: previous?.startedAt ?? event.clockNow,
            lastRetainedAt: event.clockNow,
          },
        ],
      }
    }
    case 'exclude':
      if (history.excludedAttempts.includes(event.attemptId)) return history
      return {
        ...history,
        excludedAttempts: [...history.excludedAttempts, event.attemptId],
        excludedForRequest: isRequestExcluded(
          history,
          event.account,
          event.scope,
        )
          ? history.excludedForRequest
          : [
              ...history.excludedForRequest,
              { account: { ...event.account }, scope: { ...event.scope } },
            ],
      }
    case 'switch':
      return history.switchedAttempts.includes(event.attemptId)
        ? history
        : {
            ...history,
            switchedAttempts: [...history.switchedAttempts, event.attemptId],
            switches: history.switches + 1,
          }
    case 'blocked':
      return history.blockedSince === undefined
        ? { ...history, blockedSince: event.clockNow }
        : history
    case 'selected': {
      const { blockedSince: _, ...selected } = history
      return selected
    }
  }
}

export const REQUEST_EXCLUSION_EFFECTS = Object.freeze({
  refundHybridToken: true,
  cancelDiscardedBody: true,
  addMark: false,
  addCooldown: false,
  penalizeHealth: false,
  chargeSwitch: false,
} as const)

/** Run the returned effects once, then reselect with the returned history. */
export function commitRequestExclusion(
  history: RequestHistory,
  entry: RequestExclusion & { readonly attemptId: string },
): {
  readonly history: RequestHistory
  readonly effects?: typeof REQUEST_EXCLUSION_EFFECTS
} {
  if (history.excludedAttempts.includes(entry.attemptId)) return { history }
  return {
    history: reduceRequestHistory(history, { type: 'exclude', ...entry }),
    effects: REQUEST_EXCLUSION_EFFECTS,
  }
}
