import { createLogger } from '../logger/index.js'
import { isQuotaObservation, type QuotaObservation } from '../quota/index.js'
import { type QuotaField, quotaFields } from '../quota/pending.js'
import {
  type Attribution,
  assertQuotaEpoch,
  assertQuotaRow,
  mergedQuota,
} from './attribution.js'
import { PoolOperationError } from './errors.js'
import { toFailure, withTransaction } from './mutate.js'
import { LockStack } from './refresh-lock.js'
import { readRow, refusal, type StoreRuntime } from './runtime.js'
import { entryIn, type PoolRow } from './schema.js'

interface Publication {
  id: string
  attribution: Attribution
  observation: QuotaObservation
}
type Field = QuotaField<Publication>
const COALESCE_MS = 100

// Like the roster writer, keep fields in the mailbox until their exact snapshot
// commits. A newer enqueue during lock acquisition must survive an older flush.
export class PoolQuotaWriter {
  private readonly pending = new Map<string, Field>()
  private readonly warned = new Set<string>()
  private readonly wake = new Set<() => void>()
  private readonly logger
  private timer?: ReturnType<typeof setTimeout>
  private running?: Promise<void>
  private closing?: Promise<void>
  private closed = false
  private stopped = false
  private order = 0
  private failures = 0

  constructor(
    private readonly rt: StoreRuntime,
    private readonly timeoutMs = 1_000,
  ) {
    this.logger = rt.ctx.logger ?? createLogger('store')
  }

  async record(
    id: string,
    attribution: Attribution,
    observation: unknown,
  ): Promise<void> {
    try {
      this.assertOpen(id)
      assertQuotaEpoch(id, attribution)
      // Snapshot before the first await: callers may reuse their headers object.
      const publication = structuredClone({ id, attribution, observation })
      const { row, result } = await readRow(this.rt, 'pull', id)
      assertQuotaRow(id, publication.attribution, row)
      mergedQuota(
        this.rt.ctx,
        id,
        this.overlayRow({ ...row, quota: entryIn(result.config, id)?.quota })
          .quota,
        publication.observation,
      )
      if (!isQuotaObservation(publication.observation))
        throw refusal(
          'pull',
          id,
          'invalid-quota',
          'coalescing requires a QuotaObservation',
        )
      this.assertOpen(id)
      const witness = JSON.stringify([
        id,
        publication.attribution.credentialEpoch,
        publication.attribution.identity,
      ])
      for (const [key, field] of quotaFields(
        publication as Publication,
        witness,
      )) {
        const previous = this.pending.get(key)
        if (!previous || field.at >= previous.at) {
          field.order = ++this.order
          // Coverage must retain a preceding unflushed reading to retire it,
          // rather than turning a previously observed window into an absence.
          if (field.publication.observation.coverage)
            field.priorReading = previous?.publication.observation.readings
              ? previous.publication
              : previous?.priorReading
          this.pending.set(key, field)
        }
      }
      this.schedule(COALESCE_MS)
    } catch (error) {
      throw toFailure(error, 'pull', id, { writes: 0 })
    }
  }

  private assertOpen(id: string): void {
    if (this.closed)
      throw refusal('pull', id, 'invalid-input', 'pool quota writer is closed')
  }

  private ordered(fields = this.pending): Field[] {
    return [...fields.values()].sort((a, b) => a.order - b.order)
  }

  private apply(stored: unknown, field: Field): unknown {
    const { ctx } = this.rt
    if (field.priorReading)
      stored = mergedQuota(
        ctx,
        field.publication.id,
        stored,
        field.priorReading.observation,
      )
    return mergedQuota(
      ctx,
      field.publication.id,
      stored,
      field.publication.observation,
    )
  }

  private overlayRow(row: PoolRow): PoolRow {
    let next = row
    for (const field of this.ordered()) {
      if (field.publication.id !== row.id) continue
      try {
        assertQuotaRow(row.id, field.publication.attribution, row)
      } catch {
        continue
      }
      next = {
        ...next,
        quota: this.apply(next.quota, field),
        needsFirstReading: false,
      }
    }
    return next
  }

