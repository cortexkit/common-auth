import type {
  SessionCacheHours,
  SessionKeepWarmMode,
} from '../routing-accessor/cache-policy.js'
import { combineAbortSignals } from '../util/any-signal.js'
import { type CacheKeepDecision, decideCacheKeep } from './decision.js'
import { classifyFailure, type Failure } from './failure.js'
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
  /** Legacy/unpriced-auto warm cap; unlimited when absent. */
  maxWarms?: number
  /** Legacy/unpriced-auto idle bound replacing the main or subagent default. */
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

/** A fresh, plugin-validated session policy with optional provider prices. */
export interface CacheKeepPlan {
  mode: SessionKeepWarmMode
  hours?: SessionCacheHours
  costs?: { nextWarm: number; rewrite: number }
}

/**
 * The provider half of keep-warm. The manager decides when and what to warm;
 * the plugin turns a captured request into a replay, resolves the account's
 * credential, sends it and reads usage back.
 */
export interface CacheKeepAdapter<M> {
  /** Read a fresh policy; undefined preserves legacy only if never planned. */
  plan?(sessionKey: string): CacheKeepPlan | undefined
  /** Successful warm reports never block scheduling. */
  onWarmed?(sessionKey: string, input: { at: number }): void | Promise<void>
  /** Report retirement only after a target has successfully warmed. */
  onWarmStopped?(
    sessionKey: string,
    input: { at: number; reason: string },
  ): void | Promise<void>
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
  /** How often the timer runs a tick. Default 60 s. */
  tickIntervalMs?: number
  /** Most sessions tracked at once. Default 32. */
  maxTargets?: number
  /** Total captured body bytes (UTF-8). Default 8 MiB. */
  maxBytes?: number
  /** One deadline for credential resolution and the send. Default 30 s. */
  warmTimeoutMs?: number
  /** Override failure delays, fixed or by consecutive failures. Defaults to expiry-bounded transient retries, otherwise 10 minutes. */
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
  | {
      tracked: false
      reason:
        | 'body-exceeds-max-bytes'
        | 'outside-window'
        | 'unsupported'
        | 'session-ended'
    }

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
  mode?: SessionKeepWarmMode
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
  plan?: CacheKeepPlan
  planTimer?: ReturnType<typeof setInterval>
  planDueAt?: number
  warmCostSoFar: number
  hasWarmed: boolean
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
  retryTimer?: ReturnType<typeof setInterval>
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
const TRANSIENT_RETRY_STEP_MS = 20_000
const TRANSIENT_RETRY_MAX_MS = 60_000
const EXPIRY_SAFETY_MS = 5_000

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback
}

