import {
  afterAll,
  afterEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'
import {
  CACHE_WARM_STOP_REASONS,
  type CacheTouchInput,
  type CacheWarmStoppedInput,
  isCacheWarmStopReason,
  reportCacheTouch,
  reportCacheWarmStopped,
  sessionCachePolicy,
  sessionToolWait,
} from '../../src/routing-accessor/index.js'

const symbol = Symbol.for('cortexkit.routing')
const original = Object.getOwnPropertyDescriptor(globalThis, symbol)
const warning = spyOn(console, 'warn').mockImplementation(() => {})

function install(value: unknown): void {
  Object.defineProperty(globalThis, symbol, { configurable: true, value })
}

function cache(answer: unknown): void {
  install(() => ({ cache: () => answer }))
}

afterEach(() => {
  if (original) Object.defineProperty(globalThis, symbol, original)
  else Reflect.deleteProperty(globalThis, symbol)
  warning.mockClear()
})

afterAll(() => warning.mockRestore())

const hours = { from: '09:15', to: '19:45', tz: 'Europe/Istanbul' }
const validPolicies = [
  {},
  { ttl: 'none' as const },
  { ttl: 'none' as const, keep_warm: 'off' as const },
  ...([undefined, 'short', 'long'] as const).flatMap((ttl) =>
    ([undefined, 'off', 'auto', 'always', 'hours'] as const).map(
      (keep_warm) => ({
        ...(ttl ? { ttl } : {}),
        ...(keep_warm ? { keep_warm } : {}),
        ...(keep_warm === 'hours' ? { hours } : {}),
      }),
    ),
  ),
  {
    keep_warm: 'hours' as const,
    hours: { from: '22:00', to: '06:00', tz: 'UTC' },
  },
]

describe('sessionCachePolicy', () => {
  test.each(validPolicies)('accepts valid policy %j', (policy) => {
    cache(policy)
    expect(sessionCachePolicy('session')).toEqual(policy)
    expect(warning).not.toHaveBeenCalled()
  })

  test.each(
    [
      undefined,
      false,
      1,
      'policy',
      [],
      { ttl: null },
      { ttl: 'LONG' },
      { ttl: 5 },
      { keep_warm: null },
      { keep_warm: 'sustain' },
      { keep_warm: 1 },
      { ttl: 'none', keep_warm: 'auto' },
      { ttl: 'none', keep_warm: 'always' },
      { ttl: 'none', keep_warm: 'hours', hours },
      { keep_warm: 'hours' },
      { keep_warm: 'hours', hours: null },
      { keep_warm: 'hours', hours: [] },
      { hours },
      { keep_warm: 'auto', hours },
      { keep_warm: 'off', hours },
      { keep_warm: 'always', hours },
      { keep_warm: 'off', hours: undefined },
      { unknown: 'field' },
      ...['from', 'to', 'tz'].map((field) => ({
        keep_warm: 'hours',
        hours: { ...hours, [field]: undefined },
      })),
      ...['9:00', '24:00', '12:60', '00:0', ' 09:00', '09:00:00', 900].flatMap(
        (value) =>
          ['from', 'to'].map((field) => ({
            keep_warm: 'hours',
            hours: { ...hours, [field]: value },
          })),
      ),
      { keep_warm: 'hours', hours: { ...hours, to: hours.from } },
      { keep_warm: 'hours', hours: { ...hours, tz: 'not/a-zone' } },
      { keep_warm: 'hours', hours: { ...hours, tz: '' } },
      { keep_warm: 'hours', hours: { ...hours, tz: 5 } },
      { keep_warm: 'hours', hours: { ...hours, extra: true } },
    ].map((value) => [value]),
  )('rejects invalid policy %j', (policy) => {
    cache(policy)
    expect(sessionCachePolicy('session')).toBeNull()
  })

  test('warns once per distinct invalid shape without printing its contents', () => {
    cache({ keep_warm: 'invalid-mode-dedup-a' })
    expect(sessionCachePolicy('session')).toBeNull()
    cache({ keep_warm: 'invalid-mode-dedup-a' })
    expect(sessionCachePolicy('another')).toBeNull()
    expect(warning).toHaveBeenCalledTimes(1)
    cache({ keep_warm: 'invalid-mode-dedup-b' })
    expect(sessionCachePolicy('session')).toBeNull()
    expect(warning).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(warning.mock.calls)).not.toContain(
      'invalid-mode-dedup',
    )
  })

  test('copies the policy and hours instead of retaining bridge state', () => {
    const answer = { keep_warm: 'hours' as const, hours: { ...hours } }
    cache(answer)
    const policy = sessionCachePolicy('session')
    expect(policy).toEqual(answer)
    expect(policy).not.toBe(answer)
    expect(policy?.hours).not.toBe(answer.hours)
    answer.hours.from = '10:00'
    expect(policy?.hours?.from).toBe('09:15')
  })

  test('warns once for an invalid policy that cannot be inspected', () => {
    const unreadable = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('uninspectable policy')
        },
      },
    )
    cache(unreadable)
    expect(sessionCachePolicy('session')).toBeNull()
    expect(sessionCachePolicy('session')).toBeNull()
    expect(warning).toHaveBeenCalledTimes(1)
  })

  test('reads the handle and bound cache method fresh for every decision', () => {
    let answer: unknown = { ttl: 'short' }
    const read = mock(function (this: unknown) {
      expect(this).toBe(handle)
      return answer
    })
    const handle = { cache: read }
    const routing = mock((_sessionId: string) => handle)
    install(routing)
    expect(sessionCachePolicy('a')).toEqual({ ttl: 'short' })
    answer = { keep_warm: 'auto' }
    expect(sessionCachePolicy('b')).toEqual({ keep_warm: 'auto' })
    answer = null
    expect(sessionCachePolicy('a')).toBeNull()
    expect(read.mock.calls).toEqual([[], [], []])
    expect(routing.mock.calls).toEqual([['a'], ['b'], ['a']])
    cache({ ttl: 'long' })
    expect(sessionCachePolicy('a')).toEqual({ ttl: 'long' })
  })
})

