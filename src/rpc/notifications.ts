export interface ApplyRequest {
  command: string
  arguments: string
  sessionId?: string
}
export interface ApplyResult {
  text: string
  knobs: Record<string, unknown>
}
export interface OpenDialogPayload {
  command: string
  text: string
  knobs: Record<string, unknown>
}
export interface RpcNotification {
  id: number
  type: 'open-dialog'
  payload: OpenDialogPayload
  sessionId?: string
}
export interface NotificationScope {
  rpcRoot: string
  directoryPrefix: string
  registrationSessionId: string
  /**
   * Strict session isolation. When true, `pushNotification` and
   * `drainNotifications` refuse an absent or empty session id (throwing
   * `RpcSessionRequiredError`) and a drain returns only that session's own
   * notifications: no notification reaches every session. A strict scope is
   * a separate queue from the same scope without the flag, so a lenient
   * caller cannot push into it or drain it.
   *
   * Off by default: without it, a drain with no session returns every
   * session's notifications and a push with no session reaches every
   * session, which plugins that drain from one process-wide TUI rely on.
   */
  requireSession?: boolean
}

/** A strict notification scope was used without a session id. */
export class RpcSessionRequiredError extends Error {
  readonly operation: 'push' | 'drain'
  constructor(operation: 'push' | 'drain') {
    super(`a ${operation} on a strict notification scope needs a session id`)
    this.name = 'RpcSessionRequiredError'
    this.operation = operation
  }
}

/** True for a session id a strict scope accepts: a non-empty string. */
export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
type Queue = {
  queue: RpcNotification[]
  nextId: number
  lastDrainAtBySession: Map<string, number>
}
const queues = new Map<string, Queue>()
function state(scope: NotificationScope): Queue {
  const key = JSON.stringify([
    scope.rpcRoot,
    scope.directoryPrefix,
    scope.registrationSessionId,
    ...(scope.requireSession === true ? ['strict'] : []),
  ])
  let value = queues.get(key)
  if (!value) {
    value = { queue: [], nextId: 1, lastDrainAtBySession: new Map() }
    queues.set(key, value)
  }
  return value
}

const QUEUE_CAP = 100
const TUI_CONNECTED_WINDOW_MS = 3_000

export function pushNotification(
  scope: NotificationScope,
  payload: OpenDialogPayload,
  sessionId?: string,
): void {
  if (scope.requireSession === true && !isSessionId(sessionId))
    throw new RpcSessionRequiredError('push')
  const value = state(scope)
  value.queue.push({
    id: value.nextId++,
    type: 'open-dialog',
    payload,
    sessionId,
  })
  if (value.queue.length > QUEUE_CAP)
    value.queue = value.queue.slice(-QUEUE_CAP)
}

export function drainNotifications(
  scope: NotificationScope,
  lastReceivedId = 0,
  sessionId?: string,
): RpcNotification[] {
  const strict = scope.requireSession === true
  if (strict && !isSessionId(sessionId))
    throw new RpcSessionRequiredError('drain')
  const value = state(scope)
  const now = Date.now()
  if (sessionId !== undefined) value.lastDrainAtBySession.set(sessionId, now)
  const matches = (n: RpcNotification) =>
    strict
      ? n.sessionId === sessionId
      : sessionId === undefined ||
        n.sessionId === undefined ||
        n.sessionId === sessionId
  if (lastReceivedId > 0) {
    value.queue = value.queue.filter((n) => {
      if (n.id > lastReceivedId) return true
      if (sessionId === undefined) return true
      return n.sessionId !== sessionId
    })
  }
  return value.queue.filter((n) => n.id > lastReceivedId && matches(n))
}

export function isTuiConnected(
  scope: NotificationScope,
  sessionId: string,
): boolean {
  const now = Date.now()
  const at = state(scope).lastDrainAtBySession.get(sessionId) ?? 0
  return at > 0 && now - at < TUI_CONNECTED_WINDOW_MS
}

export function resetNotificationsForTest(scope: NotificationScope): void {
  const value = state(scope)
  value.queue = []
  value.nextId = 1
  value.lastDrainAtBySession.clear()
}
