/**
 * Optional THALAMUS routing for vault mode, plugin wait reports and advisory turn
 * notes for request shaping. Account ids are vault account ids, not local pool
 * rows. Nothing is persisted here; plugins on routes the runner does not serve
 * get no turn notes.
 */

import {
  type CacheWarmStopReason,
  isCacheWarmStopReason,
} from './cache-policy.js'
import { routingHandle } from './handle.js'

export type {
  CacheTouchInput,
  CacheWarmStoppedInput,
  CacheWarmStopReason,
  SessionCacheHours,
  SessionCachePolicy,
  SessionCacheTtl,
  SessionKeepWarmMode,
  SessionToolWait,
} from './cache-policy.js'
export {
  CACHE_WARM_STOP_REASONS,
  isCacheWarmStopReason,
  reportCacheTouch,
  reportCacheWarmStopped,
  sessionCachePolicy,
  sessionToolWait,
} from './cache-policy.js'

/** An eligible vault route, not a local pool row. */
export interface RoutingCandidate {
  /** Vault account id, not the plugin's route id. */
  accountId: string
  credentialId: string
}

export interface AskRoutingInput<
  Candidate extends RoutingCandidate = RoutingCandidate,
  Refusals extends boolean = false,
> {
  sessionId: string
  provider: string
  modelId: string
  /** Only routes already eligible under the plugin's vault and killswitch rules. */
  candidates: readonly Candidate[]
  /** Defaults to 1500 ms, above routing's normal tail; clamped to 1–2000 ms. */
  deadlineMs?: number
  /** Opt in to refusals, which stop the request instead of using a local choice. */
  refusals?: Refusals
  /**
   * Longest same-account hold, in seconds, that routing may advise. The
   * holdWaitMaxS helper from `./limits` caps it by the setting and the current
   * account's cache expiry, returning 0 when there is no accepted prompt cache
   * worth waiting for. Fractions are floored and negatives become 0. Omit it to leave
   * routing's default cap in force.
   */
  holdWaitMaxS?: number
}

export interface RoutingHold {
  /** Uncapped advice from routing. The plugin must apply its own hold cap. */
  retry_after_ms: number
}

export interface RoutingSelection<
  Candidate extends RoutingCandidate = RoutingCandidate,
> {
  /** The original eligible candidate, including any plugin-specific metadata. */
  candidate: Candidate
  hold?: RoutingHold
}

export type RoutingRefusal = {
  refused: {
    code:
      | 'account_limit_exhausted'
      | 'account_selection_refused'
      | 'account_selection_final'
    routingCode?: string
    retryAfterSecs?: number
    resetsAtMs?: number
  }
}

interface RoutingReportIdentity {
  sessionId: string
  accountId: string
  credentialId?: string
}

export type BillingRequestKind =
  | 'primary'
  | 'title'
  | 'compaction'
  | 'generate'
  | 'keep_warm'
  | 'prime'

export type BillingOutcome = 'completed' | 'cut' | 'failed'

/** Omit unread counts; zero represents a measured count, not a default. */
export interface BillingUsage {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  cacheWrite5m?: number
  cacheWrite1h?: number
  reasoning?: number
  reasoningIncludedInOutput?: boolean
}

/** Keep this closed list aligned with the routing contract when adding a reason. */
export const PLUGIN_WAIT_REASONS = [
  'account_limit',
  'account_free',
  'rate_limited',
  'server_busy',
  'quota_reading',
  'routing_hold',
] as const

export type PluginWaitReason = (typeof PLUGIN_WAIT_REASONS)[number]

