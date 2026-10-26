import { resolve } from 'node:path'
import { createLogger } from '../logger/index.js'
import {
  QUOTA_COMMIT_INTERVAL_MS,
  type QuotaCommitTimer,
  quotaCommitTimer,
} from '../quota/commit-interval.js'
import { isQuotaObservation, type QuotaObservation } from '../quota/index.js'
import { type QuotaField, quotaFields } from '../quota/pending.js'
import {
  applyVaultQuota,
  mutateVaultRoster,
  type QuotaReceipt,
  type VaultRosterFile,
} from './roster.js'

export type VaultQuotaPublication = {
  routeId: string
  accountIdentity?: string
  receipt?: QuotaReceipt
  observation: QuotaObservation
}

type Field = QuotaField<VaultQuotaPublication>
type Pending = Map<string, Map<string, Field>>
type Listener = (publication: VaultQuotaPublication) => void
interface Writer {
  path: string
  pending: Pending
  listeners: Set<Listener>
  wake: Set<() => void>
  abort: AbortController
  running?: Promise<void>
  clock: QuotaCommitTimer
  timer?: ReturnType<QuotaCommitTimer['schedule']>
  committedAt?: number
  failures: number
  draining: boolean
  order: number
}

// Every consumer of the same file shares one mailbox and one lock waiter.
const writers = new Map<string, Writer>()
const logger = createLogger('claustrum')
const COALESCE_MS = 100

function writerFor(path: string, clock = quotaCommitTimer): Writer {
  const key = resolve(path)
  let writer = writers.get(key)
  if (!writer) {
    writer = {
      path: key,
      pending: new Map(),
      listeners: new Set(),
      wake: new Set(),
      abort: new AbortController(),
      clock,
      failures: 0,
      draining: false,
      order: 0,
    }
    writers.set(key, writer)
  }
  return writer
}

/** Retain the shared writer; the last consumer's close drains it. */
export function retainVaultQuotaWriter(
  path: string,
  listener: Listener,
  clock?: QuotaCommitTimer,
): () => Promise<void> {
  const writer = writerFor(path, clock)
  writer.listeners.add(listener)
  let released: Promise<void> | undefined
  return () =>
    (released ??= (() => {
      writer.listeners.delete(listener)
      return writer.listeners.size ? Promise.resolve() : drainVaultQuota(path)
    })())
}

// Each field retains the receipt fence as well as its independent timestamp.
function fields(publication: VaultQuotaPublication): Map<string, Field> {
  return quotaFields(
    publication,
    JSON.stringify([
      publication.routeId,
      publication.receipt?.credentialId,
      publication.receipt?.accountIdentitySource,
      publication.receipt?.expectedAccountIdentity,
    ]),
  )
}

/** Enqueue without filesystem work; each quota field retains its own receipt fence. */
export function enqueueVaultQuota(
  path: string,
  publication: VaultQuotaPublication,
): Promise<boolean> {
  if (!isQuotaObservation(publication.observation))
    return Promise.resolve(false)
  const writer = writerFor(path)
  const account = JSON.stringify([
    publication.accountIdentity ?? null,
    publication.accountIdentity === undefined ? publication.routeId : null,
  ])
  const pending = writer.pending.get(account) ?? new Map<string, Field>()
  for (const [key, field] of fields(publication)) {
    const previous = pending.get(key)
    if (!previous || field.at >= previous.at) {
      field.order = ++writer.order
      // A covered disappearance after an unflushed reading is a retirement,
      // not an absence. Retain just enough history to preserve that distinction.
      if (field.publication.observation.coverage)
        field.priorReading = previous?.publication.observation.readings
          ? previous.publication
          : previous?.priorReading
      pending.set(key, field)
    }
  }
  if (pending.size) writer.pending.set(account, pending)
  for (const listener of writer.listeners) listener(publication)
  schedule(writer, COALESCE_MS)
  return Promise.resolve(true)
}

function orderedFields(pending: Pending): Field[] {
  // Equal observation times are last-enqueue-wins even across different
  // credentials or account-only readings. Map insertion order cannot prove it.
  return [...pending.values()]
    .flatMap((account) => [...account.values()])
    .sort((a, b) => a.order - b.order)
}

