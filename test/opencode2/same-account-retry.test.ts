import { describe, expect, mock, test } from 'bun:test'
import type { SessionRetryDecision } from '@opencode/plugin/promise/session'
import {
  type ChooseAccountInput,
  installOpenCode2Auth,
  type OpenCode2AuthEvents,
  placeholderSecret,
  type SameAccountRetryInput,
  type SameAccountRetryResult,
} from '../../src/opencode2/index.js'
import { fakeAdapter, fakeHost, PROVIDER, scopeFor, sse } from './fake-host.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function setup(maxRecords?: number) {
  const host = fakeHost()
  const retrySameAccount = mock(
    (
      _input: SameAccountRetryInput,
    ):
      | SameAccountRetryResult
      | undefined
      | Promise<SameAccountRetryResult | undefined> => undefined,
  )
  const dropSameAccountRetry = mock(
    (_input: SameAccountRetryInput & SameAccountRetryResult) => {},
  )
  const dropChoice = mock(
    (_input: ChooseAccountInput & { accountId: string }) => {},
  )
  const limitFromError = mock(() => ({ reason: 'limited', status: 429 }))
  const state = { token: 'old-token', direct: false }
  const { adapter, plan } = fakeAdapter(undefined, {
    retrySameAccount,
    dropSameAccountRetry,
    dropChoice,
    limitFromError,
    accountHeaders: ({ accountId }) => ({
      authorization: `Bearer ${state.token}`,
      'x-account': accountId,
    }),
    rewriteRequest: ({ request }) =>
      new Request(
        state.direct ? 'https://provider.invalid/direct' : request.url,
        request,
      ),
  })
  const chooseAccount = mock(adapter.chooseAccount)
  adapter.chooseAccount = chooseAccount
  const auth = await installOpenCode2Auth(host.ctx, adapter, {
    ...(maxRecords === undefined ? {} : { maxRecords }),
    gateOnPlaceholder: {
      credential: (headers) =>
        headers.get('authorization')?.replace(/^Bearer /, ''),
    },
  })
  const retries: OpenCode2AuthEvents<unknown>['retry'][] = []
  auth.on('retry', (event) => {
    retries.push(event)
  })
  const send = (owned = true, modelID = 'mock-model') =>
    host.fire('http.request', {
      ...scopeFor(),
      model: { providerID: PROVIDER, id: modelID },
      request: new Request('https://provider.invalid/relay', {
        headers: {
          authorization: `Bearer ${owned ? placeholderSecret(PROVIDER) : 'user-key'}`,
        },
      }),
    })
  const respond = (request: Request, status: number, body = 'refused') =>
    host.fire('http.response', {
      ...scopeFor(),
      request,
      response: new Response(body, { status }),
    })
  const retry = (attempt = 1) => {
    const { kind: _kind, ...scope } = scopeFor()
    return host.fire('retry', {
      ...scope,
      error: { type: 'provider.unknown', message: '401', status: 401 },
      attempt,
      decision: { retry: false } as SessionRetryDecision,
    })
  }
  return {
    host,
    auth,
    adapter,
    plan,
    state,
    send,
    respond,
    retry,
    retries,
    retrySameAccount,
    dropSameAccountRetry,
    dropChoice,
    chooseAccount,
    limitFromError,
  }
}

