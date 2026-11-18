import {
  afterEach,
  describe,
  expect,
  expectTypeOf,
  mock,
  spyOn,
  test,
} from 'bun:test'
import {
  type AskRoutingInput,
  askRouting,
  type ReportRoutingInput,
  type RoutingRefusal,
  type RoutingSelection,
  reportRouting,
} from '../../src/routing-accessor/index.js'

test('routing accessor imports only bridge modules and the Node crypto builtin', async () => {
  const build = await Bun.build({
    entrypoints: [
      new URL('../../src/routing-accessor/index.ts', import.meta.url).pathname,
    ],
    target: 'node',
    plugins: [
      {
        name: 'bridge-closure',
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) => {
            if (!args.importer) return
            // Bun injects its own Node target runtime, outside the source graph.
            if (args.importer === 'runtime' && args.path === 'node:module')
              return
            if (
              args.path === './handle.js' ||
              args.path === './cache-policy.js' ||
              args.path === 'node:crypto'
            )
              return
            throw new Error(
              `routing-accessor must stay dependency-free: ${args.path} from ${args.importer}`,
            )
          })
        },
      },
    ],
  })
  expect(build.success).toBe(true)
  expect(build.logs).toEqual([])
})

test('routing handle itself has no dependencies', async () => {
  const build = await Bun.build({
    entrypoints: [
      new URL('../../src/routing-accessor/handle.ts', import.meta.url).pathname,
    ],
    target: 'node',
    plugins: [
      {
        name: 'handle-closure',
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) => {
            if (args.importer === 'runtime' && args.path === 'node:module')
              return
            if (args.importer)
              throw new Error(
                `routing handle must not import dependencies: ${args.path} from ${args.importer}`,
              )
          })
        },
      },
    ],
  })
  expect(build.success).toBe(true)
  expect(build.logs).toEqual([])
})

