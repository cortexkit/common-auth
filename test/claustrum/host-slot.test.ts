import { expect, test } from 'bun:test'
import {
  assertHostSlotMatchesMode,
  assertNotCustodyPlaceholder,
  ClaustrumConsumerError,
  classifyHostSlot,
  custodyPlaceholder,
  isCustodyPlaceholder,
} from '../../src/claustrum/index.ts'

const login = {
  type: 'oauth',
  access: 'real-access',
  refresh: 'real-refresh',
  expires: 1,
}

test('a real login landing in the host slot under custody fails closed', () => {
  expect(() =>
    assertHostSlotMatchesMode({
      mode: 'custody',
      auth: login,
      provider: 'test',
    }),
  ).toThrow(ClaustrumConsumerError)
  try {
    assertHostSlotMatchesMode({
      mode: 'custody',
      auth: { type: 'api', key: 'sk-real' },
      provider: 'test',
    })
    throw new Error('custody accepted a host api key')
  } catch (error) {
    expect((error as ClaustrumConsumerError).kind).toBe('host-slot-login')
  }
  expect(
    assertHostSlotMatchesMode({
      mode: 'custody',
      auth: custodyPlaceholder('test'),
      provider: 'test',
    }),
  ).toBe('placeholder')
  expect(
    assertHostSlotMatchesMode({
      mode: 'custody',
      auth: undefined,
      provider: 'test',
    }),
  ).toBe('empty')
})

test('the custody placeholder in local mode asks for a login instead of serving', () => {
  expect(() =>
    assertHostSlotMatchesMode({
      mode: 'local',
      auth: custodyPlaceholder('test'),
      provider: 'test',
    }),
  ).toThrow('sign in')
  expect(
    assertHostSlotMatchesMode({ mode: 'local', auth: login, provider: 'test' }),
  ).toBe('login')
})

test('the placeholder is provider-specific and never mistaken for a credential', () => {
  const placeholder = custodyPlaceholder('test')
  expect(placeholder.access).toBe('')
  expect(isCustodyPlaceholder(placeholder, 'test')).toBe(true)
  expect(isCustodyPlaceholder(placeholder, 'other')).toBe(false)
  expect(classifyHostSlot(custodyPlaceholder('other'), 'test')).toBe('empty')
  expect(() =>
    assertNotCustodyPlaceholder(placeholder.refresh, 'test'),
  ).toThrow('local token refresh is forbidden')
  expect(() =>
    assertNotCustodyPlaceholder('real-refresh', 'test'),
  ).not.toThrow()
})
