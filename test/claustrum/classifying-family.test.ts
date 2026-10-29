import { expect, test } from 'bun:test'
import type { ScopedInventoryRow } from '@cortexkit/claustrum-client'
import {
  type ClassifyingClaustrumFamily,
  type ClaustrumFamily,
  type ClaustrumFamilyInput,
  type ClaustrumScopedClient,
  ClaustrumScopedCustody,
  projectVaultRoster,
  type VaultRowFacts,
} from '../../src/claustrum/index.ts'
import {
  captureLogger,
  inventoryRow,
  realApiKeyRow,
  realOAuthRow,
  unknownGrants,
} from './helpers.ts'

const category = 'llm-provider'
const refusalCodes = ['unmapped', 'reserved-provider'] as const

function row(id: string, overrides: Partial<ScopedInventoryRow> = {}) {
  return inventoryRow({
    id,
    categories: [category],
    providerIds: [id],
    authMethod: 'oauth',
    refreshAdapter: id,
    ...overrides,
  })
}

function fixture(rows: ScopedInventoryRow[], family: ClaustrumFamilyInput) {
  const logs = captureLogger()
  const client: ClaustrumScopedClient = {
    listScoped: async () => ({
      rows,
      view: 'classified-view',
      ...unknownGrants,
    }),
    getScoped: async () => {
      throw new Error('discovery must not fetch secrets')
    },
    reportAuthFailureScoped: async () => {
      throw new Error('discovery must not report failures')
    },
    close() {},
  }
  return new ClaustrumScopedCustody({
    client,
    family,
    readToken: async () => ({ token: '01'.repeat(32), token_generation: 1 }),
    logger: logs.logger,
  })
}

function classifying(
  classify: ClassifyingClaustrumFamily<string>['classify'] = (facts) => ({
    kind: 'mine',
    member: facts.providerIds?.[0] ?? 'fallback',
  }),
  codes: readonly string[] = refusalCodes,
): ClassifyingClaustrumFamily<string> {
  return { category, refusalCodes: codes, classify }
}

test('classifying family admits distinct OAuth adapters and static keys in one pass', async () => {
  const seen: VaultRowFacts[] = []
  const custody = fixture(
    [
      row('xai'),
      row('meta'),
      realApiKeyRow({
        id: 'deepseek',
        providerIds: ['deepseek'],
      }),
    ],
    classifying((facts) => {
      seen.push(facts)
      return { kind: 'mine', member: facts.providerIds?.[0] ?? 'missing' }
    }),
  )
  const inventory = await custody.discover()
  expect(
    inventory.credentials.map(({ credentialId, credentialType, member }) => ({
      credentialId,
      credentialType,
      member,
    })),
  ).toEqual([
    { credentialId: 'xai', credentialType: 'oauth', member: 'xai' },
    { credentialId: 'meta', credentialType: 'oauth', member: 'meta' },
    { credentialId: 'deepseek', credentialType: 'api_key', member: 'deepseek' },
  ])
  expect(seen).toEqual([
    {
      credentialId: 'xai',
      credentialType: 'oauth',
      authMethod: 'oauth',
      refreshAdapter: 'xai',
      providerIds: ['xai'],
      categories: [category],
    },
    {
      credentialId: 'meta',
      credentialType: 'oauth',
      authMethod: 'oauth',
      refreshAdapter: 'meta',
      providerIds: ['meta'],
      categories: [category],
    },
    {
      credentialId: 'deepseek',
      credentialType: 'api_key',
      authMethod: 'apikey',
      refreshAdapter: undefined,
      providerIds: ['deepseek'],
      categories: [category],
    },
  ])
  expect(inventory.refused).toEqual([])
  expect(inventory.notMine).toBe(0)
})

test.each([
  {
    row: realOAuthRow({
      authMethod: 'antigravity',
      refreshAdapter: 'google-antigravity',
    }),
    type: 'oauth',
  },
  {
    row: realOAuthRow({ credentialType: 'chatgpt', authMethod: 'chatgpt' }),
    type: 'oauth',
  },
  {
    row: realApiKeyRow({ credentialType: 'oauth', refreshAdapter: 'meta' }),
    type: 'api_key',
  },
])(
  'classifying derives $type from authMethod even when the id type differs: $row.authMethod',
  async ({ row, type }) => {
    const seen: VaultRowFacts[] = []
    const inventory = await fixture(
      [row],
      classifying((facts) => {
        seen.push(facts)
        return { kind: 'mine', member: 'provider' }
      }),
    ).discover()
    expect(inventory.credentials).toMatchObject([
      { credentialId: row.id, credentialType: type, member: 'provider' },
    ])
    expect(seen).toMatchObject([
      { credentialType: type, authMethod: row.authMethod },
    ])
    expect(inventory.refused).toEqual([])
  },
)