const symbol = Symbol.for('cortexkit.routing')
const original = Object.getOwnPropertyDescriptor(globalThis, symbol)
const candidate = {
  accountId: 'vault-account',
  credentialId: 'vault-credential',
  route: { kind: 'oauth' },
}
const candidateView = {
  view_digest:
    '25478d57c66c318bc8ed460d02c02530eecc284dc35d8afaa6da0d73a119b6d3',
  accounts: [
    { account_id: 'vault-account', credential_id: 'vault-credential' },
  ],
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
  test('sends candidates in input order with a digest of the sorted account lines', async () => {
    const accounts = [
      { accountId: 'b', credentialId: 'c2', label: 'not sent' },
      { accountId: 'a', credentialId: 'c1', label: 'not sent' },
    ]
    const accountFor = mock((_request: unknown) =>
      Promise.resolve({ account_id: 'a', credential_id: 'c1' }),
    )
    install(() => ({ accountFor }))
    const selected = await askRouting({ ...input, candidates: accounts })
    expect(selected?.candidate).toBe(accounts[1])
    expect(accountFor.mock.calls[0]?.[0]).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet',
      candidates: {
        view_digest:
          '10059db6eaf3fe5e8d2ccc17a5059ef02deca3ca6c1df44d17ff2ac5f3f7ea37',
        accounts: [
          { account_id: 'b', credential_id: 'c2' },
          { account_id: 'a', credential_id: 'c1' },
        ],
      },
    })
  })

  test('sorts digest lines by UTF-8 bytes instead of JavaScript string order', async () => {
    const accountFor = mock((_request: unknown) => Promise.resolve(null))
    install(() => ({ accountFor }))
    await askRouting({
      ...input,
      candidates: [
        { accountId: '\u{10000}', credentialId: 'c2' },
        { accountId: '\uE000', credentialId: 'c1' },
      ],
    })
    expect(accountFor.mock.calls[0]?.[0]).toHaveProperty(
      'candidates.view_digest',
      '2ca028d04c79fd58a037c31f5b8cbbb19cb3b32f7020f3c0d64232a34cbee0e9',
    )
  })

  test('omits invalid candidates and leaves out the view when none are valid', async () => {
    const invalid = [
      { ...candidate, credentialId: '' },
      { ...candidate, credentialId: 'x'.repeat(257) },
      { ...candidate, credentialId: 'bad\u0080credential' },
      { ...candidate, credentialId: 1 as unknown as string },
      { ...candidate, accountId: '' },
      { ...candidate, accountId: null as unknown as string },
    ]
    const accountFor = mock((_request: unknown) => Promise.resolve(null))
    install(() => ({ accountFor }))
    await askRouting({ ...input, candidates: [candidate, ...invalid] })
    expect(accountFor.mock.calls[0]?.[0]).toHaveProperty(
      'candidates',
      candidateView,
    )
    await askRouting({ ...input, candidates: invalid })
    expect(accountFor.mock.calls[1]?.[0]).toStrictEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet',
    })
  })

  test('sends mode only for the exact continue value', async () => {
    const accountFor = mock((_request: unknown) => Promise.resolve(null))
    install(() => ({ accountFor }))
    await askRouting({ ...input, mode: 'continue' })
    await askRouting(input)
    await askRouting({
      ...input,
      mode: 'Continue',
    } as unknown as AskRoutingInput)
    expect(accountFor.mock.calls[0]?.[0]).toHaveProperty('mode', 'continue')
    expect(accountFor.mock.calls[1]?.[0]).not.toHaveProperty('mode')
    expect(accountFor.mock.calls[2]?.[0]).not.toHaveProperty('mode')
  })

  test('keeps existing caller types narrow and infers opted-in refusal types', async () => {
    answerWith({ account_id: candidate.accountId })
    const existingInput: AskRoutingInput<typeof candidate> = input
    const existing = await askRouting(existingInput)
    expectTypeOf(existing).toEqualTypeOf<
      RoutingSelection<typeof candidate> | undefined
    >()
    const explicitFalse = await askRouting({ ...input, refusals: false })
    expectTypeOf(explicitFalse).toEqualTypeOf<
      RoutingSelection<typeof candidate> | undefined
    >()
    const optedIn = await askRouting({ ...input, refusals: true })
    expectTypeOf(optedIn).toEqualTypeOf<
      RoutingSelection<typeof candidate> | RoutingRefusal | undefined
    >()
    const booleanInput: AskRoutingInput<typeof candidate, boolean> = {
      ...input,
      refusals: true,
    }
    const dynamic = await askRouting(booleanInput)
    expectTypeOf(dynamic).toEqualTypeOf<
      RoutingSelection<typeof candidate> | RoutingRefusal | undefined
    >()
    const optedInInput: AskRoutingInput<typeof candidate, true> = {
      ...input,
      refusals: true,
    }
    const typedOptedIn = await askRouting(optedInInput)
    expectTypeOf(typedOptedIn).toEqualTypeOf<
      RoutingSelection<typeof candidate> | RoutingRefusal | undefined
    >()
    expect(existing).toEqual({ candidate })
  })

  test.each([undefined, false, true])(
    'sends refusals only for an explicit true flag: %p',
    async (refusals) => {
      const accountFor = mock(() => Promise.resolve(null))
      install(() => ({ accountFor }))
      await askRouting({ ...input, refusals, holdWaitMaxS: 12.9 })
      expect(accountFor).toHaveBeenCalledWith(
        {
          provider: 'anthropic',
          modelId: 'claude-sonnet',
          hold_wait_max_s: 12,
          ...(refusals === true ? { refusals: true } : {}),
          candidates: candidateView,
        },
        { deadlineMs: 1500 },
      )
    },
  )

  test.each([
    'account_limit_exhausted',
    'account_selection_refused',
    'account_selection_final',
  ])('returns an opted-in routing refusal: %s', async (code) => {
    answerWith({ refused: { code } })
    expect(await askRouting({ ...input, refusals: true })).toEqual({
      refused: { code },
    })
  })

  test('passes through the reason for a terminal account-selection refusal', async () => {
    answerWith({
      refused: {
        code: 'account_selection_final',
        routing_code: 'account_unservable',
        reason: 'candidates_disjoint',
      },
    })
    expect(await askRouting({ ...input, refusals: true })).toEqual({
      refused: {
        code: 'account_selection_final',
        routingCode: 'account_unservable',
        reason: 'candidates_disjoint',
      },
    })
    expect(await askRouting(input)).toBeUndefined()
  })

  test.each([
    undefined,
    null,
    false,
    42,
    'account_limit_exhausted',
    [],
    {},
    { code: null },
    { code: 1 },
    { code: 'unknown_refusal' },
  ])('ignores an unreadable refusal: %p', async (refused) => {
    answerWith({ refused })
    expect(await askRouting({ ...input, refusals: true })).toBeUndefined()
  })

  test.each([
    ['routing_code', 'routingCode', 'quota.daily-1_exhausted'],
    ['routing_code', 'routingCode', 'a'.repeat(64)],
    ['retry_after_secs', 'retryAfterSecs', 0],
    ['retry_after_secs', 'retryAfterSecs', 1.5],
    ['resets_at_ms', 'resetsAtMs', 1],
    ['resets_at_ms', 'resetsAtMs', Number.MAX_SAFE_INTEGER],
  ] as const)(
    'copies a valid refusal member %s to %s: %p',
    async (wire, local, value) => {
      answerWith({
        refused: {
          code: 'account_limit_exhausted',
          [wire]: value,
          ignored: 'not copied',
        },
      })
      expect(await askRouting({ ...input, refusals: true })).toEqual({
        refused: { code: 'account_limit_exhausted', [local]: value },
      })
    },
  )

  const invalidOptionalMembers = [
    ...[
      undefined,
      null,
      1,
      '',
      'UPPER',
      'with space',
      'slash/code',
      'trailing\n',
      'a'.repeat(65),
    ].flatMap((value) =>
      (['routing_code', 'reason'] as const).map((wire) => ({ wire, value })),
    ),
    ...[undefined, null, '1', -1, NaN, Infinity, -Infinity].map((value) => ({
      wire: 'retry_after_secs' as const,
      value,
    })),
    ...[
      undefined,
      null,
      '1',
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      -Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ].map((value) => ({ wire: 'resets_at_ms' as const, value })),
  ]
  test.each(invalidOptionalMembers)(
    'drops an invalid optional refusal member without losing the refusal: %p',
    async ({ wire, value }) => {
      answerWith({
        refused: {
          code: 'account_selection_refused',
          routing_code: 'quota.daily',
          reason: 'quota_exhausted',
          retry_after_secs: 2.5,
          resets_at_ms: 1234,
          [wire]: value,
        },
      })
      const validMembers: Record<string, unknown> = {
        routingCode: 'quota.daily',
        reason: 'quota_exhausted',
        retryAfterSecs: 2.5,
        resetsAtMs: 1234,
      }
      const localName = {
        routing_code: 'routingCode',
        reason: 'reason',
        retry_after_secs: 'retryAfterSecs',
        resets_at_ms: 'resetsAtMs',
      }
      delete validMembers[localName[wire]]
      expect(await askRouting({ ...input, refusals: true })).toEqual({
        refused: { code: 'account_selection_refused', ...validMembers },
      })
    },
  )

  test.each([undefined, false])(
    'ignores a refusal without opting in: %p',
    async (refusals) => {
      answerWith({ refused: { code: 'account_selection_final' } })
      expect(await askRouting({ ...input, refusals })).toBeUndefined()
    },
  )

  test('preserves candidate selection, metadata, holds and eligibility with refusals enabled', async () => {
    answerWith({ account_id: candidate.accountId })
    const selected = await askRouting({ ...input, refusals: true })
    expect(selected).toEqual({ candidate })
    if (!selected || !('candidate' in selected)) {
      throw new Error('expected a candidate selection')
    }
    expect(selected.candidate).toBe(candidate)
    expectTypeOf(selected.candidate).toEqualTypeOf<typeof candidate>()
    expect(selected.candidate.route.kind).toBe('oauth')
    answerWith({
      account_id: candidate.accountId,
      credential_id: candidate.credentialId,
      hold: { retry_after_ms: 2000 },
    })
    expect(await askRouting({ ...input, refusals: true })).toEqual({
      candidate,
      hold: { retry_after_ms: 2000 },
    })
    expect(
      await askRouting({ ...input, candidates: [], refusals: true }),
    ).toBeUndefined()
    answerWith({
      account_id: candidate.accountId,
      credential_id: 'wrong-credential',
    })
    expect(await askRouting({ ...input, refusals: true })).toBeUndefined()
  })

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
    [undefined, 1500],
    [25, 25],
    [0, 1],
    [-10, 1],
    [4000, 2000],
    [NaN, 1500],
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
      {
        provider: 'anthropic',
        modelId: 'claude-sonnet',
        candidates: candidateView,
      },
      { deadlineMs: expected },
    )
    expect(accountFor.mock.contexts[0]).toBe(handle)
  })

  test.each([
    [600, 600],
    [12.9, 12],
    [0, 0],
    [-5, 0],
  ])('sends the hold cap %p as hold_wait_max_s %p', async (cap, expected) => {
    const accountFor = mock(() =>
      Promise.resolve({ account_id: candidate.accountId }),
    )
    install(() => ({ accountFor }))
    await askRouting({ ...input, holdWaitMaxS: cap })
    expect(accountFor).toHaveBeenCalledWith(
      {
        provider: 'anthropic',
        modelId: 'claude-sonnet',
        hold_wait_max_s: expected,
        candidates: candidateView,
      },
      { deadlineMs: 1500 },
    )
  })

  test.each([undefined, NaN, Infinity])(
    'omits hold_wait_max_s for cap %p',
    async (cap) => {
      const accountFor = mock(() =>
        Promise.resolve({ account_id: candidate.accountId }),
      )
      install(() => ({ accountFor }))
      await askRouting({ ...input, holdWaitMaxS: cap })
      expect(accountFor).toHaveBeenCalledWith(
        {
          provider: 'anthropic',
          modelId: 'claude-sonnet',
          candidates: candidateView,
        },
        { deadlineMs: 1500 },
      )
    },
  )

  test.each([false, true])(
    'times out a never-settling accountFor using an unref timer with refusals = %p',
    async (refusals) => {
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
      const pending = askRouting({ ...input, deadlineMs: 7, refusals })
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
    },
  )

  test('finds an accessor registered after module load and observes replacements', async () => {
    Reflect.deleteProperty(globalThis, symbol)
    expect(await askRouting(input)).toBeUndefined()
    answerWith({ account_id: candidate.accountId })
    expect(await askRouting(input)).toEqual({ candidate })
    install(() => null)
    expect(await askRouting(input)).toBeUndefined()
  })
})

