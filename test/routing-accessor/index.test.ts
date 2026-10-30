import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import {
  askRouting,
  type ReportRoutingInput,
  reportRouting,
} from '../../src/routing-accessor/index.js'

const symbol = Symbol.for('cortexkit.routing')
const original = Object.getOwnPropertyDescriptor(globalThis, symbol)
const candidate = {
  accountId: 'vault-account',
  credentialId: 'vault-credential',
  route: { kind: 'oauth' },
}
const input = {
  sessionId: 'session',
  provider: 'anthropic',
  modelId: 'claude-sonnet',
  candidates: [candidate],
}

function install(value: unknown): void {
  Object.defineProperty(globalThis, symbol, {
    configurable: true,
    value,
  })
}

function answerWith(answer: unknown): void {
  install(() => ({ accountFor: () => Promise.resolve(answer) }))
}

afterEach(() => {
  mock.restore()
  Reflect.deleteProperty(globalThis, symbol)
  if (original) Object.defineProperty(globalThis, symbol, original)
})

describe('askRouting', () => {
  test('falls back when the accessor is absent, not a function, or has no handle', async () => {
    Reflect.deleteProperty(globalThis, symbol)
    expect(await askRouting(input)).toBeUndefined()
    install({
      accountFor: () => Promise.resolve({ account_id: 'vault-account' }),
    })
    expect(await askRouting(input)).toBeUndefined()
    install(() => null)
    expect(await askRouting(input)).toBeUndefined()
  })

  test('ignores a throwing global getter, accessor, and accountFor', async () => {
    Object.defineProperty(globalThis, symbol, {
      configurable: true,
      get() {
        throw new Error('getter failed')
      },
    })
    expect(await askRouting(input)).toBeUndefined()
    install(() => {
      throw new Error('accessor failed')
    })
    expect(await askRouting(input)).toBeUndefined()
    install(() => ({
      accountFor() {
        throw new Error('accountFor failed')
      },
    }))
    expect(await askRouting(input)).toBeUndefined()
  })

  test.each([undefined, false, 1, 'handle', () => {}])(
    'ignores a non-object handle: %p',
    async (handle) => {
      install(() => handle)
      expect(await askRouting(input)).toBeUndefined()
    },
  )

  test('ignores missing methods, method getters, rejected promises and non-promises', async () => {
    install(() => ({}))
    expect(await askRouting(input)).toBeUndefined()
    install(() => ({
      get accountFor() {
        throw new Error('method getter failed')
      },
    }))
    expect(await askRouting(input)).toBeUndefined()
    install(() => ({ accountFor: () => Promise.reject(new Error('rejected')) }))
    expect(await askRouting(input)).toBeUndefined()
    install(() => ({ accountFor: () => ({ account_id: 'vault-account' }) }))
    expect(await askRouting(input)).toBeUndefined()
    install(() => ({
      accountFor: () => ({
        // biome-ignore lint/suspicious/noThenProperty: Exercise a malformed promise returned by the optional bridge.
        get then() {
          throw new Error('then getter failed')
        },
      }),
    }))
    expect(await askRouting(input)).toBeUndefined()
  })

  test.each([null, undefined, 42, 'account', {}, { account_id: 1 }])(
    'ignores a malformed answer: %p',
    async (answer) => {
      answerWith(answer)
      expect(await askRouting(input)).toBeUndefined()
    },
  )

  test('ignores an answer with throwing properties', async () => {
    answerWith({
      get account_id() {
        throw new Error('answer getter failed')
      },
    })
    expect(await askRouting(input)).toBeUndefined()
  })

  test('rejects accounts outside the eligible set and mismatched credentials', async () => {
    answerWith({ account_id: 'blocked-account' })
    expect(await askRouting(input)).toBeUndefined()
    answerWith({
      account_id: candidate.accountId,
      credential_id: 'other-credential',
    })
    expect(await askRouting(input)).toBeUndefined()
    answerWith({ account_id: candidate.accountId, credential_id: null })
    expect(await askRouting(input)).toBeUndefined()
    answerWith({ account_id: candidate.accountId })
    expect(await askRouting({ ...input, candidates: [] })).toBeUndefined()
  })

  test('returns the original candidate with or without a credential in the answer', async () => {
    answerWith({ account_id: candidate.accountId })
    const selected = await askRouting(input)
    expect(selected).toEqual({ candidate })
    expect(selected?.candidate).toBe(candidate)
    expect(selected?.candidate.route.kind).toBe('oauth')
    answerWith({
      account_id: candidate.accountId,
      credential_id: candidate.credentialId,
    })
    expect(await askRouting(input)).toEqual({ candidate })
  })

  test('matches the credential when multiple routes share an account', async () => {
    const other = { ...candidate, credentialId: 'other-credential' }
    answerWith({
      account_id: candidate.accountId,
      credential_id: other.credentialId,
    })
    expect(
      await askRouting({ ...input, candidates: [candidate, other] }),
    ).toEqual({
      candidate: other,
    })
  })

  test.each([0, 50, 2_000_000])(
    'passes through a valid uncapped hold: %p',
    async (retryAfterMs) => {
      answerWith({
        account_id: candidate.accountId,
        hold: { retry_after_ms: retryAfterMs, ignored: true },
      })
      expect(await askRouting(input)).toEqual({
        candidate,
        hold: { retry_after_ms: retryAfterMs },
      })
    },
  )

  test.each([
    null,
    {},
    { retry_after_ms: -1 },
    { retry_after_ms: NaN },
    { retry_after_ms: Infinity },
    { retry_after_ms: '10' },
  ])('drops an invalid hold without losing the candidate: %p', async (hold) => {
    answerWith({ account_id: candidate.accountId, hold })
    expect(await askRouting(input)).toEqual({ candidate })
  })

  test.each([
    [undefined, 500],
    [25, 25],
    [0, 1],
    [-10, 1],
    [4000, 2000],
    [NaN, 500],
    [Infinity, 2000],
    [-Infinity, 1],
  ])('passes the bounded deadline %p as %p', async (deadlineMs, expected) => {
    const accountFor = mock(() =>
      Promise.resolve({ account_id: candidate.accountId }),
    )
    const handle = { accountFor }
    const routing = mock(() => handle)
    install(routing)
    expect(await askRouting({ ...input, deadlineMs })).toEqual({ candidate })
    expect(routing).toHaveBeenCalledWith('session')
    expect(accountFor).toHaveBeenCalledWith(
      { provider: 'anthropic', modelId: 'claude-sonnet' },
      { deadlineMs: expected },
    )
    expect(accountFor.mock.contexts[0]).toBe(handle)
  })

  test('times out a never-settling accountFor using an unref timer', async () => {
    let expire: (() => void) | undefined
    const unref = mock(() => {})
    const timer = { unref } as unknown as ReturnType<typeof setTimeout>
    const setTimer = spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: () => void,
    ) => {
      expire = callback as () => void
      return timer
    }) as typeof setTimeout)
    const clearTimer = spyOn(globalThis, 'clearTimeout').mockImplementation(
      () => {},
    )
    install(() => ({ accountFor: () => new Promise(() => {}) }))
    const pending = askRouting({ ...input, deadlineMs: 7 })
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 7)
    expect(unref).toHaveBeenCalledTimes(1)
    expect(expire).toBeDefined()
    expire?.()
    expect(await pending).toBeUndefined()
    expect(clearTimer).toHaveBeenCalledWith(timer)
  })

  test('finds an accessor registered after module load and observes replacements', async () => {
    Reflect.deleteProperty(globalThis, symbol)
    expect(await askRouting(input)).toBeUndefined()
    answerWith({ account_id: candidate.accountId })
    expect(await askRouting(input)).toEqual({ candidate })
    install(() => null)
    expect(await askRouting(input)).toBeUndefined()
  })
})