/** Overlay uncommitted observations when a consumer reloads the durable roster. */
export function pendingVaultQuota(
  path: string,
  roster: VaultRosterFile | undefined,
): VaultRosterFile | undefined {
  const writer = writers.get(resolve(path))
  if (writer) {
    for (const field of orderedFields(writer.pending)) {
      if (field.priorReading)
        roster = applyVaultQuota(roster, field.priorReading).roster
      roster = applyVaultQuota(roster, field.publication).roster
    }
  }
  return roster
}

/**
 * Whether this process holds quota readings for `path` that no commit of the
 * durable roster has written yet, so a reader of the file alone is not seeing
 * everything this process would publish.
 */
export function hasPendingVaultQuota(path: string): boolean {
  return !!writers.get(resolve(path))?.pending.size
}

function schedule(writer: Writer, delay: number): void {
  if (
    writer.running ||
    writer.timer ||
    !writer.pending.size ||
    writer.abort.signal.aborted
  )
    return
  const remaining = writer.draining
    ? 0
    : (writer.committedAt ?? -Infinity) +
      QUOTA_COMMIT_INTERVAL_MS -
      writer.clock.now()
  writer.timer = writer.clock.schedule(Math.max(delay, remaining), () => {
    writer.timer = undefined
    return flush(writer)
  })
  if (!writer.draining) writer.timer.unref?.()
}

function cancelTimer(writer: Writer): void {
  writer.timer?.cancel()
  writer.timer = undefined
}

function flush(writer: Writer): Promise<void> {
  if (writer.running || writer.abort.signal.aborted)
    return writer.running ?? Promise.resolve()
  const batch = new Map(
    [...writer.pending].map(([account, pending]) => [
      account,
      new Map(pending),
    ]),
  )
  writer.running = (async () => {
    try {
      const committed = await mutateVaultRoster(
        writer.path,
        (current) => {
          let next = current
          for (const field of orderedFields(batch)) {
            if (field.priorReading)
              next = applyVaultQuota(next, field.priorReading).roster
            next = applyVaultQuota(next, field.publication).roster
          }
          const changed = JSON.stringify(next) !== JSON.stringify(current)
          return { ...(changed && { next }), result: changed }
        },
        { signal: writer.abort.signal },
      )
      if (committed) writer.committedAt = writer.clock.now()
      for (const [account, fields] of batch) {
        const pending = writer.pending.get(account)
        for (const [key, field] of fields) {
          // A newer enqueue must survive completion of an older flush.
          if (pending?.get(key) === field) pending.delete(key)
        }
        if (!pending?.size) writer.pending.delete(account)
      }
      writer.failures = 0
    } catch (error) {
      if (!writer.abort.signal.aborted && writer.failures++ === 0) {
        logger.warn('vault quota publication delayed; retrying', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
      // Keep the batch in the mailbox, including any fresher fields enqueued meanwhile.
    } finally {
      writer.running = undefined
      for (const wake of writer.wake) wake()
      const backoff = writer.failures
        ? Math.min(5_000, 100 * 2 ** Math.min(writer.failures, 6)) *
          (0.5 + Math.random())
        : COALESCE_MS
      schedule(writer, backoff)
    }
  })()
  return writer.running
}

/** Wait at most timeoutMs for detached publication; shutdown loss is acceptable. */
export async function drainVaultQuota(
  path: string,
  timeoutMs = 1_000,
): Promise<void> {
  const key = resolve(path)
  const writer = writers.get(key)
  if (!writer) return
  writer.draining = true
  cancelTimer(writer)
  let deadline: ReturnType<typeof setTimeout> | undefined
  let wake: (() => void) | undefined
  const drained = new Promise<void>((done) => {
    wake = () => {
      if (!writer.pending.size || writer.abort.signal.aborted) done()
    }
    writer.wake.add(wake)
    wake()
  })
  try {
    if (writer.pending.size) flush(writer)
    await Promise.race([
      drained,
      new Promise<void>((done) => {
        deadline = setTimeout(done, Math.max(0, timeoutMs))
      }),
    ])
  } finally {
    clearTimeout(deadline)
    if (wake) writer.wake.delete(wake)
    writer.draining = false
    // A still-open consumer owns the mailbox, so another consumer's disposal
    // must not discard its observations or stop its retries.
    if (!writer.listeners.size) {
      writer.abort.abort()
      cancelTimer(writer)
      writer.pending.clear()
      if (writers.get(key) === writer) writers.delete(key)
    }
  }
}
