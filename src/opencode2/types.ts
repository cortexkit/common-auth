import type { Plugin } from '@opencode/plugin'
import type {
  SessionRequestKind,
  SessionRetryDecision,
} from '@opencode/plugin/promise/session'

/** The parts of the OpenCode 2 plugin context the installer uses. */
export type OpenCode2HookContext = {
  readonly session: Pick<Plugin.Context['session'], 'hook'>
  /** Used only to forget per-session records when a session is deleted. */
  readonly event?: Pick<Plugin.Context['event'], 'subscribe'>
}

export type RequestKind = SessionRequestKind

/** Which request a hook call belongs to, as the host reports it. */
export interface RequestScope {
  readonly providerID: string
  readonly modelID: string
  readonly sessionID: string
  readonly agent: string
  readonly kind: RequestKind
}

/** Where a reading or a refusal was seen. */
export type Transport = 'http' | 'ws'

/**
 * A provider refusal that should move the request to another account: a rate
 * limit, an exhausted usage window, or anything else the adapter decides is
 * tied to the account rather than to the request.
 */
export interface LimitSignal {
  /** Short machine-readable reason, such as the provider's error code. */
  readonly reason: string
  readonly status?: number
  /** How long the provider asked the account to wait, when it said. */
  readonly retryAfterMs?: number
}

/** What the adapter learned from one streamed event or WebSocket frame. */
export interface EventVerdict<Q> {
  /** The user has seen output from this response: a retry would repeat it. */
  readonly outputStarted?: boolean
  readonly quota?: Q
  readonly limit?: LimitSignal
}

/**
 * Header changes for one account. A string sets the header (replacing every
 * spelling of its name); `null` removes it.
 */
export type HeaderEdits = Readonly<Record<string, string | null>>

export interface ChooseAccountInput extends RequestScope {
  /** The account the previous attempt of this session and kind used. */
  readonly previousAccountId?: string
  /**
   * Set when the previous attempt was refused for a limit before any output
   * and the retry hook asked the host to try again. The adapter should not
   * pick `accountId` again unless it has nothing else.
   */
  readonly rerouteFrom?: {
    readonly accountId: string
    readonly limit: LimitSignal
  }
}

export interface AccountRequest extends RequestScope {
  readonly accountId: string
}

/** A host-supplied error, as the retry hook reports it. */
export interface HostError {
  readonly type: string
  readonly message: string
  readonly status?: number
}

/**
 * Everything provider-specific the installer needs. `Q` is the plugin's own
 * quota reading type; the installer only carries it to the `quota` event.
 */
export interface OpenCode2AuthAdapter<Q = unknown> {
  /** Every hook is scoped to this provider; other providers are untouched. */
  readonly providerID: string
  /**
   * Picks the account for one model request. Called again for every retry,
   * so a refused account can be skipped. Returning `undefined` stops the
   * request with `OpenCode2AuthError` kind `no-account`.
   */
  chooseAccount(
    input: ChooseAccountInput,
  ): Promise<string | undefined> | string | undefined
  /**
   * The credential and per-account headers for an account, applied in
   * `model.request`, `http.request` and `experimental.ws.handshake`. The last
   * two run after the host has applied its own credential, so these headers
   * win on the wire.
   */
  accountHeaders(input: AccountRequest): Promise<HeaderEdits> | HeaderEdits
  /**
   * Optional request rewrite (URL, body) before the account headers are
   * applied. Return `undefined` to keep the request.
   */
  rewriteRequest?(
    input: AccountRequest & { readonly request: Request },
  ): Promise<Request | undefined> | Request | undefined
  /**
   * Optional response rewrite (body stream, status). It receives the
   * response after quota, limit and output detection have been attached, so
   * detection always sees the provider's own events.
   */
  rewriteResponse?(
    input: AccountRequest & {
      readonly request: Request
      readonly response: Response
    },
  ): Promise<Response | undefined> | Response | undefined
  /** Optional WebSocket URL rewrite. Return `undefined` to keep the URL. */
  rewriteHandshakeURL?(
    input: AccountRequest & { readonly url: string },
  ): string | undefined
  /** Quota carried in HTTP response headers. */
  quotaFromHeaders?(headers: Headers, status: number): Q | undefined
  /**
   * Recognises an account-level refusal from an HTTP response before its
   * body is streamed. `body()` reads a copy, so the host still gets the body.
   */
  limitFromResponse?(input: {
    readonly status: number
    readonly headers: Headers
    readonly body: () => Promise<string>
  }): Promise<LimitSignal | undefined> | LimitSignal | undefined
  /**
   * Inspects one server-sent event (`data` payload) or one WebSocket frame.
   * Detects output, quota and refusals inside the stream.
   */
  inspectEvent?(input: {
    readonly transport: Transport
    readonly data: string
    readonly event?: string
  }): EventVerdict<Q> | undefined
  /**
   * Recognises an account-level refusal from the error the host hands the
   * retry hook, for refusals no other hook saw.
   */
  limitFromError?(error: HostError): LimitSignal | undefined
}

