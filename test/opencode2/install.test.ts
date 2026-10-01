import { describe, expect, test } from 'bun:test'
import {
  installOpenCode2Auth,
  OpenCode2AuthError,
  placeholderSecret,
} from '../../src/opencode2/index.js'
import {
  fakeAdapter,
  fakeHost,
  PROVIDER,
  scopeFor,
  sse,
  type TestQuota,
} from './fake-host.js'

const PLACEHOLDER = `Bearer ${placeholderSecret(PROVIDER)}`

function httpDraft(kind: 'primary' | 'title' = 'primary', sessionID = 'ses_1') {
  return {
    ...scopeFor(kind, sessionID),
    request: new Request('https://provider.invalid/v1/responses', {
      method: 'POST',
      headers: {
        authorization: PLACEHOLDER,
        'content-type': 'application/json',
      },
      body: '{"input":[]}',
    }),
  }
}

async function sendHttp(
  host: ReturnType<typeof fakeHost>,
  kind: 'primary' | 'title' = 'primary',
  response: Response = new Response('ok'),
  sessionID = 'ses_1',
) {
  await host.fire('model.request', {
    ...scopeFor(kind, sessionID),
    headers: { authorization: PLACEHOLDER } as Record<string, string>,
  })
  const request = await host.fire('http.request', httpDraft(kind, sessionID))
  const reply = await host.fire('http.response', {
    ...scopeFor(kind, sessionID),
    request: request.request,
    response,
  })
  return { request: request.request, response: reply.response }
}

async function sendWs(
  host: ReturnType<typeof fakeHost>,
  frames: unknown[],
  kind: 'primary' | 'title' = 'primary',
) {
  await host.fire('model.request', { ...scopeFor(kind), headers: {} })
  const handshake = await host.fire('experimental.ws.handshake', {
    ...scopeFor(kind),
    url: 'wss://provider.invalid/v1/responses',
    headers: { Authorization: PLACEHOLDER } as Record<string, string>,
  })
  for (const frame of frames) {
    await host.fire('experimental.ws.receive', {
      ...scopeFor(kind),
      frame: JSON.stringify(frame),
    })
  }
  return handshake
}

function retryDraft(decision: { retry: boolean; delay?: number }) {
  const { kind: _kind, ...scope } = scopeFor()
  return {
    ...scope,
    error: { type: 'provider.unknown', message: 'failed' },
    attempt: 1,
    decision,
  }
}

