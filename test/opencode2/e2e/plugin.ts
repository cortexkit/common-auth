// The plugin the placement test loads into the real OpenCode 2 host. It is
// bundled into a scratch directory at test time. Account choice follows a
// control file the test rewrites between turns; every installer event is
// appended to a log the test reads afterwards. Both paths come from the
// host's environment, which the test sets.
//
// Each attempt gets a receipt (`<account>-<kind>-<n>`) from `accountHeaders`,
// kept as the attempt's value and, when the test asks, also sent on the wire
// in a header, so the test can check that what the installer hands back
// belongs to the request that actually went out. The header is opt-in
// because the host keys a session's WebSocket on its handshake headers: a
// header that changes per attempt opens a new socket every turn.
import { appendFileSync, readFileSync } from 'node:fs'
import {
  type AccountHeadersResult,
  ATTEMPT_HEADER,
  installOpenCode2Auth,
  type LimitSignal,
} from '../../../src/opencode2/index.js'
import { MARKER_FIELD, RECEIPT_HEADER } from './mock-provider.js'

const LOG = process.env.COMMON_AUTH_E2E_PLUGIN_LOG ?? ''
const CONTROL = process.env.COMMON_AUTH_E2E_CONTROL ?? ''
/** Set by the test to turn on the WebSocket frame rewrite. */
const MARK_FRAMES = process.env.COMMON_AUTH_E2E_MARK_FRAMES === '1'
/** Set by the test to send each attempt's receipt in a header. */
const RECEIPT_ON_WIRE = process.env.COMMON_AUTH_E2E_RECEIPT_ON_WIRE === '1'
const MARK = 'common-auth-e2e'
const ACCOUNTS: Record<string, { token: string; id: string }> = {
  A: { token: 'tok-A', id: 'acct-A' },
  B: { token: 'tok-B', id: 'acct-B' },
}

function log(event: string, data: Record<string, unknown> = {}) {
  if (LOG) appendFileSync(LOG, `${JSON.stringify({ event, ...data })}\n`)
}

function preferred(): string {
  try {
    return JSON.parse(readFileSync(CONTROL, 'utf8')).next ?? 'A'
  } catch {
    return 'A'
  }
}

function limitOf(event: {
  type?: string
  status?: number
  error?: { code?: string; type?: string }
  response?: { error?: { code?: string; type?: string } }
}): LimitSignal | undefined {
  const error = event.error ?? event.response?.error
  const code = error?.code ?? error?.type ?? ''
  if (event.type === 'response.failed' && /rate_limit|usage_limit/.test(code))
    return { reason: code }
  if (
    event.type === 'error' &&
    (event.status === 429 || /usage_limit/.test(code))
  )
    return { reason: code || 'error-429', status: 429 }
  return undefined
}

export default {
  id: 'cortexkit.common-auth.e2e-placement',
  async setup(ctx: Parameters<typeof installOpenCode2Auth>[0]) {
    const limited = new Set<string>()
    let receipts = 0
    // Registered before the installer, so they run before its transport
    // hooks: they record the attempt mark the host carried from
    // model.request onto the request and the handshake.
    await ctx.session.hook(
      'http.request',
      (draft) => {
        log('mark', {
          transport: 'http',
          kind: draft.kind,
          mark: draft.request.headers.get(ATTEMPT_HEADER),
        })
      },
      { providerID: 'openai' },
    )
    await ctx.session.hook(
      'experimental.ws.handshake',
      (draft) => {
        const name = Object.keys(draft.headers).find(
          (header) => header.toLowerCase() === ATTEMPT_HEADER,
        )
        log('mark', {
          transport: 'ws',
          kind: draft.kind,
          mark: name === undefined ? null : draft.headers[name],
        })
      },
      { providerID: 'openai' },
    )
    const installation = await installOpenCode2Auth<{ used: number }, string>(
      ctx,
      {
        providerID: 'openai',
        chooseAccount(input) {
          const order = [preferred(), 'A', 'B']
          const accountId = order.find((id) => !limited.has(id))
          log('choose', {
            kind: input.kind,
            accountId,
            previousAccountId: input.previousAccountId,
            rerouteFrom: input.rerouteFrom?.accountId,
          })
          return accountId
        },
        accountHeaders({ accountId, kind }): AccountHeadersResult<string> {
          const account = ACCOUNTS[accountId]
          if (!account) return { headers: {} }
          receipts += 1
          const receipt = `${accountId}-${kind}-${receipts}`
          return {
            headers: {
              authorization: `Bearer ${account.token}`,
              'x-mock-account': account.id,
              ...(RECEIPT_ON_WIRE ? { [RECEIPT_HEADER]: receipt } : {}),
            },
            attempt: receipt,
          }
        },
        quotaFromHeaders(headers) {
          const used = headers.get('x-mock-used-percent')
          return used === null ? undefined : { used: Number(used) }
        },
        async limitFromResponse({ status, body, attempt }) {
          log('error-response', {
            kind: attempt.kind,
            status,
            receipt: attempt.data,
          })
          if (status !== 429) return undefined
          let code = ''
          try {
            code = JSON.parse(await body()).error?.type ?? ''
          } catch {}
          return { reason: code || 'http-429', status }
        },
        inspectEvent({ data }) {
          let event: Record<string, unknown>
          try {
            event = JSON.parse(data)
          } catch {
            return undefined
          }
          if (event.type === 'mock.rate_limits')
            return { quota: { used: Number(event.used_percent) } }
          if (event.type === 'response.output_text.delta')
            return { outputStarted: true }
          const limit = limitOf(event)
          const done =
            event.type === 'response.completed' ||
            event.type === 'response.failed' ||
            event.type === 'error'
          if (!limit && !done) return undefined
          return { ...(limit ? { limit } : {}), ...(done ? { done } : {}) }
        },
        onAttemptEnd(attempt, outcome) {
          log('end', {
            kind: attempt.kind,
            transport: attempt.transport,
            receipt: attempt.data,
            status: outcome.status,
            outputStarted: outcome.outputStarted,
            error: outcome.error?.reason,
          })
        },
        ...(MARK_FRAMES
          ? {
              rewriteWebSocketFrame({ frame, attempt }) {
                log('rewrite', { receipt: attempt?.data })
                return JSON.stringify({
                  ...JSON.parse(frame),
                  [MARKER_FIELD]: MARK,
                })
              },
            }
          : {}),
      },
      { logger: { warn: (message, data) => log('warn', { message, data }) } },
    )
    installation.on('select', (event) =>
      log('select', {
        kind: event.kind,
        accountId: event.accountId,
        hook: event.hook,
        attemptId: event.handle.attemptId,
      }),
    )
    installation.on('quota', (event) =>
      log('quota', {
        kind: event.kind,
        accountId: event.accountId,
        transport: event.transport,
        used: event.quota.used,
      }),
    )
    installation.on('limit', (event) => {
      limited.add(event.accountId)
      log('limit', {
        kind: event.kind,
        accountId: event.accountId,
        via: event.via,
        reason: event.limit.reason,
        outputStarted: event.outputStarted,
      })
    })
    installation.on('retry', (event) =>
      log('retry', {
        accountId: event.accountId,
        kind: event.kind,
        reason: event.reason,
        hostDecision: event.hostDecision,
        decision: event.decision,
        receipt: event.handle?.data,
      }),
    )
    log('setup')
    return () => installation.dispose()
  },
}
