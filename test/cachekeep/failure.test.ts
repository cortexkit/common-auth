import { describe, expect, test } from 'bun:test'
import { classifyFailure } from '../../src/cachekeep/failure.js'

describe('cachekeep closed failure diagnostics', () => {
  test('retains only allowlisted names and codes, preferring transport causes over TypeError', () => {
    for (const name of ['AbortError', 'TimeoutError', 'TypeError']) {
      expect(classifyFailure({ name, message: 'PRIVATE' }, 'send')).toEqual({
        stage: 'send',
        class: name,
      })
    }
    for (const code of [
      'ECONNRESET',
      'EAI_AGAIN',
      'UND_ERR_SOCKET',
      'UND_ERR_CONNECT_TIMEOUT',
    ]) {
      expect(
        classifyFailure(
          { name: 'TypeError', cause: { code, message: 'PRIVATE' } },
          'send',
        ),
      ).toEqual({ stage: 'send', class: code })
      expect(classifyFailure({ code }, 'authorization')).toEqual({
        stage: 'authorization',
        class: code,
      })
    }
    expect(
      classifyFailure({ name: 'TimeoutError', code: 'ECONNRESET' }, 'send'),
    ).toEqual({ stage: 'send', class: 'TimeoutError' })
  })

  test('HTTP failure status wins; successful and invalid status numbers do not become classes', () => {
    expect(classifyFailure(new TypeError('PRIVATE'), 'send', 503)).toEqual({
      stage: 'response',
      class: 503,
    })
    for (const status of [200, 0, 600, 401.5, Number.NaN]) {
      expect(
        classifyFailure(new TypeError('PRIVATE'), 'response', status),
      ).toEqual({ stage: 'response', class: 'TypeError' })
    }
  })

  test('unknown values, nested causes and hostile accessors never leak text or throw', () => {
    const hostile = {
      get name() {
        throw new Error('PRIVATE accessor')
      },
    }
    for (const error of [
      null,
      'PRIVATE error',
      new Error('PRIVATE message'),
      {
        name: 'PRIVATE name',
        code: 'PRIVATE code',
        cause: { code: 'PRIVATE cause' },
      },
      { cause: { cause: { code: 'ECONNRESET' } } },
      hostile,
    ]) {
      const classified = classifyFailure(error, 'send')
      expect(classified).toEqual({ stage: 'send', class: 'unknown' })
      expect(JSON.stringify(classified)).not.toContain('PRIVATE')
    }
  })
})
