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
  const value = state(scope)
  const now = Date.now()
  if (sessionId !== undefined) value.lastDrainAtBySession.set(sessionId, now)
  const matches = (n: RpcNotification) =>
    sessionId === undefined ||
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
