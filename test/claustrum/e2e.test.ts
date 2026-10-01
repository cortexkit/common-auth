import { afterEach, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ClaustrumConsumer,
  type ClaustrumConsumerOptions,
  ClaustrumEnrollmentManager,
  connectClaustrumEnrollmentClient,
  connectClaustrumScopedClient,
  getClaustrumEnrollmentPaths,
  readVaultRoster,
} from '../../src/claustrum/index.ts'
import {
  captureLogger,
  cleanupDirs,
  family,
  tempDir,
  writeToken,
} from './helpers.ts'
import {
  type MockCredential,
  type MockDaemon,
  startMockDaemon,
} from './mock-daemon.ts'

const daemons: MockDaemon[] = []
const closers: Array<{ close(): void }> = []
afterEach(async () => {
  for (const closer of closers.splice(0)) closer.close()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await cleanupDirs()
})

const HOUR = 3_600_000

function credential(overrides: Partial<MockCredential> = {}): MockCredential {
  return {
    payload: JSON.stringify({ access_token: 'access-v1' }),
    account_id: 'account-work',
    record_version: 1,
    expires_at_ms: Date.now() + HOUR,
    ...overrides,
  }
}

async function scenario(
  credentials: Record<string, MockCredential>,
  extra: Partial<ClaustrumConsumerOptions> = {},
) {
  const dir = await tempDir('claustrum-e2e-')
  const daemon = await startMockDaemon({ directory: dir, credentials })
  daemons.push(daemon)
  const tokenPath = await writeToken(dir)
  const logs = captureLogger()
  const errors: unknown[] = []
  const options: ClaustrumConsumerOptions = {
    rosterPath: join(dir, 'vault-roster.json'),
    tokenPath,
    family,
    connect: () =>
      connectClaustrumScopedClient({
        connectionFile: daemon.connectionFile,
        identity: { project_root: dir, harness: 'test', session: 'e2e' },
        logger: () => {},
      }),
    pollIntervalMs: 0,
    logger: logs.logger,
    onError: (error) => errors.push(error),
    ...extra,
  }
  const consumer = new ClaustrumConsumer(options)
  closers.push(consumer)
  return { dir, daemon, consumer, options, logs, errors }
}

function routeFor(consumer: ClaustrumConsumer, credentialId: string): string {
  const row = consumer
    .snapshot()
    ?.rows.find((entry) => entry.credentialId === credentialId)
  if (!row) throw new Error(`no route for ${credentialId}`)
  return row.routeId
}

function bearer(token: string) {
  return new Headers({ authorization: `Bearer ${token}` })
}

test('a cold vault account is listed but never routed or authorized', async () => {
  const s = await scenario({
    'oauth:test:work': credential(),
    'oauth:test:cold': credential({
      account_id: 'account-cold',
      state: 'needs_reauth',
    }),
  })
  await s.consumer.refresh()
  const cold = routeFor(s.consumer, 'oauth:test:cold')
  const work = routeFor(s.consumer, 'oauth:test:work')
  expect(s.consumer.routingRows().map((row) => row.id)).toEqual([work])
  await expect(s.consumer.authorize(cold)).rejects.toThrow('changed')
  expect(s.daemon.gets.map((get) => get.credential_id)).toEqual([])
  const attempt = await s.consumer.authorize(work)
  expect(attempt.accessToken).toBe('access-v1')
})

test('a warm account goes cold after a served 401 and leaves routing', async () => {
  const s = await scenario({
    'oauth:test:work': credential({ record_version: 7 }),
  })
  s.daemon.onReport = (report) => {
    const target = s.daemon.credentials[report.credential_id ?? '']
    if (target && target.record_version === report.record_version)
      target.state = 'needs_reauth'
  }
  await s.consumer.refresh()
  const work = routeFor(s.consumer, 'oauth:test:work')
  const sent: string[] = []
  const response = await s.consumer.send(
    work,
    async (attempt) => {
      sent.push(attempt.accessToken)
      return new Response(null, { status: 401, headers: bearer('x') })
    },
    { site: 'model' },
  )
  expect(response.status).toBe(401)
  expect(sent).toEqual(['access-v1'])
  expect(s.daemon.reports).toEqual([
    {
      credential_id: 'oauth:test:work',
      enrollment_token: '01'.repeat(32),
      provider_status: 401,
      record_version: 7,
      reporter_source: 'direct',
    },
  ])
  await s.consumer.refresh()
  expect(s.consumer.routingRows()).toEqual([])
  expect(s.consumer.snapshot()?.rows[0]?.state).toBe('needs_reauth')
})

