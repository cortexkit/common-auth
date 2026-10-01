import { describe, expect, test } from 'bun:test'
import {
  type AttemptOutcome,
  installOpenCode2Auth,
  type OpenCode2AuthAdapter,
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
type Kind = 'primary' | 'title'

/**
 * An adapter whose `accountHeaders` hands out a fresh value per attempt,
 * `<session>/<kind>#<n>`, and which writes down that value at every place
 * the installer hands an attempt back: `<where>:<value>`.
 */
function trackingAdapter(
  overrides: Partial<OpenCode2AuthAdapter<TestQuota, string>> = {},
) {
  const seen: string[] = []
  const ends: Array<{ data: string | undefined; outcome: AttemptOutcome }> = []
  let issued = 0
  const base = fakeAdapter().adapter
  const adapter: OpenCode2AuthAdapter<TestQuota, string> = {
    ...base,
    accountHeaders({ accountId, sessionID, kind }) {
      issued += 1
      return {
        headers: {
          authorization: `Bearer tok-${accountId}`,
          'x-account': accountId,
        },
        attempt: `${sessionID}/${kind}#${issued}`,
      }
    },
    quotaFromHeaders(headers, status, attempt) {
      seen.push(`headers:${attempt.data}`)
      return base.quotaFromHeaders?.(headers, status, attempt)
    },
    limitFromResponse(input) {
      seen.push(`response:${input.attempt.data}`)
      return base.limitFromResponse?.(input)
    },
    inspectEvent(input) {
      seen.push(`${input.transport}-event:${input.attempt.data}`)
      const event = JSON.parse(input.data) as { type?: string }
      if (event.type === 'done') return { done: true }
      if (event.type === 'failed') return { error: 'response failed' }
      return base.inspectEvent?.(input)
    },
    limitFromError(_error, attempt) {
      seen.push(`error:${attempt.data}`)
      return undefined
    },
    onAttemptEnd(attempt, outcome) {
      seen.push(`end:${attempt.data}`)
      ends.push({ data: attempt.data, outcome })
    },
    ...overrides,
  }
  return { adapter, seen, ends }
}

/** Installs `adapter`, logging every event's attempt value into `seen`. */
async function install(
  adapter: OpenCode2AuthAdapter<TestQuota, string>,
  seen: string[] = [],
) {
  const host = fakeHost()
  const installation = await installOpenCode2Auth<TestQuota, string>(
    host.ctx,
    adapter,
  )
  installation.on('select', (event) => {
    seen.push(`select:${event.handle.data}`)
  })
  installation.on('quota', (event) => {
    seen.push(`quota:${event.handle.data}`)
  })
  installation.on('limit', (event) => {
    seen.push(`limit:${event.handle.data}`)
  })
  installation.on('retry', (event) => {
    seen.push(`retry:${event.handle?.data}`)
  })
  return { host, installation, events: seen }
}

const modelRequest = (
  host: ReturnType<typeof fakeHost>,
  sessionID: string,
  kind: Kind = 'primary',
) =>
  host.fire('model.request', {
    ...scopeFor(kind, sessionID),
    headers: {} as Record<string, string>,
  })

const httpRequest = (
  host: ReturnType<typeof fakeHost>,
  sessionID: string,
  kind: Kind = 'primary',
) =>
  host.fire('http.request', {
    ...scopeFor(kind, sessionID),
    request: new Request('https://provider.invalid/v1/responses', {
      method: 'POST',
      headers: { authorization: PLACEHOLDER },
      body: '{}',
    }),
  })

const httpResponse = (
  host: ReturnType<typeof fakeHost>,
  sessionID: string,
  request: Request,
  response: Response,
  kind: Kind = 'primary',
) =>
  host.fire('http.response', {
    ...scopeFor(kind, sessionID),
    request,
    response,
  })

const handshake = (
  host: ReturnType<typeof fakeHost>,
  sessionID: string,
  kind: Kind = 'primary',
) =>
  host.fire('experimental.ws.handshake', {
    ...scopeFor(kind, sessionID),
    url: 'wss://provider.invalid/v1/responses',
    headers: { authorization: PLACEHOLDER } as Record<string, string>,
  })

const receive = (
  host: ReturnType<typeof fakeHost>,
  sessionID: string,
  frame: unknown,
  kind: Kind = 'primary',
) =>
  host.fire('experimental.ws.receive', {
    ...scopeFor(kind, sessionID),
    frame: JSON.stringify(frame),
  })

const retry = (host: ReturnType<typeof fakeHost>, sessionID: string) => {
  const { kind: _kind, ...scope } = scopeFor('primary', sessionID)
  return host.fire('retry', {
    ...scope,
    error: { type: 'provider.unknown', message: 'failed' },
    attempt: 1,
    decision: { retry: true, delay: 100 } as
      | { retry: false }
      | { retry: true; delay: number },
  })
}

/** Lets pending listener and callback promises settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Groups `<where>:<value>` entries by value. */
function byValue(entries: string[]) {
  const groups: Record<string, string[]> = {}
  for (const entry of entries) {
    const at = entry.indexOf(':')
    const value = entry.slice(at + 1)
    groups[value] ??= []
    groups[value].push(entry.slice(0, at))
  }
  return groups
}

describe('installOpenCode2Auth attempts', () => {
  test('an attempt value reaches every event of its own attempt across interleaved sessions', async () => {
    const { adapter, seen, ends } = trackingAdapter()
    const { host } = await install(adapter, seen)
    // Two sessions over HTTP, every step interleaved.
    await modelRequest(host, 's1')
    await modelRequest(host, 's2')
    const second = await httpRequest(host, 's2')
    const first = await httpRequest(host, 's1')
    const refused = await httpResponse(
      host,
      's1',
      first.request,
      new Response('{"error":"slow down"}', {
        status: 429,
        headers: { 'x-quota-used': '90' },
      }),
    )
    const served = await httpResponse(
      host,
      's2',
      second.request,
      new Response(sse([{ type: 'quota', used: 12 }, { type: 'delta' }]), {
        headers: { 'x-quota-used': '10' },
      }),
    )
    await served.response.text()
    await refused.response.text()
    await retry(host, 's1')
    // Two more sessions over WebSocket, frames interleaved.
    await modelRequest(host, 's3')
    await modelRequest(host, 's4')
    await handshake(host, 's4')
    await handshake(host, 's3')
    await receive(host, 's3', { type: 'quota', used: 30 })
    await receive(host, 's4', { type: 'delta' })
    await receive(host, 's3', { type: 'refused' })
    await receive(host, 's4', { type: 'done' })
    await receive(host, 's3', { type: 'done' })
    await settle()

    expect(byValue(seen)).toEqual({
      's1/primary#1': [
        'select',
        'headers',
        'quota',
        'response',
        'limit',
        'end',
        'retry',
      ],
      's2/primary#2': [
        'select',
        'headers',
        'quota',
        'http-event',
        'quota',
        'http-event',
        'end',
      ],
      's3/primary#3': [
        'select',
        'ws-event',
        'quota',
        'ws-event',
        'limit',
        'ws-event',
        'end',
      ],
      's4/primary#4': ['select', 'ws-event', 'ws-event', 'end'],
    })
    expect(
      ends.map(({ data, outcome }) => [data, outcome.status, outcome.limit]),
    ).toEqual([
      ['s1/primary#1', 429, { reason: 'too-many', status: 429 }],
      ['s2/primary#2', 200, undefined],
      ['s4/primary#4', undefined, undefined],
      ['s3/primary#3', undefined, { reason: 'refused' }],
    ])
  })

  test('two sequential attempts in one session keep their own values', async () => {
    const { adapter, seen, ends } = trackingAdapter()
    const { host } = await install(adapter, seen)
    for (const used of [5, 6]) {
      await modelRequest(host, 's1')
      await handshake(host, 's1')
      await receive(host, 's1', { type: 'quota', used })
      await receive(host, 's1', { type: 'done' })
    }
    for (const used of [7, 8]) {
      await modelRequest(host, 's1')
      const sent = await httpRequest(host, 's1')
      const reply = await httpResponse(
        host,
        's1',
        sent.request,
        new Response('ok', { headers: { 'x-quota-used': String(used) } }),
      )
      await reply.response.text()
    }
    await retry(host, 's1')
    await settle()
    expect(seen.filter((entry) => /^(error|retry):/.test(entry))).toEqual([
      'error:s1/primary#4',
      'retry:s1/primary#4',
    ])
    expect(seen.filter((entry) => entry.startsWith('quota'))).toEqual([
      'quota:s1/primary#1',
      'quota:s1/primary#2',
      'quota:s1/primary#3',
      'quota:s1/primary#4',
    ])
    expect(ends.map(({ data, outcome }) => [data, outcome])).toEqual([
      ['s1/primary#1', { outputStarted: false }],
      ['s1/primary#2', { outputStarted: false }],
      ['s1/primary#3', { status: 200, outputStarted: false }],
      ['s1/primary#4', { status: 200, outputStarted: false }],
    ])
  })

  test('cancelling the response ends the attempt with output as observed', async () => {
    const { adapter, ends } = trackingAdapter()
    const { host } = await install(adapter)
    const encoder = new TextEncoder()
    // A body that sends its first events and then never finishes.
    const endless = (events: unknown[]) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(sse(events)))
          },
        }),
      )
    for (const [session, events] of [
      ['s1', [{ type: 'delta' }]],
      ['s2', [{ type: 'quota', used: 1 }]],
    ] as const) {
      await modelRequest(host, session)
      const sent = await httpRequest(host, session)
      const reply = await httpResponse(
        host,
        session,
        sent.request,
        endless([...events]),
      )
      const reader = (reply.response.body as ReadableStream).getReader()
      await reader.read()
      await reader.cancel('user stopped the turn')
    }
    await settle()
    expect(ends.map(({ data, outcome }) => [data, outcome])).toEqual([
      [
        's1/primary#1',
        {
          status: 200,
          outputStarted: true,
          error: { reason: 'cancelled', message: 'user stopped the turn' },
        },
      ],
      [
        's2/primary#2',
        {
          status: 200,
          outputStarted: false,
          error: { reason: 'cancelled', message: 'user stopped the turn' },
        },
      ],
    ])
  })

  test('an event with no attributable attempt reaches no attempt', async () => {
    const { adapter, seen } = trackingAdapter()
    const { host } = await install(adapter, seen)
    // A frame for a session that never chose an account.
    await receive(host, 'ghost', { type: 'quota', used: 1 })
    // A frame after the account was chosen but before any handshake.
    await modelRequest(host, 's1')
    await receive(host, 's1', { type: 'quota', used: 2 })
    // A frame after the attempt ended.
    await handshake(host, 's1')
    await receive(host, 's1', { type: 'done' })
    await receive(host, 's1', { type: 'refused' })
    // A frame after the session's next account was chosen, before its
    // handshake: it can only be a late frame of the earlier exchange.
    await modelRequest(host, 's1')
    await receive(host, 's1', { type: 'delta' })
    // An HTTP response the host hands back on a request object the installer
    // did not produce, once the attempt it could belong to has its response.
    const sent = await httpRequest(host, 's1')
    await httpResponse(host, 's1', sent.request, new Response('ok'))
    await httpResponse(
      host,
      's1',
      new Request('https://provider.invalid/other'),
      new Response('late', { status: 429, headers: { 'x-quota-used': '9' } }),
    )
    // ...and one for a kind that never went out over HTTP.
    await modelRequest(host, 's1', 'title')
    await handshake(host, 's1', 'title')
    await httpResponse(
      host,
      's1',
      new Request('https://provider.invalid/other'),
      new Response('stray', { status: 429 }),
      'title',
    )
    await settle()
    expect(seen).toEqual([
      'select:s1/primary#1',
      'ws-event:s1/primary#1',
      'end:s1/primary#1',
      'select:s1/primary#2',
      'headers:s1/primary#2',
      'select:s1/title#3',
    ])
  })

  test('a response the host hands back on another request object is still attributed while it is the only one outstanding', async () => {
    const { adapter, seen } = trackingAdapter()
    const { host } = await install(adapter)
    await modelRequest(host, 's1')
    await httpRequest(host, 's1')
    await httpResponse(
      host,
      's1',
      new Request('https://provider.invalid/copy'),
      new Response('ok', { status: 401 }),
    )
    await settle()
    expect(seen).toEqual([
      'headers:s1/primary#1',
      'response:s1/primary#1',
      'end:s1/primary#1',
    ])
  })

  test('an error response ends its attempt at once and the retry waits for the end callback', async () => {
    let release: () => void = () => {}
    const order: string[] = []
    const { adapter, ends } = trackingAdapter({
      onAttemptEnd: async (attempt, outcome) => {
        ends.push({ data: attempt.data, outcome })
        await new Promise<void>((resolve) => {
          release = resolve
        })
        order.push('end settled')
      },
    })
    const { host } = await install(adapter)
    await modelRequest(host, 's1')
    const sent = await httpRequest(host, 's1')
    // The body is never read: the status alone ends the attempt.
    await httpResponse(
      host,
      's1',
      sent.request,
      new Response('{"error":"unauthorized"}', { status: 401 }),
    )
    expect(ends).toEqual([
      { data: 's1/primary#1', outcome: { status: 401, outputStarted: false } },
    ])
    const decided = retry(host, 's1').then(() => order.push('retry decided'))
    await settle()
    expect(order).toEqual([])
    release()
    await decided
    expect(order).toEqual(['end settled', 'retry decided'])
  })

  test('a newer attempt, a forgotten session or dispose abandons an open attempt once', async () => {
    const { adapter, ends } = trackingAdapter()
    const { host, installation } = await install(adapter)
    await modelRequest(host, 's1')
    await handshake(host, 's1')
    await receive(host, 's1', { type: 'delta' })
    await modelRequest(host, 's1')
    await handshake(host, 's2')
    installation.forgetSession('s2')
    await modelRequest(host, 's3')
    await installation.dispose()
    await settle()
    expect(
      ends.map(({ data, outcome }) => [
        data,
        outcome.outputStarted,
        outcome.error?.reason,
        outcome.error?.message,
      ]),
    ).toEqual([
      [
        's1/primary#1',
        true,
        'abandoned',
        'a newer attempt of its session and kind began',
      ],
      ['s2/primary#3', false, 'abandoned', 'its session was forgotten'],
      ['s1/primary#2', false, 'abandoned', 'the installation was disposed'],
      ['s3/primary#4', false, 'abandoned', 'the installation was disposed'],
    ])
  })

  test('a failure reported in the stream or by a transport hook ends the attempt as failed', async () => {
    const { adapter, ends } = trackingAdapter()
    const { host } = await install(adapter)
    await modelRequest(host, 's1')
    await handshake(host, 's1')
    await receive(host, 's1', { type: 'failed' })
    const refused = trackingAdapter({
      accountHeaders: ({ accountId }) => ({
        headers: { 'x-account': accountId },
        attempt: 'kept-placeholder',
      }),
    })
    const second = await install(refused.adapter)
    await modelRequest(second.host, 's1')
    await httpRequest(second.host, 's1').catch(() => undefined)
    await settle()
    expect(ends.map(({ outcome }) => outcome.error)).toEqual([
      { reason: 'failed', message: 'response failed' },
    ])
    expect(
      refused.ends.map(({ data, outcome }) => [data, outcome.error?.reason]),
    ).toEqual([['kept-placeholder', 'failed']])
  })

  test('a second send without model.request gets its own attempt', async () => {
    const { adapter, seen } = trackingAdapter()
    const { host } = await install(adapter, seen)
    await modelRequest(host, 's1')
    const first = await httpRequest(host, 's1')
    const second = await httpRequest(host, 's1')
    expect(first.request.headers.get('authorization')).toBe('Bearer tok-A')
    expect(second.request.headers.get('authorization')).toBe('Bearer tok-A')
    expect(seen.filter((entry) => entry.startsWith('select'))).toEqual([
      'select:s1/primary#1',
      'select:s1/primary#2',
    ])
  })

  test('bare header edits leave the attempt value undefined', async () => {
    const host = fakeHost()
    const { adapter } = fakeAdapter()
    const installation = await installOpenCode2Auth(host.ctx, adapter)
    const handles: unknown[] = []
    installation.on('select', (event) => {
      handles.push({ ...event.handle })
    })
    await modelRequest(host, 's1')
    await handshake(host, 's1')
    const sent = await httpRequest(host, 's2')
    expect(sent.request.headers.get('authorization')).toBe('Bearer tok-A')
    const scope = {
      providerID: PROVIDER,
      modelID: 'mock-model',
      agent: 'build',
      kind: 'primary',
      accountId: 'A',
    }
    // The attempt chosen in model.request learns its transport only when
    // the handshake runs; one chosen by http.request knows it at once.
    expect(handles).toStrictEqual([
      {
        ...scope,
        sessionID: 's1',
        attemptId: 'attempt-1',
        transport: undefined,
        data: undefined,
      },
      {
        ...scope,
        sessionID: 's2',
        attemptId: 'attempt-2',
        transport: 'http',
        data: undefined,
      },
    ])
  })

  test('a throwing end callback is logged and never reaches the host', async () => {
    const host = fakeHost()
    const { adapter } = fakeAdapter(undefined, {
      onAttemptEnd: () => {
        throw new Error('callback broke')
      },
    })
    const warnings: string[] = []
    await installOpenCode2Auth(host.ctx, adapter, {
      logger: { warn: (message) => warnings.push(message) },
    })
    await modelRequest(host, 's1')
    const sent = await httpRequest(host, 's1')
    await httpResponse(host, 's1', sent.request, new Response(null))
    await settle()
    expect(warnings).toEqual([
      'opencode2 auth onAttemptEnd threw; the request is unaffected',
    ])
  })
})

