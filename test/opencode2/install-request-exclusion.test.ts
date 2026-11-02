import { describe, expect, test } from 'bun:test'
import type {
  AttemptOutcome,
  ChooseAccountInput,
  ChooseAccountResult,
  InstallOpenCode2AuthOptions,
  OpenCode2AuthAdapter,
} from '../../src/opencode2/index.js'
import {
  installOpenCode2Auth,
  placeholderSecret,
} from '../../src/opencode2/index.js'
import {
  fakeAdapter,
  fakeHost,
  PROVIDER,
  scopeFor,
  type TestQuota,
} from './fake-host.js'

type Adapter = OpenCode2AuthAdapter<TestQuota, unknown, ChooseAccountResult>
type Decision = { retry: false } | { retry: true; delay: number }
const scope = scopeFor('primary', 'exclusion-session')
const limit = { reason: 'limited', status: 429 }
const excluded = (input: ChooseAccountInput | undefined) =>
  input?.excluded ?? []

async function setup(
  gate: boolean,
  choose: (input: ChooseAccountInput) => ChooseAccountResult,
  options: InstallOpenCode2AuthOptions = {},
) {
  const host = fakeHost()
  const choices: ChooseAccountInput[] = []
  const headers: string[] = []
  const drops: Array<ChooseAccountInput & { accountId: string }> = []
  const ends: AttemptOutcome[] = []
  const warnings: string[] = []
  const adapter: Adapter = {
    ...fakeAdapter().adapter,
    chooseAccount(input) {
      choices.push(input)
      return choose(input)
    },
    accountHeaders({ accountId }) {
      headers.push(accountId)
      return { authorization: `Bearer tok-${accountId}` }
    },
    dropChoice(input) {
      drops.push(input)
    },
    onAttemptEnd(_attempt, outcome) {
      ends.push(outcome)
    },
    inspectEvent({ data }) {
      if (data === 'limit') return { limit }
      if (data === 'limit-done') return { limit, done: true }
      if (data === 'done') return { done: true }
      return undefined
    },
  }
  const auth = await installOpenCode2Auth(host.ctx, adapter, {
    enforceRequestExclusion: true,
    ...(gate
      ? {
          gateOnPlaceholder: {
            credential: (headers: Headers) =>
              headers.get('authorization')?.replace(/^Bearer /, ''),
          },
        }
      : {}),
    logger: { warn: (message) => warnings.push(message) },
    ...options,
  })
  const model = () =>
    host.fire('model.request', {
      ...scope,
      headers: {} as Record<string, string>,
    })
  const transport = async (
    draft: Awaited<ReturnType<typeof model>>,
    ws = false,
    credential = placeholderSecret(PROVIDER),
  ) => {
    const headers = { ...draft.headers, authorization: `Bearer ${credential}` }
    if (ws) {
      await host.fire('experimental.ws.handshake', {
        ...scope,
        headers,
        url: 'wss://provider.invalid',
      })
      return undefined
    }
    return (
      await host.fire('http.request', {
        ...scope,
        request: new Request('https://provider.invalid/messages', { headers }),
      })
    ).request
  }
  const send = async () => (await transport(await model()))!
  const socket = async () => transport(await model(), true)
  const frame = (data: string) =>
    host.fire('experimental.ws.receive', { ...scope, frame: data })
  const respond = async (request: Request, status = 429) => {
    const result = await host.fire('http.response', {
      ...scope,
      request,
      response: new Response('provider body', { status }),
    })
    await result.response.text()
  }
  const retry = (
    decision: Decision = { retry: true, delay: 321 },
    attempt = 1,
  ) =>
    host.fire('retry', {
      ...scope,
      attempt,
      error: {
        type: 'provider.error',
        message: 'provider failure',
        status: 429,
      },
      decision,
    })
  return {
    host,
    auth,
    choices,
    headers,
    drops,
    ends,
    warnings,
    model,
    transport,
    send,
    socket,
    frame,
    respond,
    retry,
  }
}