describe('identity-preserving retries', () => {
  for (const recovery of [
    'vault-newer',
    'local-newer',
    'relay-direct',
  ] as const) {
    test(`mixed session still retries ${recovery} on the owned route`, async () => {
      const t = await setup()
      let prepared: string | undefined
      const trigger = mock(
        ({ attempt }: { attempt: { attemptId: string } }) => {
          prepared = `${recovery}:${attempt.attemptId}`
          return { reason: prepared, status: 401 }
        },
      )
      t.adapter.limitFromResponse = trigger
      t.retrySameAccount.mockImplementation((input) => {
        expect(input).toMatchObject({
          sessionID: 'ses_1',
          providerID: PROVIDER,
          modelID: 'mock-model',
          accountId: 'A',
          attempt: 1,
          error: { status: 401 },
          limit: { reason: prepared, status: 401 },
        })
        if (!prepared || input.limit?.reason !== prepared) return undefined
        prepared = undefined
        if (recovery === 'relay-direct') t.state.direct = true
        else t.state.token = 'new-token'
        return { accountId: input.accountId }
      })
      try {
        await t.send(false)
        const first = (await t.send()).request
        expect(first.headers.get('authorization')).toBe('Bearer old-token')
        await t.respond(first, 401)
        t.plan.next = 'B'
        expect((await t.retry()).decision).toEqual({ retry: true, delay: 0 })
        const second = (await t.send()).request
        expect(second.headers.get('x-account')).toBe('A')
        expect(second.headers.get('authorization')).toBe(
          recovery === 'relay-direct' ? 'Bearer old-token' : 'Bearer new-token',
        )
        expect(second.url).toBe(
          recovery === 'relay-direct'
            ? 'https://provider.invalid/direct'
            : 'https://provider.invalid/relay',
        )
        expect(trigger).toHaveBeenCalledTimes(1)
        expect(t.retrySameAccount).toHaveBeenCalledTimes(1)
        expect(t.chooseAccount).toHaveBeenCalledTimes(1)
        expect(t.limitFromError).not.toHaveBeenCalled()
        expect(t.retries.map((event) => event.reason)).toEqual(['same-account'])
        expect(t.dropSameAccountRetry).not.toHaveBeenCalled()
        expect(t.dropChoice).not.toHaveBeenCalled()
      } finally {
        await t.auth.dispose()
      }
    })
  }

  test('a host-error recovery can prepare the retry without a response trigger', async () => {
    const t = await setup()
    t.retrySameAccount.mockImplementation((input) => {
      expect(input.limit).toBeUndefined()
      expect(input.error.type).toBe('provider.unknown')
      t.state.direct = true
      return { accountId: input.accountId }
    })
    try {
      await t.send(false)
      await t.send()
      expect((await t.retry()).decision).toEqual({ retry: true, delay: 0 })
      expect((await t.send()).request.url).toBe(
        'https://provider.invalid/direct',
      )
      expect(t.limitFromError).not.toHaveBeenCalled()
    } finally {
      await t.auth.dispose()
    }
  })

  test('declining recovery in a mixed session still forbids reroute and hold selection', async () => {
    const t = await setup()
    try {
      await t.send(false)
      const owned = await t.send()
      await t.respond(owned.request, 429)
      t.chooseAccount.mockImplementation(() => {
        throw new Error('must not select a reroute or hold')
      })
      expect((await t.retry()).decision).toEqual({ retry: false })
      expect(t.retrySameAccount).toHaveBeenCalledTimes(1)
      expect(t.chooseAccount).toHaveBeenCalledTimes(1)
      expect(t.limitFromError).not.toHaveBeenCalled()
      expect(t.retries.at(-1)?.reason).toBe('host-decides')
    } finally {
      await t.auth.dispose()
    }
  })

  test('an answer naming another account is declined and released', async () => {
    const t = await setup()
    t.retrySameAccount.mockReturnValue({ accountId: 'B' })
    try {
      await t.send(false)
      await t.send()
      expect((await t.retry()).decision).toEqual({ retry: false })
      expect(t.dropSameAccountRetry).toHaveBeenCalledTimes(1)
      expect(t.dropSameAccountRetry.mock.calls[0]?.[0]).toMatchObject({
        sessionID: 'ses_1',
        accountId: 'B',
        attempt: 1,
      })
      t.plan.next = 'A'
      expect((await t.send()).request.headers.get('x-account')).toBe('A')
      expect(t.chooseAccount).toHaveBeenCalledTimes(2)
    } finally {
      await t.auth.dispose()
    }
  })

  test('a recovery runs once on the original attempt and never chains', async () => {
    const t = await setup()
    t.retrySameAccount.mockImplementation(({ accountId }) => ({ accountId }))
    try {
      await t.send(false)
      const first = await t.send()
      await t.respond(first.request, 401)
      expect((await t.retry()).decision).toEqual({ retry: true, delay: 0 })
      expect((await t.retry()).decision).toEqual({ retry: false })
      expect(t.retrySameAccount).toHaveBeenCalledTimes(1)
      const second = await t.send()
      await t.respond(second.request, 401)
      expect((await t.retry(2)).decision).toEqual({ retry: false })
      expect(t.retrySameAccount).toHaveBeenCalledTimes(1)
    } finally {
      await t.auth.dispose()
    }
  })

  test('latest foreign transport, ambiguous attempts and started output skip recovery', async () => {
    for (const mode of ['foreign', 'ambiguous', 'output'] as const) {
      const t = await setup()
      t.retrySameAccount.mockImplementation(({ accountId }) => ({ accountId }))
      try {
        await t.send(false)
        const first = await t.send()
        if (mode === 'foreign') await t.send(false)
        if (mode === 'ambiguous') await t.send()
        if (mode === 'output') {
          const reply = await t.respond(
            first.request,
            200,
            sse([{ type: 'delta' }]),
          )
          await reply.response.text()
        }
        expect((await t.retry()).decision).toEqual({ retry: false })
        expect(t.retrySameAccount).not.toHaveBeenCalled()
      } finally {
        await t.auth.dispose()
      }
    }
  })
})

