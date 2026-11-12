import { expect } from 'bun:test'
import { ClaustrumCredentialError } from '@cortexkit/claustrum-client'
import {
  type ClaustrumScopedAttempt,
  type ClaustrumScopedClient,
  ClaustrumScopedCustody,
  ClaustrumUnreachableError,
  VAULT_RECEIPT_WAIT_MS,
  VAULT_YOUNG_OUTAGE_MS,
} from '../../src/claustrum/index.ts'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { captureLogger, family } from './helpers.ts'

const { test, lifetime } = lifetimeHooks()
const identity = {
  credentialId: 'oauth:test:work',
  credentialType: 'oauth' as const,
  accountIdentity: 'work',
}
const flush = async () => {
  for (let turn = 0; turn < 40; turn++) await Promise.resolve()
}

function scenario() {
  let now = 0
  const timers = new Set<{
    at: number
    run: () => void
    unref: () => void
    unreferenced: boolean
  }>()
  const setTimeoutImpl = ((run: () => void, delay: number) => {
    const timer = {
      at: now + delay,
      run,
      unreferenced: false,
      unref() {
        this.unreferenced = true
      },
    }
    timers.add(timer)
    return timer
  }) as unknown as typeof setTimeout
  const clearTimeoutImpl = ((timer: never) => {
    timers.delete(timer)
  }) as typeof clearTimeout
  const unavailable = new ClaustrumCredentialError(
    'unavailable',
    'transient',
    'retry',
  )
  const calls: number[] = []
  let get: ClaustrumScopedClient['getScoped'] = async () => {
    throw unavailable
  }
  const answer = () => ({
    credentialId: identity.credentialId,
    accountId: identity.accountIdentity,
    material: 'recovered-token',
    recordVersion: 1,
    expiresAtMs: now + 3_600_000,
  })
  const custody = lifetime.manage(
    new ClaustrumScopedCustody({
      client: {
        getScoped: (input) => {
          calls.push(now)
          return get(input)
        },
        listScoped: async () => {
          throw unavailable
        },
        reportAuthFailureScoped: async () => {},
        close() {},
      },
      family,
      readToken: async () => ({ token: 'ab'.repeat(32), token_generation: 1 }),
      logger: captureLogger().logger,
      now: () => now,
      setTimeoutImpl,
      clearTimeoutImpl,
    }),
  )
  return {
    custody,
    calls,
    unavailable,
    answer,
    now: () => now,
    setGet: (next: typeof get) => {
      get = next
    },
    pending: () => [...timers].map((timer) => timer.at - now),
    async advance(ms: number) {
      await flush()
      const target = now + ms
      for (;;) {
        const next = [...timers].sort((a, b) => a.at - b.at)[0]
        if (!next || next.at > target) break
        expect(next.unreferenced).toBe(true)
        now = next.at
        timers.delete(next)
        next.run()
        await flush()
      }
      now = target
      await flush()
    },
  }
}

function observed(pending: Promise<ClaustrumScopedAttempt>) {
  let result: { value?: ClaustrumScopedAttempt; error?: unknown } | undefined
  void pending.then(
    (value) => {
      result = { value }
    },
    (error: unknown) => {
      result = { error }
    },
  )
  return () => result
}

test('cold receipt wait succeeds when the vault returns after two seconds', async () => {
  const s = scenario()
  s.setGet(async () => {
    if (s.now() < 2_000) throw s.unavailable
    return s.answer()
  })
  const result = observed(s.custody.authorize(identity))
  await s.advance(1_999)
  expect(result()).toBeUndefined()
  await s.advance(751)
  expect(result()?.value?.accessToken).toBe('recovered-token')
  expect(result()?.value?.fromKeptReceipt).toBeUndefined()
  expect(s.calls).toEqual([0, 250, 750, 1_750, 2_750])
  expect(s.pending()).toEqual([])
  s.custody.transportLost()
  expect((await s.custody.authorize(identity)).fromKeptReceipt).toBe(true)
  expect(s.calls).toHaveLength(5)
})

test('cold receipt wait preserves the unreachable error at the ten second bound', async () => {
  expect(VAULT_RECEIPT_WAIT_MS).toBe(10_000)
  const s = scenario()
  const result = observed(s.custody.authorize(identity))
  await s.advance(9_999)
  expect(result()).toBeUndefined()
  await s.advance(1)
  expect(result()?.error).toBe(s.unavailable)
  const calls = s.calls.length
  await s.advance(2_000)
  expect(s.calls).toHaveLength(calls)
})

test('cold receipt wait stops immediately on a vault refusal', async () => {
  const s = scenario()
  const refusal = new ClaustrumCredentialError(
    'grant_denied',
    'permanent',
    'gone',
  )
  const result = observed(s.custody.authorize(identity))
  await s.advance(250)
  s.setGet(async () => {
    throw refusal
  })
  await s.advance(500)
  expect(result()?.error).toBe(refusal)
  expect(s.calls).toEqual([0, 250, 750])
  expect(s.pending()).toEqual([])
})

test('cold receipt wait retains the sanitized transport error class and code', async () => {
  const s = scenario()
  s.setGet(async () => {
    throw Object.assign(new Error('private transport detail'), {
      code: 'ECONNREFUSED',
    })
  })
  const result = observed(s.custody.authorize(identity))
  await s.advance(10_000)
  expect(result()?.error).toBeInstanceOf(ClaustrumUnreachableError)
  expect(result()?.error).toMatchObject({ kind: 'unavailable' })
  expect(String(result()?.error)).not.toContain('private transport detail')
})

