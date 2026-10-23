import { describe, expect, mock, test } from 'bun:test'
import {
  installOpenCode2Auth,
  OpenCode2AuthError,
  placeholderSecret,
} from '../../src/opencode2/index.js'
import { fakeAdapter, fakeHost, PROVIDER, scopeFor } from './fake-host.js'

const secret = placeholderSecret(PROVIDER)
const credential = (headers: Headers) =>
  headers.get('authorization')?.replace(/^Bearer /, '')
const refuseMisplaced = (header: string) =>
  `Cannot serve placeholder in ${header}`

describe('placeholder placement opt-in', () => {
  for (const transport of ['http', 'ws'] as const) {
    for (const shape of ['wrong-header', 'two-carriers', 'embedded'] as const) {
      test(`L5 refuses ${shape} on ${transport} before selection`, async () => {
        const host = fakeHost()
        const { adapter } = fakeAdapter()
        const choose = mock(adapter.chooseAccount)
        const headers = mock(adapter.accountHeaders)
        adapter.chooseAccount = choose
        adapter.accountHeaders = headers
        const auth = await installOpenCode2Auth(host.ctx, adapter, {
          gateOnPlaceholder: { credential, refuseMisplaced },
        })
        try {
          const carried: Record<string, string> =
            shape === 'embedded'
              ? { authorization: `Bearer prefix-${secret}` }
              : {
                  'x-api-key': secret,
                  ...(shape === 'two-carriers'
                    ? { authorization: `Bearer ${secret}` }
                    : {}),
                }
          let error: unknown
          try {
            if (transport === 'http')
              await host.fire('http.request', {
                ...scopeFor(),
                request: new Request('https://provider.invalid/', {
                  headers: carried,
                }),
              })
            else
              await host.fire('experimental.ws.handshake', {
                ...scopeFor(),
                url: 'wss://provider.invalid/',
                headers: carried,
              })
          } catch (caught) {
            error = caught
          }
          expect(error).toBeInstanceOf(OpenCode2AuthError)
          expect(error).toMatchObject({
            kind: 'placement-refused',
            providerID: PROVIDER,
            sessionID: 'ses_1',
          })
          expect((error as Error).message).toStartWith(
            'Cannot serve placeholder in ',
          )
          expect(choose).toHaveBeenCalledTimes(0)
          expect(headers).toHaveBeenCalledTimes(0)
        } finally {
          await auth.dispose()
        }
      })
    }
  }

  for (const optIn of [false, true]) {
    test(`L5 handshake refusal leaves ${optIn ? 'placeholder' : 'legacy account headers'} with option ${optIn}`, async () => {
      const host = fakeHost()
      const { adapter } = fakeAdapter(undefined, {
        rewriteHandshakeURL() {
          throw new Error('origin refused')
        },
      })
      const auth = await installOpenCode2Auth(host.ctx, adapter, {
        gateOnPlaceholder: {
          credential,
          ...(optIn ? { refuseMisplaced } : {}),
        },
      })
      const draft = {
        ...scopeFor(),
        url: 'wss://provider.invalid/',
        headers: { authorization: `Bearer ${secret}` },
      }
      try {
        await expect(
          host.fire('experimental.ws.handshake', draft),
        ).rejects.toThrow('origin refused')
        expect(draft.headers.authorization).toBe(
          optIn ? `Bearer ${secret}` : 'Bearer tok-A',
        )
      } finally {
        await auth.dispose()
      }
    })

    test(`L5 single carrier and foreign traffic work with option ${optIn}`, async () => {
      const host = fakeHost()
      const { adapter, choices } = fakeAdapter()
      const auth = await installOpenCode2Auth(host.ctx, adapter, {
        gateOnPlaceholder: {
          credential,
          ...(optIn ? { refuseMisplaced } : {}),
        },
      })
      try {
        for (const value of ['user-key', secret]) {
          const http = await host.fire('http.request', {
            ...scopeFor(),
            request: new Request('https://provider.invalid/', {
              headers: { authorization: `Bearer ${value}` },
            }),
          })
          const ws = await host.fire('experimental.ws.handshake', {
            ...scopeFor(),
            url: 'wss://provider.invalid/',
            headers: { authorization: `Bearer ${value}` },
          })
          const expected = value === secret ? 'Bearer tok-A' : `Bearer ${value}`
          expect(http.request.headers.get('authorization')).toBe(expected)
          expect(ws.headers.authorization).toBe(expected)
        }
        expect(choices).toHaveLength(2)
      } finally {
        await auth.dispose()
      }
    })
  }

  test('L5 absent leaves misplaced placeholders on the legacy path', async () => {
    const host = fakeHost()
    const { adapter, choices } = fakeAdapter()
    const auth = await installOpenCode2Auth(host.ctx, adapter, {
      gateOnPlaceholder: { credential },
    })
    try {
      const draft = {
        ...scopeFor(),
        request: new Request('https://provider.invalid/', {
          headers: { 'x-api-key': secret },
        }),
      }
      expect((await host.fire('http.request', draft)).request).toBe(
        draft.request,
      )
      expect(choices).toHaveLength(0)
      await expect(
        host.fire('experimental.ws.handshake', {
          ...scopeFor(),
          url: 'wss://provider.invalid/',
          headers: { authorization: `Bearer ${secret}`, 'x-api-key': secret },
        }),
      ).rejects.toMatchObject({ kind: 'host-credential-on-wire' })
      expect(choices).toHaveLength(1)
    } finally {
      await auth.dispose()
    }
  })

  test('L5 placement refusal counts as foreign for retry taint', async () => {
    const host = fakeHost()
    const { adapter, choices } = fakeAdapter(undefined, {
      limitFromError: () => {
        throw new Error('must not attribute a foreign retry')
      },
    })
    const auth = await installOpenCode2Auth(host.ctx, adapter, {
      gateOnPlaceholder: { credential, refuseMisplaced },
    })
    try {
      await expect(
        host.fire('http.request', {
          ...scopeFor(),
          request: new Request('https://provider.invalid/', {
            headers: { 'x-api-key': secret },
          }),
        }),
      ).rejects.toMatchObject({ kind: 'placement-refused' })
      await host.fire('experimental.ws.handshake', {
        ...scopeFor(),
        url: 'wss://provider.invalid/',
        headers: { authorization: `Bearer ${secret}` },
      })
      const { kind: _kind, ...scope } = scopeFor()
      const retry = await host.fire('retry', {
        ...scope,
        error: { type: 'provider.unknown', message: '429' },
        attempt: 1,
        decision: { retry: false },
      })
      expect(retry.decision).toEqual({ retry: false })
      expect(choices).toHaveLength(1)
    } finally {
      await auth.dispose()
    }
  })
})
