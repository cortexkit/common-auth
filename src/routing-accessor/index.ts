// Optional THALAMUS routing for vault mode only. Account ids here are vault
// account ids; local pool rows are not known to the routing engine.

import { routingHandle } from './hold-cap.js'

export { holdWaitMaxS } from './hold-cap.js'

/** An eligible vault route, not a local pool row. */
export interface RoutingCandidate {
  /** Vault account id, not the plugin's route id. */
  accountId: string
  credentialId: string
}

export interface AskRoutingInput<
  Candidate extends RoutingCandidate = RoutingCandidate,
> {
  sessionId: string
  provider: string
  modelId: string
  /** Only routes already eligible under the plugin's vault and killswitch rules. */
  candidates: readonly Candidate[]
  /** Defaults to 500 ms, clamped to 1–2000 ms. */
  deadlineMs?: number
  /**
   * Longest same-account hold, in seconds, that routing may advise. The
   * holdWaitMaxS helper caps it by the setting and the current account's cache
   * expiry, returning 0 when there is no accepted prompt cache worth waiting
   * for. Fractions are floored and negatives become 0. Omit it to leave
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

interface RoutingReportIdentity {
  sessionId: string
  accountId: string
  credentialId?: string
}

export type ReportRoutingInput = RoutingReportIdentity &
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
  )

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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

/**
 * Ask routing for an eligible vault route. Any failure or unfamiliar answer
 * yields undefined so the plugin can keep its own choice. This does not admit
 * routes: callers must exclude vault refusals and killswitch-blocked accounts.
 */
export async function askRouting<Candidate extends RoutingCandidate>(
  input: AskRoutingInput<Candidate>,
): Promise<RoutingSelection<Candidate> | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const handle = routingHandle(input.sessionId)
    if (!handle) return undefined
    const accountFor = handle.accountFor
    if (typeof accountFor !== 'function') return undefined
    const requested = input.deadlineMs ?? 500
    const deadlineMs = Number.isNaN(requested)
      ? 500
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
    const pending: unknown = accountFor.call(handle, request, { deadlineMs })
    if (!isObject(pending) || typeof pending.then !== 'function')
      return undefined
    const answer: unknown = await Promise.race([pending, expired])
    return selectionFor(answer, input.candidates)
  } catch {
    // The process-global bridge is optional and must not break authentication.
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Report a vault request without waiting for routing. Only contract fields are
 * sent, and all accessor failures are ignored. Headers must already be limited
 * to rate-limit headers by the caller; values are not filtered or redacted here.
 */
export function reportRouting(input: ReportRoutingInput): void {
  try {
    const handle = routingHandle(input.sessionId)
    if (!handle) return
    const report = handle.report
    if (typeof report !== 'function') return
    const identity = {
      account_id: input.accountId,
      ...(input.credentialId !== undefined
        ? { credential_id: input.credentialId }
        : {}),
    }
    let payload: unknown
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
      default:
        return
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
