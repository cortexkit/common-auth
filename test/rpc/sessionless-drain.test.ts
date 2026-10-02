import { afterEach, expect, spyOn, test } from 'bun:test'
import {
  drainNotifications,
  isTuiConnected,
  type NotificationScope,
  type OpenDialogPayload,
  pushNotification,
  resetNotificationsForTest,
} from '../../src/rpc/index.js'

// A plugin whose TUI polls before a route has an active session drains with
// no session id; in broadcast-only mode that drain must never see another
// session's notifications, and "is any TUI connected" must be answerable.
const lenient: NotificationScope = {
  rpcRoot: '/fixture-sessionless',
  directoryPrefix: 'fixture-',
  registrationSessionId: 'registration',
}
const broadcastOnly: NotificationScope = {
  ...lenient,
  sessionlessDrain: 'broadcast-only',
}
const payload = (text: string): OpenDialogPayload => ({
  command: 'fixture-quota',
  text,
  knobs: {},
})
const texts = (scope: NotificationScope, cursor: number, sid?: string) =>
  drainNotifications(scope, cursor, sid).map((n) => n.payload.text)

afterEach(() => {
  resetNotificationsForTest(lenient)
  resetNotificationsForTest(broadcastOnly)
})

function pushThree(scope: NotificationScope) {
  pushNotification(scope, payload('broadcast'))
  pushNotification(scope, payload('session-a'), 'a')
  pushNotification(scope, payload('session-b'), 'b')
}

test('a broadcast-only sessionless drain returns broadcasts and never targeted notifications', () => {
  pushThree(broadcastOnly)
  expect(texts(broadcastOnly, 0)).toEqual(['broadcast'])
  // Session drains keep their meaning: broadcasts plus their own.
  expect(texts(broadcastOnly, 0, 'a')).toEqual(['broadcast', 'session-a'])
  expect(texts(broadcastOnly, 0, 'b')).toEqual(['broadcast', 'session-b'])
})

test('a broadcast-only sessionless ack drops acknowledged broadcasts and keeps targeted ones', () => {
  pushThree(broadcastOnly)
  drainNotifications(broadcastOnly, 3)
  expect(texts(broadcastOnly, 0, 'b')).toEqual(['session-b'])
  expect(texts(broadcastOnly, 0, 'a')).toEqual(['session-a'])
})

test('the default sessionless drain still returns every notification and an ack keeps them all', () => {
  pushThree(lenient)
  expect(texts(lenient, 0)).toEqual(['broadcast', 'session-a', 'session-b'])
  drainNotifications(lenient, 3)
  expect(texts(lenient, 0, 'b')).toEqual(['broadcast', 'session-b'])
  drainNotifications(lenient, 0, 'a')
  expect(isTuiConnected(lenient, undefined)).toBe(false)
})

test('in broadcast-only mode any drain makes the sessionless liveness probe live for 3000 ms', () => {
  const now = spyOn(Date, 'now')
  try {
    now.mockReturnValue(10_000)
    expect(isTuiConnected(broadcastOnly, undefined)).toBe(false)
    drainNotifications(broadcastOnly, 0, 'session-a')
    now.mockReturnValue(12_999)
    expect(isTuiConnected(broadcastOnly, 'session-a')).toBe(true)
    expect(isTuiConnected(broadcastOnly, 'session-b')).toBe(false)
    expect(isTuiConnected(broadcastOnly, undefined)).toBe(true)
    now.mockReturnValue(13_000)
    expect(isTuiConnected(broadcastOnly, 'session-a')).toBe(false)
    expect(isTuiConnected(broadcastOnly, undefined)).toBe(false)
  } finally {
    now.mockRestore()
  }
})

test('in broadcast-only mode a sessionless drain refreshes the sessionless liveness probe', () => {
  drainNotifications(broadcastOnly, 0)
  expect(isTuiConnected(broadcastOnly, undefined)).toBe(true)
  expect(isTuiConnected(broadcastOnly, 'session-a')).toBe(false)
})