test('a 401 is attributed to the record that served it', async () => {
  const s = await scenario({
    'oauth:test:a': credential({ account_id: 'account-a', record_version: 3 }),
    'oauth:test:b': credential({
      account_id: 'account-b',
      record_version: 9,
      payload: JSON.stringify({ access_token: 'access-b' }),
    }),
  })
  await s.consumer.refresh()
  const a = routeFor(s.consumer, 'oauth:test:a')
  const b = routeFor(s.consumer, 'oauth:test:b')
  const ok = await s.consumer.send(a, async () => new Response('ok'), {
    site: 'model',
  })
  expect(ok.status).toBe(200)
  // The vault refreshes b between the send and the 401: the report must still
  // name the version that send used, and the retry uses the new one.
  const sent: string[] = []
  const response = await s.consumer.send(
    b,
    async (attempt) => {
      sent.push(`${attempt.accessToken}@${attempt.recordVersion}`)
      const target = s.daemon.credentials['oauth:test:b']
      if (target) {
        target.record_version += 1
        target.payload = JSON.stringify({ access_token: 'access-b2' })
      }
      return new Response(null, { status: 401 })
    },
    { site: 'model', reporterSource: 'relay_status_field' },
  )
  expect(response.status).toBe(401)
  expect(sent).toEqual(['access-b@9', 'access-b2@10'])
  expect(s.daemon.reports).toEqual([
    {
      credential_id: 'oauth:test:b',
      enrollment_token: '01'.repeat(32),
      provider_status: 401,
      record_version: 10,
      reporter_source: 'relay_status_field',
    },
  ])
})

test('a malformed vault record is skipped and warned about while the rest of the list is used', async () => {
  const s = await scenario({
    'oauth:test:work': credential(),
    'oauth:test:blank': credential({ account_id: '   ' }),
  })
  const roster = await s.consumer.refresh()
  expect(roster?.rows.map((row) => row.credentialId)).toEqual([
    'oauth:test:work',
  ])
  expect(
    s.logs.records.filter(
      (record) => record.message === 'skipped malformed vault record',
    ),
  ).toEqual([
    {
      level: 'warn',
      message: 'skipped malformed vault record',
      data: {
        credentialId: 'oauth:test:blank',
        reason: 'blank account identity',
      },
    },
  ])
})

test('enrollment resumes after a restart between propose and poll', async () => {
  const dir = await tempDir('claustrum-e2e-enroll-')
  const daemon = await startMockDaemon({ directory: dir })
  daemons.push(daemon)
  const paths = getClaustrumEnrollmentPaths(
    join(dir, 'state', 'opencode-enrollment.json'),
  )
  const connect = async () => {
    const client = await connectClaustrumEnrollmentClient({
      connectionFile: daemon.connectionFile,
      identity: { project_root: dir, harness: 'test', session: 'setup' },
      logger: () => {},
    })
    closers.push(client)
    return client
  }
  const first = new ClaustrumEnrollmentManager({
    client: await connect(),
    paths,
    proposedName: 'test-auth-opencode',
  })
  const proposed = await first.reconcile()
  expect(proposed).toEqual({
    state: 'pending',
    proposedName: 'test-auth-opencode',
    requestId: 'request-1',
  })
  // The process stops here. A new one, with a new connection, resumes the
  // poll from disk instead of proposing again.
  daemon.approve('request-1', 'cd'.repeat(32), 2)
  const resumed = new ClaustrumEnrollmentManager({
    client: await connect(),
    paths,
    proposedName: 'test-auth-opencode',
  })
  expect(await resumed.reconcile()).toEqual({
    state: 'approved',
    proposedName: 'test-auth-opencode',
    approvedName: 'test-auth-opencode',
    tokenGeneration: 2,
  })
  expect(daemon.proposals).toHaveLength(1)
  expect(JSON.parse(await readFile(paths.tokenPath, 'utf8'))).toEqual({
    token: 'cd'.repeat(32),
    token_generation: 2,
  })
})

