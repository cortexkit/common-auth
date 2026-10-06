// Use src/rpc/rpc-server.ts from base 3c93e40, which only discards oversized
// bodies, or disable its newer error.declaredOversize response-finish listener.
// This probe supplies the entire close policy for both oversized paths.
// Overlapping production and measurement listeners would invalidate the result.
import { mkdtemp, rm } from 'node:fs/promises'
import { Server, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startRpcServer } from '../../src/rpc/index.js'

const variant = process.argv[2] ?? 'destroy'
if (!['destroy', 'end', 'bounded', 'discard'].includes(variant))
  throw new Error('variant must be destroy, end, bounded or discard')
const emit = Server.prototype.emit
let refused: IncomingMessage['socket'] | undefined
let reused: boolean | undefined
let lifecycle: string[] = []
Server.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
  if (event === 'request') {
    const [req, res] = args as [IncomingMessage, ServerResponse]
    if (Number(req.headers['content-length']) > 1_000_000 || req.headers['transfer-encoding'] === 'chunked') {
      refused = req.socket
      const events = lifecycle
      req.socket.once('close', () => events.push('socket-close'))
      req.once('end', () => events.push('body-end'))
      res.once('finish', () => {
        events.push('413-finish')
        if (variant === 'destroy') req.socket.destroy()
        else if (variant === 'end' || variant === 'bounded') {
          req.socket.end()
          if (variant === 'bounded') {
            // Two seconds matches the server's default receipt deadline and bounds
            // retention of a peer that never finishes an abandoned upload.
            const timer = setTimeout(() => req.socket.destroy(), 2_000)
            timer.unref()
            req.once('end', () => req.socket.destroy())
            req.socket.once('close', () => clearTimeout(timer))
          }
        }
      })
    } else if (req.url === '/rpc/apply') reused = req.socket === refused
  }
  return Reflect.apply(emit, this, [event, ...args])
}
const dir = await mkdtemp(join(tmpdir(), 'rpc-close-alternatives-'))
const server = await startRpcServer({ dir, isManagedDir: () => false, drain: () => [], apply: async () => ({ text: 'ok', knobs: {} }) })
const url = `http://127.0.0.1:${server.port}/rpc/apply`
const headers = { authorization: `Bearer ${server.token}` }
try {
  for (const client of ['fetch', 'slow-declared', 'chunked']) {
    lifecycle = []
    reused = undefined
    const errors: string[] = []
    let status: number | undefined
    let body = ''
    let writes = 0
    let writesAtResponse: number | undefined
    if (client === 'fetch') {
      try {
        const response = await fetch(url, { method: 'POST', headers, body: 'x'.repeat(1_310_720), signal: AbortSignal.timeout(4_000) })
        status = response.status
        body = await response.text()
      } catch (error) { errors.push(String(error)) }
    } else {
      await new Promise<void>((resolve) => {
        const req = request(url, { method: 'POST', headers: { ...headers, ...(client === 'slow-declared' ? { 'content-length': '1310720' } : { 'transfer-encoding': 'chunked' }) } }, (res) => {
          status = res.statusCode
          writesAtResponse = writes
          res.on('data', (chunk) => { body += chunk.toString() })
          res.on('error', (error) => errors.push(String(error)))
          res.on('end', () => lifecycle.push('client-response-end'))
        })
        req.on('error', (error) => errors.push(String(error)))
        req.on('close', () => lifecycle.push('client-request-close'))
        writes = 1
        req.write('x'.repeat(256 * 1024), (error) => { if (error) errors.push(String(error)) })
        const timer = setInterval(() => {
          writes++
          req.write('x'.repeat(256 * 1024), (error) => { if (error) errors.push(String(error)) })
          if (writes === 5) {
            clearInterval(timer)
            req.end()
            lifecycle.push('client-upload-end')
            setTimeout(resolve, 100)
          }
        }, 30)
      })
    }
    let followup: number | string
    try {
      const response = await fetch(url, { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(4_000) })
      followup = response.status
      await response.text()
    } catch (error) { followup = String(error) }
    await new Promise((resolve) => setTimeout(resolve, 2_100))
    console.log(JSON.stringify({ bun: Bun.version, variant, client, status, body, complete413: status === 413 && body === '{"error":"body too large"}', errors, writes, writesAtResponse, followup, reused, lifecycle: [...lifecycle] }))
  }
} finally {
  await server.stop()
  await rm(dir, { recursive: true, force: true })
}
