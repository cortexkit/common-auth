import { type CacheKeepWindow, isWithinCacheKeepWindow } from './window.js'

export interface CacheKeepLogger {
  debug(message: string, data?: unknown): void
  warn(message: string, data?: unknown): void
}

/**
 * Per-target overrides a plugin derives from the captured request, usually
 * from its model: how long the provider keeps that model's prompt cache, how
 * many warms a session of that kind is worth, and how long it may sit idle.
 * Evaluated once at capture time and kept on the target.
 */
export interface CacheKeepProfile {
  /** Provider cache lifetime for this request; defaults to the manager's `ttlMs`. */
  ttlMs?: number
  /** Drop the target after this many successful warms; unlimited when absent. */
  maxWarms?: number
  /** Idle bound replacing the main or subagent default for this target. */
  maxIdleMs?: number
}

/** What the plugin sees of a tracked target. */
export interface CacheKeepTargetView<M> {
  sessionKey: string
  accountId: string | undefined
  bodyText: string
  isSubagent: boolean
  meta: M
  warmCount: number
  ttlMs: number
}

export interface CacheKeepSendInput<M> {
  target: CacheKeepTargetView<M>
  /** The replay body `buildBody` returned. */
  body: string
  /** Aborted on the warm timeout and when the manager stops. */
  signal: AbortSignal
}

/**
 * The provider half of keep-warm. The manager decides when and what to warm;
 * the plugin turns a captured request into a replay, resolves the account's
 * credential, sends it and reads usage back.
 */
export interface CacheKeepAdapter<M> {
  /** Build the replay body from the captured one. A throw backs the target off. */
  buildBody(target: CacheKeepTargetView<M>): string | Promise<string>
  /**
   * Resolve the target account's credential and send the replay. A throw
   * (including "no credential") or a non-2xx response backs the target off.
   */
  send(input: CacheKeepSendInput<M>): Promise<Response>
  /** Read usage from a successful response, for the log line only. */
  readUsage?(input: {
    target: CacheKeepTargetView<M>
    response: Response
    text: string
  }): Record<string, unknown> | undefined
  /** Per-target TTL, warm cap and idle bound, from the captured request. */
  profile?(input: {
    bodyText: string
    isSubagent: boolean
    accountId: string | undefined
    meta: M
  }): CacheKeepProfile | undefined
  /**
   * The account the session routes to now, asked before every warm. A
   * different account than the one that served the captured request drops
   * the target: its cache lives on the old account, which the session has
   * left, and replaying on the new one would only write a cache nobody asked
   * for. `undefined` means the plugin holds no session-to-account binding and
   * the captured account stands. A throw backs the target off.
   */
  activeAccount?(
    sessionKey: string,
    target: CacheKeepTargetView<M>,
  ): string | undefined | Promise<string | undefined>
}

export type CacheKeepBackoff =
  | number
  | ((input: { sessionKey: string; failures: number }) => number)

export interface CacheKeepManagerOptions<M> {
  adapter: CacheKeepAdapter<M>
  now: () => number
  logger?: CacheKeepLogger
  /** Default provider cache lifetime. Default 5 minutes. */
  ttlMs?: number
  /** Warm this long before the cache expires. Default one tick plus 15 s. */
  leadMs?: number
  /** Idle bound for main sessions, from their last real request. Default 1 h. */
  maxIdleWarmMs?: number
  /** Idle bound for subagent sessions. Default 30 minutes. */
  maxSubagentIdleMs?: number
  /** Default 60 s. */
  tickIntervalMs?: number
  /** Default 32. */
  maxTargets?: number
  /** Total captured body bytes (UTF-8). Default 8 MiB. */
  maxBytes?: number
  /** One deadline for credential resolution and the send. Default 30 s. */
  warmTimeoutMs?: number
  /** Delay after a failed warm, fixed or by consecutive failures. Default 10 minutes. */
  backoffMs?: CacheKeepBackoff
  /** The configured clock window; undefined means always warm. Read on every call. */
  getWindow?: () => CacheKeepWindow | undefined
  /** When true, main sessions are exempt from idle pruning. Read on every call. */
  getSustain?: () => boolean
  setIntervalImpl?: typeof globalThis.setInterval
  clearIntervalImpl?: typeof globalThis.clearInterval
}

