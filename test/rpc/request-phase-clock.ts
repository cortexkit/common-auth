import { spyOn } from 'bun:test'
import { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

/** Observe the early refusal without changing the server's request listeners. */
export function requestPhaseClock(port?: number) {
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
  const sockets = new Map<Socket, number>()
  let refusedSocket: Socket | undefined
  let serverPort: number | undefined = port
  let resolveClosed: () => void = () => {}
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
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
        (Number(req.headers['content-length']) > 1_000_000 ||
          (port !== undefined &&
            req.socket.localPort === port &&
            req.headers['transfer-encoding'] === 'chunked'))
      if (oversized) serverPort = req.socket.localPort
      const observed =
        event === 'request' &&
        req instanceof IncomingMessage &&
        res instanceof ServerResponse &&
        serverPort !== undefined &&
        req.socket.localPort === serverPort
      if (observed) {
        const socket = req.socket
        if (oversized) refusedSocket = socket
        const request = oversized ? 'oversized' : 'follow-up'
        const fresh = !sockets.has(socket)
        if (fresh) sockets.set(socket, sockets.size + 1)
        const detail = {
          request,
          socketId: sockets.get(socket),
          remotePort: socket.remotePort,
          reused413Connection: oversized ? null : socket === refusedSocket,
        }
        const record = (phase: string, extra: Record<string, unknown> = {}) =>
          mark(phase, { ...detail, ...extra })
        record('server-request', { declared: req.headers['content-length'] })
        const head = res.writeHead
        restores.push(
          spyOn(res, 'writeHead').mockImplementation((...values) => {
            record('server-write-headers', { status: values[0] })
            return Reflect.apply(head, res, values)
          }),
        )
        res.once('finish', () => record('server-response-finish'))
        if (fresh) {
          const end = socket.end
          restores.push(
            spyOn(socket, 'end').mockImplementation((...values) => {
              record('socket-local-end', { side: 'server' })
              return Reflect.apply(end, socket, values)
            }),
          )
          const destroy = socket.destroy
          restores.push(
            spyOn(socket, 'destroy').mockImplementation((...values) => {
              record('socket-local-destroy', { side: 'server' })
              return Reflect.apply(destroy, socket, values)
            }),
          )
          socket.once('end', () =>
            record('socket-peer-end', { side: 'client' }),
          )
          socket.once('close', (hadError) => {
            record('socket-close', { hadError })
            if (socket === refusedSocket) resolveClosed()
          })
        }
        req.once('end', () => record('body-end'))
        req.once('aborted', () => record('body-aborted'))
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
    events,
    closed,
    get refusedSocket() {
      return refusedSocket
    },
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
