import { describe, expect, test } from 'bun:test'
import {
  nextOrderedAttempt,
  orderForPlacement,
  resolveRoutingMode,
  routeOrdered,
} from '../../src/routing/index.js'
import { now, primaryAt } from '../quota/helpers.js'
import { apiKey, oauth } from './helpers.js'

const roster = ['main', 'a', 'b']

function aliasOrder(mode: unknown, formerMainId?: string) {
  const resolved = resolveRoutingMode(mode)
  expect(resolved.mode).toBe('ordered')
  return orderForPlacement(roster, resolved.placement, formerMainId)
}

describe('routing mode aliases', () => {
  test('fallback-first places the former main row last', () => {
    expect(aliasOrder('fallback-first')).toEqual(['a', 'b', 'main'])
  })

  test('main-first places the former main row first', () => {
    expect(aliasOrder('main-first')).toEqual(['main', 'a', 'b'])
  })

  test('formerMainId names the row the aliases move', () => {
    expect(aliasOrder('fallback-first', 'a')).toEqual(['main', 'b', 'a'])
    expect(aliasOrder('main-first', 'a')).toEqual(['a', 'main', 'b'])
    expect(aliasOrder('main-first', 'missing')).toEqual(roster)
  })

  test('an absent or unrecognised mode resolves to ordered in roster order', () => {
    expect(aliasOrder(undefined)).toEqual(['main', 'a', 'b'])
    expect(aliasOrder('garbage')).toEqual(['main', 'a', 'b'])
    expect(aliasOrder('ordered')).toEqual(['main', 'a', 'b'])
    expect(resolveRoutingMode('sticky-balanced')).toEqual({
      mode: 'sticky-balanced',
      placement: 'roster',
    })
  })

  test('resolving a persisted routing mode leaves the persisted value unchanged', () => {
    const persisted = Object.freeze({ mode: 'garbage' })
    resolveRoutingMode(persisted.mode)
    expect(persisted).toEqual({ mode: 'garbage' })
    const ids = Object.freeze([...roster])
    orderForPlacement(ids, 'fallback-first')
    expect(ids).toEqual(roster)
  })
})

describe('routeOrdered', () => {
  const healthy = () => primaryAt(20)

  test('ordered honours roster order with reactive retry on the configured statuses', () => {
    const { order } = routeOrdered({
      rows: [oauth('main', healthy()), oauth('a', healthy()), apiKey('b')],
      now,
    })
    expect(order).toEqual(['main', 'a', 'b'])
    const retry = [429, 503]
    expect(nextOrderedAttempt(order, [], retry)).toBe('main')
    expect(
      nextOrderedAttempt(order, [{ id: 'main', status: 429 }], retry),
    ).toBe('a')
    expect(
      nextOrderedAttempt(
        order,
        [
          { id: 'main', status: 429 },
          { id: 'a', status: 503 },
        ],
        retry,
      ),
    ).toBe('b')
    expect(
      nextOrderedAttempt(
        order,
        [
          { id: 'main', status: 429 },
          { id: 'a', status: 503 },
          { id: 'b', status: 429 },
        ],
        retry,
      ),
    ).toBeUndefined()
  })

  test('ordered stops on a status outside the configured retry set', () => {
    const order = ['main', 'a']
    expect(
      nextOrderedAttempt(order, [{ id: 'main', status: 500 }], [429]),
    ).toBeUndefined()
    expect(nextOrderedAttempt(order, [{ id: 'main' }], [429])).toBeUndefined()
    expect(
      nextOrderedAttempt(order, [{ id: 'main', status: 500 }], [500]),
    ).toBe('a')
  })

  test('ordered applies the placement to admitted rows', () => {
    const { order } = routeOrdered({
      rows: [oauth('main', healthy()), oauth('a', healthy()), apiKey('b')],
      now,
      placement: 'fallback-first',
    })
    expect(order).toEqual(['a', 'b', 'main'])
  })

  test('ordered refuses an exhausted row', () => {
    const route = routeOrdered({
      rows: [oauth('main', primaryAt(100)), oauth('a', healthy())],
      now,
    })
    expect(route.order).toEqual(['a'])
    expect(route.admission.refused).toMatchObject([
      { id: 'main', reason: 'exhausted' },
    ])
  })

  test('ordered dispatches the api-key row in a mixed pool', () => {
    expect(
      routeOrdered({ rows: [oauth('main'), apiKey('key')], now }).order,
    ).toEqual(['key'])
  })

  test('a fresh healthy reading is dispatched end-to-end in ordered mode', () => {
    const { order } = routeOrdered({ rows: [oauth('main', healthy())], now })
    expect(nextOrderedAttempt(order, [], [429])).toBe('main')
  })

  test('ordered excludes a rate-limited row until its mark expires, then readmits it in its roster position', () => {
    const rows = [oauth('main', healthy()), oauth('a', healthy()), apiKey('b')]
    const rateLimitMarks = new Map([['a', now + 1000]])
    expect(routeOrdered({ rows, now, rateLimitMarks }).order).toEqual([
      'main',
      'b',
    ])
    expect(
      routeOrdered({ rows, now: now + 1000, rateLimitMarks }).order,
    ).toEqual(['main', 'a', 'b'])
  })

  test('ordered excludes a backed-off row until its retry time', () => {
    const rows = [oauth('main', healthy()), apiKey('b')]
    const refreshBackoff = new Map([['main', now + 1000]])
    expect(routeOrdered({ rows, now, refreshBackoff }).order).toEqual(['b'])
    expect(
      routeOrdered({ rows, now: now + 1000, refreshBackoff }).order,
    ).toEqual(['main', 'b'])
  })

  test('ordered drops a killswitch-killed row', () => {
    expect(
      routeOrdered({
        rows: [oauth('main', healthy()), apiKey('b')],
        now,
        killswitch: new Map([
          ['main', false],
          ['b', true],
        ]),
      }).order,
    ).toEqual(['b'])
  })
})
