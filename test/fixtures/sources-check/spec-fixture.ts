import { describe, expect, test } from 'bun:test'

test('source fixture top-level passes', () => {
  expect(2 + 2).toBe(4)
})

describe('source fixture group', () => {
  test('source fixture nested passes', () => {
    expect('nested').toBe('nested')
  })
})

test.skip('source fixture skipped', () => {
  expect(true).toBe(false)
})

test.todo('source fixture todo', () => {
  expect(true).toBe(false)
})
