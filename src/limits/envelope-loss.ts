import { AsyncResource } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createLogger } from '../logger/index.js'
import { mergeAccessState } from './merge-laws.js'
import {
  createLimitsNamespace,
  type LimitsNamespace,
  pruneLimitsNamespace,
  timedMarkKeyId,
} from './namespace.js'

const detached = new AsyncResource('common-auth-limits-recovery')
const logger = createLogger('limits')

/** Readers never join the write lock; notify them after a detached repair lands. */
export class EnvelopeRepair {
  private running?: Promise<void>
  private readonly listeners = new Set<() => void>()

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  schedule(commit: () => Promise<unknown>): void {
    if (this.running) return
    this.running = detached.runInAsyncScope(async () => {
      // Defer invocation until the single-flight promise is installed, and keep
      // the write outside any caller context that holds the store lock.
      await Promise.resolve()
      let succeeded = false
      try {
        await commit()
        succeeded = true
      } catch (error) {
        try {
          logger.warn(
            'limits envelope recovery failed; agreement remains degraded',
            {
              error: error instanceof Error ? error.message : String(error),
            },
          )
        } catch {
          // A failed diagnostic must not turn detached bookkeeping into a rejection.
        }
      } finally {
        this.running = undefined
        if (succeeded) {
          for (const listener of this.listeners) {
            try {
              listener()
            } catch {
              // Observers cannot change the result of a durable repair.
            }
          }
        }
      }
    })
  }
}

/** Retain only durable observations; a new, empty namespace is not lost state. */
export class EnvelopeHistory {
  private seen?: LimitsNamespace
  private missingGeneration?: string
  private incorporated?: LimitsNamespace

  remember(snapshot: LimitsNamespace, previous?: LimitsNamespace): void {
    if (this.seen && this.seen.revision > snapshot.revision) return
    this.seen = structuredClone(snapshot)
    this.missingGeneration = undefined
    if (previous) this.incorporated = structuredClone(previous)
  }

  private retained(previous?: LimitsNamespace): LimitsNamespace[] {
    // A notification reload still carries the pre-repair registry snapshot.
    // Do not mistake that already-merged generation for another loss.
    const retainedPrevious = isDeepStrictEqual(previous, this.incorporated)
      ? undefined
      : previous
    return [this.seen, retainedPrevious].filter(
      (snapshot): snapshot is LimitsNamespace =>
        snapshot !== undefined &&
        (snapshot === this.seen || snapshot.revision > 0),
    )
  }

  lost(
    present: LimitsNamespace | undefined,
    previous?: LimitsNamespace,
  ): boolean {
    return this.retained(previous).some(
      (seen) =>
        !present ||
        seen.generation !== present.generation ||
        present.revision < seen.revision ||
        seen.tombstones.some(
          (clear) =>
            clear.revision > present.lowWatermark &&
            !present.tombstones.some(
              (current) =>
                timedMarkKeyId(current.key) === timedMarkKeyId(clear.key) &&
                current.revision >= clear.revision,
            ),
        ),
    )
  }

  /** Preview a restrictive merge, or apply it against the envelope under the write lock. */
  recover(
    present: LimitsNamespace | undefined,
    previous: LimitsNamespace | undefined,
    namespace: string,
    now: number,
  ): LimitsNamespace {
    if (!present) this.missingGeneration ??= randomUUID()
    const current =
      present ??
      createLimitsNamespace(namespace, this.missingGeneration ?? randomUUID())
    const sources = [...this.retained(previous), current]
    const marks = new Map<string, LimitsNamespace['marks'][number]>()
    const tombstones = new Map<string, LimitsNamespace['tombstones'][number]>()
    const operations = new Map<
      string,
      LimitsNamespace['operationIds'][number]
    >()
    const access = new Map<string, LimitsNamespace['access'][number]>()
    let highest = 0
    for (const source of sources) {
      highest = Math.max(highest, source.revision, source.lowWatermark)
      for (const mark of source.marks) {
        const id = timedMarkKeyId(mark.key)
        const old = marks.get(id)
        if (old && old.mergeLaw !== mark.mergeLaw)
          throw new Error('limits-recovery-merge-law-conflict')
        marks.set(id, {
          ...mark,
          entries: [...(old?.entries ?? []), ...mark.entries],
        })
        for (const entry of mark.entries)
          highest = Math.max(
            highest,
            entry.baseRevision,
            entry.committedRevision,
          )
      }
      for (const clear of source.tombstones) {
        const id = timedMarkKeyId(clear.key)
        const old = tombstones.get(id)
        if (!old || old.revision < clear.revision) tombstones.set(id, clear)
        highest = Math.max(highest, clear.revision)
      }
      for (const op of source.operationIds) {
        const id = JSON.stringify([op.producerId, op.operationId])
        const old = operations.get(id)
        if (!old || old.revision < op.revision) operations.set(id, op)
        highest = Math.max(highest, op.revision)
      }
      for (const state of source.access) {
        const { namespace, accountId, incarnation } = state.account
        const id = JSON.stringify([namespace, accountId, incarnation])
        const old = access.get(id)
        access.set(id, old ? mergeAccessState(old, state) : state)
        highest = Math.max(highest, state.committedRevision)
      }
    }
    const revision = highest + 1
    if (!Number.isSafeInteger(revision))
      throw new Error('limits-revision-exhausted')
    // The barrier rejects observations predating even a clear this process never
    // saw. Retain entry base revisions so a later restored clear can remove them.
    return pruneLimitsNamespace(
      {
        ...current,
        revision,
        lowWatermark: revision,
        marks: [...marks.values()],
        tombstones: [...tombstones.values()],
        operationIds: [...operations.values()],
        access: [...access.values()],
      },
      now,
    )
  }
}
