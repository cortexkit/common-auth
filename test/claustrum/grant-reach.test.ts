import { expect } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ClaustrumConsumer,
  type ClaustrumConsumerOptions,
  type ClaustrumScopedClient,
  connectClaustrumScopedClient,
  type VaultGrantReach,
} from '../../src/claustrum/index.ts'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import {
  cleanupDirs,
  clientDecodesGrants,
  deferred,
  family,
  tempDir,
  writeToken,
} from './helpers.ts'
import {
  type MockCredential,
  type MockDaemon,
  type MockGrant,
  startMockDaemon,
} from './mock-daemon.ts'

// What the consumer reports about its own grants, read from the vault's list
// reply through the real claustrum-client decoder (the mock daemon speaks the
// wire). It is what lets a plugin tell "no grant" from "a grant that reaches
// no account" when the vault serves it nothing.

const hooks = lifetimeHooks()
const { afterEach, test } = hooks

const daemons: MockDaemon[] = []
const closers: Array<{ close(): void }> = []
afterEach(async () => {
  for (const closer of closers.splice(0)) closer.close()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await cleanupDirs()
})

const categoryGrant: MockGrant = {
  selector_kind: 'category',
  selector: family.category,
  operation: 'read',
}

/** A login without this family's category: a category grant cannot reach it. */
const uncategorized: MockCredential = {
  payload: JSON.stringify({ access_token: 'access-v1' }),
  account_id: 'account-work',
  record_version: 1,
  expires_at_ms: Date.now() + 3_600_000,
  categories: [],
}

async function scenario(input: {
  grants?: MockGrant[]
  credentials?: Record<string, MockCredential>
}) {
  const dir = await tempDir('claustrum-grant-reach-')
  const daemon = await startMockDaemon({
    directory: dir,
    credentials: input.credentials,
    grants: input.grants,
  })
  daemons.push(daemon)
  const rosterPath = join(dir, 'vault-roster.json')
  const consumer = new ClaustrumConsumer({
    rosterPath,
    tokenPath: await writeToken(dir),
    family,
    connect: () =>
      connectClaustrumScopedClient({
        connectionFile: daemon.connectionFile,
        identity: { project_root: dir, harness: 'test', session: 'grants' },
        logger: () => {},
      }),
    pollIntervalMs: 0,
  })
  closers.push(consumer)
  return { daemon, consumer, rosterPath }
}

test.if(clientDecodesGrants)(
  'no rows with zero grants reports a known absence of any grant',
  async () => {
    const { consumer, rosterPath } = await scenario({ grants: [] })
    const roster = await consumer.refresh()
    expect(roster?.rows).toEqual([])
    expect(consumer.grantReach()).toEqual({ grants: 0, tuples: [] })
    // Memory only: older readers of the roster file see no new field.
    expect(await readFile(rosterPath, 'utf8')).not.toContain('grant')
  },
)

test.if(clientDecodesGrants)(
  'no rows with a grant reports the grant that reaches nothing',
  async () => {
    const { consumer, rosterPath } = await scenario({
      grants: [categoryGrant],
      credentials: { 'oauth:test:work': uncategorized },
    })
    const roster = await consumer.refresh()
    expect(roster?.rows).toEqual([])
    expect(consumer.grantReach()).toEqual({
      grants: 1,
      tuples: [
        {
          selectorKind: 'category',
          selector: family.category,
          operation: 'read',
        },
      ],
    })
    expect(await readFile(rosterPath, 'utf8')).not.toContain('grant')
  },
)

test('a vault that sends no grant fields leaves the grant reach unknown, not zero', async () => {
  const { daemon, consumer } = await scenario({})
  const roster = await consumer.refresh()
  expect(daemon.lists).toBe(1)
  expect(roster?.rows).toEqual([])
  expect(consumer.grantReach()).toBeUndefined()
})

test.if(!clientDecodesGrants)(
  'a client older than 0.10.0 leaves the grant reach unknown even when the vault sends it',
  async () => {
    const { consumer } = await scenario({ grants: [categoryGrant] })
    expect((await consumer.refresh())?.rows).toEqual([])
    expect(consumer.grantReach()).toBeUndefined()
  },
)

test.if(clientDecodesGrants)(
  'each discovery replaces the grant reach, even when the view does not move',
  async () => {
    const { daemon, consumer } = await scenario({ grants: [] })
    const first = await consumer.refresh()
    expect(consumer.grantReach()).toEqual({ grants: 0, tuples: [] })
    // The operator grants the category; there is still no login carrying it,
    // so the list (and the view over it) is unchanged.
    daemon.grants = [categoryGrant]
    const second = await consumer.refresh()
    expect(second?.view).toBe(first?.view)
    expect(consumer.grantReach()?.grants).toBe(1)
    // A vault downgraded to one without the fields: unknown replaces the old
    // count instead of keeping it.
    daemon.grants = undefined
    await consumer.refresh()
    expect(daemon.lists).toBe(3)
    expect(consumer.grantReach()).toBeUndefined()
  },
)

test('a roster served from a peer keeps the grant reach only while its view is the one discovered', async () => {
  const dir = await tempDir('claustrum-grant-reach-peer-')
  const tokenPath = await writeToken(dir)
  const rosterPath = join(dir, 'vault-roster.json')
  const reach: VaultGrantReach = { grants: 0, tuples: [] }
  // Each consumer lists through its own fake client; `hold` parks a list call
  // so its consumer keeps the discovery lease.
  const consumerWith = (
    view: string,
    hold?: { entered: () => void; release: Promise<void> },
  ) => {
    const client: ClaustrumScopedClient = {
      listScoped: async () => {
        hold?.entered()
        await hold?.release
        return { rows: [], view, grants: reach.grants, grantTuples: [] }
      },
      getScoped: async () => {
        throw new Error('unexpected')
      },
      reportAuthFailureScoped: async () => {},
      close: () => {},
    }
    const options: ClaustrumConsumerOptions = {
      rosterPath,
      tokenPath,
      family,
      connect: async () => client,
      pollIntervalMs: 0,
    }
    const consumer = hooks.lifetime.manage(new ClaustrumConsumer(options))
    closers.push(consumer)
    return consumer
  }
  const holdingPeer = async (view: string) => {
    const entered = deferred<void>()
    const release = deferred<void>()
    hooks.lifetime.unpark(() => release.resolve())
    const peer = consumerWith(view, {
      entered: () => entered.resolve(),
      release: release.promise,
    })
    const pending = peer.refresh()
    await entered.promise
    return async () => {
      release.resolve()
      await pending
    }
  }

  const own = consumerWith('v1')
  await own.refresh()
  expect(own.grantReach()).toEqual(reach)

  // A peer holds the lease, so this refresh serves the persisted v1 roster
  // without discovering: the value discovered with v1 still describes it.
  const releaseSame = await holdingPeer('v2')
  try {
    expect((await own.refresh())?.view).toBe('v1')
    expect(own.grantReach()).toEqual(reach)
  } finally {
    await releaseSame()
  }

  // That peer committed v2. Served v2 without discovering, this consumer has
  // no grant reach for it.
  const releaseNewer = await holdingPeer('v3')
  try {
    expect((await own.refresh())?.view).toBe('v2')
    expect(own.grantReach()).toBeUndefined()
  } finally {
    await releaseNewer()
  }
})