export type ReportRoutingInput =
  | (RoutingReportIdentity &
      (
        | {
            outcome: 'served'
            /**
             * Pass only rate-limit headers, never the whole response headers.
             * Values are forwarded unchanged; do not include tokens, emails or labels.
             */
            headers: Readonly<Record<string, string>>
          }
        | {
            outcome: 'exhausted'
            /** The exhausted quota window; keep scoped quota groups in `pool`. */
            window: '5h' | '7d'
            /**
             * Scoped quota group, such as Antigravity's `3p` or `gemini`.
             * Must match `^[a-z0-9._-]{1,64}$`. Routing compares names exactly, so
             * callers must lowercase names from elsewhere (e.g. `Fable` to `fable`).
             * Names are never rewritten here. Omit or pass `undefined` to block the
             * whole account; include to block only this pool.
             */
            pool?: string
            /** Optional reset time in epoch milliseconds. */
            resetsAt?: number
          }
        | {
            /**
             * A provider's typed refusal that condemns the API key until it is
             * topped up, such as an exhausted prepaid balance. Never use for
             * 401, 403 or short rate limits.
             */
            outcome: 'credential_refused'
            credentialId: string
            /**
             * What the provider actually sent: its own code from the structured
             * error (OpenRouter's `openrouter_credits`). When the body carries
             * no code, `http_<status>`, but only for a status the provider
             * documents with a single balance meaning (DeepSeek's `http_402`).
             * Never message text, and never a status with several meanings such
             * as 403 or 429. Must match `^[a-z0-9._-]{1,64}$`.
             */
            providerCode: string
          }
      ))
  | {
      sessionId: string
      kind: 'turn_notes_supported'
      model: string
      supported: boolean
    }
  | {
      sessionId: string
      kind: 'turn_note_skipped'
      after_tool_use_id: string
      reason:
        | 'anchor_missing'
        | 'before_user_message'
        | 'unsupported_model'
        | 'not_oauth'
    }
  | {
      sessionId: string
      kind: 'wait'
      phase: 'start' | 'end'
      waitId: string
      reason: PluginWaitReason
      /** Absolute epoch-millisecond time of the next attempt. */
      nextMs?: number
      attempt?: number
      /** Fixed plugin text, never provider text, an account label or an id. */
      message?: string
      outcome?: 'resumed' | 'cancelled' | 'abandoned'
    }
  | {
      sessionId: string
      kind: 'billing'
      attemptId: string
      requestKind: BillingRequestKind
      credentialId: string
      accountId?: string
      provider: string
      model: string
      outcome: BillingOutcome
      providerRequestId?: string
      providerResponseId?: string
      userMessageId?: string
      status?: number
      attempt?: number
      chargeBasis?: 'subscription_included' | 'metered_api'
      usage?: BillingUsage
      usageByModel?: readonly { modelUsed: string; usage: BillingUsage }[]
      cache?: {
        ttlMs?: number
        implicit?: true
        warming?: { on: boolean; stopReason?: CacheWarmStopReason }
      }
    }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function billingCache(value: unknown): Record<string, unknown> | undefined {
  if (!isObject(value) || Array.isArray(value)) return
  const { ttlMs, implicit, warming } = value
  const cache: Record<string, unknown> = {}
  // Conflicting lifetime claims cannot prove what the request cached.
  if (!(ttlMs !== undefined && implicit !== undefined)) {
    if (typeof ttlMs === 'number' && Number.isSafeInteger(ttlMs) && ttlMs > 0) {
      cache.ttl_ms = ttlMs
    } else if (implicit === true) {
      cache.implicit = true
    }
  }
  if (isObject(warming) && !Array.isArray(warming)) {
    const { on, stopReason } = warming
    if (typeof on === 'boolean') {
      cache.warming = {
        on,
        ...(!on && isCacheWarmStopReason(stopReason)
          ? { stop_reason: stopReason }
          : {}),
      }
    }
  }
  return Object.keys(cache).length > 0 ? cache : undefined
}

function billingUsage(
  value: unknown,
): Record<string, number | boolean> | undefined {
  if (!isObject(value) || Array.isArray(value)) return
  const usage: Record<string, number | boolean> = {}
  for (const [inputKey, payloadKey] of [
    ['input', 'input'],
    ['output', 'output'],
    ['cacheRead', 'cache_read'],
    ['cacheWrite', 'cache_write'],
    ['cacheWrite5m', 'cache_write_5m'],
    ['cacheWrite1h', 'cache_write_1h'],
    ['reasoning', 'reasoning'],
  ] as const) {
    const count = value[inputKey]
    if (
      typeof count === 'number' &&
      Number.isSafeInteger(count) &&
      count >= 0
    ) {
      usage[payloadKey] = count
    }
  }
  const reasoningIncludedInOutput = value.reasoningIncludedInOutput
  if (typeof reasoningIncludedInOutput === 'boolean') {
    usage.reasoning_included_in_output = reasoningIncludedInOutput
  }
  return Object.keys(usage).length > 0 ? usage : undefined
}