describe('synchronous session readers', () => {
  for (const [method, read] of [
    ['cache', sessionCachePolicy],
    ['tool_wait', sessionToolWait],
  ] as const) {
    test(`${method}: unavailable bridges and null results keep plugin defaults`, () => {
      Reflect.deleteProperty(globalThis, symbol)
      expect(read('session')).toBeNull()
      for (const routing of [
        undefined,
        {},
        1,
        () => null,
        () => 'handle',
        () => ({}),
      ]) {
        install(routing)
        expect(read('session')).toBeNull()
      }
      for (const value of [null, undefined, {}, 1, 'method']) {
        install(() => ({ [method]: value }))
        expect(read('session')).toBeNull()
      }
      install(() => ({ [method]: () => null }))
      expect(read('session')).toBeNull()
      expect(warning).not.toHaveBeenCalled()
    })

    test(`${method}: absorbs throwing global, accessor, method and answer getters`, () => {
      Object.defineProperty(globalThis, symbol, {
        configurable: true,
        get() {
          throw new Error('global')
        },
      })
      expect(read('session')).toBeNull()
      install(() => {
        throw new Error('accessor')
      })
      expect(read('session')).toBeNull()
      install(() =>
        Object.defineProperty({}, method, {
          get() {
            throw new Error('method getter')
          },
        }),
      )
      expect(read('session')).toBeNull()
      install(() => ({
        [method]: () => {
          throw new Error('method')
        },
      }))
      expect(read('session')).toBeNull()
      const field = method === 'cache' ? 'ttl' : 'since'
      install(() => ({
        [method]: () =>
          Object.defineProperty({}, field, {
            get() {
              throw new Error('answer getter')
            },
          }),
      }))
      expect(read('session')).toBeNull()
      install(() => ({
        [method]: () =>
          new Proxy(
            {},
            {
              ownKeys() {
                throw new Error('proxy')
              },
            },
          ),
      }))
      expect(read('session')).toBeNull()
    })

    test(`${method}: rejects and absorbs asynchronous reads`, async () => {
      install(() => ({
        [method]: () => Promise.reject(new Error('async reader')),
      }))
      expect(read('session')).toBeNull()
      await Promise.resolve()
    })
  }

  test('absorbs throwing nested hours getters', () => {
    cache({
      keep_warm: 'hours',
      hours: {
        ...hours,
        get tz() {
          throw new Error('zone getter')
        },
      },
    })
    expect(sessionCachePolicy('session')).toBeNull()
  })
})

describe('sessionToolWait', () => {
  test('copies a valid wait and reads it fresh for each session', () => {
    let answer: { since: number } | null = { since: 1_800_000_000_000 }
    const read = mock(() => answer)
    const handle = { tool_wait: read }
    const routing = mock((_id: string) => handle)
    install(routing)
    expect(sessionToolWait('a')).toEqual({ since: 1_800_000_000_000 })
    expect(sessionToolWait('a')).not.toBe(answer)
    answer = { since: 0 }
    expect(sessionToolWait('b')).toEqual({ since: 0 })
    answer = null
    expect(sessionToolWait('a')).toBeNull()
    expect(routing.mock.calls).toEqual([['a'], ['a'], ['b'], ['a']])
    expect(read.mock.contexts).toEqual([handle, handle, handle, handle])
    expect(read.mock.calls).toEqual([[], [], [], []])
  })

  test.each(
    [
      undefined,
      [],
      false,
      3,
      'wait',
      {},
      { since: '123' },
      { since: -1 },
      { since: 1.5 },
      { since: NaN },
      { since: Infinity },
      { since: Number.MAX_SAFE_INTEGER + 1 },
      { since: 0, extra: true },
    ].map((value) => [value]),
  )('rejects invalid wait %j', (answer) => {
    install(() => ({ tool_wait: () => answer }))
    expect(sessionToolWait('session')).toBeNull()
  })
})