test('classifying not-mine rows are counted but never listed', async () => {
  const inventory = await fixture(
    [row('dedicated-a'), row('dedicated-b')],
    classifying(() => ({ kind: 'not-mine' })),
  ).discover()
  expect(inventory).toMatchObject({
    credentials: [],
    skipped: [],
    refused: [],
    notMine: 2,
  })
  expect(JSON.stringify(inventory)).not.toContain('dedicated')
})

test('classifying refusals retain only credential ids and declared codes', async () => {
  const inventory = await fixture(
    [row('reserved'), row('   ')],
    classifying(() => ({ kind: 'refused', code: 'reserved-provider' })),
  ).discover()
  expect(inventory).toMatchObject({
    credentials: [],
    skipped: [],
    notMine: 0,
    refused: [
      { credentialId: 'reserved', code: 'reserved-provider' },
      { code: 'reserved-provider' },
    ],
  })
})

test('classifying gate checks read and category but never the credential type hint', async () => {
  const calls: string[] = []
  const inventory = await fixture(
    [
      row('write-only', { operations: ['deposit'] }),
      row('wrong-category', { categories: ['other'] }),
      row('type-hint', { credentialType: 'signing_key' }),
      row('eligible'),
    ],
    classifying((facts) => {
      calls.push(facts.credentialId)
      return { kind: 'mine', member: facts.credentialId }
    }),
  ).discover()
  expect(calls).toEqual(['type-hint', 'eligible'])
  expect(inventory.notMine).toBe(2)
  expect(inventory.credentials.map((credential) => credential.member)).toEqual([
    'type-hint',
    'eligible',
  ])
})

test('classifying malformed admitted records keep their member in skipped records', async () => {
  const inventory = await fixture(
    [
      row(''),
      row('duplicate'),
      row('duplicate'),
      row('blank-account', { accountId: ' ' }),
      row('blank-state', { state: ' ' }),
    ],
    classifying(() => ({ kind: 'mine', member: 'meta' })),
  ).discover()
  expect(inventory.credentials).toEqual([])
  expect(inventory.skipped).toEqual([
    { member: 'meta', reason: 'empty credential id' },
    {
      credentialId: 'duplicate',
      member: 'meta',
      reason: 'duplicate credential id',
    },
    {
      credentialId: 'duplicate',
      member: 'meta',
      reason: 'duplicate credential id',
    },
    {
      credentialId: 'blank-account',
      member: 'meta',
      reason: 'blank account identity',
    },
    { credentialId: 'blank-state', member: 'meta', reason: 'empty state' },
  ])
  expect(inventory.refused).toEqual([])
})

test('classifying undeclared refusal codes become unclassified', async () => {
  const inventory = await fixture(
    [row('unknown-code')],
    classifying(() => ({ kind: 'refused', code: 'private-vault-data' })),
  ).discover()
  expect(inventory.refused).toEqual([
    { credentialId: 'unknown-code', code: 'unclassified' },
  ])
  expect(JSON.stringify(inventory)).not.toContain('private-vault-data')
})

test('classifying declared codes must also satisfy the closed code grammar', async () => {
  const codes = [
    '',
    'Upper',
    'has space',
    'has_underscore',
    'a'.repeat(33),
    'a\n',
    'private:secret',
  ]
  let next = 0
  const inventory = await fixture(
    codes.map((_, index) => row(`invalid-${index}`)),
    classifying(() => ({ kind: 'refused', code: codes[next++] ?? '' }), codes),
  ).discover()
  expect(inventory.refused).toEqual(
    codes.map((_, index) => ({
      credentialId: `invalid-${index}`,
      code: 'unclassified',
    })),
  )
})

