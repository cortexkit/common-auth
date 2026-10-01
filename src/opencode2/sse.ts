/** One server-sent event: its `event:` name, if any, and its joined `data:` lines. */
export interface ServerSentEvent {
  readonly event?: string
  readonly data: string
}

function parseBlock(block: string): ServerSentEvent | undefined {
  const data: string[] = []
  let event: string | undefined
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    else if (line.startsWith('event:')) event = line.slice(6).trim()
  }
  if (data.length === 0) return undefined
  return event === undefined
    ? { data: data.join('\n') }
    : { event, data: data.join('\n') }
}

/**
 * A pass-through stream that hands every complete server-sent event to
 * `onEvent` while forwarding the original bytes unchanged, so the host still
 * consumes the body exactly once. A throwing `onEvent` is reported to
 * `onError` and never breaks the stream.
 */
export function watchServerSentEvents(
  onEvent: (event: ServerSentEvent) => void,
  onError: (error: unknown) => void,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  let buffer = ''
  const emit = (block: string) => {
    const event = parseBlock(block)
    if (!event) return
    try {
      onEvent(event)
    } catch (error) {
      onError(error)
    }
  }
  const drain = () => {
    for (;;) {
      const match = /\r?\n\r?\n/.exec(buffer)
      if (!match) return
      const block = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)
      emit(block)
    }
  }
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      buffer += decoder.decode(chunk, { stream: true })
      drain()
    },
    flush() {
      buffer += decoder.decode()
      drain()
      if (buffer.trim() !== '') emit(buffer)
      buffer = ''
    },
  })
}