test('enrollment re-proposes with the persisted secret after a restart before the request id was saved', async () => {
  const dir = await tempDir('claustrum-e2e-enroll-')
  const daemon = await startMockDaemon({ directory: dir })
  daemons.push(daemon)
  const paths = getClaustrumEnrollmentPaths(
    join(dir, 'state', 'pi-enrollment.json'),
  )
  const client = await connectClaustrumEnrollmentClient({
    connectionFile: daemon.connectionFile,
    identity: { project_root: dir, harness: 'test', session: 'setup' },
    logger: () => {},
  })
  closers.push(client)
  // The vault commits the proposal but the reply is lost with the process.
  const crashing = new ClaustrumEnrollmentManager({
    client: {
      enrollPropose: async (input) => {
        await client.enrollPropose(input)
        throw new Error('process stopped before saving the request id')
      },
      enrollPoll: (input) => client.enrollPoll(input),
    },
    paths,
    proposedName: 'test-auth-pi',
  })
  await expect(crashing.reconcile()).rejects.toThrow('process stopped')
  const resumed = new ClaustrumEnrollmentManager({
    client,
    paths,
    proposedName: 'test-auth-pi',
  })
  expect(await resumed.reconcile()).toMatchObject({
    state: 'pending',
    requestId: 'request-1',
  })
  expect(daemon.proposals).toHaveLength(2)
  expect(daemon.proposals[0]?.hash).toBe(daemon.proposals[1]?.hash)
})

test('a declined vault account stays declined across refreshes and version bumps until its account changes', async () => {
  const s = await scenario({ 'oauth:test:work': credential() })
  await s.consumer.refresh()
  const work = routeFor(s.consumer, 'oauth:test:work')
  await s.consumer.decline(work)
  expect(s.consumer.routingRows()).toEqual([])
  await expect(s.consumer.authorize(work)).rejects.toThrow('disabled')

  const target = s.daemon.credentials['oauth:test:work']
  if (!target) throw new Error('missing fixture credential')
  target.record_version = 2
  await s.consumer.refresh()
  expect(s.consumer.routingRows()).toEqual([])

  // An adapter that stops claiming an identity proves nothing: still declined.
  delete target.account_id
  await s.consumer.refresh()
  expect(s.consumer.routingRows()).toEqual([])

  // Logged into a different known account: the decline no longer applies.
  target.account_id = 'account-other'
  await s.consumer.refresh()
  expect(s.consumer.routingRows()).toHaveLength(1)
  expect((await readVaultRoster(s.options.rosterPath))?.declined).toEqual([])
})

test('the view cursor notifies on visible changes and ignores token refreshes', async () => {
  const views: string[] = []
  const s = await scenario(
    { 'oauth:test:work': credential() },
    { onRoster: (roster) => views.push(roster.view ?? '') },
  )
  await s.consumer.refresh()
  await s.consumer.refresh()
  expect(views).toHaveLength(1)
  const target = s.daemon.credentials['oauth:test:work']
  if (!target) throw new Error('missing fixture credential')
  target.record_version = 5
  await s.consumer.refresh()
  expect(views).toHaveLength(1)
  s.daemon.credentials['oauth:test:second'] = credential({
    account_id: 'account-second',
  })
  await s.consumer.refresh()
  expect(views).toHaveLength(2)
  expect(views[1]).not.toBe(views[0])
  expect(s.daemon.lists).toBe(4)
})