test('usable kept receipt serves immediately without a request wait', async () => {
  const s = scenario()
  s.setGet(async () => s.answer())
  await s.custody.authorize(identity)
  s.setGet(async () => {
    throw s.unavailable
  })
  const kept = await s.custody.authorize(identity)
  expect(kept.fromKeptReceipt).toBe(true)
  expect(s.now()).toBe(0)
  expect(s.calls).toEqual([0, 0])
  expect(s.pending()).toEqual([2_000])
})

test('expired kept receipt receives the same bounded wait as a cold account', async () => {
  const s = scenario()
  s.setGet(async () => s.answer())
  await s.custody.authorize(identity)
  await s.advance(3_540_000)
  s.setGet(async () => {
    throw s.unavailable
  })
  const result = observed(s.custody.authorize(identity))
  await s.advance(250)
  expect(result()).toBeUndefined()
  s.setGet(async () => s.answer())
  await s.advance(500)
  expect(result()?.value?.fromKeptReceipt).toBeUndefined()
  expect(result()?.value?.accessToken).toBe('recovered-token')
})

test('old outage without any successful call fails without a receipt wait', async () => {
  expect(VAULT_YOUNG_OUTAGE_MS).toBe(60_000)
  const s = scenario()
  s.custody.transportLost()
  await s.advance(60_000)
  await expect(s.custody.authorize(identity)).rejects.toBe(s.unavailable)
  expect(s.calls).toEqual([60_000])
})

test('abort during receipt backoff clears request timers promptly', async () => {
  const s = scenario()
  const abort = new AbortController()
  const result = observed(s.custody.authorize(identity, abort.signal))
  await s.advance(100)
  const reason = new Error('caller cancelled')
  abort.abort(reason)
  await flush()
  expect(result()?.error).toBe(reason)
  expect(s.pending()).toEqual([1_900]) // Only the existing idle discovery probe remains.
  await s.advance(1_000)
  expect(s.calls).toEqual([0])
  s.custody.close()
  expect(s.pending()).toEqual([])
})

test('concurrent receipt waiters share probes but own separate receipts', async () => {
  const s = scenario()
  const first = observed(s.custody.authorize(identity))
  const second = observed(s.custody.authorize(identity))
  await s.advance(250)
  expect(s.calls).toEqual([0, 0, 250])
  s.setGet(async () => s.answer())
  await s.advance(500)
  expect(s.calls).toEqual([0, 0, 250, 750])
  expect(first()?.value?.accessToken).toBe('recovered-token')
  expect(second()?.value?.accessToken).toBe('recovered-token')
  expect(first()?.value).not.toBe(second()?.value)
  expect(s.pending()).toEqual([])
})

test('one aborted receipt waiter does not cancel another waiter', async () => {
  const s = scenario()
  const abort = new AbortController()
  const first = observed(s.custody.authorize(identity, abort.signal))
  const second = observed(s.custody.authorize(identity))
  await s.advance(100)
  abort.abort('cancel first')
  await flush()
  expect(first()?.error).toBe('cancel first')
  s.setGet(async () => s.answer())
  await s.advance(150)
  expect(second()?.value?.accessToken).toBe('recovered-token')
  expect(s.calls).toEqual([0, 0, 250])
})

test('later receipt waiters join recovery and retain their own ten second bound', async () => {
  const s = scenario()
  const first = observed(s.custody.authorize(identity))
  await s.advance(100)
  const second = observed(s.custody.authorize(identity))
  await flush()
  expect(s.calls).toEqual([0])
  await s.advance(9_900)
  expect(first()?.error).toBe(s.unavailable)
  expect(second()).toBeUndefined()
  await s.advance(100)
  expect(second()?.error).toBe(s.unavailable)
})

test('abort during a stalled recovery read releases the single flight', async () => {
  const s = scenario()
  const abort = new AbortController()
  const result = observed(s.custody.authorize(identity, abort.signal))
  await s.advance(100)
  s.setGet(() => new Promise(() => {}))
  await s.advance(150)
  abort.abort('cancel stalled probe')
  await flush()
  expect(result()?.error).toBe('cancel stalled probe')
  expect(s.pending()).toEqual([1_750])
  s.setGet(async () => s.answer())
  expect((await s.custody.authorize(identity)).accessToken).toBe(
    'recovered-token',
  )
  expect(s.pending()).toEqual([])
})

for (const stop of ['close', 'dispose'] as const) {
  test(`${stop} ends a receipt wait and clears every timer`, async () => {
    const s = scenario()
    const result = observed(s.custody.authorize(identity))
    await s.advance(100)
    await s.custody[stop]()
    await flush()
    expect(result()?.error).toMatchObject({ kind: 'closed' })
    expect(s.pending()).toEqual([])
    await s.advance(20_000)
    expect(s.calls).toEqual([0])
  })
}

test('receipt wait deadline also bounds a stalled recovery read', async () => {
  const s = scenario()
  const result = observed(s.custody.authorize(identity))
  await s.advance(100)
  s.setGet(() => new Promise(() => {}))
  await s.advance(9_899)
  expect(result()).toBeUndefined()
  await s.advance(1)
  expect(result()?.error).toBe(s.unavailable)
  expect(s.calls).toEqual([0, 250])
  s.custody.close()
  expect(s.pending()).toEqual([])
})
