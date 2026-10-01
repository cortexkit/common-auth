// The plugin the placement test loads into the real OpenCode 2 host. It is
// bundled into a scratch directory at test time. Account choice follows a
// control file the test rewrites between turns; every installer event is
// appended to a log the test reads afterwards. Both paths come from the
// host's environment, which the test sets.
import { appendFileSync, readFileSync } from 'node:fs'
import {
  type HeaderEdits,
  installOpenCode2Auth,
  type LimitSignal,
} from '../../../src/opencode2/index.js'

const LOG = process.env.COMMON_AUTH_E2E_PLUGIN_LOG ?? ''
const CONTROL = process.env.COMMON_AUTH_E2E_CONTROL ?? ''
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
    const installation = await installOpenCode2Auth<{ used: number }>(
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
        accountHeaders({ accountId }): HeaderEdits {
          const account = ACCOUNTS[accountId]
          if (!account) return {}
          return {
            authorization: `Bearer ${account.token}`,
            'x-mock-account': account.id,
          }
        },
        quotaFromHeaders(headers) {
          const used = headers.get('x-mock-used-percent')
          return used === null ? undefined : { used: Number(used) }
        },
        async limitFromResponse({ status, body }) {
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
          return limit ? { limit } : undefined
        },
      },
      { logger: { warn: (message, data) => log('warn', { message, data }) } },
    )
    installation.on('select', (event) =>
      log('select', {
        kind: event.kind,
        accountId: event.accountId,
        hook: event.hook,
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
      }),
    )
    log('setup')
    return () => installation.dispose()
  },
}
