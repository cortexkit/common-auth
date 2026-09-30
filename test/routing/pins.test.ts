import { describe, expect, test } from 'bun:test'
import {
  isPinValid,
  pendingBytesForPins,
  routeSticky,
} from '../../src/routing/index.js'
import { now, primaryAt } from '../quota/helpers.js'
import { oauth } from './helpers.js'

const valid = new Set(['a', 'b'])

describe('sticky pins', () => {
  test('a pin on a valid row with an unknown identity survives', () => {
    expect(isPinValid({ accountId: 'a' }, valid, 'wire-a')).toBe(true)
    expect(
      isPinValid({ accountId: 'a', wireIdentity: 'wire-a' }, valid, undefined),
    ).toBe(true)
    expect(
      isPinValid({ accountId: 'a', wireIdentity: 'wire-a' }, valid, 'wire-a'),
    ).toBe(true)
  })

  test('a pin whose known identities differ is invalidated', () => {
    expect(
      isPinValid({ accountId: 'a', wireIdentity: 'wire-a' }, valid, 'wire-z'),
    ).toBe(false)
  })

  test('a pin whose row left the valid set is invalidated', () => {
    expect(isPinValid({ accountId: 'gone' }, valid, undefined)).toBe(false)
  })

  test('an invalidated pin is replaced by a new assignment or cleared', () => {
    const rows = [oauth('a', primaryAt(20)), oauth('b', primaryAt(20))]
    const identities = new Map([['a', 'wire-a']])
    const replaced = routeSticky({
      rows,
      now,
      requestBytes: 1,
      identities,
      pin: { accountId: 'a', wireIdentity: 'wire-old' },
    })
    expect(replaced).toMatchObject({
      accountId: 'a',
      source: 'weighted',
      pin: {
        action: 'assign',
        pin: { accountId: 'a', wireIdentity: 'wire-a' },
      },
    })
    const cleared = routeSticky({
      rows: [oauth('a')],
      now,
      requestBytes: 1,
      pin: { accountId: 'gone' },
    })
    expect(cleared).toMatchObject({
      outcome: 'no-admissible-account',
      pin: { action: 'clear' },
    })
    expect(
      routeSticky({ rows: [oauth('a')], now, requestBytes: 1 }).pin,
    ).toEqual({ action: 'none' })
  })

  test('pending bytes count only other sessions pinned on the current projection time', () => {
    const pending = pendingBytesForPins(
      [
        ['s1', { accountId: 'a', inputBytes: 10, quotaCheckedAt: now }],
        ['s2', { accountId: 'a', inputBytes: 5, quotaCheckedAt: now }],
        ['s3', { accountId: 'a', inputBytes: 99, quotaCheckedAt: now - 1 }],
        ['self', { accountId: 'b', inputBytes: 7, quotaCheckedAt: now }],
      ],
      new Map([
        ['a', now],
        ['b', now],
      ]),
      'self',
    )
    expect([...pending]).toEqual([['a', 15]])
  })
})
