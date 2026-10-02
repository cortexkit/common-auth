import { describe, expect, test } from 'bun:test'
import {
  ATTEMPT_HEADER,
  type AttemptOutcome,
  type ChooseAccountInput,
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
  const base = fakeAdapter<string>().adapter
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

/**
 * `carried` stands for the headers `model.request` left, which the host
 * builds the request from (the attempt mark among them).
 */
const httpRequest = (
  host: ReturnType<typeof fakeHost>,
  sessionID: string,
  kind: Kind = 'primary',
  carried: Record<string, string> = {},
) =>
  host.fire('http.request', {
    ...scopeFor(kind, sessionID),
    request: new Request('https://provider.invalid/v1/responses', {
      method: 'POST',
      headers: { ...carried, authorization: PLACEHOLDER },
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
  carried: Record<string, string> = {},
) =>
  host.fire('experimental.ws.handshake', {
    ...scopeFor(kind, sessionID),
    url: 'wss://provider.invalid/v1/responses',
    headers: { ...carried, authorization: PLACEHOLDER } as Record<
      string,
      string
    >,
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

  test('a response the host hands back on another request object is dropped, even with one attempt outstanding', async () => {
    // Only the request object the installer produced proves which send a
    // response answers: the installer keeps only the newest attempt of each
    // session and kind, so an older send still in flight is invisible to it.
    const { adapter, seen } = trackingAdapter()
    const warned: string[] = []
    const host = fakeHost()
    await installOpenCode2Auth<TestQuota, string>(host.ctx, adapter, {
      logger: { warn: (message) => void warned.push(message) },
    })
    await modelRequest(host, 's1')
    await httpRequest(host, 's1')
    for (let n = 0; n < 2; n++)
      await httpResponse(
        host,
        's1',
        new Request('https://provider.invalid/copy'),
        new Response('ok', { status: 401 }),
      )
    await settle()
    // No adapter callback ran for either response.
    expect(seen).toEqual([])
    // Said once, so a plugin that always copies requests does not flood the log.
    expect(warned).toEqual([
      'opencode2 auth dropped an http.response whose request it did not produce',
    ])
  })

  test('a delayed copied response of an earlier attempt is not attributed to the newer one', async () => {
    const { adapter, seen } = trackingAdapter()
    const { host } = await install(adapter, seen)
    await modelRequest(host, 's1')
    const a = await httpRequest(host, 's1')
    await modelRequest(host, 's1')
    const b = await httpRequest(host, 's1')
    // A's response arrives after B went out, on a copy of A's request.
    await httpResponse(
      host,
      's1',
      new Request(a.request),
      new Response('slow down', {
        status: 429,
        headers: { 'x-quota-used': '100' },
      }),
    )
    await settle()
    expect(seen.filter((entry) => entry.includes('#2'))).toEqual([
      'select:s1/primary#2',
    ])
    // B's own response is still attributed to B.
    const reply = await httpResponse(
      host,
      's1',
      b.request,
      new Response('ok', { headers: { 'x-quota-used': '5' } }),
    )
    await reply.response.text()
    await settle()
    expect(seen.filter((entry) => entry.includes('#2'))).toEqual([
      'select:s1/primary#2',
      'headers:s1/primary#2',
      'quota:s1/primary#2',
      'end:s1/primary#2',
    ])
  })

  test('a late 401 of an older same-account attempt is reported on that attempt, never on the newer credential version', async () => {
    // Both attempts use the same account; the attempt value stands for the
    // credential version each send carried.
    let version = 0
    const { adapter, seen } = trackingAdapter({
      chooseAccount: () => 'acct-x',
      accountHeaders: ({ accountId }) => ({
        headers: { authorization: `Bearer tok-${accountId}-v${++version}` },
        attempt: `${accountId}@v${version}`,
      }),
    })
    const { host } = await install(adapter, seen)
    await modelRequest(host, 's1')
    const old = await httpRequest(host, 's1')
    await modelRequest(host, 's1')
    await httpRequest(host, 's1')
    // The old send's 401 arrives late, once on a copy and once on its own
    // request object.
    await httpResponse(
      host,
      's1',
      new Request(old.request),
      new Response('expired', { status: 401 }),
    )
    await httpResponse(
      host,
      's1',
      old.request,
      new Response('expired', { status: 401 }),
    )
    await settle()
    expect(seen.filter((entry) => entry.includes('@v2'))).toEqual([
      'select:acct-x@v2',
    ])
    expect(
      seen.filter((entry) => /^(headers|response|limit):/.test(entry)),
    ).toEqual(['headers:acct-x@v1', 'response:acct-x@v1'])
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

/** A body that sends `events` and then fails the way a dropped connection does. */
function breakingBody(events: unknown[], message: string) {
  const encoder = new TextEncoder()
  let pulls = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls++ === 0) controller.enqueue(encoder.encode(sse(events)))
      else controller.error(new Error(message))
    },
  })
}

/** `chooseAccount` handing out `accounts` in turn, keeping each input. */
function accountsInTurn(accounts: string[]) {
  const inputs: ChooseAccountInput[] = []
  return {
    inputs,
    chooseAccount(input: ChooseAccountInput) {
      inputs.push({ ...input })
      return accounts.shift()
    },
  }
}

describe('installOpenCode2Auth concurrent attempts of one session and kind', () => {
  test('two in-flight http attempts of one session and kind keep their own account, body, response, error and retry', async () => {
    const turn = accountsInTurn(['A', 'B', 'C'])
    const { adapter, seen, ends } = trackingAdapter({
      chooseAccount: turn.chooseAccount,
      rewriteRequest: ({ request, attempt }) => {
        seen.push(`rewrite:${attempt.data}`)
        return new Request(request, {
          body: JSON.stringify({ account: attempt.accountId }),
        })
      },
      limitFromError: (_error, attempt) => {
        seen.push(`error:${attempt.data}`)
        return { reason: 'reset' }
      },
    })
    const { host, installation } = await install(adapter, seen)
    const accounts: string[] = []
    installation.on('quota', (event) => {
      accounts.push(`quota:${event.accountId}:${event.quota.used}`)
    })
    installation.on('limit', (event) => {
      accounts.push(`limit:${event.accountId}`)
    })
    const retries: Array<[string | undefined, string, unknown]> = []
    installation.on('retry', (event) => {
      retries.push([event.accountId, event.reason, event.decision])
    })

    const a = await modelRequest(host, 's1')
    const b = await modelRequest(host, 's1')
    const sentA = await httpRequest(host, 's1', 'primary', a.headers)
    const sentB = await httpRequest(host, 's1', 'primary', b.headers)
    expect(
      [sentA, sentB].map((sent) => [
        sent.request.headers.get('authorization'),
        sent.request.headers.get('x-account'),
        sent.request.headers.has(ATTEMPT_HEADER),
      ]),
    ).toEqual([
      ['Bearer tok-A', 'A', false],
      ['Bearer tok-B', 'B', false],
    ])
    expect(await sentA.request.text()).toBe('{"account":"A"}')
    expect(await sentB.request.text()).toBe('{"account":"B"}')

    // A answers late, after B went out, and its stream breaks.
    const repliedA = await httpResponse(
      host,
      's1',
      sentA.request,
      new Response(
        breakingBody([{ type: 'quota', used: 91 }], 'connection reset'),
        { headers: { 'x-quota-used': '90' } },
      ),
    )
    await repliedA.response.text().catch(() => undefined)
    // The retry is about A: B is still in flight and keeps going.
    await retry(host, 's1')
    await settle()
    expect(ends.map(({ data }) => data)).toEqual(['s1/primary#1'])

    const repliedB = await httpResponse(
      host,
      's1',
      sentB.request,
      new Response(sse([{ type: 'quota', used: 12 }, { type: 'delta' }]), {
        headers: { 'x-quota-used': '10' },
      }),
    )
    await repliedB.response.text()
    // The host's retry of A starts the next attempt.
    await modelRequest(host, 's1')
    await settle()

    expect(byValue(seen)).toEqual({
      's1/primary#1': [
        'select',
        'rewrite',
        'headers',
        'quota',
        'http-event',
        'quota',
        'end',
        'error',
        'limit',
        'retry',
      ],
      's1/primary#2': [
        'select',
        'rewrite',
        'headers',
        'quota',
        'http-event',
        'quota',
        'http-event',
        'end',
      ],
      's1/primary#3': ['select'],
    })
    expect(accounts).toEqual([
      'quota:A:90',
      'quota:A:91',
      'limit:A',
      'quota:B:10',
      'quota:B:12',
    ])
    expect(retries).toEqual([['A', 'reroute', { retry: true, delay: 0 }]])
    expect(ends.map(({ data, outcome }) => [data, outcome])).toEqual([
      [
        's1/primary#1',
        {
          status: 200,
          outputStarted: false,
          error: { reason: 'failed', message: 'connection reset' },
        },
      ],
      ['s1/primary#2', { status: 200, outputStarted: true }],
    ])
    // The retried attempt is told about A, never about B.
    expect(turn.inputs[2]).toMatchObject({
      previousAccountId: 'A',
      rerouteFrom: { accountId: 'A', limit: { reason: 'reset' } },
    })
    expect(installation.accountFor('s1', 'primary')).toBe('C')
  })

  test('a retry that cannot tell open attempts apart keeps the host decision and touches neither', async () => {
    const turn = accountsInTurn(['A', 'B'])
    const { adapter, seen, ends } = trackingAdapter({
      chooseAccount: turn.chooseAccount,
    })
    const { host, installation } = await install(adapter, seen)
    const retries: unknown[] = []
    installation.on('retry', (event) => {
      retries.push([event.handle?.data, event.reason, event.decision])
    })
    const a = await modelRequest(host, 's1')
    const b = await modelRequest(host, 's1')
    // Sent in the opposite order to their model.request: the mark, not the
    // order, ties each send to its attempt.
    const sentB = await httpRequest(host, 's1', 'primary', b.headers)
    const sentA = await httpRequest(host, 's1', 'primary', a.headers)
    expect(sentA.request.headers.get('authorization')).toBe('Bearer tok-A')
    expect(sentB.request.headers.get('authorization')).toBe('Bearer tok-B')

    await retry(host, 's1')
    await settle()
    expect(ends).toEqual([])
    // Once B fails, the retry is about B; A stays open.
    await httpResponse(
      host,
      's1',
      sentB.request,
      new Response('expired', { status: 401 }),
    )
    await retry(host, 's1')
    const repliedA = await httpResponse(
      host,
      's1',
      sentA.request,
      new Response('ok', { headers: { 'x-quota-used': '7' } }),
    )
    await repliedA.response.text()
    await settle()
    expect(retries).toEqual([
      [undefined, 'host-decides', { retry: true, delay: 100 }],
      ['s1/primary#2', 'host-decides', { retry: true, delay: 100 }],
    ])
    expect(seen.filter((entry) => entry.startsWith('error:'))).toEqual([
      'error:s1/primary#2',
    ])
    expect(ends.map(({ data, outcome }) => [data, outcome.status])).toEqual([
      ['s1/primary#2', 401],
      ['s1/primary#1', 200],
    ])
    expect(seen.filter((entry) => entry.startsWith('quota:'))).toEqual([
      'quota:s1/primary#1',
    ])
  })

  test('websocket attempts of one session and kind stay serial: each handshake binds its own attempt and ends the one before', async () => {
    const turn = accountsInTurn(['A', 'B'])
    const { adapter, seen, ends } = trackingAdapter({
      chooseAccount: turn.chooseAccount,
    })
    const { host } = await install(adapter, seen)
    const a = await modelRequest(host, 's1')
    const b = await modelRequest(host, 's1')
    const shookA = await handshake(host, 's1', 'primary', a.headers)
    await receive(host, 's1', { type: 'quota', used: 30 })
    const shookB = await handshake(host, 's1', 'primary', b.headers)
    await receive(host, 's1', { type: 'quota', used: 40 })
    await receive(host, 's1', { type: 'delta' })
    await receive(host, 's1', { type: 'done' })
    await settle()
    expect([shookA.headers, shookB.headers]).toEqual([
      { authorization: 'Bearer tok-A', 'x-account': 'A' },
      { authorization: 'Bearer tok-B', 'x-account': 'B' },
    ])
    expect(byValue(seen)).toEqual({
      's1/primary#1': ['select', 'ws-event', 'quota', 'end'],
      's1/primary#2': [
        'select',
        'ws-event',
        'quota',
        'ws-event',
        'ws-event',
        'end',
      ],
    })
    expect(ends.map(({ data, outcome }) => [data, outcome])).toEqual([
      [
        's1/primary#1',
        {
          outputStarted: false,
          error: {
            reason: 'abandoned',
            message:
              'a newer attempt of its session and kind went out over WebSocket',
          },
        },
      ],
      ['s1/primary#2', { outputStarted: true }],
    ])
  })

  test('a send without its mark among several waiting attempts goes to the newest, with one warning', async () => {
    const turn = accountsInTurn(['A', 'B', 'C'])
    const { adapter } = trackingAdapter({ chooseAccount: turn.chooseAccount })
    const host = fakeHost()
    const warned: string[] = []
    await installOpenCode2Auth<TestQuota, string>(host.ctx, adapter, {
      logger: { warn: (message) => void warned.push(message) },
    })
    await modelRequest(host, 's1')
    await modelRequest(host, 's1')
    const first = await httpRequest(host, 's1')
    await modelRequest(host, 's1')
    await httpRequest(host, 's1')
    expect(first.request.headers.get('authorization')).toBe('Bearer tok-B')
    expect(warned).toEqual([
      'opencode2 auth tied a send without its attempt mark to the newest of several waiting attempts',
    ])
  })

  test('a mark naming an attempt of another session or kind is ignored', async () => {
    const turn = accountsInTurn(['A', 'B'])
    const { adapter, seen } = trackingAdapter({
      chooseAccount: turn.chooseAccount,
    })
    const { host } = await install(adapter, seen)
    const s1 = await modelRequest(host, 's1')
    const stray = await httpRequest(host, 's2', 'primary', s1.headers)
    expect(stray.request.headers.get('authorization')).toBe('Bearer tok-B')
    const own = await httpRequest(host, 's1', 'primary', s1.headers)
    expect(own.request.headers.get('authorization')).toBe('Bearer tok-A')
    expect(seen).toEqual(['select:s1/primary#1', 'select:s2/primary#2'])
  })

  test('an attempt the retry hook judged while open is abandoned by the next attempt', async () => {
    const { adapter, ends } = trackingAdapter()
    const { host } = await install(adapter)
    const first = await modelRequest(host, 's1')
    // Sent, but no response ever comes (the connection failed).
    await httpRequest(host, 's1', 'primary', first.headers)
    await retry(host, 's1')
    await settle()
    expect(ends).toEqual([])
    await modelRequest(host, 's1')
    await settle()
    expect(
      ends.map(({ data, outcome }) => [data, outcome.error?.message]),
    ).toEqual([
      ['s1/primary#1', 'a newer attempt of its session and kind began'],
    ])
  })
})

describe('installOpenCode2Auth answeredBy', () => {
  test('a response another account answered is attributed to that account only, once', async () => {
    const turn = accountsInTurn(['A', 'C'])
    const { adapter, seen, ends } = trackingAdapter({
      chooseAccount: turn.chooseAccount,
      // The adapter's own sender moved the request on to another account
      // and says which in a response header.
      answeredBy: ({ response, attempt }) => {
        seen.push(`answered:${attempt.data}`)
        const by = response.headers.get('x-answered-by')
        return by === null
          ? undefined
          : { accountId: by, data: `${attempt.data}->${by}` }
      },
    })
    const { host, installation } = await install(adapter, seen)
    const accounts: string[] = []
    installation.on('quota', (event) => {
      accounts.push(`quota:${event.accountId}:${event.quota.used}`)
    })
    installation.on('limit', (event) => {
      accounts.push(`limit:${event.accountId}`)
    })
    installation.on('retry', (event) => {
      accounts.push(`retry:${event.accountId}:${event.reason}`)
    })
    const first = await modelRequest(host, 's1')
    const sent = await httpRequest(host, 's1', 'primary', first.headers)
    await httpResponse(
      host,
      's1',
      sent.request,
      new Response('slow down', {
        status: 429,
        headers: { 'x-answered-by': 'B', 'x-quota-used': '70' },
      }),
    )
    await retry(host, 's1')
    const second = await modelRequest(host, 's1')
    const resent = await httpRequest(host, 's1', 'primary', second.headers)
    const served = await httpResponse(
      host,
      's1',
      resent.request,
      new Response('ok', { headers: { 'x-quota-used': '5' } }),
    )
    await served.response.text()
    await settle()

    expect(accounts).toEqual([
      'quota:B:70',
      'limit:B',
      'retry:B:reroute',
      'quota:C:5',
    ])
    expect(seen).toEqual([
      'select:s1/primary#1',
      'answered:s1/primary#1',
      'headers:s1/primary#1->B',
      'quota:s1/primary#1->B',
      'response:s1/primary#1->B',
      'limit:s1/primary#1->B',
      'end:s1/primary#1->B',
      'retry:s1/primary#1->B',
      'select:s1/primary#2',
      'answered:s1/primary#2',
      'headers:s1/primary#2',
      'quota:s1/primary#2',
      'end:s1/primary#2',
    ])
    expect(
      ends.map(({ data, outcome }) => [data, outcome.status, outcome.limit]),
    ).toEqual([
      ['s1/primary#1->B', 429, { reason: 'too-many', status: 429 }],
      ['s1/primary#2', 200, undefined],
    ])
    expect(turn.inputs[1]).toMatchObject({
      previousAccountId: 'B',
      rerouteFrom: { accountId: 'B' },
    })
  })

  test('the rebound attempt names the chosen account it moved from', async () => {
    const handles: Array<Record<string, unknown>> = []
    const { adapter } = trackingAdapter({
      answeredBy: () => ({ accountId: 'B' }),
      onAttemptEnd: (attempt) => {
        handles.push({ ...attempt })
      },
    })
    const { host, installation } = await install(adapter)
    const model = await modelRequest(host, 's1')
    const sent = await httpRequest(host, 's1', 'primary', model.headers)
    await httpResponse(host, 's1', sent.request, new Response(null))
    await settle()
    // Without `data` in the answer the attempt keeps its own value.
    expect(handles).toMatchObject([
      { accountId: 'B', reboundFrom: 'A', data: 's1/primary#1' },
    ])
    expect(installation.accountFor('s1', 'primary')).toBe('B')
  })

  test('a throwing answeredBy ends the attempt as failed and attributes nothing', async () => {
    const { adapter, seen, ends } = trackingAdapter({
      answeredBy: () => {
        throw new Error('bridge state lost')
      },
    })
    const { host } = await install(adapter, seen)
    const model = await modelRequest(host, 's1')
    const sent = await httpRequest(host, 's1', 'primary', model.headers)
    const thrown = await httpResponse(
      host,
      's1',
      sent.request,
      new Response('slow down', {
        status: 429,
        headers: { 'x-quota-used': '9' },
      }),
    ).catch((error: Error) => error.message)
    await settle()
    expect(thrown).toBe('bridge state lost')
    expect(seen).toEqual(['select:s1/primary#1', 'end:s1/primary#1'])
    expect(ends.map(({ outcome }) => outcome)).toEqual([
      {
        outputStarted: false,
        error: { reason: 'failed', message: 'bridge state lost' },
      },
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
