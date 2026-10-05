import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writePortFile } from '../../src/rpc/port-file.js'
import { createRpcClient } from '../../src/rpc/rpc-client.js'

async function exchange(send: (socket: Socket) => void, holdDeadline = false) {
  const dir = await mkdtemp(join(tmpdir(), 'rpc-wire-'))
  const sockets = new Set<Socket>()
  const closed = Promise.withResolvers<void>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => {
      sockets.delete(socket)
      closed.resolve()
    })
    socket.once('data', () => send(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  const realSetTimeout = globalThis.setTimeout
  let deadlines = 0
  const deadlineSpy = holdDeadline
    ? spyOn(globalThis, 'setTimeout').mockImplementation(((
        ...args: Parameters<typeof realSetTimeout>
      ) => {
        if (args[1] !== 150) return realSetTimeout(...args)
        deadlines++
        // Hold only the RPC deadline: rejection must come from received data,
        // not from a timeout while the peer deliberately withholds EOF.
        return realSetTimeout(() => {}, 0)
      }) as typeof realSetTimeout)
    : undefined
  try {
    await writePortFile(dir, {
      port: address.port,
      pid: process.pid,
      token: 'fixture',
    })
    const result = await createRpcClient(dir, process.pid).apply(
      { command: 'probe', arguments: '☃' },
      150,
    )
    if (holdDeadline) expect(deadlines).toBe(1)
    // The server never ends bounded responses; observe client-initiated close.
    await closed.promise
    expect(sockets.size).toBe(0)
    return result
  } finally {
    deadlineSpy?.mockRestore()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
}

const body = JSON.stringify({ text: 'snow ☃', knobs: {} })
const fallback = { text: 'apply failed', knobs: {} }

test('raw RPC transport reads split headers and UTF-8 bodies with or without Content-Length', async () => {
  for (const length of ['', `Content-Length: ${Buffer.byteLength(body)}\r\n`]) {
    expect(
      await exchange((socket) => {
        socket.write('HTTP/1.0 200 OK\r\n')
        setTimeout(() => {
          const bytes = Buffer.from(`${length}\r\n${body}`)
          socket.write(bytes.subarray(0, bytes.length - 5))
          // A length-delimited peer may keep the connection open indefinitely.
          if (length) socket.write(bytes.subarray(bytes.length - 5))
          else socket.end(bytes.subarray(bytes.length - 5))
        }, 5)
      }),
    ).toEqual({ text: 'snow ☃', knobs: {} })
  }
})

test('raw RPC transport rejects truncated, reset and stalled bodies and closes sockets', async () => {
  for (const mode of ['truncated', 'reset', 'stalled']) {
    expect(
      await exchange((socket) => {
        socket.write('HTTP/1.0 200 OK\r\nContent-Length: 100\r\n\r\n{"text":')
        if (mode === 'truncated') socket.end()
        if (mode === 'reset') socket.resetAndDestroy()
      }),
    ).toEqual(fallback)
  }
})

test('raw RPC transport rejects length overruns, transfer encoding, invalid JSON and non-2xx', async () => {
  for (const response of [
    `HTTP/1.0 200 OK\r\nContent-Length: 1\r\n\r\n${body}`,
    `HTTP/1.0 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${body}`,
    'HTTP/1.0 200 OK\r\nContent-Length: invalid\r\n\r\n{}',
    'HTTP/1.0 200 OK\r\n\r\nnot JSON',
    `HTTP/1.0 403 Forbidden\r\n\r\n${body}`,
    'not HTTP\r\n\r\n{}',
  ]) {
    expect(await exchange((socket) => socket.end(response))).toEqual(fallback)
  }
})

test('raw RPC transport bounds headers and response bodies before EOF', async () => {
  for (const response of [
    `HTTP/1.0 200 OK\r\nX-Large: ${'x'.repeat(16 * 1024)}`,
    `HTTP/1.0 200 OK\r\n\r\n${'x'.repeat(8 * 1024 * 1024 + 1)}`,
  ]) {
    expect(await exchange((socket) => socket.write(response), true)).toEqual(
      fallback,
    )
  }
})
