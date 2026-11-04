import { describe, expect, mock, test } from 'bun:test'
import type { SessionRetryDecision } from '@opencode/plugin/promise/session'
import {
  type HostError,
  installOpenCode2Auth,
  type OpenCode2AuthEvents,
  placeholderSecret,
  type SameAccountRetryInput,
  type SameAccountRetryResult,
} from '../../src/opencode2/index.js'
import { fakeAdapter, fakeHost, PROVIDER, scopeFor, sse } from './fake-host.js'

async function setup(gated = true, hostRetryLimit = 4) {
  const host = fakeHost()
  const state = { identity: 'login-A', usable: true }
  const retrySameAccount = mock(
    ({
      accountId,
    }: SameAccountRetryInput):
      | SameAccountRetryResult
      | undefined
      | Promise<SameAccountRetryResult | undefined> =>
      state.usable && state.identity === 'login-A' ? { accountId } : undefined,
  )
  const dropSameAccountRetry = mock(() => {})
  const { adapter, plan } = fakeAdapter(undefined, {
    retrySameAccount,
    dropSameAccountRetry,
  })
  const chooseAccount = mock(adapter.chooseAccount)
  adapter.chooseAccount = chooseAccount
  const auth = await installOpenCode2Auth(host.ctx, adapter, {
    hostRetryLimit,
    ...(gated
      ? {
          gateOnPlaceholder: {
            credential: (headers: Headers) =>
              headers.get('authorization')?.replace(/^Bearer /, ''),
          },
        }
      : {}),
  })
  const retries: OpenCode2AuthEvents<unknown>['retry'][] = []
  auth.on('retry', (event) => {
    retries.push(event)
  })
  const send = async (owned = true, modelID = 'mock-model') => {
    const scope = {
      ...scopeFor(),
      model: { providerID: PROVIDER, id: modelID },
    }
    const model = await host.fire('model.request', { ...scope, headers: {} })
    return host.fire('http.request', {
      ...scope,
      request: new Request('https://provider.invalid/response', {
        headers: {
          ...model.headers,
          authorization: `Bearer ${owned ? placeholderSecret(PROVIDER) : 'user-key'}`,
        },
      }),
    })
  }
  const interrupt = async (
    request: Request,
    events: unknown[] = [{ type: 'delta' }],
    status = 200,
  ) => {
    let fail!: () => void
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse(events)))
          fail = () => controller.error(new Error('ECONNRESET'))
        },
      }),
      { status },
    )
    const reply = await host.fire('http.response', {
      ...scopeFor(),
      request,
      response,
    })
    const reader = reply.response.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    fail()
    await expect(reader.read()).rejects.toThrow('ECONNRESET')
  }
  const retry = (
    attempt = 1,
    decision: SessionRetryDecision = { retry: true, delay: 37 },
    error: HostError = {
      type: 'provider.transport',
      message: 'Connection lost',
    },
  ) =>
    host.fire('retry', {
      model: scopeFor().model,
      sessionID: 'ses_1',
      agent: scopeFor().agent,
      attempt,
      decision,
      error,
    })
  return {
    host,
    auth,
    adapter,
    plan,
    send,
    interrupt,
    retry,
    retries,
    retrySameAccount,
    dropSameAccountRetry,
    chooseAccount,
    state,
  }
}

