// The client side of ./rpc on its own: a sidebar process imports this to talk
// to its plugin's server without loading the server, its notification queue or
// the server registry. Everything here is also exported from ./rpc.
export type {
  ApplyRequest,
  ApplyResult,
  OpenDialogPayload,
  RpcNotification,
} from './notifications.js'
export {
  type DiscoverPortFileOptions,
  discoverPortFile,
  type PortFileEntry,
} from './port-file.js'
export * from './rpc-client.js'
