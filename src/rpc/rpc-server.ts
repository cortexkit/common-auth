import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { join } from 'node:path'
import type { RpcLogChannel } from './index.js'
import {
  type ApplyRequest,
  type ApplyResult,
  isSessionId,
  type RpcNotification,
} from './notifications.js'
import { sweepRpcState, writePortFile } from './port-file.js'

export interface RpcServerHandle {
  port: number
  token: string
  stop: () => Promise<void>
}

export interface RpcServerOptions {
  dir: string
  log?: RpcLogChannel
  isManagedDir: (name: string) => boolean
  secureDir?: boolean
  sweepRoot?: string
  drain: (lastReceivedId: number, sessionId?: string) => RpcNotification[]
  apply: (request: ApplyRequest) => Promise<ApplyResult>
  /**
   * Refuse a `pending-notifications` drain whose `sessionId` is absent, not a
   * string or empty, with 400 and without calling `drain`. Pair it with a
   * strict notification scope (`requireSession`) so neither the wire nor
   * the queue can hand one session's notifications to another. Off by
   * default, when a session-less drain is passed to `drain` as undefined.
   */
  requireSession?: boolean
  // Bounds handler execution via the socket inactivity timer.
  timeoutMs?: number
  // Bounds request delivery only (requestTimeout/headersTimeout).
  receiptTimeoutMs?: number
  /**
   * Answer an `apply` call whose handler is still running after this many
   * milliseconds with 504 `{error: 'handler deadline exceeded'}`. The handler
   * is not cancelled; its eventual result is discarded. Unset by default,
   * when only the socket inactivity timeout (`timeoutMs`) bounds a handler,
   * by destroying the socket.
   */
  applyDeadlineMs?: number
}

/**
 * Thrown by an `apply` or `drain` handler to refuse a request with a 4xx
 * status. Its message is sent on the wire as `{error: message}`, so it must
 * be written for the client and never quote a credential. Any other error a
 * handler throws answers 500 with a fixed code.
 */
export class RpcRequestError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    if (!Number.isInteger(status) || status < 400 || status > 499)
      throw new RangeError(`RpcRequestError status must be 4xx, got ${status}`)
    super(message)
    this.name = 'RpcRequestError'
    this.status = status
  }
}

const MAX_BODY_BYTES = 1_000_000

/** The request body exceeded the cap; answered 413. */
class BodyTooLargeError extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const tooLarge = () => {
      // Keep reading and discarding the rest, so the client finishes sending
      // and can read the 413 instead of seeing a reset connection.
      req.removeAllListeners('data')
      req.on('data', () => {})
      req.resume()
      reject(new BodyTooLargeError('body too large'))
    }
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      tooLarge()
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        tooLarge()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

class ApplyDeadlineError extends Error {}

