import { describe, expect, test } from 'bun:test'
import { watchServerSentEvents } from '../../src/opencode2/index.js'

describe('watchServerSentEvents', () => {
  test('passes the body through unchanged and reports events split across chunks', async () => {
    const body =
      'event: one\ndata: {"a":1}\n\n: comment\n\ndata: line1\r\ndata: line2\r\n\r\ndata: tail'
    const encoder = new TextEncoder()
    const bytes = encoder.encode(body)
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        // Split mid-event and mid-character boundary to exercise buffering.
        for (let i = 0; i < bytes.length; i += 7) {
          controller.enqueue(bytes.slice(i, i + 7))
        }
        controller.close()
      },
    })
    const seen: Array<{ event?: string; data: string }> = []
    const errors: unknown[] = []
    const out = await new Response(
      source.pipeThrough(
        watchServerSentEvents(
          (event) => {
            seen.push(event)
            if (event.data === 'line1\nline2') throw new Error('observer broke')
          },
          (error) => errors.push(error),
        ),
      ),
    ).text()
    expect(out).toBe(body)
    expect(seen).toEqual([
      { event: 'one', data: '{"a":1}' },
      { data: 'line1\nline2' },
      { data: 'tail' },
    ])
    expect(errors).toHaveLength(1)
  })
})
