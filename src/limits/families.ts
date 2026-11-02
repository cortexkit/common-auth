import { formatDuration, formatReset } from './duration.js'
import { containsEmail, sanitizeRefusalLabel } from './labels.js'
import {
  hasUnsafeWording,
  type LimitMessages,
  type MessageParameters,
} from './wording.js'

export type OpenCode1Family =
  | 'openai-429'
  | 'claude-429'
  | 'json-412'
  | 'claustrum-429'
  | 'claude-econnreset'

export type RefusalFamily = OpenCode1Family | 'pi-final'
export type HostRetry = 'leave' | 'veto'

export interface RefusalInput {
  readonly family: RefusalFamily
  readonly messageKey: string
  readonly messages?: LimitMessages
  readonly parameters?: { readonly labels?: readonly string[] }
  /**
   * The confirmed-affinity preset's adapter opts in for re-login guidance only.
   * Ordinary refusals omit labels, even when the caller supplies them.
   */
  readonly labelPolicy?: 'relogin'
  readonly now: number
  /** A retained reset, already filtered for freshness by the decision layer. */
  readonly resetAt?: number
  readonly retryAfterMs?: number
  /** Time already spent presenting a notice, not an instruction to sleep. */
  readonly noticeDelayMs?: number
  /** Additional provider headers are preserved by the JSON 412 family only. */
  readonly extraHeaders?: ConstructorParameters<typeof Headers>[0]
}

interface RefusalAttributes {
  readonly family: RefusalFamily
  readonly disposition: 'refuse'
  readonly retryable: boolean
  readonly hostRetry: HostRetry
}

export interface HttpRefusal extends RefusalAttributes {
  readonly kind: 'http'
  readonly status: 412 | 429
  readonly headers: Headers
  readonly body: string
}

export interface TextRefusal extends RefusalAttributes {
  readonly kind: 'text'
  readonly body: string
}

export class ClaudeIncompleteError extends Error {
  readonly code = 'ECONNRESET'
  readonly syscall = 'sticky-routing'
  readonly isRetryable = true

  constructor(message: string) {
    super(message, { cause: { code: 'ECONNRESET', syscall: 'sticky-routing' } })
    this.name = 'ClaudeIncompleteError'
  }
}

export interface ThrownRefusal extends RefusalAttributes {
  readonly kind: 'throw'
  readonly error: ClaudeIncompleteError
}

export type BuiltRefusal = HttpRefusal | TextRefusal | ThrownRefusal

/** Compute metadata at delivery time, after time spent showing a notice. */
export function retryAfterSeconds(
  retryAfterMs: number | undefined,
  noticeDelayMs = 0,
): number | undefined {
  if (
    retryAfterMs === undefined ||
    !Number.isFinite(retryAfterMs) ||
    retryAfterMs < 0
  ) {
    return undefined
  }
  const remaining = retryAfterMs - elapsedNotice(noticeDelayMs)
  return remaining >= 0 ? Math.ceil(remaining / 1000) : undefined
}

function elapsedNotice(ms: number): number {
  return Number.isFinite(ms) && ms >= 0 ? ms : 0
}

function keptReset(input: RefusalInput): number | undefined {
  return input.resetAt !== undefined && Number.isFinite(input.resetAt)
    ? input.resetAt
    : undefined
}

function resetClause(reset: string | undefined): string {
  return reset === undefined ? 'The reset is unknown.' : `Reset at ${reset}.`
}

function defaultText(
  family: RefusalFamily,
  reset: string | undefined,
  retry: number | undefined,
  nonRetryable: boolean,
): string {
  const retryClause =
    !nonRetryable && retry !== undefined
      ? ` Retry in ${formatDuration(retry * 1000)}.`
      : ''
  const start =
    family === 'pi-final'
      ? 'The request cannot continue.'
      : 'No account is available.'
  return `${start}${retryClause} ${resetClause(reset)}`
}

