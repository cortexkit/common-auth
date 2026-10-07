import { expect } from 'bun:test'
import { join } from 'node:path'
import {
  ClaustrumConsumer,
  connectClaustrumScopedClient,
} from '../../src/claustrum/index.ts'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { cleanupDirs, tempDir, writeToken } from './helpers.ts'
import { type MockDaemon, startMockDaemon } from './mock-daemon.ts'

const { afterEach, test } = lifetimeHooks()
const consumers: ClaustrumConsumer[] = []
const daemons: MockDaemon[] = []
afterEach(async () => {
  for (const consumer of consumers.splice(0)) consumer.close()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await cleanupDirs()
})

// The daemon owner's 2026-10-07 capture, with placeholder identities. Preserve
// the wire field order and keep auth_method distinct from the OAuth type.
const capturedRow = {
  account_id: 'user@gmail.com',
  auth_method: 'antigravity',
  categories: ['antigravity-native', 'llm-provider'],
  email: 'user@gmail.com',
  id: 'antigravity:google',
  operations: ['read'],
  provider_ids: ['google'],
  record_version: 2141,
  refresh_adapter: 'antigravity',
  serves: ['google', 'anthropic', 'openai'],
  state: 'active',
  type: 'oauth',
}

async function scenario(row = capturedRow) {
  const dir = await tempDir('claustrum-antigravity-wire-')
  const daemon = await startMockDaemon({
    directory: dir,
    listScopedResult: {
      credentials: [row],
      grant_tuples: [
        {
          operation: 'read',
          selector: 'antigravity-native',
          selector_kind: 'category',
        },
      ],
      grants: 1,
      view: 'ODs6AfRHmjqJ6XX3LVdfLyDAE04vF+a5JYczvTZdpuU=',
    },
    getScopedResults: {
      'antigravity:google': {
        account_id: 'user@gmail.com',
        credential_id: 'antigravity:google',
        email: 'user@gmail.com',
        expires_at_ms: Date.now() + 3_600_000,
        // An opaque 261-byte token, not JSON OAuth material or a JWT. The real
        // wire payload is a JSON byte array, not an already-decoded string.
        payload: Array<number>(261).fill(120),
        project_id: 'word-word-abc12',
        record_version: 2141,
      },
    },
  })
  daemons.push(daemon)
  const consumer = new ClaustrumConsumer({
    rosterPath: join(dir, 'vault-roster.json'),
    tokenPath: await writeToken(dir),
    family: {
      refreshAdapter: 'antigravity',
      category: 'antigravity-native',
      apiKeys: false,
    },
    requireAssertion: true,
    // No parseIdentity: the vault must assert the opaque token's account.
    connect: () =>
      connectClaustrumScopedClient({
        connectionFile: daemon.connectionFile,
        identity: {
          project_root: dir,
          harness: 'test',
          session: 'antigravity',
        },
        logger: () => {},
      }),
    pollIntervalMs: 0,
  })
  consumers.push(consumer)
  return { consumer, daemon }
}

test('the captured antigravity wire credential routes and serves an asserted OAuth receipt', async () => {
  const { consumer, daemon } = await scenario()
  const roster = await consumer.refresh()
  expect(roster?.rows).toHaveLength(1)
  const row = roster?.rows[0]
  expect(row).toMatchObject({
    credentialId: 'antigravity:google',
    credentialType: 'oauth',
    accountIdentity: 'user@gmail.com',
    state: 'active',
  })
  if (!row)
    throw new Error('the captured antigravity credential was not admitted')
  expect(consumer.routingRows()).toEqual([{ id: row.routeId, kind: 'oauth' }])

  const receipt = await consumer.authorize(row.routeId)
  expect(receipt).toMatchObject({
    credentialId: 'antigravity:google',
    credentialType: 'oauth',
    accountIdentity: 'user@gmail.com',
    accountIdentitySource: 'asserted',
    expectedAccountIdentity: 'user@gmail.com',
    assertedCredentialId: 'antigravity:google',
    assertedAccountIdentity: 'user@gmail.com',
    projectId: 'word-word-abc12',
    recordVersion: 2141,
  })
  expect(receipt.accessToken).toBe('x'.repeat(261))
  expect(daemon.gets).toEqual([
    { credential_id: 'antigravity:google', enrollment_token: '01'.repeat(32) },
  ])

  await consumer.reportFailure(receipt, 401, 'direct')
  expect(daemon.reports).toEqual([
    {
      credential_id: 'antigravity:google',
      enrollment_token: '01'.repeat(32),
      provider_status: 401,
      record_version: 2141,
      reporter_source: 'direct',
    },
  ])
})

test('the captured antigravity wire credential with another refresh adapter is not routed', async () => {
  const { consumer, daemon } = await scenario({
    ...capturedRow,
    refresh_adapter: 'other-adapter',
  })
  const roster = await consumer.refresh()
  expect(roster?.rows).toEqual([])
  expect(consumer.routingRows()).toEqual([])
  expect(daemon.lists).toBe(1)
  expect(daemon.gets).toEqual([])
})

test('the captured antigravity wire credential outside the family category is not routed', async () => {
  const { consumer, daemon } = await scenario({
    ...capturedRow,
    categories: ['llm-provider'],
  })
  const roster = await consumer.refresh()
  expect(roster?.rows).toEqual([])
  expect(consumer.routingRows()).toEqual([])
  expect(daemon.lists).toBe(1)
  expect(daemon.gets).toEqual([])
})
