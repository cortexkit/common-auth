import { describe, expect, expectTypeOf, test } from 'bun:test'
import { buildRefusal, type HostRetry } from '../../src/limits/index.js'
import type {
  ChooseAccountInput,
  ChooseAccountResult,
  InstallOpenCode2AuthOptions,
  OpenCode2AuthAdapter,
  OpenCode2AuthEvents,
  RetryDisposition,
} from '../../src/opencode2/index.js'
import {
  installOpenCode2Auth,
  MAX_RETRY_HOLD_MS,
  placeholderSecret,
} from '../../src/opencode2/index.js'
import {
  fakeAdapter,
  fakeHost,
  PROVIDER,
  scopeFor,
  type TestQuota,
} from './fake-host.js'

type Adapter = OpenCode2AuthAdapter<TestQuota, unknown, ChooseAccountResult>
type Decision = { retry: false } | { retry: true; delay: number }
const sessionID = 'disposition-session'
const scope = scopeFor('primary', sessionID)

async function setup(
  choose: (
    input: ChooseAccountInput,
  ) => ChooseAccountResult | Promise<ChooseAccountResult>,
  overrides: Partial<Adapter> = {},
  options: InstallOpenCode2AuthOptions = {},
) {
  const host = fakeHost()
  const choices: ChooseAccountInput[] = []
  const headers: string[] = []
  const drops: Array<ChooseAccountInput & { accountId: string }> = []
  const retries: OpenCode2AuthEvents<TestQuota>['retry'][] = []
  const adapter: Adapter = {
    ...fakeAdapter().adapter,
    chooseAccount(input) {
      choices.push(input)
      return choose(input)
    },
    accountHeaders({ accountId }) {
      headers.push(accountId)
      return {
        authorization: `Bearer tok-${accountId}`,
        'x-account': accountId,
      }
    },
    dropChoice(input) {
      drops.push(input)
    },
    limitFromError: () => ({ reason: 'limited', status: 429 }),
    ...overrides,
  }
  const auth = await installOpenCode2Auth(host.ctx, adapter, options)
  auth.on('retry', (event) => {
    retries.push(event)
  })
  const send = async (
    credential = placeholderSecret(PROVIDER),
    requestScope = scope,
  ) => {
    const model = await host.fire('model.request', {
      ...requestScope,
      headers: {} as Record<string, string>,
    })
    const draft = await host.fire('http.request', {
      ...requestScope,
      request: new Request('https://provider.invalid/messages', {
        headers: { ...model.headers, authorization: `Bearer ${credential}` },
      }),
    })
    return draft.request
  }
  const respond = (request: Request, status = 429) =>
    host.fire('http.response', {
      ...scope,
      request,
      response: new Response('provider failure', { status }),
    })
  const retry = (
    decision: Decision = { retry: true, delay: 321 },
    attempt = 1,
  ) =>
    host.fire('retry', {
      ...scope,
      error: {
        type: 'provider.error',
        message: 'provider failure',
        status: 429,
      },
      attempt,
      decision,
    })
  return { host, auth, choices, headers, drops, retries, send, respond, retry }
}

const gated: InstallOpenCode2AuthOptions = {
  gateOnPlaceholder: {
    credential: (headers) =>
      headers.get('authorization')?.replace(/^Bearer /, ''),
  },
}

