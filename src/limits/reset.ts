export interface ResetSource {
  readonly source: string
  readonly value: number | undefined
  readonly unit: 'delay-ms' | 'epoch-ms'
  readonly zero: 'accept' | 'skip'
}

export interface ResolvedReset {
  readonly resetAt: number
  readonly source: string
}

/** First usable source wins; a default is just another explicitly ordered source. */
export function resolveReset(
  sources: readonly ResetSource[],
  now: number,
): ResolvedReset | undefined {
  for (const candidate of sources) {
    const { value } = candidate
    if (
      value === undefined ||
      !Number.isFinite(value) ||
      value < 0 ||
      (value === 0 && candidate.zero === 'skip')
    ) {
      continue
    }
    const resetAt = candidate.unit === 'delay-ms' ? now + value : value
    if (Number.isFinite(resetAt)) return { resetAt, source: candidate.source }
  }
  return undefined
}

/** Only a window listed in lendable may supply its own cached reset. */
export function resolveNamedWindowReset(input: {
  readonly now: number
  readonly explicitResetAt?: number
  readonly window: string
  readonly lendable: readonly string[]
  readonly cached: Readonly<Record<string, number | undefined>>
  readonly defaultMs: number
}): ResolvedReset | undefined {
  const future = (value: number | undefined) =>
    value !== undefined && Number.isFinite(value) && value > input.now
      ? value
      : undefined
  return resolveReset(
    [
      {
        source: 'explicit',
        value: future(input.explicitResetAt),
        unit: 'epoch-ms',
        zero: 'skip',
      },
      {
        source: 'cached',
        value: input.lendable.includes(input.window)
          ? future(input.cached[input.window])
          : undefined,
        unit: 'epoch-ms',
        zero: 'skip',
      },
      {
        source: 'default',
        value: input.defaultMs,
        unit: 'delay-ms',
        zero: 'accept',
      },
    ],
    input.now,
  )
}