describe('installOpenCode2Auth WebSocket frame rewrite', () => {
  test('the send hook is registered only for an adapter that rewrites frames', async () => {
    const host = fakeHost()
    const { adapter } = fakeAdapter(undefined, {
      rewriteWebSocketFrame: ({ frame }) => frame,
    })
    await installOpenCode2Auth(host.ctx, adapter)
    expect(host.hooks.map((hook) => [hook.name, hook.providerID])).toEqual([
      ['model.request', PROVIDER],
      ['http.request', PROVIDER],
      ['http.response', PROVIDER],
      ['experimental.ws.handshake', PROVIDER],
      ['experimental.ws.send', PROVIDER],
      ['experimental.ws.receive', PROVIDER],
      ['retry', PROVIDER],
    ])
  })

  test('every outgoing frame is rewritten, with its attempt when one can be tied to it', async () => {
    const calls: string[] = []
    const { adapter } = trackingAdapter({
      rewriteWebSocketFrame: ({ frame, attempt, sessionID }) => {
        calls.push(`${sessionID}:${attempt?.data ?? 'none'}`)
        const body = JSON.parse(frame) as Record<string, unknown>
        return JSON.stringify({ ...body, marker: 'added' })
      },
    })
    const { host } = await install(adapter)
    const send = (sessionID: string, providerID = PROVIDER) =>
      host.fire('experimental.ws.send', {
        ...scopeFor('primary', sessionID, providerID),
        frame: '{"type":"response.create","previous_response_id":"resp_1"}',
      })
    await modelRequest(host, 's1')
    const beforeHandshake = await send('s1')
    await handshake(host, 's1')
    const live = await send('s1')
    const other = await send('s1', 'otherprov')
    expect(JSON.parse(beforeHandshake.frame)).toEqual({
      type: 'response.create',
      previous_response_id: 'resp_1',
      marker: 'added',
    })
    expect(JSON.parse(live.frame)).toEqual(JSON.parse(beforeHandshake.frame))
    expect(JSON.parse(other.frame)).toEqual({
      type: 'response.create',
      previous_response_id: 'resp_1',
    })
    expect(calls).toEqual(['s1:none', 's1:s1/primary#1'])
  })

  test('a rewrite returning undefined sends the frame unchanged', async () => {
    const host = fakeHost()
    const { adapter } = fakeAdapter(undefined, {
      rewriteWebSocketFrame: () => undefined,
    })
    await installOpenCode2Auth(host.ctx, adapter)
    const sent = await host.fire('experimental.ws.send', {
      ...scopeFor(),
      frame: '{"type":"response.create"}',
    })
    expect(sent.frame).toBe('{"type":"response.create"}')
  })
})
