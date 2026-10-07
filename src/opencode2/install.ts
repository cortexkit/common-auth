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
  ResponseAccount,
  RetryReason,
  SelectingHook,
  Transport,
} from './types.js'

export const DEFAULT_MAX_RECORDS = 512

/**
 * The request header `model.request` sets to the attempt it started. The
 * host builds the HTTP request and the WebSocket handshake from the headers
 * `model.request` leaves, so `http.request` and `experimental.ws.handshake`
 * read it to find their own attempt among several of one session and kind,
 * and remove it: it never reaches the wire.
 */
export const ATTEMPT_HEADER = 'x-common-auth-attempt'

type OpenAttempt<A> = { -readonly [K in keyof Attempt<A>]: Attempt<A>[K] }
type AttemptError = NonNullable<AttemptOutcome['error']>

/**
 * One attempt: an account chosen for one send of one session and request
 * kind. Several attempts of one session and kind can be open at once.
 * Neither quota headers nor stream events name the account, and the retry
 * hook names only the session, so every reading is attributed through the
 * attempt it was tied to.
 */
interface AttemptRecord<A> {
  /** Unique within the installation; also the attempt's `attemptId`. */
  readonly id: string
  readonly key: string
  readonly scope: RequestScope
  /**
   * `undefined` when the adapter had no account for this attempt. Changes
   * only when `answeredBy` rebinds the attempt.
   */
  accountId: string | undefined
  readonly headers: HeaderEdits
  /** The handle given to the adapter and listeners; absent without an account. */
  readonly attempt: OpenAttempt<A> | undefined
  /**
   * The transport hook that carried this attempt. A second transport hook
   * for the same attempt is a new send and gets a new attempt.
   */
  transport?: Transport
  status?: number
  outputStarted: boolean
  limit?: { readonly signal: LimitSignal; readonly delivered: Promise<void> }
  /** Set once the retry hook has decided about this attempt. */
  judged?: boolean
  /** Set when the retry hook asked the host to retry it on another account. */
  rerouted?: boolean
  /** Set when the attempt ended; settles once `onAttemptEnd` has. */
  ended?: Promise<void>
  /** Why the attempt ended without completing, when it did. */
  endError?: AttemptError
}

/**
 * What the retry hook decided about an attempt it asked the host to retry,
 * waiting for the next attempt of the same session and kind.
 */
