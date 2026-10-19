// Change watches shared by the vault roster and the insula quota source. Both
// modules push a numbered notice over a route the plugin already holds, so a
// host can stop polling for changes and re-read only when told to. Neither
// stream is a durable history: a notice may be shed, and a watch can end at
// any time, so every rule here falls back to reading (and, failing that, to
// the polling a host did before watches existed), never to nothing.
import type { ClaustrumLogger } from './errors.js'

/**
 * How a host currently learns about changes, for logs and status displays.
 * `watching`: a watch was accepted and is open, so polling is reduced to a
 * slow safety read. `polling`: no watch is open yet (not started, opening, or
 * re-subscribing after a close), so the host polls at its usual interval.
 * `fallback`: the watch is unavailable (an older module or client, a refusal,
 * the watch limit, or repeated failures), so the host polls at its usual
 * interval and may try a watch again later. Never carries secrets.
 */
export type WatchMode = 'watching' | 'polling' | 'fallback'

/**
 * While a vault watch is healthy, the roster is still read this often: the
 * watch carries no history, so a lost notice or a silently dead stream is
 * caught within this period.
 */
export const SAFETY_POLL_MS = 5 * 60_000
/**
 * After a watch fails without being accepted, the host polls and tries one
 * new watch this much later, so a refusing or draining module is never asked
 * in a tight loop.
 */
export const WATCH_RETRY_MS = 5 * 60_000
/**
 * First wait before re-subscribing a watch that closed after it had been
 * accepted. It doubles for each further close in a row, up to WATCH_RETRY_MS.
 */
export const RESUBSCRIBE_BACKOFF_MS = 1_000

/** The fields every change notice carries, from either module. */
export interface ChangeNotice {
  readonly kind: string
  readonly epoch: string
  readonly seq: number
}

/**
 * Tells whether a notice follows the previous one with nothing lost between
 * them. `seq` restarts at 1 for every watch and `epoch` names the sending
 * module's process lifetime. A sequence gap (notices are sheddable), a
 * different epoch (the module restarted) or a notice of an unknown kind all
 * mean changes may have been missed, so the caller must re-read everything.
 */
export class ChangeNoticeReader {
  #epoch?: string
  #seq = 0

  /**
   * Begin a new watch, whose first notice is seq 1 again. The epoch is kept,
   * so a module restart between two watches still reads as a break.
   */
  restart(): void {
    this.#seq = 0
  }

  continuous(notice: ChangeNotice): boolean {
    const continuous =
      notice.kind === 'changed' &&
      notice.seq === this.#seq + 1 &&
      (this.#epoch === undefined || notice.epoch === this.#epoch)
    this.#epoch = notice.epoch
    this.#seq = notice.seq
    return continuous
  }
}

/**
 * Runs `read` with at most one call in flight and at most one more queued
 * behind it, however many requests arrive meanwhile. A request made while a
 * read is running may have arrived after that read took its snapshot, so it
 * earns exactly one more read; any further requests share that one.
 */
export class CoalescedRead {
  readonly #read: () => Promise<void>
  readonly #onError: (error: unknown) => void
  #running?: Promise<void>
  #queued = false

  constructor(read: () => Promise<void>, onError: (error: unknown) => void) {
    this.#read = read
    this.#onError = onError
  }

  /** The read in flight (including its queued follow-up), if any. */
  get running(): Promise<void> | undefined {
    return this.#running
  }

  request(): Promise<void> {
    if (this.#running) {
      this.#queued = true
      return this.#running
    }
    this.#running = (async () => {
      do {
        this.#queued = false
        try {
          await this.#read()
        } catch (error) {
          this.#onError(error)
        }
      } while (this.#queued)
    })().finally(() => {
      this.#running = undefined
    })
    return this.#running
  }
}

/** A vault watch notice: `view` is the same digest `list_scoped` returns. */
export interface ScopedWatchNoticeShape extends ChangeNotice {
  readonly view: string
}

/**
 * How a vault watch ended, as claustrum-client 0.12.0 reports it. `refused`
 * and `not_accepting` both mean the watch closed before its first notice; the
 * client then made one `list_scoped` read to learn why, and `refused` carries
 * that read's refusal.
 */
export type ScopedWatchEnd =
  | { readonly kind: 'refused'; readonly error: unknown }
  | { readonly kind: 'transport_lost'; readonly error: unknown }
  | {
      readonly kind: 'ended' | 'not_accepting' | 'unsupported' | 'stopped'
    }

export interface ScopedWatchHandle {
  stop(): void
  readonly closed: Promise<ScopedWatchEnd>
}

/**
 * The part of a vault client that can watch. claustrum-client added
 * `watchScoped` in 0.12.0; the peer range still admits 0.6.2, so it is
 * optional and detected at run time.
 */
export interface ScopedWatchSource {
  watchScoped?(
    onNotice: (notice: ScopedWatchNoticeShape) => void,
    options?: { enrollmentToken?: string },
  ): ScopedWatchHandle
}

export interface ScopedRosterWatchOptions {
  client: ScopedWatchSource
  /** The enrollment token, read again for every watch so a new one is used. */
  enrollmentToken: () => Promise<string>
  /** The view of the roster this host last discovered; undefined for none. */
  view: () => string | undefined
  /**
   * The host's existing discovery: `list_scoped`, the roster commit and
   * everything that follows it. The watch never reads the vault list itself.
   */
  discover: () => Promise<unknown>
  /**
   * The vault refused the watch, and the confirming `list_scoped` read it
   * with this error (a revoked enrollment ends both with `not_found`). Handle
   * it as discovery handles the same refusal from `list_scoped`.
   */
  onRefused: (error: unknown) => void
  onError?: (error: unknown) => void
  onMode?: (mode: WatchMode) => void
  logger?: ClaustrumLogger
  now?: () => number
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
}

