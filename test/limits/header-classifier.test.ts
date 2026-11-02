import { describe, expect, test } from 'bun:test'
import {
  type ClassifierInput,
  classifyHeaders,
  classifyRetryAfter,
  markFromSignal,
  resolveHeaderReset,
} from '../../src/limits/index.js'

const now = Date.parse('2026-01-01T00:00:00Z')
function input(headers: Record<string, string>, status = 429): ClassifierInput {
  return {
    account: { namespace: 'test:pool', accountId: 'A', incarnation: '1' },
    status,
    headers: new Headers(headers),
    now,
    effectiveModel: 'claude-sonnet',
    readings: [],
  }
}

describe('generic header classifier', () => {
  const vectors: readonly [string, string, string, number | undefined][] = [
    ['Retry-After delta', 'Retry-After', '17', 17000],
    ['Retry-After fraction', 'Retry-After', '1.5', 1500],
    [
      'Retry-After HTTP-date',
      'Retry-After',
      'Thu, 01 Jan 2026 00:00:10 GMT',
      10000,
    ],
    [
      'Retry-After obsolete HTTP-date',
      'Retry-After',
      'Thursday, 01-Jan-26 00:00:10 GMT',
      10000,
    ],
    ['Retry-After asctime', 'Retry-After', 'Thu Jan  1 00:00:10 2026', 10000],
    ['Retry-After zero expires immediately', 'Retry-After', '0', 0],
    [
      'Retry-After past date expires immediately',
      'Retry-After',
      'Wed, 31 Dec 2025 23:59:59 GMT',
      0,
    ],
    [
      'Retry-After date at now expires immediately',
      'Retry-After',
      'Thu, 01 Jan 2026 00:00:00 GMT',
      0,
    ],
    ['Retry-After negative is absent', 'Retry-After', '-1', undefined],
    ['Retry-After unparsable is absent', 'Retry-After', 'tomorrow', undefined],
    [
      'Retry-After numeric-looking junk is absent',
      'Retry-After',
      '1oops',
      undefined,
    ],
    ['Retry-After blank is absent', 'Retry-After', '', undefined],
    ['reset compound duration', 'X-RateLimit-Reset-Requests', '6m0s', 360000],
    ['reset fractional duration', 'X-RateLimit-Reset-Tokens', '1.5s', 1500],
    ['reset milliseconds', 'X-RateLimit-Reset-Tokens', '250ms', 250],
    ['reset bare delta', 'X-RateLimit-Reset-Requests', '7', 7000],
    ['reset fractional bare delta', 'X-RateLimit-Reset-Requests', '0.25', 250],
    ['reset zero is skipped', 'X-RateLimit-Reset-Requests', '0', undefined],
    [
      'reset duration zero is skipped',
      'X-RateLimit-Reset-Tokens',
      '0ms',
      undefined,
    ],
    ['reset negative is absent', 'X-RateLimit-Reset-Tokens', '-2', undefined],
    [
      'reset negative duration is absent',
      'X-RateLimit-Reset-Tokens',
      '-1s',
      undefined,
    ],
    [
      'reset unparsable is absent',
      'X-RateLimit-Reset-Tokens',
      '1second',
      undefined,
    ],
    [
      'reset date is not a delta',
      'X-RateLimit-Reset-Tokens',
      'Thu, 01 Jan 2026 00:00:10 GMT',
      undefined,
    ],
    [
      'reset bare number is never epoch seconds',
      'X-RateLimit-Reset-Tokens',
      '1700000000',
      1700000000000,
    ],
  ]
  for (const [name, header, value, delay] of vectors) {
    test(name, () => {
      const signal = classifyHeaders(input({ [header]: value }))
      expect(signal?.retryAfterMs).toBe(delay)
      expect(signal?.windows[0]?.resetAt).toBe(
        delay === undefined ? undefined : now + delay,
      )
      expect(signal?.windows[0]?.resetSource).toBe(
        delay === undefined ? undefined : header.toLowerCase(),
      )
      expect(signal?.windows[0]?.confirmed).toBe(false)
      expect(signal?.windows[0]?.confirmedByReading).toBe(false)
    })
  }

  test('Retry-After precedes even an earlier reset header, including zero', () => {
    for (const retry of ['20', '0']) {
      expect(
        resolveHeaderReset(
          new Headers({
            'Retry-After': retry,
            'X-RateLimit-Reset-Tokens': '1s',
          }),
          now,
        ),
      ).toEqual({ resetAt: now + Number(retry) * 1000, source: 'retry-after' })
    }
  })

  test('earliest valid reset header wins, skipping zero and invalid sources', () => {
    expect(
      resolveHeaderReset(
        new Headers({
          'Retry-After': '-1',
          'x-ratelimit-reset-tokens': '3s',
          'x-ratelimit-reset-requests': '2.5',
          'x-ratelimit-reset-day': '0',
          'x-ratelimit-reset-invalid': '-1s',
          'x-ratelimit-reset': '0.1',
        }),
        now,
      ),
    ).toEqual({ resetAt: now + 2500, source: 'x-ratelimit-reset-requests' })
  })

  test('429 and 503 are only hints; every other status has no signal', () => {
    for (const status of [429, 503]) {
      const signal = classifyHeaders(input({ 'Retry-After': '1' }, status))
      expect(signal?.kind).toBe(status === 429 ? 'rate-limit' : 'capacity')
      expect(signal?.scope).toEqual({ kind: 'pool' })
      expect(
        signal?.windows.every(
          (window) => !window.confirmed && !window.confirmedByReading,
        ),
      ).toBe(true)
    }
    for (const status of [200, 401, 402, 403, 500, 529]) {
      expect(
        classifyHeaders(input({ 'Retry-After': '1' }, status)),
      ).toBeUndefined()
    }
  })
})

