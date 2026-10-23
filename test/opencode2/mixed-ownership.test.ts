import { describe, expect, mock, test } from 'bun:test'
import {
  type ChooseAccountInput,
  installOpenCode2Auth,
  type OpenCode2AuthEvents,
  placeholderSecret,
} from '../../src/opencode2/index.js'
import {
  fakeAdapter,
  fakeHost,
  PROVIDER,
  scopeFor,
  type TestQuota,
} from './fake-host.js'

const secret = placeholderSecret(PROVIDER)
const gate = {
  gateOnPlaceholder: {
    credential: (headers: Headers) =>
      headers.get('authorization')?.replace(/^Bearer /, ''),
  },
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function setup() {
  const host = fakeHost()
  const limitFromError = mock(() => ({ reason: 'too-many', status: 429 }))
  const onAttemptEnd = mock(() => {})
  const dropChoice = mock(
    (_input: ChooseAccountInput & { accountId: string }) => {},
  )
  const { adapter } = fakeAdapter(undefined, {
    inspectEvent: undefined,
    limitFromError,
    onAttemptEnd,
    dropChoice,
  })
  const chooseAccount = mock(adapter.chooseAccount)
  adapter.chooseAccount = chooseAccount
  const auth = await installOpenCode2Auth(host.ctx, adapter, gate)
  const retries: OpenCode2AuthEvents<TestQuota>['retry'][] = []
  const limits: OpenCode2AuthEvents<TestQuota>['limit'][] = []
  auth.on('retry', (event) => {
    retries.push(event)
  })
  auth.on('limit', (event) => {
    limits.push(event)
  })
  const send = (owned = true, sessionID = 'ses_1') =>
    host.fire('http.request', {
      ...scopeFor('primary', sessionID),
      request: new Request('https://provider.invalid/', {
        headers: { authorization: `Bearer ${owned ? secret : 'user-key'}` },
      }),
    })
  const complete = async (request: Request, status = 200) => {
    const reply = await host.fire('http.response', {
      ...scopeFor(),
      request,
      response: new Response('done', { status }),
    })
    // A successful attempt ends through body tracking, not response arrival.
    expect(await reply.response.text()).toBe('done')
  }
  const retry = () => {
    const { kind: _kind, ...scope } = scopeFor()
    return host.fire('retry', {
      ...scope,
      error: { type: 'provider.unknown', message: '429' },
      attempt: 1,
      decision: { retry: true, delay: 1234 },
    })
  }
  const unchanged = async (event = true) => {
    const calls = chooseAccount.mock.calls.length
    const result = await retry()
    expect(result.decision).toEqual({ retry: true, delay: 1234 })
    expect(chooseAccount).toHaveBeenCalledTimes(calls)
    expect(limitFromError).toHaveBeenCalledTimes(0)
    expect(limits).toEqual([])
    expect(retries.map((entry) => entry.reason)).toEqual(
      event ? ['host-decides'] : [],
    )
  }
  return {
    host,
    auth,
    adapter,
    send,
    complete,
    retry,
    unchanged,
    chooseAccount,
    limitFromError,
    onAttemptEnd,
    dropChoice,
    retries,
    limits,
  }
}

describe('mixed ownership retry', () => {
  test('L6 1: foreign then owned cannot blame the owned account', async () => {
    const t = await setup()
    try {
      await t.send(false)
      await t.send()
      await t.unchanged()
    } finally {
      await t.auth.dispose()
    }
  })

  test('L6 2: an ended error superseded by another owned attempt stays mixed', async () => {
    const t = await setup()
    try {
      await t.complete((await t.send()).request, 500)
      await t.send(false)
      await t.send()
      await t.unchanged()
    } finally {
      await t.auth.dispose()
    }
  })

  test('L6 3: delayed foreign retry after owned completion stays mixed', async () => {
    const t = await setup()
    try {
      await t.send(false)
      await t.complete((await t.send()).request)
      expect(t.onAttemptEnd).toHaveBeenCalledTimes(1)
      await t.unchanged()
    } finally {
      await t.auth.dispose()
    }
  })

  test('L6 4: foreign during selection counts before an attempt exists', async () => {
    const t = await setup()
    const selected = deferred<string>()
    const entered = deferred<void>()
    t.chooseAccount.mockImplementationOnce(() => {
      entered.resolve()
      return selected.promise
    })
    try {
      const owned = t.send()
      await entered.promise
      await t.send(false)
      selected.resolve('A')
      await t.complete((await owned).request)
      expect(t.onAttemptEnd).toHaveBeenCalledTimes(1)
      await t.send()
      expect(t.auth.size).toBe(1)
      await t.unchanged()
    } finally {
      selected.resolve('A')
      await t.auth.dispose()
    }
  })

  for (const reset of ['session.deleted', 'forgetSession'] as const) {
    test(`L6 5: ${reset} does not reset a reused mixed session id`, async () => {
      const t = await setup()
      try {
        await t.send(false)
        await t.send()
        if (reset === 'session.deleted')
          await t.host.publish(reset, { sessionID: 'ses_1' })
        else t.auth.forgetSession('ses_1')
        expect(t.auth.size).toBe(0)
        await t.send()
        await t.unchanged()
      } finally {
        await t.auth.dispose()
      }
    })
  }

  test('L6 6: owned-only reroutes, including after deletion and id reuse', async () => {
    const t = await setup()
    try {
      for (let i = 0; i < 2; i++) {
        await t.send()
        const calls = t.chooseAccount.mock.calls.length
        expect((await t.retry()).decision).toEqual({ retry: true, delay: 0 })
        expect(t.chooseAccount).toHaveBeenCalledTimes(calls + 1)
        expect(t.limitFromError).toHaveBeenCalledTimes(i + 1)
        expect(t.limits).toHaveLength(i + 1)
        expect(t.retries.at(-1)?.reason).toBe('reroute')
        await t.host.publish('session.deleted', { sessionID: 'ses_1' })
      }
    } finally {
      await t.auth.dispose()
    }
  })

  test('L6 7: becoming mixed while choosing releases the retry choice', async () => {
    const t = await setup()
    const selected = deferred<string>()
    const entered = deferred<void>()
    try {
      await t.send()
      t.chooseAccount.mockImplementationOnce(() => {
        entered.resolve()
        return selected.promise
      })
      const retrying = t.retry()
      await entered.promise
      await t.send(false)
      selected.resolve('B')
      expect((await retrying).decision).toEqual({ retry: true, delay: 1234 })
      expect(t.chooseAccount).toHaveBeenCalledTimes(2)
      // The error was attributed before a foreign transport was seen.
      expect(t.limitFromError).toHaveBeenCalledTimes(1)
      expect(t.limits).toHaveLength(1)
      expect(t.dropChoice).toHaveBeenCalledTimes(1)
      expect(t.dropChoice.mock.calls[0]?.[0]).toMatchObject({
        accountId: 'B',
        phase: 'retry',
      })
      expect(t.retries.map((event) => event.reason)).toEqual(['host-decides'])
      await t.send()
      expect(t.chooseAccount).toHaveBeenCalledTimes(3)
      expect(t.chooseAccount.mock.calls[2]?.[0]).toMatchObject({
        phase: 'request',
      })
      expect(t.chooseAccount.mock.calls[2]?.[0].rerouteFrom).toBeUndefined()
    } finally {
      selected.resolve('B')
      await t.auth.dispose()
    }
  })

  test('L6 8: latest foreign returns silently as before', async () => {
    const t = await setup()
    try {
      await t.send()
      await t.send(false)
      await t.unchanged(false)
    } finally {
      await t.auth.dispose()
    }
  })
})
