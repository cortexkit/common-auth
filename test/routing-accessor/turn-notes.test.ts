import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  type ReportRoutingInput,
  reportRouting,
  turnNotes,
} from '../../src/routing-accessor/index.js'

const symbol = Symbol.for('cortexkit.routing')
const original = Object.getOwnPropertyDescriptor(globalThis, symbol)

function install(value: unknown): void {
  Object.defineProperty(globalThis, symbol, { configurable: true, value })
}

function answerWith(answer: unknown): void {
  install(() => ({ turn_notes: () => answer }))
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, symbol)
  if (original) Object.defineProperty(globalThis, symbol, original)
})

describe('turnNotes', () => {
  test('returns an empty array without the global bridge', () => {
    Reflect.deleteProperty(globalThis, symbol)
    expect(turnNotes('session')).toEqual([])
  })

  test.each([undefined, null, {}, 'not an accessor', 1])(
    'returns an empty array for a non-function global: %p',
    (value) => {
      install(value)
      expect(turnNotes('session')).toEqual([])
    },
  )

  test.each([undefined, null, 'not a handle', 1, () => []])(
    'returns an empty array for an invalid handle: %p',
    (handle) => {
      install(() => handle)
      expect(turnNotes('session')).toEqual([])
    },
  )

  test.each(
    [undefined, null, [], {}, 'not a method', 1].map((value) => [value]),
  )(
    'returns an empty array for a missing or non-function turn_notes: %p',
    (turn_notes) => {
      install(() => ({ turn_notes }))
      expect(turnNotes('session')).toEqual([])
    },
  )

  test('returns an empty array for an empty handle or no notes', () => {
    install(() => ({}))
    expect(turnNotes('session')).toEqual([])
    answerWith([])
    expect(turnNotes('session')).toEqual([])
  })

  test('ignores throwing global getters, accessors and methods', () => {
    Object.defineProperty(globalThis, symbol, {
      configurable: true,
      get() {
        throw new Error('global getter failed')
      },
    })
    expect(turnNotes('session')).toEqual([])
    install(() => {
      throw new Error('accessor failed')
    })
    expect(turnNotes('session')).toEqual([])
    install(() => ({
      get turn_notes() {
        throw new Error('method getter failed')
      },
    }))
    expect(turnNotes('session')).toEqual([])
    install(() => ({
      turn_notes() {
        throw new Error('method failed')
      },
    }))
    expect(turnNotes('session')).toEqual([])
  })

  test.each([
    ['promise', Promise.resolve([])],
    [
      'thenable object',
      {
        // biome-ignore lint/suspicious/noThenProperty: The synchronous reader must reject thenable results.
        then() {},
      },
    ],
    [
      'thenable array',
      Object.assign([{ after_tool_use_id: 'tool-1', text: 'note' }], {
        // biome-ignore lint/suspicious/noThenProperty: Even an array is invalid when it is also thenable.
        then() {},
      }),
    ],
  ])('rejects a synchronous result that is a %s', (_name, answer) => {
    answerWith(answer)
    expect(turnNotes('session')).toEqual([])
  })

  test('ignores a rejected promise returned by a broken synchronous reader', async () => {
    answerWith(Promise.reject(new Error('reader rejected')))
    expect(turnNotes('session')).toEqual([])
    await Promise.resolve()
  })

  test('ignores a throwing then getter', () => {
    const answer = [{ after_tool_use_id: 'tool-1', text: 'note' }]
    Object.defineProperty(answer, 'then', {
      get() {
        throw new Error('then getter failed')
      },
    })
    answerWith(answer)
    expect(turnNotes('session')).toEqual([])
  })

  test.each([undefined, null, {}, 'not an array', 1, () => []])(
    'returns an empty array for a non-array result: %p',
    (answer) => {
      answerWith(answer)
      expect(turnNotes('session')).toEqual([])
    },
  )

  test('keeps valid neighbours in landing order and copies only contract fields', () => {
    answerWith([
      { after_tool_use_id: 'tool-2', text: 'first', ignored: 'not copied' },
      null,
      undefined,
      1,
      'note',
      {},
      Object.assign([], { after_tool_use_id: 'array', text: 'invalid' }),
      Object.assign(() => {}, {
        after_tool_use_id: 'function',
        text: 'invalid',
      }),
      { after_tool_use_id: 1, text: 'invalid' },
      { after_tool_use_id: '', text: 'invalid' },
      { after_tool_use_id: 'tool', text: 1 },
      { after_tool_use_id: 'tool', text: '' },
      { after_tool_use_id: 'tool', text: 'x'.repeat(16_385) },
      {
        get after_tool_use_id() {
          throw new Error('entry getter failed')
        },
        text: 'invalid',
      },
      { after_tool_use_id: 'tool-1', text: 'second' },
      { after_tool_use_id: 'tool-2', text: 'third' },
    ])
    expect(turnNotes('session')).toEqual([
      { afterToolUseId: 'tool-2', text: 'first' },
      { afterToolUseId: 'tool-1', text: 'second' },
      { afterToolUseId: 'tool-2', text: 'third' },
    ])
  })

  test('enforces the 16,384 UTF-8 byte boundary with multi-byte text', () => {
    const atLimit = 'é'.repeat(8192)
    const overLimit = `${atLimit}a`
    expect(Buffer.byteLength(atLimit, 'utf8')).toBe(16_384)
    expect(Buffer.byteLength(overLimit, 'utf8')).toBe(16_385)
    answerWith([
      { after_tool_use_id: 'at-limit', text: atLimit },
      { after_tool_use_id: 'over-limit', text: overLimit },
      { after_tool_use_id: 'after-limit', text: 'still valid' },
    ])
    expect(turnNotes('session')).toEqual([
      { afterToolUseId: 'at-limit', text: atLimit },
      { afterToolUseId: 'after-limit', text: 'still valid' },
    ])
  })

  test('keeps returned and bridge arrays and objects independent in both directions', () => {
    const source = [{ after_tool_use_id: 'original', text: 'original text' }]
    answerWith(source)
    const notes = turnNotes('session') as {
      afterToolUseId: string
      text: string
    }[]
    expect(notes).not.toBe(source)
    expect(notes[0]).not.toBe(source[0])
    expect(notes).toEqual([
      { afterToolUseId: 'original', text: 'original text' },
    ])
    Object.assign(source[0] ?? {}, {
      after_tool_use_id: 'bridge changed',
      text: 'bridge text',
    })
    source.push({ after_tool_use_id: 'new', text: 'new text' })
    expect(notes).toEqual([
      { afterToolUseId: 'original', text: 'original text' },
    ])
    Object.assign(notes[0] ?? {}, {
      afterToolUseId: 'caller changed',
      text: 'caller text',
    })
    notes.splice(0, 1)
    expect(source).toEqual([
      { after_tool_use_id: 'bridge changed', text: 'bridge text' },
      { after_tool_use_id: 'new', text: 'new text' },
    ])
  })

  test('looks up each session on every call and invokes the bound method with no arguments', () => {
    const read = mock(() => [{ after_tool_use_id: 'id', text: 'note' }])
    const handle = { turn_notes: read }
    const routing = mock((_sessionId: string) => handle)
    install(routing)
    expect(turnNotes('session-a')).toEqual([
      { afterToolUseId: 'id', text: 'note' },
    ])
    expect(turnNotes('session-b')).toEqual([
      { afterToolUseId: 'id', text: 'note' },
    ])
    expect(routing.mock.calls).toEqual([['session-a'], ['session-b']])
    expect(read.mock.calls).toEqual([[], []])
    expect(read.mock.contexts).toEqual([handle, handle])
    answerWith([{ after_tool_use_id: 'replacement', text: 'new bridge' }])
    expect(turnNotes('session-a')).toEqual([
      { afterToolUseId: 'replacement', text: 'new bridge' },
    ])
    Reflect.deleteProperty(globalThis, symbol)
    expect(turnNotes('session-a')).toEqual([])
  })
})