export type CacheKeepTrackResult =
  | { tracked: true }
  | { tracked: false; reason: 'body-exceeds-max-bytes' | 'outside-window' }

export type CacheKeepTrackInput<M> = {
  sessionKey: string
  bodyText: string
  /** The account that served this request; the one a warm replays on. */
  accountId?: string
  isSubagent?: boolean
} & (undefined extends M
  ? {
      /** Plugin data handed back to the adapter, e.g. replay headers. */ meta?: M
    }
  : {
      /** Plugin data handed back to the adapter, e.g. replay headers. */ meta: M
    })

export interface CacheKeepTargetStatus {
  sessionKey: string
  accountId: string | undefined
  isSubagent: boolean
  cacheExpiresAt: number
  lastRealRequestAt: number
  lastWarmedAt?: number
  backoffUntil?: number
  failures: number
  warmCount: number
  ttlMs: number
  bodyBytes: number
}

export interface CacheKeepStatus {
  running: boolean
  tracked: number
  totalBytes: number
  generatedAt: number
  startedAt: number | null
  ttlMs: number
  leadMs: number
  maxIdleWarmMs: number
  maxSubagentIdleMs: number
  sustain: boolean
  window?: CacheKeepWindow
  targets: CacheKeepTargetStatus[]
}

interface Target<M> {
  bodyText: string
  bodyBytes: number
  accountId: string | undefined
  isSubagent: boolean
  meta: M
  ttlMs: number
  maxWarms: number | undefined
  maxIdleMs: number | undefined
  cacheExpiresAt: number
  lastRealRequestAt: number
  lastWarmedAt?: number
  backoffUntil?: number
  failures: number
  warmCount: number
}

const DEFAULT_TTL_MS = 5 * 60_000
const DEFAULT_MAX_IDLE_WARM_MS = 60 * 60_000
const DEFAULT_MAX_SUBAGENT_IDLE_MS = 30 * 60_000
const DEFAULT_TICK_INTERVAL_MS = 60_000
const DEFAULT_MAX_TARGETS = 32
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_WARM_TIMEOUT_MS = 30_000
const DEFAULT_BACKOFF_MS = 10 * 60_000

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Keeps idle prompt caches warm: one target per session holding the latest
 * request body, replayed just before the provider's cache would expire.
 *
 * Bounds, in the order they act: the clock window gates capture and warming
 * (targets captured earlier survive outside it); idle caps prune a target its
 * session stopped using (`sustain` lifts only the main-session cap); the
 * target-count and byte caps evict the least recently touched target; a
 * per-target warm cap retires short-lived sessions; and a failed warm backs
 * that target off without touching the others.
 */
export class CacheKeepManager<M = undefined> {
  private readonly targets = new Map<string, Target<M>>()
  private readonly adapter: CacheKeepAdapter<M>
  private readonly now: () => number
  private readonly log: CacheKeepLogger | undefined
  private readonly ttlMs: number
  private readonly leadMs: number
  private readonly maxIdleWarmMs: number
  private readonly maxSubagentIdleMs: number
  private readonly tickIntervalMs: number
  private readonly maxTargets: number
  private readonly maxBytes: number
  private readonly warmTimeoutMs: number
  private readonly backoff: CacheKeepBackoff
  private readonly getWindow: (() => CacheKeepWindow | undefined) | undefined
  private readonly getSustain: (() => boolean) | undefined
  private readonly setIntervalImpl: typeof globalThis.setInterval
  private readonly clearIntervalImpl: typeof globalThis.clearInterval

  private timer: ReturnType<typeof setInterval> | null = null
  private startedAt: number | null = null
  private totalBytes = 0
  private tickPromise: Promise<void> | null = null
  private disposed = false
  private abortController = new AbortController()

