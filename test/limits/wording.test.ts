import { describe, expect, test } from 'bun:test'
import {
  buildRefusal,
  formatDuration,
  hasUnsafeWording,
  type MessageParameters,
  type RefusalFamily,
  registerLimitMessages,
  sanitizeRefusalLabel,
  UnsafeWordingError,
} from '../../src/limits/index.js'

const now = 1_700_000_000_000

// Independent oracle: OpenCode 1's seven groups (src/redaction/index.ts:142-150).
const openCode1 = [
  /429|500|502|503|504|524/i,
  /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
  /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
  /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
  /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
  /try your request again|retry your request|resource exhausted|resource_exhausted/i,
  /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i,
]

// Version-cited fixture copied from @earendil-works/pi-ai@1.4.0
// dist/utils/retry.js:26-106, RETRYABLE_PROVIDER_ERROR_PATTERN. The installed
// dev dependency is older and is deliberately not the oracle for this contract.
const pi140 = new RegExp(
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

function unsafeByHost(text: string): boolean {
  return openCode1.some((pattern) => pattern.test(text)) || pi140.test(text)
}

function body(family: RefusalFamily, resetAt?: number): string {
  const result = buildRefusal({
    family,
    messageKey: 'pool-empty',
    now,
    resetAt,
  })
  if (result.kind === 'throw') throw new Error('Expected surfaced refusal')
  return result.body
}

describe('new duration rendering', () => {
  test.each([
    [45_000, '45s'],
    [61_000, '2m'],
    [11 * 60_000, '11m'],
    [90 * 60_000, '1h 30m'],
    [4 * 24 * 60 * 60_000, '4d 0h 0m'],
    [100 * 24 * 60 * 60_000, 'over 99 days'],
    [101 * 24 * 60 * 60_000, 'over 99 days'],
    [1, '1s'],
    [59_001, '1m'],
    [60_001, '2m'],
    [0, '0s'],
    [-1000, '0s'],
    [Number.NaN, 'unknown'],
    [Number.POSITIVE_INFINITY, 'unknown'],
  ])('%s ms renders as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected)
  })

  test('every reset from 1 second through 30 days is safe, including complete refusals', () => {
    const seen = new Set<string>()
    const end = 30 * 24 * 60 * 60
    for (let seconds = 1; seconds <= end; seconds++) {
      const duration = formatDuration(seconds * 1000)
      // Every second is rendered; repeated minute strings share the same host
      // match result. Check the complete bodies at each distinct rendering too.
      if (seen.has(duration)) continue
      seen.add(duration)
      if (unsafeByHost(duration))
        throw new Error(`Unsafe duration at ${seconds}s: ${duration}`)
      for (const family of ['json-412', 'pi-final'] as const) {
        const rendered = body(family, now + seconds * 1000)
        if (unsafeByHost(rendered))
          throw new Error(`Unsafe ${family} at ${seconds}s: ${rendered}`)
      }
    }
    expect(seen.size).toBe(59 + 30 * 24 * 60)
    expect(unsafeByHost(body('json-412'))).toBe(false)
    expect(unsafeByHost(body('pi-final'))).toBe(false)
    // Exhaustive by design: about 0.3 s on Bun 1.4, but Bun 1.3.14's regex
    // engine takes 4-9 s for the 43,259 distinct renderings, past the 5 s default.
  }, 30_000)
})

describe('template registration', () => {
  test.each([
    '429m',
    '1500 requests',
    'rate_limit_error',
    'service-unavailable',
    'ECONNRESET',
    'request timed out',
    'resource exhausted',
    'try again later',
    'server_busy',
    '520',
    'service is temporarily unavailable',
    'The upstream provider returned an error',
    'request to example.test failed, reason:',
    'WebSocket closed',
    'stream ended before a terminal response event',
    'pending stream has been canceled',
    'ResourceExhausted',
    'subscription_sharing_user_unavailable',
  ])('rejects host replay trigger: %s', (text) => {
    expect(unsafeByHost(text)).toBe(true)
    expect(hasUnsafeWording(text)).toBe(true)
    try {
      registerLimitMessages({ refusals: { unsafe: () => text } })
      throw new Error('Registration accepted unsafe text')
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeWordingError)
      expect((error as UnsafeWordingError).code).toBe('unsafe-wording')
      expect((error as UnsafeWordingError).messageKey).toBe('unsafe')
    }
  })

  test('checks representative parameters and the longest duration at registration', () => {
    const seen: MessageParameters[] = []
    registerLimitMessages({
      refusals: {
        quota: (parameters) => {
          seen.push(parameters)
          return 'No account is available.'
        },
      },
    })
    expect(seen.some((parameters) => parameters.reset === 'over 99 days')).toBe(
      true,
    )
    expect(seen.some((parameters) => parameters.reset === '99d 23h 59m')).toBe(
      true,
    )
    expect(seen.some((parameters) => parameters.reset === undefined)).toBe(true)
    expect(
      seen.some((parameters) => parameters.labels.includes('this account')),
    ).toBe(true)
    expect(seen.every((parameters) => parameters.retryIn === undefined)).toBe(
      true,
    )
  })

  test('validates substitutions, not only the literal part of a template', () => {
    expect(() =>
      registerLimitMessages({
        refusals: {
          quota: ({ reset }) =>
            reset === 'over 99 days' ? 'timeout' : 'No account.',
        },
      }),
    ).toThrow(UnsafeWordingError)
  })
})

