import { randomUUID } from 'node:crypto'
import { mergeAccessState } from './merge-laws.js'
import {
  createLimitsNamespace,
  type LimitsNamespace,
  pruneLimitsNamespace,
  timedMarkKeyId,
} from './namespace.js'

/** Retain only durable observations; a new, empty namespace is not lost state. */
export class EnvelopeHistory {
  private seen?: LimitsNamespace

  remember(snapshot: LimitsNamespace): void {
    if (this.seen && this.seen.revision > snapshot.revision) return
    this.seen = structuredClone(snapshot)
  }

  private retained(previous?: LimitsNamespace): LimitsNamespace[] {
    return [this.seen, previous].filter(
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

  /** Called under the adapter's write lock, against the envelope present there. */
  recover(
    present: LimitsNamespace | undefined,
    previous: LimitsNamespace | undefined,
    namespace: string,
    now: number,
  ): LimitsNamespace {
    const current = present ?? createLimitsNamespace(namespace, randomUUID())
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