describe('status-vault-order Retry-After isolation', () => {
  const axes = {
    kind: 'hint',
    mergeLaw: 'overwrite',
    defaultMs: 60000,
    minimumMs: 0,
    zero: 'accept',
    hintClock: 'marker',
  } as const

  test('CL-1/2/3 numeric, zero and future date are preserved', () => {
    for (const [value, delay] of [
      ['17', 17000],
      ['0', 0],
      ['1.5', 1500],
      ['Thu, 01 Jan 2026 00:00:10 GMT', 10000],
    ] as const) {
      const signal = classifyRetryAfter(input({ 'Retry-After': value }))
      expect(markFromSignal(signal, axes, { now })).toEqual({
        scope: { kind: 'pool' },
        until: now + delay,
        mergeLaw: 'overwrite',
      })
    }
  })

  test('CL-4 invalid, blank and nonfuture dates use the marker default, not a known reset', () => {
    for (const value of [
      '',
      'invalid',
      '-1',
      'Thu, 01 Jan 2026 00:00:00 GMT',
      'Wed, 31 Dec 2025 23:59:59 GMT',
    ]) {
      const signal = classifyRetryAfter(input({ 'Retry-After': value }))
      expect(signal?.retryAfterMs).toBeUndefined()
      expect(signal?.windows[0]?.resetAt).toBeUndefined()
      expect(markFromSignal(signal, axes, { now })?.until).toBe(now + 60000)
    }
  })

  test('CL-5 generic classifier remains available without adding reset sources', () => {
    const facts = {
      ...input({ 'retry-after-ms': '12', 'x-ratelimit-reset-tokens': '2s' }),
      body: { resetAt: now + 3 },
      readings: [
        {
          window: '5h',
          confirmed: true,
          confirmedByReading: true,
          resetAt: now + 4,
          resetSource: 'cached',
          observedAt: now,
          provenance: 'poll',
        },
      ],
    }
    expect(classifyHeaders(facts)?.retryAfterMs).toBe(2000)
    const signal = classifyRetryAfter(facts)
    expect(signal?.retryAfterMs).toBeUndefined()
    expect(signal?.windows[0]?.confirmed).toBe(false)
    expect(markFromSignal(signal, axes, { now })?.until).toBe(now + 60000)
    for (const status of [401, 402, 403, 503]) {
      expect(classifyRetryAfter({ ...facts, status })).toBeUndefined()
    }
  })
})