describe('runtime refusal safety', () => {
  for (const family of ['json-412', 'pi-final'] as const) {
    for (const resetAt of [undefined, now + 429 * 60_000]) {
      test(`${family} unsafe runtime template falls back with ${resetAt === undefined ? 'unknown' : 'known'} reset`, () => {
        const messages = registerLimitMessages({
          refusals: {
            quota: ({ labels }) =>
              labels.includes('runtime')
                ? 'try again in 429m'
                : 'No account is available.',
          },
        })
        const input = {
          family,
          messageKey: 'quota',
          now,
          resetAt,
          retryAfterMs: 900_000,
          extraHeaders: { 'x-guidance': 'kept' },
        }
        const expected = buildRefusal(input)
        const actual = buildRefusal({
          ...input,
          messages,
          labelPolicy: 'relogin',
          parameters: { labels: ['runtime'] },
        })
        expect(actual).toEqual(expected)
        if (actual.kind === 'throw')
          throw new Error('Expected surfaced refusal')
        expect(unsafeByHost(actual.body)).toBe(false)
        expect(actual.body).not.toContain('runtime')
        expect(actual.body).toContain(
          resetAt === undefined ? 'reset is unknown' : 'Reset at 7h 9m',
        )
        expect(actual.body.toLowerCase()).not.toContain('retry in')
      })
    }

    test(`${family} unsafe runtime reset formatter falls back without changing delivery`, () => {
      const input = {
        family,
        messageKey: 'quota',
        now,
        resetAt: now + 429 * 60_000,
        retryAfterMs: 900_000,
      }
      const messages = registerLimitMessages({
        refusals: {
          quota: ({ reset }) => `No account is available. Reset at ${reset}.`,
        },
        formatReset: () => '429m',
      })
      const result = buildRefusal({ ...input, messages })
      expect(result).toEqual(buildRefusal(input))
      if (result.kind === 'throw') throw new Error('Expected surfaced refusal')
      expect(result.body).toContain('Reset at 7h 9m')
      expect(unsafeByHost(result.body)).toBe(false)
    })

    test(`${family} unknown reset never calls an unsafe reset formatter`, () => {
      let calls = 0
      const messages = registerLimitMessages({
        formatReset: () => {
          calls++
          throw new Error('No retained reset was supplied')
        },
      })
      const result = buildRefusal({
        family,
        messageKey: 'quota',
        now,
        messages,
      })
      expect(result).toEqual(buildRefusal({ family, messageKey: 'quota', now }))
      expect(calls).toBe(0)
    })

    test(`${family} renderer exceptions also use the safe retained-facts fallback`, () => {
      let requestPath = false
      const messages = registerLimitMessages({
        refusals: {
          quota: () => {
            if (requestPath) throw new UnsafeWordingError('quota')
            return 'No account is available.'
          },
        },
      })
      requestPath = true
      expect(
        buildRefusal({ family, messageKey: 'quota', now, messages }),
      ).toEqual(buildRefusal({ family, messageKey: 'quota', now }))
    })
  }
})

describe('refusal privacy', () => {
  test.each([
    ['person@example.test', 'this account'],
    ['Main <person@example.test>', 'this account'],
    ['my-429-account', 'this account'],
    ['Try again later', 'this account'],
    ['ResourceExhausted', 'this account'],
    ['Personal account', 'Personal account'],
  ])('sanitizes %s to %s', (label, expected) => {
    expect(sanitizeRefusalLabel(label)).toBe(expected)
  })

  test('builder sanitizes labels before the plugin template sees them', () => {
    let received: MessageParameters | undefined
    const messages = registerLimitMessages({
      refusals: {
        relogin: (parameters) => {
          received = parameters
          return `Sign in to ${parameters.labels.join(' and ')}.`
        },
      },
    })
    for (const family of ['json-412', 'pi-final'] as const) {
      const result = buildRefusal({
        family,
        messageKey: 'relogin',
        now,
        messages,
        labelPolicy: 'relogin',
        parameters: { labels: ['person@example.test', '429m', 'Personal'] },
      })
      expect(received?.labels).toEqual([
        'this account',
        'this account',
        'Personal',
      ])
      if (result.kind === 'throw') throw new Error('Expected surfaced refusal')
      expect(result.body).toContain(
        'Sign in to this account and this account and Personal.',
      )
      expect(unsafeByHost(result.body)).toBe(false)
      expect(result.body).not.toContain('@')
    }
  })

  test('non-retryable templates receive no identifiers and ordinary refusals receive no labels', () => {
    const parameters = {
      labels: ['Private label'],
      accountId: 'account-secret',
      credentialId: 'credential-secret',
      vaultId: 'vault-secret',
      email: 'person@example.test',
    }
    const messages = registerLimitMessages({
      refusals: {
        quota: (params) => `Cannot continue. ${JSON.stringify(params)}`,
      },
    })
    for (const family of ['json-412', 'pi-final'] as const) {
      const result = buildRefusal({
        family,
        messageKey: 'quota',
        now,
        messages,
        parameters,
      })
      if (result.kind === 'throw') throw new Error('Expected surfaced refusal')
      for (const secret of Object.values(parameters).flat())
        expect(result.body).not.toContain(secret)
      expect(result.body).not.toContain('accountId')
      expect(result.body).not.toContain('credentialId')
      expect(result.body).not.toContain('vaultId')
    }
  })

  test('email in plugin text falls back even when it matches no host retry pattern', () => {
    const messages = registerLimitMessages({
      refusals: { quota: () => 'Sign in person@example.test' },
    })
    for (const family of ['json-412', 'pi-final'] as const) {
      const result = buildRefusal({
        family,
        messageKey: 'quota',
        now,
        messages,
      })
      expect(result).toEqual(buildRefusal({ family, messageKey: 'quota', now }))
    }
  })
})
