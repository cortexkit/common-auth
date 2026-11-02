import { describe, expect, test } from 'bun:test'
import {
  buildRefusal,
  ClaudeIncompleteError,
  type HttpRefusal,
  type OpenCode1Family,
  registerLimitMessages,
  retryAfterSeconds,
} from '../../src/limits/index.js'

const now = 1_700_000_000_000
const messages = registerLimitMessages({
  retryable: { quota: () => 'Provider quota reached.' },
  refusals: { quota: () => 'No account is available.' },
})

function http(family: OpenCode1Family, retryAfterMs = 61_001): HttpRefusal {
  const result = buildRefusal({
    family,
    messageKey: 'quota',
    messages,
    now,
    retryAfterMs,
  })
  if (result.kind !== 'http') throw new Error('Expected HTTP refusal')
  return result
}

describe('OpenCode 1 refusal families', () => {
  const vectors = [
    {
      family: 'openai-429',
      status: 429,
      retryable: true,
      hostRetry: 'leave',
      body: {
        error: {
          message: 'Provider quota reached.',
          type: 'rate_limit_exceeded',
          code: 'rate_limit_exceeded',
        },
      },
    },
    {
      family: 'claude-429',
      status: 429,
      retryable: true,
      hostRetry: 'leave',
      body: {
        type: 'error',
        error: { type: 'rate_limit_error', message: 'Provider quota reached.' },
      },
    },
    {
      family: 'json-412',
      status: 412,
      retryable: false,
      hostRetry: 'veto',
      body: {
        error: {
          code: 412,
          status: 'FAILED_PRECONDITION',
          message: 'No account is available.',
        },
      },
    },
    {
      family: 'claustrum-429',
      status: 429,
      retryable: true,
      hostRetry: 'leave',
      body: { error: 'claustrum-auth: accounts-rate-limited' },
    },
  ] as const

  for (const vector of vectors) {
    test(`${vector.family} owns status, envelope and retry attributes`, () => {
      const result = http(vector.family)
      expect(result.status).toBe(vector.status)
      expect(result.retryable).toBe(vector.retryable)
      expect(result.hostRetry).toBe(vector.hostRetry)
      expect(result.disposition).toBe('refuse')
      expect(result.family).toBe(vector.family)
      expect(JSON.parse(result.body)).toEqual(vector.body)
      expect(Object.fromEntries(result.headers)).toEqual({
        'content-type': 'application/json',
        'retry-after': '62',
      })
    })
  }

  test('Claude incomplete is a retryable ECONNRESET, not an HTTP envelope', () => {
    const result = buildRefusal({
      family: 'claude-econnreset',
      messageKey: 'quota',
      messages,
      now,
    })
    expect(result.kind).toBe('throw')
    if (result.kind !== 'throw') throw new Error('Expected thrown refusal')
    expect(result.retryable).toBe(true)
    expect(result.hostRetry).toBe('leave')
    expect(result.disposition).toBe('refuse')
    expect(result.error).toBeInstanceOf(ClaudeIncompleteError)
    expect(result.error.message).toBe('Provider quota reached.')
    expect(result.error.code).toBe('ECONNRESET')
    expect(result.error.syscall).toBe('sticky-routing')
    expect(result.error.cause).toEqual({
      code: 'ECONNRESET',
      syscall: 'sticky-routing',
    })
    expect(result.error.isRetryable).toBe(true)
    expect('status' in result).toBe(false)
  })

  test('JSON 412 preserves extra headers, but library metadata is authoritative', () => {
    const extraHeaders = new Headers({
      'x-provider-guidance': 'kept',
      'content-type': 'text/plain',
      'retry-after': '999',
    })
    const result = buildRefusal({
      family: 'json-412',
      messageKey: 'quota',
      now,
      retryAfterMs: 5700_000,
      noticeDelayMs: 1501,
      extraHeaders,
    })
    if (result.kind !== 'http') throw new Error('Expected HTTP refusal')
    expect(Object.fromEntries(result.headers)).toEqual({
      'x-provider-guidance': 'kept',
      'content-type': 'application/json',
      'retry-after': '5699',
    })
    expect(extraHeaders.get('retry-after')).toBe('999')
    const unknown = buildRefusal({
      family: 'json-412',
      messageKey: 'quota',
      now,
      extraHeaders,
    })
    if (unknown.kind !== 'http') throw new Error('Expected HTTP refusal')
    expect(unknown.headers.get('retry-after')).toBeNull()
    expect(unknown.headers.get('x-provider-guidance')).toBe('kept')
  })

  test('other HTTP families do not accept replacement headers', () => {
    for (const family of [
      'openai-429',
      'claude-429',
      'claustrum-429',
    ] as const) {
      const result = buildRefusal({
        family,
        messageKey: 'quota',
        now,
        extraHeaders: { 'x-private': 'not copied', 'retry-after': '999' },
      })
      if (result.kind !== 'http') throw new Error('Expected HTTP refusal')
      expect(Object.fromEntries(result.headers)).toEqual({
        'content-type': 'application/json',
      })
    }
  })
})