describe('installOpenCode2Auth', () => {
  test('registers every recipe hook scoped to the adapter provider', async () => {
    const host = fakeHost()
    const { adapter, choices } = fakeAdapter()
    await installOpenCode2Auth(host.ctx, adapter)
    expect(host.hooks.map((hook) => [hook.name, hook.providerID])).toEqual([
      ['model.request', PROVIDER],
      ['http.request', PROVIDER],
      ['http.response', PROVIDER],
      ['experimental.ws.handshake', PROVIDER],
      ['experimental.ws.receive', PROVIDER],
      ['retry', PROVIDER],
    ])
    const other = await host.fire('model.request', {
      ...scopeFor('primary', 'ses_1', 'otherprov'),
      headers: { authorization: 'Bearer other' } as Record<string, string>,
    })
    expect(other.headers).toEqual({ authorization: 'Bearer other' })
    expect(choices).toEqual([])
  })

  test('model.request picks the account per session and kind and sets its headers', async () => {
    const host = fakeHost()
    const { adapter, choices, plan } = fakeAdapter()
    const installation = await installOpenCode2Auth(host.ctx, adapter)
    const primary = await host.fire('model.request', {
      ...scopeFor('primary'),
      headers: { Authorization: PLACEHOLDER } as Record<string, string>,
    })
    expect(primary.headers).toEqual({
      authorization: 'Bearer tok-A',
      'x-account': 'A',
    })
    plan.next = 'B'
    await host.fire('model.request', { ...scopeFor('title'), headers: {} })
    expect(installation.accountFor('ses_1', 'primary')).toBe('A')
    expect(installation.accountFor('ses_1', 'title')).toBe('B')
    expect(choices.map((choice) => [choice.kind, choice.sessionID])).toEqual([
      ['primary', 'ses_1'],
      ['title', 'ses_1'],
    ])
  })

  test('a later request of the same session switches account and names the previous one', async () => {
    const host = fakeHost()
    const { adapter, choices, plan } = fakeAdapter()
    const installation = await installOpenCode2Auth(host.ctx, adapter)
    const selected: string[] = []
    installation.on('select', (event) => {
      selected.push(`${event.accountId}<-${event.previousAccountId ?? '-'}`)
    })
    const first = await sendHttp(host)
    plan.next = 'B'
    const second = await sendHttp(host)
    expect(first.request.headers.get('authorization')).toBe('Bearer tok-A')
    expect(second.request.headers.get('authorization')).toBe('Bearer tok-B')
    expect(choices[1]?.previousAccountId).toBe('A')
    expect(selected).toEqual(['A<--', 'B<-A'])
  })

  test('http.request writes the account credential over the host credential', async () => {
    const host = fakeHost()
    const { adapter } = fakeAdapter()
    await installOpenCode2Auth(host.ctx, adapter)
    await host.fire('model.request', { ...scopeFor(), headers: {} })
    const draft = await host.fire('http.request', httpDraft())
    expect(draft.request.headers.get('authorization')).toBe('Bearer tok-A')
    expect(draft.request.headers.get('x-account')).toBe('A')
    expect(draft.request.headers.get('content-type')).toBe('application/json')
    expect(await draft.request.text()).toBe('{"input":[]}')
  })

  test('ws handshake writes the account credential over the host credential', async () => {
    const host = fakeHost()
    const { adapter, plan } = fakeAdapter()
    await installOpenCode2Auth(host.ctx, adapter)
    plan.next = 'B'
    const handshake = await sendWs(host, [])
    expect(handshake.headers).toEqual({
      authorization: 'Bearer tok-B',
      'x-account': 'B',
    })
  })

  test('a transport hook picks the account when model.request did not run', async () => {
    const host = fakeHost()
    const { adapter } = fakeAdapter()
    const installation = await installOpenCode2Auth(host.ctx, adapter)
    const hooks: string[] = []
    installation.on('select', (event) => {
      hooks.push(`${event.kind}:${event.hook}`)
    })
    const draft = await host.fire('http.request', httpDraft('title'))
    expect(draft.request.headers.get('authorization')).toBe('Bearer tok-A')
    const handshake = await host.fire('experimental.ws.handshake', {
      ...scopeFor('primary'),
      url: 'wss://provider.invalid/',
      headers: { authorization: PLACEHOLDER } as Record<string, string>,
    })
    expect(handshake.headers.authorization).toBe('Bearer tok-A')
    await host.fire('model.request', { ...scopeFor('primary'), headers: {} })
    expect(hooks).toEqual([
      'title:http.request',
      'primary:experimental.ws.handshake',
      'primary:model.request',
    ])
  })

  test('http quota headers are attributed to the account recorded for the request', async () => {
    const host = fakeHost()
    const { adapter, plan } = fakeAdapter()
    const installation = await installOpenCode2Auth(host.ctx, adapter)
    const readings: string[] = []
    installation.on('quota', (event) => {
      readings.push(`${event.kind}:${event.accountId}:${event.quota.used}`)
    })
    await sendHttp(
      host,
      'primary',
      new Response('ok', { headers: { 'x-quota-used': '11' } }),
    )
    plan.next = 'B'
    await sendHttp(
      host,
      'title',
      new Response('ok', { headers: { 'x-quota-used': '55' } }),
    )
    expect(readings).toEqual(['primary:A:11', 'title:B:55'])
  })

  test('ws quota frames are attributed to the account recorded for the session and kind', async () => {
    const host = fakeHost()
    const { adapter, plan } = fakeAdapter()
    const installation = await installOpenCode2Auth(host.ctx, adapter)
    const readings: string[] = []
    installation.on('quota', (event) => {
      readings.push(`${event.transport}:${event.accountId}:${event.quota.used}`)
    })
    await sendWs(host, [{ type: 'quota', used: 11 }])
    plan.next = 'B'
    await sendWs(host, [{ type: 'quota', used: 55 }])
    expect(readings).toEqual(['ws:A:11', 'ws:B:55'])
  })

  test('the http event stream is inspected without being consumed', async () => {
    const host = fakeHost()
    const { adapter } = fakeAdapter()
    const installation = await installOpenCode2Auth(host.ctx, adapter)
    const limits: string[] = []
    const quotas: number[] = []
    installation.on('limit', (event) => {
      limits.push(`${event.accountId}:${event.via}:${event.outputStarted}`)
    })
    installation.on('quota', (event) => {
      quotas.push(event.quota.used)
    })
    const body = sse([
      { type: 'quota', used: 40 },
      { type: 'delta' },
      { type: 'refused' },
    ])
    const { response } = await sendHttp(host, 'primary', new Response(body))
    expect(await response.text()).toBe(body)
    expect(quotas).toEqual([40])
    expect(limits).toEqual(['A:http:true'])
    const retry = await host.fire(
      'retry',
      retryDraft({ retry: true, delay: 900 }),
    )
    expect(retry.decision).toEqual({ retry: false })
  })

  test('retry before output reroutes at once after the limit listeners finish', async () => {
    const host = fakeHost()
    const { adapter, choices, plan } = fakeAdapter()
    const installation = await installOpenCode2Auth(host.ctx, adapter)
    installation.on('limit', async (event) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      plan.limited.add(event.accountId)
    })
    const decisions: string[] = []
    installation.on('retry', (event) => {
      decisions.push(`${event.reason}:${event.accountId}`)
    })
    await sendWs(host, [{ type: 'refused' }])
    const retry = await host.fire('retry', retryDraft({ retry: false }))
    expect(retry.decision).toEqual({ retry: true, delay: 0 })
    expect(decisions).toEqual(['reroute:A'])
    const handshake = await sendWs(host, [])
    expect(handshake.headers.authorization).toBe('Bearer tok-B')
    expect(choices.at(-1)).toMatchObject({
      previousAccountId: 'A',
      rerouteFrom: { accountId: 'A', limit: { reason: 'refused' } },
    })
  })

  test('retry after output vetoes the host retry', async () => {
    const host = fakeHost()
    const { adapter } = fakeAdapter()
    const installation = await installOpenCode2Auth(host.ctx, adapter)
    const decisions: string[] = []
    installation.on('retry', (event) => {
      decisions.push(event.reason)
    })
    await sendWs(host, [{ type: 'delta' }, { type: 'refused' }])
    const retry = await host.fire(
      'retry',
      retryDraft({ retry: true, delay: 1500 }),
    )
    expect(retry.decision).toEqual({ retry: false })
    expect(decisions).toEqual(['output-started'])
  })

  test('retry leaves the host decision alone for errors that are not limits', async () => {
    const host = fakeHost()
    const { adapter } = fakeAdapter()
    await installOpenCode2Auth(host.ctx, adapter)
    await sendWs(host, [])
    const retry = await host.fire(
      'retry',
      retryDraft({ retry: true, delay: 1500 }),
    )
    expect(retry.decision).toEqual({ retry: true, delay: 1500 })
  })

  test('a limit named only by the retry error still reroutes', async () => {
    const host = fakeHost()
    const { adapter } = fakeAdapter(undefined, {
      limitFromError: (error) =>
        error.type === 'provider.quota' ? { reason: error.type } : undefined,
    })
    const installation = await installOpenCode2Auth(host.ctx, adapter)
    const limits: string[] = []
    installation.on('limit', (event) => {
      limits.push(`${event.accountId}:${event.via}`)
    })
    await sendWs(host, [])
    const retry = await host.fire('retry', {
      ...retryDraft({ retry: false }),
      error: { type: 'provider.quota', message: 'usage limit' },
    })
    expect(retry.decision).toEqual({ retry: true, delay: 0 })
    expect(limits).toEqual(['A:error'])
  })

  test('a request with no account is refused and its retry vetoed', async () => {
    const host = fakeHost()
    const { adapter } = fakeAdapter({ next: 'A', limited: new Set(['A', 'B']) })
    await installOpenCode2Auth(host.ctx, adapter)
    const failure = await host
      .fire('model.request', { ...scopeFor(), headers: {} })
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect(failure).toBeInstanceOf(OpenCode2AuthError)
    expect((failure as OpenCode2AuthError).kind).toBe('no-account')
    const retry = await host.fire(
      'retry',
      retryDraft({ retry: true, delay: 10 }),
    )
    expect(retry.decision).toEqual({ retry: false })
  })

  test('a request still carrying the host placeholder is refused before it leaves', async () => {
    const host = fakeHost()
    const { adapter } = fakeAdapter(undefined, {
      accountHeaders: ({ accountId }) => ({ 'x-account': accountId }),
    })
    await installOpenCode2Auth(host.ctx, adapter)
    await host.fire('model.request', { ...scopeFor(), headers: {} })
    const http = await host.fire('http.request', httpDraft()).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect((http as OpenCode2AuthError).kind).toBe('host-credential-on-wire')
    const ws = await host
      .fire('experimental.ws.handshake', {
        ...scopeFor(),
        url: 'wss://provider.invalid/',
        headers: { authorization: PLACEHOLDER } as Record<string, string>,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect((ws as OpenCode2AuthError).kind).toBe('host-credential-on-wire')
  })

  test('request and response rewrites run around detection', async () => {
    const host = fakeHost()
    const seenByRewrite: string[] = []
    const { adapter } = fakeAdapter(undefined, {
      rewriteRequest: ({ request, accountId }) =>
        new Request(`https://rewritten.invalid/${accountId}`, {
          method: 'POST',
          headers: request.headers,
          body: '{"rewritten":true}',
        }),
      rewriteResponse: async ({ response }) => {
        const text = await response.text()
        seenByRewrite.push(text)
        return new Response('replaced', { status: 503 })
      },
      rewriteHandshakeURL: ({ url, accountId }) =>
        `${url}?account=${accountId}`,
    })
    const installation = await installOpenCode2Auth(host.ctx, adapter)
    const outputs: boolean[] = []
    installation.on('limit', (event) => {
      outputs.push(event.outputStarted)
    })
    const body = sse([{ type: 'delta' }, { type: 'refused' }])
    const { request, response } = await sendHttp(
      host,
      'primary',
      new Response(body),
    )
    expect(request.url).toBe('https://rewritten.invalid/A')
    expect(request.headers.get('authorization')).toBe('Bearer tok-A')
    expect(await request.text()).toBe('{"rewritten":true}')
    expect(response.status).toBe(503)
    expect(await response.text()).toBe('replaced')
    expect(seenByRewrite).toEqual([body])
    expect(outputs).toEqual([true])
    const handshake = await sendWs(host, [])
    expect(handshake.url).toBe('wss://provider.invalid/v1/responses?account=A')
  })

  test('an error response is classified from a copy of its body', async () => {
    const host = fakeHost()
    const bodies: string[] = []
    const { adapter } = fakeAdapter(undefined, {
      limitFromResponse: async ({ status, body }) => {
        const text = await body()
        bodies.push(text)
        return status === 429 && text.includes('usage_limit')
          ? { reason: 'usage_limit', status }
          : undefined
      },
    })
    const installation = await installOpenCode2Auth(host.ctx, adapter)
    const limits: string[] = []
    installation.on('limit', (event) => {
      limits.push(
        `${event.accountId}:${event.limit.reason}:${event.limit.status}`,
      )
    })
    const errorBody = '{"error":{"type":"usage_limit"}}'
    const { response } = await sendHttp(
      host,
      'primary',
      new Response(errorBody, { status: 429 }),
    )
    expect(await response.text()).toBe(errorBody)
    expect(bodies).toEqual([errorBody])
    expect(limits).toEqual(['A:usage_limit:429'])
    const retry = await host.fire('retry', retryDraft({ retry: false }))
    expect(retry.decision).toEqual({ retry: true, delay: 0 })
  })

  test('records are bounded and a deleted session is forgotten', async () => {
    const host = fakeHost()
    const { adapter } = fakeAdapter()
    const installation = await installOpenCode2Auth(host.ctx, adapter, {
      maxRecords: 3,
    })
    for (const session of ['s1', 's2', 's3', 's4']) {
      await host.fire('model.request', {
        ...scopeFor('primary', session),
        headers: {},
      })
    }
    expect(installation.size).toBe(3)
    expect(installation.accountFor('s1', 'primary')).toBeUndefined()
    await host.fire('model.request', {
      ...scopeFor('title', 's4'),
      headers: {},
    })
    expect(installation.accountFor('s2', 'primary')).toBeUndefined()
    await host.publish('session.deleted', { sessionID: 's4' })
    expect(installation.accountFor('s4', 'primary')).toBeUndefined()
    expect(installation.accountFor('s4', 'title')).toBeUndefined()
    expect(installation.accountFor('s3', 'primary')).toBe('A')
    expect(installation.size).toBe(1)
  })

  test('a throwing listener is logged and never reaches the host', async () => {
    const host = fakeHost()
    const { adapter } = fakeAdapter()
    const warnings: string[] = []
    const installation = await installOpenCode2Auth(host.ctx, adapter, {
      logger: { warn: (message) => warnings.push(message) },
    })
    installation.on('limit', () => {
      throw new Error('listener broke')
    })
    await sendWs(host, [{ type: 'refused' }])
    const retry = await host.fire('retry', retryDraft({ retry: false }))
    expect(retry.decision).toEqual({ retry: true, delay: 0 })
    expect(warnings).toEqual([
      'opencode2 auth listener threw; the request is unaffected',
    ])
  })

  test('dispose removes every hook and ends the session listener', async () => {
    const host = fakeHost()
    const { adapter, choices } = fakeAdapter()
    const installation = await installOpenCode2Auth<TestQuota>(
      host.ctx,
      adapter,
    )
    await host.publish('noop', {})
    expect(host.activeSubscriptions).toBe(1)
    await installation.dispose()
    await host.publish('noop', {})
    expect(host.hooks.every((hook) => hook.disposed)).toBe(true)
    expect(host.activeSubscriptions).toBe(0)
    await host.fire('model.request', { ...scopeFor(), headers: {} })
    expect(choices).toEqual([])
  })
})