describe('OpenCode 2 attempt retry dispositions', () => {
  test('formatted payment refusal carries its veto through responseRetry', async () => {
    const dispositions = new WeakMap<Response, HostRetry>()
    const fx = await setup(() => 'A', {
      limitFromError: () => undefined,
      limitFromResponse: () => undefined,
      rewriteResponse: () => {
        const refusal = buildRefusal({
          family: 'claustrum-402',
          host: 'opencode2',
          messageKey: 'payment.insufficient-balance',
          now: 1000,
          retryAfterMs: 299000,
        })
        if (refusal.kind !== 'http') throw new Error('expected HTTP refusal')
        const response = new Response(refusal.body, refusal)
        dispositions.set(response, refusal.hostRetry)
        return response
      },
      responseRetry: ({ response }) => dispositions.get(response),
    })
    try {
      const { response } = await fx.respond(await fx.send(), 200)
      expect(response.status).toBe(402)
      expect(response.headers.get('retry-after')).toBe('299')
      expect((await fx.retry()).decision).toEqual({ retry: false })
      expect(fx.retries.at(-1)?.reason).toBe('adapter-veto')
      expect(fx.choices).toHaveLength(1)
    } finally {
      await fx.auth.dispose()
    }
  })
  test('rewriteResponse returns a Response or undefined for direct callers', () => {
    expectTypeOf<
      Awaited<ReturnType<NonNullable<Adapter['rewriteResponse']>>>
    >().toEqualTypeOf<Response | undefined>()
    expectTypeOf<
      Parameters<NonNullable<Adapter['responseRetry']>>
    >().toEqualTypeOf<Parameters<NonNullable<Adapter['rewriteResponse']>>>()
  })

  for (const gate of [false, true]) {
    test(`chooser veto forbids replay without reserving an account (gated=${gate})`, async () => {
      const fx = await setup(
        (input) => (input.phase === 'request' ? 'A' : { hostRetry: 'veto' }),
        {},
        gate ? gated : {},
      )
      try {
        await fx.send()
        expect((await fx.retry()).decision).toEqual({ retry: false })
        expect(fx.retries.at(-1)?.reason).toBe('adapter-veto')
        expect(fx.headers).toEqual(['A'])
        expect(fx.drops).toEqual([])
        await fx.send()
        expect(fx.choices.map((input) => input.phase)).toEqual([
          'request',
          'retry',
          'request',
        ])
      } finally {
        await fx.auth.dispose()
      }
    })
  }

  for (const decision of [
    { retry: false },
    { retry: true, delay: 321 },
  ] as const) {
    test(`chooser leave preserves host retry=${decision.retry} and chooses later`, async () => {
      const fx = await setup((input) =>
        input.phase === 'request' ? 'A' : { hostRetry: 'leave' },
      )
      try {
        await fx.send()
        expect((await fx.retry(decision)).decision).toBe(decision)
        await fx.send()
        expect(fx.choices.map((input) => input.phase)).toEqual([
          'request',
          'retry',
          'request',
        ])
        expect(fx.drops).toEqual([])
      } finally {
        await fx.auth.dispose()
      }
    })
  }

  test('response refusal and veto belong to the same attempt without a recognised limit', async () => {
    let refuse = true
    let recoveries = 0
    const rewrites: Parameters<NonNullable<Adapter['rewriteResponse']>>[0][] =
      []
    const policies: Parameters<NonNullable<Adapter['responseRetry']>>[0][] = []
    const fx = await setup(() => 'A', {
      limitFromError: () => undefined,
      limitFromResponse: () => undefined,
      rewriteResponse: async (input) => {
        rewrites.push(input)
        return refuse
          ? new Response('{"error":{"message":"No eligible account."}}', {
              status: 412,
              headers: {
                'content-type': 'application/json',
                'retry-after': '5700',
                'x-extra': 'kept',
              },
            })
          : undefined
      },
      responseRetry: async (input) => {
        policies.push(input)
        return input.response.status === 412 ? 'veto' : undefined
      },
      retrySameAccount: () => {
        recoveries += 1
        return undefined
      },
    })
    try {
      const request = await fx.send()
      const { response } = await fx.respond(request)
      expect(response.status).toBe(412)
      expect(response.headers.get('retry-after')).toBe('5700')
      expect(response.headers.get('x-extra')).toBe('kept')
      expect(await response.text()).toBe(
        '{"error":{"message":"No eligible account."}}',
      )
      expect((await fx.retry()).decision).toEqual({ retry: false })
      expect(rewrites).toHaveLength(1)
      expect(policies).toHaveLength(1)
      expect(policies).toEqual(
        rewrites.map((input) => ({ ...input, response })),
      )
      expect(policies[0]?.request).toBe(request)
      expect(policies[0]?.attempt).toBe(rewrites[0]?.attempt)
      expect(policies[0]?.response).toBe(response)
      expect(rewrites[0]?.response.status).toBe(429)
      expect(fx.retries.at(-1)?.handle?.attemptId).toBe('attempt-1')
      expect(fx.retries.at(-1)?.reason).toBe('adapter-veto')
      expect(fx.choices).toHaveLength(1)
      expect(recoveries).toBe(0)
      refuse = false
      const unchanged = await fx.respond(await fx.send(), 503)
      expect(policies).toHaveLength(2)
      expect(policies[1]?.response).toBe(unchanged.response)
      expect(policies[1]?.response).toBe(rewrites[1]?.response)
      const decision: Decision = { retry: true, delay: 72 }
      expect((await fx.retry(decision)).decision).toBe(decision)
    } finally {
      await fx.auth.dispose()
    }
  })

  test('response leave permits normal rerouting rather than freezing the host proposal', async () => {
    const seen: Response[] = []
    const fx = await setup((input) => (input.phase === 'request' ? 'A' : 'B'), {
      responseRetry: ({ response }) => {
        seen.push(response)
        return 'leave'
      },
    })
    try {
      const { response } = await fx.respond(await fx.send())
      expect(seen).toEqual([response])
      expect((await fx.retry({ retry: false })).decision).toEqual({
        retry: true,
        delay: 0,
      })
      expect((await fx.send()).headers.get('x-account')).toBe('B')
      expect(fx.choices).toHaveLength(2)
    } finally {
      await fx.auth.dispose()
    }
  })

  for (const disposition of ['leave', undefined] as const) {
    test(`response policy ${disposition} cannot clear an earlier event veto`, async () => {
      const fx = await setup(() => 'A', {
        limitFromError: () => undefined,
        inspectEvent: () => ({ hostRetry: 'veto' }),
        rewriteResponse: async ({ response }) => {
          await response.text()
          return new Response('formatted refusal', { status: 412 })
        },
        responseRetry: () => disposition,
      })
      try {
        await fx.host.fire('http.response', {
          ...scope,
          request: await fx.send(),
          response: new Response('data: refusal\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          }),
        })
        expect((await fx.retry()).decision).toEqual({ retry: false })
        expect(fx.retries.at(-1)?.reason).toBe('adapter-veto')
        expect(fx.choices).toHaveLength(1)
      } finally {
        await fx.auth.dispose()
      }
    })
  }

  test('event refusal carries a sticky attempt veto even without a limit signal', async () => {
    const fx = await setup(() => 'A', {
      limitFromError: () => undefined,
      inspectEvent: ({ data }) =>
        data === 'refusal'
          ? { error: 'No eligible account.', hostRetry: 'veto' }
          : { hostRetry: 'leave' },
    })
    try {
      await fx.host.fire('experimental.ws.handshake', {
        ...scope,
        url: 'wss://provider.invalid',
        headers: {},
      })
      await fx.host.fire('experimental.ws.receive', {
        ...scope,
        frame: 'refusal',
      })
      await fx.host.fire('experimental.ws.receive', {
        ...scope,
        frame: 'later event',
      })
      expect((await fx.retry()).decision).toEqual({ retry: false })
      expect(fx.retries.at(-1)?.reason).toBe('adapter-veto')
      expect(fx.choices).toHaveLength(1)
    } finally {
      await fx.auth.dispose()
    }
  })
})

describe('OpenCode 2 disposition fences', () => {
  for (const latestOwned of [false, true]) {
    test(`response veto respects ownership and mixed-session fences (latestOwned=${latestOwned})`, async () => {
      let policies = 0
      const fx = await setup(
        () => 'A',
        {
          responseRetry: () => {
            policies += 1
            return 'veto'
          },
        },
        gated,
      )
      const foreign = async () => fx.respond(await fx.send('foreign-key'))
      try {
        if (latestOwned) await foreign()
        await fx.respond(await fx.send())
        if (!latestOwned) await foreign()
        expect(policies).toBe(1)
        const decision: Decision = { retry: true, delay: 987 }
        expect((await fx.retry(decision)).decision).toBe(decision)
        expect(fx.choices).toHaveLength(1)
        expect(fx.retries.map((event) => event.reason)).toEqual(
          latestOwned ? ['host-decides'] : [],
        )
      } finally {
        await fx.auth.dispose()
      }
    })
  }

  for (const latestOwned of [false, true]) {
    test(`ownership and mixed-session fences precede output and source veto (latestOwned=${latestOwned})`, async () => {
      const fx = await setup(
        () => 'A',
        {
          inspectEvent: () => ({
            outputStarted: true,
            hostRetry: 'veto',
            error: 'No eligible account.',
          }),
        },
        gated,
      )
      const ownedSocket = () =>
        fx.host.fire('experimental.ws.handshake', {
          ...scope,
          url: 'wss://provider.invalid',
          headers: { authorization: `Bearer ${placeholderSecret(PROVIDER)}` },
        })
      try {
        if (latestOwned) await fx.send('foreign-key')
        await ownedSocket()
        await fx.host.fire('experimental.ws.receive', {
          ...scope,
          frame: 'refusal after output',
        })
        if (!latestOwned) await fx.send('foreign-key')
        const decision: Decision = { retry: true, delay: 987 }
        expect((await fx.retry(decision)).decision).toBe(decision)
        expect(fx.choices).toHaveLength(1)
        expect(fx.retries.map((event) => event.reason)).toEqual(
          latestOwned ? ['host-decides'] : [],
        )
      } finally {
        await fx.auth.dispose()
      }
    })
  }

  test('ambiguous attempts preserve the host decision despite source vetoes', async () => {
    const fx = await setup(() => 'A', {
      limitFromResponse: () => undefined,
      responseRetry: () => 'veto',
    })
    try {
      const first = await fx.send()
      const second = await fx.send()
      await fx.respond(first, 200)
      await fx.respond(second, 200)
      const decision: Decision = { retry: true, delay: 987 }
      expect((await fx.retry(decision)).decision).toBe(decision)
      expect(fx.retries.at(-1)?.reason).toBe('host-decides')
      expect(fx.choices).toHaveLength(2)
    } finally {
      await fx.auth.dispose()
    }
  })

  test('a foreign transport arriving during chooser veto wins over the veto', async () => {
    let enter!: () => void
    let finish!: (choice: RetryDisposition) => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const chosen = new Promise<RetryDisposition>((resolve) => {
      finish = resolve
    })
    const fx = await setup(
      (input) => {
        if (input.phase === 'request') return 'A'
        enter()
        return chosen
      },
      {},
      gated,
    )
    try {
      await fx.send()
      const decision: Decision = { retry: true, delay: 987 }
      const retry = fx.retry(decision)
      await entered
      await fx.send('foreign-key')
      finish({ hostRetry: 'veto' })
      expect((await retry).decision).toBe(decision)
      expect(fx.drops).toEqual([])
    } finally {
      finish({ hostRetry: 'leave' })
      await fx.auth.dispose()
    }
  })

  test('a source veto arriving during choice releases the unused account', async () => {
    let enter!: () => void
    let finish!: (choice: string) => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const chosen = new Promise<string>((resolve) => {
      finish = resolve
    })
    const fx = await setup(
      (input) => {
        if (input.phase === 'request') return 'A'
        enter()
        return chosen
      },
      { inspectEvent: () => ({ hostRetry: 'veto' }) },
    )
    try {
      await fx.host.fire('experimental.ws.handshake', {
        ...scope,
        url: 'wss://provider.invalid',
        headers: {},
      })
      const retry = fx.retry()
      await entered
      await fx.host.fire('experimental.ws.receive', {
        ...scope,
        frame: 'refusal',
      })
      finish('B')
      expect((await retry).decision).toEqual({ retry: false })
      expect(fx.drops.map((input) => input.accountId)).toEqual(['B'])
      expect(fx.headers).toEqual(['A'])
    } finally {
      finish('B')
      await fx.auth.dispose()
    }
  })
})

describe('OpenCode 2 wait then reselect', () => {
  for (const gate of [false, true]) {
    test(`wait then reselect reserves no account and chooses at the next request (gated=${gate})`, async () => {
      let account = 'A'
      const fx = await setup(
        (input) =>
          input.phase === 'request'
            ? account
            : { waitThenReselect: { delayMs: 4000.25 } },
        {},
        gate ? gated : {},
      )
      try {
        await fx.send()
        expect((await fx.retry({ retry: false })).decision).toEqual({
          retry: true,
          delay: 4001,
        })
        expect(fx.retries.at(-1)?.reason).toBe('wait-then-reselect')
        expect(fx.headers).toEqual(['A'])
        expect(fx.drops).toEqual([])
        account = 'B'
        expect((await fx.send()).headers.get('x-account')).toBe('B')
        expect(fx.choices.at(-1)).toEqual({
          sessionID,
          providerID: PROVIDER,
          kind: 'primary',
          agent: 'build',
          modelID: 'mock-model',
          phase: 'request',
          previousAccountId: 'A',
        })
        expect(fx.headers).toEqual(['A', 'B'])
        expect(fx.drops).toEqual([])
      } finally {
        await fx.auth.dispose()
      }
    })
  }

  for (const delayMs of [-1, NaN, Infinity, MAX_RETRY_HOLD_MS + 1]) {
    test(`invalid unreserved wait ${delayMs} leaves the host decision intact`, async () => {
      const fx = await setup((input) =>
        input.phase === 'request' ? 'A' : { waitThenReselect: { delayMs } },
      )
      try {
        await fx.send()
        const decision: Decision = { retry: true, delay: 987 }
        expect((await fx.retry(decision)).decision).toBe(decision)
        await fx.send()
        expect(fx.choices.map((input) => input.phase)).toEqual([
          'request',
          'retry',
          'request',
        ])
        expect(fx.drops).toEqual([])
      } finally {
        await fx.auth.dispose()
      }
    })
  }

  test('an exhausted retry budget does not execute an unreserved wait', async () => {
    const fx = await setup(
      (input) =>
        input.phase === 'request' ? 'A' : { waitThenReselect: { delayMs: 25 } },
      {},
      { hostRetryLimit: 2 },
    )
    try {
      await fx.send()
      const decision: Decision = { retry: false }
      expect((await fx.retry(decision, 2)).decision).toBe(decision)
      expect(fx.drops).toEqual([])
    } finally {
      await fx.auth.dispose()
    }
  })

  test('cancelling an unreserved wait has no account choice to release', async () => {
    const fx = await setup((input) =>
      input.phase === 'request' ? 'A' : { waitThenReselect: { delayMs: 25 } },
    )
    try {
      await fx.send()
      await fx.retry()
      await fx.host.publish('session.status', {
        sessionID,
        status: { type: 'idle' },
      })
      fx.auth.forgetSession(sessionID)
      await fx.send()
      expect(fx.choices.at(-1)?.previousAccountId).toBeUndefined()
      expect(fx.drops).toEqual([])
    } finally {
      await fx.auth.dispose()
    }
  })
})