interface PendingRetry {
  readonly sessionID: string
  readonly accountId: string
  readonly rerouteFrom?: {
    readonly accountId: string
    readonly limit: LimitSignal
  }
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
 * - `model.request` picks the account for one model call of a session and
 *   request kind, which starts a new attempt, sets its headers and marks the
 *   request with the attempt (`ATTEMPT_HEADER`);
 * - `http.request` and `experimental.ws.handshake` find the attempt by that
 *   mark, remove it and set the account headers again, because the host
 *   applies its own credential after `model.request`;
 * - `experimental.ws.send` (only when the adapter rewrites frames) rewrites
 *   each outgoing frame;
 * - `http.response` and `experimental.ws.receive` read quota, refusals,
 *   whether output has started and when the response ended, attributed to
 *   an attempt by the rules below;
 * - `retry` asks the host to retry at once when an account was refused
 *   before any output, so `model.request` runs again and can pick another
 *   account, and refuses to retry once output has started.
 *
 * Attribution. A send belongs to the attempt named by the mark
 * `model.request` left on it, so several attempts of one session and kind
 * can be in flight at once, each on its own account. An HTTP response
 * belongs to the attempt whose `http.request` produced its request object,
 * and to nothing else. The host hands `http.response` the request object the
 * `http.request` hooks left, so a different object means a later hook
 * replaced it; nothing then proves which send the response answers, and its
 * feedback is dropped rather than guessed by recency. A WebSocket frame
 * names no attempt, so frames go to the newest open attempt of their session
 * and kind that went out over WebSocket, and an older one is abandoned as
 * soon as a newer attempt of that session and kind begins or goes out over
 * WebSocket: the host runs one exchange at a time on a session's socket.
 * Anything else is attributed to no attempt and reaches no adapter callback
 * or listener.
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
  /** Every attempt still held, oldest first. */
  const attempts = new Map<string, AttemptRecord<A>>()
  const byRequest = new WeakMap<Request, AttemptRecord<A>>()
  /** Retries the retry hook asked for, by `sessionID:kind`. */
  const pendingRetries = new Map<string, PendingRetry>()
  let warnedUnprovenResponse = false
  let warnedUnmarkedSend = false
  const listeners = new Map<
    OpenCode2AuthEventName,
    Set<(payload: never) => void | Promise<void>>
  >()
  let seq = 0
  let disposed = false
  /** Only active hook calls are held; forgetting never leaves a session tombstone. */
  const inFlight = new Map<string, Set<object>>()

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
    if (error) rec.endError = error
    rec.ended = deliverEnd(rec.attempt, outcome)
  }

  const abandon = (rec: AttemptRecord<A>, message: string) =>
    finish(rec, { reason: 'abandoned', message })

  /** The attempts of one session and kind, oldest first. */
  const attemptsOf = (key: string) =>
    [...attempts.values()].filter((rec) => rec.key === key)
  const newestOf = (key: string) => attemptsOf(key).at(-1)

  /** Forgets an attempt, and its key's pending retry once nothing else holds the key. */
  const drop = (rec: AttemptRecord<A>) => {
    attempts.delete(rec.id)
    if (!attemptsOf(rec.key).length) pendingRetries.delete(rec.key)
  }

  const remember = (rec: AttemptRecord<A>) => {
    attempts.set(rec.id, rec)
    while (attempts.size > maxRecords) {
      const oldest = attempts.values().next().value
      if (oldest === undefined) break
      abandon(oldest, 'dropped to keep the record bound')
      drop(oldest)
    }
  }

  const accountOf = (rec: AttemptRecord<A>): AccountRequest | undefined =>
    rec.accountId === undefined
      ? undefined
      : { ...rec.scope, accountId: rec.accountId }

  const noAccount = (scope: RequestScope, message?: string) =>
    new OpenCode2AuthError({
      kind: 'no-account',
      providerID,
      sessionID: scope.sessionID,
      requestKind: scope.kind,
      ...(message === undefined ? {} : { message }),
    })

  const revokeSelections = (sessionID: string) => {
    inFlight.get(sessionID)?.clear()
    inFlight.delete(sessionID)
  }

  /**
   * Owns selection through its transport handoff, not just the adapter calls.
   * Deleting a session's set revokes its old calls without poisoning reuse of
   * that id. Each await must recheck before calling the adapter or publishing.
   */
  const withSelection = async <T>(
    scope: RequestScope,
    run: (assertActive: () => void) => Promise<T>,
  ): Promise<T> => {
    const revoked = () =>
      noAccount(
        scope,
        `${providerID} ${scope.kind} request has no account: its auth selection was revoked by session forgetting or installation disposal`,
      )
    if (disposed) throw revoked()
    let selections = inFlight.get(scope.sessionID)
    if (!selections) {
      selections = new Set()
      inFlight.set(scope.sessionID, selections)
    }
    const token = {}
    selections.add(token)
    const assertActive = () => {
      if (!selections.has(token)) throw revoked()
    }
    try {
      return await run(assertActive)
    } finally {
      selections.delete(token)
      // An old call may settle after a new call has reused the session id.
      if (selections.size === 0 && inFlight.get(scope.sessionID) === selections)
        inFlight.delete(scope.sessionID)
    }
  }

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

  /**
   * Retires the attempts a new attempt of the same session and kind
   * supersedes. One that has ended is dropped. One still open stays when it
   * may yet be sent or answered (waiting for its transport, or an HTTP send
   * whose response will name it), since another call of the same session and
   * kind may run beside this one. One on WebSocket is abandoned, because
   * frames name no attempt and the host runs one exchange at a time on a
   * session's socket; one the retry hook already judged is abandoned too,
   * because the host has finished with that call.
   */
  const supersede = (key: string) => {
    for (const rec of attemptsOf(key)) {
      if (rec.ended || !rec.attempt) {
        drop(rec)
      } else if (rec.transport === 'ws' || rec.judged) {
        abandon(rec, 'a newer attempt of its session and kind began')
        drop(rec)
      }
    }
  }

  const select = async (
    scope: RequestScope,
    hook: SelectingHook,
    assertActive: () => void,
    transport?: Transport,
  ): Promise<AttemptRecord<A>> => {
    const key = keyOf(scope.sessionID, scope.kind)
    const retried = pendingRetries.get(key)
    pendingRetries.delete(key)
    const previousAccountId = retried?.accountId ?? newestOf(key)?.accountId
    supersede(key)
    const input: ChooseAccountInput = {
      ...scope,
      ...(previousAccountId === undefined ? {} : { previousAccountId }),
      ...(retried?.rerouteFrom === undefined
        ? {}
        : { rerouteFrom: retried.rerouteFrom }),
    }
    const accountId = await adapter.chooseAccount(input)
    assertActive()
    let headers: HeaderEdits = {}
    let data: A | undefined
    if (accountId !== undefined) {
      const result = await adapter.accountHeaders({ ...scope, accountId })
      assertActive()
      if (isHeadersResult(result)) {
        headers = result.headers
        data = result.attempt
      } else {
        headers = result
      }
    }
    const id = `attempt-${++seq}`
    const rec: AttemptRecord<A> = {
      id,
      key,
      scope,
      accountId,
      headers,
      attempt:
        accountId === undefined
          ? undefined
          : {
              ...scope,
              accountId,
              attemptId: id,
              transport,
              data,
            },
      ...(transport === undefined ? {} : { transport }),
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

  // The transport hooks normally follow `model.request` and carry the mark
  // of the attempt it started. Choosing here too keeps a request that skipped
  // it from going out under the host credential, and a second send of the
  // same attempt from reusing the first send's attempt.
  const bind = async (
    scope: RequestScope,
    hook: SelectingHook,
    transport: Transport,
    mark: string | undefined,
    assertActive: () => void,
  ): Promise<AttemptRecord<A>> => {
    const key = keyOf(scope.sessionID, scope.kind)
    let rec = mark === undefined ? undefined : attempts.get(mark)
    if (rec?.key !== key) rec = undefined
    if (!rec) {
      // No mark: the newest attempt of the session and kind is the only
      // candidate the hook can name. Say so once when that is a guess.
      rec = newestOf(key)
      const waiting = attemptsOf(key).filter(
        (other) => other.transport === undefined && !other.ended,
      )
      if (waiting.length > 1 && !warnedUnmarkedSend) {
        warnedUnmarkedSend = true
        warn(
          'opencode2 auth tied a send without its attempt mark to the newest of several waiting attempts',
          { sessionID: scope.sessionID, kind: scope.kind },
        )
      }
    }
    if (!rec || rec.transport !== undefined || rec.ended)
      rec = await select(scope, hook, assertActive, transport)
    else {
      rec.transport = transport
      if (rec.attempt) rec.attempt.transport = transport
    }
    if (transport === 'ws') {
      for (const other of attemptsOf(key)) {
        if (other !== rec && other.transport === 'ws')
          abandon(
            other,
            'a newer attempt of its session and kind went out over WebSocket',
          )
      }
    }
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

  /** The attempt a frame of this session and kind belongs to, if any. */
  const liveOnSocket = (sessionID: string, kind: string) => {
    const rec = attemptsOf(keyOf(sessionID, kind))
      .filter((each) => each.transport === 'ws')
      .at(-1)
    return rec?.attempt !== undefined && !rec.ended ? rec : undefined
  }

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

  /** Moves an attempt to the account that answered its response. */
  const rebind = (rec: AttemptRecord<A>, answered: ResponseAccount<A>) => {
    const attempt = rec.attempt
    if (!attempt || answered.accountId === rec.accountId) return
    attempt.reboundFrom ??= attempt.accountId
    attempt.accountId = answered.accountId
    if ('data' in answered) attempt.data = answered.data
    rec.accountId = answered.accountId
  }

  const failedOutcome = (rec: AttemptRecord<A>) =>
    !rec.attempt ||
    rec.endError !== undefined ||
    (rec.status !== undefined && rec.status >= 400)

  /**
   * The attempt a retry is about. The retry hook names only the session, so:
   * the newest refused attempt not yet rerouted; else, among the session's
   * primary attempts (or all of them when it has none), the only one, the
   * newest that failed and was not yet judged, the only one still open, or
   * the newest. Two or more open with nothing else to tell them apart is
   * `ambiguous`: deciding for one could reroute or end the other.
   */
  const pickForRetry = (
    sessionID: string,
  ): AttemptRecord<A> | 'ambiguous' | undefined => {
    const held = [...attempts.values()].filter(
      (rec) => rec.scope.sessionID === sessionID,
    )
    const refused = held.filter((rec) => rec.limit && !rec.rerouted).at(-1)
    if (refused) return refused
    const primary = held.filter((rec) => rec.scope.kind === 'primary')
    const pool = primary.length > 0 ? primary : held
    if (pool.length <= 1) return pool[0]
    const failed = pool
      .filter((rec) => !rec.judged && failedOutcome(rec))
      .at(-1)
    if (failed) return failed
    const open = pool.filter((rec) => rec.attempt && !rec.ended)
    if (open.length > 1) return 'ambiguous'
    return open[0] ?? pool.at(-1)
  }

  const scoped = { providerID }
  const registrations: Array<{ dispose(): Promise<void> | void }> = []
  registrations.push(
    await ctx.session.hook(
      'model.request',
      (draft) =>
        withSelection(scopeOf(draft), async (assertActive) => {
          const rec = await select(
            scopeOf(draft),
            'model.request',
            assertActive,
          )
          assertActive()
          if (rec.accountId === undefined) throw noAccount(rec.scope)
          applyHeaderEdits(draft.headers, {
            ...rec.headers,
            [ATTEMPT_HEADER]: rec.id,
          })
        }),
      scoped,
    ),
  )
  registrations.push(
    await ctx.session.hook(
      'http.request',
      (draft) =>
        withSelection(scopeOf(draft), async (assertActive) => {
          const mark = draft.request.headers.get(ATTEMPT_HEADER) ?? undefined
          const rec = await bind(
            scopeOf(draft),
            'http.request',
            'http',
            mark,
            assertActive,
          )
          assertActive()
          const account = accountOf(rec)
          const attempt = rec.attempt
          if (!account || !attempt) throw noAccount(rec.scope)
          await failing(rec, async () => {
            let request = draft.request
            if (adapter.rewriteRequest) {
              if (mark !== undefined) {
                // The mark is the installer's own; the adapter's rewrite never
                // sees it.
                const unmarked = new Headers(request.headers)
                unmarked.delete(ATTEMPT_HEADER)
                request = new Request(request, { headers: unmarked })
              }
              request =
                (await adapter.rewriteRequest({
                  ...account,
                  request,
                  attempt,
                })) ?? request
              assertActive()
            }
            const headers = new Headers(request.headers)
            headers.delete(ATTEMPT_HEADER)
            applyHeaderEditsTo(headers, rec.headers)
            guard(rec.scope, headers.entries())
            const final = new Request(request, { headers })
            byRequest.set(final, rec)
            draft.request = final
          })
        }),
      scoped,
    ),
  )
  registrations.push(
    await ctx.session.hook(
      'http.response',
      async (draft) => {
        const rec = byRequest.get(draft.request)
        if (!rec) {
          if (!warnedUnprovenResponse) {
            warnedUnprovenResponse = true
            warn(
              'opencode2 auth dropped an http.response whose request it did not produce',
              { sessionID: draft.sessionID, kind: draft.kind },
            )
          }
          return
        }
        const original = draft.response
        if (adapter.answeredBy && rec.attempt) {
          const attempt = rec.attempt
          const answered = await failing(rec, async () =>
            adapter.answeredBy?.({
              request: draft.request,
              response: original,
              attempt,
            }),
          )
          if (answered) rebind(rec, answered)
        }
        const account = accountOf(rec)
        const attempt = rec.attempt
        if (!account || !attempt) return
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
      (draft) =>
        withSelection(scopeOf(draft), async (assertActive) => {
          let mark: string | undefined
          for (const name of Object.keys(draft.headers)) {
            if (name.toLowerCase() !== ATTEMPT_HEADER) continue
            mark ??= draft.headers[name]
            delete draft.headers[name]
          }
          const rec = await bind(
            scopeOf(draft),
            'experimental.ws.handshake',
            'ws',
            mark,
            assertActive,
          )
          assertActive()
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
        }),
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
          const rec = liveOnSocket(scope.sessionID, scope.kind)
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
        const rec = liveOnSocket(draft.sessionID, draft.kind)
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
        const picked = pickForRetry(draft.sessionID)
        if (!picked) return
        const hostDecision = draft.decision
        if (picked === 'ambiguous') {
          // Nothing tells which open attempt failed: keep the host's
          // decision and leave every attempt as it is.
          await emit('retry', {
            sessionID: draft.sessionID,
            attempt: draft.attempt,
            reason: 'host-decides',
            hostDecision,
            decision: hostDecision,
          })
          return
        }
        const rec = picked
        await withSelection(rec.scope, async (assertActive) => {
          rec.judged = true
          let decision: SessionRetryDecision = hostDecision
          let reason: RetryReason
          let rerouteFrom: PendingRetry['rerouteFrom']
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
            if (rec.ended) {
              await rec.ended
              assertActive()
            }
            if (rec.limit) {
              await rec.limit.delivered
              assertActive()
              rec.rerouted = true
              rerouteFrom = {
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
          // The host's retry runs `model.request` again for this attempt's
          // session and kind; that next attempt, and no other attempt of the
          // session, is told what this one ended with.
          if (decision.retry && rec.accountId !== undefined) {
            pendingRetries.set(rec.key, {
              sessionID: rec.scope.sessionID,
              accountId: rec.accountId,
              ...(rerouteFrom === undefined ? {} : { rerouteFrom }),
            })
          }
          await emit('retry', {
            sessionID: draft.sessionID,
            ...(rec.accountId === undefined
              ? {}
              : { accountId: rec.accountId }),
            kind: rec.scope.kind,
            attempt: draft.attempt,
            reason,
            hostDecision,
            decision,
            ...(attempt === undefined ? {} : { handle: attempt }),
          })
        })
      },
      scoped,
    ),
  )

  const forgetSession = (sessionID: string) => {
    revokeSelections(sessionID)
    for (const rec of [...attempts.values()]) {
      if (rec.scope.sessionID !== sessionID) continue
      abandon(rec, 'its session was forgotten')
      attempts.delete(rec.id)
    }
    for (const [key, pending] of pendingRetries) {
      if (pending.sessionID === sessionID) pendingRetries.delete(key)
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
      return newestOf(keyOf(sessionID, kind))?.accountId
    },
    forgetSession,
    get size() {
      return attempts.size
    },
    async dispose() {
      if (disposed) return
      disposed = true
      for (const sessionID of inFlight.keys()) revokeSelections(sessionID)
      abort.abort()
      for (const rec of attempts.values())
        abandon(rec, 'the installation was disposed')
      attempts.clear()
      pendingRetries.clear()
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