test('classifying thrown errors are replaced with unclassified without leaking their messages', async () => {
  const inventory = await fixture(
    [row('throws')],
    classifying(() => {
      throw new Error('private-vault-data')
    }),
  ).discover()
  expect(inventory.refused).toEqual([
    { credentialId: 'throws', code: 'unclassified' },
  ])
  expect(JSON.stringify(inventory)).not.toContain('private-vault-data')
})

test('classifying old-client rows are refused unknown-auth-method before checking providers', async () => {
  const old = row('old-client')
  Reflect.deleteProperty(old, 'providerIds')
  Reflect.deleteProperty(old, 'authMethod')
  let calls = 0
  const inventory = await fixture(
    [old],
    classifying(() => {
      calls++
      throw new Error('old-client row must not reach policy')
    }),
  ).discover()
  expect(inventory.refused).toEqual([
    { credentialId: 'old-client', code: 'unknown-auth-method' },
  ])
  expect(inventory.credentials).toEqual([])
  expect(calls).toBe(0)
})

test('classifying read rows without authMethod are refused without guessing from their ids', async () => {
  let calls = 0
  const inventory = await fixture(
    [
      realApiKeyRow({ authMethod: undefined }),
      realOAuthRow({ authMethod: undefined }),
    ],
    classifying(() => {
      calls++
      return { kind: 'mine', member: 'guessed' }
    }, []),
  ).discover()
  expect(inventory.refused).toEqual([
    { credentialId: 'apikey:cerebras', code: 'unknown-auth-method' },
    { credentialId: 'oauth:meta', code: 'unknown-auth-method' },
  ])
  expect(inventory.credentials).toEqual([])
  expect(calls).toBe(0)
})

test('classifying unknown auth methods are refused without invoking policy', async () => {
  const unknown = realApiKeyRow()
  Object.assign(unknown, { authMethod: 'future-method' })
  const inventory = await fixture(
    [unknown],
    classifying(() => {
      throw new Error('unknown method must not reach policy')
    }),
  ).discover()
  expect(inventory.refused).toEqual([
    { credentialId: unknown.id, code: 'unknown-auth-method' },
  ])
})

test('classifying absent provider ids are unmapped but empty provider ids remain a policy decision', async () => {
  const missing = row('missing')
  Reflect.deleteProperty(missing, 'providerIds')
  const calls: string[] = []
  const inventory = await fixture(
    [missing, row('empty', { providerIds: [] })],
    classifying((facts) => {
      calls.push(facts.credentialId)
      return { kind: 'refused', code: 'unmapped' }
    }),
  ).discover()
  expect(inventory.refused).toEqual([
    { credentialId: 'missing', code: 'unmapped' },
    { credentialId: 'empty', code: 'unmapped' },
  ])
  expect(calls).toEqual(['empty'])
})

test('classifying metadata never changes the persisted roster format', async () => {
  const inventory = await fixture([row('xai')], classifying()).discover()
  expect(inventory.credentials[0]?.member).toBe('xai')
  const roster = projectVaultRoster(undefined, inventory)
  expect(roster.rows).toHaveLength(1)
  expect(JSON.stringify(roster)).not.toContain('member')
  expect(JSON.stringify(roster)).not.toContain('refused')
  expect(JSON.stringify(roster)).not.toContain('notMine')
})

// Extending and reading the legacy interface must remain source-compatible.
interface AdapterFamily extends ClaustrumFamily {
  label: string
}
const legacy: AdapterFamily = {
  label: 'legacy',
  category,
  refreshAdapter: 'xai',
  apiKeys: true,
}
const adapter: string = legacy.refreshAdapter
const apiKeys: boolean | undefined = legacy.apiKeys
void adapter
void apiKeys

test('legacy families keep their inventory shape and never read classifier metadata', async () => {
  const legacyRow = row('xai')
  Object.defineProperties(legacyRow, {
    providerIds: {
      get() {
        throw new Error('legacy must not read providerIds')
      },
    },
    authMethod: {
      get() {
        throw new Error('legacy must not read authMethod')
      },
    },
  })
  const inventory = await fixture([legacyRow], legacy).discover()
  expect(inventory.credentials).toHaveLength(1)
  expect(inventory.credentials[0]).not.toHaveProperty('member')
  expect(inventory).not.toHaveProperty('refused')
  expect(inventory).not.toHaveProperty('notMine')
})
