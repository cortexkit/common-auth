import { describe, expect, mock, test } from 'bun:test'
import type { SessionRetryDecision } from '@opencode/plugin/promise/session'
import {
  type ChooseAccountInput,
  type HostError,
  installOpenCode2Auth,
  OpenCode2AuthError,
  type OpenCode2AuthEvents,
  type RetryHold,
  type RetryWaitThenReselect,
  type SameAccountRetryInput,
} from '../../src/opencode2/index.js'
import { fakeAdapter, fakeHost, scopeFor, sse } from './fake-host.js'

type Kind = NonNullable<Parameters<typeof scopeFor>[0]>

const rateLimit = {
  type: 'provider.rate-limit',
  message: 'Too many requests',
  status: 429,
} satisfies HostError

async function setup(wait?: RetryHold | RetryWaitThenReselect) {
  const host = fakeHost()
  const retrySameAccount = mock(({ accountId }: SameAccountRetryInput) => ({
    accountId,
  }))
  const { adapter, plan } = fakeAdapter(undefined, { retrySameAccount })
  const accountHeaders = mock(adapter.accountHeaders)
  const dropChoice = mock(() => {})
  const auth = await installOpenCode2Auth(
    host.ctx,
    {
      ...adapter,
      accountHeaders,
      dropChoice,
      chooseAccount: (input: ChooseAccountInput) =>
        input.phase === 'retry' && wait ? wait : adapter.chooseAccount(input),
    },
    { hostRetryLimit: 4 },
  )
  const retries: OpenCode2AuthEvents<unknown>['retry'][] = []
  auth.on('retry', (event) => {
    retries.push(event)
  })
  const send = async (kind: Kind = 'primary') => {
    const scope = scopeFor(kind)
    const model = await host.fire('model.request', { ...scope, headers: {} })
    return host.fire('http.request', {
      ...scope,
      request: new Request('https://provider.invalid/response', {
        headers: model.headers,
      }),
    })
  }
  const respond = (request: Request, status: number, kind: Kind) =>
    host.fire('http.response', {
      ...scopeFor(kind),
      request,
      response: new Response(null, { status }),
    })
  const interrupt = async (request: Request) => {
    let fail!: () => void
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse([{ type: 'delta' }])))
          fail = () => controller.error(new Error('ECONNRESET'))
        },
      }),
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
    attempt: number,
    decision: SessionRetryDecision = { retry: true, delay: 37 },
    error: HostError = {
      type: 'provider.transport',
      message: 'Connection lost',
    },
  ) =>
    host.fire('retry', {
      model: scopeFor().model,
      sessionID: scopeFor().sessionID,
      agent: scopeFor().agent,
      attempt,
      decision,
      error,
    })
  return {
    auth,
    host,
    plan,
    send,
    respond,
    interrupt,
    retry,
    retries,
    retrySameAccount,
    accountHeaders,
    dropChoice,
  }
}

describe('retry judges the failed primary, not a stale refused side request', () => {
  for (const kind of ['title', 'compaction'] as const) {
    for (const sideRetry of ['not-called', 'judged'] as const) {
      test(`${kind} 429 (${sideRetry}) then primary interrupted read → continue-same-account`, async () => {
        const t = await setup()
        try {
          const side = (await t.send(kind)).request
          await t.respond(side, 429, kind)
          if (sideRetry === 'judged') {
            await t.retry(1, { retry: true, delay: 5 }, rateLimit)
            expect(t.retries.at(-1)?.reason).not.toBe('reroute')
          }
          const sideJudgements = t.retries.length
          const primary = (await t.send('primary')).request
          expect(primary.headers.get('x-account')).toBe('A')
          await t.interrupt(primary)
          t.plan.next = 'B'
          const hostDecision = { retry: true as const, delay: 37 }
          const result = await t.retry(1, hostDecision)
          const event = t.retries.at(-1)
          console.log(
            `F1 ${kind}/${sideRetry}: reason=${event?.reason} kind=${event?.kind} decision=${JSON.stringify(result.decision)} judged=${t.retries.length - sideJudgements}`,
          )
          expect(event?.reason).toBe('continue-same-account')
          expect(event?.kind).toBe('primary')
          expect(result.decision).toBe(hostDecision)
          const continuation = t.retrySameAccount.mock.calls.at(-1)?.[0]
          expect(continuation?.kind).toBe('primary')
          expect(continuation?.continuation).toBe('interrupted-read')
        } finally {
          await t.auth.dispose()
        }
      })
    }
  }

  test('a title refusal that ends after primary starts is judged on the title record', async () => {
    const t = await setup()
    try {
      const title = (await t.send('title')).request
      await t.send('primary')
      await t.respond(title, 429, 'title')

      t.plan.next = 'B'
      const { decision } = await t.retry(
        1,
        { retry: true, delay: 5 },
        rateLimit,
      )
      expect(decision).toEqual({ retry: true, delay: 0 })
      expect(t.retries.at(-1)).toMatchObject({
        kind: 'title',
        reason: 'same-account',
      })
      expect(t.retrySameAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'title',
          limit: { reason: 'too-many', status: 429 },
        }),
      )
      expect((await t.send('title')).request.headers.get('x-account')).toBe('A')
    } finally {
      await t.auth.dispose()
    }
  })
})

