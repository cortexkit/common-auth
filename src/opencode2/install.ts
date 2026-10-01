import type { SessionRetryDecision } from '@opencode/plugin/promise/session'
import { OpenCode2AuthError } from './errors.js'
import { placeholderSecret } from './integration.js'
import { watchServerSentEvents } from './sse.js'
import type {
  AccountHeadersResult,
  AccountRequest,
  Attempt,
  AttemptOutcome,
  ChooseAccountInput,
  HeaderEdits,
  InstallOpenCode2AuthOptions,
  LimitSignal,
  OpenCode2AuthAdapter,
  OpenCode2AuthEventName,
  OpenCode2AuthEvents,
  OpenCode2AuthInstallation,
  OpenCode2HookContext,
  RequestKind,
  RequestScope,
  RetryReason,
  SelectingHook,
  Transport,
} from './types.js'

export const DEFAULT_MAX_RECORDS = 512

type OpenAttempt<A> = { -readonly [K in keyof Attempt<A>]: Attempt<A>[K] }
type AttemptError = NonNullable<AttemptOutcome['error']>

/**
 * One attempt: an account chosen for one send of one session and request
 * kind. The latest attempt of each `sessionID:kind` is kept, because neither
 * quota headers nor stream events name the account, and the retry hook names
 * only the session: every reading is attributed through this record.
 */
interface AttemptRecord<A> {
  readonly scope: RequestScope
  /** `undefined` when the adapter had no account for this attempt. */
  readonly accountId: string | undefined
  readonly headers: HeaderEdits
  readonly seq: number
  /** The handle given to the adapter and listeners; absent without an account. */
  readonly attempt: OpenAttempt<A> | undefined
  /**
   * The transport hook that carried this attempt. A second transport hook
   * for the same session and kind is a new send and gets a new attempt.
   */
  transport?: Transport
  /** An `http.response` was attributed to this attempt. */
  responded: boolean
  status?: number
  outputStarted: boolean
  limit?: { readonly signal: LimitSignal; readonly delivered: Promise<void> }
  /** Set by the retry hook when it asked the host to retry elsewhere. */
  rerouteFrom?: { readonly accountId: string; readonly limit: LimitSignal }
  /** Set when the attempt ended; settles once `onAttemptEnd` has. */
  ended?: Promise<void>
}

type HookDraft = {
  readonly sessionID: string
  readonly agent: string
  readonly model: { readonly providerID: string; readonly id: string }
  readonly kind: RequestKind
}

const keyOf = (sessionID: string, kind: string) =>
  JSON.stringify([sessionID, kind])

const scopeOf = (draft: HookDraft): RequestScope => ({
  providerID: draft.model.providerID,
  modelID: draft.model.id,
  sessionID: draft.sessionID,
  agent: draft.agent,
  kind: draft.kind,
})

// A header value is a string or null, so an object under `headers` can only
// be the `{headers, attempt}` form.
function isHeadersResult<A>(
  value: HeaderEdits | AccountHeadersResult<A>,
): value is AccountHeadersResult<A> {
  const headers = (value as { headers?: unknown }).headers
  return typeof headers === 'object' && headers !== null
}

/**
 * Forwards a response body and reports how it ended: read to the end
 * (`undefined`), errored, or cancelled by whoever was reading it.
 */
function trackBody(
  source: ReadableStream<Uint8Array>,
  onEnd: (error?: AttemptError) => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: Awaited<ReturnType<typeof reader.read>>
      try {
        chunk = await reader.read()
      } catch (error) {
        onEnd({
          reason: 'failed',
          message: error instanceof Error ? error.message : String(error),
        })
        controller.error(error)
        return
      }
      if (chunk.done) {
        onEnd()
        controller.close()
      } else {
        controller.enqueue(chunk.value)
      }
    },
    async cancel(reason) {
      onEnd({
        reason: 'cancelled',
        ...(reason === undefined ? {} : { message: String(reason) }),
      })
      await reader.cancel(reason)
    },
  })
}

