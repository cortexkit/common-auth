import { Agent, request as httpRequest } from 'node:http'
import type {
  ApplyRequest,
  ApplyResult,
  RpcNotification,
} from './notifications.js'
import {
  type DiscoverPortFileOptions,
  discoverPortFile,
  type PortFileEntry,
} from './port-file.js'

export interface RpcClient {
  pending: (
    lastReceivedId: number,
    sessionId?: string,
  ) => Promise<RpcNotification[]>
  apply: (request: ApplyRequest, timeoutMs?: number) => Promise<ApplyResult>
}

export const DEFAULT_RPC_TIMEOUT_MS = 2_000

/**
 * `exactPid`: every call goes only to the expected PID's server. With no
 * such server (or no expected PID) a call returns its fallback without
 * opening a socket, on every call. Off by default, when a call falls back to
 * the newest live server.
 */
export type RpcClientOptions = DiscoverPortFileOptions

async function call<T>(
  dir: string,
  expectedPid: number | undefined,
  discoverOptions: DiscoverPortFileOptions,
  onSelected: ((entry: PortFileEntry | null) => void) | undefined,
  agent: Agent,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
): Promise<T | null> {
  const entry = await discoverPortFile(dir, expectedPid, discoverOptions)
  onSelected?.(entry)
  if (!entry) return null

  // node:http request bypasses HTTP_PROXY/http_proxy for loopback connections
  // under Bun, and an explicit Agent bypasses NODE_USE_ENV_PROXY under Node 24.5+.
  return new Promise<T | null>((resolve) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let settled = false
    const done = (value: T | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    try {
      const body = JSON.stringify(params)
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port: entry.port,
          path: `/rpc/${method}`,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            authorization: `Bearer ${entry.token}`,
          },
          agent,
          signal: controller.signal,
        },
        (res) => {
          const statusCode = res.statusCode ?? 0
          if (statusCode < 200 || statusCode >= 300) {
            res.resume()
            done(null)
            return
          }
          let text = ''
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            text += chunk
          })
          res.on('end', () => {
            try {
              done(JSON.parse(text) as T)
            } catch {
              done(null)
            }
          })
          res.on('error', () => {
            done(null)
          })
          res.on('close', () => {
            if (!res.readableEnded) done(null)
          })
        },
      )

      req.on('error', () => {
        done(null)
      })
      req.on('close', () => {
        done(null)
      })

      req.end(body)
    } catch {
      done(null)
    }
  })
}

/**
 * A client for the server in `dir`, preferring `expectedPid`'s.
 *
 * `onSelected` reports the first selection: it is told which entry (or null)
 * discovery chose, until one call of it returns normally. It is a report, not
 * a gate: an observer that throws rejects that call before any request is
 * sent and is asked again on the next call, but nothing stops a later call
 * once an observer has returned. A caller that must never reach another
 * server passes `{ exactPid: true }`.
 */
export function createRpcClient(
  dir: string,
  expectedPid?: number,
  onSelected?: (entry: PortFileEntry | null) => void,
  options: RpcClientOptions = {},
): RpcClient {
  const discoverOptions: DiscoverPortFileOptions = {
    exactPid: options.exactPid,
  }
  // An explicit Agent ensures requests go direct rather than through
  // proxy settings (e.g. Node 24.5+ NODE_USE_ENV_PROXY on http.globalAgent).
  // keepAlive is disabled so sockets are not pooled or leaked across calls.
  const agent = new Agent({ keepAlive: false })
  let reportedSelection = false
  const reportSelected = (entry: PortFileEntry | null) => {
    if (reportedSelection) return
    onSelected?.(entry)
    // Counted only after the observer returns, so a throwing one is not
    // silently skipped on later calls.
    reportedSelection = true
  }
  return {
    async pending(lastReceivedId, sessionId) {
      const out = await call<{ messages: RpcNotification[] }>(
        dir,
        expectedPid,
        discoverOptions,
        reportSelected,
        agent,
        'pending-notifications',
        { lastReceivedId, sessionId },
      )
      return out?.messages ?? []
    },
    async apply(request, timeoutMs) {
      const out = await call<ApplyResult>(
        dir,
        expectedPid,
        discoverOptions,
        reportSelected,
        agent,
        'apply',
        {
          ...request,
        },
        timeoutMs,
      )
      return out ?? { text: 'apply failed', knobs: {} }
    },
  }
}
