// Compile-time checks, run by `bun run typecheck`. They pin that the
// synchronous `drain` option keeps its exact type, so a consumer that derives
// types from it compiles unchanged, and that the async entry point refuses a
// call with both notification sources or with neither.

import {
  type RpcNotification,
  type RpcServerAsyncOptions,
  type RpcServerOptions,
  startRpcServer,
} from '../../src/rpc/index.js'

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

declare const asyncOptions: RpcServerAsyncOptions
void startRpcServer(asyncOptions)
void startRpcServer(options)
// Each directive below fails the typecheck if the call it marks stops being
// an error, so these assert the refusals rather than silence a mistake.
// @ts-expect-error Both callbacks would make the notification source ambiguous.
void startRpcServer({ ...options, drainAsync: async () => messages })
// @ts-expect-error A notification source is required.
void startRpcServer({
  dir: '',
  isManagedDir: () => false,
  apply: options.apply,
})
