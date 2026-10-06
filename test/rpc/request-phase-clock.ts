import { spyOn } from 'bun:test'
import { IncomingMessage, Server, ServerResponse } from 'node:http'

/** Observe the early refusal without changing the server's request listeners. */
export function requestPhaseClock() {
  const started = performance.now()
  const events: Array<Record<string, unknown>> = []
  const restores: Array<{ mockRestore(): void }> = []
  let bytes = 0
  let firstByteMs: number | undefined
  let lastByteMs: number | undefined
  let failed = true
  const ms = () => Number((performance.now() - started).toFixed(3))
  const mark = (phase: string, detail: Record<string, unknown> = {}) => {
    events.push({
      phase,
      ms: ms(),
      bytes,
      firstByteMs: firstByteMs ?? null,
      lastByteMs: lastByteMs ?? null,
      ...detail,
    })
  }
  const emit = Server.prototype.emit
  restores.push(
    spyOn(Server.prototype, 'emit').mockImplementation(function (
      this: Server,
      event: string | symbol,
      ...args: unknown[]
    ) {
      const [req, res] = args
      const oversized =
        event === 'request' &&
        req instanceof IncomingMessage &&
        res instanceof ServerResponse &&
        Number(req.headers['content-length']) > 1_000_000
      if (oversized) {
        mark('server-request', { declared: req.headers['content-length'] })
        const head = res.writeHead
        restores.push(
          spyOn(res, 'writeHead').mockImplementation((...values) => {
            mark('server-write-headers', { status: values[0] })
            return Reflect.apply(head, res, values)
          }),
        )
        res.once('finish', () => mark('server-response-finish'))
        const socket = req.socket
        const end = socket.end
        restores.push(
          spyOn(socket, 'end').mockImplementation((...values) => {
            mark('socket-local-end', { side: 'server' })
            return Reflect.apply(end, socket, values)
          }),
        )
        const destroy = socket.destroy
        restores.push(
          spyOn(socket, 'destroy').mockImplementation((...values) => {
            mark('socket-local-destroy', { side: 'server' })
            return Reflect.apply(destroy, socket, values)
          }),
        )
        socket.once('end', () => mark('socket-peer-end', { side: 'client' }))
        socket.once('close', (hadError) => mark('socket-close', { hadError }))
        req.once('end', () => mark('body-discard-end'))
        req.once('aborted', () => mark('body-aborted'))
      }
      const result = Reflect.apply(emit, this, [event, ...args]) as boolean
      if (oversized) {
        // The server removes data listeners before draining an oversized body
        // into a no-op listener. Attach afterwards so this observer survives.
        req.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          firstByteMs ??= ms()
          lastByteMs = ms()
        })
      }
      return result
    }),
  )
  return {
    mark,
    succeeded() {
      failed = false
    },
    finish() {
      mark('trace-finish')
      for (const restore of restores.reverse()) restore.mockRestore()
      if (failed)
        console.error('RPC 413 failure phases', JSON.stringify(events))
    },
  }
}
