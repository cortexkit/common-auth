import { describe, expect, mock, test } from 'bun:test'
import {
  ATTEMPT_HEADER,
  installOpenCode2Auth,
  OpenCode2AuthError,
  placeholderSecret,
} from '../../src/opencode2/index.js'
import { fakeAdapter, fakeHost, PROVIDER, scopeFor } from './fake-host.js'

const secret = placeholderSecret(PROVIDER)
const placeholder = `Bearer ${secret}`
const gated = {
  gateOnPlaceholder: {
    credential(headers: Headers) {
      const value = headers.get('authorization')
      return value?.startsWith('Bearer ') ? value.slice(7) : undefined
    },
  },
}

function request(credential = placeholder) {
  return new Request('https://provider.invalid/v1/responses?stock=1', {
    method: 'POST',
    headers: {
      authorization: credential,
      'content-type': 'application/json',
      'x-stock': 'keep',
    },
    body: '{"input":[],"max_output_tokens":42}',
  })
}

const retry = () => ({
  ...scopeFor(),
  error: { type: 'provider.unknown', message: 'failed' },
  attempt: 1,
  decision: { retry: true, delay: 123 },
})

function fixture() {
  const host = fakeHost()
  const { adapter, choices, plan } = fakeAdapter()
  const calls: string[] = []
  for (const name of Object.keys(adapter)) {
    const fn = adapter[name as keyof typeof adapter]
    if (typeof fn !== 'function') continue
    Object.assign(adapter, {
      [name]: (...args: unknown[]) => {
        calls.push(name)
        return Reflect.apply(fn, adapter, args)
      },
    })
  }
  adapter.rewriteRequest = mock(async ({ request, sessionID }) => {
    calls.push('rewriteRequest')
    const body = JSON.parse(await request.text())
    delete body.max_output_tokens
    const headers = new Headers(request.headers)
    headers.set('session-id', sessionID)
    return new Request('https://plugin.invalid/responses', {
      method: request.method,
      headers,
      body: JSON.stringify(body),
    })
  })
  adapter.rewriteHandshakeURL = mock(() => {
    calls.push('rewriteHandshakeURL')
    return 'wss://plugin.invalid/responses'
  })
  adapter.rewriteWebSocketFrame = mock(({ frame }) => {
    calls.push('rewriteWebSocketFrame')
    return `${frame} rewritten`
  })
  return { host, adapter, choices, plan, calls }
}

async function passThrough(credential: string) {
  const { host, adapter, calls } = fixture()
  const installation = await installOpenCode2Auth(host.ctx, adapter, gated)
  const events: string[] = []
  for (const name of ['select', 'quota', 'limit', 'retry'] as const)
    installation.on(name, () => {
      events.push(name)
    })
  const model = {
    ...scopeFor(),
    baseURL: 'https://stock.invalid',
    headers: { 'x-stock': 'model' },
  }
  const beforeModel = structuredClone(model)
  await host.fire('model.request', model)
  expect(model).toEqual(beforeModel)
  const original = request(credential)
  const headers = [...original.headers.entries()]
  const body = await original.clone().text()
  const draft = await host.fire('http.request', {
    ...scopeFor(),
    request: original,
  })
  expect(draft.request).toBe(original)
  expect(draft.request.url).toBe(
    'https://provider.invalid/v1/responses?stock=1',
  )
  expect([...draft.request.headers.entries()]).toEqual(headers)
  expect(await draft.request.text()).toBe(body)
  const response = new Response('{"type":"refused"}', {
    status: 429,
    headers: { 'x-quota-used': '5' },
  })
  const reply = await host.fire('http.response', {
    ...scopeFor(),
    request: original,
    response,
  })
  expect(reply.response).toBe(response)
  const retried = retry()
  const decision = retried.decision
  await host.fire('retry', retried)
  expect(retried.decision).toBe(decision)
  expect(calls).toEqual([])
  expect(events).toEqual([])
  expect(installation.size).toBe(0)
  expect(installation.accountFor('ses_1', 'primary')).toBeUndefined()
  await installation.dispose()
}

