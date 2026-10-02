import type {
  OpenCode2AuthAdapter,
  OpenCode2HookContext,
} from '../../src/opencode2/index.js'

/**
 * A stand-in for the OpenCode 2 plugin context. Hooks run in registration
 * order and honour `providerID` scoping the way the host does; events are
 * pushed by the test.
 */
export function fakeHost() {
  type Hook = {
    name: string
    callback: (draft: never) => unknown
    providerID: string | undefined
    disposed: boolean
  }
  const hooks: Hook[] = []
  const pending: Array<{ type: string; data: unknown }> = []
  let wake: (() => void) | undefined
  let subscriptions = 0
  let activeSubscriptions = 0
  const ctx = {
    session: {
      hook: async (
        name: string,
        callback: (draft: never) => unknown,
        options?: { providerID?: string },
      ) => {
        const hook: Hook = {
          name,
          callback,
          providerID: options?.providerID,
          disposed: false,
        }
        hooks.push(hook)
        return {
          dispose: async () => {
            hook.disposed = true
          },
        }
      },
    },
    event: {
      subscribe(options?: { signal?: AbortSignal }) {
        subscriptions += 1
        return {
          async *[Symbol.asyncIterator]() {
            activeSubscriptions += 1
            try {
              while (!options?.signal?.aborted) {
                const next = pending.shift()
                if (next) {
                  yield next
                  continue
                }
                await new Promise<void>((resolve) => {
                  wake = resolve
                  options?.signal?.addEventListener('abort', () => resolve(), {
                    once: true,
                  })
                })
              }
            } finally {
              activeSubscriptions -= 1
            }
          },
        }
      },
    },
  }
  return {
    ctx: ctx as unknown as OpenCode2HookContext,
    hooks,
    get subscriptions() {
      return subscriptions
    },
    get activeSubscriptions() {
      return activeSubscriptions
    },
    /** Delivers a host event to subscribers and lets them process it. */
    async publish(type: string, data: unknown) {
      pending.push({ type, data })
      wake?.()
      for (let i = 0; i < 5; i += 1) await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    /** Runs every live hook registered for `name` that applies to the draft's provider. */
    async fire<T extends { model: { providerID: string } }>(
      name: string,
      draft: T,
    ): Promise<T> {
      for (const hook of hooks) {
        if (hook.name !== name || hook.disposed) continue
        if (hook.providerID && hook.providerID !== draft.model.providerID)
          continue
        await hook.callback(draft as never)
      }
      return draft
    },
  }
}

export const PROVIDER = 'mockprov'

export function scopeFor(
  kind: 'primary' | 'title' | 'compaction' | 'generate' = 'primary',
  sessionID = 'ses_1',
  providerID = PROVIDER,
) {
  return {
    sessionID,
    agent: 'build',
    model: { providerID, id: 'mock-model' },
    kind,
  }
}

export type TestQuota = { used: number }

/**
 * A provider-neutral adapter over two fake accounts, `A` and `B`. It picks the
 * account named in `plan.next`, or the other one when that account is in
 * `plan.limited`; tests change both between requests. Events are JSON objects:
 * `delta` starts output, `quota` reports usage, `refused` is a limit.
 */
export function fakeAdapter<A = unknown>(
  plan: { next: string; limited: Set<string> } = {
    next: 'A',
    limited: new Set(),
  },
  overrides: Partial<OpenCode2AuthAdapter<TestQuota, A>> = {},
) {
  const choices: Array<Record<string, unknown>> = []
  const adapter: OpenCode2AuthAdapter<TestQuota, A> = {
    providerID: PROVIDER,
    chooseAccount(input) {
      choices.push({ ...input })
      const order = [plan.next, ...['A', 'B'].filter((id) => id !== plan.next)]
      return order.find((id) => !plan.limited.has(id))
    },
    accountHeaders({ accountId }) {
      return {
        authorization: `Bearer tok-${accountId}`,
        'x-account': accountId,
      }
    },
    quotaFromHeaders(headers) {
      const used = headers.get('x-quota-used')
      return used === null ? undefined : { used: Number(used) }
    },
    limitFromResponse({ status }) {
      return status === 429 ? { reason: 'too-many', status } : undefined
    },
    inspectEvent({ data }) {
      let event: { type?: string; used?: number }
      try {
        event = JSON.parse(data)
      } catch {
        return undefined
      }
      if (event.type === 'delta') return { outputStarted: true }
      if (event.type === 'quota') return { quota: { used: event.used ?? 0 } }
      if (event.type === 'refused') return { limit: { reason: 'refused' } }
      return undefined
    },
    ...overrides,
  }
  return { adapter, choices, plan }
}

export function sse(events: unknown[]): string {
  return events
    .map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`)
    .join('')
}
