import { describe, expect, test } from 'bun:test'
import {
  ATTEMPT_HEADER,
  type ChooseAccountInput,
  installOpenCode2Auth,
  placeholderSecret,
} from '../../src/opencode2/index.js'
import { fakeAdapter, fakeHost, PROVIDER, scopeFor } from './fake-host.js'

/**
 * A limit before any output used to make the retry hook reroute at once
 * whether or not another account could serve. On the last usable account
 * that threw away the host's wait, and the rerouted attempt, excluding the
 * refused account, found none: the transport hook threw `no-account`, which
 * OpenCode 2 treats as a defect and ends the step instead of retrying.
 */

const PLACEHOLDER = `Bearer ${placeholderSecret(PROVIDER)}`
const gated = {
  gateOnPlaceholder: {
    credential(headers: Headers) {
      const value = headers.get('authorization')
      return value?.startsWith('Bearer ') ? value.slice(7) : undefined
    },
  },
}

/** What the host asks for after a 429 with `retry-after: 30`. */
const HOST_WAIT = { retry: true, delay: 30_000 }

const retryDraft = (decision: { retry: boolean; delay?: number }) => ({
  ...scopeFor(),
  error: { type: 'provider.rate_limit', message: 'rate limited' },
  attempt: 1,
  decision,
})

const tooMany = () =>
  new Response(null, { status: 429, headers: { 'retry-after': '30' } })

/**
 * An adapter shaped like a pool plugin's: it never picks an account marked
 * limited (the plugin marks it from the `limit` event) or the account named
 * by `rerouteFrom`, and has no account when none is left.
 */
function poolAdapter(accounts: string[]) {
  const limited = new Set<string>()
  const choices: ChooseAccountInput[] = []
  const { adapter } = fakeAdapter(undefined, {
    chooseAccount(input) {
      choices.push({ ...input })
      return accounts.find(
        (id) => !limited.has(id) && id !== input.rerouteFrom?.accountId,
      )
    },
  })
  return { adapter, limited, choices }
}

/**
 * Sends one owned HTTP request through the transport hooks the way the host
 * does with `gateOnPlaceholder`, answers it with `response`, and returns the
 * credential that went out.
 */
async function sendOwned(
  host: ReturnType<typeof fakeHost>,
  response: Response,
): Promise<string | null> {
  const sent = await host.fire('http.request', {
    ...scopeFor(),
    request: new Request('https://provider.invalid/v1/responses', {
      method: 'POST',
      headers: { authorization: PLACEHOLDER },
      body: '{"input":[]}',
    }),
  })
  const reply = await host.fire('http.response', {
    ...scopeFor(),
    request: sent.request,
    response,
  })
  await reply.response.text()
  return sent.request.headers.get('authorization')
}

/** Sends one request through `model.request` and `http.request`, without `gateOnPlaceholder`. */
async function sendLegacy(
  host: ReturnType<typeof fakeHost>,
  response: Response,
  model = 'mock-model',
): Promise<string | null> {
  const base = scopeFor()
  const scope = { ...base, model: { ...base.model, id: model } }
  const prepared = await host.fire('model.request', {
    ...scope,
    headers: { authorization: PLACEHOLDER } as Record<string, string>,
  })
  const sent = await host.fire('http.request', {
    ...scope,
    request: new Request('https://provider.invalid/v1/responses', {
      method: 'POST',
      headers: {
        [ATTEMPT_HEADER]: prepared.headers[ATTEMPT_HEADER] ?? '',
        authorization: PLACEHOLDER,
      },
      body: '{"input":[]}',
    }),
  })
  const reply = await host.fire('http.response', {
    ...scope,
    request: sent.request,
    response,
  })
  await reply.response.text()
  return sent.request.headers.get('authorization')
}

function recordRetries(installation: {
  on(
    event: 'retry',
    listener: (event: {
      reason: string
      accountId?: string
      hostDecision: unknown
      decision: unknown
    }) => void,
  ): () => void
}) {
  const retries: Array<[string | undefined, string, unknown, unknown]> = []
  installation.on('retry', (event) => {
    retries.push([
      event.accountId,
      event.reason,
      event.hostDecision,
      event.decision,
    ])
  })
  return retries
}

