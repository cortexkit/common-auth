import { expect, it } from 'bun:test'
import {
  createRedactor,
  redact,
  redactStrings,
} from '../../src/logger/index.js'

it('scrubs embedded eyJabc in place while preserving surrounding message text', () => {
  expect(redactStrings('before eyJabc after')).toBe(
    'before ***REDACTED*** after',
  )
})

it('base redaction leaves plugin identity keys visible and extras receive normalized keys', () => {
  expect(redact({ chatgptAccountId: 'x' })).toEqual({ chatgptAccountId: 'x' })
  const redactor = createRedactor({
    extraSecretKeys: (key) => key === 'chatgptaccountid',
  })
  expect(redactor.redact({ 'ChatGPT_Account-ID': 'x' })).toEqual({
    'ChatGPT_Account-ID': '***REDACTED***',
  })
})

it('redacts the full case-insensitive key set and normalized secret key families', () => {
  const keys = [
    'AUTHORIZATION',
    'X-API-KEY',
    'Cookie',
    'SET-COOKIE',
    'Refresh',
    'ACCESS',
    'Token',
    'my_api_key_id',
    'CLIENT_SECRET',
    'userPassword',
    'idToken',
  ]
  for (const key of keys)
    expect(redact({ [key]: 'x' })).toEqual({ [key]: '***REDACTED***' })
  expect(redact({ input_tokens: 12, sessionKey: 'x' })).toEqual({
    input_tokens: 12,
    sessionKey: 'x',
  })
})

it('tool schemas scrub strings without redacting schema property names', () => {
  const schema = {
    properties: {
      api_key: { type: 'string', description: 'use sk-abcdef here' },
      token: { type: 'string' },
    },
  }
  expect(redactStrings(schema)).toEqual({
    properties: {
      api_key: { type: 'string', description: 'use ***REDACTED*** here' },
      token: { type: 'string' },
    },
  })
  expect(schema.properties.api_key.description).toBe('use sk-abcdef here')
})

it('extra value patterns scrub every match in place without mutable regexp state', () => {
  const pattern = /private:\d+/g
  pattern.lastIndex = 9
  const redactor = createRedactor({ extraValuePatterns: [pattern] })
  for (let i = 0; i < 2; i++)
    expect(redactor.redactStrings('a private:12 b private:34 c')).toBe(
      'a ***REDACTED*** b ***REDACTED*** c',
    )
  expect(pattern.lastIndex).toBe(9)
})
