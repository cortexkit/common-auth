import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  PLUGIN_WAIT_REASONS,
  type PluginWaitReason,
  type ReportRoutingInput,
  reportRouting,
} from '../../src/routing-accessor/index.js'

const symbol = Symbol.for('cortexkit.routing')
const original = Object.getOwnPropertyDescriptor(globalThis, symbol)

function install(value: unknown): void {
  Object.defineProperty(globalThis, symbol, { configurable: true, value })
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, symbol)
  if (original) Object.defineProperty(globalThis, symbol, original)
})

const wait = {
  sessionId: 'session',
  kind: 'wait',
  phase: 'start',
  waitId: 'retry:1',
  reason: 'account_limit',
} as const satisfies ReportRoutingInput

const minimalPayload = {
  kind: 'wait',
  phase: 'start',
  wait_id: 'retry:1',
  reason: 'account_limit',
}

const reasons = [
  'account_limit',
  'account_free',
  'rate_limited',
  'server_busy',
  'quota_reading',
  'routing_hold',
] as const satisfies readonly PluginWaitReason[]

describe('plugin wait reports', () => {
  test('sends exactly the snake_case start payload through the session handle', () => {
    const report = mock((_payload: unknown) => {})
    const handle = { report }
    const routing = mock((_sessionId: string) => handle)
    install(routing)
    expect(
      reportRouting({
        ...wait,
        nextMs: 1_800_000_000_000,
        attempt: 2,
        message: 'Waiting for the next attempt.',
        outcome: 'resumed',
        extra: 'not forwarded',
        wait_id: 'not forwarded',
        next_ms: 99,
      } as ReportRoutingInput),
    ).toBeUndefined()
    expect(report.mock.calls).toEqual([
      [
        {
          kind: 'wait',
          phase: 'start',
          wait_id: 'retry:1',
          reason: 'account_limit',
          next_ms: 1_800_000_000_000,
          attempt: 2,
          message: 'Waiting for the next attempt.',
        },
      ],
    ])
    expect(routing.mock.calls).toEqual([['session']])
    expect(report.mock.contexts).toEqual([handle])
  })

  test('exports the closed set of plugin wait reasons', () => {
    expect(PLUGIN_WAIT_REASONS).toEqual(reasons)
  })

  test.each([...reasons])('accepts reason %s', (reason) => {
    const report = mock((_payload: unknown) => {})
    install(() => ({ report }))
    reportRouting({ ...wait, reason })
    expect(report.mock.calls).toEqual([[{ ...minimalPayload, reason }]])
  })

  test.each(['resumed', 'cancelled', 'abandoned'] as const)(
    'carries end outcome %s and drops it on start',
    (outcome) => {
      const report = mock((_payload: unknown) => {})
      install(() => ({ report }))
      reportRouting({ ...wait, phase: 'end', outcome })
      reportRouting({ ...wait, outcome })
      expect(report.mock.calls).toEqual([
        [{ ...minimalPayload, phase: 'end', outcome }],
        [minimalPayload],
      ])
    },
  )

  test.each([
    ['sessionId', [undefined, null, '', 1, false, {}, []]],
    ['phase', [undefined, null, '', 'pause', 'START', 1, false, {}, []]],
    [
      'waitId',
      [
        undefined,
        null,
        '',
        'has space',
        'a'.repeat(65),
        'retry\n',
        '/',
        1,
        {},
        [],
      ],
    ],
    [
      'reason',
      [undefined, null, '', 'ACCOUNT_LIMIT', ' account_limit', 1, {}, []],
    ],
  ] as const)('sends nothing for a missing or invalid %s', (key, invalid) => {
    const report = mock((_payload: unknown) => {})
    install(() => ({ report }))
    const missing: Record<string, unknown> = { ...wait }
    delete missing[key]
    reportRouting(missing as ReportRoutingInput)
    for (const value of invalid) {
      reportRouting({ ...wait, [key]: value } as unknown as ReportRoutingInput)
    }
    expect(report).not.toHaveBeenCalled()
  })

  test('sends nothing for an unknown reason', () => {
    const report = mock((_payload: unknown) => {})
    install(() => ({ report }))
    reportRouting({
      ...wait,
      reason: 'future_reason',
    } as unknown as ReportRoutingInput)
    expect(report).not.toHaveBeenCalled()
  })

  test.each(['a', 'AZaz09._:-', 'a'.repeat(64)])(
    'accepts a valid wait id %s',
    (waitId) => {
      const report = mock((_payload: unknown) => {})
      install(() => ({ report }))
      reportRouting({ ...wait, waitId })
      expect(report.mock.calls).toEqual([
        [{ ...minimalPayload, wait_id: waitId }],
      ])
    },
  )

  test.each([
    ['nextMs', 0],
    ['nextMs', 1.5],
    ['nextMs', -1],
    ['nextMs', Number.MAX_SAFE_INTEGER + 1],
    ['nextMs', NaN],
    ['nextMs', Infinity],
    ['nextMs', '1000'],
    ['attempt', 0],
    ['attempt', -1],
    ['attempt', 1.5],
    ['attempt', Infinity],
    ['attempt', '1'],
    ['message', 'a'.repeat(161)],
    ['message', 'has\nnewline'],
    ['message', ''],
    ['message', 1],
    ['outcome', 'unknown'],
    ['outcome', null],
  ])('drops invalid optional %s=%p without losing the report', (key, value) => {
    const report = mock((_payload: unknown) => {})
    install(() => ({ report }))
    reportRouting({
      ...wait,
      phase: 'end',
      [key]: value,
    } as unknown as ReportRoutingInput)
    expect(report.mock.calls).toEqual([[{ ...minimalPayload, phase: 'end' }]])
  })

  test.each(['\u0000', '\u0009', '\u001f', '\u007f', '\u0080', '\u009f'])(
    'drops a message containing control character %p',
    (control) => {
      const report = mock((_payload: unknown) => {})
      install(() => ({ report }))
      reportRouting({ ...wait, message: `Waiting${control}now` })
      expect(report.mock.calls).toEqual([[minimalPayload]])
    },
  )

  test.each([' ', ' a ', 'a'.repeat(160), '\u00a0Ready'])(
    'preserves valid message text without trimming: %p',
    (message) => {
      const report = mock((_payload: unknown) => {})
      install(() => ({ report }))
      reportRouting({ ...wait, message })
      expect(report.mock.calls).toEqual([[{ ...minimalPayload, message }]])
    },
  )

  test.each([1, Number.MAX_SAFE_INTEGER])(
    'accepts a positive safe next-attempt time %p and a first attempt',
    (nextMs) => {
      const report = mock((_payload: unknown) => {})
      install(() => ({ report }))
      reportRouting({ ...wait, nextMs, attempt: 1 })
      expect(report.mock.calls).toEqual([
        [{ ...minimalPayload, next_ms: nextMs, attempt: 1 }],
      ])
    },
  )

  test('does nothing without an accessor, handle or report function', () => {
    Reflect.deleteProperty(globalThis, symbol)
    expect(reportRouting(wait)).toBeUndefined()
    for (const handle of [null, undefined, {}, { report: 1 }]) {
      install(() => handle)
      expect(reportRouting(wait)).toBeUndefined()
    }
  })

  test('ignores a throwing accessor or report', () => {
    install(() => {
      throw new Error('accessor failed')
    })
    expect(reportRouting(wait)).toBeUndefined()
    install(() => ({
      report() {
        throw new Error('report failed')
      },
    }))
    expect(reportRouting(wait)).toBeUndefined()
  })

  test('ignores rejected reports without waiting for settlement', async () => {
    install(() => ({
      report: () => Promise.reject(new Error('report rejected')),
    }))
    expect(reportRouting(wait)).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 0))
    install(() => ({ report: () => new Promise(() => {}) }))
    expect(reportRouting(wait)).toBeUndefined()
  })
})