/** Applies edits to a plain header record, replacing every spelling of each name. */
export function applyHeaderEdits(
  target: Record<string, string>,
  edits: HeaderEdits,
): void {
  for (const [name, value] of Object.entries(edits)) {
    const lower = name.toLowerCase()
    for (const existing of Object.keys(target)) {
      if (existing.toLowerCase() === lower) delete target[existing]
    }
    if (value !== null) target[name] = value
  }
}

function applyHeaderEditsTo(target: Headers, edits: HeaderEdits): void {
  for (const [name, value] of Object.entries(edits)) {
    if (value === null) target.delete(name)
    else target.set(name, value)
  }
}

/**
 * Installs multi-account auth on OpenCode 2's own provider drivers. Every
 * hook is scoped to `adapter.providerID`:
 *
 * - `model.request` picks the account for the request's `sessionID:kind`,
 *   which starts a new attempt, and sets its headers;
 * - `http.request` and `experimental.ws.handshake` set them again, because
 *   the host applies its own credential after `model.request`;
 * - `experimental.ws.send` (only when the adapter rewrites frames) rewrites
 *   each outgoing frame;
 * - `http.response` and `experimental.ws.receive` read quota, refusals,
 *   whether output has started and when the response ended, attributed to
 *   an attempt by the rules below;
 * - `retry` asks the host to retry at once when an account was refused
 *   before any output, so `model.request` runs again and can pick another
 *   account, and refuses to retry once output has started.
 *
 * Attribution. An HTTP response belongs to the attempt whose `http.request`
 * produced its request; if the host hands back a different request object,
 * it belongs to the newest attempt of its session and kind only while that
 * attempt went out over HTTP and has no response yet. A WebSocket frame
 * belongs to the newest attempt of its session and kind only while that
 * attempt went out over WebSocket and has not ended: the host runs one
 * exchange at a time per session socket, so frames between one handshake
 * and the next belong to the earlier attempt. Anything else is attributed to
 * no attempt and reaches no adapter callback or listener.
 */