describe('same-account recovery lifecycle', () => {
  for (const cancel of [
    'idle',
    'forget',
    'delete',
    'dispose',
    'model-change',
  ] as const) {
    test(`unused recovery is released once on ${cancel}`, async () => {
      const t = await setup()
      t.retrySameAccount.mockImplementation(({ accountId }) => ({ accountId }))
      try {
        await t.send(false)
        await t.send()
        expect((await t.retry()).decision).toEqual({ retry: true, delay: 0 })
        if (cancel === 'idle')
          await t.host.publish('session.status', {
            sessionID: 'ses_1',
            status: { type: 'idle' },
          })
        if (cancel === 'forget') t.auth.forgetSession('ses_1')
        if (cancel === 'delete')
          await t.host.publish('session.deleted', { sessionID: 'ses_1' })
        if (cancel === 'dispose') await t.auth.dispose()
        if (cancel === 'model-change') await t.send(true, 'different-model')
        // Selection waits for queued cleanup after the synchronous forget API.
        if (cancel !== 'dispose') await t.send()
        expect(t.dropSameAccountRetry).toHaveBeenCalledTimes(1)
        expect(t.dropSameAccountRetry.mock.calls[0]?.[0]).toMatchObject({
          accountId: 'A',
          sessionID: 'ses_1',
          attempt: 1,
        })
        expect(t.dropChoice).not.toHaveBeenCalled()
      } finally {
        await t.auth.dispose()
      }
      expect(t.dropSameAccountRetry).toHaveBeenCalledTimes(1)
    })
  }

  test('foreign traffic during recovery rejects and releases its result', async () => {
    const t = await setup()
    const entered = deferred<void>()
    const result = deferred<SameAccountRetryResult>()
    t.retrySameAccount.mockImplementation(() => {
      entered.resolve()
      return result.promise
    })
    try {
      await t.send()
      const retrying = t.retry()
      await entered.promise
      await t.send(false)
      result.resolve({ accountId: 'A' })
      expect((await retrying).decision).toEqual({ retry: false })
      expect(t.dropSameAccountRetry).toHaveBeenCalledTimes(1)
      expect(t.limitFromError).not.toHaveBeenCalled()
    } finally {
      result.resolve({ accountId: 'A' })
      await t.auth.dispose()
    }
  })

  test('eviction releases an unused recovery before another choice for its session', async () => {
    const t = await setup(1)
    t.retrySameAccount.mockImplementation(({ accountId }) => ({ accountId }))
    try {
      await t.send(false)
      await t.send()
      expect((await t.retry()).decision).toEqual({ retry: true, delay: 0 })
      await t.host.fire('http.request', {
        ...scopeFor('primary', 'other-session'),
        request: new Request('https://provider.invalid/', {
          headers: { authorization: `Bearer ${placeholderSecret(PROVIDER)}` },
        }),
      })
      await t.send()
      expect(t.dropSameAccountRetry).toHaveBeenCalledTimes(1)
      expect(t.chooseAccount).toHaveBeenCalledTimes(3)
    } finally {
      await t.auth.dispose()
    }
  })

  test('forgetting an in-flight recovery releases its returned state', async () => {
    const t = await setup()
    const entered = deferred<void>()
    const result = deferred<SameAccountRetryResult>()
    t.retrySameAccount.mockImplementation(() => {
      entered.resolve()
      return result.promise
    })
    try {
      await t.send()
      const retrying = t.retry()
      const rejected = retrying.catch((error: unknown) => error)
      await entered.promise
      t.auth.forgetSession('ses_1')
      result.resolve({ accountId: 'A' })
      expect(await rejected).toMatchObject({ kind: 'no-account' })
      expect(t.dropSameAccountRetry).toHaveBeenCalledTimes(1)
      expect(t.retries).toEqual([])
    } finally {
      result.resolve({ accountId: 'A' })
      await t.auth.dispose()
    }
  })

  test('concurrent retry hooks cannot prepare recovery twice', async () => {
    const t = await setup()
    const entered = deferred<void>()
    const result = deferred<SameAccountRetryResult>()
    t.retrySameAccount.mockImplementation(() => {
      entered.resolve()
      return result.promise
    })
    try {
      await t.send(false)
      await t.send()
      const first = t.retry()
      await entered.promise
      const second = t.retry()
      result.resolve({ accountId: 'A' })
      const decisions = await Promise.all([first, second])
      expect(decisions.map((draft) => draft.decision)).toEqual([
        { retry: true, delay: 0 },
        { retry: false },
      ])
      expect(t.retrySameAccount).toHaveBeenCalledTimes(1)
    } finally {
      result.resolve({ accountId: 'A' })
      await t.auth.dispose()
    }
  })

  test('declining or throwing leaves owned-only failover unchanged', async () => {
    for (const throws of [false, true]) {
      const t = await setup()
      t.retrySameAccount.mockImplementation(() => {
        if (throws) throw new Error('recovery unavailable')
        return undefined
      })
      try {
        await t.send()
        expect((await t.retry()).decision).toEqual({ retry: true, delay: 0 })
        expect(t.retries.at(-1)?.reason).toBe('reroute')
        expect(t.chooseAccount).toHaveBeenCalledTimes(2)
        expect(t.limitFromError).toHaveBeenCalledTimes(1)
        expect(t.dropSameAccountRetry).not.toHaveBeenCalled()
      } finally {
        await t.auth.dispose()
      }
    }
  })
})
