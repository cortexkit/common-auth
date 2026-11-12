import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  type AskRoutingInput,
  askRouting,
} from '../../src/routing-accessor/index.js'

const symbol = Symbol.for('cortexkit.routing')
const original = Object.getOwnPropertyDescriptor(globalThis, symbol)

function install(value: unknown): void {
  Object.defineProperty(globalThis, symbol, { configurable: true, value })
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, symbol)
  if (original) Object.defineProperty(globalThis, symbol, original)
})

const candidate = {
  accountId: 'vault-account',
  credentialId: 'oauth:anthropic:sticky',
}
const input = {
  sessionId: 'session',
  provider: 'anthropic',
  modelId: 'claude-sonnet',
  candidates: [candidate],
} satisfies AskRoutingInput

describe('warm credential hints', () => {
  test('sends a matching candidate credential on the account question', async () => {
    const accountFor = mock((_request: unknown, _options: unknown) =>
      Promise.resolve({ account_id: candidate.accountId }),
    )
    install(() => ({ accountFor }))
    expect(
      await askRouting({
        ...input,
        warmCredentialId: candidate.credentialId,
        holdWaitMaxS: 12.9,
        refusals: true,
      }),
    ).toEqual({ candidate })
    expect(accountFor.mock.calls).toEqual([
      [
        {
          provider: 'anthropic',
          modelId: 'claude-sonnet',
          hold_wait_max_s: 12,
          refusals: true,
          warm_credential: 'oauth:anthropic:sticky',
        },
        { deadlineMs: 1500 },
      ],
    ])
  })

  test('omits a warm credential filtered out of the candidates without failing', async () => {
    const eligible = { accountId: 'other-account', credentialId: 'other-key' }
    const accountFor = mock((_request: unknown, _options: unknown) =>
      Promise.resolve({ account_id: eligible.accountId }),
    )
    install(() => ({ accountFor }))
    expect(
      await askRouting({
        ...input,
        candidates: [eligible],
        warmCredentialId: candidate.credentialId,
      }),
    ).toEqual({ candidate: eligible })
    expect(accountFor.mock.calls).toEqual([
      [
        { provider: 'anthropic', modelId: 'claude-sonnet' },
        { deadlineMs: 1500 },
      ],
    ])
  })

  test.each([
    '',
    'a'.repeat(257),
    'oauth:\naccount',
    'oauth:\u0000account',
    'oauth:\u001faccount',
    'oauth:\u007faccount',
    'oauth:\u0080account',
    'oauth:\u009faccount',
  ])(
    'omits invalid warm credential %p even if a candidate matches',
    async (warmCredentialId) => {
      const matching = { ...candidate, credentialId: warmCredentialId }
      const accountFor = mock((_request: unknown, _options: unknown) =>
        Promise.resolve({ account_id: matching.accountId }),
      )
      install(() => ({ accountFor }))
      expect(
        await askRouting({
          ...input,
          candidates: [matching],
          warmCredentialId,
        }),
      ).toEqual({ candidate: matching })
      expect(accountFor.mock.calls).toEqual([
        [
          { provider: 'anthropic', modelId: 'claude-sonnet' },
          { deadlineMs: 1500 },
        ],
      ])
    },
  )

  test.each([undefined, null, 1, false, {}, []])(
    'omits non-string warm credential %p without failing',
    async (warmCredentialId) => {
      const accountFor = mock((_request: unknown, _options: unknown) =>
        Promise.resolve({ account_id: candidate.accountId }),
      )
      install(() => ({ accountFor }))
      expect(
        await askRouting({ ...input, warmCredentialId } as AskRoutingInput),
      ).toEqual({ candidate })
      expect(accountFor.mock.calls).toEqual([
        [
          { provider: 'anthropic', modelId: 'claude-sonnet' },
          { deadlineMs: 1500 },
        ],
      ])
    },
  )

  test.each(['a', 'a'.repeat(256), ' credential '])(
    'sends a valid matching credential unchanged: %p',
    async (warmCredentialId) => {
      const matching = { ...candidate, credentialId: warmCredentialId }
      const accountFor = mock((_request: unknown, _options: unknown) =>
        Promise.resolve({ account_id: matching.accountId }),
      )
      install(() => ({ accountFor }))
      await askRouting({ ...input, candidates: [matching], warmCredentialId })
      expect(accountFor.mock.calls).toEqual([
        [
          {
            provider: 'anthropic',
            modelId: 'claude-sonnet',
            warm_credential: warmCredentialId,
          },
          { deadlineMs: 1500 },
        ],
      ])
    },
  )

  test('never pins the selected account to the warm hint', async () => {
    const selected = {
      accountId: 'selected-account',
      credentialId: 'selected-key',
    }
    const accountFor = mock((_request: unknown, _options: unknown) =>
      Promise.resolve({ account_id: selected.accountId }),
    )
    install(() => ({ accountFor }))
    const result = await askRouting({
      ...input,
      candidates: [candidate, selected],
      warmCredentialId: candidate.credentialId,
    })
    expect(result?.candidate).toBe(selected)
    expect(accountFor.mock.calls[0]?.[0]).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet',
      warm_credential: candidate.credentialId,
    })
  })

  test('keeps legacy question bytes identical when no hint is passed', async () => {
    const accountFor = mock((_request: unknown, _options: unknown) =>
      Promise.resolve({ account_id: candidate.accountId }),
    )
    install(() => ({ accountFor }))
    await askRouting(input)
    await askRouting({ ...input, holdWaitMaxS: 12.9, refusals: true })
    expect(JSON.stringify(accountFor.mock.calls[0]?.[0])).toBe(
      '{"provider":"anthropic","modelId":"claude-sonnet"}',
    )
    expect(JSON.stringify(accountFor.mock.calls[1]?.[0])).toBe(
      '{"provider":"anthropic","modelId":"claude-sonnet","hold_wait_max_s":12,"refusals":true}',
    )
  })
})