  constructor(options: CacheKeepManagerOptions<M>) {
    this.adapter = options.adapter
    this.now = options.now
    this.log = options.logger
    this.ttlMs = positive(options.ttlMs, DEFAULT_TTL_MS)
    this.tickIntervalMs = positive(
      options.tickIntervalMs,
      DEFAULT_TICK_INTERVAL_MS,
    )
    // One tick of slack so a target that becomes due between ticks is still
    // warmed before its cache expires.
    this.leadMs = positive(options.leadMs, this.tickIntervalMs + 15_000)
    this.maxIdleWarmMs = positive(
      options.maxIdleWarmMs,
      DEFAULT_MAX_IDLE_WARM_MS,
    )
    this.maxSubagentIdleMs = positive(
      options.maxSubagentIdleMs,
      DEFAULT_MAX_SUBAGENT_IDLE_MS,
    )
    this.maxTargets = positive(options.maxTargets, DEFAULT_MAX_TARGETS)
    this.maxBytes = positive(options.maxBytes, DEFAULT_MAX_BYTES)
    this.warmTimeoutMs = positive(
      options.warmTimeoutMs,
      DEFAULT_WARM_TIMEOUT_MS,
    )
    this.backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS
    this.getWindow = options.getWindow
    this.getSustain = options.getSustain
    this.setIntervalImpl = options.setIntervalImpl ?? globalThis.setInterval
    this.clearIntervalImpl =
      options.clearIntervalImpl ?? globalThis.clearInterval
  }

  /**
   * Capture a session's latest request. The freshest body replaces the
   * previous one and restarts its cache clock, idle clock and warm count.
   * Arms the timer.
   */
  track(input: CacheKeepTrackInput<M>): CacheKeepTrackResult {
    const { sessionKey, bodyText } = input
    this.pruneStale()

    const bodyBytes = Buffer.byteLength(bodyText, 'utf8')
    if (bodyBytes > this.maxBytes) {
      this.log?.debug('cachekeep track skipped (body exceeds maxBytes)', {
        sessionKey,
        bodyBytes,
        maxBytes: this.maxBytes,
      })
      return { tracked: false, reason: 'body-exceeds-max-bytes' }
    }

    const window = this.getWindow?.()
    if (window && !isWithinCacheKeepWindow(window, new Date(this.now()))) {
      this.log?.debug('cachekeep track skipped (outside window)', {
        sessionKey,
        startHour: window.startHour,
        endHour: window.endHour,
      })
      return { tracked: false, reason: 'outside-window' }
    }

    // Delete before re-adding so a retracked session is also the most recent
    // in insertion order.
    this.drop(sessionKey)

    while (
      this.targets.size >= this.maxTargets ||
      (this.totalBytes + bodyBytes > this.maxBytes && this.targets.size > 0)
    ) {
      const evictKey = this.leastRecentlyTouched()
      if (evictKey === undefined) break
      this.log?.debug('cachekeep evicted least recently used target', {
        sessionKey: evictKey,
      })
      this.drop(evictKey)
    }

    const isSubagent = input.isSubagent === true
    const accountId = input.accountId || undefined
    const profile = this.adapter.profile?.({
      bodyText,
      isSubagent,
      accountId,
      meta: input.meta as M,
    })
    const ttlMs = positive(profile?.ttlMs, this.ttlMs)
    const now = this.now()
    this.targets.set(sessionKey, {
      bodyText,
      bodyBytes,
      accountId,
      isSubagent,
      meta: input.meta as M,
      ttlMs,
      maxWarms:
        profile?.maxWarms !== undefined && profile.maxWarms > 0
          ? Math.floor(profile.maxWarms)
          : undefined,
      maxIdleMs:
        profile?.maxIdleMs !== undefined
          ? positive(profile.maxIdleMs, this.idleDefault(isSubagent))
          : undefined,
      cacheExpiresAt: now + ttlMs,
      lastRealRequestAt: now,
      failures: 0,
      warmCount: 0,
    })
    this.totalBytes += bodyBytes
    this.log?.debug('cachekeep captured target', { sessionKey, accountId })
    this.start()
    return { tracked: true }
  }

  /** Forget a session, e.g. when the host deletes it. */
  remove(sessionKey: string): void {
    if (this.drop(sessionKey)) {
      this.log?.debug('cachekeep removed target', { sessionKey })
    }
  }