describe('reportRouting', () => {
  const served = {
    sessionId: 'session',
    accountId: candidate.accountId,
    credentialId: candidate.credentialId,
    outcome: 'served' as const,
    headers: { 'anthropic-ratelimit-requests-remaining': '9' },
  }

  test('does nothing without an accessor or handle', () => {
    Reflect.deleteProperty(globalThis, symbol)
    expect(reportRouting(served)).toBeUndefined()
    install('not an accessor')
    expect(reportRouting(served)).toBeUndefined()
    install(() => null)
    expect(reportRouting(served)).toBeUndefined()
    install(() => ({}))
    expect(reportRouting(served)).toBeUndefined()
  })

  test('sends only contract fields for served and exhausted outcomes', () => {
    const report = mock((_payload: unknown) => {})
    const handle = { report }
    const routing = mock((_sessionId: string) => handle)
    install(routing)
    reportRouting({
      ...served,
      token: 'must not be sent',
      email: 'must not be sent',
      label: 'must not be sent',
      window: 'must not be sent',
      resetsAt: 123,
    } as ReportRoutingInput)
    reportRouting({
      ...served,
      outcome: 'exhausted',
      window: '7d:sonnet',
      resetsAt: 1_800_000_000_000,
    })
    expect(report.mock.calls).toEqual([
      [
        {
          account_id: 'vault-account',
          credential_id: 'vault-credential',
          outcome: 'served',
          headers: { 'anthropic-ratelimit-requests-remaining': '9' },
        },
      ],
      [
        {
          account_id: 'vault-account',
          credential_id: 'vault-credential',
          outcome: 'exhausted',
          window: '7d:sonnet',
          resets_at: 1_800_000_000_000,
        },
      ],
    ])
    expect(report.mock.contexts).toEqual([handle, handle])
    expect(routing.mock.calls).toEqual([['session'], ['session']])
  })

  test('omits optional credential and reset fields and preserves header values', () => {
    const sent: unknown[] = []
    install(() => ({
      report: (payload: unknown) => {
        sent.push(payload)
      },
    }))
    const headers = {
      'x-ratelimit-reset': ' 001.500 ',
      'x-ratelimit-remaining': '0',
    }
    reportRouting({
      sessionId: 'session',
      accountId: 'vault-account',
      outcome: 'served',
      headers,
    })
    reportRouting({
      sessionId: 'session',
      accountId: 'vault-account',
      outcome: 'exhausted',
      window: '5h',
    })
    expect(sent).toEqual([
      { account_id: 'vault-account', outcome: 'served', headers },
      { account_id: 'vault-account', outcome: 'exhausted', window: '5h' },
    ])
    expect((sent[0] as { headers: unknown }).headers).toBe(headers)
  })

  test('ignores throwing global getters, accessors, methods and rejected reports', async () => {
    Object.defineProperty(globalThis, symbol, {
      configurable: true,
      get() {
        throw new Error('getter failed')
      },
    })
    expect(() => reportRouting(served)).not.toThrow()
    install(() => {
      throw new Error('accessor failed')
    })
    expect(() => reportRouting(served)).not.toThrow()
    install(() => ({
      get report() {
        throw new Error('report getter failed')
      },
    }))
    expect(() => reportRouting(served)).not.toThrow()
    install(() => ({
      report() {
        throw new Error('report failed')
      },
    }))
    expect(() => reportRouting(served)).not.toThrow()
    install(() => ({
      report: () => Promise.reject(new Error('rejected report')),
    }))
    expect(reportRouting(served)).toBeUndefined()
    await Promise.resolve()
  })

  test('returns immediately even when report never settles, including late registration', () => {
    Reflect.deleteProperty(globalThis, symbol)
    expect(reportRouting(served)).toBeUndefined()
    const report = mock(() => new Promise(() => {}))
    install(() => ({ report }))
    expect(reportRouting(served)).toBeUndefined()
    expect(report).toHaveBeenCalledTimes(1)
  })
})
