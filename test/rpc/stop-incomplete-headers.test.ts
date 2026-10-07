import { expect } from 'bun:test'
import { rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { startRpcServer } from '../../src/rpc/rpc-server.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { makeTempDir } from '../fixtures/scratch.js'

const hooks = lifetimeHooks()
const { afterEach, test } = hooks
let dir: string | undefined
let stop: (() => Promise<void>) | undefined
let peer: ReturnType<typeof connect> | undefined

afterEach(async () => {
  peer?.destroy()
  peer = undefined
  await stop?.()
  stop = undefined
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

test('RPC stop closes a peer that sent incomplete headers', async () => {
  dir = await makeTempDir('fixture-rpc-stop-incomplete-headers-')
  const server = await startRpcServer({
    dir,
    isManagedDir: () => false,
    drain: () => [],
    apply: async () => ({ text: '', knobs: {} }),
  })
  stop = server.stop

  const socket = connect({ host: '127.0.0.1', port: server.port })
  peer = socket
  socket.on('error', () => {})
  const closed = new Promise<void>((resolve) => {
    socket.once('close', resolve)
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.write('POST /rpc HTTP/1.1\r\nHost: localhost\r\nContent-')
      resolve()
    })
  })

  // Let the server receive the unfinished headers before shutdown begins.
  await new Promise((resolve) => setTimeout(resolve, 200))
  await server.stop()
  stop = undefined

  let timer: ReturnType<typeof setTimeout> | undefined
  const closedWithinBound = await Promise.race([
    closed.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), 1_500)
    }),
  ])
  clearTimeout(timer)
  expect(
    closedWithinBound,
    'stop closes the peer that sent incomplete headers',
  ).toBe(true)
})
