import { resolve } from 'node:path'
import type {
  ClaustrumClientOptions,
  ClaustrumConnector,
} from '@cortexkit/claustrum-client'
import { storeIdentity } from '@cortexkit/claustrum-client'
// A static import: claustrum-client already loads subc-client whenever
// /claustrum is imported, so loading it lazily saves nothing, and a dynamic
// import makes bundlers emit a separate chunk that a running host loses when
// its dist folder is rebuilt underneath it.
import { SubcClient } from '@cortexkit/subc-client'
import { classifyVaultFailure } from './availability.js'
import {
  ChangeNoticeReader,
  CoalescedRead,
  RESUBSCRIBE_BACKOFF_MS,
  WATCH_RETRY_MS,
  type WatchMode,
} from './watch.js'

/** Insula's window fields are open: plugins choose which limits they understand. */
export interface InsulaUsageWindow {
  usedPercent: number
  rawUsedPercent?: number
  resetsAt?: string
  windowMinutes?: number
  windowKind?: string
  [field: string]: unknown
}

export interface InsulaUsageEntry {
  provider: string
  account?: string
  fetchedAt?: string
  source?: string
  stale?: unknown
  errorClass?: unknown
  usage?: {
    primary?: InsulaUsageWindow
    secondary?: InsulaUsageWindow
    tertiary?: InsulaUsageWindow
    extraRateWindows?: Array<{
      id?: string
      title?: string
      window?: InsulaUsageWindow
    }>
    [field: string]: unknown
  }
  [field: string]: unknown
}

export interface InsulaQuotaContext {
  /** Milliseconds since the epoch, parsed from the producer's fetchedAt. */
  fetchedAt: number
  source?: string
}

export interface InsulaQuotaOptions<Q> {
  provider: 'codex' | 'claude' | 'antigravity'
  /**
   * Set every converted window's reading time to context.fetchedAt, not poll
   * time. Return undefined for entries the plugin cannot use. Antigravity can
   * receive its own sidebar reading back from insula: accept it only from the
   * vault or when fetchedAt is newer than the plugin's last reading.
   */
  normalize: (
    entry: InsulaUsageEntry,
    context: InsulaQuotaContext,
  ) => Q | undefined
}

/**
 * A held-open `usage.watch` stream. `closed` resolves when insula ends the
 * stream (STREAM_END at shutdown, or a reply that ends it) or after `stop()`,
 * and rejects with insula's refusal (an error with a `code`, such as
 * `unknown_method` from an insula that predates the method, or
 * `usage_watch_limit` when 64 watches are already open) or with the
 * transport failure.
 */
export interface InsulaUsageWatch {
  stop(): void
  readonly closed: Promise<void>
}

/** Optional transport for custom scoped clients; getUsage must not retry refusals. */
export interface InsulaUsageTransport {
  connectionFile: string
  getUsage(): Promise<unknown>
  /**
   * Open a `usage.watch` stream, passing each notice's raw JSON body to
   * `onNotice`. Optional: a transport without it is polled as before.
   */
  watchUsage?(onNotice: (body: Uint8Array) => void): InsulaUsageWatch
}

