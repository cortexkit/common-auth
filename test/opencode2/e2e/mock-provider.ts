// A loopback stand-in for a Responses-style model provider with two accounts,
// speaking just enough HTTP SSE and WebSocket for one OpenCode 2 turn. It
// records which account each request arrived under, so the placement test can
// check what really reached the wire.

export const ACCOUNTS = {
  A: { token: 'tok-A', id: 'acct-A', used: 11 },
  B: { token: 'tok-B', id: 'acct-B', used: 55 },
} as const

export type AccountName = keyof typeof ACCOUNTS
export type Identity = AccountName | 'none'

/** How the next agent-loop request of an account is refused. */
export type RejectMode =
  | 'rate-limit'
  | 'usage-limit'
  | 'after-output'
  | 'unauthorized'

/** The header the test plugin uses to put each attempt's value on the wire. */
export const RECEIPT_HEADER = 'x-mock-receipt'
/** The field the test plugin's frame rewrite adds to every frame. */
export const MARKER_FIELD = 'common_auth_marker'

export interface WireRecord {
  readonly transport: 'http' | 'ws'
  readonly action: 'request' | 'handshake' | 'frame'
  readonly connection?: number
  readonly kind?: 'primary' | 'title'
  readonly identity: Identity
  /** Any header carried a value the host should never send. */
  readonly forbiddenSeen: boolean
  readonly previousResponseID?: string
  readonly rejected?: RejectMode
  /** The `RECEIPT_HEADER` the request or handshake carried. */
  readonly receipt?: string
  /** A frame's `MARKER_FIELD`, if it had one. */
  readonly marker?: unknown
  /** How many `input` items a frame carried. */
  readonly inputItems?: number
  /** The id of the response the mock sent back for a frame. */
  readonly responseID?: string
}

function identify(headers: Headers): Identity {
  const token = /^Bearer (.+)$/i.exec(headers.get('authorization') ?? '')?.[1]
  const account = headers.get('x-mock-account')
  for (const [name, entry] of Object.entries(ACCOUNTS)) {
    if (token === entry.token && account === entry.id)
      return name as AccountName
  }
  return 'none'
}