describe('post-notice retry metadata', () => {
  test.each([
    [0, 0, 0],
    [1, 0, 1],
    [1001, 0, 2],
    [2001, 1001, 1],
    [2001, 1000, 2],
    [1000, 1000, 0],
    [1000, 1001, undefined],
    [-1, 0, undefined],
    [Number.NaN, 0, undefined],
    [Number.POSITIVE_INFINITY, 0, undefined],
    [Number.NEGATIVE_INFINITY, 0, undefined],
    [undefined, 0, undefined],
  ])(
    'ceil(%s ms after %s ms notice) is %s seconds',
    (estimate, delay, expected) => {
      expect(retryAfterSeconds(estimate, delay)).toBe(expected)
      for (const family of [
        'json-412',
        'openai-429',
        'claude-429',
        'claustrum-429',
      ] as const) {
        const result = buildRefusal({
          family,
          messageKey: 'quota',
          now,
          retryAfterMs: estimate,
          noticeDelayMs: delay,
        })
        if (result.kind !== 'http') throw new Error('Expected HTTP refusal')
        expect(result.headers.get('retry-after')).toBe(
          expected === undefined ? null : String(expected),
        )
      }
    },
  )

  test('shared text uses capped retry delay and true reset, both after the notice', () => {
    const result = buildRefusal({
      family: 'claude-429',
      messageKey: 'pool-empty',
      now,
      resetAt: now + 4 * 24 * 60 * 60_000 + 60_000,
      retryAfterMs: 900_000,
      noticeDelayMs: 60_000,
    })
    if (result.kind !== 'http') throw new Error('Expected HTTP refusal')
    expect(JSON.parse(result.body).error.message).toBe(
      'No account is available. Retry in 14m. Reset at 4d 0h 0m.',
    )
    expect(result.headers.get('retry-after')).toBe('840')
  })

  test('non-retryable shared text has only a true-reset clause even with metadata', () => {
    for (const family of ['json-412', 'pi-final'] as const) {
      const result = buildRefusal({
        family,
        messageKey: 'pool-empty',
        now,
        resetAt: now + 5700_000,
        retryAfterMs: 5700_000,
      })
      if (result.kind === 'throw') throw new Error('Expected surfaced refusal')
      expect(result.body).toContain('Reset at 1h 35m.')
      expect(result.body.toLowerCase()).not.toContain('retry in')
      expect(result.retryable).toBe(false)
      expect(result.hostRetry).toBe('veto')
      if (result.kind === 'http')
        expect(result.headers.get('retry-after')).toBe('5700')
    }
  })

  test('plugin reset formatter receives post-notice time in shared default text', () => {
    const seen: unknown[] = []
    const result = buildRefusal({
      family: 'json-412',
      messageKey: 'quota',
      now,
      resetAt: now + 90_000,
      noticeDelayMs: 30_000,
      messages: registerLimitMessages({
        formatReset: (input) => {
          seen.push(input)
          return 'one minute'
        },
      }),
    })
    if (result.kind !== 'http') throw new Error('Expected HTTP refusal')
    expect(seen).toEqual([{ resetAt: now + 90_000, now: now + 30_000 }])
    expect(JSON.parse(result.body).error.message).toBe(
      'No account is available. Reset at one minute.',
    )
  })

  test('retryable recorded-format templates keep their exact text', () => {
    const result = buildRefusal({
      family: 'claude-429',
      messageKey: 'recorded',
      messages: registerLimitMessages({
        retryable: { recorded: () => 'Retry in 429m 0s' },
      }),
      now,
    })
    if (result.kind !== 'http') throw new Error('Expected HTTP refusal')
    expect(JSON.parse(result.body).error.message).toBe('Retry in 429m 0s')
  })
})
