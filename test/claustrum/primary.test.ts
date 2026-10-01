import { expect, test } from 'bun:test'
import {
  resolveVaultPrimary,
  type VaultCredential,
  type VaultInventory,
  type VaultPrimaryBinding,
  type VaultPrimaryUnavailableReason,
} from '../../src/claustrum/index.ts'

// The plugin names its host-owned main record; the library has no convention.
const PRIMARY = 'oauth:test'

const primary: VaultCredential = {
  credentialId: PRIMARY,
  credentialType: 'oauth',
  accountIdentity: 'account-main',
  state: 'active',
}
const sameAccountAlias: VaultCredential = {
  ...primary,
  credentialId: 'oauth:test:main-alias',
}
const fallback: VaultCredential = {
  credentialId: 'oauth:test:fallback',
  credentialType: 'oauth',
  accountIdentity: 'account-fallback',
  state: 'active',
}
const verified: VaultPrimaryBinding = {
  routeId: 'main',
  credentialId: PRIMARY,
  accountIdentity: 'account-main',
  view: 'v0',
}

function list(
  credentials: readonly VaultCredential[],
  skipped: VaultInventory['skipped'] = [],
  view = 'v1',
): VaultInventory {
  return { view, credentials, skipped }
}

test('the primary hook binds main to the account its record claims, served by a same-account credential when the record itself is cold', () => {
  expect(
    resolveVaultPrimary({
      inventory: list([fallback, primary, sameAccountAlias]),
      routeId: 'main',
      primaryCredentialId: PRIMARY,
    }),
  ).toEqual({
    status: 'ready',
    binding: {
      routeId: 'main',
      credentialId: PRIMARY,
      accountIdentity: 'account-main',
      view: 'v1',
    },
  })
  expect(
    resolveVaultPrimary({
      inventory: list([
        fallback,
        { ...primary, state: 'needs_reauth' },
        sameAccountAlias,
      ]),
      routeId: 'main',
      primaryCredentialId: PRIMARY,
      previous: verified,
    }),
  ).toEqual({
    status: 'ready',
    binding: {
      routeId: 'main',
      credentialId: sameAccountAlias.credentialId,
      accountIdentity: 'account-main',
      view: 'v1',
    },
  })
})

test('a complete inventory without the primary record means main is absent, and no fallback is promoted', () => {
  expect(
    resolveVaultPrimary({
      inventory: list([fallback, { ...sameAccountAlias }]),
      routeId: 'main',
      primaryCredentialId: PRIMARY,
      previous: verified,
    }),
  ).toEqual({ status: 'absent' })
})

test('a malformed, unclaimed or possibly unlisted primary is unavailable rather than absent, and keeps the last verified binding', () => {
  const cases: Array<
    [
      VaultPrimaryUnavailableReason | 'declared incomplete',
      VaultInventory,
      boolean | undefined,
    ]
  > = [
    [
      'malformed',
      list(
        [fallback],
        [{ credentialId: PRIMARY, reason: 'blank account identity' }],
      ),
      undefined,
    ],
    [
      'unclaimed',
      list([fallback, { ...primary, accountIdentity: undefined }]),
      undefined,
    ],
    [
      'incomplete',
      list([fallback], [{ reason: 'empty credential id' }]),
      undefined,
    ],
    ['declared incomplete', list([fallback]), false],
  ]
  for (const [name, inventory, complete] of cases) {
    const result = resolveVaultPrimary({
      inventory,
      ...(complete !== undefined && { complete }),
      routeId: 'main',
      primaryCredentialId: PRIMARY,
      previous: verified,
    })
    expect([name, result]).toEqual([
      name,
      {
        status: 'unavailable',
        reason: name === 'declared incomplete' ? 'incomplete' : name,
        lastVerified: verified,
      },
    ])
  }
})

test('a known replacement of the primary account is reported so account-owned state can be invalidated', () => {
  const result = resolveVaultPrimary({
    inventory: list([
      { ...primary, accountIdentity: 'account-new' },
      sameAccountAlias,
    ]),
    routeId: 'main',
    primaryCredentialId: PRIMARY,
    previous: verified,
  })
  expect(result).toEqual({
    status: 'ready',
    binding: {
      routeId: 'main',
      credentialId: PRIMARY,
      accountIdentity: 'account-new',
      view: 'v1',
    },
    replaced: verified,
  })
})

test('the primary hook refuses a request whose expected account is no longer the one main holds', () => {
  expect(
    resolveVaultPrimary({
      inventory: list([{ ...primary, accountIdentity: 'account-new' }]),
      routeId: 'main',
      primaryCredentialId: PRIMARY,
      previous: verified,
      expectedAccountIdentity: 'account-main',
    }),
  ).toEqual({
    status: 'unavailable',
    reason: 'identity-changed',
    lastVerified: verified,
  })
  expect(
    resolveVaultPrimary({
      inventory: list([primary]),
      routeId: 'main',
      primaryCredentialId: PRIMARY,
      expectedAccountIdentity: 'account-main',
    }).status,
  ).toBe('ready')
})
