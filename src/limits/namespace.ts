import type { AuthorizeCredentialEpoch, IdentityBinding } from './identity.js'
import { validateIdentityFence } from './identity.js'
import type { LimitMarkCause, MergeLaw } from './marker.js'
import type { AccessOrder, TimedMarkEntry } from './merge-laws.js'
import { mergeAccessState, mergeTimedMarkEntries } from './merge-laws.js'
import { sameAccount } from './request-history.js'
import type { Scope } from './scope.js'
import type { AccountKey } from './signal.js'

export const LIMITS_HISTORY_BOUND = 1024

export interface MarkTarget {
  readonly scope: Scope
  readonly window: string
}

export interface TimedMarkKey extends MarkTarget {
  readonly account: AccountKey
}

export interface NamespaceMark {
  readonly key: TimedMarkKey
  readonly mergeLaw: MergeLaw
  readonly entries: readonly TimedMarkEntry[]
}

export interface ClearTombstone {
  readonly key: TimedMarkKey
  readonly revision: number
}

export interface CommittedOperation {
  readonly producerId: string
  readonly operationId: string
  readonly revision: number
}

export interface NamespaceAccess<T = unknown> extends AccessOrder {
  readonly account: AccountKey
  readonly state: T
}

/** JSON-compatible state; adapters own generation creation, locking and persistence. */
export interface LimitsNamespace<T = unknown> {
  readonly schemaVersion: 1
  readonly namespace: string
  readonly generation: string
  readonly revision: number
  readonly lowWatermark: number
  readonly marks: readonly NamespaceMark[]
  readonly tombstones: readonly ClearTombstone[]
  readonly operationIds: readonly CommittedOperation[]
  readonly access: readonly NamespaceAccess<T>[]
}

interface CommandBase {
  readonly producerId: string
  readonly operationId: string
  readonly binding: IdentityBinding
  readonly baseRevision: number
}

export type LimitsCommand<T = unknown> = CommandBase &
  (
    | ({
        readonly type: 'mark'
        readonly until: number
        readonly evidenceAt: number
        readonly mergeLaw: MergeLaw
        readonly cause?: LimitMarkCause
      } & MarkTarget)
    | {
        readonly type: 'clear'
        readonly keys: readonly MarkTarget[]
        /** Absent for explicit user clears; automatic clears carry their evidence time. */
        readonly evidenceAt?: number
        /** A successful probe clears only this cause, but fences absent/expired keys too. */
        readonly cause?: LimitMarkCause
      }
    | {
        readonly type: 'access'
        readonly state: T
        readonly eligibilityStateUpdatedAt: number
      }
  )

export interface LimitsMergeContext {
  readonly now: number
  /** Current identity bindings, loaded under the same lock as this merge. */
  readonly bindings: readonly IdentityBinding[]
  readonly authorizeEpoch: AuthorizeCredentialEpoch
}

export type LimitsRejection =
  | 'below-watermark'
  | 'future-revision'
  | 'wrong-namespace'
  | 'unknown-account'
  | 'identity-replaced'
  | 'credential-epoch'
  | 'cleared'
  | 'newer-evidence'
  | 'merge-law-conflict'

export interface LimitsCommandOutcome {
  readonly producerId: string
  readonly operationId: string
  readonly status: 'committed' | 'duplicate' | 'rejected'
  readonly revision?: number
  readonly reason?: LimitsRejection
}

export interface LimitsMergeResult<T = unknown> {
  readonly snapshot: LimitsNamespace<T>
  readonly outcomes: readonly LimitsCommandOutcome[]
}

export function createLimitsNamespace<T = unknown>(
  namespace: string,
  generation: string,
): LimitsNamespace<T> {
  return {
    schemaVersion: 1,
    namespace,
    generation,
    revision: 0,
    lowWatermark: 0,
    marks: [],
    tombstones: [],
    operationIds: [],
    access: [],
  }
}

function accountId(account: AccountKey): string {
  return JSON.stringify([
    account.namespace,
    account.accountId,
    account.incarnation,
  ])
}

export function timedMarkKeyId(key: TimedMarkKey): string {
  const scope = key.scope
  return JSON.stringify([
    accountId(key.account),
    scope.kind,
    scope.kind === 'model'
      ? scope.model
      : scope.kind === 'family'
        ? scope.family
        : null,
    key.window,
  ])
}

function operationId(op: CommittedOperation | CommandBase): string {
  return JSON.stringify([op.producerId, op.operationId])
}

/** Apply tombstones before compacting them; the watermark then fences delayed commands. */
export function pruneLimitsNamespace<T>(
  snapshot: LimitsNamespace<T>,
  now: number,
): LimitsNamespace<T> {
  const clears = new Map(
    snapshot.tombstones.map((t) => [timedMarkKeyId(t.key), t.revision]),
  )
  const marks = snapshot.marks.flatMap((mark) => {
    const entries = mergeTimedMarkEntries(
      mark.mergeLaw,
      mark.entries,
      now,
      clears.get(timedMarkKeyId(mark.key)),
    )
    return entries.length ? [{ ...mark, entries }] : []
  })
  let lowWatermark = snapshot.lowWatermark
  const compact = <E extends { readonly revision: number }>(
    entries: readonly E[],
  ): readonly E[] => {
    const ordered = [...entries].sort((a, b) => a.revision - b.revision)
    const count = Math.max(0, ordered.length - LIMITS_HISTORY_BOUND)
    for (const entry of ordered.slice(0, count)) {
      lowWatermark = Math.max(lowWatermark, entry.revision + 1)
    }
    return ordered.slice(count)
  }
  const tombstones = compact(snapshot.tombstones)
  const operationIds = compact(snapshot.operationIds)
  return {
    ...snapshot,
    revision: Math.max(snapshot.revision, lowWatermark),
    marks,
    tombstones,
    operationIds,
    lowWatermark,
  }
}

