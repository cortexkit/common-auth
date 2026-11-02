import { type ResolvedReset, resolveReset } from './reset.js'
import type { ClassifierInput, LimitSignal } from './signal.js'

const delta = /^(?:\d+(?:\.\d*)?|\.\d+)$/
const httpDate =
  /^(?:[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]+, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{3} [A-Za-z]{3} {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4})$/

/** HTTP dates include a month name; Date.parse alone also accepts numbers and junk. */
function retryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined
  const text = value.trim()
  if (delta.test(text)) {
    const ms = Number(text) * 1000
    return Number.isFinite(ms) ? ms : undefined
  }
  if (!httpDate.test(text)) return undefined
  const date = Date.parse(text)
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined
}

function resetDuration(value: string): number | undefined {
  const text = value.trim()
  if (delta.test(text)) {
    const ms = Number(text) * 1000
    return Number.isFinite(ms) ? ms : undefined
  }
  const parts = text.matchAll(/(\d+(?:\.\d*)?|\.\d+)(ms|s|m|h|d)/g)
  let consumed = ''
  let ms = 0
  const units = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }
  for (const part of parts) {
    consumed += part[0]
    ms += Number(part[1]) * units[part[2] as keyof typeof units]
  }
  return consumed === text && consumed !== '' && Number.isFinite(ms)
    ? ms
    : undefined
}

export function resolveRetryAfter(
  headers: Headers,
  now: number,
): ResolvedReset | undefined {
  return resolveReset(
    [
      {
        source: 'retry-after',
        value: retryAfter(headers.get('retry-after'), now),
        unit: 'delay-ms',
        zero: 'accept',
      },
    ],
    now,
  )
}

/** Importing this module alone does not enable its header reset sources. */
export function resolveHeaderReset(
  headers: Headers,
  now: number,
): ResolvedReset | undefined {
  const retry = resolveRetryAfter(headers, now)
  if (retry) return retry
  let earliest: ResolvedReset | undefined
  for (const [name, value] of headers) {
    if (!name.startsWith('x-ratelimit-reset-')) continue
    const reset = resolveReset(
      [
        {
          source: name,
          value: resetDuration(value),
          unit: 'delay-ms',
          zero: 'skip',
        },
      ],
      now,
    )
    if (reset && (!earliest || reset.resetAt < earliest.resetAt))
      earliest = reset
  }
  return earliest
}

function hintSignal(
  input: ClassifierInput,
  reset: ResolvedReset | undefined,
): LimitSignal {
  return {
    account: input.account,
    kind: input.status === 429 ? 'rate-limit' : 'capacity',
    reason: input.status === 429 ? 'rate-limit' : 'capacity',
    status: input.status,
    scope: { kind: 'pool' },
    observedAt: input.now,
    windows: [
      {
        window: 'retry',
        confirmed: false,
        confirmedByReading: false,
        observedAt: input.now,
        provenance: 'http-status',
        ...(reset ? { resetAt: reset.resetAt, resetSource: reset.source } : {}),
      },
    ],
    ...(reset
      ? {
          retryAfterMs: reset.resetAt - input.now,
          retryAfterSource: reset.source,
        }
      : {}),
  }
}

/** Generic status hints never assert quota exhaustion, even on a 429. */
export function classifyHeaders(
  input: ClassifierInput,
): LimitSignal | undefined {
  if (input.status !== 429 && input.status !== 503) return undefined
  return hintSignal(input, resolveHeaderReset(input.headers, input.now))
}

/** Retry-After-only classification leaves default timers to the marker. */
export function classifyRetryAfter(
  input: ClassifierInput,
): LimitSignal | undefined {
  if (input.status !== 429) return undefined
  const raw = input.headers.get('retry-after')?.trim() ?? ''
  const numeric = raw === '' ? Number.NaN : Number(raw)
  const parsed =
    Number.isFinite(numeric) && numeric >= 0
      ? resolveReset(
          [
            {
              source: 'retry-after',
              value: numeric * 1000,
              unit: 'delay-ms',
              zero: 'accept',
            },
          ],
          input.now,
        )
      : resolveRetryAfter(input.headers, input.now)
  const usable =
    parsed && (Number.isFinite(numeric) || parsed.resetAt > input.now)
      ? parsed
      : undefined
  // The marker supplies its default timer; that timer is not a known reset.
  return hintSignal(input, usable)
}