interface OpenWatch {
  readonly handle: ScopedWatchHandle
  notices: number
  acceptedAt?: number
}

/**
 * Keeps one vault `watchScoped` open for a host and runs the host's discovery
 * when a notice shows the visible account list changed. Discovery runs only
 * when the notice's view differs from the last discovered roster's view, when
 * a notice shows a gap or a new epoch, or on the first notice of a watch that
 * was re-subscribed after a close (the time between two watches was not
 * observed). It never opens a second watch while one is open.
 */
export class ScopedRosterWatch {
  readonly #options: ScopedRosterWatchOptions
  readonly #reader = new ChangeNoticeReader()
  readonly #reads: CoalescedRead
  #mode: WatchMode = 'polling'
  #watch?: OpenWatch
  #timer?: ReturnType<typeof setTimeout>
  #stopped = false
  #latestView?: string
  #force = false
  /** Closes after acceptance in a row; sets the re-subscribe backoff. */
  #closes = 0

  constructor(options: ScopedRosterWatchOptions) {
    this.#options = options
    this.#reads = new CoalescedRead(
      async () => {
        const force = this.#force
        this.#force = false
        if (force || this.#latestView !== this.#options.view())
          await this.#options.discover()
      },
      (error) => {
        if (!this.#stopped) this.#options.onError?.(error)
      },
    )
  }

  get mode(): WatchMode {
    return this.#mode
  }

  start(): void {
    if (this.#stopped || this.#watch || this.#timer) return
    if (typeof this.#options.client.watchScoped !== 'function') {
      // A claustrum-client older than 0.12.0: poll exactly as before.
      this.#setMode('fallback', 'client-without-watch')
      return
    }
    void this.#open(false)
  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    if (this.#timer)
      (this.#options.clearTimeoutImpl ?? clearTimeout)(this.#timer)
    this.#timer = undefined
    const watch = this.#watch
    this.#watch = undefined
    watch?.handle.stop()
  }

  #setMode(mode: WatchMode, reason: string): void {
    if (this.#mode === mode) return
    this.#mode = mode
    this.#options.logger?.debug('claustrum vault watch', { mode, reason })
    this.#options.onMode?.(mode)
  }

  #later(delay: number, run: () => void): void {
    this.#timer = (this.#options.setTimeoutImpl ?? setTimeout)(() => {
      this.#timer = undefined
      if (!this.#stopped) run()
    }, delay)
    this.#timer.unref?.()
  }

  async #open(resubscribed: boolean): Promise<void> {
    let token: string
    try {
      token = await this.#options.enrollmentToken()
    } catch (error) {
      if (this.#stopped) return
      this.#options.onError?.(error)
      this.#fallback('token-unreadable')
      return
    }
    const watchScoped = this.#options.client.watchScoped
    if (this.#stopped || this.#watch || !watchScoped) return
    this.#reader.restart()
    // A re-subscribed watch reads on its first notice: changes made while no
    // watch was open were never announced.
    this.#force = resubscribed
    let watch: OpenWatch | undefined
    let handle: ScopedWatchHandle
    try {
      handle = watchScoped.call(
        this.#options.client,
        (notice) => {
          if (this.#stopped || !watch || this.#watch !== watch) return
          watch.notices++
          if (watch.notices === 1) {
            watch.acceptedAt = (this.#options.now ?? Date.now)()
            this.#setMode('watching', 'accepted')
          }
          if (!this.#reader.continuous(notice)) this.#force = true
          this.#latestView = notice.view
          // The read itself decides whether to list, against the roster as
          // it stands when the read runs.
          void this.#reads.request()
        },
        { enrollmentToken: token },
      )
    } catch (error) {
      this.#options.onError?.(error)
      this.#fallback('watch-failed')
      return
    }
    watch = { handle, notices: 0 }
    this.#watch = watch
    this.#setMode('polling', resubscribed ? 'resubscribing' : 'opening')
    const opened = watch
    handle.closed.then(
      (end) => this.#closed(opened, end),
      (error: unknown) =>
        this.#closed(opened, { kind: 'transport_lost', error }),
    )
  }

  #closed(watch: OpenWatch, end: ScopedWatchEnd): void {
    if (this.#stopped || this.#watch !== watch) return
    this.#watch = undefined
    if (end.kind === 'stopped') return
    if (end.kind === 'unsupported') {
      // An older vault answers unknown_method: poll exactly as before.
      this.#setMode('fallback', 'vault-without-watch')
      return
    }
    if (end.kind === 'refused') {
      this.#fallback('refused')
      try {
        this.#options.onRefused(end.error)
      } catch (error) {
        this.#options.onError?.(error)
      }
      return
    }
    if (watch.notices > 0) {
      // An accepted watch that closed (the vault restarted, or a revocation
      // ended it) gets one new watch. A revocation then shows up as that
      // watch's refusal.
      const now = (this.#options.now ?? Date.now)()
      if (
        watch.acceptedAt !== undefined &&
        now - watch.acceptedAt >= SAFETY_POLL_MS
      )
        this.#closes = 0
      const delay = Math.min(
        RESUBSCRIBE_BACKOFF_MS * 2 ** Math.min(this.#closes, 16),
        WATCH_RETRY_MS,
      )
      this.#closes++
      this.#setMode('polling', 'resubscribing')
      this.#later(delay, () => void this.#open(true))
      return
    }
    // Zero notices: the watch was never accepted (the vault is draining, or
    // the connection failed). The client already made one read to learn why.
    this.#fallback(end.kind)
  }

  #fallback(reason: string): void {
    this.#setMode('fallback', reason)
    this.#later(WATCH_RETRY_MS, () => void this.#open(false))
  }
}
