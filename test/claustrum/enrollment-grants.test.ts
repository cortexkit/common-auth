import { describe, expect } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ClaustrumClient,
  type ClaustrumConnector,
  ClaustrumCredentialError,
  writeEnrollmentTokenFile,
} from '@cortexkit/claustrum-client'
import {
  type ClaustrumEnrollmentClient,
  ClaustrumEnrollmentManager,
  type ClaustrumRequestedGrant,
  getClaustrumEnrollmentPaths,
  readClaustrumEnrollmentStatus,
  validEnrollmentRequestedGrants,
} from '../../src/claustrum/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'

const { afterEach, test } = lifetimeHooks()
const roots: string[] = []
const secret = '01'.repeat(32)
const requestedGrants = [
  { selector: { category: 'openai-native' }, operation: 'read' },
  { selector: { exact: 'account-1' }, operation: 'list' },
] as const satisfies ReadonlyArray<ClaustrumRequestedGrant>

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'enrollment-grants-'))
  roots.push(root)
  return getClaustrumEnrollmentPaths(join(root, 'enrollment.json'))
}

function manager(
  paths: Awaited<ReturnType<typeof fixture>>,
  client: Partial<ClaustrumEnrollmentClient> = {},
  options: Partial<
    ConstructorParameters<typeof ClaustrumEnrollmentManager>[0]
  > = {},
) {
  return new ClaustrumEnrollmentManager({
    paths,
    proposedName: 'test-auth-opencode',
    mintSecret: () => secret,
    now: () => 1000,
    client: {
      enrollPropose: async () => ({ requestId: 'request-1' }),
      enrollPoll: async () => ({ status: 'pending' }),
      ...client,
    },
    ...options,
  })
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('enrollment requested grants', () => {
  test('requested grants reach the proposal exactly and survive approval and status reads', async () => {
    const paths = await fixture()
    const proposals: Parameters<
      ClaustrumEnrollmentClient['enrollPropose']
    >[0][] = []
    const instance = manager(
      paths,
      {
        async enrollPropose(input) {
          proposals.push(input)
          return { requestId: 'request-1' }
        },
        async enrollPoll() {
          return {
            status: 'approved',
            name: 'approved-name',
            token: 'ab'.repeat(32),
            tokenGeneration: 1,
          }
        },
      },
      { requestedGrants },
    )
    expect(await instance.reconcile()).toMatchObject({
      state: 'approved',
      requestedGrants,
      requestedGrantsStatus: 'sent',
    })
    expect(proposals).toEqual([
      {
        name: 'test-auth-opencode',
        requestSecretHash:
          '72cd6e8422c407fb6d098690f1130b7ded7ec2f7f5e1d30bd9d521f015363793',
        requestedGrants,
      },
    ])
    expect(await instance.status()).toMatchObject({
      state: 'approved',
      requestedGrants,
      requestedGrantsStatus: 'sent',
    })
    expect(await manager(paths).reconcile()).toMatchObject({
      state: 'approved',
      requestedGrants,
      requestedGrantsStatus: 'sent',
    })
  })

  test('invalid requested grants throw before any send', async () => {
    const paths = await fixture()
    let sent = 0
    const valid = { selector: { category: 'llm-provider' }, operation: 'read' }
    for (const invalid of [
      [],
      Array(5).fill(valid),
      Array(1),
      [{ ...valid, operation: 'write' }],
      [
        {
          selector: { category: 'llm-provider', exact: 'one' },
          operation: 'read',
        },
      ],
      [{ selector: {}, operation: 'read' }],
      [{ selector: { category: '' }, operation: 'read' }],
      [{ selector: { exact: '  ' }, operation: 'list' }],
      [{ selector: { credentialId: 'one' }, operation: 'read' }],
      [{ ...valid, extra: true }],
      null,
    ]) {
      expect(validEnrollmentRequestedGrants(invalid)).toBe(false)
      expect(() =>
        manager(
          paths,
          {
            async enrollPropose() {
              sent++
              return { requestId: 'unexpected' }
            },
          },
          {
            requestedGrants: invalid as ReadonlyArray<ClaustrumRequestedGrant>,
          },
        ),
      ).toThrow('invalid Claustrum enrollment requested grants')
    }
    expect(sent).toBe(0)
    expect(validEnrollmentRequestedGrants(Array(4).fill(valid))).toBe(true)
    expect(validEnrollmentRequestedGrants(requestedGrants)).toBe(true)
  })

  test('older vault retries once without both optional fields byte-identically to a plain proposal', async () => {
    const plainPaths = await fixture()
    let plainBytes = ''
    await manager(plainPaths, {
      async enrollPropose(input) {
        plainBytes = JSON.stringify(input)
        return { requestId: 'plain' }
      },
    }).reconcile()
    for (const displayName of [undefined, 'Plugin for OpenCode']) {
      const paths = await fixture()
      const proposals: Parameters<
        ClaustrumEnrollmentClient['enrollPropose']
      >[0][] = []
      const instance = manager(
        paths,
        {
          async enrollPropose(input) {
            proposals.push(input)
            if (proposals.length === 1)
              throw new ClaustrumCredentialError(
                'invalid_params',
                'permanent',
                'gone',
              )
            return { requestId: 'old-vault' }
          },
        },
        { displayName, requestedGrants },
      )
      expect(await instance.reconcile()).toMatchObject({
        state: 'pending',
        requestId: 'old-vault',
        requestedGrantsStatus: 'dropped',
        requestedGrants,
      })
      expect(proposals).toHaveLength(2)
      expect(proposals[0]?.requestedGrants).toEqual(requestedGrants)
      expect(JSON.stringify(proposals[1])).toBe(plainBytes)
      expect(await instance.status()).toMatchObject({
        requestedGrantsStatus: 'dropped',
      })
      expect(
        await manager(paths, {
          async enrollPoll() {
            return {
              status: 'approved',
              name: 'renamed',
              token: 'ab'.repeat(32),
              tokenGeneration: 1,
            }
          },
        }).reconcile(),
      ).toMatchObject({ state: 'approved', requestedGrantsStatus: 'dropped' })
      expect(await instance.status()).toMatchObject({
        state: 'approved',
        requestedGrantsStatus: 'dropped',
      })
    }
  })

  test('a pending re-proposal keeps its first list even after an interrupted send', async () => {
    const paths = await fixture()
    await expect(
      manager(
        paths,
        {
          async enrollPropose() {
            throw new Error('interrupted after the vault stored the request')
          },
        },
        { requestedGrants },
      ).reconcile(),
    ).rejects.toThrow('interrupted')
    let reproposed: unknown
    const changed = [
      { selector: { category: 'other' }, operation: 'read' },
    ] as const
    const resumed = manager(
      paths,
      {
        async enrollPropose(input) {
          reproposed = input.requestedGrants
          return { requestId: 'original' }
        },
      },
      { requestedGrants: changed },
    )
    expect(await resumed.reconcile()).toMatchObject({
      requestedGrants,
      requestedGrantsStatus: 'sent',
    })
    expect(reproposed).toEqual(requestedGrants)
    let sends = 0
    await manager(
      paths,
      {
        async enrollPropose() {
          sends++
          return { requestId: 'unexpected' }
        },
      },
      { requestedGrants: changed },
    ).reconcile()
    expect(sends).toBe(0)
  })

  test('a legacy pending enrollment does not acquire a newly configured list', async () => {
    const paths = await fixture()
    await expect(
      manager(paths, {
        async enrollPropose() {
          throw new Error('interrupt')
        },
      }).reconcile(),
    ).rejects.toThrow('interrupt')
    let proposal: unknown
    await manager(
      paths,
      {
        async enrollPropose(input) {
          proposal = input
          return { requestId: 'legacy' }
        },
      },
      { requestedGrants },
    ).reconcile()
    expect(proposal).not.toHaveProperty('requestedGrants')
  })

  test('grant fallback status survives an interruption after writing the token', async () => {
    const paths = await fixture()
    const instance = manager(
      paths,
      {
        async enrollPropose(input) {
          if (input.requestedGrants)
            throw new ClaustrumCredentialError(
              'invalid_params',
              'permanent',
              'gone',
            )
          return { requestId: 'old-vault' }
        },
        async enrollPoll() {
          return {
            status: 'approved',
            name: 'approved-name',
            token: 'ab'.repeat(32),
            tokenGeneration: 1,
          }
        },
      },
      {
        requestedGrants,
        async writeTokenFile(path, token) {
          await writeEnrollmentTokenFile(path, token)
          throw new Error('interrupted before saving approved metadata')
        },
      },
    )
    await expect(instance.reconcile()).rejects.toThrow('interrupted')
    expect(await instance.status()).toMatchObject({
      state: 'approved',
      requestedGrants,
      requestedGrantsStatus: 'dropped',
    })
    expect(await manager(paths).reconcile()).toMatchObject({
      state: 'approved',
      requestedGrants,
      requestedGrantsStatus: 'dropped',
    })
  })

  test('the decoder keeps the same enrollment status with additive grant keys', async () => {
    const paths = await fixture()
    await manager(paths).reconcile()
    const before = await readClaustrumEnrollmentStatus(
      paths,
      'test-auth-opencode',
    )
    if (before.state !== 'pending') throw new Error('expected pending')
    const state = JSON.parse(await readFile(paths.statePath, 'utf8'))
    await writeFile(
      paths.statePath,
      JSON.stringify({
        ...state,
        requestedGrants,
        requestedGrantsStatus: 'sent',
        futureKey: 'ignored',
      }),
      { mode: 0o600 },
    )
    const after = await readClaustrumEnrollmentStatus(
      paths,
      'test-auth-opencode',
    )
    expect(after).toMatchObject(before)
    expect(after).toMatchObject({
      requestedGrants,
      requestedGrantsStatus: 'sent',
    })
    if (after.state !== 'pending') throw new Error('expected pending')
    const {
      requestedGrants: _,
      requestedGrantsStatus: __,
      ...enrollment
    } = after
    expect(enrollment).toEqual(before)
  })

  test('real client connect puts requested_grants on the enrollment wire', async () => {
    const paths = await fixture()
    const calls: { module: string; method: string; params: unknown }[] = []
    let closed = 0
    const transport = {
      async call(module: string, method: string, params: unknown) {
        calls.push({ module, method, params })
        return {
          result:
            method === 'auth.enroll_propose'
              ? { request_id: 'wire-request' }
              : { status: 'pending' },
        }
      },
      close() {
        closed++
      },
    }
    const client = await ClaustrumClient.connect({
      connectionFile: join(roots[roots.length - 1]!, 'unused-connection.json'),
      identity: { project_root: '/test', harness: 'test', session: 'test' },
      connector: async () =>
        transport as unknown as Awaited<ReturnType<ClaustrumConnector>>,
    })
    try {
      await manager(
        paths,
        {},
        {
          client,
          requestedGrants,
          displayName: 'Plugin for OpenCode',
        },
      ).reconcile()
      expect(calls).toEqual([
        {
          module: 'claustrum',
          method: 'auth.enroll_propose',
          params: {
            proposed_name: 'test-auth-opencode',
            request_secret_hash:
              '72cd6e8422c407fb6d098690f1130b7ded7ec2f7f5e1d30bd9d521f015363793',
            display_name: 'Plugin for OpenCode',
            requested_grants: requestedGrants,
          },
        },
        {
          module: 'claustrum',
          method: 'auth.enroll_poll',
          params: {
            request_id: 'wire-request',
            request_secret: secret,
          },
        },
      ])
    } finally {
      client.close()
    }
    expect(closed).toBe(1)
  })
})