function responseEvents(text: string, id: string, partial = false) {
  const itemID = `msg_${id}`
  const response = (status: string, output: unknown[]) => ({
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: 'mock-model',
    output,
    usage:
      status === 'completed'
        ? {
            input_tokens: 11,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 3,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 14,
          }
        : null,
  })
  const done = {
    id: itemID,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
  const events = [
    {
      type: 'response.created',
      sequence_number: 0,
      response: response('in_progress', []),
    },
    {
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: {
        id: itemID,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    },
    {
      type: 'response.content_part.added',
      sequence_number: 2,
      item_id: itemID,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    },
    {
      type: 'response.output_text.delta',
      sequence_number: 3,
      item_id: itemID,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: 'response.output_text.done',
      sequence_number: 4,
      item_id: itemID,
      output_index: 0,
      content_index: 0,
      text,
    },
    {
      type: 'response.content_part.done',
      sequence_number: 5,
      item_id: itemID,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text, annotations: [] },
    },
    {
      type: 'response.output_item.done',
      sequence_number: 6,
      output_index: 0,
      item: done,
    },
    {
      type: 'response.completed',
      sequence_number: 7,
      response: response('completed', [done]),
    },
  ]
  return partial ? events.slice(0, 4) : events
}

const RATE_LIMIT = {
  code: 'rate_limit_exceeded',
  type: 'rate_limit_exceeded',
  message: 'Rate limit reached for this account.',
}
const USAGE_LIMIT = {
  type: 'usage_limit_reached',
  message: 'The usage limit has been reached',
}

function failed(id: string) {
  return {
    type: 'response.failed',
    sequence_number: 9,
    response: {
      id,
      object: 'response',
      status: 'failed',
      model: 'mock-model',
      output: [],
      error: RATE_LIMIT,
      usage: null,
    },
  }
}

const toSSE = (events: unknown[]) =>
  events
    .map(
      (event) =>
        `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join('')

/** The in-band quota frame, sent before each WebSocket response. */
const quotaFrame = (account: Identity) => ({
  type: 'mock.rate_limits',
  used_percent: account === 'none' ? 0 : ACCOUNTS[account].used,
})

const quotaHeaders = (account: Identity): Record<string, string> =>
  account === 'none'
    ? {}
    : { 'x-mock-used-percent': String(ACCOUNTS[account].used) }

export interface MockProvider {
  readonly url: string
  readonly records: WireRecord[]
  /** Refuses the next agent-loop request of `account` once. */
  reject(account: AccountName, mode: RejectMode): void
  stop(): Promise<void>
}

export function startMockProvider(forbidden: readonly string[]): MockProvider {
  const records: WireRecord[] = []
  const rejects: Array<{ account: AccountName; mode: RejectMode }> = []
  let requests = 0
  let connections = 0
  const carriesForbidden = (headers: Headers) =>
    [...headers.values()].some((value) =>
      forbidden.some((secret) => value.includes(secret)),
    )
  const takeReject = (identity: Identity) => {
    const index = rejects.findIndex((entry) => entry.account === identity)
    if (index < 0) return undefined
    return rejects.splice(index, 1)[0]?.mode
  }
  type Socket = { connection: number; identity: Identity }
  const receiptOf = (headers: Headers) => {
    const receipt = headers.get(RECEIPT_HEADER)
    return receipt === null ? {} : { receipt }
  }

  const server = Bun.serve<Socket>({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request, server) {
      const identity = identify(request.headers)
      const forbiddenSeen = carriesForbidden(request.headers)
      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const connection = ++connections
        records.push({
          transport: 'ws',
          action: 'handshake',
          connection,
          identity,
          forbiddenSeen,
          ...receiptOf(request.headers),
        })
        if (server.upgrade(request, { data: { connection, identity } }))
          return undefined
        return new Response('upgrade failed', { status: 400 })
      }
      const body = await request.text()
      if (
        request.method !== 'POST' ||
        !/\/responses$/.test(new URL(request.url).pathname)
      ) {
        return Response.json(
          { error: { message: 'mock: no route' } },
          { status: 404 },
        )
      }
      const index = ++requests
      // Only agent-loop requests carry tool definitions; title requests do not.
      const kind = /"tools"\s*:/.test(body) ? 'primary' : 'title'
      const rejected = kind === 'primary' ? takeReject(identity) : undefined
      records.push({
        transport: 'http',
        action: 'request',
        kind,
        identity,
        forbiddenSeen,
        ...(rejected ? { rejected } : {}),
        ...receiptOf(request.headers),
      })
      if (rejected === 'unauthorized') {
        return Response.json(
          { error: { type: 'invalid_api_key', message: 'Unauthorized' } },
          { status: 401 },
        )
      }
      if (rejected === 'rate-limit' || rejected === 'usage-limit') {
        return Response.json(
          { error: rejected === 'rate-limit' ? RATE_LIMIT : USAGE_LIMIT },
          {
            status: 429,
            headers: {
              'retry-after': '30',
              ...quotaHeaders(identity),
              'x-mock-used-percent': '100',
            },
          },
        )
      }
      const id = `resp_http_${index}`
      const events =
        rejected === 'after-output'
          ? [
              ...responseEvents(`PARTIAL-FROM-${identity} `, id, true),
              failed(id),
            ]
          : responseEvents(`MOCK-HTTP-REPLY-${index}-${identity}`, id)
      return new Response(toSSE(events), {
        headers: {
          'content-type': 'text/event-stream',
          ...quotaHeaders(identity),
        },
      })
    },
    websocket: {
      message(socket, message) {
        const { connection, identity } = socket.data
        const index = ++requests
        let frame: Record<string, unknown> & {
          previous_response_id?: string
          input?: unknown
        } = {}
        try {
          frame = JSON.parse(String(message))
        } catch {}
        const rejected = takeReject(identity)
        const id = `resp_ws_c${connection}_${index}`
        records.push({
          transport: 'ws',
          action: 'frame',
          connection,
          kind: 'primary',
          identity,
          forbiddenSeen: false,
          ...(frame.previous_response_id
            ? { previousResponseID: frame.previous_response_id }
            : {}),
          ...(rejected ? { rejected } : {}),
          ...(MARKER_FIELD in frame ? { marker: frame[MARKER_FIELD] } : {}),
          ...(Array.isArray(frame.input)
            ? { inputItems: frame.input.length }
            : {}),
          responseID: id,
        })
        const send = (event: unknown) => socket.send(JSON.stringify(event))
        send(quotaFrame(identity))
        if (rejected === 'rate-limit') {
          send(responseEvents('', id)[0])
          send(failed(id))
          return
        }
        if (rejected === 'usage-limit') {
          send({ type: 'error', status: 429, error: USAGE_LIMIT })
          return
        }
        if (rejected === 'after-output') {
          for (const event of responseEvents(
            `PARTIAL-FROM-${identity} `,
            id,
            true,
          ))
            send(event)
          send(failed(id))
          return
        }
        for (const event of responseEvents(
          `MOCK-WS-REPLY-${index}-${identity}`,
          id,
        ))
          send(event)
      },
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    records,
    reject(account, mode) {
      rejects.push({ account, mode })
    },
    async stop() {
      await server.stop(true)
    },
  }
}
