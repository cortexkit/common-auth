import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  type BillingOutcome,
  type BillingRequestKind,
  type BillingUsage,
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

const billing = {
  sessionId: 'session',
  kind: 'billing',
  attemptId: 'physical-request',
  requestKind: 'primary',
  credentialId: 'vault-credential',
  provider: 'anthropic',
  model: 'claude-sonnet',
  outcome: 'completed',
} as const satisfies ReportRoutingInput

const minimalPayload = {
  kind: 'billing',
  attempt_id: 'physical-request',
  request_kind: 'primary',
  credential_id: 'vault-credential',
  provider: 'anthropic',
  model: 'claude-sonnet',
  outcome: 'completed',
}

describe('billing reports', () => {
  test('sends the exact full snake_case payload through the session handle', () => {
    const report = mock((_payload: unknown) => {})
    const handle = { report }
    const routing = mock((_sessionId: string) => handle)
    install(routing)
    const usage: BillingUsage = {
      input: 100,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      cacheWrite5m: 50,
      cacheWrite1h: 60,
      reasoning: 7,
      reasoningIncludedInOutput: true,
    }
    expect(
      reportRouting({
        ...billing,
        accountId: 'vault-account',
        providerRequestId: 'request-id',
        providerResponseId: 'response-id',
        userMessageId: 'message-id',
        status: 200,
        attempt: 2,
        chargeBasis: 'subscription_included',
        usage,
        usageByModel: [{ modelUsed: 'claude-sonnet-resolved', usage }],
      }),
    ).toBeUndefined()
    expect(report.mock.calls).toEqual([
      [
        {
          kind: 'billing',
          attempt_id: 'physical-request',
          request_kind: 'primary',
          credential_id: 'vault-credential',
          account_id: 'vault-account',
          provider: 'anthropic',
          model: 'claude-sonnet',
          outcome: 'completed',
          provider_request_id: 'request-id',
          provider_response_id: 'response-id',
          user_message_id: 'message-id',
          status: 200,
          attempt: 2,
          charge_basis: 'subscription_included',
          usage: {
            input: 100,
            output: 20,
            cache_read: 30,
            cache_write: 40,
            cache_write_5m: 50,
            cache_write_1h: 60,
            reasoning: 7,
            reasoning_included_in_output: true,
          },
          usage_by_model: [
            {
              model_used: 'claude-sonnet-resolved',
              usage: {
                input: 100,
                output: 20,
                cache_read: 30,
                cache_write: 40,
                cache_write_5m: 50,
                cache_write_1h: 60,
                reasoning: 7,
                reasoning_included_in_output: true,
              },
            },
          ],
        },
      ],
    ])
    expect(routing.mock.calls).toEqual([['session']])
    expect(report.mock.contexts).toEqual([handle])
  })

  test.each(['attemptId', 'credentialId', 'provider', 'model'])(
    'sends nothing for a missing, empty or non-string %s',
    (key) => {
      const report = mock((_payload: unknown) => {})
      install(() => ({ report }))
      for (const value of [undefined, null, '', 1, false, {}, []]) {
        reportRouting({
          ...billing,
          [key]: value,
        } as unknown as ReportRoutingInput)
      }
      expect(report).not.toHaveBeenCalled()
    },
  )

  test.each(['requestKind', 'outcome'])(
    'sends nothing for an unknown or missing %s',
    (key) => {
      const report = mock((_payload: unknown) => {})
      install(() => ({ report }))
      for (const value of [undefined, null, '', 'unknown', 1, false, {}, []]) {
        reportRouting({
          ...billing,
          [key]: value,
        } as unknown as ReportRoutingInput)
      }
      expect(report).not.toHaveBeenCalled()
    },
  )

  test.each([
    'primary',
    'title',
    'compaction',
    'generate',
    'keep_warm',
    'prime',
  ] satisfies BillingRequestKind[])(
    'accepts request kind %s',
    (requestKind) => {
      const report = mock((_payload: unknown) => {})
      install(() => ({ report }))
      reportRouting({ ...billing, requestKind })
      expect(report.mock.calls).toEqual([
        [{ ...minimalPayload, request_kind: requestKind }],
      ])
    },
  )

  test.each(['completed', 'cut', 'failed'] satisfies BillingOutcome[])(
    'accepts outcome %s',
    (outcome) => {
      const report = mock((_payload: unknown) => {})
      install(() => ({ report }))
      reportRouting({ ...billing, outcome })
      expect(report.mock.calls).toEqual([[{ ...minimalPayload, outcome }]])
    },
  )

  test('omits invalid optional members and unknown fields without dropping the report', () => {
    const report = mock((_payload: unknown) => {})
    install(() => ({ report }))
    reportRouting({
      ...billing,
      accountId: '',
      providerRequestId: '',
      providerResponseId: null,
      userMessageId: 1,
      status: -1,
      attempt: 0,
      chargeBasis: 'unknown',
      final: true,
      extra: 'not forwarded',
      usage: {
        input: 0,
        output: -1,
        cacheRead: 1.5,
        cacheWrite: Number.MAX_SAFE_INTEGER + 1,
        cacheWrite5m: Infinity,
        reasoning: NaN,
        reasoningIncludedInOutput: false,
        extra: 42,
      },
    } as unknown as ReportRoutingInput)
    expect(report.mock.calls).toEqual([
      [
        {
          ...minimalPayload,
          usage: { input: 0, reasoning_included_in_output: false },
        },
      ],
    ])
    const payload = report.mock.calls[0]?.[0] as { usage: object }
    expect(Object.hasOwn(payload.usage, 'cache_write_1h')).toBe(false)
    expect(Object.hasOwn(payload.usage, 'output')).toBe(false)
    expect(Object.hasOwn(payload, 'final')).toBe(false)
  })

  test.each([
    ['accountId', 1],
    ['providerRequestId', false],
    ['providerResponseId', ''],
    ['userMessageId', ''],
    ['status', 1.5],
    ['status', Infinity],
    ['status', '200'],
    ['attempt', -1],
    ['attempt', 1.5],
    ['attempt', Infinity],
    ['attempt', '1'],
  ])('omits invalid optional %s=%p', (key, value) => {
    const report = mock((_payload: unknown) => {})
    install(() => ({ report }))
    reportRouting({ ...billing, [key]: value } as unknown as ReportRoutingInput)
    expect(report.mock.calls).toEqual([[minimalPayload]])
  })

  test('preserves zero status, a first attempt, metered billing and the largest safe count', () => {
    const report = mock((_payload: unknown) => {})
    install(() => ({ report }))
    reportRouting({
      ...billing,
      status: 0,
      attempt: 1,
      chargeBasis: 'metered_api',
      usage: { input: Number.MAX_SAFE_INTEGER },
    })
    expect(report.mock.calls).toEqual([
      [
        {
          ...minimalPayload,
          status: 0,
          attempt: 1,
          charge_basis: 'metered_api',
          usage: { input: Number.MAX_SAFE_INTEGER },
        },
      ],
    ])
  })

  test.each(
    [
      undefined,
      null,
      'not usage',
      [],
      {},
      { input: -1, output: '0', reasoningIncludedInOutput: 'false', extra: 1 },
    ].map((value) => [value]),
  )('omits usage with no valid readings: %p', (usage) => {
    const report = mock((_payload: unknown) => {})
    install(() => ({ report }))
    reportRouting({ ...billing, usage } as unknown as ReportRoutingInput)
    expect(report.mock.calls).toEqual([[minimalPayload]])
    expect(Object.hasOwn(report.mock.calls[0]?.[0] as object, 'usage')).toBe(
      false,
    )
  })

  test('filters usage_by_model entries and their usage without copying extra fields', () => {
    const report = mock((_payload: unknown) => {})
    install(() => ({ report }))
    reportRouting({
      ...billing,
      usageByModel: [
        null,
        1,
        {},
        { modelUsed: '', usage: { input: 9 } },
        { modelUsed: 1, usage: { input: 9 } },
        {
          modelUsed: 'first',
          usage: {
            input: 0,
            output: -1,
            cacheRead: 10,
            cacheWrite: 1.5,
            reasoningIncludedInOutput: false,
            extra: 42,
          },
          extra: 'not forwarded',
        },
        { modelUsed: 'no-readings', usage: { output: -1 } },
        { modelUsed: 'last', usage: { output: 2 } },
      ],
    } as unknown as ReportRoutingInput)
    expect(report.mock.calls).toEqual([
      [
        {
          ...minimalPayload,
          usage_by_model: [
            {
              model_used: 'first',
              usage: {
                input: 0,
                cache_read: 10,
                reasoning_included_in_output: false,
              },
            },
            { model_used: 'last', usage: { output: 2 } },
          ],
        },
      ],
    ])
  })

  test.each(
    [
      undefined,
      null,
      'not a list',
      {},
      [],
      [null, {}, { modelUsed: '', usage: { input: 0 } }],
      [{ modelUsed: 'no-readings', usage: { output: -1 } }],
      [{ modelUsed: 'no-usage' }],
    ].map((value) => [value]),
  )(
    'omits usage_by_model when no valid model entries remain: %p',
    (usageByModel) => {
      const report = mock((_payload: unknown) => {})
      install(() => ({ report }))
      reportRouting({
        ...billing,
        usageByModel,
      } as unknown as ReportRoutingInput)
      expect(report.mock.calls).toEqual([[minimalPayload]])
      expect(
        Object.hasOwn(report.mock.calls[0]?.[0] as object, 'usage_by_model'),
      ).toBe(false)
    },
  )

  test('forwards a validated snapshot even when field getters change on subsequent reads', () => {
    const report = mock((_payload: unknown) => {})
    install(() => ({ report }))
    const reads: Record<string, number> = {}
    const input = new Proxy(
      { ...billing, accountId: 'vault-account', status: 200, attempt: 1 },
      {
        get(target, key, receiver) {
          if (typeof key !== 'string') return Reflect.get(target, key, receiver)
          reads[key] = (reads[key] ?? 0) + 1
          return reads[key] === 1
            ? Reflect.get(target, key, receiver)
            : undefined
        },
      },
    )
    reportRouting(input)
    expect(report.mock.calls).toEqual([
      [
        {
          ...minimalPayload,
          account_id: 'vault-account',
          status: 200,
          attempt: 1,
        },
      ],
    ])
    expect(Object.values(reads).every((count) => count === 1)).toBe(true)
  })

  test('sends nothing without a handle or report function', () => {
    Reflect.deleteProperty(globalThis, symbol)
    expect(reportRouting(billing)).toBeUndefined()
    for (const handle of [null, undefined, {}, { report: 1 }]) {
      install(() => handle)
      expect(reportRouting(billing)).toBeUndefined()
    }
  })

  test('swallows throwing and rejected reports and never waits for settlement', async () => {
    install(() => ({
      report() {
        throw new Error('report failed')
      },
    }))
    expect(reportRouting(billing)).toBeUndefined()
    install(() => ({
      report: () => Promise.reject(new Error('report rejected')),
    }))
    expect(reportRouting(billing)).toBeUndefined()
    await Promise.resolve()
    const report = mock(() => new Promise(() => {}))
    install(() => ({ report }))
    expect(reportRouting(billing)).toBeUndefined()
    expect(report).toHaveBeenCalledTimes(1)
  })
})