/** Pure transaction body; load namespace state and identity bindings under one lock. */
export function applyLimitsCommands<T>(
  initial: LimitsNamespace<T>,
  commands: readonly LimitsCommand<T>[],
  context: LimitsMergeContext,
): LimitsMergeResult<T> {
  let snapshot = pruneLimitsNamespace(initial, context.now)
  const outcomes: LimitsCommandOutcome[] = []
  for (const command of commands) {
    const reject = (reason: LimitsRejection) => {
      outcomes.push({
        producerId: command.producerId,
        operationId: command.operationId,
        status: 'rejected',
        reason,
      })
    }
    if (command.binding.account.namespace !== snapshot.namespace) {
      reject('wrong-namespace')
      continue
    }
    if (command.baseRevision < snapshot.lowWatermark) {
      reject('below-watermark')
      continue
    }
    if (command.baseRevision > snapshot.revision) {
      reject('future-revision')
      continue
    }
    const authoritative = context.bindings.find((b) =>
      sameAccount(b.account, command.binding.account),
    )
    if (!authoritative) {
      reject('unknown-account')
      continue
    }
    const fence = validateIdentityFence(
      command.binding,
      authoritative,
      context.authorizeEpoch,
    )
    if (fence) {
      reject(fence)
      continue
    }
    const duplicate = snapshot.operationIds.find(
      (op) => operationId(op) === operationId(command),
    )
    if (duplicate) {
      outcomes.push({ ...duplicate, status: 'duplicate' })
      continue
    }
    const account = authoritative.account
    const revision = snapshot.revision + 1
    let marks = [...snapshot.marks]
    let tombstones = [...snapshot.tombstones]
    let access = [...snapshot.access]
    if (command.type === 'mark') {
      const key = { account, scope: command.scope, window: command.window }
      const id = timedMarkKeyId(key)
      const previous = marks.find((m) => timedMarkKeyId(m.key) === id)
      const clear = tombstones.find((t) => timedMarkKeyId(t.key) === id)
      if (clear && command.baseRevision < clear.revision) {
        reject('cleared')
        continue
      }
      if (previous && previous.mergeLaw !== command.mergeLaw) {
        reject('merge-law-conflict')
        continue
      }
      const entries = mergeTimedMarkEntries(
        command.mergeLaw,
        [
          ...(previous?.entries ?? []),
          {
            until: command.until,
            evidenceAt: command.evidenceAt,
            baseRevision: command.baseRevision,
            committedRevision: revision,
            ...(command.cause === 'rate-limit' ||
            command.cause === 'payment-balance'
              ? { cause: command.cause }
              : {}),
          },
        ],
        context.now,
        clear?.revision,
      )
      marks = marks.filter((m) => timedMarkKeyId(m.key) !== id)
      if (entries.length)
        marks.push({ key, mergeLaw: command.mergeLaw, entries })
    } else if (command.type === 'clear') {
      const keys = command.keys
        .map((key) => ({ ...key, account }))
        .filter(
          (key) =>
            command.cause === undefined ||
            !marks.some(
              (mark) =>
                timedMarkKeyId(mark.key) === timedMarkKeyId(key) &&
                mark.entries.some((entry) => entry.cause !== command.cause),
            ),
        )
      const ids = new Set(keys.map(timedMarkKeyId))
      const evidenceAt = command.evidenceAt
      if (
        evidenceAt !== undefined &&
        marks.some(
          (m) =>
            ids.has(timedMarkKeyId(m.key)) &&
            m.entries.some((e) => e.evidenceAt > evidenceAt),
        )
      ) {
        reject('newer-evidence')
        continue
      }
      marks = marks.filter((m) => !ids.has(timedMarkKeyId(m.key)))
      tombstones = tombstones.filter((t) => !ids.has(timedMarkKeyId(t.key)))
      // A clear enumerates covered keys, not all scopes on the account.
      for (const key of new Map(
        keys.map((k) => [timedMarkKeyId(k), k]),
      ).values()) {
        tombstones.push({ key, revision })
      }
    } else {
      const incoming: NamespaceAccess<T> = {
        account,
        state: command.state,
        eligibilityStateUpdatedAt: command.eligibilityStateUpdatedAt,
        committedRevision: revision,
      }
      const previous = access.find((a) => sameAccount(a.account, account))
      access = access.filter((a) => !sameAccount(a.account, account))
      access.push(previous ? mergeAccessState(previous, incoming) : incoming)
    }
    const op = {
      producerId: command.producerId,
      operationId: command.operationId,
      revision,
    }
    snapshot = pruneLimitsNamespace(
      {
        ...snapshot,
        revision,
        marks,
        tombstones,
        access,
        operationIds: [...snapshot.operationIds, op],
      },
      context.now,
    )
    outcomes.push({ ...op, status: 'committed' })
  }
  return { snapshot, outcomes }
}
