import { expect, test } from 'bun:test'
import { UnconfirmedRetainCounter } from '../../src/limits/index.js'

const A = { namespace: 'provider', accountId: 'A', incarnation: '1' }

test('counter replaces the current turn/account and isolates full account identities', () => {
  const counter = new UnconfirmedRetainCounter()
  counter.increment('session', 'turn', A)
  counter.increment('session', 'turn', A)
  expect(counter.count('session', 'turn', A)).toBe(2)
  for (const other of [
    { ...A, namespace: 'other-provider' },
    { ...A, accountId: 'B' },
    { ...A, incarnation: '2' },
  ]) {
    expect(counter.count('session', 'turn', other)).toBe(0)
    counter.increment('session', 'turn', other)
    expect(counter.count('session', 'turn', other)).toBe(1)
    expect(counter.count('session', 'turn', A)).toBe(0)
  }
  counter.increment('session', 'new-turn', A)
  expect(counter.count('session', 'new-turn', A)).toBe(1)
  expect(counter.count('session', 'turn', A)).toBe(0)
})

test('explicit lifecycle clear resets one session without affecting another', () => {
  const counter = new UnconfirmedRetainCounter()
  counter.increment('session', 'turn', A)
  counter.increment('other-session', 'turn', A)
  counter.clear('session')
  counter.clear('session')
  expect(counter.count('session', 'turn', A)).toBe(0)
  expect(counter.count('other-session', 'turn', A)).toBe(1)
  counter.increment('session', 'turn', A)
  expect(counter.count('session', 'turn', A)).toBe(1)
})

test('shutdown clears all sessions and old sessions are evicted at the storage bound', () => {
  const counter = new UnconfirmedRetainCounter(2)
  counter.increment('first', 'turn', A)
  counter.increment('first', 'turn', A)
  counter.increment('second', 'turn', A)
  counter.increment('third', 'turn', A)
  expect(counter.count('first', 'turn', A)).toBe(0)
  expect(counter.count('second', 'turn', A)).toBe(1)
  expect(counter.count('third', 'turn', A)).toBe(1)
  counter.clearAll()
  expect(counter.count('second', 'turn', A)).toBe(0)
  expect(counter.count('third', 'turn', A)).toBe(0)
})

test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  'invalid storage bound %s is rejected',
  (bound) =>
    expect(() => new UnconfirmedRetainCounter(bound)).toThrow(RangeError),
)