describe('a continuation after output keeps its account on the next hop', () => {
  test('continuation refused 429 before output on A is not rerouted to B', async () => {
    const t = await setup()
    try {
      const first = (await t.send()).request
      expect(first.headers.get('x-account')).toBe('A')
      await t.interrupt(first)
      t.plan.next = 'B'
      expect((await t.retry(1)).decision).toEqual({ retry: true, delay: 37 })
      expect(t.retries.at(-1)?.reason).toBe('continue-same-account')
      const continuation = (await t.send()).request
      expect(continuation.headers.get('x-account')).toBe('A')
      await t.respond(continuation, 429, 'primary')
      const result = await t.retry(2, { retry: true, delay: 37 }, rateLimit)
      const event = t.retries.at(-1)
      let nextAccount: string | null | undefined
      let nextError: unknown
      if (result.decision.retry) {
        try {
          nextAccount = (await t.send()).request.headers.get('x-account')
        } catch (error) {
          nextError = error
        }
      }
      console.log(
        `F2: reason=${event?.reason} decision=${JSON.stringify(result.decision)} sameAccountCalls=${t.retrySameAccount.mock.calls.length} next=${nextAccount ?? String(nextError)}`,
      )
      expect(event?.reason).not.toBe('reroute')
      if (result.decision.retry && nextError === undefined)
        expect(nextAccount).toBe('A')
      expect(event?.reason).toBe('output-started')
      expect(result.decision).toEqual({ retry: false })
      expect(result.error).toBe(rateLimit)
    } finally {
      await t.auth.dispose()
    }
  })

  for (const wait of ['hold', 'wait-then-reselect'] as const) {
    test(`a ${wait} can wait but cannot dispatch when the pinned account is no longer usable`, async () => {
      const t = await setup(
        wait === 'hold'
          ? { hold: { delayMs: 25, target: Date.now() + 25 } }
          : { waitThenReselect: { delayMs: 25 } },
      )
      try {
        await t.interrupt((await t.send()).request)
        await t.retry(1)
        const continuation = (await t.send()).request
        expect(continuation.headers.get('x-account')).toBe('A')
        await t.respond(continuation, 429, 'primary')
        expect(
          (await t.retry(2, { retry: true, delay: 37 }, rateLimit)).decision,
        ).toEqual({
          retry: true,
          delay: 25,
        })
        expect(t.retries.at(-1)?.reason).toBe(wait)

        t.plan.limited.add('A')
        await expect(t.send()).rejects.toThrow(
          new OpenCode2AuthError({
            kind: 'no-account',
            providerID: scopeFor().model.providerID,
            sessionID: scopeFor().sessionID,
            requestKind: 'primary',
          }),
        )
        expect(
          t.accountHeaders.mock.calls.map(([input]) => input.accountId),
        ).toEqual(['A', 'A'])
        expect(t.dropChoice).toHaveBeenCalledWith(
          expect.objectContaining({ phase: 'request', accountId: 'B' }),
        )
      } finally {
        await t.auth.dispose()
      }
    })
  }

  test('a new user turn can move accounts after the previous turn showed output', async () => {
    const t = await setup()
    try {
      await t.interrupt((await t.send()).request)
      expect((await t.retry(1)).decision.retry).toBe(true)
      expect(t.retries.at(-1)?.reason).toBe('continue-same-account')

      await t.host.publish('session.status', {
        sessionID: scopeFor().sessionID,
        status: { type: 'idle' },
      })
      t.plan.next = 'B'
      expect((await t.send()).request.headers.get('x-account')).toBe('B')
    } finally {
      await t.auth.dispose()
    }
  })
})
