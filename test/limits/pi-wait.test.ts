import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import {
  type AccountKey,
  buildRefusal,
  confirmedAffinity,
  createRequestHistory,
  decideAfterLimit,
  type MaxSameAccountWait,
  type PiWaitOptions,
  type PiWaitResult,
  type PolicyFacts,
  waitForPi,
} from '../../src/limits/index.js'
import { pi140RetryPattern } from './fixtures/pi-retry-patterns.js'

const now = 1_800_000_000_000
const day = 86400000
const account: AccountKey = {
  namespace: 'pool',
  accountId: 'A',
  incarnation: 'one',
}
const restorers: (() => void)[] = []
afterEach(() => {
  for (const restore of restorers.splice(0).reverse()) restore()
})

function fakeClock() {
  let time = now
  let id = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  const clock = spyOn(Date, 'now').mockImplementation(() => time)
  const schedule = spyOn(globalThis, 'setTimeout').mockImplementation(((
    run: () => void,
    delay = 0,
  ) => {
    timers.set(++id, { at: time + delay, run })
    return id
  }) as unknown as typeof setTimeout)
  const cancel = spyOn(globalThis, 'clearTimeout').mockImplementation(((
    timer: number,
  ) => {
    timers.delete(timer)
  }) as unknown as typeof clearTimeout)
  restorers.push(
    () => clock.mockRestore(),
    () => schedule.mockRestore(),
    () => cancel.mockRestore(),
  )
  return {
    pending: () => timers.size,
    advance(ms: number) {
      const end = time + ms
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > end) break
        timers.delete(next[0])
        time = next[1].at
        next[1].run()
      }
      time = end
    },
  }
}

function an56(setting: MaxSameAccountWait = 15): PolicyFacts {
  return {
    phase: 'pre-send',
    host: 'pi',
    now,
    clockNow: now,
    sessionId: 'pi-terminal',
    requestScope: { kind: 'model', model: 'claude-opus' },
    history: createRequestHistory({
      requestId: 'request',
      originalUrl: 'https://provider.invalid',
      clockNow: now,
    }),
    attempted: account,
    delivery: { owned: true, attributable: true, replayable: true },
    candidates: [],
    terminal: {
      source: 'pool',
      reason: 'quota',
      scan: {
        candidates: [
          {
            account,
            readingAccount: account,
            windows: [
              {
                window: 'scoped',
                scope: { kind: 'model', model: 'claude-opus' },
                blockedBy: 'exhausted',
                reset: { at: now + day, observedAt: now },
              },
            ],
          },
        ],
        effectiveModel: 'claude-opus',
        familyOf: () => 'claude',
        maxAgeMs: day,
        maxSameAccountWait: setting,
      },
    },
  }
}

// A plugin owns this driver: after elapsed it supplies current facts and the
// checkpoint to the reducer, then publishes the refusal. The helper does neither.
async function terminalCaller(
  facts: PolicyFacts,
  options: PiWaitOptions,
  publish: ReturnType<typeof mock>,
) {
  let decision = decideAfterLimit(facts, confirmedAffinity)
  if (decision.action === 'wait-then-reselect') {
    if ((await waitForPi(decision.delayMs, options)) === 'aborted') return
    decision = decideAfterLimit(
      {
        ...facts,
        now: Date.now(),
        clockNow: Date.now(),
        wake: {
          checkpoint: decision.checkpoint,
          target: decision.target,
          kind: decision.waitKind,
        },
      },
      confirmedAffinity,
    )
  }
  if (decision.action !== 'refuse' || decision.family !== 'pi-final')
    throw new Error('Expected a final Pi refusal')
  publish(
    buildRefusal({ ...decision, family: decision.family, now: Date.now() }),
  )
}

