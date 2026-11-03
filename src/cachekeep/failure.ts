type FailureStage = 'authorization' | 'send' | 'response'

const ERROR_NAMES = ['AbortError', 'TimeoutError', 'TypeError'] as const
const NETWORK_CODES = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_HEADERS_OVERFLOW',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_RESPONSE_STATUS_CODE',
  'UND_ERR_INVALID_ARG',
  'UND_ERR_INVALID_RETURN_VALUE',
  'UND_ERR_ABORTED',
  'UND_ERR_CLIENT_DESTROYED',
  'UND_ERR_CLIENT_CLOSED',
  'UND_ERR_SOCKET',
  'UND_ERR_NOT_SUPPORTED',
  'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH',
  'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
  'UND_ERR_INFO',
  'UND_ERR_RES_EXCEEDED_MAX_SIZE',
  'UND_ERR_PRX_TLS',
] as const

function allowed<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return typeof value === 'string' && values.includes(value as T)
}

/** Keep diagnostics useful without retaining provider text, credentials or error causes. */
export function classifyFailure(
  error: unknown,
  stage: FailureStage,
  status?: number,
) {
  try {
    if (
      status !== undefined &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599 &&
      (status < 200 || status >= 300)
    ) {
      return { stage: 'response' as const, class: status }
    }
    if (typeof error === 'object' && error !== null) {
      const fields = error as {
        name?: unknown
        code?: unknown
        cause?: { code?: unknown }
      }
      const name = fields.name
      if (name === 'AbortError' || name === 'TimeoutError')
        return { stage, class: name }
      const code = fields.code
      if (allowed(NETWORK_CODES, code)) return { stage, class: code }
      const causeCode = fields.cause?.code
      if (allowed(NETWORK_CODES, causeCode)) return { stage, class: causeCode }
      if (allowed(ERROR_NAMES, name)) return { stage, class: name }
    }
  } catch {
    // Host errors can have throwing accessors; never inspect or stringify them further.
  }
  return { stage, class: 'unknown' as const }
}

export type Failure = ReturnType<typeof classifyFailure>