export interface OpenCode2AuthLogger {
  warn(message: string, data?: unknown): void
}

export interface InstallOpenCode2AuthOptions {
  /**
   * Values that must never reach the wire, normally the placeholder the host
   * holds as its credential. Defaults to the placeholder secret for the
   * adapter's provider.
   */
  readonly hostCredentials?: readonly string[]
  /** Most `sessionID:kind` records kept before the oldest is dropped. */
  readonly maxRecords?: number
  readonly logger?: OpenCode2AuthLogger
}

export type RetryReason =
  | 'reroute'
  | 'output-started'
  | 'no-account'
  | 'host-decides'

/**
 * The hook that picked an account. Normally `model.request`; a transport hook
 * picks only when the host skipped `model.request` for that request, which a
 * plugin may want to log as a host change.
 */
export type SelectingHook =
  | 'model.request'
  | 'http.request'
  | 'experimental.ws.handshake'

export interface OpenCode2AuthEvents<Q> {
  /** An account was picked for a model request. */
  readonly select: AccountRequest & {
    readonly hook: SelectingHook
    readonly previousAccountId?: string
    readonly rerouteFrom?: ChooseAccountInput['rerouteFrom']
  }
  /** A quota reading, attributed through this installer's own record. */
  readonly quota: AccountRequest & {
    readonly transport: Transport
    readonly status?: number
    readonly quota: Q
  }
  /**
   * An account-level refusal. The retry hook waits for every listener of
   * this event before asking the host to retry, so a plugin that marks the
   * account limited here has the mark in place when `chooseAccount` runs.
   */
  readonly limit: AccountRequest & {
    readonly via: Transport | 'error'
    readonly limit: LimitSignal
    readonly outputStarted: boolean
  }
  /** The retry hook ran for this provider. */
  readonly retry: {
    readonly sessionID: string
    readonly accountId?: string
    readonly kind?: RequestKind
    readonly attempt: number
    readonly reason: RetryReason
    readonly hostDecision: SessionRetryDecision
    readonly decision: SessionRetryDecision
  }
}

export type OpenCode2AuthEventName = keyof OpenCode2AuthEvents<unknown>

export interface OpenCode2AuthInstallation<Q> {
  /**
   * Listens to an event. Listener errors are logged and never reach the
   * host. Returns a function that removes the listener.
   */
  on<E extends OpenCode2AuthEventName>(
    event: E,
    listener: (payload: OpenCode2AuthEvents<Q>[E]) => void | Promise<void>,
  ): () => void
  /** The account last chosen for a session and request kind. */
  accountFor(sessionID: string, kind: RequestKind): string | undefined
  /** Drops every record of a session. Session deletion does this itself. */
  forgetSession(sessionID: string): void
  /** Number of `sessionID:kind` records held. */
  readonly size: number
  /** Removes every hook and stops listening for session deletion. */
  dispose(): Promise<void>
}