describe('OpenCode 2 placeholder ownership', () => {
  test('an API key passes through byte identical with no adapter calls or attempts', async () => {
    await passThrough('Bearer sk-api-key')
  })

  test('a host login bearer passes through byte identical with no adapter calls or attempts', async () => {
    await passThrough('Bearer host-oauth-token')
  })

  test('ownership requires exact placeholder equality', async () => {
    await passThrough(`${placeholder}-suffix`)
    await passThrough(`Bearer prefix-${secret}`)
    await passThrough('')
  })

  test('an owned placeholder is served attributed and retried at transport', async () => {
    const { host, adapter, choices, plan } = fixture()
    const installation = await installOpenCode2Auth(host.ctx, adapter, gated)
    const selected: string[] = []
    const quotas: string[] = []
    installation.on('select', (e) => {
      selected.push(e.hook)
    })
    installation.on('quota', (e) => {
      quotas.push(`${e.accountId}:${e.quota.used}`)
    })
    installation.on('limit', (e) => {
      plan.limited.add(e.accountId)
    })
    await host.fire('model.request', { ...scopeFor(), headers: {} })
    expect(choices).toEqual([])
    const sent = await host.fire('http.request', {
      ...scopeFor(),
      request: request(),
    })
    expect(sent.request.headers.get('authorization')).toBe('Bearer tok-A')
    expect(sent.request.headers.get('session-id')).toBe('ses_1')
    expect(sent.request.headers.has(ATTEMPT_HEADER)).toBe(false)
    expect(sent.request.url).toBe('https://plugin.invalid/responses')
    expect(await sent.request.text()).toBe('{"input":[]}')
    await host.fire('http.response', {
      ...scopeFor(),
      request: sent.request,
      response: new Response(null, {
        status: 429,
        headers: { 'x-quota-used': '12' },
      }),
    })
    const retried = await host.fire('retry', retry())
    expect(retried.decision).toEqual({ retry: true, delay: 0 })
    const next = await host.fire('http.request', {
      ...scopeFor(),
      request: request(),
    })
    expect(next.request.headers.get('authorization')).toBe('Bearer tok-B')
    expect(choices[1]?.rerouteFrom).toEqual({
      accountId: 'A',
      limit: { reason: 'too-many', status: 429 },
    })
    expect(selected).toEqual(['http.request', 'http.request'])
    expect(quotas).toEqual(['A:12'])
    await installation.dispose()
  })

  test('an owned placeholder with no account is refused locally before dispatch', async () => {
    const { host, adapter, plan } = fixture()
    plan.limited = new Set(['A', 'B'])
    const installation = await installOpenCode2Auth(host.ctx, adapter, gated)
    const dispatch = mock(() => {})
    let error: unknown
    try {
      await host.fire('http.request', { ...scopeFor(), request: request() })
      dispatch()
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(OpenCode2AuthError)
    expect((error as OpenCode2AuthError).kind).toBe('no-account')
    expect(dispatch).not.toHaveBeenCalled()
    expect(adapter.rewriteRequest).not.toHaveBeenCalled()
    const retried = await host.fire('retry', retry())
    expect(retried.decision.retry).toBe(false)
    await installation.dispose()
  })

  test('switching placeholder to API key and back changes the next request and retry', async () => {
    const { host, adapter, plan, choices, calls } = fixture()
    const installation = await installOpenCode2Auth(host.ctx, adapter, gated)
    const owned = await host.fire('http.request', {
      ...scopeFor(),
      request: request(),
    })
    await host.fire('http.response', {
      ...scopeFor(),
      request: owned.request,
      response: new Response(null, { status: 429 }),
    })
    calls.length = 0
    const apiKey = request('Bearer sk-api-key')
    expect(
      (await host.fire('http.request', { ...scopeFor(), request: apiKey }))
        .request,
    ).toBe(apiKey)
    const draft = retry()
    const stockDecision = draft.decision
    await host.fire('retry', draft)
    expect(draft.decision).toBe(stockDecision)
    expect(calls).toEqual([])
    expect(choices).toHaveLength(1)
    plan.next = 'B'
    const back = await host.fire('http.request', {
      ...scopeFor(),
      request: request(),
    })
    expect(back.request.headers.get('authorization')).toBe('Bearer tok-B')
    expect(choices).toHaveLength(2)
    await installation.dispose()
  })

  test('a non owned socket handshake and frames are untouched and unattributed', async () => {
    const { host, adapter, calls } = fixture()
    const installation = await installOpenCode2Auth(host.ctx, adapter, gated)
    const quotas: string[] = []
    installation.on('quota', (e) => {
      quotas.push(e.accountId)
    })
    const handshake = (credential: string) => ({
      ...scopeFor(),
      url: 'wss://stock.invalid/responses',
      headers: { Authorization: credential, 'x-stock': 'keep' } as Record<
        string,
        string
      >,
    })
    const owned = await host.fire(
      'experimental.ws.handshake',
      handshake(placeholder),
    )
    expect(owned.url).toBe('wss://plugin.invalid/responses')
    expect(owned.headers.Authorization).toBeUndefined()
    expect(
      (
        await host.fire('experimental.ws.send', {
          ...scopeFor(),
          frame: 'owned',
        })
      ).frame,
    ).toBe('owned rewritten')
    calls.length = 0
    const stock = handshake('Bearer sk-api-key')
    const before = structuredClone(stock)
    await host.fire('experimental.ws.handshake', stock)
    expect(stock).toEqual(before)
    expect(
      (
        await host.fire('experimental.ws.send', {
          ...scopeFor(),
          frame: 'stock',
        })
      ).frame,
    ).toBe('stock')
    await host.fire('experimental.ws.receive', {
      ...scopeFor(),
      frame: '{"type":"quota","used":88}',
    })
    const draft = retry()
    const stockDecision = draft.decision
    await host.fire('retry', draft)
    expect(draft.decision).toBe(stockDecision)
    expect(calls).toEqual([])
    expect(quotas).toEqual([])
    expect(installation.size).toBe(1)
    await installation.dispose()
  })

  test('concurrent owned attempts of one session and kind keep their own attribution', async () => {
    const host = fakeHost()
    const { adapter, plan, choices } = fakeAdapter()
    const installation = await installOpenCode2Auth(host.ctx, adapter, gated)
    const quotas: string[] = []
    installation.on('quota', (e) => {
      quotas.push(`${e.handle.attemptId}:${e.accountId}:${e.quota.used}`)
    })
    const a = await host.fire('http.request', {
      ...scopeFor(),
      request: request(),
    })
    plan.next = 'B'
    const b = await host.fire('http.request', {
      ...scopeFor(),
      request: request(),
    })
    expect(a.request.headers.get('authorization')).toBe('Bearer tok-A')
    expect(b.request.headers.get('authorization')).toBe('Bearer tok-B')
    await host.fire('http.response', {
      ...scopeFor(),
      request: b.request,
      response: new Response(null, { headers: { 'x-quota-used': '22' } }),
    })
    await host.fire('http.response', {
      ...scopeFor(),
      request: a.request,
      response: new Response(null, {
        status: 429,
        headers: { 'x-quota-used': '11' },
      }),
    })
    expect(quotas).toEqual(['attempt-2:B:22', 'attempt-1:A:11'])
    expect((await host.fire('retry', retry())).decision).toEqual({
      retry: true,
      delay: 0,
    })
    await host.fire('http.request', { ...scopeFor(), request: request() })
    expect(choices[2]?.rerouteFrom).toEqual({
      accountId: 'A',
      limit: { reason: 'too-many', status: 429 },
    })
    await installation.dispose()
  })

  test('omitting the option preserves legacy model selection and wire bytes', async () => {
    const host = fakeHost()
    const { adapter, choices } = fakeAdapter()
    const installation = await installOpenCode2Auth(host.ctx, adapter)
    const model = await host.fire('model.request', {
      ...scopeFor(),
      headers: { Authorization: 'Bearer real-host-token' } as Record<
        string,
        string
      >,
    })
    expect(model.headers).toEqual({
      authorization: 'Bearer tok-A',
      'x-account': 'A',
      [ATTEMPT_HEADER]: 'attempt-1',
    })
    const headers = {
      ...model.headers,
      authorization: 'Bearer real-host-token',
      'content-type': 'application/json',
      'x-stock': 'keep',
    }
    const original = new Request('https://provider.invalid/v1/responses', {
      method: 'POST',
      headers,
      body: '{"input":[]}',
    })
    const sent = await host.fire('http.request', {
      ...scopeFor(),
      request: original,
    })
    expect(choices).toHaveLength(1)
    expect(sent.request.url).toBe(original.url)
    expect([...sent.request.headers.entries()]).toEqual([
      ['authorization', 'Bearer tok-A'],
      ['content-type', 'application/json'],
      ['x-account', 'A'],
      ['x-stock', 'keep'],
    ])
    expect(await sent.request.text()).toBe('{"input":[]}')
    await installation.dispose()
  })

  test('owned placeholders cannot leave even with a customized wire guard', async () => {
    const host = fakeHost()
    const { adapter } = fakeAdapter(undefined, { accountHeaders: () => ({}) })
    const installation = await installOpenCode2Auth(host.ctx, adapter, {
      ...gated,
      hostCredentials: [],
    })
    const dispatch = mock(() => {})
    let error: unknown
    try {
      await host.fire('http.request', { ...scopeFor(), request: request() })
      dispatch()
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(OpenCode2AuthError)
    expect((error as OpenCode2AuthError).kind).toBe('host-credential-on-wire')
    expect(dispatch).not.toHaveBeenCalled()
    error = undefined
    try {
      await host.fire('experimental.ws.handshake', {
        ...scopeFor(),
        url: 'wss://stock.invalid',
        headers: { authorization: placeholder },
      })
      dispatch()
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(OpenCode2AuthError)
    expect((error as OpenCode2AuthError).kind).toBe('host-credential-on-wire')
    expect(dispatch).not.toHaveBeenCalled()
    await installation.dispose()
  })

  test('an adapter can gate on the Anthropic API key header', async () => {
    const host = fakeHost()
    const { adapter } = fakeAdapter(undefined, {
      accountHeaders: () => ({ 'x-api-key': 'served-key' }),
    })
    const installation = await installOpenCode2Auth(host.ctx, adapter, {
      gateOnPlaceholder: {
        credential: (headers) => headers.get('x-api-key') ?? undefined,
      },
    })
    const original = new Request('https://anthropic.invalid/messages', {
      headers: { 'x-api-key': secret },
    })
    const sent = await host.fire('http.request', {
      ...scopeFor(),
      request: original,
    })
    expect(sent.request.headers.get('x-api-key')).toBe('served-key')
    await installation.dispose()
  })
})