describe('Pi wait helper', () => {
  test('countdown updates every second and clears at the exact deadline', async () => {
    const clock = fakeClock()
    const messages: [number, string | undefined][] = []
    const waiting = waitForPi(2500, {
      setWorkingMessage: (text) => messages.push([Date.now() - now, text]),
    })
    expect(messages).toEqual([
      [0, 'Waiting for the account limit to reset · 3s · Esc to cancel'],
    ])
    clock.advance(999)
    expect(messages).toHaveLength(1)
    clock.advance(1)
    expect(messages.at(-1)).toEqual([
      1000,
      'Waiting for the account limit to reset · 2s · Esc to cancel',
    ])
    clock.advance(1000)
    expect(messages.at(-1)).toEqual([
      2000,
      'Waiting for the account limit to reset · 1s · Esc to cancel',
    ])
    clock.advance(499)
    expect(clock.pending()).toBe(1)
    clock.advance(1)
    expect(await waiting).toBe('elapsed')
    expect(messages.at(-1)).toEqual([2500, undefined])
    expect(clock.pending()).toBe(0)
    clock.advance(10000)
    expect(messages).toHaveLength(4)
  })

  test('abort mid-wait resolves immediately without advancing the clock', async () => {
    const clock = fakeClock()
    const controller = new AbortController()
    const remove = spyOn(controller.signal, 'removeEventListener')
    restorers.push(() => remove.mockRestore())
    const messages = mock()
    let result: PiWaitResult | undefined
    void waitForPi(900000, {
      signal: controller.signal,
      setWorkingMessage: messages,
    }).then((value) => {
      result = value
    })
    clock.advance(450)
    controller.abort(new Error('stream cancelled'))
    await Promise.resolve()
    expect(result).toBe('aborted')
    expect(Date.now()).toBe(now + 450)
    expect(messages.mock.calls).toEqual([
      ['Waiting for the account limit to reset · 15m · Esc to cancel'],
      [undefined],
    ])
    expect(clock.pending()).toBe(0)
    expect(remove).toHaveBeenCalledTimes(1)
    clock.advance(900000)
    expect(messages).toHaveBeenCalledTimes(2)
  })

  test('an already-aborted signal clears without arming a timer', async () => {
    const clock = fakeClock()
    const controller = new AbortController()
    controller.abort()
    const messages = mock()
    expect(
      await waitForPi(900000, {
        signal: controller.signal,
        setWorkingMessage: messages,
      }),
    ).toBe('aborted')
    expect(messages.mock.calls).toEqual([[undefined]])
    expect(clock.pending()).toBe(0)
  })

  test('zero delay clears immediately and elapsed removes the abort listener', async () => {
    const clock = fakeClock()
    const controller = new AbortController()
    const messages = mock()
    expect(
      await waitForPi(0, {
        signal: controller.signal,
        setWorkingMessage: messages,
      }),
    ).toBe('elapsed')
    controller.abort()
    expect(messages.mock.calls).toEqual([[undefined]])
    expect(clock.pending()).toBe(0)
  })

  test('cancellation inside the UI callback does not leave a timer', async () => {
    const clock = fakeClock()
    const controller = new AbortController()
    const messages = mock((text?: string) => {
      if (text) controller.abort()
    })
    expect(
      await waitForPi(1000, {
        signal: controller.signal,
        setWorkingMessage: messages,
      }),
    ).toBe('aborted')
    expect(messages.mock.calls).toEqual([
      ['Waiting for the account limit to reset · 1s · Esc to cancel'],
      [undefined],
    ])
    expect(clock.pending()).toBe(0)
  })

  test('a UI failure cannot strand the wait or mask an abort', async () => {
    const clock = fakeClock()
    for (const abort of [false, true]) {
      const controller = new AbortController()
      const waiting = waitForPi(1000, {
        signal: controller.signal,
        setWorkingMessage: () => {
          throw new Error('UI unavailable')
        },
      })
      if (abort) controller.abort()
      else clock.advance(1000)
      expect(await waiting).toBe(abort ? 'aborted' : 'elapsed')
      expect(clock.pending()).toBe(0)
    }
  })

  test.each(['unchanged', 'admission-revoked', 'identity-replaced'])(
    'helper never sends; caller re-checks admission and identity: %s',
    async (change) => {
      const clock = fakeClock()
      let admitted = true
      let incarnation = 'one'
      const options = {
        setWorkingMessage: mock(),
        recheck: mock(() => admitted && incarnation === 'one'),
        send: mock(),
      }
      const waiting = waitForPi(2000, options)
      if (change === 'admission-revoked') admitted = false
      if (change === 'identity-replaced') incarnation = 'two'
      clock.advance(2000)
      expect(await waiting).toBe('elapsed')
      expect(options.recheck).not.toHaveBeenCalled()
      expect(options.send).not.toHaveBeenCalled()

      if (options.recheck()) options.send()
      expect(options.recheck).toHaveBeenCalledTimes(1)
      expect(options.send).toHaveBeenCalledTimes(change === 'unchanged' ? 1 : 0)
    },
  )
})