describe('cache reports', () => {
  test('exports exactly the billing contract stop reasons and a narrow guard', () => {
    expect(CACHE_WARM_STOP_REASONS).toEqual([
      'cost-cap',
      'count-cap',
      'outside-hours',
      'session-ended',
      'unsupported',
    ])
    for (const reason of CACHE_WARM_STOP_REASONS) {
      expect(isCacheWarmStopReason(reason)).toBe(true)
    }
    for (const reason of [
      'idle',
      'expired',
      'evicted',
      'account-changed',
      'stopped',
      'future-reason',
      '',
      undefined,
      null,
      1,
      {},
      [],
    ]) {
      expect(isCacheWarmStopReason(reason)).toBe(false)
    }
  })

  const touch: CacheTouchInput = {
    at: 1_800_000_000_000,
    ttlMs: 300_000,
    source: 'response',
  }
  const stop: CacheWarmStoppedInput = { at: touch.at, reason: 'count-cap' }

  function sendBoth(): void {
    expect(reportCacheTouch('session', touch)).toBeUndefined()
    expect(reportCacheWarmStopped('session', stop)).toBeUndefined()
  }

  test('sends exact wire records and bound methods, never retries', () => {
    const report = mock((_payload: unknown) => {})
    const handle = { report }
    const routing = mock((_id: string) => handle)
    install(routing)
    reportCacheTouch('a', { ...touch, secret: 'not sent' } as CacheTouchInput)
    reportCacheTouch('b', { at: 0, ttlMs: 'implicit', source: 'warm' })
    reportCacheTouch('b', { at: 1, ttlMs: 0, source: 'response' })
    reportCacheWarmStopped('c', {
      ...stop,
      secret: 'not sent',
    } as CacheWarmStoppedInput)
    reportCacheWarmStopped('c', { at: 0, reason: 'future-runner-reason' })
    expect(report.mock.calls).toEqual([
      [
        {
          kind: 'cache_touch',
          at: touch.at,
          ttl_ms: 300_000,
          source: 'response',
        },
      ],
      [{ kind: 'cache_touch', at: 0, ttl_ms: 'implicit', source: 'warm' }],
      [{ kind: 'cache_touch', at: 1, ttl_ms: 0, source: 'response' }],
      [{ kind: 'cache_warm_stopped', at: stop.at, reason: 'count-cap' }],
      [{ kind: 'cache_warm_stopped', at: 0, reason: 'future-runner-reason' }],
    ])
    expect(report.mock.contexts).toEqual(Array(5).fill(handle))
    expect(routing.mock.calls).toEqual([['a'], ['b'], ['b'], ['c'], ['c']])
  })

  test('is a no-op without a handle or report method', () => {
    Reflect.deleteProperty(globalThis, symbol)
    sendBoth()
    for (const value of [
      undefined,
      {},
      () => null,
      () => ({}),
      () => ({ report: 1 }),
    ]) {
      install(value)
      sendBoth()
    }
  })

  test('absorbs throwing and rejected reports, and never waits', async () => {
    Object.defineProperty(globalThis, symbol, {
      configurable: true,
      get() {
        throw new Error('global')
      },
    })
    sendBoth()
    install(() => {
      throw new Error('accessor')
    })
    sendBoth()
    install(() => ({
      get report() {
        throw new Error('report getter')
      },
    }))
    sendBoth()
    install(() => ({
      report() {
        throw new Error('report')
      },
    }))
    sendBoth()
    const rejected = mock(() => Promise.reject(new Error('async report')))
    install(() => ({ report: rejected }))
    sendBoth()
    await Promise.resolve()
    expect(rejected).toHaveBeenCalledTimes(2)
    const pending = mock(() => new Promise(() => {}))
    install(() => ({ report: pending }))
    sendBoth()
    expect(pending).toHaveBeenCalledTimes(2)
  })

  test.each([1.5, NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1, '123', null])(
    'rejects non-integer epoch milliseconds %j without sending',
    (at) => {
      const report = mock(() => {})
      install(() => ({ report }))
      reportCacheTouch('s', { ...touch, at } as CacheTouchInput)
      reportCacheWarmStopped('s', { ...stop, at } as CacheWarmStoppedInput)
      expect(report).not.toHaveBeenCalled()
    },
  )

  test('rejects malformed report fields without sending', () => {
    const report = mock(() => {})
    install(() => ({ report }))
    for (const ttlMs of [NaN, Infinity, -1, '300000', null]) {
      reportCacheTouch('s', { ...touch, ttlMs } as CacheTouchInput)
    }
    reportCacheTouch('s', {
      ...touch,
      source: 'step',
    } as unknown as CacheTouchInput)
    reportCacheWarmStopped('s', {
      ...stop,
      reason: null,
    } as unknown as CacheWarmStoppedInput)
    expect(report).not.toHaveBeenCalled()
  })
})