  overlay(rows: PoolRow[]): PoolRow[] {
    return rows.map((row) => this.overlayRow(row))
  }

  private schedule(delay: number): void {
    if (this.running || this.timer || !this.pending.size || this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, delay)
    if (!this.closed) this.timer.unref?.()
  }

  private flush(): void {
    if (this.running || this.stopped || !this.pending.size) return
    const batch = new Map(this.pending)
    // Short lock attempts allow retries to pick up fresh pending fields and
    // bound shutdown even when the normal store acquisition budget is long.
    const ctx = {
      ...this.rt.ctx,
      storeLocks: this.rt.ctx.storeLocks.map((spec) => ({
        ...spec,
        timeoutMs: Math.min(
          spec.timeoutMs ?? this.rt.ctx.lockDefaults.timeoutMs,
          100,
        ),
      })),
    }
    const locks = new LockStack(ctx.lockDefaults, ctx.lockEnv)
    this.running = (async () => {
      try {
        await withTransaction(
          ctx,
          locks,
          { writes: 0 },
          { operation: 'pull', rowId: undefined },
          async (tx) => {
            if (this.stopped) return
            let changed = false
            for (const field of this.ordered(batch)) {
              const { id, attribution } = field.publication
              try {
                tx.assertNotStaged(id)
                assertQuotaRow(id, attribution, tx.row(id))
              } catch (error) {
                if (!(error instanceof PoolOperationError)) throw error
                const witness = JSON.stringify([
                  id,
                  attribution.credentialEpoch,
                  attribution.identity,
                ])
                if (!this.warned.has(witness)) {
                  this.warned.add(witness)
                  this.warn(
                    'pool quota publication dropped; account binding changed',
                    { id, kind: error.kind },
                  )
                }
                continue
              }
              const entry = tx.entry(id)
              if (!entry) continue
              tx.setEntry(id, {
                ...entry,
                quota: this.apply(entry.quota, field),
                needsFirstReading: false,
              })
              changed = true
            }
            if (changed && !this.stopped) await tx.commitConfig()
          },
          { completeTorn: false },
        )
        for (const [key, field] of batch)
          if (this.pending.get(key) === field) this.pending.delete(key)
        this.failures = 0
      } catch (error) {
        if (!this.stopped && this.failures++ === 0)
          this.warn('pool quota publication delayed; retrying', {
            error: error instanceof Error ? error.message : String(error),
          })
        // Retain the mailbox on failure, including fresher fields queued meanwhile.
      } finally {
        await locks.releaseAll()
        this.running = undefined
        for (const wake of this.wake) wake()
        const delay = this.failures
          ? Math.min(5_000, 100 * 2 ** Math.min(this.failures, 6)) *
            (0.5 + Math.random())
          : COALESCE_MS
        this.schedule(delay)
      }
    })()
  }

  private warn(message: string, data?: unknown): void {
    try {
      this.logger.warn(message, data)
    } catch {
      /* Logging cannot stop publication. */
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.closing = this.drain()
    return this.closing
  }

  private async drain(): Promise<void> {
    clearTimeout(this.timer)
    this.timer = undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    let wake!: () => void
    const drained = new Promise<void>((done) => {
      wake = () => {
        if (!this.pending.size) done()
      }
      this.wake.add(wake)
      wake()
    })
    try {
      this.flush()
      await Promise.race([
        drained,
        new Promise<void>((done) => {
          deadline = setTimeout(done, Math.max(0, this.timeoutMs))
        }),
      ])
    } finally {
      this.stopped = true
      clearTimeout(deadline)
      clearTimeout(this.timer)
      this.wake.delete(wake)
      if (this.pending.size)
        this.warn('pool quota drain timed out; pending readings left', {
          accounts: new Set(
            [...this.pending.values()].map((field) => field.publication.id),
          ).size,
          fields: this.pending.size,
        })
      this.pending.clear()
    }
  }
}
