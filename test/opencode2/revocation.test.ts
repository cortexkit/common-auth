import { describe, expect, spyOn, test } from 'bun:test'
import {
  ATTEMPT_HEADER,
  type HeaderEdits,
  installOpenCode2Auth,
  OpenCode2AuthError,
  placeholderSecret,
  type SelectingHook,
} from '../../src/opencode2/index.js'
import { fakeAdapter, fakeHost, PROVIDER, scopeFor } from './fake-host.js'

const PLACEHOLDER = `Bearer ${placeholderSecret(PROVIDER)}`
const ACCOUNT_HEADERS = { authorization: 'Bearer tok-A', 'x-account': 'A' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function draftFor(hook: SelectingHook, sessionID = 'ses_revoked') {
  const scope = scopeFor('primary', sessionID)
  const headers = { authorization: PLACEHOLDER }
  return {
    ...scope,
    headers,
    url: 'wss://provider.invalid/v1/responses',
    request:
      hook === 'http.request'
        ? new Request('https://provider.invalid/v1/responses', { headers })
        : undefined,
  }
}

function authorization(draft: ReturnType<typeof draftFor>) {
  return draft.request
    ? draft.request.headers.get('authorization')
    : draft.headers.authorization
}

/** Model requests reach the transport only if selection succeeded. */
async function prepare(
  host: ReturnType<typeof fakeHost>,
  hook: SelectingHook,
  draft: ReturnType<typeof draftFor>,
  prepared: string[],
) {
  await host.fire(hook, draft)
  if (hook === 'model.request') {
    const http = {
      ...scopeFor('primary', draft.sessionID),
      request: new Request('https://provider.invalid/v1/responses', {
        headers: { ...draft.headers, authorization: PLACEHOLDER },
      }),
    }
    await host.fire('http.request', http)
    prepared.push(http.request.headers.get('authorization') ?? '')
  } else {
    prepared.push(authorization(draft) ?? '')
  }
}

function refusal(error: unknown) {
  expect(error).toBeInstanceOf(OpenCode2AuthError)
  expect(error).toMatchObject({
    kind: 'no-account',
    providerID: PROVIDER,
    sessionID: 'ses_revoked',
    requestKind: 'primary',
  })
}

function retryDraft(sessionID = 'ses_revoked') {
  return {
    ...scopeFor('primary', sessionID),
    error: { type: 'provider.limit', message: 'limited' },
    attempt: 1,
    decision: { retry: false },
  }
}

const hooks: SelectingHook[] = [
  'model.request',
  'http.request',
  'experimental.ws.handshake',
]

describe('installOpenCode2Auth revocation', () => {
  for (const hook of hooks) {
    for (const action of ['forget', 'dispose'] as const) {
      for (const checkpoint of ['chooseAccount', 'accountHeaders'] as const) {
        test(`${action} after ${checkpoint} refuses ${hook} without publishing or preparing auth`, async () => {
          const host = fakeHost()
          const choice = deferred<string>()
          const headers = deferred<HeaderEdits>()
          const enteredHeaders = deferred<void>()
          let headerCalls = 0
          const { adapter } = fakeAdapter(undefined, {
            chooseAccount: () => choice.promise,
            accountHeaders: () => {
              headerCalls += 1
              enteredHeaders.resolve()
              return headers.promise
            },
          })
          const installation = await installOpenCode2Auth(host.ctx, adapter)
          const selected: string[] = []
          const retried: string[] = []
          installation.on('select', ({ accountId }) => {
            selected.push(accountId)
          })
          installation.on('retry', ({ sessionID }) => {
            retried.push(sessionID)
          })
          const draft = draftFor(hook)
          const originalRequest = draft.request
          const prepared: string[] = []
          const outcome = prepare(host, hook, draft, prepared).then(
            () => undefined,
            (error: unknown) => error,
          )
          choice.resolve('A')
          if (checkpoint === 'accountHeaders') await enteredHeaders.promise
          // Fulfil the adapter's last await, then revoke before its continuation
          // can remember an attempt. Both deferreds are released even with a
          // broken checkpoint, so a mutant fails assertions rather than hangs.
          headers.resolve(ACCOUNT_HEADERS)
          const disposal =
            action === 'forget'
              ? installation.forgetSession('ses_revoked')
              : installation.dispose()
          const error = await outcome
          await disposal
          expect(headerCalls).toBe(checkpoint === 'chooseAccount' ? 0 : 1)
          refusal(error)
          expect(authorization(draft)).toBe(PLACEHOLDER)
          if (originalRequest) expect(draft.request).toBe(originalRequest)
          else expect(draft.headers).toEqual({ authorization: PLACEHOLDER })
          expect(prepared).toEqual([])
          expect(installation.size).toBe(0)
          expect(selected).toEqual([])
          expect(
            installation.accountFor('ses_revoked', 'primary'),
          ).toBeUndefined()
          const retry = await host.fire('retry', retryDraft())
          expect(retry.decision).toEqual({ retry: false })
          expect(retried).toEqual([])
          await installation.dispose()
        })
      }
    }
  }

  test('a new selection reusing a forgotten session succeeds while its old selections settle', async () => {
    const host = fakeHost()
    const oldChoice = deferred<string>()
    const choices: Array<{
      previousAccountId?: string
      rerouteFrom?: unknown
    }> = []
    let calls = 0
    const { adapter } = fakeAdapter(undefined, {
      chooseAccount: (input) => {
        choices.push(input)
        return ++calls <= 2 ? oldChoice.promise : 'B'
      },
    })
    const installation = await installOpenCode2Auth(host.ctx, adapter)
    const prepared: string[] = []
    const old = ['primary', 'title'].map((kind) => {
      const draft = { ...draftFor('model.request'), kind }
      return host.fire('model.request', draft).then(
        () => undefined,
        (error: unknown) => error,
      )
    })
    installation.forgetSession('ses_revoked')
    await prepare(host, 'model.request', draftFor('model.request'), prepared)
    expect(prepared).toEqual(['Bearer tok-B'])
    oldChoice.resolve('A')
    for (const error of await Promise.all(old)) {
      expect(error).toBeInstanceOf(OpenCode2AuthError)
      expect(error).toMatchObject({ kind: 'no-account' })
    }
    expect(installation.size).toBe(1)
    expect(installation.accountFor('ses_revoked', 'primary')).toBe('B')
    expect(installation.accountFor('ses_revoked', 'title')).toBeUndefined()
    expect(choices[2]?.previousAccountId).toBeUndefined()
    expect(choices[2]?.rerouteFrom).toBeUndefined()
    await installation.dispose()
  })

  test('forgetting one session leaves concurrent selections of another session untouched', async () => {
    const host = fakeHost()
    const choice = deferred<string>()
    const { adapter } = fakeAdapter(undefined, {
      chooseAccount: () => choice.promise,
    })
    const installation = await installOpenCode2Auth(host.ctx, adapter)
    const prepared: string[] = []
    const forgotten = prepare(
      host,
      'model.request',
      draftFor('model.request'),
      prepared,
    ).catch((error: unknown) => error)
    const live = prepare(
      host,
      'http.request',
      draftFor('http.request', 'ses_live'),
      prepared,
    )
    installation.forgetSession('ses_revoked')
    choice.resolve('A')
    refusal(await forgotten)
    await live
    expect(prepared).toEqual(['Bearer tok-A'])
    expect(installation.size).toBe(1)
    expect(installation.accountFor('ses_live', 'primary')).toBe('A')
    await installation.dispose()
  })

  test('in-flight tracking drops forgotten sessions immediately and all tokens when selections settle', async () => {
    const host = fakeHost()
    const choice = deferred<string>()
    const { adapter } = fakeAdapter(undefined, {
      chooseAccount: () => choice.promise,
    })
    const installation = await installOpenCode2Auth(host.ctx, adapter)
    // Observe the real private map, not installation.size (which counts only
    // remembered attempts). The spy is restored before yielding to other tests.
    const originalSet = Map.prototype.set
    let tracking: Map<string, Set<unknown>> | undefined
    const spy = spyOn(Map.prototype, 'set').mockImplementation(function (
      this: Map<string, Set<unknown>>,
      key,
      value,
    ) {
      if (key === 'ses_revoked' && value instanceof Set) tracking = this
      return originalSet.call(this, key, value)
    })
    let outcome: Promise<unknown>
    try {
      outcome = host
        .fire('model.request', draftFor('model.request'))
        .catch((error: unknown) => error)
    } finally {
      spy.mockRestore()
    }
    const tokens = tracking?.get('ses_revoked')
    const heldBeforeForget = tracking?.size
    const tokensBeforeForget = tokens?.size
    // Release before any assertion so even a missing tracker cannot strand work.
    installation.forgetSession('ses_revoked')
    const heldAfterForget = tracking?.size
    choice.resolve('A')
    const error = await outcome
    expect(tracking).toBeDefined()
    expect(heldBeforeForget).toBe(1)
    expect(tokensBeforeForget).toBe(1)
    expect(heldAfterForget).toBe(0)
    expect(tracking?.size).toBe(0)
    expect(tokens?.size).toBe(0)
    refusal(error)
    for (let i = 0; i < 8; i += 1) {
      const sessionID = `ses_reused_${i}`
      await host.fire('model.request', draftFor('model.request', sessionID))
      expect(tracking?.size).toBe(0)
      installation.forgetSession(sessionID)
    }
    adapter.chooseAccount = () => {
      throw new Error('choice failed')
    }
    await expect(
      host.fire('model.request', draftFor('model.request')),
    ).rejects.toThrow('choice failed')
    expect(tracking?.size).toBe(0)
    adapter.chooseAccount = () => 'A'
    adapter.accountHeaders = () => {
      throw new Error('headers failed')
    }
    await expect(
      host.fire('model.request', draftFor('model.request')),
    ).rejects.toThrow('headers failed')
    expect(tracking?.size).toBe(0)
    expect(installation.size).toBe(0)
    await installation.dispose()
  })

  for (const hook of hooks) {
    test(`forget at the selection handoff refuses ${hook} before publishing auth`, async () => {
      const host = fakeHost()
      const { adapter } = fakeAdapter()
      const installation = await installOpenCode2Auth(host.ctx, adapter)
      installation.on('select', () => installation.forgetSession('ses_revoked'))
      const draft = draftFor(hook)
      const prepared: string[] = []
      const error = await host.fire(hook, draft).then(
        () => {
          prepared.push(authorization(draft) ?? '')
          return undefined
        },
        (error: unknown) => error,
      )
      refusal(error)
      expect(authorization(draft)).toBe(PLACEHOLDER)
      expect(prepared).toEqual([])
      expect(installation.size).toBe(0)
      await installation.dispose()
    })
  }

  test('forget during an HTTP rewrite refuses the prepared authenticated request', async () => {
    const host = fakeHost()
    const rewrite = deferred<Request | undefined>()
    const entered = deferred<void>()
    const { adapter } = fakeAdapter(undefined, {
      rewriteRequest: () => {
        entered.resolve()
        return rewrite.promise
      },
    })
    const installation = await installOpenCode2Auth(host.ctx, adapter)
    const draft = draftFor('http.request')
    const original = draft.request
    const prepared: string[] = []
    const outcome = prepare(host, 'http.request', draft, prepared).catch(
      (error: unknown) => error,
    )
    await entered.promise
    installation.forgetSession('ses_revoked')
    rewrite.resolve(undefined)
    refusal(await outcome)
    expect(draft.request).toBe(original)
    expect(prepared).toEqual([])
    expect(installation.size).toBe(0)
    await installation.dispose()
  })

  for (const checkpoint of ['attempt end', 'limit listener'] as const) {
    test(`forget while retry awaits ${checkpoint} refuses locally without remembering a retry`, async () => {
      const host = fakeHost()
      const barrier = deferred<void>()
      const entered = deferred<void>()
      const choices: Array<{
        previousAccountId?: string
        rerouteFrom?: unknown
      }> = []
      const { adapter } = fakeAdapter(undefined, {
        chooseAccount: (input) => {
          choices.push(input)
          return 'A'
        },
        limitFromResponse: () => undefined,
        limitFromError: () =>
          checkpoint === 'limit listener' ? { reason: 'too-many' } : undefined,
        onAttemptEnd: () => {
          if (checkpoint !== 'attempt end') return
          entered.resolve()
          return barrier.promise
        },
      })
      const installation = await installOpenCode2Auth(host.ctx, adapter)
      if (checkpoint === 'limit listener') {
        installation.on('limit', () => {
          entered.resolve()
          return barrier.promise
        })
      }
      const draft = draftFor('http.request')
      await host.fire('http.request', draft)
      if (checkpoint === 'attempt end') {
        await host.fire('http.response', {
          ...scopeFor('primary', 'ses_revoked'),
          request: draft.request!,
          response: new Response(null, { status: 500 }),
        })
      }
      const retried: string[] = []
      installation.on('retry', ({ sessionID }) => {
        retried.push(sessionID)
      })
      const retry = retryDraft()
      const outcome = host.fire('retry', retry).catch((error: unknown) => error)
      await entered.promise
      installation.forgetSession('ses_revoked')
      barrier.resolve()
      refusal(await outcome)
      expect(retry.decision).toEqual({ retry: false })
      expect(retried).toEqual([])
      expect(installation.size).toBe(0)
      const model = await host.fire('model.request', {
        ...scopeFor('primary', 'ses_revoked'),
        headers: {} as Record<string, string>,
      })
      expect(model.headers[ATTEMPT_HEADER]).toBeDefined()
      expect(choices[1]?.previousAccountId).toBeUndefined()
      expect(choices[1]?.rerouteFrom).toBeUndefined()
      await installation.dispose()
    })
  }
})
