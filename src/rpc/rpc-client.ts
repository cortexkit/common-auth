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
  method: string,
  params: Record<string, unknown>,
  timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
): Promise<T | null> {
  const entry = await discoverPortFile(dir, expectedPid, discoverOptions)
  onSelected?.(entry)
  if (!entry) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`http://127.0.0.1:${entry.port}/rpc/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${entry.token}`,
      },
      body: JSON.stringify(params),
      signal: controller.signal,
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
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
