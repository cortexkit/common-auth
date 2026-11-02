import type { ResetFormatter } from './duration.js'

// OpenCode 1 session/retry.ts, also recorded in src/redaction/index.ts. Body
// matches can trigger replay even when the error itself is non-retryable.
const openCode1Patterns = [
  /429|500|502|503|504|524/i,
  /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
  /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
  /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
  /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
  /try your request again|retry your request|resource exhausted|resource_exhausted/i,
  /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i,
]

// @earendil-works/pi-ai@1.4.0, dist/utils/retry.js:26-106,
// RETRYABLE_PROVIDER_ERROR_PATTERN. Pin this independently of the dev peer.
const pi140Pattern = new RegExp(
  [
    'overloaded',
    'server_busy',
    'servers are currently busy',
    'currently experiencing high demand',
    'model is at capacity',
    'rate.?limit',
    'too many requests',
    '(?<![a-z0-9])(?:429|500|502|503|504|520|524)(?![a-z0-9])',
    'service.?(?:is.?)?(?:temporarily.?)?unavailable',
    'server.?error',
    'internal.?error',
    'provider.?returned.?(?:an.?)?error',
    'exceeded request buffer limit while retrying upstream',
    'unable to forward upstream',
    'upstream.?request.?failed',
    'upstream_stream_read_error',
    'stream was interrupted',
    'http/?2 stream failed',
    'network.?error',
    'connection.?error',
    'connection.?refused',
    'connection.?lost',
    'other side closed',
    'fetch failed',
    'request to \\S+ failed, reason:',
    'getaddrinfo',
    'ENOTFOUND',
    'EAI_AGAIN',
    'upstream.?connect',
    'reset before headers',
    'socket hang up',
    'socket connection was closed',
    'timed? out',
    'timeout',
    'terminated',
    'websocket.?closed',
    'websocket.?error',
    'ended without',
    'stream ended before message_stop',
    'stream ended before a terminal response event',
    'http2 request did not get a response',
    'stream disconnected before completion',
    'pending stream has been canceled',
    'retry delay',
    'you can retry your request',
    'try your request again',
    'please retry your request',
    'ResourceExhausted',
    'subscription_sharing_usage_unavailable',
    'subscription_sharing_user_unavailable',
  ].join('|'),
  'i',
)

export function hasUnsafeWording(text: string): boolean {
  return (
    openCode1Patterns.some((pattern) => pattern.test(text)) ||
    pi140Pattern.test(text)
  )
}

export interface MessageParameters {
  readonly labels: readonly string[]
  readonly retryIn?: string
  readonly reset?: string
}

/** Templates return text only; they cannot replace a family's wire envelope. */
export type MessageTemplate = (parameters: MessageParameters) => string

export class UnsafeWordingError extends Error {
  readonly code = 'unsafe-wording'

  constructor(readonly messageKey: string) {
    super(`Unsafe refusal template: ${messageKey}`)
    this.name = 'UnsafeWordingError'
  }
}

export interface LimitMessageOptions {
  readonly refusals?: Readonly<Record<string, MessageTemplate>>
  readonly retryable?: Readonly<Record<string, MessageTemplate>>
  readonly formatReset?: ResetFormatter
}

export interface LimitMessages {
  readonly formatReset?: ResetFormatter
  readonly render: (
    messageKey: string,
    parameters: MessageParameters,
    nonRetryable: boolean,
  ) => string | undefined
}

/** Registration rejects unsafe fixed text; actual substitutions are checked again. */
export function registerLimitMessages(
  options: LimitMessageOptions,
): LimitMessages {
  const refusals = new Map(Object.entries(options.refusals ?? {}))
  const retryable = new Map(Object.entries(options.retryable ?? {}))
  for (const [key, template] of refusals) {
    for (const reset of [
      undefined,
      '45s',
      '2m',
      '1h 30m',
      '99d 23h 59m',
      'over 99 days',
    ]) {
      for (const labels of [[], ['this account']]) {
        const parameters = Object.freeze({
          labels: Object.freeze(labels),
          reset,
        })
        let rendered: string
        try {
          rendered = template(parameters)
        } catch {
          throw new UnsafeWordingError(key)
        }
        if (typeof rendered !== 'string' || hasUnsafeWording(rendered)) {
          throw new UnsafeWordingError(key)
        }
      }
    }
  }
  return Object.freeze({
    formatReset: options.formatReset,
    render: (
      key: string,
      parameters: MessageParameters,
      nonRetryable: boolean,
    ) => (nonRetryable ? refusals : retryable).get(key)?.(parameters),
  })
}
