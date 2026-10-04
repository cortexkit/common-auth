import type { RpcNotification, RpcServerOptions } from '../../src/rpc/index.js'

type DrainResult = ReturnType<RpcServerOptions['drain']>
type DrainParameters = Parameters<RpcServerOptions['drain']>
const messages: RpcNotification[] = []
const result: DrainResult = messages
const synchronous: RpcNotification[] = result
const args: DrainParameters = [0, 'session']
const drain: RpcServerOptions['drain'] = (..._args: DrainParameters) =>
  synchronous
void args
void drain

declare const options: RpcServerOptions
const direct: RpcNotification[] = options.drain(...args)
const length: ReturnType<RpcServerOptions['drain']>['length'] = direct.length
void length

import {
  type RpcServerAsyncOptions,
  startRpcServer,
} from '../../src/rpc/index.js'

declare const asyncOptions: RpcServerAsyncOptions
void startRpcServer(asyncOptions)
void startRpcServer(options)
// Both callbacks would make the notification source ambiguous.
// @ts-expect-error Drain callbacks are mutually exclusive.
void startRpcServer({ ...options, drainAsync: async () => messages })
// @ts-expect-error A notification source is required.
void startRpcServer({
  dir: '',
  isManagedDir: () => false,
  apply: options.apply,
})