/**
 * Read advisory input for request shaping, in landing order, without persisting
 * it. If no routing handle is available or the runner does not serve the route,
 * returns [].
 */
export function turnNotes(
  sessionId: string,
): readonly { afterToolUseId: string; text: string }[] {
  try {
    const handle = routingHandle(sessionId)
    if (!handle) return []
    const read = handle.turn_notes
    if (typeof read !== 'function') return []
    const answer: unknown = read.call(handle)
    if (isObject(answer) && typeof answer.then === 'function') {
      void Promise.resolve(answer).catch(() => {})
      return []
    }
    if (!Array.isArray(answer)) return []
    const notes: { afterToolUseId: string; text: string }[] = []
    const encoder = new TextEncoder()
    for (const entry of answer) {
      try {
        if (!isObject(entry) || Array.isArray(entry)) continue
        const afterToolUseId = entry.after_tool_use_id
        const text = entry.text
        if (
          typeof afterToolUseId !== 'string' ||
          afterToolUseId.length === 0 ||
          typeof text !== 'string' ||
          // A whitespace-only note says nothing and a provider may refuse it.
          text.trim().length === 0 ||
          encoder.encode(text).byteLength > 16_384
        )
          continue
        notes.push({ afterToolUseId, text })
      } catch {
        // One unreadable note entry must not hide its valid neighbours.
      }
    }
    return notes
  } catch {
    // Turn notes are optional and must not break request shaping.
    return []
  }
}

function selectionFor<Candidate extends RoutingCandidate>(
  answer: unknown,
  candidates: readonly Candidate[],
): RoutingSelection<Candidate> | undefined {
  if (!isObject(answer)) return undefined
  const accountId = answer.account_id
  const credentialId = answer.credential_id
  if (typeof accountId !== 'string') return undefined
  if (credentialId !== undefined && typeof credentialId !== 'string') {
    return undefined
  }
  const candidate = candidates.find(
    (route) =>
      route.accountId === accountId &&
      (credentialId === undefined || route.credentialId === credentialId),
  )
  if (!candidate) return undefined
  const hold = answer.hold
  const retryAfterMs = isObject(hold) ? hold.retry_after_ms : undefined
  if (
    typeof retryAfterMs === 'number' &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs >= 0
  ) {
    return { candidate, hold: { retry_after_ms: retryAfterMs } }
  }
  return { candidate }
}

function refusalFor(value: unknown): RoutingRefusal | undefined {
  if (!isObject(value)) return undefined
  const code = value.code
  if (
    code !== 'account_limit_exhausted' &&
    code !== 'account_selection_refused' &&
    code !== 'account_selection_final'
  ) {
    return undefined
  }
  const refused: RoutingRefusal['refused'] = { code }
  const routingCode = value.routing_code
  if (
    typeof routingCode === 'string' &&
    /^[a-z0-9._-]{1,64}$/.test(routingCode)
  ) {
    refused.routingCode = routingCode
  }
  const retryAfterSecs = value.retry_after_secs
  if (
    typeof retryAfterSecs === 'number' &&
    Number.isFinite(retryAfterSecs) &&
    retryAfterSecs >= 0
  ) {
    refused.retryAfterSecs = retryAfterSecs
  }
  const resetsAtMs = value.resets_at_ms
  if (
    typeof resetsAtMs === 'number' &&
    Number.isSafeInteger(resetsAtMs) &&
    resetsAtMs > 0
  ) {
    refused.resetsAtMs = resetsAtMs
  }
  return { refused }
}

/**
 * Ask routing for an eligible vault route. Any failure or unfamiliar answer
 * yields undefined so the plugin can keep its own choice. Opted-in routing
 * refusals instead stop the request. This does not admit routes. Callers pass
 * only accounts that may serve: not ones the vault refused, and not ones a rule
 * the user set rules out (an enabled killswitch floor, a per-model account
 * list). Routing's pick among those candidates is final. Don't reject it under
 * a local floor, and don't add floors of the plugin's own that duplicate
 * routing's reserves.
 */
export function askRouting<
  Candidate extends RoutingCandidate,
  Refusals extends boolean = false,
