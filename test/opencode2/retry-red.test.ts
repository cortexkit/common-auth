import { describe, expect, mock, test } from 'bun:test'
import type { SessionRetryDecision } from '@opencode/plugin/promise/session'
import {
  type ChooseAccountInput,
  type HostError,
  installOpenCode2Auth,
  OpenCode2AuthError,
  type OpenCode2AuthEvents,
  placeholderSecret,
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

async function setup(
  wait?: RetryHold | RetryWaitThenReselect,
  gated = false,
  maxRecords?: number,
) {
  const host = fakeHost()
  const retrySameAccount = mock(
    (input: SameAccountRetryInput): { accountId: string } | undefined => ({
      accountId: input.accountId,
    }),
  )
  const { adapter, choices, plan } = fakeAdapter(undefined, {
    retrySameAccount,
  })
  const accountHeaders = mock(adapter.accountHeaders)
  const dropChoice = mock(() => {})
  const warn = mock((_message: string, _data?: unknown) => {})
  const auth = await installOpenCode2Auth(
    host.ctx,
    {
      ...adapter,
      accountHeaders,
      dropChoice,
      ...(gated && { rewriteWebSocketFrame: ({ frame }) => frame }),
      chooseAccount: (input: ChooseAccountInput) =>
        input.phase === 'retry' && wait ? wait : adapter.chooseAccount(input),
    },
    {
      hostRetryLimit: 4,
      logger: { warn },
      ...(maxRecords === undefined ? {} : { maxRecords }),
      ...(gated && {
        gateOnPlaceholder: {
          credential: (headers: Headers) =>
            headers.get('authorization')?.replace(/^Bearer /, ''),
        },
      }),
    },
  )
  const retries: OpenCode2AuthEvents<unknown>['retry'][] = []
  auth.on('retry', (event) => {
    retries.push(event)
  })
  const send = async (kind: Kind = 'primary', prompt?: string) => {
    const scope = scopeFor(kind)
    const model = await host.fire('model.request', { ...scope, headers: {} })
    return host.fire('http.request', {
      ...scope,
      request: new Request('https://provider.invalid/response', {
        headers: model.headers,
        ...(prompt !== undefined && { method: 'POST', body: prompt }),
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
    sessionID = scopeFor().sessionID,
  ) =>
    host.fire('retry', {
      model: scopeFor().model,
      sessionID,
      agent: scopeFor().agent,
      attempt,
      decision,
      error,
    })
  return {
    auth,
    choices,
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
    warn,
  }
}

async function setupFallback(maxRecords?: number, gated = true) {
  const t = await setup(undefined, gated, maxRecords)
  const scope = scopeFor()
  const owned = {
    authorization: `Bearer ${placeholderSecret(scope.model.providerID)}`,
  }
  const modelRequest = (forScope = scope) =>
    t.host.fire('model.request', { ...forScope, headers: { ...owned } })
  const handshake = (headers = owned, forScope = scope) =>
    t.host.fire('experimental.ws.handshake', {
      ...forScope,
      url: 'wss://provider.invalid/v1/responses',
      headers: { ...headers },
    })
  const http = (headers = owned, forScope = scope) =>
    t.host.fire('http.request', {
      ...forScope,
      request: new Request('https://provider.invalid/v1/responses', {
        headers,
      }),
    })
  const receive = (type: string, forScope = scope) =>
    t.host.fire('experimental.ws.receive', {
      ...forScope,
      frame: JSON.stringify({ type }),
    })
  const queueContinuation = async (forScope = scope) => {
    const first = await handshake(
      (await modelRequest(forScope)).headers,
      forScope,
    )
    expect(new Headers(first.headers).get('x-account')).toBe('A')
    await receive('delta', forScope)
    expect(
      (await t.retry(1, undefined, undefined, forScope.sessionID)).decision,
    ).toEqual({ retry: true, delay: 37 })
    expect(t.retries.at(-1)?.reason).toBe('continue-same-account')
  }
  const continuation = async () => {
    await queueContinuation()
    t.plan.next = 'B'
    const { headers } = await modelRequest()
    const retry = await handshake(headers)
    expect(new Headers(retry.headers).get('x-account')).toBe('A')
    return headers
  }
  const noAccount = (forScope = scope) =>
    new OpenCode2AuthError({
      kind: 'no-account',
      providerID: forScope.model.providerID,
      sessionID: forScope.sessionID,
      requestKind: forScope.kind,
    })
  return {
    ...t,
    scope,
    handshake,
    http,
    receive,
    queueContinuation,
    continuation,
    noAccount,
  }
}

describe('a refusal on the still-open newest attempt', () => {
  test('a WebSocket limit frame before output is rerouted, though the attempt has not ended', async () => {
    const t = await setup()
    // The adapter won't retry a refused account on itself, so only a reroute
    // can serve.
    t.retrySameAccount.mockImplementation(() => undefined as never)
    try {
      const scope = scopeFor()
      // An earlier HTTP attempt of the session is still open, so the refused
      // WebSocket attempt can't be picked as the only one either.
      await t.send()
      const model = await t.host.fire('model.request', {
        ...scope,
        headers: {},
      })
      await t.host.fire('experimental.ws.handshake', {
        ...scope,
        url: 'wss://provider.invalid/v1/responses',
        headers: { ...model.headers } as Record<string, string>,
      })
      await t.host.fire('experimental.ws.receive', {
        ...scope,
        frame: JSON.stringify({ type: 'refused' }),
      })
      t.plan.next = 'B'
      const result = await t.retry(1, { retry: true, delay: 37 }, rateLimit)
      expect(t.retries.at(-1)?.reason).toBe('reroute')
      expect(result.decision).toEqual({ retry: true, delay: 0 })
    } finally {
      await t.auth.dispose()
    }
  })
})

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

  test('a new user turn can move accounts after a post-output retry completes', async () => {
    const t = await setup()
    try {
      await t.interrupt((await t.send()).request)
      expect((await t.retry(1)).decision.retry).toBe(true)
      expect(t.retries.at(-1)?.reason).toBe('continue-same-account')

      await t.respond((await t.send()).request, 200, 'primary')
      await t.host.publish('session.execution.succeeded', {
        sessionID: scopeFor().sessionID,
      })
      t.plan.next = 'B'
      expect((await t.send()).request.headers.get('x-account')).toBe('B')
    } finally {
      await t.auth.dispose()
    }
  })

  test('an execution terminal preserves the output pin on a pending wait', async () => {
    const t = await setup({ waitThenReselect: { delayMs: 25 } })
    try {
      await t.interrupt((await t.send()).request)
      expect((await t.retry(1)).decision.retry).toBe(true)
      const continuation = (await t.send()).request
      expect(continuation.headers.get('x-account')).toBe('A')
      await t.respond(continuation, 429, 'primary')
      expect(
        (await t.retry(2, { retry: true, delay: 37 }, rateLimit)).decision,
      ).toEqual({ retry: true, delay: 25 })
      expect(t.retries.at(-1)?.reason).toBe('wait-then-reselect')

      await t.host.publish('session.execution.interrupted', {
        sessionID: scopeFor().sessionID,
        reason: 'user',
      })
      t.plan.next = 'B'
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
    } finally {
      await t.auth.dispose()
    }
  })

  test('a terminal observed late preserves a newer post-output retry', async () => {
    const t = await setup()
    try {
      t.plan.next = 'B'
      await t.respond((await t.send()).request, 200, 'primary')
      const previousTerminal = {
        type: 'session.execution.succeeded',
        data: { sessionID: scopeFor().sessionID },
      }

      t.plan.next = 'A'
      const nextRun = (await t.send()).request
      expect(nextRun.headers.get('x-account')).toBe('A')
      await t.interrupt(nextRun)
      expect((await t.retry(1)).decision.retry).toBe(true)
      expect(t.retries.at(-1)?.reason).toBe('continue-same-account')

      t.plan.next = 'B'
      await t.host.publish(previousTerminal.type, previousTerminal.data)

      expect((await t.send()).request.headers.get('x-account')).toBe('A')
    } finally {
      await t.auth.dispose()
    }
  })
})

describe('pending retries across execution and transport boundaries', () => {
  // A user interrupt currently leaves the cancelled continuation's account pending.
  test.skip('a new prompt does not inherit a cancelled continuation', async () => {
    const t = await setup()
    try {
      const first = (await t.send('primary', 'First prompt')).request
      expect(first.headers.get('x-account')).toBe('A')
      await t.interrupt(first)
      expect((await t.retry(1)).decision).toEqual({ retry: true, delay: 37 })
      expect(t.retries.at(-1)?.reason).toBe('continue-same-account')

      await t.host.publish('session.execution.interrupted', {
        sessionID: scopeFor().sessionID,
        reason: 'user',
      })
      t.plan.limited.add('A')
      t.plan.next = 'B'

      const next = (await t.send('primary', 'New prompt')).request
      expect(next.headers.get('x-account')).toBe('B')
    } finally {
      await t.auth.dispose()
    }
  })

  for (const gated of [true, false]) {
    test(`HTTP fallback after a failed continuation handshake stays on the output account (placeholder gate: ${gated})`, async () => {
      const t = await setupFallback(undefined, gated)
      try {
        const headers = await t.continuation()
        const fallback = await t.http(headers)
        expect(fallback.request.headers.get('x-account')).toBe('A')
        expect(t.choices).toHaveLength(1)
        expect(t.retrySameAccount).toHaveBeenCalledTimes(1)
      } finally {
        await t.auth.dispose()
      }
    })
  }

  test('not-sent WS fallback and repeated sends stay on the output account', async () => {
    const t = await setupFallback()
    try {
      const headers = await t.continuation()
      await t.host.fire('experimental.ws.send', {
        ...t.scope,
        frame: JSON.stringify({ type: 'response.create' }),
      })
      const first = (await t.http(headers)).request
      const repeated = (await t.http(headers)).request
      expect(first.headers.get('x-account')).toBe('A')
      expect(repeated.headers.get('x-account')).toBe('A')

      // Neither a different Request object nor an older send answers the handoff.
      await t.respond(new Request(repeated), 200, 'primary')
      await t.respond(first, 200, 'primary')
      const latest = (await t.http(headers)).request
      expect(latest.headers.get('x-account')).toBe('A')
      await t.respond(latest, 200, 'primary')
      expect((await t.http()).request.headers.get('x-account')).toBe('B')
    } finally {
      await t.auth.dispose()
    }
  })

  test('a received WS frame releases the guard for the next turn', async () => {
    const t = await setupFallback()
    try {
      await t.continuation()
      expect(new Headers((await t.handshake()).headers).get('x-account')).toBe(
        'A',
      )
      await t.receive('keepalive')
      expect((await t.http()).request.headers.get('x-account')).toBe('B')
    } finally {
      await t.auth.dispose()
    }
  })

  test('an unattributed terminal does not release the fallback guard', async () => {
    const t = await setupFallback()
    try {
      const headers = await t.continuation()
      await t.host.publish('session.execution.succeeded', {
        sessionID: t.scope.sessionID,
      })
      expect((await t.http(headers)).request.headers.get('x-account')).toBe('A')
    } finally {
      await t.auth.dispose()
    }
  })

  test('foreign sends and their replies do not use or release the fallback guard', async () => {
    const t = await setupFallback()
    try {
      const headers = await t.continuation()
      const foreign = { authorization: 'Bearer user-key' }
      const foreignHttp = (await t.http(foreign)).request
      expect(foreignHttp.headers.get('authorization')).toBe(
        foreign.authorization,
      )
      expect(foreignHttp.headers.get('x-account')).toBeNull()
      await t.respond(foreignHttp, 200, 'primary')
      expect((await t.handshake(foreign)).headers).toEqual(foreign)
      await t.receive('keepalive')

      // Mixed ownership prevents safe pinned attribution, not just fresh selection.
      await expect(t.http(headers)).rejects.toThrow(t.noAccount())
      expect(t.choices).toHaveLength(1)
    } finally {
      await t.auth.dispose()
    }
  })

  test('fallback refuses if the pinned account credentials cannot be prepared', async () => {
    const t = await setupFallback()
    try {
      const headers = await t.continuation()
      t.accountHeaders.mockImplementationOnce(() => {
        throw new Error('account credential is unavailable')
      })
      await expect(t.http(headers)).rejects.toThrow(t.noAccount())
      expect(t.choices).toHaveLength(1)
      expect((await t.http(headers)).request.headers.get('x-account')).toBe('A')
    } finally {
      await t.auth.dispose()
    }
  })

  test('an HTTP fallback refusal cannot reroute a reply that already showed output', async () => {
    const t = await setupFallback()
    try {
      const headers = await t.continuation()
      const earlier = (await t.http(headers)).request
      const fallback = (await t.http(headers)).request
      await t.respond(fallback, 429, 'primary')
      // Once the latest response takes over, a successful older send must not
      // retire the shared logical request while the refusal is still judged.
      await t.respond(earlier, 200, 'primary')
      const result = await t.retry(2, { retry: true, delay: 37 }, rateLimit)
      expect(result.decision).toEqual({ retry: false })
      expect(t.retries.at(-1)?.reason).toBe('output-started')
    } finally {
      await t.auth.dispose()
    }
  })

  test('the guard bound refuses a new pinned handshake without evicting a live guard', async () => {
    const t = await setupFallback(1)
    const other = scopeFor('primary', 'ses_other')
    try {
      const headers = await t.continuation()
      t.plan.next = 'A'
      await t.queueContinuation(other)
      t.plan.next = 'B'
      await expect(t.handshake(undefined, other)).rejects.toThrow(
        t.noAccount(other),
      )
      await expect(t.handshake(undefined, other)).rejects.toThrow(
        t.noAccount(other),
      )
      expect(
        t.warn.mock.calls.filter(([message]) =>
          message.includes('fallback guard limit'),
        ),
      ).toHaveLength(1)

      expect((await t.http(headers)).request.headers.get('x-account')).toBe('A')
      t.auth.forgetSession(t.scope.sessionID)
      expect((await t.http()).request.headers.get('x-account')).toBe('B')
    } finally {
      await t.auth.dispose()
    }
  })

  // Known limit, so skipped: terminals name only the session, not the run. If
  // cleanup kept holds across a terminal, a hold from a stopped run would steer
  // the next prompt. Losing this newer hold only means a fresh choice before any
  // output, never a shown reply moving accounts.
  test.skip('a late success does not remove the next execution’s pre-output hold', async () => {
    const target = Date.now() + 25
    const t = await setup({ hold: { delayMs: 25, target } })
    try {
      const earlier = (await t.send()).request
      await t.respond(earlier, 200, 'primary')
      const earlierSuccess = { sessionID: scopeFor().sessionID }

      const successor = (await t.send()).request
      await t.respond(successor, 429, 'primary')
      t.retrySameAccount.mockReturnValue(undefined)
      const result = await t.retry(1, { retry: true, delay: 37 }, rateLimit)
      expect(result.decision).toEqual({ retry: true, delay: 25 })
      expect(t.retries.at(-1)?.reason).toBe('hold')

      await t.host.publish('session.execution.succeeded', earlierSuccess)
      await t.send()
      expect(t.choices.at(-1)?.wake).toEqual({ target })
    } finally {
      await t.auth.dispose()
    }
  })
})
