import { expect, test } from 'bun:test'
import { checkWindowsMutationAnchors } from '../../scripts/check-windows-mutation-anchors.mjs'
import { applyMutation } from '../windows/mutation-source.mjs'

test('Windows mutation anchors match committed LF and CRLF sources exactly once', async () => {
  expect(await checkWindowsMutationAnchors()).toEqual({ rows: 14, checks: 28 })
})

test('Windows mutation matching normalizes both sides and retains checkout line endings', () => {
  const lf = 'before\nguard\nafter\n'
  const crlf = 'before\r\nguard\r\nafter\r\n'
  expect(applyMutation(lf, 'guard\r\nafter', 'broken\r\nafter')).toBe(
    'before\nbroken\nafter\n',
  )
  expect(applyMutation(crlf, 'guard\nafter', 'broken\nafter')).toBe(
    'before\r\nbroken\r\nafter\r\n',
  )
})

test('Windows mutation matching refuses missing empty and duplicate anchors', () => {
  expect(() => applyMutation('source', 'missing', 'new')).toThrow(
    'exactly once',
  )
  expect(() => applyMutation('source', '', 'new')).toThrow('exactly once')
  expect(() => applyMutation('guard guard', 'guard', 'new')).toThrow(
    'exactly once',
  )
})
