import { describe, expect, test } from 'bun:test'
import {
  type AccountKey,
  type LimitClassifier,
  type LimitKind,
  type LimitSignal,
  resolveNamedWindowReset,
  resolveReset,
  scopeCovers,
  toOpenCode2LimitSignal,
} from '../../src/limits/index.js'
import type { LimitSignal as OpenCode2LimitSignal } from '../../src/opencode2/types.js'

const account: AccountKey = {
  namespace: 'test:pool',
  accountId: 'A',
  incarnation: '1',
}
const now = 1700000000000

describe('limit signal contract', () => {
  test('per-window confirmation and provenance remain independent', () => {
    const signal: LimitSignal = {
      account,
      kind: 'quota-exhausted',
      reason: 'quota',
      observedAt: now,
      scope: { kind: 'pool' },
      windows: [
        {
          window: '5h',
          confirmed: true,
          confirmedByReading: false,
          observedAt: now,
          provenance: 'response',
          resetAt: now + 1000,
          resetSource: 'body',
        },
        {
          window: '7d',
          confirmed: true,
          confirmedByReading: true,
          observedAt: now - 1,
          provenance: 'poll',
        },
      ],
    }
    expect(signal.windows[0]?.confirmedByReading).toBe(false)
    expect(signal.windows[1]?.resetAt).toBeUndefined()
    const kinds: LimitKind[] = ['account-access', 'model-unavailable']
    expect(kinds).toHaveLength(2)
    const classifier: LimitClassifier = () => undefined
    expect(
      classifier({
        account,
        now,
        status: 401,
        headers: new Headers(),
        effectiveModel: 'claude-sonnet',
        readings: [],
      }),
    ).toBeUndefined()
  })

  test('bridge preserves the unchanged OpenCode 2 shape and zero hint', () => {
    const signal: LimitSignal = {
      account,
      kind: 'rate-limit',
      reason: 'rate-limit',
      status: 429,
      scope: { kind: 'family', family: 'claude' },
      windows: [],
      observedAt: now,
      retryAfterMs: 0,
      retryAfterSource: 'retry-after',
    }
    const result: OpenCode2LimitSignal = toOpenCode2LimitSignal(signal)
    expect(result).toEqual({
      reason: 'rate-limit',
      status: 429,
      retryAfterMs: 0,
    })
    expect(
      toOpenCode2LimitSignal({
        ...signal,
        status: undefined,
        retryAfterMs: undefined,
      }),
    ).toEqual({ reason: 'rate-limit' })
  })

  test('AG-MARK-13 family covers claude-sonnet but not gemini', () => {
    const families: Record<string, string> = {
      'claude-sonnet': 'claude',
      'claude-opus': 'claude',
      'gemini-pro': 'gemini',
    }
    const familyOf = (model: string) => families[model]
    expect(
      scopeCovers(
        { kind: 'family', family: 'claude' },
        'claude-sonnet',
        familyOf,
      ),
    ).toBe(true)
    expect(
      scopeCovers({ kind: 'family', family: 'claude' }, 'gemini-pro', familyOf),
    ).toBe(false)
    expect(
      scopeCovers({ kind: 'family', family: 'claude' }, 'not-claude', familyOf),
    ).toBe(false)
    expect(
      scopeCovers(
        { kind: 'model', model: 'claude-sonnet' },
        'claude-opus',
        familyOf,
      ),
    ).toBe(false)
    expect(scopeCovers({ kind: 'pool' }, 'anything', familyOf)).toBe(true)
    const otherModelMark = { kind: 'model', model: 'gemini-pro' } as const
    expect(
      [otherModelMark].filter(
        (scope) => !scopeCovers(scope, 'claude-sonnet', familyOf),
      ),
    ).toEqual([otherModelMark])
  })

  test('limits export imports with optional peer resolution forbidden', async () => {
    const manifest = await Bun.file(
      new URL('../../package.json', import.meta.url),
    ).json()
    expect(manifest.exports['./limits']).toEqual({
      types: './dist/limits/index.d.ts',
      import: './dist/limits/index.js',
    })
    const build = await Bun.build({
      entrypoints: [
        new URL('../../src/limits/index.ts', import.meta.url).pathname,
      ],
      target: 'node',
      plugins: [
        {
          name: 'no-optional-peers',
          setup(builder) {
            builder.onResolve(
              {
                filter: /^@cortexkit\/(?:claustrum-client|subc-client)(?:\/|$)/,
              },
              () => {
                throw new Error('Optional peer must not be imported by limits')
              },
            )
          },
        },
      ],
    })
    expect(build.success).toBe(true)
    expect(build.logs).toEqual([])
    const code = await build.outputs[0]!.text()
    const imported = await import(
      `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
    )
    expect(typeof imported.markFromSignal).toBe('function')
  })
})

describe('ordered reset sources', () => {
  test('source precedence is explicit, not earliest across different sources', () => {
    expect(
      resolveReset(
        [
          { source: 'body', value: 1500, unit: 'delay-ms', zero: 'skip' },
          {
            source: 'retry-after',
            value: 1000,
            unit: 'delay-ms',
            zero: 'accept',
          },
        ],
        now,
      ),
    ).toEqual({ resetAt: now + 1500, source: 'body' })
  })

  test('zero is accepted or skipped per source, including epoch values', () => {
    expect(
      resolveReset(
        [
          { source: 'body', value: 0, unit: 'delay-ms', zero: 'skip' },
          { source: 'header', value: 0, unit: 'delay-ms', zero: 'accept' },
          { source: 'default', value: 60000, unit: 'delay-ms', zero: 'accept' },
        ],
        now,
      ),
    ).toEqual({ resetAt: now, source: 'header' })
    expect(
      resolveReset(
        [{ source: 'absolute', value: 0, unit: 'epoch-ms', zero: 'accept' }],
        now,
      ),
    ).toEqual({ resetAt: 0, source: 'absolute' })
  })

  test('negative, missing, non-finite and overflowing sources are absent', () => {
    for (const value of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        resolveReset(
          [{ source: 'bad', value, unit: 'delay-ms', zero: 'accept' }],
          now,
        ),
      ).toBeUndefined()
    }
    expect(
      resolveReset(
        [
          {
            source: 'overflow',
            value: Number.MAX_VALUE,
            unit: 'delay-ms',
            zero: 'accept',
          },
        ],
        Number.MAX_VALUE,
      ),
    ).toBeUndefined()
  })

  test('OA-10 future explicit reset wins a shorter cached primary reset', () => {
    expect(
      resolveNamedWindowReset({
        now,
        explicitResetAt: now + 900000,
        window: 'primary',
        cached: { primary: now + 300000 },
        defaultMs: 60000,
      }),
    ).toEqual({ resetAt: now + 900000, source: 'explicit' })
  })

  test('OA-11 only the named primary or secondary borrows its future reset', () => {
    expect(
      resolveNamedWindowReset({
        now,
        window: 'secondary',
        cached: { primary: now + 1000, secondary: now + 300000 },
        defaultMs: 60000,
      }),
    ).toEqual({ resetAt: now + 300000, source: 'cached' })
  })

  test('OA-12 invalid or passed own resets default, never borrowing another window', () => {
    for (const reset of [undefined, now, now - 1, Number.NaN]) {
      expect(
        resolveNamedWindowReset({
          now,
          explicitResetAt: reset,
          window: 'primary',
          cached: { primary: reset, secondary: now + 300000 },
          defaultMs: 60000,
        }),
      ).toEqual({ resetAt: now + 60000, source: 'default' })
    }
    expect(
      resolveNamedWindowReset({
        now,
        window: 'capacity',
        cached: { primary: now + 300000, capacity: now + 500000 },
        defaultMs: 60000,
      }),
    ).toEqual({ resetAt: now + 60000, source: 'default' })
  })
})