/** Settle with `work`, or reject at `ms` while `work` keeps running. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ApplyDeadlineError('apply deadline exceeded')),
      ms,
    )
  })
  // A handler that fails after its deadline has nobody left to answer.
  work.catch(() => {})
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}

function tokenOk(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false
  const got = Buffer.from(header.slice(7))
  const want = Buffer.from(token)
  return got.length === want.length && timingSafeEqual(got, want)
}

export async function startRpcServer(
  options: RpcServerOptions,
): Promise<RpcServerHandle> {
  const log = options.log ?? { warn() {}, debug() {} }
  const token = randomBytes(32).toString('hex')
  // The receipt timeout limits request delivery, not handler execution.
  // The socket inactivity timeout must also allow slow handlers to finish.
  const handlerTimeoutMs = options.timeoutMs ?? 90_000
  const receiptTimeoutMs = options.receiptTimeoutMs ?? 2_000
  let warnedMissingNotificationSession = false
  const server = createServer((req, res) => {
    req.setTimeout(handlerTimeoutMs, () => {
      req.socket.destroy()
    })
    void dispatch(req, res)
  })
  server.requestTimeout = receiptTimeoutMs
  server.headersTimeout = receiptTimeoutMs

  async function dispatch(req: IncomingMessage, res: ServerResponse) {
    const json = (
      status: number,
      value: unknown,
      headers: Record<string, string> = {},
    ) => {
      // Guard against writing to a socket that is already gone (the
      // inactivity timeout destroys it).
      if (res.headersSent || res.writableEnded || res.destroyed) return
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(JSON.stringify(value))
    }
    try {
      // Route on the pathname alone, so a query string does not turn a known
      // method into a 404.
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      if (req.method === 'GET' && path === '/health')
        return json(200, { ok: true })
      if (req.method !== 'POST' || !path.startsWith('/rpc/'))
        return json(404, { error: 'not found' })
      if (!tokenOk(req.headers.authorization, token))
        return json(401, { error: 'unauthorized' })
      const method = path.slice('/rpc/'.length)
      let body: string
      try {
        body = await readBody(req)
      } catch (error) {
        if (!(error instanceof BodyTooLargeError)) throw error
        // Close the connection after answering: the rest of the oversized
        // body is not worth keeping the socket for.
        return json(413, { error: 'body too large' }, { connection: 'close' })
      }
      let params: Record<string, unknown>
      try {
        params = JSON.parse(body || '{}') as Record<string, unknown>
      } catch {
        return json(400, { error: 'invalid json' })
      }
      if (method === 'pending-notifications') {
        if (options.requireSession === true && !isSessionId(params.sessionId))
          return json(400, { error: 'session required' })
        const sessionId =
          typeof params.sessionId === 'string' ? params.sessionId : undefined
        if (sessionId === undefined && !warnedMissingNotificationSession) {
          warnedMissingNotificationSession = true
          log.warn('rpc notification drain missing session id', {
            pid: process.pid,
          })
        }
        const messages = options.drain(
          Number(params.lastReceivedId ?? 0),
          sessionId,
        )
        return json(200, { messages })
      }
      if (method === 'apply') {
        const work = Promise.resolve(
          options.apply(params as unknown as ApplyRequest),
        )
        const result =
          options.applyDeadlineMs === undefined
            ? await work
            : await withDeadline(work, options.applyDeadlineMs)
        return json(200, result)
      }
      return json(404, { error: 'unknown method' })
    } catch (error) {
      if (error instanceof RpcRequestError) {
        log.debug('rpc request refused', {
          pid: process.pid,
          status: error.status,
        })
        return json(error.status, { error: error.message })
      }
      if (error instanceof ApplyDeadlineError) {
        log.warn('rpc apply deadline exceeded', {
          pid: process.pid,
          deadlineMs: options.applyDeadlineMs,
        })
        return json(504, { error: 'handler deadline exceeded' })
      }
      // A handler's exception can quote a request or a credential, so its
      // text goes to the plugin's log channel only; the wire gets a fixed code.
      log.warn('rpc request failed', {
        pid: process.pid,
        error: error instanceof Error ? error.message : String(error),
      })
      json(500, { error: 'internal error' })
    }
  }

  const port = await new Promise<number>((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') resolve(addr.port)
      else reject(new Error('no port'))
    })
  })
  server.unref()
  if (options.sweepRoot) {
    try {
      await sweepRpcState(
        options.sweepRoot,
        options.dir,
        options.isManagedDir,
        log,
      )
    } catch (error) {
      log.warn('rpc state sweep failed', {
        pid: process.pid,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  try {
    await writePortFile(
      options.dir,
      { port, token, pid: process.pid },
      { secureDir: options.secureDir },
    )
    log.debug('rpc server pid', {
      pid: process.pid,
      rpcPort: port,
    })
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw error
  }

  return {
    port,
    token,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      const portFile = join(options.dir, `port-${process.pid}.json`)
      const current = await readFile(portFile, 'utf8')
        .then((raw) => JSON.parse(raw) as { port?: unknown; token?: unknown })
        .catch(() => undefined)
      if (current?.port === port && current.token === token)
        await unlink(portFile).catch(() => {})
    },
  }
}