export async function installOpenCode2Auth<Q, A = unknown>(
  ctx: OpenCode2HookContext,
  adapter: OpenCode2AuthAdapter<Q, A>,
  options: InstallOpenCode2AuthOptions = {},
): Promise<OpenCode2AuthInstallation<Q, A>> {
  const { providerID } = adapter
  const logger = options.logger
  const maxRecords = Math.max(1, options.maxRecords ?? DEFAULT_MAX_RECORDS)
  const forbidden = (
    options.hostCredentials ?? [placeholderSecret(providerID)]
  ).filter((value) => value !== '')
  const records = new Map<string, AttemptRecord<A>>()
  const byRequest = new WeakMap<Request, AttemptRecord<A>>()
  const listeners = new Map<
    OpenCode2AuthEventName,
    Set<(payload: never) => void | Promise<void>>
  >()
  let seq = 0

  const warn = (message: string, data?: unknown) => {
    try {
      logger?.warn(message, data)
    } catch {}
  }
  const describe = (error: unknown) =>
    error instanceof Error ? error.message : String(error)

  const emit = async <E extends OpenCode2AuthEventName>(
    event: E,
    payload: OpenCode2AuthEvents<Q, A>[E],
  ): Promise<void> => {
    const set = listeners.get(event)
    if (!set || set.size === 0) return
    await Promise.all(
      [...set].map(async (listener) => {
        try {
          await (listener as (value: OpenCode2AuthEvents<Q, A>[E]) => unknown)(
            payload,
          )
        } catch (error) {
          warn('opencode2 auth listener threw; the request is unaffected', {
            event,
            error: describe(error),
          })
        }
      }),
    )
  }

  const deliverEnd = async (attempt: Attempt<A>, outcome: AttemptOutcome) => {
    try {
      await adapter.onAttemptEnd?.(attempt, outcome)
    } catch (error) {
      warn('opencode2 auth onAttemptEnd threw; the request is unaffected', {
        attemptId: attempt.attemptId,
        error: describe(error),
      })
    }
  }

  /** Ends an attempt once; later calls for the same attempt do nothing. */
  const finish = (rec: AttemptRecord<A>, error?: AttemptError) => {
    if (rec.ended || !rec.attempt) return
    const outcome: AttemptOutcome = {
      ...(rec.status === undefined ? {} : { status: rec.status }),
      outputStarted: rec.outputStarted,
      ...(rec.limit ? { limit: rec.limit.signal } : {}),
      ...(error ? { error } : {}),
    }
    rec.ended = deliverEnd(rec.attempt, outcome)
  }

  const abandon = (rec: AttemptRecord<A>, message: string) =>
    finish(rec, { reason: 'abandoned', message })

  const remember = (rec: AttemptRecord<A>) => {
    const key = keyOf(rec.scope.sessionID, rec.scope.kind)
    records.delete(key)
    records.set(key, rec)
    while (records.size > maxRecords) {
      const oldest = records.entries().next().value
      if (oldest === undefined) break
      abandon(oldest[1], 'dropped to keep the record bound')
      records.delete(oldest[0])
    }
  }

  const accountOf = (rec: AttemptRecord<A>): AccountRequest | undefined =>
    rec.accountId === undefined
      ? undefined
      : { ...rec.scope, accountId: rec.accountId }

  const noAccount = (scope: RequestScope) =>
    new OpenCode2AuthError({
      kind: 'no-account',
      providerID,
      sessionID: scope.sessionID,
      requestKind: scope.kind,
    })

  const guard = (scope: RequestScope, headers: Iterable<[string, string]>) => {
    for (const [name, value] of headers) {
      if (forbidden.some((secret) => value.includes(secret))) {
        throw new OpenCode2AuthError({
          kind: 'host-credential-on-wire',
          providerID,
          sessionID: scope.sessionID,
          requestKind: scope.kind,
          message: `${providerID} ${scope.kind} request still carries the host's placeholder credential in ${name}; the adapter's account headers must replace it`,
        })
      }
    }
  }

  const select = async (
    scope: RequestScope,
    hook: SelectingHook,
    transport?: Transport,
  ): Promise<AttemptRecord<A>> => {
    const prior = records.get(keyOf(scope.sessionID, scope.kind))
    if (prior) abandon(prior, 'a newer attempt of its session and kind began')
    const input: ChooseAccountInput = {
      ...scope,
      ...(prior?.accountId === undefined
        ? {}
        : { previousAccountId: prior.accountId }),
      ...(prior?.rerouteFrom === undefined
        ? {}
        : { rerouteFrom: prior.rerouteFrom }),
    }
    const accountId = await adapter.chooseAccount(input)
    let headers: HeaderEdits = {}
    let data: A | undefined
    if (accountId !== undefined) {
      const result = await adapter.accountHeaders({ ...scope, accountId })
      if (isHeadersResult(result)) {
        headers = result.headers
        data = result.attempt
      } else {
        headers = result
      }
    }
    const id = ++seq
    const rec: AttemptRecord<A> = {
      scope,
      accountId,
      headers,
      seq: id,
      attempt:
        accountId === undefined
          ? undefined
          : {
              ...scope,
              accountId,
              attemptId: `attempt-${id}`,
              transport,
              data,
            },
      ...(transport === undefined ? {} : { transport }),
      responded: false,
      outputStarted: false,
    }
    remember(rec)
    if (rec.attempt) {
      void emit('select', {
        ...scope,
        accountId: rec.attempt.accountId,
        hook,
        ...(input.previousAccountId === undefined
          ? {}
          : { previousAccountId: input.previousAccountId }),
        ...(input.rerouteFrom === undefined
          ? {}
          : { rerouteFrom: input.rerouteFrom }),
        handle: rec.attempt,
      })
    }
    return rec
  }

  // The transport hooks normally follow `model.request` and carry the
  // attempt it started. Choosing here too keeps a request that skipped it
  // from going out under the host credential, and a second send without a
  // `model.request` in between from reusing the first send's attempt.
  const bind = async (
    scope: RequestScope,
    hook: SelectingHook,
    transport: Transport,
  ): Promise<AttemptRecord<A>> => {
    const rec = records.get(keyOf(scope.sessionID, scope.kind))
    if (!rec || rec.transport !== undefined || rec.ended)
      return select(scope, hook, transport)
    rec.transport = transport
    if (rec.attempt) rec.attempt.transport = transport
    return rec
  }

  // A transport hook that throws stops the send, so its attempt is over.
  const failing = async <T>(rec: AttemptRecord<A>, run: () => Promise<T>) => {
    try {
      return await run()
    } catch (error) {
      finish(rec, { reason: 'failed', message: describe(error) })
      throw error
    }
  }

  const liveOn = (rec: AttemptRecord<A> | undefined, transport: Transport) =>
    rec?.attempt !== undefined && rec.transport === transport && !rec.ended
      ? rec
      : undefined

  const noteLimit = (
    rec: AttemptRecord<A>,
    signal: LimitSignal,
    via: Transport | 'error',
  ) => {
    const account = accountOf(rec)
    if (!account || !rec.attempt || rec.limit) return
    rec.limit = {
      signal,
      delivered: emit('limit', {
        ...account,
        via,
        limit: signal,
        outputStarted: rec.outputStarted,
        handle: rec.attempt,
      }),
    }
  }

  const noteQuota = (
    rec: AttemptRecord<A>,
    transport: Transport,
    quota: Q,
    status?: number,
  ) => {
    const account = accountOf(rec)
    if (!account || !rec.attempt) return
    void emit('quota', {
      ...account,
      transport,
      ...(status === undefined ? {} : { status }),
      quota,
      handle: rec.attempt,
    })
  }

  const inspect = (
    rec: AttemptRecord<A>,
    transport: Transport,
    data: string,
    event?: string,
  ) => {
    const attempt = rec.attempt
    if (!attempt) return
    const verdict = adapter.inspectEvent?.(
      event === undefined
        ? { transport, data, attempt }
        : { transport, data, event, attempt },
    )
    if (!verdict) return
    if (verdict.quota !== undefined) noteQuota(rec, transport, verdict.quota)
    if (verdict.outputStarted) rec.outputStarted = true
    if (verdict.limit) noteLimit(rec, verdict.limit, transport)
    if (verdict.error !== undefined)
      finish(rec, { reason: 'failed', message: verdict.error })
    else if (verdict.done) finish(rec)
  }

  const pickForRetry = (sessionID: string): AttemptRecord<A> | undefined => {
    let refused: AttemptRecord<A> | undefined
    let primary: AttemptRecord<A> | undefined
    let latest: AttemptRecord<A> | undefined
    for (const rec of records.values()) {
      if (rec.scope.sessionID !== sessionID) continue
      if (!latest || rec.seq > latest.seq) latest = rec
      if (rec.scope.kind === 'primary') primary = rec
      if (rec.limit && !rec.rerouteFrom && (!refused || rec.seq > refused.seq))
        refused = rec
    }
    return refused ?? primary ?? latest
  }

  const scoped = { providerID }
  const registrations: Array<{ dispose(): Promise<void> | void }> = []
  registrations.push(
    await ctx.session.hook(
      'model.request',
      async (draft) => {
        const rec = await select(scopeOf(draft), 'model.request')
        if (rec.accountId === undefined) throw noAccount(rec.scope)
        applyHeaderEdits(draft.headers, rec.headers)
      },
      scoped,
    ),
  )
  registrations.push(
    await ctx.session.hook(
      'http.request',
      async (draft) => {
        const rec = await bind(scopeOf(draft), 'http.request', 'http')
        const account = accountOf(rec)
        const attempt = rec.attempt
        if (!account || !attempt) throw noAccount(rec.scope)
        await failing(rec, async () => {
          let request = draft.request
          if (adapter.rewriteRequest) {
            request =
              (await adapter.rewriteRequest({
                ...account,
                request,
                attempt,
              })) ?? request
          }
          const headers = new Headers(request.headers)
          applyHeaderEditsTo(headers, rec.headers)
          guard(rec.scope, headers.entries())
          const final = new Request(request, { headers })
          byRequest.set(final, rec)
          draft.request = final
        })
      },
      scoped,
    ),
  )
  registrations.push(
    await ctx.session.hook(
      'http.response',
      async (draft) => {
        const latest = records.get(keyOf(draft.sessionID, draft.kind))
        const rec =
          byRequest.get(draft.request) ??
          (latest && !latest.responded ? liveOn(latest, 'http') : undefined)
        const account = rec && accountOf(rec)
        const attempt = rec?.attempt
        if (!rec || !account || !attempt) return
        const original = draft.response
        rec.responded = true
        rec.status = original.status
        const quota = adapter.quotaFromHeaders?.(
          original.headers,
          original.status,
          attempt,
        )
        if (quota !== undefined) noteQuota(rec, 'http', quota, original.status)
        if (!original.ok && adapter.limitFromResponse) {
          const signal = await adapter.limitFromResponse({
            status: original.status,
            headers: original.headers,
            body: () => original.clone().text(),
            attempt,
          })
          if (signal) noteLimit(rec, signal, 'http')
        }
        // An error response carries no output, so its status is the outcome;
        // ending here keeps the end from depending on whether the host reads
        // the error body to the end.
        if (!original.ok || !original.body) finish(rec)
        let response = original
        if (original.body && (adapter.inspectEvent || adapter.onAttemptEnd)) {
          let body = original.body
          if (adapter.inspectEvent) {
            body = body.pipeThrough(
              watchServerSentEvents(
                (event) => inspect(rec, 'http', event.data, event.event),
                (error) =>
                  warn('opencode2 auth event inspection threw', {
                    error: describe(error),
                  }),
              ),
            )
          }
          response = new Response(
            trackBody(body, (error) => finish(rec, error)),
            {
              status: original.status,
              statusText: original.statusText,
              headers: original.headers,
            },
          )
        }
        if (adapter.rewriteResponse) {
          response =
            (await adapter.rewriteResponse({
              ...account,
              request: draft.request,
              response,
              attempt,
            })) ?? response
        }
        if (response !== original) draft.response = response
      },
      scoped,
    ),
  )
  registrations.push(
    await ctx.session.hook(
      'experimental.ws.handshake',
      async (draft) => {
        const rec = await bind(
          scopeOf(draft),
          'experimental.ws.handshake',
          'ws',
        )
        const account = accountOf(rec)
        const attempt = rec.attempt
        if (!account || !attempt) throw noAccount(rec.scope)
        await failing(rec, async () => {
          applyHeaderEdits(draft.headers, rec.headers)
          const url = adapter.rewriteHandshakeURL?.({
            ...account,
            url: draft.url,
            attempt,
          })
          if (url !== undefined) draft.url = url
          guard(rec.scope, Object.entries(draft.headers))
        })
      },
      scoped,
    ),
  )
  const rewriteFrame = adapter.rewriteWebSocketFrame?.bind(adapter)
  if (rewriteFrame) {
    registrations.push(
      await ctx.session.hook(
        'experimental.ws.send',
        async (draft) => {
          const scope = scopeOf(draft)
          const rec = liveOn(
            records.get(keyOf(scope.sessionID, scope.kind)),
            'ws',
          )
          const frame = await rewriteFrame({
            ...scope,
            attempt: rec?.attempt,
            frame: draft.frame,
          })
          if (frame !== undefined) draft.frame = frame
        },
        scoped,
      ),
    )
  }
  registrations.push(
    await ctx.session.hook(
      'experimental.ws.receive',
      (draft) => {
        const rec = liveOn(
          records.get(keyOf(draft.sessionID, draft.kind)),
          'ws',
        )
        if (!rec) return
        try {
          inspect(rec, 'ws', draft.frame)
        } catch (error) {
          warn('opencode2 auth frame inspection threw', {
            error: describe(error),
          })
        }
      },
      scoped,
    ),
  )
  registrations.push(
    await ctx.session.hook(
      'retry',
      async (draft) => {
        const rec = pickForRetry(draft.sessionID)
        if (!rec) return
        const hostDecision = draft.decision
        let decision: SessionRetryDecision = hostDecision
        let reason: RetryReason
        const attempt = rec.attempt
        if (rec.accountId === undefined || !attempt) {
          decision = { retry: false }
          reason = 'no-account'
        } else if (rec.outputStarted) {
          // The user has already seen part of this answer; a retry would
          // send it again.
          decision = { retry: false }
          reason = 'output-started'
        } else {
          if (!rec.limit) {
            const signal = adapter.limitFromError?.(draft.error, attempt)
            if (signal) noteLimit(rec, signal, 'error')
          }
          // The next `chooseAccount` should see whatever the plugin learnt
          // from how this attempt ended.
          if (rec.ended) await rec.ended
          if (rec.limit) {
            await rec.limit.delivered
            rec.rerouteFrom = {
              accountId: rec.accountId,
              limit: rec.limit.signal,
            }
            // No delay: the next attempt goes to another account, and the
            // host would otherwise wait out the refused account's backoff,
            // or not retry at all for errors it deems final.
            decision = { retry: true, delay: 0 }
            reason = 'reroute'
          } else {
            reason = 'host-decides'
          }
        }
        draft.decision = decision
        await emit('retry', {
          sessionID: draft.sessionID,
          ...(rec.accountId === undefined ? {} : { accountId: rec.accountId }),
          kind: rec.scope.kind,
          attempt: draft.attempt,
          reason,
          hostDecision,
          decision,
          ...(attempt === undefined ? {} : { handle: attempt }),
        })
      },
      scoped,
    ),
  )

  const forgetSession = (sessionID: string) => {
    for (const [key, rec] of records) {
      if (rec.scope.sessionID !== sessionID) continue
      abandon(rec, 'its session was forgotten')
      records.delete(key)
    }
  }

  const abort = new AbortController()
  const events = ctx.event
  if (events) {
    void (async () => {
      try {
        for await (const event of events.subscribe({ signal: abort.signal })) {
          if (event.type === 'session.deleted')
            forgetSession(event.data.sessionID)
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          warn('opencode2 auth stopped listening for session deletion', {
            error: describe(error),
          })
        }
      }
    })()
  }

  let disposed = false
  return {
    on(event, listener) {
      let set = listeners.get(event)
      if (!set) {
        set = new Set()
        listeners.set(event, set)
      }
      const entry = listener as (payload: never) => void | Promise<void>
      set.add(entry)
      return () => {
        set.delete(entry)
      }
    },
    accountFor(sessionID, kind) {
      return records.get(keyOf(sessionID, kind))?.accountId
    },
    forgetSession,
    get size() {
      return records.size
    },
    async dispose() {
      if (disposed) return
      disposed = true
      abort.abort()
      for (const rec of records.values())
        abandon(rec, 'the installation was disposed')
      records.clear()
      listeners.clear()
      await Promise.all(
        registrations.map(async (registration) => {
          try {
            await registration.dispose()
          } catch (error) {
            warn('opencode2 auth hook did not dispose cleanly', {
              error: describe(error),
            })
          }
        }),
      )
    },
  }
}