describe('turn-note reports', () => {
  const supported = {
    sessionId: 'session',
    kind: 'turn_notes_supported',
    model: 'claude-sonnet',
    supported: true,
  } as const
  const skipped = {
    sessionId: 'session',
    kind: 'turn_note_skipped',
    after_tool_use_id: 'tool-1',
    reason: 'anchor_missing',
  } as const

  test.each([true, false])(
    'forwards turn_notes_supported with supported=%p and no session or extra fields',
    (value) => {
      const report = mock((_payload: unknown) => {})
      const handle = { report }
      const routing = mock((_sessionId: string) => handle)
      install(routing)
      reportRouting({
        ...supported,
        supported: value,
        accountId: 'not sent',
        credentialId: 'not sent',
        extra: 'not sent',
      } as ReportRoutingInput)
      expect(report.mock.calls).toEqual([
        [
          {
            kind: 'turn_notes_supported',
            model: 'claude-sonnet',
            supported: value,
          },
        ],
      ])
      expect(routing.mock.calls).toEqual([['session']])
      expect(report.mock.contexts).toEqual([handle])
    },
  )

  test.each([
    'anchor_missing',
    'before_user_message',
    'unsupported_model',
    'not_oauth',
  ] as const)('forwards one turn_note_skipped event for %s', (reason) => {
    const report = mock((_payload: unknown) => {})
    install(() => ({ report }))
    reportRouting({ ...skipped, reason })
    expect(report.mock.calls).toEqual([
      [{ kind: 'turn_note_skipped', after_tool_use_id: 'tool-1', reason }],
    ])
  })

  test('does not deduplicate or batch repeated events', () => {
    const report = mock((_payload: unknown) => {})
    install(() => ({ report }))
    reportRouting(supported)
    reportRouting(supported)
    reportRouting(skipped)
    reportRouting(skipped)
    expect(report.mock.calls).toEqual([
      [
        {
          kind: 'turn_notes_supported',
          model: 'claude-sonnet',
          supported: true,
        },
      ],
      [
        {
          kind: 'turn_notes_supported',
          model: 'claude-sonnet',
          supported: true,
        },
      ],
      [
        {
          kind: 'turn_note_skipped',
          after_tool_use_id: 'tool-1',
          reason: 'anchor_missing',
        },
      ],
      [
        {
          kind: 'turn_note_skipped',
          after_tool_use_id: 'tool-1',
          reason: 'anchor_missing',
        },
      ],
    ])
  })

  test.each([supported, skipped])(
    'forwards only the validated snapshot of $kind fields',
    (event) => {
      const report = mock((_payload: unknown) => {})
      install(() => ({ report }))
      const reads: Record<string, number> = {}
      const input = new Proxy(event, {
        get(target, key, receiver) {
          if (typeof key !== 'string') return Reflect.get(target, key, receiver)
          reads[key] = (reads[key] ?? 0) + 1
          return reads[key] === 1
            ? Reflect.get(target, key, receiver)
            : undefined
        },
      })
      reportRouting(input)
      const { sessionId: _sessionId, ...payload } = event
      expect(report.mock.calls).toEqual([[payload]])
      expect(Object.values(reads).every((count) => count === 1)).toBe(true)
    },
  )

  test.each([undefined, null, '', 1, false, {}, []].map((value) => [value]))(
    'drops an invalid model: %p',
    (model) => {
      const report = mock((_payload: unknown) => {})
      install(() => ({ report }))
      reportRouting({ ...supported, model } as unknown as ReportRoutingInput)
      expect(report).not.toHaveBeenCalled()
    },
  )

  test.each(
    [undefined, null, '', 'true', 0, 1, {}, []].map((value) => [value]),
  )('drops a non-boolean supported: %p', (value) => {
    const report = mock((_payload: unknown) => {})
    install(() => ({ report }))
    reportRouting({
      ...supported,
      supported: value,
    } as unknown as ReportRoutingInput)
    expect(report).not.toHaveBeenCalled()
  })

  test.each([undefined, null, '', 1, false, {}, []].map((value) => [value]))(
    'drops an invalid tool-use anchor: %p',
    (after_tool_use_id) => {
      const report = mock((_payload: unknown) => {})
      install(() => ({ report }))
      reportRouting({
        ...skipped,
        after_tool_use_id,
      } as unknown as ReportRoutingInput)
      expect(report).not.toHaveBeenCalled()
    },
  )

  test.each(
    [undefined, null, '', 'unknown_reason', 1, {}, []].map((value) => [value]),
  )('drops a reason outside the closed set: %p', (reason) => {
    const report = mock((_payload: unknown) => {})
    install(() => ({ report }))
    reportRouting({ ...skipped, reason } as unknown as ReportRoutingInput)
    expect(report).not.toHaveBeenCalled()
  })

  test('drops an unknown kind', () => {
    const report = mock((_payload: unknown) => {})
    install(() => ({ report }))
    reportRouting({
      ...supported,
      kind: 'unknown_kind',
    } as unknown as ReportRoutingInput)
    expect(report).not.toHaveBeenCalled()
  })

  test.each([supported, skipped])(
    'ignores missing, throwing and rejecting bridges for $kind',
    async (event) => {
      Reflect.deleteProperty(globalThis, symbol)
      expect(reportRouting(event)).toBeUndefined()
      install(() => ({}))
      expect(reportRouting(event)).toBeUndefined()
      install(() => ({
        report() {
          throw new Error('report failed')
        },
      }))
      expect(reportRouting(event)).toBeUndefined()
      install(() => ({
        report: () => Promise.reject(new Error('report rejected')),
      }))
      expect(reportRouting(event)).toBeUndefined()
      await Promise.resolve()
      install(() => ({ report: () => new Promise(() => {}) }))
      expect(reportRouting(event)).toBeUndefined()
    },
  )
})