  start(): void {
    this.disposed = false
    if (this.timer) return
    this.startedAt = this.now()
    this.timer = this.setIntervalImpl(() => {
      void this.tick().catch((error) => {
        this.log?.warn('cachekeep tick failed', { error: errorMessage(error) })
      })
    }, this.tickIntervalMs)
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref()
    }
    this.log?.debug('cachekeep started', {
      ttlMs: this.ttlMs,
      leadMs: this.leadMs,
      maxIdleWarmMs: this.maxIdleWarmMs,
    })
  }

  /** Disarm, abort any warm in flight and forget every target. */
  stop(): void {
    this.disposed = true
    this.abortController.abort()
    this.abortController = new AbortController()
    if (this.timer) {
      this.clearIntervalImpl(this.timer)
      this.timer = null
    }
    this.startedAt = null
    this.targets.clear()
    this.totalBytes = 0
    this.log?.debug('cachekeep stopped')
  }

  /** A snapshot without captured bodies, which can hold prompt content. */
  status(): CacheKeepStatus {
    const window = this.getWindow?.()
    return {
      running: this.timer !== null,
      tracked: this.targets.size,
      totalBytes: this.totalBytes,
      generatedAt: this.now(),
      startedAt: this.startedAt,
      ttlMs: this.ttlMs,
      leadMs: this.leadMs,
      maxIdleWarmMs: this.maxIdleWarmMs,
      maxSubagentIdleMs: this.maxSubagentIdleMs,
      sustain: this.getSustain?.() === true,
      ...(window ? { window } : {}),
      targets: [...this.targets].map(([sessionKey, target]) => ({
        sessionKey,
        accountId: target.accountId,
        isSubagent: target.isSubagent,
        cacheExpiresAt: target.cacheExpiresAt,
        lastRealRequestAt: target.lastRealRequestAt,
        ...(target.lastWarmedAt !== undefined
          ? { lastWarmedAt: target.lastWarmedAt }
          : {}),
        ...(target.backoffUntil !== undefined
          ? { backoffUntil: target.backoffUntil }
          : {}),
        failures: target.failures,
        warmCount: target.warmCount,
        ttlMs: target.ttlMs,
        bodyBytes: target.bodyBytes,
      })),
    }
  }

  /**
   * Prune, then warm every target within `leadMs` of expiry that is not
   * backing off. Overlapping calls share the tick already running, so a slow
   * warm never stacks a second send for the same target.
   */
  tick(): Promise<void> {
    if (this.tickPromise) return this.tickPromise
    const run = this.runTick().finally(() => {
      if (this.tickPromise === run) this.tickPromise = null
    })
    this.tickPromise = run
    return run
  }

  private async runTick(): Promise<void> {
    this.pruneStale()
    // Outside the window nothing fires, but captured targets stay so they
    // warm again when it reopens.
    const window = this.getWindow?.()
    if (window && !isWithinCacheKeepWindow(window, new Date(this.now()))) {
      return
    }
    const now = this.now()
    const leadBound = now + this.leadMs
    for (const [sessionKey, target] of [...this.targets]) {
      if (this.disposed) return
      if (this.targets.get(sessionKey) !== target) continue
      if (target.backoffUntil !== undefined && now < target.backoffUntil) {
        continue
      }
      if (target.cacheExpiresAt > leadBound) continue
      await this.warm(sessionKey, target)
    }
  }

  private isCurrent(sessionKey: string, target: Target<M>): boolean {
    return !this.disposed && this.targets.get(sessionKey) === target
  }

  private view(sessionKey: string, target: Target<M>): CacheKeepTargetView<M> {
    return {
      sessionKey,
      accountId: target.accountId,
      bodyText: target.bodyText,
      isSubagent: target.isSubagent,
      meta: target.meta,
      warmCount: target.warmCount,
      ttlMs: target.ttlMs,
    }
  }

  private fail(
    sessionKey: string,
    target: Target<M>,
    message: string,
    fields: Record<string, unknown> = {},
  ): void {
    if (!this.isCurrent(sessionKey, target)) return
    target.failures += 1
    const delay =
      typeof this.backoff === 'function'
        ? this.backoff({ sessionKey, failures: target.failures })
        : this.backoff
    target.backoffUntil =
      this.now() + (Number.isFinite(delay) && delay > 0 ? delay : 0)
    this.log?.warn(message, {
      sessionKey,
      accountId: target.accountId,
      failures: target.failures,
      backoffUntil: target.backoffUntil,
      ...fields,
    })
  }

  private async warm(sessionKey: string, target: Target<M>): Promise<void> {
    const view = this.view(sessionKey, target)
    if (this.adapter.activeAccount) {
      let active: string | undefined
      try {
        active = await this.adapter.activeAccount(sessionKey, view)
      } catch (error) {
        this.fail(
          sessionKey,
          target,
          'cachekeep skip (active account unknown)',
          {
            error: errorMessage(error),
          },
        )
        return
      }
      if (!this.isCurrent(sessionKey, target)) return
      if (active !== undefined && active !== target.accountId) {
        this.log?.debug('cachekeep dropped target (session changed account)', {
          sessionKey,
          accountId: target.accountId,
          activeAccountId: active,
        })
        this.drop(sessionKey)
        return
      }
    }

    let body: string
    try {
      body = await this.adapter.buildBody(view)
    } catch (error) {
      this.fail(
        sessionKey,
        target,
        'cachekeep skip (replay body unbuildable)',
        {
          error: errorMessage(error),
        },
      )
      return
    }
    if (!this.isCurrent(sessionKey, target)) return

    const signal = AbortSignal.any([
      AbortSignal.timeout(this.warmTimeoutMs),
      this.abortController.signal,
    ])
    let response: Response
    let text = ''
    try {
      response = await this.adapter.send({ target: view, body, signal })
      // Drain the body so the connection is released; its text is only
      // diagnostic.
      text = await response.text().catch(() => '')
    } catch (error) {
      this.fail(sessionKey, target, 'cachekeep failed', {
        error: errorMessage(error),
      })
      return
    }
    if (!this.isCurrent(sessionKey, target)) return

    if (!response.ok) {
      this.fail(sessionKey, target, 'cachekeep failed', {
        status: response.status,
        responseBody: text.slice(0, 600),
      })
      return
    }

    let usage: Record<string, unknown> | undefined
    try {
      usage = this.adapter.readUsage?.({ target: view, response, text })
    } catch {
      // Usage is for the log line only and must never fail a warm that worked.
    }
    const now = this.now()
    target.cacheExpiresAt = now + target.ttlMs
    target.lastWarmedAt = now
    target.backoffUntil = undefined
    target.failures = 0
    target.warmCount += 1
    this.log?.debug('cachekeep fired', {
      sessionKey,
      accountId: target.accountId,
      warmCount: target.warmCount,
      ...usage,
    })
    if (target.maxWarms !== undefined && target.warmCount >= target.maxWarms) {
      this.log?.debug('cachekeep retired target (warm cap reached)', {
        sessionKey,
        warmCount: target.warmCount,
      })
      this.drop(sessionKey)
    }
  }

  private idleDefault(isSubagent: boolean): number {
    return isSubagent ? this.maxSubagentIdleMs : this.maxIdleWarmMs
  }

  private pruneStale(): void {
    const now = this.now()
    const sustain = this.getSustain?.() === true
    for (const [sessionKey, target] of [...this.targets]) {
      // Sustain exempts main sessions from the idle cap only; the window,
      // count, byte and warm caps still apply to them.
      if (sustain && !target.isSubagent) continue
      const maxIdleMs = target.maxIdleMs ?? this.idleDefault(target.isSubagent)
      if (target.lastRealRequestAt >= now - maxIdleMs) continue
      this.log?.debug('cachekeep pruned idle target', {
        sessionKey,
        accountId: target.accountId,
        lastRealRequestAt: target.lastRealRequestAt,
        maxIdleMs,
      })
      this.drop(sessionKey)
    }
  }

  private leastRecentlyTouched(): string | undefined {
    let evictKey: string | undefined
    let evictTouchedAt = Number.POSITIVE_INFINITY
    for (const [key, target] of this.targets) {
      // A warm counts as a touch, so a session kept warm outlives one whose
      // only activity is an older real request.
      const touchedAt = Math.max(
        target.lastRealRequestAt,
        target.lastWarmedAt ?? 0,
      )
      if (touchedAt < evictTouchedAt) {
        evictKey = key
        evictTouchedAt = touchedAt
      }
    }
    return evictKey
  }

  private drop(sessionKey: string): boolean {
    const target = this.targets.get(sessionKey)
    if (!target) return false
    this.totalBytes -= target.bodyBytes
    this.targets.delete(sessionKey)
    return true
  }
}
