import type { RpcServerHandle } from './rpc-server.js'

interface Registry {
  servers: Map<string, RpcServerHandle>
  pending: Map<string, Promise<void>>
}
export interface RpcServerAdoption {
  server: RpcServerHandle
  release: () => Promise<void>
}

/**
 * Serializes same-directory replacement. Release checks the adopted server
 * identity so an older holder cannot stop or remove its successor.
 * Distinct project directories remain independent.
 */
export async function adoptRpcServer(
  registryKey: string,
  rpcDir: string,
  create: () => Promise<RpcServerHandle>,
): Promise<RpcServerAdoption> {
  const globals = globalThis as unknown as Record<symbol, Registry | undefined>
  const key = Symbol.for(registryKey)
  const registry = globals[key] ?? { servers: new Map(), pending: new Map() }
  globals[key] = registry
  const { servers, pending } = registry

  const predecessor = pending.get(rpcDir) ?? Promise.resolve()
  let server: RpcServerHandle | undefined
  const start = predecessor
    .catch(() => {})
    .then(async () => {
      const previous = servers.get(rpcDir)
      if (previous) {
        await previous.stop()
        if (servers.get(rpcDir) === previous) servers.delete(rpcDir)
      }
      server = await create()
      servers.set(rpcDir, server)
    })
  pending.set(rpcDir, start)

  try {
    await start
  } finally {
    if (pending.get(rpcDir) === start) pending.delete(rpcDir)
  }
  const adoptedServer = server
  if (!adoptedServer) throw new Error('RPC server failed to start')

  return {
    server: adoptedServer,
    release: async () => {
      if (servers.get(rpcDir) !== adoptedServer) return
      await adoptedServer.stop()
      if (servers.get(rpcDir) === adoptedServer) servers.delete(rpcDir)
    },
  }
}
