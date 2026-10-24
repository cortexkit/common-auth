import { describe, expect, test } from 'bun:test'
import type { SessionRetryDecision } from '@opencode/plugin/promise/session'
import {
  type ChooseAccountInput,
  type ChooseAccountResult,
  installOpenCode2Auth,
  type OpenCode2AuthAdapter,
  placeholderSecret,
} from '../../src/opencode2/index.js'
import {
  fakeAdapter,
  fakeHost,
  PROVIDER,
  scopeFor,
  type TestQuota,
} from './fake-host.js'

async function setup(gated = false) {
  const host = fakeHost()
  const choices: ChooseAccountInput[] = []
  const drops: Array<ChooseAccountInput & { accountId: string }> = []
  const headers: string[] = []
  let pin = 'A'
  let result: ChooseAccountResult = { hold: { delayMs: 920_000 } }
  let recognised = true
  let retryChoice: (() => Promise<ChooseAccountResult>) | undefined
  const adapter: OpenCode2AuthAdapter<TestQuota, unknown, ChooseAccountResult> =
    {
      ...fakeAdapter().adapter,
      chooseAccount(input) {
        choices.push(input)
        if (input.phase === 'retry') return retryChoice ? retryChoice() : result
        pin = input.previousAccountId ?? 'A'
        return pin
      },
      dropChoice(input) {
        drops.push(input)
      },
      accountHeaders({ accountId }) {
        headers.push(accountId)
        return { authorization: `Bearer tok-${accountId}` }
      },
      limitFromError: () =>
        recognised ? { reason: 'usage_limit_reached' } : undefined,
    }
  const auth = await installOpenCode2Auth(host.ctx, adapter, {
    ...(gated
      ? {
          gateOnPlaceholder: {
            credential: (h: Headers) =>
              h.get('authorization')?.replace(/^Bearer /, ''),
          },
        }
      : {}),
  })
  const request = (scope = scopeFor()) =>
    host.fire('model.request', { ...scope, headers: {} })
  const send = (owned = true) =>
    host.fire('http.request', {
      ...scopeFor(),
      request: new Request('https://provider.invalid', {
        headers: {
          authorization: `Bearer ${owned ? placeholderSecret(PROVIDER) : 'user-key'}`,
        },
      }),
    })
  const retry = (decision: SessionRetryDecision = { retry: true, delay: 5 }) =>
    host.fire('retry', {
      ...scopeFor(),
      error: { type: 'provider.unknown', message: 'usage_limit_reached' },
      attempt: 1,
      decision,
    })
  if (gated) await send()
  else await request()
  return {
    host,
    auth,
    choices,
    drops,
    headers,
    request,
    send,
    retry,
    pin: () => pin,
    result(value: ChooseAccountResult) {
      result = value
    },
    recognised(value: boolean) {
      recognised = value
    },
    onRetryChoice(value: () => Promise<ChooseAccountResult>) {
      retryChoice = value
    },
  }
}

const expectedDrop: ChooseAccountInput & { accountId: string } = {
  sessionID: 'ses_1',
  agent: 'build',
  kind: 'primary',
  providerID: PROVIDER,
  modelID: 'mock-model',
  phase: 'retry',
  previousAccountId: 'A',
  rerouteFrom: { accountId: 'A', limit: { reason: 'usage_limit_reached' } },
  accountId: 'A',
}

