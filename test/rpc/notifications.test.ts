import { beforeEach, describe, expect, test } from 'bun:test'
import type { OpenDialogPayload } from '../../src/rpc/notifications.js'
import {
  drainNotifications,
  isTuiConnected,
  pushNotification,
  resetNotificationsForTest,
} from '../../src/rpc/notifications.js'

const scope = {
  rpcRoot: '/fixture',
  directoryPrefix: 'fixture-',
  registrationSessionId: 'registration',
}
const payload = (command: OpenDialogPayload['command']): OpenDialogPayload => ({
  command,
  text: 'x',
  knobs: {},
})

describe('notifications', () => {
  beforeEach(() => resetNotificationsForTest(scope))

  test('push then drain returns the item once, ordered', () => {
    pushNotification(scope, payload('fixture-quota'), 's1')
    pushNotification(scope, payload('fixture-account'), 's1')
    const first = drainNotifications(scope, 0, 's1')
    expect(first.map((n) => n.payload.command)).toEqual([
      'fixture-quota',
      'fixture-account',
    ])
    expect(first[0]?.id).toBeLessThan(first[1]?.id as number)
    const second = drainNotifications(scope, first[1]?.id as number, 's1')
    expect(second).toEqual([])
  })

  test('session scoping: a session only drains its own + global', () => {
    pushNotification(scope, payload('fixture-quota'), 's1')
    pushNotification(scope, payload('fixture-dump'), 's2')
    expect(
      drainNotifications(scope, 0, 's1').map((n) => n.payload.command),
    ).toEqual(['fixture-quota'])
    expect(
      drainNotifications(scope, 0, 's2').map((n) => n.payload.command),
    ).toEqual(['fixture-dump'])
  })

  test('isTuiConnected reflects a recent drain within the window', () => {
    expect(isTuiConnected(scope, 's1')).toBe(false)
    drainNotifications(scope, 0, 's1')
    expect(isTuiConnected(scope, 's1')).toBe(true)
  })

  test('a drain for one session does not make an unscoped probe connected', () => {
    drainNotifications(scope, 0, 's2')
    expect(isTuiConnected(scope, 's1')).toBe(false)
    expect(isTuiConnected(scope, undefined as never)).toBe(false)
  })

  // @ts-expect-error TUI connectivity must always be scoped to a session.
  isTuiConnected(scope)

  test('queue cap evicts oldest beyond 100', () => {
    for (let i = 0; i < 130; i++)
      pushNotification(scope, payload('fixture-quota'), 's1')
    const all = drainNotifications(scope, 0, 's1')
    expect(all.length).toBe(100)
  })

  test('a global notification reaches every session and is not pruned by one ack', () => {
    // Without a sessionId, the notification can reach every session.
    pushNotification(scope, payload('fixture-quota'))
    const a = drainNotifications(scope, 0, 's1')
    expect(a.length).toBe(1)
    // s1 acknowledges the notification by draining through its ID.
    drainNotifications(scope, a[0]?.id as number, 's1')
    // s2 must still receive the global notification.
    const b = drainNotifications(scope, 0, 's2')
    expect(b.length).toBe(1)
  })
})

test('queue scope includes root, prefix and registration independently', () => {
  const scopes = [
    scope,
    { ...scope, rpcRoot: '/other' },
    { ...scope, directoryPrefix: 'other-' },
    { ...scope, registrationSessionId: 'other' },
  ]
  try {
    scopes.forEach((key, index) => {
      resetNotificationsForTest(key)
      pushNotification(key, payload(String(index)), 'same-wire')
    })
    scopes.forEach((key, index) => {
      expect(
        drainNotifications(key, 0, 'same-wire').map((n) => n.payload.command),
      ).toEqual([String(index)])
    })
  } finally {
    scopes.forEach((key) => {
      resetNotificationsForTest(key)
    })
  }
})