/**
 * Keeps idle prompt caches warm: one target per session holding the latest
 * request body, replayed just before the provider's cache would expire.
 *
 * Without a session plan, bounds act in this order: a target retires once its last confirmed
 * cache lifetime ends (`cacheExpiresAt`, set by its capture or its last
 * successful warm), whatever else holds, because replaying a history whose
 * cache has expired rebuilds a cold cache instead of keeping a warm one
 * alive; the clock window gates capture and warming (targets captured earlier
 * survive outside it until their lifetime ends); idle caps prune a target its
 * session stopped using (`sustain` lifts only the main-session idle cap, not
 * the lifetime); the target-count and byte caps evict the least recently
 * touched target; a per-target warm cap retires short-lived sessions; and a
 * failed warm backs that target off without touching the others. Default
 * transient retries use 20/40/60-second delays, clipped to the last safe start
 * (expiry minus the warm timeout and 5 seconds). Only default-policy retries
 * observe that deadline: first attempts and explicit backoff policies retain
 * their existing lead-time scheduling, bounded by the cache lifetime.
 * Session plans use the shared decision rule and one-shot due timers instead;
 * only unpriced auto keeps the legacy idle and profile warm bounds. Lifetime,
 * target-count, byte and LRU bounds apply to every target.
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
  private readonly backoff: CacheKeepBackoff | undefined
  private readonly getWindow: (() => CacheKeepWindow | undefined) | undefined
  private readonly getSustain: (() => boolean) | undefined
  private readonly setIntervalImpl: typeof globalThis.setInterval
  private readonly clearIntervalImpl: typeof globalThis.clearInterval

  private timer: ReturnType<typeof setInterval> | null = null
  private startedAt: number | null = null
  private totalBytes = 0
  private tickPromise: Promise<void> | null = null
  private disposed = false
  private planWarningLogged = false
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
    this.backoff = options.backoffMs
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
    const previous = this.targets.get(sessionKey)
    const plan = this.readPlan(sessionKey)
    if (!plan && previous?.plan) {
      this.drop(sessionKey, 'session-ended')
      return { tracked: false, reason: 'session-ended' }
    }
    if (plan?.mode === 'off') {
      this.drop(sessionKey, 'unsupported')
      return { tracked: false, reason: 'unsupported' }
    }
    this.pruneStale(plan ? sessionKey : undefined)

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
    if (
      !plan &&
      window &&
      !isWithinCacheKeepWindow(window, new Date(this.now()))
    ) {
      this.log?.debug('cachekeep track skipped (outside window)', {
        sessionKey,
        startHour: window.startHour,
        endHour: window.endHour,
      })
      return { tracked: false, reason: 'outside-window' }
    }

    // Delete before re-adding so a retracked session is also the most recent
    // in insertion order.
    const hasWarmed = this.targets.get(sessionKey)?.hasWarmed ?? false
    this.drop(sessionKey, null)

    while (
      this.targets.size >= this.maxTargets ||
      (this.totalBytes + bodyBytes > this.maxBytes && this.targets.size > 0)
    ) {
      const evictKey = this.leastRecentlyTouched()
      if (evictKey === undefined) break
      this.log?.debug('cachekeep evicted least recently used target', {
        sessionKey: evictKey,
      })
      this.drop(evictKey, 'evicted')
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
    const target: Target<M> = {
      plan,
      warmCostSoFar: 0,
      hasWarmed,
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
    }
    this.targets.set(sessionKey, target)
    this.totalBytes += bodyBytes
    this.log?.debug('cachekeep captured target', { sessionKey, accountId })
    this.start()
    if (plan) this.planDecision(sessionKey, target)
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
        this.log?.warn('cachekeep tick failed', classifyFailure(error, 'send'))
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
    for (const sessionKey of this.targets.keys())
      this.drop(sessionKey, 'stopped')
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
        ...(target.plan ? { mode: target.plan.mode } : {}),
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
    // Outside the window nothing fires, but captured targets stay until
    // their cache lifetime ends, so one still alive when the window reopens
    // is warmed again.
    const window = this.getWindow?.()
    const outsideWindow =
      window && !isWithinCacheKeepWindow(window, new Date(this.now()))
    for (const [sessionKey, target] of [...this.targets]) {
      if (this.disposed) return
      if (this.targets.get(sessionKey) !== target) continue
      if (!this.refreshPlan(sessionKey, target)) continue
      const now = this.now()
      if (target.plan) {
        const decision = this.planDecision(sessionKey, target)
        if (decision.action !== 'warm') continue
        if (target.backoffUntil !== undefined && now < target.backoffUntil) {
          this.schedulePlan(sessionKey, target, target.backoffUntil)
          continue
        }
      } else {
        if (outsideWindow) continue
        if (target.cacheExpiresAt > now + this.leadMs) continue
      }
      if (target.backoffUntil !== undefined && now < target.backoffUntil) {
        continue
      }
      if (!this.canRetry(target)) continue
      await this.warm(sessionKey, target)
    }
  }

  /**
   * Retires `target` when its last confirmed cache lifetime has ended; true
   * when it did. Called before every send, since earlier warms in the same
   * tick, the adapter's account lookup and body build all take time.
   */
  private retireIfExpired(sessionKey: string, target: Target<M>): boolean {
    if (this.now() < target.cacheExpiresAt) return false
    this.log?.debug('cachekeep retired target (cache lifetime ended)', {
      sessionKey,
      accountId: target.accountId,
      cacheExpiresAt: target.cacheExpiresAt,
      failures: target.failures,
    })
    this.drop(sessionKey, target.plan ? 'cost-cap' : 'expired')
    return true
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

  private readPlan(sessionKey: string): CacheKeepPlan | undefined {
    try {
      return this.adapter.plan?.(sessionKey)
    } catch {
      if (!this.planWarningLogged) {
        this.planWarningLogged = true
        this.log?.warn('cachekeep plan unavailable')
      }
      return undefined
    }
  }

  private refreshPlan(sessionKey: string, target: Target<M>): boolean {
    const plan = this.readPlan(sessionKey)
    if (!plan && target.plan) {
      this.drop(sessionKey, 'session-ended')
      return false
    }
    target.plan = plan
    if (plan?.mode === 'off') {
      this.drop(sessionKey, 'unsupported')
      return false
    }
    return true
  }

  private usesLegacyBounds(target: Target<M>): boolean {
    return !target.plan || (target.plan.mode === 'auto' && !target.plan.costs)
  }

  private planDecision(
    sessionKey: string,
    target: Target<M>,
  ): CacheKeepDecision {
    const plan = target.plan
    if (!plan) return { action: 'stop', reason: 'session-ended' }
    if (this.usesLegacyBounds(target)) {
      if (this.retireIfIdle(sessionKey, target, this.getSustain?.() === true)) {
        return { action: 'stop', reason: 'idle' }
      }
      if (
        target.maxWarms !== undefined &&
        target.warmCount >= target.maxWarms
      ) {
        this.drop(sessionKey, 'count-cap')
        return { action: 'stop', reason: 'count-cap' }
      }
    }
    const decision =
      plan.mode === 'hours' && !plan.hours
        ? ({ action: 'stop', reason: 'unsupported' } as const)
        : decideCacheKeep({
            ...(plan.mode === 'hours'
              ? { mode: plan.mode, hours: plan.hours as SessionCacheHours }
              : { mode: plan.mode }),
            now: this.now(),
            ttlMs: target.ttlMs,
            lastRealRequestAt: target.lastRealRequestAt,
            lastWarmAt: target.lastWarmedAt,
            warmsSinceLastRealRequest: target.warmCount,
            ...(plan.costs
              ? {
                  warmCostSoFar: target.warmCostSoFar,
                  nextWarmCost: plan.costs.nextWarm,
                  rewriteCost: plan.costs.rewrite,
                }
              : {}),
          })
    if (decision.action === 'stop') this.drop(sessionKey, decision.reason)
    else if (decision.action === 'wait') {
      this.schedulePlan(
        sessionKey,
        target,
        Math.max(decision.until, target.backoffUntil ?? 0),
      )
    } else this.clearPlanTimer(target)
    return decision
  }

  private clearPlanTimer(target: Target<M>): void {
    if (target.planTimer === undefined) return
    this.clearIntervalImpl(target.planTimer)
    target.planTimer = undefined
    target.planDueAt = undefined
  }

  private schedulePlan(
    sessionKey: string,
    target: Target<M>,
    until: number,
  ): void {
    if (target.planTimer !== undefined && target.planDueAt === until) return
    this.clearPlanTimer(target)
    target.planDueAt = until
    // Clear the injected interval before dispatch to make it a one-shot, just
    // like retries. Waiting for an in-flight tick prevents a lost wake-up.
    target.planTimer = this.setIntervalImpl(
      () => {
        this.clearPlanTimer(target)
        return (async () => {
          await this.tickPromise
          if (this.isCurrent(sessionKey, target)) await this.tick()
        })().catch((error) => {
          this.log?.warn(
            'cachekeep tick failed',
            classifyFailure(error, 'send'),
          )
        })
      },
      Math.max(0, until - this.now()),
    )
    if (typeof target.planTimer === 'object' && 'unref' in target.planTimer) {
      target.planTimer.unref()
    }
  }

  private report(callback: () => void | Promise<void>): void {
    try {
      void Promise.resolve(callback()).catch(() => {
        this.log?.debug('cachekeep report failed')
      })
    } catch {
      this.log?.debug('cachekeep report failed')
    }
  }

  private fail(
    sessionKey: string,
    target: Target<M>,
    message: string,
    failure: Failure,
    transient = false,
    status?: number,
  ): void {
    if (!this.isCurrent(sessionKey, target)) return
    target.failures += 1
    const now = this.now()
    let delay =
      typeof this.backoff === 'function'
        ? this.backoff({ sessionKey, failures: target.failures })
        : (this.backoff ?? DEFAULT_BACKOFF_MS)
    const deadline = this.lastRetryStart(target)
    const fastRetry = this.backoff === undefined && transient && now < deadline
    if (fastRetry) {
      delay = Math.min(
        TRANSIENT_RETRY_STEP_MS * target.failures,
        TRANSIENT_RETRY_MAX_MS,
        deadline - now,
      )
    }
    target.backoffUntil =
      now + (Number.isFinite(delay) && delay > 0 ? delay : 0)
    this.clearRetry(target)
    if (fastRetry) this.scheduleRetry(sessionKey, target, delay)
    else if (target.plan) {
      this.schedulePlan(sessionKey, target, target.backoffUntil)
    }
    this.log?.warn(message, {
      sessionKey,
      accountId: target.accountId,
      failures: target.failures,
      backoffUntil: target.backoffUntil,
      ...failure,
      ...(status !== undefined && { status }),
    })
  }

  private lastRetryStart(target: Target<M>): number {
    return target.cacheExpiresAt - this.warmTimeoutMs - EXPIRY_SAFETY_MS
  }

  private canRetry(target: Target<M>): boolean {
    return (
      this.backoff !== undefined ||
      target.failures === 0 ||
      this.now() <= this.lastRetryStart(target)
    )
  }

  private clearRetry(target: Target<M>): void {
    if (target.retryTimer === undefined) return
    this.clearIntervalImpl(target.retryTimer)
    target.retryTimer = undefined
  }

  private scheduleRetry(
    sessionKey: string,
    target: Target<M>,
    delay: number,
  ): void {
    // Use the same injected timer pair as the regular tick, but clear this
    // interval before dispatch so it acts as a one-shot retry timer.
    target.retryTimer = this.setIntervalImpl(() => {
      this.clearRetry(target)
      return (async () => {
        // A different target can still be warming. Wait for that tick before
        // rechecking eligibility, rather than losing this wake-up to coalescing.
        await this.tickPromise
        if (this.isCurrent(sessionKey, target)) await this.tick()
      })().catch((error) => {
        this.log?.warn('cachekeep tick failed', classifyFailure(error, 'send'))
      })
    }, delay)
    if (typeof target.retryTimer === 'object' && 'unref' in target.retryTimer) {
      target.retryTimer.unref()
    }
  }

  private async warm(sessionKey: string, target: Target<M>): Promise<void> {
    if (this.retireIfExpired(sessionKey, target)) return
    if (!this.canRetry(target)) return
    this.clearRetry(target)
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
          classifyFailure(error, 'authorization'),
          true,
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
        this.drop(sessionKey, 'account-changed')
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
        classifyFailure(error, 'authorization'),
      )
      return
    }
    if (!this.isCurrent(sessionKey, target)) return
    if (this.retireIfExpired(sessionKey, target)) return
    if (!this.canRetry(target)) return

    if (!this.refreshPlan(sessionKey, target)) return
    if (
      target.plan &&
      this.planDecision(sessionKey, target).action !== 'warm'
    ) {
      return
    }
    const nextWarmCost = target.plan?.costs?.nextWarm ?? 0

    const combined = combineAbortSignals([
      AbortSignal.timeout(this.warmTimeoutMs),
      this.abortController.signal,
    ])
    const signal = combined.signal
    let response: Response
    let text = ''
    let stage: 'send' | 'response' = 'send'
    let status: number | undefined
    try {
      response = await this.adapter.send({ target: view, body, signal })
      stage = 'response'
      status = response.status
      // Drain the body to release the connection and let the adapter read usage.
      text = await response.text()
    } catch (error) {
      this.fail(
        sessionKey,
        target,
        'cachekeep failed',
        classifyFailure(error, stage, status),
        status === undefined ||
          (status >= 200 && status < 300) ||
          status === 408 ||
          status === 429 ||
          status >= 500,
        status,
      )
      return
    } finally {
      combined.dispose()
    }
    if (!this.isCurrent(sessionKey, target)) return

    if (!response.ok) {
      this.fail(
        sessionKey,
        target,
        'cachekeep failed',
        classifyFailure(undefined, 'response', response.status),
        response.status === 408 ||
          response.status === 429 ||
          response.status >= 500,
        response.status,
      )
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
    this.clearRetry(target)
    target.failures = 0
    target.warmCount += 1
    target.hasWarmed = true
    target.warmCostSoFar += nextWarmCost
    if (this.adapter.onWarmed) {
      this.report(() => this.adapter.onWarmed?.(sessionKey, { at: now }))
    }
    this.log?.debug('cachekeep fired', {
      sessionKey,
      accountId: target.accountId,
      warmCount: target.warmCount,
      ...usage,
    })
    if (
      this.usesLegacyBounds(target) &&
      target.maxWarms !== undefined &&
      target.warmCount >= target.maxWarms
    ) {
      this.log?.debug('cachekeep retired target (warm cap reached)', {
        sessionKey,
        warmCount: target.warmCount,
      })
      this.drop(sessionKey, 'count-cap')
    }
    if (target.plan && this.isCurrent(sessionKey, target)) {
      if (this.refreshPlan(sessionKey, target))
        this.planDecision(sessionKey, target)
    }
  }

  private idleDefault(isSubagent: boolean): number {
    return isSubagent ? this.maxSubagentIdleMs : this.maxIdleWarmMs
  }

  private pruneStale(skipSessionKey?: string): void {
    const now = this.now()
    const sustain = this.getSustain?.() === true
    for (const [sessionKey, target] of [...this.targets]) {
      if (sessionKey === skipSessionKey) continue
      if (this.retireIfExpired(sessionKey, target)) continue
      if (!this.refreshPlan(sessionKey, target)) continue
      if (!this.usesLegacyBounds(target)) continue
      this.retireIfIdle(sessionKey, target, sustain, now)
    }
  }

  private retireIfIdle(
    sessionKey: string,
    target: Target<M>,
    sustain: boolean,
    now = this.now(),
  ): boolean {
    // Sustain exempts main sessions from the idle cap only; the lifetime,
    // window, count, byte and warm caps still apply to them.
    if (sustain && !target.isSubagent) return false
    const maxIdleMs = target.maxIdleMs ?? this.idleDefault(target.isSubagent)
    if (target.lastRealRequestAt >= now - maxIdleMs) return false
    this.log?.debug('cachekeep pruned idle target', {
      sessionKey,
      accountId: target.accountId,
      lastRealRequestAt: target.lastRealRequestAt,
      maxIdleMs,
    })
    this.drop(sessionKey, 'idle')
    return true
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

  private drop(
    sessionKey: string,
    reason: string | null = 'session-ended',
  ): boolean {
    const target = this.targets.get(sessionKey)
    if (!target) return false
    this.clearRetry(target)
    this.clearPlanTimer(target)
    this.totalBytes -= target.bodyBytes
    this.targets.delete(sessionKey)
    if (reason !== null && target.hasWarmed && this.adapter.onWarmStopped) {
      this.report(() =>
        this.adapter.onWarmStopped?.(sessionKey, { at: this.now(), reason }),
      )
    }
    return true
  }
}