function fallbackText(
  input: RefusalInput,
  now: number,
  nonRetryable: boolean,
): string {
  const resetAt = keptReset(input)
  const reset =
    resetAt === undefined ? undefined : formatReset({ resetAt, now })
  const retry = retryAfterSeconds(input.retryAfterMs, input.noticeDelayMs)
  return defaultText(input.family, reset, retry, nonRetryable)
}

function textFor(input: RefusalInput, nonRetryable: boolean): string {
  const now = input.now + elapsedNotice(input.noticeDelayMs ?? 0)
  const fallback = () => fallbackText(input, now, nonRetryable)
  try {
    const resetAt = keptReset(input)
    const reset =
      resetAt === undefined
        ? undefined
        : (input.messages?.formatReset ?? formatReset)({ resetAt, now })
    const retry = retryAfterSeconds(input.retryAfterMs, input.noticeDelayMs)
    // Whitelist text parameters rather than forwarding decision facts, which may
    // contain account or credential identifiers. Labels are an explicit exception.
    const parameters: MessageParameters = Object.freeze({
      labels: Object.freeze(
        input.labelPolicy === 'relogin'
          ? (input.parameters?.labels ?? []).map(sanitizeRefusalLabel)
          : [],
      ),
      reset,
      retryIn:
        !nonRetryable && retry !== undefined
          ? formatDuration(retry * 1000)
          : undefined,
    })
    const rendered = input.messages?.render(
      input.messageKey,
      parameters,
      nonRetryable,
    )
    return typeof rendered === 'string'
      ? rendered
      : defaultText(input.family, reset, retry, nonRetryable)
  } catch {
    // A request must still get its refusal if a plugin's text renderer fails.
    return fallback()
  }
}

function bodyFor(family: RefusalFamily, message: string): string {
  switch (family) {
    case 'openai-429':
      return JSON.stringify({
        error: {
          message,
          type: 'rate_limit_exceeded',
          code: 'rate_limit_exceeded',
        },
      })
    case 'claude-429':
      return JSON.stringify({
        type: 'error',
        error: { type: 'rate_limit_error', message },
      })
    case 'json-412':
      return JSON.stringify({
        error: { code: 412, status: 'FAILED_PRECONDITION', message },
      })
    case 'claustrum-429':
      return JSON.stringify({ error: 'claustrum-auth: accounts-rate-limited' })
    default:
      return message
  }
}

/** Pure wire construction: the caller sends the response, emits text, or throws the error. */
export function buildRefusal(input: RefusalInput): BuiltRefusal {
  const nonRetryable =
    input.family === 'json-412' || input.family === 'pi-final'
  const attributes: RefusalAttributes = {
    family: input.family,
    disposition: 'refuse',
    retryable: !nonRetryable,
    hostRetry: nonRetryable ? 'veto' : 'leave',
  }
  let body = bodyFor(input.family, textFor(input, nonRetryable))
  if (nonRetryable && (hasUnsafeWording(body) || containsEmail(body))) {
    // Rebuild from retained facts, never from plugin text or fact-supplied labels.
    const now = input.now + elapsedNotice(input.noticeDelayMs ?? 0)
    body = bodyFor(input.family, fallbackText(input, now, true))
  }
  if (input.family === 'claude-econnreset') {
    return {
      ...attributes,
      kind: 'throw',
      error: new ClaudeIncompleteError(body),
    }
  }
  if (input.family === 'pi-final') return { ...attributes, kind: 'text', body }
  const headers = new Headers(
    input.family === 'json-412' ? input.extraHeaders : undefined,
  )
  headers.set('content-type', 'application/json')
  // Only the library's post-notice estimate may control this header, including
  // when a provider supplied an old Retry-After among the extra headers.
  headers.delete('retry-after')
  const retry = retryAfterSeconds(input.retryAfterMs, input.noticeDelayMs)
  if (retry !== undefined) headers.set('retry-after', String(retry))
  return {
    ...attributes,
    kind: 'http',
    status: input.family === 'json-412' ? 412 : 429,
    headers,
    body,
  }
}