describe('reportRouting transient backoff', () => {
  const backoff = {
    kind: 'transient_backoff',
    sessionId: 'session',
    accountId: 'vault-account',
    retryAtMs: 1700000005000,
  } satisfies ReportRoutingInput

  test('sends the exact payload through the session handle', () => {
    const report = mock((_payload: unknown) => {})
    const handle = { report }
    const accessor = mock((_sessionId: string) => handle)
    install(accessor)
    const full = {
      ...backoff,
      credentialId: 'c'.repeat(256),
      providerCode: ' RATE_LIMIT/Busy '.padEnd(128, 'x'),
      ignored: 'not forwarded',
    }
    expect(reportRouting(full)).toBeUndefined()
    expect(reportRouting(backoff)).toBeUndefined()
    expect(accessor.mock.calls).toEqual([['session'], ['session']])
    expect(report.mock.contexts).toEqual([handle, handle])
    expect(report.mock.calls).toStrictEqual([
      [
        {
          kind: 'transient_backoff',
          account_id: 'vault-account',
          credential_id: full.credentialId,
          retry_at_ms: 1700000005000,
          provider_code: full.providerCode,
        },
      ],
      [
        {
          kind: 'transient_backoff',
          account_id: 'vault-account',
          retry_at_ms: 1700000005000,
        },
      ],
    ])
  })

  test.each([
    ['sessionId', ''],
    ['sessionId', 1],
    ['accountId', ''],
    ['accountId', null],
    ['retryAtMs', undefined],
    ['retryAtMs', '1700000005000'],
    ['retryAtMs', 0],
    ['retryAtMs', -1],
    ['retryAtMs', 1.5],
    ['retryAtMs', Infinity],
    ['retryAtMs', Number.MAX_SAFE_INTEGER + 1],
    ['credentialId', null],
    ['credentialId', ''],
    ['credentialId', 'x'.repeat(257)],
    ['credentialId', 'bad\u0080credential'],
    ['providerCode', null],
    ['providerCode', ''],
    ['providerCode', 'x'.repeat(129)],
    ['providerCode', 'bad\ncode'],
  ])('drops the whole backoff when %s is invalid: %p', (field, value) => {
    const report = mock((_payload: unknown) => {})
    install(() => ({ report }))
    reportRouting({ ...backoff, [field]: value } as ReportRoutingInput)
    expect(report).not.toHaveBeenCalled()
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

  test('sends nothing for an invalid exhausted window', () => {
    const report = mock((_payload: unknown) => {})
    install(() => ({ report }))
    expect(
      reportRouting({
        ...served,
        outcome: 'exhausted',
        window: 'non-gemini:5h',
      } as unknown as ReportRoutingInput),
    ).toBeUndefined()
    expect(report).not.toHaveBeenCalled()
  })

  test.each(['five_hour', 'seven_day', '1d', '', null, undefined, 5])(
    'rejects unsupported exhausted window %j',
    (window) => {
      const report = mock((_payload: unknown) => {})
      install(() => ({ report }))
      expect(
        reportRouting({
          ...served,
          outcome: 'exhausted',
          window,
        } as unknown as ReportRoutingInput),
      ).toBeUndefined()
      expect(report).not.toHaveBeenCalled()
    },
  )

  test.each([
    '',
    ':non-gemini',
    'non-gemini:5h',
    'non-gemini:',
    'Fable',
    'a'.repeat(65),
    'pool name',
    null,
    0,
    false,
    {},
  ])('sends nothing for invalid exhausted pool %j', (pool) => {
    const report = mock((_payload: unknown) => {})
    install(() => ({ report }))
    expect(
      reportRouting({
        ...served,
        outcome: 'exhausted',
        window: '5h',
        pool,
      } as unknown as ReportRoutingInput),
    ).toBeUndefined()
    expect(report).not.toHaveBeenCalled()
  })

  test('sends an exhausted pool name of 64 characters unchanged', () => {
    const report = mock((_payload: unknown) => {})
    install(() => ({ report }))
    const pool = 'a'.repeat(64)
    reportRouting({
      ...served,
      outcome: 'exhausted',
      window: '5h',
      pool,
    })
    expect(report.mock.calls).toEqual([
      [
        {
          account_id: 'vault-account',
          credential_id: 'vault-credential',
          outcome: 'exhausted',
          window: '5h',
          pool,
        },
      ],
    ])
  })

  test('sends only contract fields for a credential refusal', () => {
    const report = mock((_payload: unknown) => {})
    const handle = { report }
    const routing = mock((_sessionId: string) => handle)
    install(routing)
    expect(
      reportRouting({
        ...served,
        outcome: 'credential_refused',
        providerCode: 'prepaid_balance_exhausted',
        token: 'must not be sent',
        email: 'must not be sent',
        label: 'must not be sent',
        status: 402,
        message: 'must not be sent',
      } as ReportRoutingInput),
    ).toBeUndefined()
    expect(report.mock.calls).toEqual([
      [
        {
          account_id: 'vault-account',
          credential_id: 'vault-credential',
          outcome: 'credential_refused',
          provider_code: 'prepaid_balance_exhausted',
        },
      ],
    ])
    expect(report.mock.contexts).toEqual([handle])
    expect(routing.mock.calls).toEqual([['session']])
  })

  test.each(['a', 'a'.repeat(64), 'balance.v1-exhausted_0'])(
    'sends a credential refusal provider code %j unchanged',
    (providerCode) => {
      const report = mock((_payload: unknown) => {})
      install(() => ({ report }))
      reportRouting({
        ...served,
        outcome: 'credential_refused',
        providerCode,
      })
      expect(report.mock.calls).toEqual([
        [
          {
            account_id: 'vault-account',
            credential_id: 'vault-credential',
            outcome: 'credential_refused',
            provider_code: providerCode,
          },
        ],
      ])
    },
  )

  test.each([
    'bad:code',
    'a'.repeat(65),
    'Prepaid_balance_exhausted',
    'balance exhausted',
    '',
    undefined,
    null,
    402,
    false,
    {},
  ])(
    'sends nothing for an invalid credential refusal provider code %j',
    (providerCode) => {
      const report = mock((_payload: unknown) => {})
      install(() => ({ report }))
      expect(
        reportRouting({
          ...served,
          outcome: 'credential_refused',
          providerCode,
        } as unknown as ReportRoutingInput),
      ).toBeUndefined()
      expect(report).not.toHaveBeenCalled()
    },
  )

  test.each([undefined, '', null, 0])(
    'sends nothing for a credential refusal with a missing or invalid credential id %j',
    (credentialId) => {
      const report = mock((_payload: unknown) => {})
      install(() => ({ report }))
      expect(
        reportRouting({
          sessionId: 'session',
          accountId: candidate.accountId,
          ...(credentialId !== undefined ? { credentialId } : {}),
          outcome: 'credential_refused',
          providerCode: 'prepaid_balance_exhausted',
        } as unknown as ReportRoutingInput),
      ).toBeUndefined()
      expect(report).not.toHaveBeenCalled()
    },
  )

  test('sends only contract fields for served and pool exhausted outcomes', () => {
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
      pool: 'must not be sent',
      resetsAt: 123,
    } as ReportRoutingInput)
    reportRouting({
      ...served,
      outcome: 'exhausted',
      window: '7d',
      pool: 'non-gemini',
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
          window: '7d',
          pool: 'non-gemini',
          resets_at: 1_800_000_000_000,
        },
      ],
    ])
    expect(report.mock.contexts).toEqual([handle, handle])
    expect(routing.mock.calls).toEqual([['session'], ['session']])
    expect(
      report.mock.calls.map(([payload]) => JSON.stringify(payload)),
    ).toEqual([
      '{"account_id":"vault-account","credential_id":"vault-credential","outcome":"served","headers":{"anthropic-ratelimit-requests-remaining":"9"}}',
      '{"account_id":"vault-account","credential_id":"vault-credential","outcome":"exhausted","window":"7d","pool":"non-gemini","resets_at":1800000000000}',
    ])
  })

  test('treats an explicitly undefined pool as whole-account exhaustion', () => {
    // Callers often spread an optional field (`pool: maybePool`); that must not
    // drop a valid whole-account report.
    const report = mock((_payload: unknown) => {})
    install(() => ({ report }))
    reportRouting({
      ...served,
      outcome: 'exhausted',
      window: '7d',
      pool: undefined,
    } as ReportRoutingInput)
    expect(report).toHaveBeenCalledTimes(1)
    expect(report.mock.calls[0]?.[0]).not.toHaveProperty('pool')
  })

  test('omits pool for whole-account exhaustion and preserves header values', () => {
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
    expect(sent.map((payload) => JSON.stringify(payload))).toEqual([
      '{"account_id":"vault-account","outcome":"served","headers":{"x-ratelimit-reset":" 001.500 ","x-ratelimit-remaining":"0"}}',
      '{"account_id":"vault-account","outcome":"exhausted","window":"5h"}',
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
