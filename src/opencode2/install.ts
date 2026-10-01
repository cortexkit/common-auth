import type { SessionRetryDecision } from '@opencode/plugin/promise/session'
import { OpenCode2AuthError } from './errors.js'
import { placeholderSecret } from './integration.js'
import { watchServerSentEvents } from './sse.js'
import type {
  AccountRequest,
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

/**
 * What the installer knows about the latest attempt of one session and
 * request kind. Neither quota headers nor stream events name the account, so
 * every reading is attributed through this record.
 */
interface AttemptRecord {
  readonly scope: RequestScope
  /** `undefined` when the adapter had no account for this attempt. */
  readonly accountId: string | undefined
  readonly headers: HeaderEdits
  readonly seq: number
  outputStarted: boolean
  limit?: { readonly signal: LimitSignal; readonly delivered: Promise<void> }
  /** Set by the retry hook when it asked the host to retry elsewhere. */
  rerouteFrom?: { readonly accountId: string; readonly limit: LimitSignal }
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
 * - `model.request` picks the account for the request's `sessionID:kind` and
 *   sets its headers;
 * - `http.request` and `experimental.ws.handshake` set them again, because
 *   the host applies its own credential after `model.request`;
 * - `http.response` and `experimental.ws.receive` read quota, refusals and
 *   whether output has started, attributed through the record above;
 * - `retry` asks the host to retry at once when an account was refused
 *   before any output, so `model.request` runs again and can pick another
 *   account, and refuses to retry once output has started.
 */
export async function installOpenCode2Auth<Q>(
  ctx: OpenCode2HookContext,
  adapter: OpenCode2AuthAdapter<Q>,
  options: InstallOpenCode2AuthOptions = {},
): Promise<OpenCode2AuthInstallation<Q>> {
  const { providerID } = adapter
  const logger = options.logger
  const maxRecords = Math.max(1, options.maxRecords ?? DEFAULT_MAX_RECORDS)
  const forbidden = (
    options.hostCredentials ?? [placeholderSecret(providerID)]
  ).filter((value) => value !== '')
  const records = new Map<string, AttemptRecord>()
  const byRequest = new WeakMap<Request, AttemptRecord>()
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
    payload: OpenCode2AuthEvents<Q>[E],
  ): Promise<void> => {
    const set = listeners.get(event)
    if (!set || set.size === 0) return
    await Promise.all(
      [...set].map(async (listener) => {
        try {
          await (listener as (value: OpenCode2AuthEvents<Q>[E]) => unknown)(
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

  const remember = (rec: AttemptRecord) => {
    const key = keyOf(rec.scope.sessionID, rec.scope.kind)
    records.delete(key)
    records.set(key, rec)
    while (records.size > maxRecords) {
      const oldest = records.keys().next().value
      if (oldest === undefined) break
      records.delete(oldest)
    }
  }

  const accountOf = (rec: AttemptRecord): AccountRequest | undefined =>
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
  ): Promise<AttemptRecord> => {
    const prior = records.get(keyOf(scope.sessionID, scope.kind))
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
    const headers =
      accountId === undefined
        ? {}
        : await adapter.accountHeaders({ ...scope, accountId })
    const rec: AttemptRecord = {
      scope,
      accountId,
      headers,
      seq: ++seq,
      outputStarted: false,
    }
    remember(rec)
    if (accountId !== undefined) {
      void emit('select', {
        ...scope,
        accountId,
        hook,
        ...(input.previousAccountId === undefined
          ? {}
          : { previousAccountId: input.previousAccountId }),
        ...(input.rerouteFrom === undefined
          ? {}
          : { rerouteFrom: input.rerouteFrom }),
      })
    }
    return rec
  }

  // The transport hooks normally follow `model.request`; choosing here too
  // keeps a request that skipped it from going out under the host credential.
  const ensure = async (scope: RequestScope, hook: SelectingHook) =>
    records.get(keyOf(scope.sessionID, scope.kind)) ??
    (await select(scope, hook))

  const noteLimit = (
    rec: AttemptRecord,
    signal: LimitSignal,
    via: Transport | 'error',
  ) => {
    const account = accountOf(rec)
    if (!account || rec.limit) return
    rec.limit = {
      signal,
      delivered: emit('limit', {
        ...account,
        via,
        limit: signal,
        outputStarted: rec.outputStarted,
      }),
    }
  }

  const noteQuota = (
    rec: AttemptRecord,
    transport: Transport,
    quota: Q,
    status?: number,
  ) => {
    const account = accountOf(rec)
    if (!account) return
    void emit('quota', {
      ...account,
      transport,
      ...(status === undefined ? {} : { status }),
      quota,
    })
  }

  const inspect = (
    rec: AttemptRecord,
    transport: Transport,
    data: string,
    event?: string,
  ) => {
    const verdict = adapter.inspectEvent?.(
      event === undefined ? { transport, data } : { transport, data, event },
    )
    if (!verdict) return
    if (verdict.quota !== undefined) noteQuota(rec, transport, verdict.quota)
    if (verdict.outputStarted) rec.outputStarted = true
    if (verdict.limit) noteLimit(rec, verdict.limit, transport)
  }

  const pickForRetry = (sessionID: string): AttemptRecord | undefined => {
    let refused: AttemptRecord | undefined
    let primary: AttemptRecord | undefined
    let latest: AttemptRecord | undefined
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
  const registrations = [
    await ctx.session.hook(
      'model.request',
      async (draft) => {
        const rec = await select(scopeOf(draft), 'model.request')
        if (rec.accountId === undefined) throw noAccount(rec.scope)
        applyHeaderEdits(draft.headers, rec.headers)
      },
      scoped,
    ),
    await ctx.session.hook(
      'http.request',
      async (draft) => {
        const rec = await ensure(scopeOf(draft), 'http.request')
        const account = accountOf(rec)
        if (!account) throw noAccount(rec.scope)
        let request = draft.request
        if (adapter.rewriteRequest) {
          request =
            (await adapter.rewriteRequest({ ...account, request })) ?? request
        }
        const headers = new Headers(request.headers)
        applyHeaderEditsTo(headers, rec.headers)
        guard(rec.scope, headers.entries())
        const final = new Request(request, { headers })
        byRequest.set(final, rec)
        draft.request = final
      },
      scoped,
    ),
    await ctx.session.hook(
      'http.response',
      async (draft) => {
        const rec =
          byRequest.get(draft.request) ??
          records.get(keyOf(draft.sessionID, draft.kind))
        const account = rec && accountOf(rec)
        if (!rec || !account) return
        const original = draft.response
        const quota = adapter.quotaFromHeaders?.(
          original.headers,
          original.status,
        )
        if (quota !== undefined) noteQuota(rec, 'http', quota, original.status)
        if (!original.ok && adapter.limitFromResponse) {
          const signal = await adapter.limitFromResponse({
            status: original.status,
            headers: original.headers,
            body: () => original.clone().text(),
          })
          if (signal) noteLimit(rec, signal, 'http')
        }
        let response = original
        if (original.body && adapter.inspectEvent) {
          const watch = watchServerSentEvents(
            (event) => inspect(rec, 'http', event.data, event.event),
            (error) =>
              warn('opencode2 auth event inspection threw', {
                error: describe(error),
              }),
          )
          response = new Response(original.body.pipeThrough(watch), {
            status: original.status,
            statusText: original.statusText,
            headers: original.headers,
          })
        }
        if (adapter.rewriteResponse) {
          response =
            (await adapter.rewriteResponse({
              ...account,
              request: draft.request,
              response,
            })) ?? response
        }
        if (response !== original) draft.response = response
      },
      scoped,
    ),
    await ctx.session.hook(
      'experimental.ws.handshake',
      async (draft) => {
        const rec = await ensure(scopeOf(draft), 'experimental.ws.handshake')
        const account = accountOf(rec)
        if (!account) throw noAccount(rec.scope)
        applyHeaderEdits(draft.headers, rec.headers)
        const url = adapter.rewriteHandshakeURL?.({
          ...account,
          url: draft.url,
        })
        if (url !== undefined) draft.url = url
        guard(rec.scope, Object.entries(draft.headers))
      },
      scoped,
    ),
    await ctx.session.hook(
      'experimental.ws.receive',
      (draft) => {
        const rec = records.get(keyOf(draft.sessionID, draft.kind))
        if (!rec || rec.accountId === undefined) return
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
    await ctx.session.hook(
      'retry',
      async (draft) => {
        const rec = pickForRetry(draft.sessionID)
        if (!rec) return
        const hostDecision = draft.decision
        let decision: SessionRetryDecision = hostDecision
        let reason: RetryReason
        if (rec.accountId === undefined) {
          decision = { retry: false }
          reason = 'no-account'
        } else if (rec.outputStarted) {
          // The user has already seen part of this answer; a retry would
          // send it again.
          decision = { retry: false }
          reason = 'output-started'
        } else {
          if (!rec.limit) {
            const signal = adapter.limitFromError?.(draft.error)
            if (signal) noteLimit(rec, signal, 'error')
          }
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
        })
      },
      scoped,
    ),
  ]

  const forgetSession = (sessionID: string) => {
    for (const [key, rec] of records) {
      if (rec.scope.sessionID === sessionID) records.delete(key)
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