describe('interrupted HTTP output', () => {
  for (const gated of [true, false]) {
    test(`witnessed HTTP read failure preserves host continuation and pins the account (gated=${gated})`, async () => {
      const t = await setup(gated)
      try {
        const first = (await t.send()).request
        await t.interrupt(first)
        t.plan.next = 'B'
        const decision = { retry: true as const, delay: 37 }
        expect((await t.retry(1, decision)).decision).toBe(decision)
        const continued = (await t.send()).request
        expect(continued.headers.get('x-account')).toBe('A')
        expect(continued.headers.get('authorization')).toBe('Bearer tok-A')
        expect(t.chooseAccount).toHaveBeenCalledTimes(1)
        expect(t.retrySameAccount).toHaveBeenCalledTimes(1)
        const input = t.retrySameAccount.mock.calls[0]?.[0]
        expect(input?.continuation).toBe('interrupted-read')
        expect(input?.limit).toBeUndefined()
        expect(t.retries.at(-1)?.reason).toBe('continue-same-account')
        expect(t.dropSameAccountRetry).not.toHaveBeenCalled()
      } finally {
        await t.auth.dispose()
      }
    })
  }

  for (const refusal of [
    'response-429',
    'stream-limit',
    'host-limit',
    'host-quota',
    'host-payment',
    'response-veto',
    'rebound-account',
    'changed-identity',
    'unusable-account',
    'different-account',
    'no-callback',
    'mixed',
    'host-declined',
    'budget-exhausted',
  ] as const) {
    const behavior = refusal === 'mixed' ? 'defers to host' : 'still refuses'
    test(`${refusal} ${behavior} after a witnessed read failure`, async () => {
      const t = await setup()
      try {
        if (refusal === 'response-veto') t.adapter.responseRetry = () => 'veto'
        if (refusal === 'rebound-account')
          t.adapter.answeredBy = () => ({ accountId: 'B' })
        if (refusal === 'changed-identity') t.state.identity = 'login-B'
        if (refusal === 'unusable-account') t.state.usable = false
        if (refusal === 'different-account')
          t.retrySameAccount.mockImplementation(() => ({ accountId: 'B' }))
        if (refusal === 'no-callback') delete t.adapter.retrySameAccount
        if (refusal === 'mixed') await t.send(false)
        if (refusal === 'host-limit')
          t.adapter.limitFromError = () => ({ reason: 'usage-limit' })
        const first = (await t.send()).request
        await t.interrupt(
          first,
          refusal === 'stream-limit'
            ? [{ type: 'delta' }, { type: 'refused' }]
            : [{ type: 'delta' }],
          refusal === 'response-429' ? 429 : 200,
        )
        const hostDecision: SessionRetryDecision =
          refusal === 'host-declined'
            ? { retry: false }
            : { retry: true, delay: 37 }
        const decision = (
          await t.retry(
            refusal === 'budget-exhausted' ? 4 : 1,
            hostDecision,
            refusal === 'host-payment'
              ? {
                  type: 'provider.quota',
                  message: 'Payment required',
                  status: 402,
                }
              : refusal === 'host-quota'
                ? { type: 'provider.quota', message: 'Usage exhausted' }
                : undefined,
          )
        ).decision
        if (refusal === 'mixed') expect(decision).toBe(hostDecision)
        else expect(decision).toEqual({ retry: false })
        expect(t.retries.at(-1)?.reason).toBe(
          refusal === 'mixed' ? 'host-decides' : 'output-started',
        )
        expect(t.chooseAccount).toHaveBeenCalledTimes(1)
        if (
          ![
            'changed-identity',
            'unusable-account',
            'different-account',
          ].includes(refusal)
        )
          expect(t.retrySameAccount).not.toHaveBeenCalled()
        if (refusal === 'different-account')
          expect(t.dropSameAccountRetry).toHaveBeenCalledTimes(1)
        if (refusal === 'mixed') {
          t.plan.next = 'B'
          expect((await t.send()).request.headers.get('x-account')).toBe('B')
        }
      } finally {
        await t.auth.dispose()
      }
    })
  }

  for (const unwitnessed of [
    'reported-read',
    'non-read',
    'incomplete',
    'cancelled',
  ] as const) {
    test(`${unwitnessed} without a witnessed read failure still refuses`, async () => {
      const t = await setup()
      try {
        const request = (await t.send()).request
        const reply = await t.host.fire('http.response', {
          ...scopeFor(),
          request,
          response: new Response(sse([{ type: 'delta' }])),
        })
        const reader = reply.response.body!.getReader()
        await reader.read()
        if (unwitnessed === 'cancelled') await reader.cancel('stopped')
        else while (!(await reader.read()).done) {}
        const error = {
          type:
            unwitnessed === 'incomplete'
              ? 'provider.invalid-output'
              : 'provider.transport',
          message:
            unwitnessed === 'non-read'
              ? 'Connection lost while writing'
              : 'Connection lost while reading the response',
        }
        expect((await t.retry(1, undefined, error)).decision).toEqual({
          retry: false,
        })
        expect(t.retrySameAccount).not.toHaveBeenCalled()
        expect(t.retries.at(-1)?.reason).toBe('output-started')
      } finally {
        await t.auth.dispose()
      }
    })
  }

  test('the last available host retry is allowed', async () => {
    const t = await setup(true, 2)
    try {
      await t.interrupt((await t.send()).request)
      expect((await t.retry(1)).decision).toEqual({ retry: true, delay: 37 })
    } finally {
      await t.auth.dispose()
    }
  })

  test('the identity gate may refresh a token without changing the pinned account', async () => {
    const t = await setup()
    t.retrySameAccount.mockImplementation(({ accountId }) => {
      t.adapter.accountHeaders = () => ({
        authorization: 'Bearer refreshed-token',
        'x-account': accountId,
      })
      return { accountId }
    })
    try {
      await t.interrupt((await t.send()).request)
      expect((await t.retry()).decision.retry).toBe(true)
      t.plan.next = 'B'
      const request = (await t.send()).request
      expect(request.headers.get('x-account')).toBe('A')
      expect(request.headers.get('authorization')).toBe(
        'Bearer refreshed-token',
      )
      expect(t.chooseAccount).toHaveBeenCalledTimes(1)
    } finally {
      await t.auth.dispose()
    }
  })

  for (const cancellation of ['dispose', 'forget', 'mixed'] as const) {
    test(`${cancellation} during the continuation check releases the result`, async () => {
      const t = await setup()
      let entered!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      let complete!: (result: SameAccountRetryResult) => void
      const pending = new Promise<SameAccountRetryResult>((resolve) => {
        complete = resolve
      })
      t.retrySameAccount.mockImplementation(() => {
        entered()
        return pending
      })
      try {
        await t.interrupt((await t.send()).request)
        const hostDecision = { retry: true as const, delay: 37 }
        const retrying = t.retry(1, hostDecision)
        await started
        const disposing =
          cancellation === 'dispose' ? t.auth.dispose() : undefined
        if (cancellation === 'forget') t.auth.forgetSession('ses_1')
        if (cancellation === 'mixed') await t.send(false)
        complete({ accountId: 'A' })
        if (cancellation === 'mixed') {
          expect((await retrying).decision).toBe(hostDecision)
          expect(t.retries.at(-1)?.reason).toBe('host-decides')
          t.plan.next = 'B'
          expect((await t.send()).request.headers.get('x-account')).toBe('B')
        } else {
          await expect(retrying).rejects.toMatchObject({ kind: 'no-account' })
        }
        await disposing
        expect(t.dropSameAccountRetry).toHaveBeenCalledTimes(1)
      } finally {
        await t.auth.dispose()
      }
    })
  }

  test('a pending continuation cannot choose afresh after a route change', async () => {
    const t = await setup()
    try {
      await t.interrupt((await t.send()).request)
      expect((await t.retry()).decision.retry).toBe(true)
      t.plan.next = 'B'
      await expect(t.send(true, 'different-model')).rejects.toMatchObject({
        kind: 'no-account',
      })
      expect(t.chooseAccount).toHaveBeenCalledTimes(1)
      expect(t.dropSameAccountRetry).toHaveBeenCalledTimes(1)
    } finally {
      await t.auth.dispose()
    }
  })

  test('a pending continuation refuses newly mixed ownership without selecting', async () => {
    const t = await setup()
    try {
      await t.interrupt((await t.send()).request)
      expect((await t.retry()).decision.retry).toBe(true)
      await t.send(false)
      t.plan.next = 'B'
      await expect(t.send()).rejects.toMatchObject({ kind: 'no-account' })
      expect(t.chooseAccount).toHaveBeenCalledTimes(1)
      expect(t.dropSameAccountRetry).toHaveBeenCalledTimes(1)
    } finally {
      await t.auth.dispose()
    }
  })
})
