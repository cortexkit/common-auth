// A Claustrum daemon stand-in speaking the real subc wire protocol, so the
// real `@cortexkit/claustrum-client` can be driven over a socket. Ported from
// anthropic-auth's e2e mock (packages/e2e-tests/src/mock-claustrum.ts) and
// extended with enrollment, configurable inventory rows and failure hooks.
import { createHash } from 'node:crypto'
import { chmod, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'

// Use the real subc transport's framing and handshake on both Node and Bun,
// rather than reimplementing the Claustrum client's wire protocol.
interface SubcWire {
  buildFlags(
    binary: boolean,
    priority: number,
    last: boolean,
    admission?: number,
  ): number
  buildFrame(
    type: number,
    flags: number,
    channel: number,
    epoch: number,
    corr: bigint,
    body: Uint8Array,
  ): unknown
  computeProof(
    key: Uint8Array,
    domain: Uint8Array | string,
    clientNonce: Uint8Array,
    serverNonce: Uint8Array,
    daemonId: Uint8Array,
  ): Uint8Array
  decodeHeader(bytes: Uint8Array): {
    ty: number
    len: number
    channel: number
    epoch: number
    corr: bigint
  }
  encodeFrame(frame: unknown): Uint8Array
  FrameType: {
    Request: number
    Response: number
    StreamData: number
    StreamEnd: number
    Error: number
    Cancel: number
    Goodbye: number
  }
  AdmissionClass: { Sheddable: number }
  HEADER_LEN: number
  PROTOCOL_VERSION: number
  Priority: { Interactive: number }
  SERVER_PROOF_DOMAIN: Uint8Array | string
}

const subc = (await import('@cortexkit/subc-client')) as SubcWire

const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
const daemonId = Uint8Array.from({ length: 16 }, (_, index) => 200 + index)

export interface MockCredential {
  payload: string
  account_id?: string
  /** Non-secret project metadata served only by get_scoped. */
  project_id?: string
  record_version: number
  expires_at_ms: number | null
  state?: string
  type?: 'oauth' | 'api_key'
  /** null removes the field, as for a static key. */
  refresh_adapter?: string | null
  categories?: string[]
  operations?: string[]
  /** Extra or replacement wire fields for the inventory row. */
  wire?: Record<string, unknown>
  /** get_scoped refuses with this code while set. */
  refuse?: string
  /** Served identity when it differs from the listed one; null omits it. */
  served_account_id?: string | null
}

/**
 * How the mock answers a watch (`auth.watch_scoped` or `usage.watch`).
 * `accept` holds it open and sends notice seq 1 at once; `unknown_method`
 * refuses it as a module that predates the method does; `{ refuse }` refuses
 * it with that code before any notice (the vault with a refusal reply,
 * insula with an error frame).
 */
export type MockWatchMode = 'accept' | 'unknown_method' | { refuse: string }

/** One held-open watch the mock accepted. */
export interface MockWatch {
  /** The seq of the last notice sent. */
  seq: number
  epoch: string
  /** Set when the client cancelled it, said goodbye, or disconnected. */
  closed: boolean
  /**
   * Send one notice; a vault notice carries the current view, and insula's
   * names what `fields` give (provider, account). `fields` also replace
   * notice fields such as `seq`; `seq` defaults to the next one.
   */
  notify(fields?: Record<string, unknown>): void
  /** End the stream with STREAM_END, as a module shutting down does. */
  end(): void
  /** End the stream with a refusal reply, as a vault revocation does. */
  refuse(code: string): void
  /**
   * Destroy the connection carrying the watch, as a lost transport does. The
   * mock keeps listening, so the client can connect again.
   */
  drop(): void
}

export interface MockReport {
  credential_id?: string
  enrollment_token?: string
  provider_status?: number
  record_version?: number
  reporter_source?: string
}

export interface MockDaemon {
  connectionFile: string
  credentials: Record<string, MockCredential>
  gets: Array<{ credential_id?: string; enrollment_token?: string }>
  reports: MockReport[]
  proposals: Array<{ name?: string; hash?: string }>
  polls: number
  lists: number
  /**
   * The caller's grants, sent by list_scoped as `grants` (their count) and
   * `grant_tuples`, as claustrum 0.10.0 vaults do. Undefined omits both
   * fields, as an older vault does. Mutable, so a later list can differ.
   */
  grants?: MockGrant[]
  insula?: { response: Wire; refusal?: string; hang?: 'open' | 'usage' }
  usageGets: number
  insulaOpens: number
  /**
   * How `auth.watch_scoped` is answered. Defaults to `unknown_method`, as a
   * vault from before watches existed answers.
   */
  vaultWatch: MockWatchMode
  /** Every watch request received, accepted or not. */
  vaultWatchRequests: number
  /** Accepted watches, oldest first, including closed ones. */
  vaultWatches: MockWatch[]
  /** The epoch new watches carry; change it to model a vault restart. */
  vaultEpoch: string
  /** As the vault fields above, for insula's `usage.watch`. */
  usageWatch: MockWatchMode
  usageWatchRequests: number
  usageWatches: MockWatch[]
  usageEpoch: string
  /** While set, list_scoped refuses with not_found, as for a revoked enrollment. */
  revoked: boolean
  /** Drop scoped calls at the transport, without sending a vault refusal. */
  outage: boolean
  /**
   * How `auth.enroll_propose` is answered. `supported` runs the ceremony.
   * `unknown_method` answers the way every published claustrum vault does,
   * since none has the ceremony yet: the daemon's transport Error frame with
   * no class. `unknown_method-then-unreachable` does the same and then refuses
   * every new connection, so a client that tries to reconnect after the
   * refusal cannot.
   */
  enrollment: 'supported' | 'unknown_method' | 'unknown_method-then-unreachable'
  /**
   * While set, each list_scoped is counted and answered as of its arrival,
   * but the answer is sent only once this settles.
   */
  holdLists?: Promise<unknown>
  /** As with holdLists, delay get_scoped replies after recording the request. */
  holdGets?: Promise<unknown>
  onInsulaClose?: () => void
  onReport?: (report: MockReport) => void
  approve(requestId: string, token?: string, generation?: number): void
  deny(requestId: string): void
  stop(): Promise<void>
}

type Wire = Record<string, unknown>

/** One grant tuple in list_scoped's wire form. */
export interface MockGrant {
  selector_kind: string
  selector: string
  operation: string
}

function error(code: string, errorClass = 'permanent'): Wire {
  return { result: { error: { code, class: errorClass } } }
}

export async function startMockDaemon(input: {
  directory: string
  credentials?: Record<string, MockCredential>
  category?: string
  refreshAdapter?: string
  /** Exact list_scoped wire result, without generated inventory fields. */
  listScopedResult?: Wire
  /**
   * Grants list_scoped reports until a test changes `MockDaemon.grants`;
   * undefined omits the grant fields, as an older vault does.
   */
  grants?: MockGrant[]
  /** Exact get_scoped wire results, without generated payload or identity fields. */
  getScopedResults?: Record<string, Wire>
  /** Optional insula route; response is { result: entries, completeProviders?, pending? }. */
  insula?: { response: Wire; refusal?: string; hang?: 'open' | 'usage' }
}): Promise<MockDaemon> {
  const category = input.category ?? 'test-native'
  const adapter = input.refreshAdapter ?? 'test-provider'
  const sockets = new Set<Socket>()
  const enrollments = new Map<
    string,
    {
      name: string
      hash: string
      status: 'pending' | 'approved' | 'denied' | 'consumed'
      token?: string
      generation?: number
    }
  >()
  let nextRequest = 1
  // Set once an enrollment proposal is refused in the
  // `unknown_method-then-unreachable` mode; new connections are then dropped.
  let unreachable = false

  const state: MockDaemon = {
    connectionFile: '',
    credentials: input.credentials ?? {},
    gets: [],
    reports: [],
    proposals: [],
    polls: 0,
    lists: 0,
    grants: input.grants,
    insula: input.insula,
    usageGets: 0,
    insulaOpens: 0,
    vaultWatch: 'unknown_method',
    vaultWatchRequests: 0,
    vaultWatches: [],
    vaultEpoch: 'vault-epoch-1',
    usageWatch: 'unknown_method',
    usageWatchRequests: 0,
    usageWatches: [],
    usageEpoch: 'insula-epoch-1',
    revoked: false,
    outage: false,
    enrollment: 'supported',
    approve(requestId, token = 'ab'.repeat(32), generation = 1) {
      const entry = enrollments.get(requestId)
      if (!entry) throw new Error(`unknown request ${requestId}`)
      entry.status = 'approved'
      entry.token = token
      entry.generation = generation
    },
    deny(requestId) {
      const entry = enrollments.get(requestId)
      if (entry) entry.status = 'denied'
    },
    stop: async () => {},
  }

  function inventory(): Wire {
    const rows = Object.entries(state.credentials).map(([id, credential]) => {
      const row: Wire = {
        id,
        type: credential.type ?? 'oauth',
        state: credential.state ?? 'active',
        record_version: credential.record_version,
        categories: credential.categories ?? [category],
        serves: ['test-vendor'],
        operations: credential.operations ?? ['read'],
        ...(credential.account_id !== undefined && {
          account_id: credential.account_id,
        }),
        ...(credential.refresh_adapter !== null && {
          refresh_adapter: credential.refresh_adapter ?? adapter,
        }),
        ...credential.wire,
      }
      return row
    })
    // The view covers what the caller can see, never record versions.
    const view = createHash('sha256')
      .update(
        JSON.stringify(
          rows.map(
            ({ id, type, state, categories, operations, account_id }) => [
              id,
              type,
              state,
              categories,
              operations,
              account_id ?? null,
            ],
          ),
        ),
      )
      .digest('hex')
    const grants = state.grants
    return {
      result: {
        credentials: rows,
        view,
        ...(grants && { grants: grants.length, grant_tuples: grants }),
      },
    }
  }

  /** The view digest list_scoped would return now. */
  function currentView(): string {
    const result = inventory().result as { view: string }
    return result.view
  }

  function handle(method: string | undefined, params: Wire): Wire {
    if (method === 'credential.list_scoped') {
      state.lists++
      if (state.revoked) return error('not_found')
      if (input.listScopedResult) return { result: input.listScopedResult }
      return inventory()
    }
    if (method === 'credential.get_scoped') {
      const id = params.credential_id as string | undefined
      state.gets.push({
        credential_id: id,
        enrollment_token: params.enrollment_token as string | undefined,
      })
      const wireResult = id ? input.getScopedResults?.[id] : undefined
      if (wireResult) return { result: wireResult }
      const credential = id ? state.credentials[id] : undefined
      if (!credential) return error('not_found')
      if (credential.refuse) return error(credential.refuse, 'auth_required')
      if ((credential.state ?? 'active') !== 'active')
        return error('needs_reauth', 'auth_required')
      const served =
        credential.served_account_id === null
          ? undefined
          : (credential.served_account_id ?? credential.account_id)
      return {
        result: {
          payload: Array.from(new TextEncoder().encode(credential.payload)),
          credential_id: id,
          ...(served !== undefined && { account_id: served }),
          ...(credential.project_id !== undefined && {
            project_id: credential.project_id,
          }),
          record_version: credential.record_version,
          expires_at_ms: credential.expires_at_ms,
        },
      }
    }
    if (method === 'credential.report_auth_failure') {
      const report: MockReport = {
        credential_id: params.credential_id as string | undefined,
        enrollment_token: params.enrollment_token as string | undefined,
        provider_status: params.provider_status as number | undefined,
        record_version: params.record_version as number | undefined,
        reporter_source: params.reporter_source as string | undefined,
      }
      state.reports.push(report)
      if (report.provider_status !== 401) return error('invalid_params')
      state.onReport?.(report)
      return { result: { accepted: true } }
    }
    if (method === 'auth.enroll_propose') {
      const name = params.proposed_name as string
      const hash = params.request_secret_hash as string
      state.proposals.push({ name, hash })
      for (const [requestId, entry] of enrollments) {
        if (entry.name !== name || entry.status !== 'pending') continue
        // Idempotent on (name, secret); a different secret is another caller.
        if (entry.hash === hash) return { result: { request_id: requestId } }
        return error('pending_exists')
      }
      const requestId = `request-${nextRequest++}`
      enrollments.set(requestId, { name, hash, status: 'pending' })
      return { result: { request_id: requestId } }
    }
    if (method === 'auth.enroll_poll') {
      state.polls++
      const entry = enrollments.get(params.request_id as string)
      if (!entry) return error('not_found')
      const hash = createHash('sha256')
        .update(Buffer.from(String(params.request_secret), 'hex'))
        .digest('hex')
      if (hash !== entry.hash) return error('not_found')
      if (entry.status === 'pending') return { result: { status: 'pending' } }
      if (entry.status === 'denied') return { result: { status: 'denied' } }
      if (entry.status === 'consumed') return error('already_consumed')
      entry.status = 'consumed'
      return {
        result: {
          status: 'approved',
          name: entry.name,
          token: entry.token,
          token_generation: entry.generation,
        },
      }
    }
    return { result: {} }
  }

  const server = createServer((socket) => {
    if (unreachable) {
      socket.destroy()
      return
    }
    let insulaSocket = false
    sockets.add(socket)
    socket.once('close', () => {
      sockets.delete(socket)
      if (insulaSocket) state.onInsulaClose?.()
    })
    socket.on('error', () => {})
    let buffer = Buffer.alloc(0)
    let phase: 'hello' | 'auth' | 'frames' = 'hello'
    const routes = new Map<number, string>()
    // Each route gets its own channel, as subc assigns them: a vault watch
    // rides a second claustrum route beside the one list_scoped uses.
    let nextChannel = 7
    const watches = new Map<string, MockWatch>()
    const closeWatches = (match: (key: string) => boolean) => {
      for (const [key, watch] of watches) {
        if (!match(key)) continue
        watch.closed = true
        watches.delete(key)
      }
    }
    socket.once('close', () => closeWatches(() => true))

    function openWatch(
      header: ReturnType<SubcWire['decodeHeader']>,
      module: 'claustrum' | 'insula',
    ): void {
      const vault = module === 'claustrum'
      if (vault) state.vaultWatchRequests++
      else state.usageWatchRequests++
      const mode = vault ? state.vaultWatch : state.usageWatch
      if (mode === 'unknown_method') {
        writeResponse(
          socket,
          header,
          { code: 'unknown_method', message: 'unknown method' },
          subc.FrameType.Error,
        )
        return
      }
      if (!vault && mode !== 'accept') {
        writeResponse(
          socket,
          header,
          { code: mode.refuse },
          subc.FrameType.Error,
        )
        return
      }
      if (vault && (mode !== 'accept' || state.revoked)) {
        writeResponse(
          socket,
          header,
          error(mode === 'accept' ? 'not_found' : mode.refuse),
        )
        return
      }
      const key = `${header.channel}:${header.corr}`
      const finish = (type: number, body: unknown) => {
        if (watch.closed) return
        watch.closed = true
        watches.delete(key)
        writeResponse(socket, header, body, type, true)
      }
      const watch: MockWatch = {
        seq: 0,
        epoch: vault ? state.vaultEpoch : state.usageEpoch,
        closed: false,
        notify(fields = {}) {
          if (watch.closed) return
          const notice = {
            kind: 'changed',
            epoch: watch.epoch,
            seq: watch.seq + 1,
            ...(vault && { view: currentView(), keys: '' }),
            ...fields,
          }
          watch.seq = notice.seq
          // Notices go out as sheddable StreamData frames, as the vault's
          // watchScoped and insula's usage.watch both send them: a notice is
          // only a hint, so the transport may drop it under load.
          const frame = subc.buildFrame(
            subc.FrameType.StreamData,
            subc.buildFlags(
              false,
              subc.Priority.Interactive,
              false,
              subc.AdmissionClass.Sheddable,
            ),
            header.channel,
            header.epoch,
            header.corr,
            new TextEncoder().encode(JSON.stringify(notice)),
          )
          socket.write(Buffer.from(subc.encodeFrame(frame)))
        },
        end: () => finish(subc.FrameType.StreamEnd, {}),
        refuse: (code) => finish(subc.FrameType.Response, error(code)),
        drop: () => socket.destroy(),
      }
      watches.set(key, watch)
      if (vault) state.vaultWatches.push(watch)
      else state.usageWatches.push(watch)
      watch.notify()
    }

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([
        buffer,
        typeof chunk === 'string' ? Buffer.from(chunk) : chunk,
      ])
      for (;;) {
        if (phase !== 'frames') {
          if (buffer.length < 4) return
          const length = buffer.readUInt32LE(0)
          if (buffer.length < 4 + length) return
          const body = JSON.parse(
            buffer.subarray(4, 4 + length).toString('utf8'),
          ) as Record<string, unknown>
          buffer = buffer.subarray(4 + length)
          if (phase === 'hello') {
            const clientNonce = Uint8Array.from(body.client_nonce as number[])
            const serverNonce = Uint8Array.from(
              { length: 32 },
              (_, index) => 100 + index,
            )
            writeHandshake(socket, {
              daemon_id: Array.from(daemonId),
              server_nonce: Array.from(serverNonce),
              daemon_ver: 'mock-daemon',
              server_proof: Array.from(
                subc.computeProof(
                  key,
                  subc.SERVER_PROOF_DOMAIN,
                  clientNonce,
                  serverNonce,
                  daemonId,
                ),
              ),
            })
            phase = 'auth'
          } else {
            phase = 'frames'
          }
          continue
        }
        if (buffer.length < subc.HEADER_LEN) return
        const header = subc.decodeHeader(buffer.subarray(0, subc.HEADER_LEN))
        if (buffer.length < subc.HEADER_LEN + header.len) return
        const body = buffer.subarray(
          subc.HEADER_LEN,
          subc.HEADER_LEN + header.len,
        )
        buffer = buffer.subarray(subc.HEADER_LEN + header.len)
        if (header.ty === subc.FrameType.Cancel) {
          const key = `${header.channel}:${header.corr}`
          closeWatches((candidate) => candidate === key)
          continue
        }
        if (header.ty === subc.FrameType.Goodbye) {
          routes.delete(header.channel)
          closeWatches((candidate) =>
            candidate.startsWith(`${header.channel}:`),
          )
          continue
        }
        if (header.ty !== subc.FrameType.Request) continue
        const request = JSON.parse(body.toString('utf8')) as {
          method?: string
          op?: string
          params?: Wire
          target?: { module_id?: string }
        }
        if (header.channel === 0) {
          if (request.op === 'route.open') {
            const moduleId = request.target?.module_id ?? 'claustrum'
            if (moduleId === 'insula') {
              insulaSocket = true
              state.insulaOpens++
              if (state.insula?.hang === 'open') continue
              const refusal =
                state.insula?.refusal ??
                (!state.insula ? 'unknown_module' : undefined)
              if (refusal) {
                writeResponse(
                  socket,
                  header,
                  { code: refusal },
                  subc.FrameType.Error,
                )
                continue
              }
            }
            const channel = nextChannel++
            routes.set(channel, moduleId)
            writeResponse(socket, header, {
              route_channel: channel,
              route_epoch: 1,
            })
          } else {
            writeResponse(socket, header, { result: [] })
          }
          continue
        }
        if (!routes.has(header.channel)) {
          writeResponse(
            socket,
            header,
            { code: 'unknown_channel' },
            subc.FrameType.Error,
          )
          continue
        }
        if (state.outage && routes.get(header.channel) === 'claustrum') {
          socket.destroy()
          return
        }
        // subc-client does not yet set the SUBSCRIPTION flag on a subscribe
        // (see its client.js). Both modules know a watch by its method alone,
        // and so does this mock.
        if (
          request.method === 'auth.watch_scoped' &&
          routes.get(header.channel) === 'claustrum'
        ) {
          openWatch(header, 'claustrum')
          continue
        }
        if (
          request.method === 'usage.watch' &&
          routes.get(header.channel) === 'insula'
        ) {
          openWatch(header, 'insula')
          continue
        }
        if (routes.get(header.channel) === 'insula') {
          state.usageGets++
          if (state.insula?.hang === 'usage') continue
          writeResponse(
            socket,
            header,
            state.insula?.response ?? error('module_removed'),
          )
          continue
        }
        if (
          request.method === 'auth.enroll_propose' &&
          state.enrollment !== 'supported'
        ) {
          state.proposals.push({
            name: request.params?.proposed_name as string | undefined,
            hash: request.params?.request_secret_hash as string | undefined,
          })
          if (state.enrollment === 'unknown_method-then-unreachable')
            unreachable = true
          writeResponse(
            socket,
            header,
            {
              code: 'unknown_method',
              message: "unknown method 'auth.enroll_propose'",
            },
            subc.FrameType.Error,
          )
          continue
        }
        const reply = handle(request.method, request.params ?? {})
        const hold =
          request.method === 'credential.list_scoped'
            ? state.holdLists
            : request.method === 'credential.get_scoped'
              ? state.holdGets
              : undefined
        if (hold) void hold.then(() => writeResponse(socket, header, reply))
        else writeResponse(socket, header, reply)
      }
    })
  })
  await listen(server)
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('mock Claustrum daemon has no TCP address')
  state.connectionFile = join(input.directory, 'claustrum-connection.json')
  await writeConnectionFile(state.connectionFile, address.port)
  state.stop = async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  return state
}

function writeHandshake(socket: Socket, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32LE(body.length)
  socket.write(Buffer.concat([prefix, body]))
}

function writeResponse(
  socket: Socket,
  header: ReturnType<SubcWire['decodeHeader']>,
  value: unknown,
  type: number = subc.FrameType.Response,
  last = false,
): void {
  const frame = subc.buildFrame(
    type,
    subc.buildFlags(false, subc.Priority.Interactive, last),
    header.channel,
    header.epoch,
    header.corr,
    new TextEncoder().encode(JSON.stringify(value)),
  )
  socket.write(Buffer.from(subc.encodeFrame(frame)))
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
}

async function writeConnectionFile(path: string, port: number): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      schema: 1,
      wire_version: subc.PROTOCOL_VERSION,
      endpoints: [{ host: '127.0.0.1', port }],
      key: Array.from(key),
      daemon_id: Array.from(daemonId),
      pid: process.pid,
      daemon_ver: 'mock-daemon',
    }),
    { mode: 0o600 },
  )
  await chmod(path, 0o600)
}
