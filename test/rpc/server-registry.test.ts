import { describe, expect, mock } from 'bun:test'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'

const hooks = lifetimeHooks()
const { test, afterEach } = hooks
afterEach(() => {})
const trackedAdoptRpcServer: typeof adoptRpcServer = (...args) =>
  hooks.lifetime.operation(adoptRpcServer(...args))

import type { RpcServerHandle } from '../../src/rpc/rpc-server.js'
import { adoptRpcServer } from '../../src/rpc/server-registry.js'

const registryKey = 'fixture-rpc-registry'
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function handle(port: number) {
  return {
    port,
    token: `token-${port}`,
    stop: mock(async () => {}),
  } satisfies RpcServerHandle
}

const testKeys = new Set<string>()

function testKey(label: string): string {
  const key = `rpc-server-registry-test-${label}-${crypto.randomUUID()}`
  testKeys.add(key)
  return key
}

describe('RPC server registry', () => {
  test('serializes same-directory replacement and fences predecessor release', async () => {
    const key = testKey('same-directory')
    const firstEntered = deferred()
    const allowFirst = deferred()
    hooks.lifetime.unpark(() => allowFirst.resolve())
    const first = handle(1)
    const second = handle(2)
    let secondCreateCalls = 0

    const firstPromise = trackedAdoptRpcServer(registryKey, key, async () => {
      firstEntered.resolve()
      await allowFirst.promise
      return first
    })
    await firstEntered.promise
    const secondPromise = trackedAdoptRpcServer(registryKey, key, async () => {
      secondCreateCalls += 1
      return second
    })

    await Promise.resolve()
    expect(secondCreateCalls).toBe(0)
    allowFirst.resolve()
    const [firstAdoption, secondAdoption] = await Promise.all([
      firstPromise,
      secondPromise,
    ])

    expect(secondCreateCalls).toBe(1)
    expect(first.stop).toHaveBeenCalledTimes(1)
    expect(
      (
        globalThis as unknown as Record<
          symbol,
          { servers: Map<string, RpcServerHandle> }
        >
      )[Symbol.for(registryKey)]?.servers.get(key),
    ).toBe(second)

    await firstAdoption.release()
    expect(first.stop).toHaveBeenCalledTimes(1)
    expect(second.stop).not.toHaveBeenCalled()
    await secondAdoption.release()
    expect(second.stop).toHaveBeenCalledTimes(1)
  })

  test('does not serialize different project directories', async () => {
    const firstKey = testKey('project-a')
    const secondKey = testKey('project-b')
    const firstEntered = deferred()
    const allowFirst = deferred()
    hooks.lifetime.unpark(() => allowFirst.resolve())
    const first = handle(1)
    const second = handle(2)

    const firstPromise = trackedAdoptRpcServer(
      registryKey,
      firstKey,
      async () => {
        firstEntered.resolve()
        await allowFirst.promise
        return first
      },
    )
    await firstEntered.promise

    const secondAdoption = await trackedAdoptRpcServer(
      registryKey,
      secondKey,
      async () => second,
    )
    expect(secondAdoption.server).toBe(second)

    allowFirst.resolve()
    const firstAdoption = await firstPromise
    await firstAdoption.release()
    await secondAdoption.release()
  })
})