/** Constructing this transport opens no connection; getUsage opens one per call. */
export function insulaUsageTransport(
  options: ClaustrumClientOptions & { connectionFile: string },
): InsulaUsageTransport {
  const identity =
    options.identity ??
    storeIdentity(
      options.projectRoot ?? process.cwd(),
      options.storagePath ?? process.cwd(),
    )
  return {
    connectionFile: options.connectionFile,
    async getUsage() {
      let client: Awaited<ReturnType<ClaustrumConnector>> | undefined
      let expired = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('insula usage timeout')),
          3_000,
        )
        timer.unref?.()
      })
      const request = (async () => {
        client = options.connector
          ? await options.connector({
              connectionFile: options.connectionFile,
              handshakeTimeoutMs: Math.min(
                options.handshakeTimeoutMs ?? 3_000,
                3_000,
              ),
            })
          : await SubcClient.connect({
              connectionFile: options.connectionFile,
              handshakeTimeoutMs: Math.min(
                options.handshakeTimeoutMs ?? 3_000,
                3_000,
              ),
            })
        // A slow connector may resolve after the whole-call deadline. It still
        // owns a socket, which must not survive or open a route after fallback.
        if (expired) {
          client.close()
          throw new Error('insula usage timeout')
        }
        // Managed call() retries warming routes. A single routeOpen/request
        // instead lets the plugin fall back as soon as the daemon refuses.
        const route = await client.routeOpen(
          { kind: 'management_surface', module_id: 'insula' },
          identity,
        )
        return await client.request(route, { method: 'usage.get', params: {} })
      })()
      try {
        return await Promise.race([request, timeout])
      } finally {
        expired = true
        clearTimeout(timer)
        client?.close()
      }
    },
    watchUsage(onNotice) {
      // The watch holds its own connection for as long as it is open: each
      // usage.get above opens and closes a short-lived one, and the scoped
      // credential connection is never shared with insula. The method name
      // alone makes the request a watch; subc-client does not yet set the
      // SUBSCRIPTION flag, and insula does not require it.
      let client: Awaited<ReturnType<ClaustrumConnector>> | undefined
      let subscription: ReturnType<SubcClient['subscribe']> | undefined
      let stopped = false
      const closed = (async () => {
        let deadline: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(
            // Coded as a timeout so the source treats it as unreachable.
            () =>
              reject(
                Object.assign(new Error('insula watch timeout'), {
                  code: 'timeout',
                }),
              ),
            3_000,
          )
          deadline.unref?.()
        })
        const open = (async () => {
          const handshakeTimeoutMs = Math.min(
            options.handshakeTimeoutMs ?? 3_000,
            3_000,
          )
          const connected = options.connector
            ? await options.connector({
                connectionFile: options.connectionFile,
                handshakeTimeoutMs,
              })
            : await SubcClient.connect({
                connectionFile: options.connectionFile,
                handshakeTimeoutMs,
              })
          client = connected
          // A connection that arrives after stop() or after the open deadline
          // must not keep a route or socket alive.
          if (stopped) {
            connected.close()
            return
          }
          const route = await connected.routeOpen(
            { kind: 'management_surface', module_id: 'insula' },
            identity,
          )
          if (stopped) {
            connected.close()
            return
          }
          subscription = connected.subscribe(
            route,
            { method: 'usage.watch' },
            onNotice,
          )
        })()
        try {
          await Promise.race([open, timeout])
        } catch (error) {
          stopped = true
          throw error
        } finally {
          clearTimeout(deadline)
        }
        if (subscription) await subscription.closed
      })().finally(() => {
        stopped = true
        client?.close()
      })
      return {
        stop() {
          if (stopped) return
          stopped = true
          subscription?.unsubscribe()
          client?.close()
        },
        closed,
      }
    },
  }
}

const MINUTE = 60_000
const MAX_AGE = 4 * MINUTE
const sources = new Map<string, { source: InsulaQuotaSource; refs: number }>()
// Keep only the minute budget after the last owner closes, so project churn
// cannot reset the bound. Expired budgets are pruned on the next tick.
const attempts = new Map<string, number>()

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One `usage.watch` notice. Only seq 1 omits `provider`. */
interface UsageNotice {
  readonly kind: string
  readonly epoch: string
  readonly seq: number
  readonly provider?: string
}

function decodeUsageNotice(body: Uint8Array): UsageNotice | undefined {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
  } catch {
    return undefined
  }
  if (
    !record(value) ||
    typeof value.kind !== 'string' ||
    typeof value.epoch !== 'string' ||
    value.epoch.length === 0 ||
    typeof value.seq !== 'number' ||
    !Number.isSafeInteger(value.seq) ||
    value.seq < 1 ||
    (value.provider !== undefined && typeof value.provider !== 'string')
  )
    return undefined
  return {
    kind: value.kind,
    epoch: value.epoch,
    seq: value.seq,
    ...(typeof value.provider === 'string' && { provider: value.provider }),
  }
}

function refusalCode(error: unknown): string | undefined {
  return error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined
}

export interface InsulaWatchOptions {
  /**
   * The provider this watcher reads. A notice that names only other
   * providers then needs no read; unset means every notice does.
   */
  provider?: string
  /** Timers for the re-subscribe and retry waits; the host's own in tests. */
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
}

interface OpenUsageWatch {
  handle?: InsulaUsageWatch
  notices: number
}

