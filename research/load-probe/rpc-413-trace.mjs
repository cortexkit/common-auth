// Test-only preload: attach the data observer after the request callback,
// because the server removes earlier listeners when refusing oversized bodies.
// Observe the existing HTTP objects without changing the server interface.
import { IncomingMessage, Server, ServerResponse } from 'node:http'

console.log(JSON.stringify({ probe: 'rpc-413-runtime', bun: Bun.version, executable: process.execPath }))
const origin = performance.now()
const requests = new WeakMap()
const servers = new WeakMap()
let next = 0
const sockets = new WeakMap()
const refusedSockets = new WeakMap()
const acceptedSockets = new WeakMap()
let nextSocket = 0
function phase(id, name, extra = {}) {
  console.log(JSON.stringify({ probe: 'rpc-413', id, phase: name, ms: +(performance.now() - origin).toFixed(3), ...extra }))
}
const serverEmit = Server.prototype.emit
Server.prototype.emit = function (event, ...args) {
  if (event === 'connection') {
    const [socket] = args
    if (!sockets.has(socket)) sockets.set(socket, ++nextSocket)
    const socketId = sockets.get(socket)
    const identity = { socketId, serverPort: socket.localPort, remotePort: socket.remotePort }
    const accepted = acceptedSockets.get(this) ?? []
    accepted.push({ socket, identity })
    acceptedSockets.set(this, accepted)
    let bytes = 0
    let tail = ''
    phase(`socket-${socketId}`, 'server-connection', { ...identity, bytesRead: socket.bytesRead })
    // Observe raw arrivals without resuming, consuming, or replacing the HTTP parser.
    socket.on('data', (chunk) => {
      const text = chunk.toString('latin1')
      const combined = tail + text
      const applyHeaders = [...combined.matchAll(/POST \/rpc\/apply HTTP\/1\.[01]/g)].map((match) => bytes - tail.length + match.index)
      bytes += chunk.length
      tail = combined.slice(-32)
      phase(`socket-${socketId}`, 'server-raw-data', { ...identity, chunkBytes: chunk.length, bytes, applyHeaderOffsets: applyHeaders, prefix: text.slice(0, 80) })
    })
    socket.once('close', (hadError) => phase(`socket-${socketId}`, 'server-raw-close', { ...identity, bytes, hadError, bytesRead: socket.bytesRead }))
  }
  if (event === 'request') {
    const [req, res] = args
    if (Number(req.headers['content-length']) > 1_000_000 || (process.env.RPC_413_TRACE_ALL === '1' && req.method === 'POST')) {
      const oversized = Number(req.headers['content-length']) > 1_000_000
      if (oversized) refusedSockets.set(this, req.socket)
      if (!sockets.has(req.socket)) sockets.set(req.socket, ++nextSocket)
      const record = { id: ++next, bytes: 0, socket: req.socket }
      const records = servers.get(this) ?? []
      records.push(record)
      servers.set(this, records)
      requests.set(req, record)
      requests.set(res, record)
      phase(record.id, 'server-request', { declared: req.headers['content-length'], serverPort: req.socket.localPort, remotePort: req.socket.remotePort, socketId: sockets.get(req.socket), bytesRead: req.socket.bytesRead, reused413Connection: oversized ? null : (refusedSockets.has(this) ? refusedSockets.get(this) === req.socket : null) })
      for (const name of ['end', 'destroy']) {
        const original = req.socket[name]
        req.socket[name] = function (...values) {
          phase(record.id, `server-socket-local-${name}`, { bytes: record.bytes })
          return original.apply(this, values)
        }
      }
      req.socket.on('end', () => phase(record.id, 'server-socket-peer-fin', { bytes: record.bytes }))
      req.socket.on('close', (hadError) => phase(record.id, 'server-socket-close', { hadError, bytes: record.bytes }))
    }
  }
  const result = serverEmit.call(this, event, ...args)
  if (event === 'request') {
    const [req] = args
    const record = requests.get(req)
    if (record) {
      req.on('data', (chunk) => {
        record.bytes += chunk.length
        phase(record.id, 'server-discard-data', { bytes: record.bytes })
      })
    }
  }
  return result
}
const serverClose = Server.prototype.close
Server.prototype.close = function (...args) {
  for (const { socket, identity } of acceptedSockets.get(this) ?? []) phase(`socket-${identity.socketId}`, 'server-stop-bytes-read', { ...identity, bytesRead: socket.bytesRead })
  for (const record of servers.get(this) ?? []) phase(record.id, 'server-stop-close-call', { bytes: record.bytes })
  return serverClose.apply(this, args)
}
const messageEmit = IncomingMessage.prototype.emit
IncomingMessage.prototype.emit = function (event, ...args) {
  const record = requests.get(this)
  if (record) {
    if (['end', 'aborted', 'error', 'close'].includes(event)) phase(record.id, `server-body-${event}`, { bytes: record.bytes, error: String(args[0] ?? '') })
  }
  return messageEmit.call(this, event, ...args)
}
const writeHead = ServerResponse.prototype.writeHead
ServerResponse.prototype.writeHead = function (...args) {
  const record = requests.get(this)
  if (record) phase(record.id, 'server-write-head', { status: args[0], bytes: record.bytes })
  return writeHead.apply(this, args)
}
const responseEnd = ServerResponse.prototype.end
ServerResponse.prototype.end = function (...args) {
  const record = requests.get(this)
  if (record) {
    phase(record.id, 'server-response-end-call', { bytes: record.bytes })
    this.once('finish', () => phase(record.id, 'server-response-finish', { bytes: record.bytes, socketId: sockets.get(record.socket), bytesRead: record.socket.bytesRead }))
  }
  return responseEnd.apply(this, args)
}
const originalFetch = globalThis.fetch
let clients = 0
const promiseIds = new WeakMap()
globalThis.fetch = function (url, options) {
  if (typeof options?.body !== 'string' || (options.body.length <= 1_000_000 && process.env.RPC_413_TRACE_ALL !== '1')) return originalFetch(url, options)
  const id = `client-${++clients}`
  phase(id, 'fetch-start', { url: String(url), bytes: Buffer.byteLength(options.body) })
  options.signal?.addEventListener('abort', () => phase(id, 'signal-abort', { reason: String(options.signal.reason) }), { once: true })
  const pending = originalFetch(url, options)
  promiseIds.set(pending, `${id}:fetch`)
  void pending.then((response) => {
    phase(id, 'fetch-resolve-headers', { status: response.status, connection: response.headers.get('connection') })
    const json = response.json.bind(response)
    response.json = function () {
      phase(id, 'json-start')
      const body = json()
      promiseIds.set(body, `${id}:json`)
      void body.then(() => phase(id, 'json-resolve'), (error) => phase(id, 'json-reject', { error: String(error) }))
      return body
    }
  }, (error) => phase(id, 'fetch-reject', { error: String(error) }))
  return pending
}
process.on('unhandledRejection', (error, pending) => phase('unhandled', 'rejection', { promise: promiseIds.get(pending) ?? 'other', error: String(error) }))