describe('OpenCode 2 retry on the last usable account', () => {
  test('one account refused before output keeps the host wait and retries on the same account', async () => {
    const host = fakeHost()
    const { adapter, limited, choices } = poolAdapter(['A'])
    const installation = await installOpenCode2Auth(host.ctx, adapter, gated)
    installation.on('limit', (event) => {
      limited.add(event.accountId)
    })
    const retries = recordRetries(installation)

    expect(await sendOwned(host, tooMany())).toBe('Bearer tok-A')
    const retried = await host.fire('retry', retryDraft({ ...HOST_WAIT }))
    expect(retried.decision).toEqual(HOST_WAIT)
    expect(retries).toEqual([
      ['A', 'host-decides-last-account', HOST_WAIT, HOST_WAIT],
    ])

    // Stands for the host waiting out the retry-after: the plugin's limit
    // mark has expired by then.
    limited.clear()
    expect(await sendOwned(host, new Response('ok'))).toBe('Bearer tok-A')
    expect(choices.at(-1)?.previousAccountId).toBe('A')
    expect(choices.at(-1)?.rerouteFrom).toBeUndefined()
    await installation.dispose()
  })

  test('an adapter naming the refused account again keeps the host decision, including no retry', async () => {
    const host = fakeHost()
    const { adapter, choices } = fakeAdapter({
      next: 'A',
      limited: new Set(),
      accounts: ['A'],
    })
    const installation = await installOpenCode2Auth(host.ctx, adapter)
    const retries = recordRetries(installation)

    expect(await sendLegacy(host, tooMany())).toBe('Bearer tok-A')
    const retried = await host.fire('retry', retryDraft({ retry: false }))
    expect(retried.decision).toEqual({ retry: false })
    expect(retries).toEqual([
      ['A', 'host-decides-last-account', { retry: false }, { retry: false }],
    ])
    // The retry hook asked once, with the refused account excluded.
    expect(choices.at(-1)?.rerouteFrom).toEqual({
      accountId: 'A',
      limit: { reason: 'too-many', status: 429 },
    })

    // The user's next turn chooses without excluding the refused account.
    expect(await sendLegacy(host, new Response('ok'))).toBe('Bearer tok-A')
    expect(choices.at(-1)?.rerouteFrom).toBeUndefined()
    await installation.dispose()
  })

  test('two accounts: a limit before output reroutes at once to the other account', async () => {
    const host = fakeHost()
    const { adapter, limited, choices } = poolAdapter(['A', 'B'])
    const installation = await installOpenCode2Auth(host.ctx, adapter, gated)
    installation.on('limit', (event) => {
      limited.add(event.accountId)
    })
    const retries = recordRetries(installation)

    expect(await sendOwned(host, tooMany())).toBe('Bearer tok-A')
    const retried = await host.fire('retry', retryDraft({ ...HOST_WAIT }))
    expect(retried.decision).toEqual({ retry: true, delay: 0 })
    expect(retries).toEqual([
      ['A', 'reroute', HOST_WAIT, { retry: true, delay: 0 }],
    ])
    expect(await sendOwned(host, new Response('ok'))).toBe('Bearer tok-B')
    // The retry hook's choice served the retried attempt: one choice for the
    // first attempt, one for the retry, made with the refused account excluded.
    expect(choices).toHaveLength(2)
    expect(choices[1]).toMatchObject({
      previousAccountId: 'A',
      rerouteFrom: {
        accountId: 'A',
        limit: { reason: 'too-many', status: 429 },
      },
    })
    await installation.dispose()
  })

  test('the other account becoming unavailable before the retry still serves the retry, and its refusal keeps the host wait', async () => {
    const host = fakeHost()
    const { adapter, limited, choices } = poolAdapter(['A', 'B'])
    const installation = await installOpenCode2Auth(host.ctx, adapter, gated)
    installation.on('limit', (event) => {
      limited.add(event.accountId)
    })
    const retries = recordRetries(installation)

    expect(await sendOwned(host, tooMany())).toBe('Bearer tok-A')
    const first = await host.fire('retry', retryDraft({ ...HOST_WAIT }))
    expect(first.decision).toEqual({ retry: true, delay: 0 })

    // Stands for another session's refusal marking B limited before the
    // host retries.
    limited.add('B')
    expect(await sendOwned(host, tooMany())).toBe('Bearer tok-B')
    const second = await host.fire('retry', retryDraft({ ...HOST_WAIT }))
    expect(second.decision).toEqual(HOST_WAIT)
    expect(retries).toEqual([
      ['A', 'reroute', HOST_WAIT, { retry: true, delay: 0 }],
      ['B', 'host-decides-last-account', HOST_WAIT, HOST_WAIT],
    ])

    // Stands for the host's wait: both limit marks have expired by then.
    limited.clear()
    expect(await sendOwned(host, new Response('ok'))).toBe('Bearer tok-A')
    expect(choices.at(-1)?.previousAccountId).toBe('B')
    expect(choices.at(-1)?.rerouteFrom).toBeUndefined()
    await installation.dispose()
  })

  test('chooseAccount throwing while the retry hook looks for another account keeps the host decision', async () => {
    const host = fakeHost()
    const warnings: string[] = []
    let failing = false
    const { adapter } = fakeAdapter(undefined, {
      chooseAccount: () => {
        if (failing) throw new Error('pool unreadable')
        return 'A'
      },
    })
    const installation = await installOpenCode2Auth(host.ctx, adapter, {
      logger: { warn: (message) => warnings.push(message) },
    })
    const retries = recordRetries(installation)

    expect(await sendLegacy(host, tooMany())).toBe('Bearer tok-A')
    failing = true
    const retried = await host.fire('retry', retryDraft({ ...HOST_WAIT }))
    expect(retried.decision).toEqual(HOST_WAIT)
    expect(retries).toEqual([
      ['A', 'host-decides-last-account', HOST_WAIT, HOST_WAIT],
    ])
    expect(warnings).toEqual([
      'opencode2 auth chooseAccount threw while the retry hook looked for another account; the host decides the retry',
    ])
    await installation.dispose()
  })

  test('a retry for another model chooses again instead of taking the retry hook choice', async () => {
    const host = fakeHost()
    const { adapter, choices } = fakeAdapter()
    const installation = await installOpenCode2Auth(host.ctx, adapter)

    expect(await sendLegacy(host, tooMany())).toBe('Bearer tok-A')
    const retried = await host.fire('retry', retryDraft({ ...HOST_WAIT }))
    expect(retried.decision).toEqual({ retry: true, delay: 0 })
    expect(choices).toHaveLength(2)
    expect(await sendLegacy(host, new Response('ok'), 'other-model')).toBe(
      'Bearer tok-B',
    )
    expect(choices).toHaveLength(3)
    expect(choices[2]).toMatchObject({
      modelID: 'other-model',
      previousAccountId: 'A',
      rerouteFrom: { accountId: 'A' },
    })
    await installation.dispose()
  })
})