export class InsulaQuotaSource {
  #entries: InsulaUsageEntry[] = []
  /** Every usage.get, polled or watch-driven, shares this one slot. */
  readonly #reads = new CoalescedRead(
    async () => {
      try {
        const reply = await this.transport.getUsage()
        if (
          !record(reply) ||
          !Array.isArray(reply.result) ||
          reply.error !== undefined
        )
          throw new Error('unavailable insula usage')
        // Each response is a snapshot, not a delta. Missing accounts fall back;
        // neither pending nor the entry count asserts provider completeness.
        this.#entries = reply.result.filter(
          (entry): entry is InsulaUsageEntry =>
            record(entry) && typeof entry.provider === 'string',
        )
      } catch {
        // Refusal is absence, even if the previous reading was still young.
        this.#entries = []
      }
    },
    () => {},
  )
  readonly #reader = new ChangeNoticeReader()
  #mode: WatchMode = 'polling'
  #watchers = 0
  /** Watchers that read every provider, and the providers the others read. */
  #everyProvider = 0
  readonly #providers = new Map<string, number>()
  #watch?: OpenUsageWatch
  #timer?: ReturnType<typeof setTimeout>
  #timers: Pick<InsulaWatchOptions, 'setTimeoutImpl' | 'clearTimeoutImpl'> = {}
  /** Closes in a row of watches that had been accepted; sets the backoff. */
  #closes = 0

  constructor(
    private readonly transport: InsulaUsageTransport,
    private readonly key: string,
  ) {}

  /**
   * The background poll: at most one usage.get per minute per daemon and
   * enrollment token. While a watch is open it reads nothing: notices bring
   * every change, and an account insula stays quiet about ages past the
   * freshness gate in `current()`, which sends it back to the plugin's own
   * provider poll.
   */
  refresh(now: number): Promise<void> {
    if (this.#reads.running) return this.#reads.running
    if (this.#mode === 'watching') return Promise.resolve()
    for (const [key, time] of attempts) {
      if (now - time >= MINUTE) attempts.delete(key)
    }
    const lastAttempt = attempts.get(this.key)
    if (lastAttempt !== undefined && now - lastAttempt < MINUTE)
      return Promise.resolve()
    // Reserve the minute before I/O, so concurrent projects cannot each poll.
    attempts.set(this.key, now)
    return this.#reads.request()
  }

  /** How this source currently learns about usage changes, for logs. */
  watchMode(): WatchMode {
    return this.#mode
  }

  /**
   * Hold a `usage.watch` open while any watcher wants it, and re-read
   * usage.get when a notice says something changed. Watchers of one source
   * share one watch, since insula admits only 64 per process. Returns the
   * release; the last release closes the watch.
   */
  watch(options: InsulaWatchOptions = {}): () => void {
    this.#watchers++
    const provider = options.provider
    if (provider === undefined) this.#everyProvider++
    else this.#providers.set(provider, (this.#providers.get(provider) ?? 0) + 1)
    if (this.#watchers === 1) {
      this.#timers = options
      this.#open()
    }
    let released = false
    return () => {
      if (released) return
      released = true
      if (provider === undefined) this.#everyProvider--
      else {
        const left = (this.#providers.get(provider) ?? 1) - 1
        if (left > 0) this.#providers.set(provider, left)
        else this.#providers.delete(provider)
      }
      if (--this.#watchers === 0) this.#stopWatch()
    }
  }

  #stopWatch(): void {
    if (this.#timer)
      (this.#timers.clearTimeoutImpl ?? clearTimeout)(this.#timer)
    this.#timer = undefined
    const watch = this.#watch
    this.#watch = undefined
    watch?.handle?.stop()
    this.#mode = 'polling'
  }

  #later(delay: number): void {
    this.#timer = (this.#timers.setTimeoutImpl ?? setTimeout)(() => {
      this.#timer = undefined
      if (this.#watchers > 0 && !this.#watch) this.#open()
    }, delay)
    this.#timer.unref?.()
  }

  #open(): void {
    const watchUsage = this.transport.watchUsage
    if (!watchUsage) {
      // A custom transport that cannot watch: poll exactly as before.
      this.#mode = 'fallback'
      return
    }
    this.#mode = 'polling'
    this.#reader.restart()
    const watch: OpenUsageWatch = { notices: 0 }
    this.#watch = watch
    let handle: InsulaUsageWatch
    try {
      handle = watchUsage.call(this.transport, (body) =>
        this.#notice(watch, body),
      )
    } catch (error) {
      this.#closed(watch, error)
      return
    }
    watch.handle = handle
    handle.closed.then(
      () => this.#closed(watch, undefined),
      (error: unknown) => this.#closed(watch, error),
    )
  }

  #notice(watch: OpenUsageWatch, body: Uint8Array): void {
    // Frames already in transport can arrive after a local stop.
    if (this.#watch !== watch) return
    watch.notices++
    if (watch.notices === 1) this.#mode = 'watching'
    // A second notice means the watch stayed up past its acceptance.
    if (watch.notices === 2) this.#closes = 0
    const notice = decodeUsageNotice(body)
    // An unreadable notice may hide any change: treat it as a break, and
    // make the next notice read as one too.
    if (!notice) this.#reader.restart()
    const continuous = notice ? this.#reader.continuous(notice) : false
    // The first notice of every watch names no provider, so it always reads:
    // nothing was watched before it. After a gap or a new epoch notices were
    // lost, so read even when this notice names another provider.
    if (
      !continuous ||
      notice?.provider === undefined ||
      this.#everyProvider > 0 ||
      this.#providers.has(notice.provider)
    )
      void this.#reads.request()
  }

  #closed(watch: OpenUsageWatch, error: unknown): void {
    if (this.#watch !== watch) return
    this.#watch = undefined
    const code = refusalCode(error)
    if (code === 'unknown_method' || code === 'usage_watch_limit') {
      // An insula that predates usage.watch, or one already holding 64
      // watches: poll exactly as before until every watcher has released.
      this.#mode = 'fallback'
      return
    }
    if (watch.notices > 0) {
      // An accepted watch that closed (insula shut down, or the connection
      // dropped) gets one new watch, whose first notice reads usage.get.
      const delay = Math.min(
        RESUBSCRIBE_BACKOFF_MS * 2 ** Math.min(this.#closes, 16),
        WATCH_RETRY_MS,
      )
      this.#closes++
      this.#mode = 'polling'
      this.#later(delay)
      return
    }
    // Closed before any notice, so never accepted: read once to learn
    // whether insula answers at all, then poll as before. A refusal insula
    // answered stands until every watcher has released. A close it did not
    // explain (a
    // dropped connection, a timeout, a stream ended at once while insula
    // shuts down) earns one new watch much later.
    this.#mode = 'fallback'
    void this.#reads.request()
    if (error === undefined || classifyVaultFailure(error) === 'unreachable')
      this.#later(WATCH_RETRY_MS)
  }

  current(
    provider: string,
    accountId: string,
    now: number,
  ): { entry: InsulaUsageEntry; context: InsulaQuotaContext } | undefined {
    for (const entry of this.#entries) {
      if (
        entry.provider !== provider ||
        typeof entry.account !== 'string' ||
        entry.account.trim() !== accountId
      )
        continue
      if (
        entry.stale !== undefined ||
        entry.errorClass !== undefined ||
        !record(entry.usage)
      )
        continue
      const fetchedAt =
        typeof entry.fetchedAt === 'string'
          ? Date.parse(entry.fetchedAt)
          : Number.NaN
      if (!Number.isFinite(fetchedAt) || now - fetchedAt >= MAX_AGE) continue
      return {
        entry,
        context: {
          fetchedAt,
          ...(typeof entry.source === 'string' && { source: entry.source }),
        },
      }
    }
    return undefined
  }
}

export function acquireInsulaQuotaSource(
  transport: InsulaUsageTransport,
  tokenPath: string,
): { source: InsulaQuotaSource; release(): void } {
  const key = JSON.stringify([
    resolve(transport.connectionFile),
    resolve(tokenPath),
  ])
  let shared = sources.get(key)
  if (!shared) {
    shared = { source: new InsulaQuotaSource(transport, key), refs: 0 }
    sources.set(key, shared)
  }
  shared.refs++
  let released = false
  return {
    source: shared.source,
    release() {
      if (released) return
      released = true
      if (--shared.refs === 0) sources.delete(key)
    },
  }
}
