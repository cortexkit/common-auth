export type { OpenCode2AuthFailureKind } from './errors.js'
export { OpenCode2AuthError } from './errors.js'
export {
  applyHeaderEdits,
  DEFAULT_MAX_RECORDS,
  installOpenCode2Auth,
} from './install.js'
export type {
  FormAnswer,
  PoolAuthorization,
  PoolLoginMethod,
  RegisterOpenCode2AuthMethodsOptions,
} from './integration.js'
export {
  isPlaceholderCredential,
  PLACEHOLDER_LIFETIME_MS,
  PLACEHOLDER_METADATA_KEY,
  PLACEHOLDER_PREFIX,
  placeholderCredential,
  placeholderSecret,
  registerOpenCode2AuthMethods,
} from './integration.js'
export type { ServerSentEvent } from './sse.js'
export { watchServerSentEvents } from './sse.js'
export type {
  AccountHeadersResult,
  AccountRequest,
  Attempt,
  AttemptEndReason,
  AttemptOutcome,
  ChooseAccountInput,
  EventVerdict,
  HeaderEdits,
  HostError,
  InstallOpenCode2AuthOptions,
  LimitSignal,
  OpenCode2AuthAdapter,
  OpenCode2AuthEventName,
  OpenCode2AuthEvents,
  OpenCode2AuthInstallation,
  OpenCode2AuthLogger,
  OpenCode2HookContext,
  RequestKind,
  RequestScope,
  RetryReason,
  SelectingHook,
  Transport,
} from './types.js'