describe('same-account retry hold', () => {
  test('adapter delay replaces a short host wait without moving account or pin or choosing twice', async () => {
    const s = await setup()
    try {
      const reasons: string[] = []
      s.auth.on('retry', (event) => {
        reasons.push(event.reason)
      })
      expect((await s.retry()).decision).toEqual({
        retry: true,
        delay: 920_000,
      })
      expect(s.auth.accountFor('ses_1', 'primary')).toBe('A')
      expect(s.pin()).toBe('A')
      s.result('B')
      await s.request()
      expect(s.choices).toHaveLength(2)
      expect(s.headers).toEqual(['A', 'A'])
      expect(s.auth.accountFor('ses_1', 'primary')).toBe('A')
      expect(s.pin()).toBe('A')
      expect(reasons).toEqual(['hold'])
      expect(s.drops).toEqual([])
    } finally {
      await s.auth.dispose()
    }
  })

  for (const changed of ['model', 'agent'] as const) {
    test(`${changed} change releases a hold before choosing afresh`, async () => {
      const s = await setup()
      try {
        await s.retry()
        const scope = scopeFor()
        if (changed === 'model') scope.model.id = 'other-model'
        else scope.agent = 'other-agent'
        await s.request(scope)
        expect(s.drops).toEqual([expectedDrop])
        expect(s.choices).toHaveLength(3)
        expect(s.choices[2]?.rerouteFrom).toBeUndefined()
      } finally {
        await s.auth.dispose()
      }
      expect(s.drops).toHaveLength(1)
    })
  }

  test('cancelling the host wait releases a hold exactly once', async () => {
    const s = await setup()
    await s.retry()
    await s.host.publish('session.status', {
      sessionID: 'ses_1',
      status: { type: 'idle' },
    })
    expect(s.drops).toEqual([expectedDrop])
    await s.request()
    expect(s.choices).toHaveLength(3)
    await s.auth.dispose()
    expect(s.drops).toHaveLength(1)
  })

  test('a hold cannot retry a refusal after output', async () => {
    const s = await setup()
    try {
      await s.host.fire('experimental.ws.handshake', {
        ...scopeFor(),
        headers: {},
      })
      await s.host.fire('experimental.ws.receive', {
        ...scopeFor(),
        frame: JSON.stringify({ type: 'delta' }),
      })
      expect((await s.retry()).decision).toEqual({ retry: false })
      expect(s.choices).toHaveLength(1)
    } finally {
      await s.auth.dispose()
    }
  })

  test('cancelling during selection releases the late hold without publishing a retry', async () => {
    const s = await setup()
    let answer!: (choice: ChooseAccountResult) => void
    let entered!: () => void
    const choosing = new Promise<void>((resolve) => {
      entered = resolve
    })
    const choice = new Promise<ChooseAccountResult>((resolve) => {
      answer = resolve
    })
    s.onRetryChoice(() => {
      entered()
      return choice
    })
    const retried = s.retry().catch((error: unknown) => error)
    await choosing
    await s.host.publish('session.status', {
      sessionID: 'ses_1',
      status: { type: 'idle' },
    })
    answer({ hold: { delayMs: 920_000 } })
    expect(await retried).toBeInstanceOf(Error)
    expect(s.drops).toEqual([expectedDrop])
    await s.auth.dispose()
    expect(s.drops).toHaveLength(1)
  })

  test('a hold cannot change the host decision in a tainted session', async () => {
    const s = await setup(true)
    try {
      await s.send(false)
      await s.send()
      const calls = s.choices.length
      expect((await s.retry()).decision).toEqual({ retry: true, delay: 5 })
      expect(s.choices).toHaveLength(calls)
      expect(s.drops).toEqual([])
    } finally {
      await s.auth.dispose()
    }
  })

  test('a recognised account limit hold overrides host no retry before output', async () => {
    const s = await setup()
    try {
      expect((await s.retry({ retry: false })).decision).toEqual({
        retry: true,
        delay: 920_000,
      })
      await s.request()
      expect(s.headers).toEqual(['A', 'A'])
    } finally {
      await s.auth.dispose()
    }
  })

  test('host no retry stands without a recognised account limit', async () => {
    const s = await setup()
    try {
      s.recognised(false)
      expect((await s.retry({ retry: false })).decision).toEqual({
        retry: false,
      })
      expect(s.choices).toHaveLength(1)
    } finally {
      await s.auth.dispose()
    }
  })

  test('undefined still leaves the host in charge', async () => {
    const s = await setup()
    try {
      s.result(undefined)
      expect((await s.retry({ retry: false })).decision).toEqual({
        retry: false,
      })
      expect(s.drops).toEqual([])
    } finally {
      await s.auth.dispose()
    }
  })

  test('delay just under the cap is unchanged and above the cap is clamped', async () => {
    const s = await setup()
    try {
      for (const [delayMs, delay] of [
        [1_199_999, 1_199_999],
        [1_200_000, 1_200_000],
        [1_200_001, 1_200_000],
      ] as const) {
        s.result({ hold: { delayMs } })
        expect((await s.retry()).decision).toEqual({ retry: true, delay })
        await s.request()
      }
    } finally {
      await s.auth.dispose()
    }
  })

  for (const delayMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    test(`invalid hold delay ${delayMs} preserves host veto and releases the choice`, async () => {
      const s = await setup()
      try {
        s.result({ hold: { delayMs } })
        expect((await s.retry({ retry: false })).decision).toEqual({
          retry: false,
        })
        expect(s.drops).toEqual([expectedDrop])
      } finally {
        await s.auth.dispose()
      }
    })
  }
})
