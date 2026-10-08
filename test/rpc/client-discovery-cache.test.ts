import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RpcNotification } from '../../src/rpc/notifications.js'
import { discoverPortFile, writePortFile } from '../../src/rpc/port-file.js'
import { createRpcClient } from '../../src/rpc/rpc-client.js'

const messages: RpcNotification[] = [
  {
    id: 1,
    type: 'open-dialog',
    payload: { command: 'fixture', text: 'fixture', knobs: {} },
  },
]

async function fixture(
  body: (dir: string, serve: typeof server) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'rpc-cache-'))
  const servers: Awaited<ReturnType<typeof server>>[] = []
  try {
    await body(dir, async (...args) => {
      const live = await server(...args)
      servers.push(live)
      return live
    })
  } finally {
    for (const live of servers) await live.stop()
    await rm(dir, { recursive: true, force: true })
  }
}

async function server(reply?: (socket: Socket) => Promise<void>) {
  let calls = 0
  const sockets = new Set<Socket>()
  const listener = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    socket.once('data', () => {
      calls++
      if (reply) void reply(socket)
      else socket.end(`HTTP/1.0 200 OK\r\n\r\n${JSON.stringify({ messages })}`)
    })
  })
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  let stopped = false
  return {
    entry: {
      port: address.port,
      pid: process.pid,
      token: 'fixture',
      startedAt: Date.now(),
    },
    calls: () => calls,
    stop: async () => {
      if (stopped) return
      stopped = true
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => listener.close(() => resolve()))
    },
  }
}

function discoveryCounter() {
  let count = 0
  return {
    discover: async (...args: Parameters<typeof discoverPortFile>) => {
      count++
      return discoverPortFile(...args)
    },
    count: () => count,
  }
}

test('stable pending calls share one validated discovery per selection key', async () => {
  await fixture(async (dir, serve) => {
    const live = await serve()
    await writePortFile(dir, live.entry)
    const counter = discoveryCounter()
    const clients = Array.from({ length: 2 }, () =>
      createRpcClient(dir, process.pid, undefined, counter),
    )
    for (let call = 0; call < 10; call++) {
      expect(await clients[call % 2]!.pending(0)).toEqual(messages)
    }
    expect(live.calls()).toBe(10)
    expect(counter.count(), 'stable pending calls must discover once').toBe(1)
  })
})

test('replaced port file routes the next pending call to the new server', async () => {
  await fixture(async (dir, serve) => {
    const first = await serve()
    await writePortFile(dir, first.entry)
    const counter = discoveryCounter()
    const client = createRpcClient(dir, process.pid, undefined, counter)
    expect(await client.pending(0)).toEqual(messages)
    await first.stop()
    const replacement = await serve()
    await writePortFile(dir, { ...replacement.entry, token: 'replacement' })
    expect(await client.pending(0)).toEqual(messages)
    expect(first.calls()).toBe(1)
    expect(replacement.calls()).toBe(1)
    expect(counter.count()).toBe(2)
  })
})

test('connect failure rediscovery succeeds in the same pending call', async () => {
  await fixture(async (dir, serve) => {
    const first = await serve()
    const replacement = await serve()
    await writePortFile(dir, first.entry)
    let discoveries = 0
    const client = createRpcClient(dir, process.pid, undefined, {
      discover: async (...args) => {
        if (++discoveries === 2) await writePortFile(dir, replacement.entry)
        return discoverPortFile(...args)
      },
    })
    expect(await client.pending(0)).toEqual(messages)
    await first.stop()
    expect(await client.pending(0)).toEqual(messages)
    expect(discoveries).toBe(2)
    expect(replacement.calls()).toBe(1)
  })
})

for (const status of [401, 403, 404, 503]) {
  test(`stale status ${status} rediscovery succeeds in the same pending call`, async () => {
    await fixture(async (dir, serve) => {
      const replacement = await serve()
      const stale = await serve(async (socket) => {
        await writePortFile(dir, { ...replacement.entry, token: 'new-token' })
        socket.end(`HTTP/1.0 ${status} Stale\r\n\r\n{}`)
      })
      await writePortFile(dir, stale.entry)
      const counter = discoveryCounter()
      const client = createRpcClient(dir, process.pid, undefined, counter)
      expect(await client.pending(0)).toEqual(messages)
      expect(stale.calls()).toBe(1)
      expect(replacement.calls()).toBe(1)
      expect(counter.count()).toBe(2)
    })
  })
}

test('cached selections never weaken exactPid refusal for a dead PID', async () => {
  await fixture(async (dir, serve) => {
    const live = await serve()
    await writePortFile(dir, live.entry)
    expect(await createRpcClient(dir).pending(0)).toEqual(messages)
    const deadPid = 2_147_483_647
    await writePortFile(dir, { ...live.entry, pid: deadPid })
    const exact = createRpcClient(dir, deadPid, undefined, { exactPid: true })
    expect(await exact.pending(0)).toEqual([])
    expect(await exact.pending(0)).toEqual([])
    expect(live.calls()).toBe(1)
  })
})