describe('Pi terminal wait delivery through the caller', () => {
  test('AN56 under 15 waits 900000 ms with a countdown then refuses without host retry', async () => {
    const clock = fakeClock()
    const publish = mock()
    const messages: [number, string | undefined][] = []
    const done = terminalCaller(
      an56(),
      {
        setWorkingMessage: (text) => messages.push([Date.now() - now, text]),
      },
      publish,
    )
    expect(messages).toEqual([
      [0, 'Waiting for the account limit to reset · 15m · Esc to cancel'],
    ])
    clock.advance(899999)
    await Promise.resolve()
    expect(publish).not.toHaveBeenCalled()
    expect(messages).toHaveLength(900)
    expect(messages.at(-1)).toEqual([
      899000,
      'Waiting for the account limit to reset · 1s · Esc to cancel',
    ])
    clock.advance(1)
    await done
    expect(messages.map(([time]) => time)).toEqual(
      Array.from({ length: 901 }, (_, i) => i * 1000),
    )
    expect(messages.at(-1)).toEqual([900000, undefined])
    expect(clock.pending()).toBe(0)
    expect(publish).toHaveBeenCalledTimes(1)
    const refusal = publish.mock.calls[0]![0]
    expect(refusal).toEqual({
      kind: 'text',
      family: 'pi-final',
      disposition: 'refuse',
      retryable: false,
      hostRetry: 'veto',
      body: 'The request cannot continue. Reset at 23h 45m.',
    })
    expect(pi140RetryPattern.test(refusal.body)).toBe(false)
    expect(refusal.body.toLowerCase()).not.toContain('retry in')
  })

  test('AN56 abort mid-wait gives no refusal', async () => {
    const clock = fakeClock()
    const controller = new AbortController()
    const publish = mock()
    const messages = mock()
    const done = terminalCaller(
      an56(),
      { signal: controller.signal, setWorkingMessage: messages },
      publish,
    )
    clock.advance(450000)
    controller.abort()
    await done
    expect(Date.now()).toBe(now + 450000)
    expect(messages.mock.calls.at(-1)).toEqual([undefined])
    expect(clock.pending()).toBe(0)
    clock.advance(900000)
    expect(publish).not.toHaveBeenCalled()
  })

  test('AN56 under 0 refuses immediately without entering the helper', async () => {
    const clock = fakeClock()
    const publish = mock()
    const messages = mock()
    await terminalCaller(an56(0), { setWorkingMessage: messages }, publish)
    expect(Date.now()).toBe(now)
    expect(clock.pending()).toBe(0)
    expect(messages).not.toHaveBeenCalled()
    expect(publish).toHaveBeenCalledTimes(1)
    const refusal = publish.mock.calls[0]![0]
    expect(refusal.body).toBe('The request cannot continue. Reset at 1d 0h 0m.')
    expect(pi140RetryPattern.test(refusal.body)).toBe(false)
    expect(refusal).toMatchObject({ retryable: false, hostRetry: 'veto' })
  })

  test('the version-cited fixture detects Pi retry triggers, not just safe refusals', () => {
    for (const text of [
      'overloaded',
      'rate limit',
      '429',
      '520',
      'service is temporarily unavailable',
      'network error',
      'request to https://provider.invalid failed, reason: closed',
      'timeout',
      'stream ended before message_stop',
      'please retry your request',
      'ResourceExhausted',
      'subscription_sharing_user_unavailable',
    ]) {
      expect(pi140RetryPattern.test(text), text).toBe(true)
    }
  })
})