describe('OpenCode 2 logical request exclusions', () => {
  for (const gate of [false, true]) {
    for (const target of [false, true]) {
      test(`hold dispatches A, reroute dispatches B, third retry excludes A (gated=${gate}, target=${target})`, async () => {
        let retries = 0
        const fx = await setup(gate, (input) => {
          if (input.phase === 'request') return 'A'
          retries += 1
          if (retries === 1)
            return { hold: { delayMs: 1000, ...(target ? { target: 1 } : {}) } }
          return retries === 2 ? 'B' : undefined
        })
        try {
          await fx.respond(await fx.send())
          expect(fx.ends[0]).toMatchObject({
            status: 429,
            limit: { status: 429 },
          })
          expect(fx.ends[0]?.error).toBeUndefined()
          expect((await fx.retry()).decision).toEqual({
            retry: true,
            delay: 1000,
          })
          await fx.respond(await fx.send())
          expect(fx.headers).toEqual(['A', 'A'])
          expect(
            fx.choices.every((input) => excluded(input).length === 0),
          ).toBe(true)
          expect((await fx.retry(undefined, 2)).decision).toEqual({
            retry: true,
            delay: 0,
          })
          await fx.respond(await fx.send())
          await fx.retry(undefined, 3)
          expect(fx.headers).toEqual(['A', 'A', 'B'])
          expect(excluded(fx.choices.at(-1))).toEqual(['A'])
          expect(fx.choices.at(-1)?.phase).toBe('retry')
          expect(fx.warnings).toEqual([])
        } finally {
          await fx.auth.dispose()
        }
      })
    }

    for (const enforce of [false, true]) {
      test(`excluded retry and request choices are ${enforce ? 'rejected' : 'honoured'} (gated=${gate})`, async () => {
        let retries = 0
        const fx = await setup(
          gate,
          (input) =>
            input.phase === 'request' ? 'A' : ++retries === 1 ? 'B' : 'A',
          { enforceRequestExclusion: enforce },
        )
        try {
          await fx.respond(await fx.send())
          await fx.retry()
          await fx.respond(await fx.send())
          const result = await fx.retry(undefined, 2)
          expect(excluded(fx.choices.at(-1))).toEqual(['A'])
          expect(result.decision).toEqual({
            retry: true,
            delay: enforce ? 321 : 0,
          })
          if (enforce) {
            await expect(fx.send()).rejects.toMatchObject({
              kind: 'no-account',
            })
            expect(excluded(fx.choices.at(-1))).toEqual(['A'])
            expect(fx.headers).toEqual(['A', 'B'])
            expect(
              fx.warnings.filter((text) => text.includes('request-excluded')),
            ).toHaveLength(2)
            expect(fx.drops.map((input) => input.accountId)).toEqual(['A', 'A'])
          } else {
            await fx.send()
            expect(fx.headers).toEqual(['A', 'B', 'A'])
            expect(fx.warnings).toEqual([])
          }
          // Chooser inputs are snapshots: later reroutes never mutate earlier inputs.
          expect(excluded(fx.choices[0])).toEqual([])
          expect(excluded(fx.choices[1])).toEqual([])
        } finally {
          await fx.auth.dispose()
        }
      })
    }

    for (const separate of [false, true]) {
      test(`limit ${separate ? 'then plain done' : 'with terminal done and no error'} keeps exclusions (gated=${gate})`, async () => {
        let retries = 0
        const fx = await setup(gate, (input) =>
          input.phase === 'request' ? 'A' : ++retries === 1 ? 'B' : 'C',
        )
        try {
          await fx.socket()
          await fx.frame('limit-done')
          await fx.retry()
          await fx.socket()
          await fx.frame(separate ? 'limit' : 'limit-done')
          if (separate) await fx.frame('done')
          expect(fx.ends.at(-1)?.error).toBeUndefined()
          await fx.retry(undefined, 2)
          expect(excluded(fx.choices.at(-1))).toEqual(['A'])
          await fx.socket()
          await fx.frame('limit-done')
          await fx.retry(undefined, 3)
          expect(excluded(fx.choices.at(-1))).toEqual(['A', 'B'])
        } finally {
          await fx.auth.dispose()
        }
      })
    }

    for (const ending of [
      'success',
      'plain-done',
      'failed-no-retry',
      'retry-false',
      'veto',
      'cancel',
      'idle',
      'forget',
      'deleted',
    ] as const) {
      test(`${ending} retires the request before the next turn (gated=${gate})`, async () => {
        let retries = 0
        const fx = await setup(gate, (input) => {
          if (input.phase === 'request') return 'A'
          retries += 1
          if (retries === 1) return 'B'
          return ending === 'veto' ? { hostRetry: 'veto' } : undefined
        })
        try {
          await fx.respond(await fx.send())
          await fx.retry()
          if (
            ending === 'idle' ||
            ending === 'forget' ||
            ending === 'deleted'
          ) {
            if (ending === 'idle')
              await fx.host.publish('session.status', {
                sessionID: scope.sessionID,
                status: { type: 'idle' },
              })
            else if (ending === 'forget') fx.auth.forgetSession(scope.sessionID)
            else
              await fx.host.publish('session.deleted', {
                sessionID: scope.sessionID,
              })
          } else if (ending === 'plain-done') {
            await fx.socket()
            await fx.frame('done')
          } else {
            const request = await fx.send()
            if (ending === 'cancel') {
              const response = await fx.host.fire('http.response', {
                ...scope,
                request,
                response: new Response(new ReadableStream({ start() {} })),
              })
              await response.response.body!.cancel()
              expect(fx.ends.at(-1)?.error?.reason).toBe('cancelled')
            } else {
              await fx.respond(
                request,
                ending === 'success'
                  ? 200
                  : ending === 'failed-no-retry'
                    ? 500
                    : 429,
              )
              if (ending === 'retry-false' || ending === 'veto') {
                expect(
                  (
                    await fx.retry(
                      ending === 'retry-false' ? { retry: false } : undefined,
                      2,
                    )
                  ).decision,
                ).toEqual({ retry: false })
                expect(excluded(fx.choices.at(-1))).toEqual(['A'])
              }
            }
          }
          await fx.send()
          expect(fx.choices.at(-1)?.phase).toBe('request')
          expect(excluded(fx.choices.at(-1))).toEqual([])
          expect(fx.headers.at(-1)).toBe('A')
          expect(fx.warnings).toEqual([])
        } finally {
          await fx.auth.dispose()
        }
      })
    }

    test(`ambiguous concurrent binding keeps exclusions and warns (gated=${gate})`, async () => {
      let retries = 0
      const fx = await setup(gate, (input) =>
        input.phase === 'request' ? 'A' : ++retries === 1 ? 'B' : 'C',
      )
      try {
        const refused = await fx.send()
        const concurrent = await fx.send()
        await fx.respond(refused)
        await fx.retry()
        const consumed = await fx.send()
        expect(
          fx.warnings.filter((text) =>
            text.includes('ambiguous concurrent request'),
          ),
        ).toHaveLength(1)
        await fx.respond(concurrent, 200)
        await fx.respond(consumed)
        await fx.retry(undefined, 2)
        expect(excluded(fx.choices.at(-1))).toEqual(['A'])
      } finally {
        await fx.auth.dispose()
      }
    })

    test(`unrelated attempt consumes pending retry and actual retry starts fresh (gated=${gate})`, async () => {
      const fx = await setup(gate, (input) =>
        input.phase === 'request' ? 'A' : 'B',
      )
      try {
        await fx.respond(await fx.send())
        await fx.retry()
        await fx.send()
        // The host supplies no request id: this unrelated send has taken B.
        expect(fx.headers).toEqual(['A', 'B'])
        await fx.send()
        expect(fx.headers).toEqual(['A', 'B', 'A'])
        expect(excluded(fx.choices.at(-1))).toEqual([])
        expect(fx.warnings).toEqual([])
      } finally {
        await fx.auth.dispose()
      }
    })

    test(`minting occurs at ${gate ? 'owned transport' : 'model.request'} and pending retry is reused (gated=${gate})`, async () => {
      const fx = await setup(gate, (input) =>
        input.phase === 'request' ? 'A' : 'B',
      )
      try {
        const prepared = await fx.model()
        expect(fx.choices).toHaveLength(gate ? 0 : 1)
        await fx.respond((await fx.transport(prepared))!)
        expect(fx.choices).toHaveLength(1)
        await fx.retry()
        const retried = await fx.model()
        expect(fx.choices).toHaveLength(2)
        await fx.transport(retried)
        expect(fx.headers).toEqual(['A', 'B'])
      } finally {
        await fx.auth.dispose()
      }
    })
  }

  test('gated foreign transports never mint or choose an account', async () => {
    const fx = await setup(true, () => 'A')
    try {
      const prepared = await fx.model()
      await fx.transport(prepared, false, 'foreign-key')
      await fx.transport(prepared, true, 'foreign-key')
      expect(fx.choices).toEqual([])
      expect(fx.headers).toEqual([])
    } finally {
      await fx.auth.dispose()
    }
  })
})
