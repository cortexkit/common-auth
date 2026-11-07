import { describe, expect, mock, test } from 'bun:test'
import type { SessionRetryDecision } from '@opencode/plugin/promise/session'
import {
  type Attempt,
  type AttemptOutcome,
  type HostError,
  installOpenCode2Auth,
  type OpenCode2AuthEvents,
  placeholderSecret,
  type SameAccountRetryInput,
  type SameAccountRetryResult,
} from '../../src/opencode2/index.js'
import { fakeAdapter, fakeHost, PROVIDER, scopeFor } from './fake-host.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function setup(gated = true) {
  const host = fakeHost()
  const info = mock((_message: string, _data?: unknown) => {})
  const onAttemptEnd = mock(
    (_attempt: Attempt, _outcome: AttemptOutcome): void | Promise<void> => {},
  )
  const retrySameAccount = mock(
    ({
      accountId,
    }: SameAccountRetryInput): SameAccountRetryResult | undefined => ({
      accountId,
    }),
  )
  const { adapter, plan } = fakeAdapter(undefined, {
    retrySameAccount,
    onAttemptEnd,
  })
  const inspectEvent = adapter.inspectEvent!
  adapter.inspectEvent = (input) => {
    const event = JSON.parse(input.data)
    if (event.type === 'done') return { done: true }
    if (event.type === 'failed') return { error: 'Provider response failed' }
    if (event.type === 'veto') return { hostRetry: 'veto' }
    return inspectEvent(input)
  }
  const chooseAccount = mock(adapter.chooseAccount)
  adapter.chooseAccount = chooseAccount
  const auth = await installOpenCode2Auth(host.ctx, adapter, {
    hostRetryLimit: 4,
    logger: { warn: mock(() => {}), info },
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
  const send = async (owned = true) => {
    const scope = scopeFor()
    const model = await host.fire('model.request', { ...scope, headers: {} })
    return host.fire('experimental.ws.handshake', {
      ...scope,
      url: 'wss://provider.invalid/response?secret=do-not-log',
      headers: {
        ...model.headers,
        authorization: `Bearer ${owned ? placeholderSecret(PROVIDER) : 'user-key'}`,
      },
    })
  }
  const frame = (type: string) =>
    host.fire('experimental.ws.receive', {
      ...scopeFor(),
      frame: JSON.stringify({ type }),
    })
  const retry = (
    attempt = 1,
    error: HostError = {
      type: 'provider.transport',
      message: 'WebSocket closed with code 1006; secret=do-not-log',
    },
    decision: SessionRetryDecision = { retry: true, delay: 37 },
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
    frame,
    retry,
    retries,
    retrySameAccount,
    onAttemptEnd,
    chooseAccount,
    info,
  }
}

describe('interrupted WebSocket output', () => {
  for (const gated of [true, false]) {
    test(`WebSocket cut after output continues on the same account (gated=${gated})`, async () => {
      const t = await setup(gated)
      try {
        await t.send()
        await t.frame('delta')
        t.plan.next = 'B'
        const decision = { retry: true as const, delay: 37 }
        expect((await t.retry(1, undefined, decision)).decision).toBe(decision)
        expect(t.retrySameAccount).toHaveBeenCalledTimes(1)
        expect(t.retrySameAccount.mock.calls[0]?.[0]).toMatchObject({
          sessionID: 'ses_1',
          accountId: 'A',
          continuation: 'interrupted-read',
        })
        expect(t.onAttemptEnd).toHaveBeenCalledTimes(1)
        expect(t.onAttemptEnd.mock.calls[0]?.[1]).toMatchObject({
          outputStarted: true,
          error: { reason: 'failed' },
        })
        const next = await t.send()
        expect(next.headers).toMatchObject({
          'x-account': 'A',
          authorization: 'Bearer tok-A',
        })
        expect(t.chooseAccount).toHaveBeenCalledTimes(1)
        expect(t.retries.at(-1)?.reason).toBe('continue-same-account')
        expect(t.info).toHaveBeenLastCalledWith(
          'opencode2 auth retry decision',
          {
            sessionID: 'ses_1',
            transport: 'ws',
            attempt: 1,
            reason: 'continue-same-account',
            retry: true,
          },
        )
      } finally {
        await t.auth.dispose()
      }
    })
  }

  for (const refusal of [
    'terminal-done',
    'terminal-failed',
    'stream-limit',
    'host-limit',
    'draft-4xx',
    'non-transport',
    'payment',
    'rebound',
    'adapter-veto',
    'recovery-declined',
    'mixed',
    'budget-exhausted',
    'no-callback',
    'host-declined',
  ] as const) {
    test(`${refusal} keeps the existing WebSocket retry decision after output`, async () => {
      const t = await setup()
      try {
        if (refusal === 'mixed') await t.send(false)
        if (refusal === 'no-callback') delete t.adapter.retrySameAccount
        if (refusal === 'recovery-declined')
          t.retrySameAccount.mockImplementation(() => undefined)
        if (refusal === 'host-limit')
          t.adapter.limitFromError = () => ({ reason: 'usage-limit' })
        if (refusal === 'rebound') {
          // WebSocket has no response rebind hook; model the guarded handle state directly.
          t.auth.on('select', ({ handle }) => {
            Object.defineProperty(handle, 'reboundFrom', { value: 'original' })
          })
        }
        await t.send()
        await t.frame('delta')
        if (refusal.startsWith('terminal-'))
          await t.frame(refusal === 'terminal-done' ? 'done' : 'failed')
        if (refusal === 'stream-limit') await t.frame('refused')
        if (refusal === 'adapter-veto') await t.frame('veto')
        const error: HostError = {
          type:
            refusal === 'non-transport'
              ? 'provider.invalid-output'
              : refusal === 'payment'
                ? 'provider.quota'
                : 'provider.transport',
          message: 'Connection lost while reading; secret=do-not-log',
          ...(refusal === 'draft-4xx' ? { status: 400 } : {}),
          ...(refusal === 'payment' ? { status: 402 } : {}),
        }
        const hostDecision: SessionRetryDecision =
          refusal === 'host-declined'
            ? { retry: false }
            : { retry: true, delay: 37 }
        const decision = (
          await t.retry(
            refusal === 'budget-exhausted' ? 4 : 1,
            error,
            hostDecision,
          )
        ).decision
        if (refusal === 'mixed') expect(decision).toBe(hostDecision)
        else expect(decision).toEqual({ retry: false })
        expect(t.retries.at(-1)?.reason).toBe(
          refusal === 'mixed' ? 'host-decides' : 'output-started',
        )
        if (refusal === 'recovery-declined')
          expect(t.retrySameAccount).toHaveBeenCalledTimes(1)
        else expect(t.retrySameAccount).not.toHaveBeenCalled()
        if (refusal === 'terminal-done') {
          expect(t.info).toHaveBeenLastCalledWith(
            'opencode2 auth retry decision',
            {
              sessionID: 'ses_1',
              transport: 'ws',
              attempt: 1,
              reason: 'output-started',
              retry: false,
            },
          )
          expect(t.onAttemptEnd.mock.calls[0]?.[1].error).toBeUndefined()
        }
        expect(t.chooseAccount).toHaveBeenCalledTimes(1)
      } finally {
        await t.auth.dispose()
      }
    })
  }

  test('attempt-end feedback settles before recovery and late frames cannot reopen the cut attempt', async () => {
    const t = await setup()
    const entered = deferred()
    const ended = deferred()
    t.onAttemptEnd.mockImplementation(async () => {
      entered.resolve()
      await ended.promise
    })
    try {
      await t.send()
      await t.frame('delta')
      const retrying = t.retry()
      await entered.promise
      expect(t.retrySameAccount).not.toHaveBeenCalled()
      await t.frame('refused')
      await t.frame('veto')
      await t.frame('done')
      await t.frame('failed')
      ended.resolve()
      expect((await retrying).decision).toEqual({ retry: true, delay: 37 })
      expect(t.retrySameAccount).toHaveBeenCalledTimes(1)
      expect(t.onAttemptEnd).toHaveBeenCalledTimes(1)
      expect(t.onAttemptEnd.mock.calls[0]?.[1]).toMatchObject({
        outputStarted: true,
        error: { reason: 'failed' },
      })
      expect(t.retries.at(-1)?.reason).toBe('continue-same-account')
    } finally {
      ended.resolve()
      await t.auth.dispose()
    }
  })
})