>(
  input: AskRoutingInput<Candidate, Refusals>,
): Promise<
  | RoutingSelection<Candidate>
  | (Refusals extends true ? RoutingRefusal : never)
  | undefined
>
export async function askRouting<Candidate extends RoutingCandidate>(
  input: AskRoutingInput<Candidate, boolean>,
): Promise<RoutingSelection<Candidate> | RoutingRefusal | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const handle = routingHandle(input.sessionId)
    if (!handle) return undefined
    const accountFor = handle.accountFor
    if (typeof accountFor !== 'function') return undefined
    const requested = input.deadlineMs ?? 1500
    const deadlineMs = Number.isNaN(requested)
      ? 1500
      : Math.min(2000, Math.max(1, requested))
    const expired = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), deadlineMs)
      timer.unref()
    })
    const request: Record<string, unknown> = {
      provider: input.provider,
      modelId: input.modelId,
    }
    const cap = input.holdWaitMaxS
    if (typeof cap === 'number' && Number.isFinite(cap)) {
      request.hold_wait_max_s = Math.max(0, Math.floor(cap))
    }
    if (input.refusals === true) request.refusals = true
    const pending: unknown = accountFor.call(handle, request, { deadlineMs })
    if (!isObject(pending) || typeof pending.then !== 'function')
      return undefined
    const answer: unknown = await Promise.race([pending, expired])
    if (input.refusals === true && isObject(answer) && 'refused' in answer) {
      return refusalFor(answer.refused)
    }
    return selectionFor(answer, input.candidates)
  } catch {
    // The process-global bridge is optional and must not break authentication.
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Report a vault request, billing result, plugin wait or turn-note event without
 * waiting for routing. Only contract fields are sent, and all accessor failures
 * are ignored. Headers must already be limited to rate-limit headers by the
 * caller; values are not filtered or redacted here.
 */
export function reportRouting(input: ReportRoutingInput): void {
  try {
    const sessionId = input.sessionId
    const handle = routingHandle(sessionId)
    if (!handle) return
    const report = handle.report
    if (typeof report !== 'function') return
    let payload: unknown
    if ('kind' in input) {
      switch (input.kind) {
        case 'wait': {
          const { phase, waitId, reason, nextMs, attempt, message, outcome } =
            input
          if (
            !isNonEmptyString(sessionId) ||
            (phase !== 'start' && phase !== 'end') ||
            !isNonEmptyString(waitId) ||
            waitId.length > 64 ||
            /[^A-Za-z0-9._:-]/.test(waitId) ||
            !PLUGIN_WAIT_REASONS.includes(reason)
          )
            return
          payload = {
            kind: 'wait',
            phase,
            wait_id: waitId,
            reason,
            ...(typeof nextMs === 'number' &&
            Number.isSafeInteger(nextMs) &&
            nextMs > 0
              ? { next_ms: nextMs }
              : {}),
            ...(typeof attempt === 'number' &&
            Number.isInteger(attempt) &&
            attempt >= 1
              ? { attempt }
              : {}),
            ...(typeof message === 'string' &&
            message.length >= 1 &&
            message.length <= 160 &&
            !/\p{Cc}/u.test(message)
              ? { message }
              : {}),
            ...(phase === 'end' &&
            (outcome === 'resumed' ||
              outcome === 'cancelled' ||
              outcome === 'abandoned')
              ? { outcome }
              : {}),
          }
          break
        }
        case 'billing': {
          const {
            attemptId,
            requestKind,
            credentialId,
            provider,
            model,
            outcome,
            accountId,
            providerRequestId,
            providerResponseId,
            userMessageId,
            status,
            attempt,
            chargeBasis,
            usage: inputUsage,
            usageByModel: inputUsageByModel,
            cache: inputCache,
          } = input
          if (
            !isNonEmptyString(attemptId) ||
            !isNonEmptyString(credentialId) ||
            !isNonEmptyString(provider) ||
            !isNonEmptyString(model) ||
            (requestKind !== 'primary' &&
              requestKind !== 'title' &&
              requestKind !== 'compaction' &&
              requestKind !== 'generate' &&
              requestKind !== 'keep_warm' &&
              requestKind !== 'prime') ||
            (outcome !== 'completed' &&
              outcome !== 'cut' &&
              outcome !== 'failed')
          )
            return
          const usage = billingUsage(inputUsage)
          const cache = billingCache(inputCache)
          const usageByModel: Record<string, unknown>[] = []
          if (Array.isArray(inputUsageByModel)) {
            for (const entry of inputUsageByModel) {
              if (!isObject(entry) || Array.isArray(entry)) continue
              const modelUsed = entry.modelUsed
              if (!isNonEmptyString(modelUsed)) continue
              const modelUsage = billingUsage(entry.usage)
              // Thalamus rejects the whole report when an entry has no usage
              // object, so an entry without a valid reading is dropped.
              if (!modelUsage) continue
              usageByModel.push({ model_used: modelUsed, usage: modelUsage })
            }
          }
          payload = {
            kind: 'billing',
            attempt_id: attemptId,
            request_kind: requestKind,
            credential_id: credentialId,
            provider,
            model,
            outcome,
            ...(isNonEmptyString(accountId) ? { account_id: accountId } : {}),
            ...(isNonEmptyString(providerRequestId)
              ? { provider_request_id: providerRequestId }
              : {}),
            ...(isNonEmptyString(providerResponseId)
              ? { provider_response_id: providerResponseId }
              : {}),
            ...(isNonEmptyString(userMessageId)
              ? { user_message_id: userMessageId }
              : {}),
            ...(typeof status === 'number' &&
            Number.isInteger(status) &&
            status >= 0
              ? { status }
              : {}),
            ...(typeof attempt === 'number' &&
            Number.isInteger(attempt) &&
            attempt >= 1
              ? { attempt }
              : {}),
            ...(chargeBasis === 'subscription_included' ||
            chargeBasis === 'metered_api'
              ? { charge_basis: chargeBasis }
              : {}),
            ...(usage ? { usage } : {}),
            ...(usageByModel.length > 0
              ? { usage_by_model: usageByModel }
              : {}),
            ...(cache ? { cache } : {}),
          }
          break
        }
        case 'turn_notes_supported': {
          const { model, supported } = input
          if (
            typeof model !== 'string' ||
            model.length === 0 ||
            typeof supported !== 'boolean'
          )
            return
          payload = {
            kind: 'turn_notes_supported',
            model,
            supported,
          }
          break
        }
        case 'turn_note_skipped': {
          const { after_tool_use_id, reason } = input
          if (
            typeof after_tool_use_id !== 'string' ||
            after_tool_use_id.length === 0 ||
            (reason !== 'anchor_missing' &&
              reason !== 'before_user_message' &&
              reason !== 'unsupported_model' &&
              reason !== 'not_oauth')
          )
            return
          payload = {
            kind: 'turn_note_skipped',
            after_tool_use_id,
            reason,
          }
          break
        }
        default:
          return
      }
    } else {
      const identity = {
        account_id: input.accountId,
        ...(input.credentialId !== undefined
          ? { credential_id: input.credentialId }
          : {}),
      }
      switch (input.outcome) {
        case 'served':
          payload = { ...identity, outcome: 'served', headers: input.headers }
          break
        case 'exhausted': {
          const { window, pool } = input
          if (window !== '5h' && window !== '7d') return
          // An undefined pool means the whole account, as an omitted one does.
          if (
            pool !== undefined &&
            (typeof pool !== 'string' || !/^[a-z0-9._-]{1,64}$/.test(pool))
          )
            return
          payload = {
            ...identity,
            outcome: 'exhausted',
            window,
            ...(pool ? { pool } : {}),
            ...(input.resetsAt !== undefined
              ? { resets_at: input.resetsAt }
              : {}),
          }
          break
        }
        case 'credential_refused': {
          const { credentialId, providerCode } = input
          if (
            !isNonEmptyString(credentialId) ||
            typeof providerCode !== 'string' ||
            !/^[a-z0-9._-]{1,64}$/.test(providerCode)
          )
            return
          payload = {
            ...identity,
            outcome: 'credential_refused',
            provider_code: providerCode,
          }
          break
        }
        default:
          return
      }
    }
    // A broken bridge may return a rejected promise despite its void contract.
    const pending: unknown = report.call(handle, payload)
    if (isObject(pending) && typeof pending.then === 'function') {
      void Promise.resolve(pending).catch(() => {})
    }
  } catch {
    // Reporting must never change the result of an auth request.
  }
}
