import { expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  ClaustrumClient,
  type ClaustrumConnector,
  ClaustrumCredentialError,
} from '@cortexkit/claustrum-client'
import {
  type ClaustrumScopedClient,
  ClaustrumScopedCustody,
  ClaustrumUnreachableError,
  type VaultConditionReason,
} from '../../src/claustrum/index.ts'
import consumerOps from './fixtures/login-conditions-v1/consumer-ops.json'
import peerList from './fixtures/login-conditions-v1/peer-list.json'
import surfaces from './fixtures/login-conditions-v1/surfaces.json'
import {
  captureLogger,
  deferred,
  fakeTimers,
  inventoryRow,
  unknownGrants,
} from './helpers.ts'

const wireListing = surfaces.listing_condition.result
const wireRow = wireListing.credentials[0]!
const family = { refreshAdapter: 'antigravity', category: 'antigravity-native' }
const identity = { credentialId: wireRow.id, credentialType: 'oauth' as const }
const token = '01'.repeat(32)
const nextToken = '02'.repeat(32)
const servedVersion = 17
const expiresAtMs = 1_000_000
const actionUrl = peerList.peer_list_condition.condition.action_url
const input = {
  reason: 'provider_verification_required',
  providerStatus: 403,
  actionUrl,
} as const
const mark = { reason: input.reason, sinceMs: wireRow.condition.since_ms }

type ScopedRow = Awaited<
  ReturnType<ClaustrumScopedClient['listScoped']>
>['rows'][number]
type ListedCondition = NonNullable<ScopedRow['condition']>
type ReportInput = Parameters<
  NonNullable<ClaustrumScopedClient['reportCondition']>
>[0]
type ClearInput = Parameters<
  NonNullable<ClaustrumScopedClient['clearCondition']>
>[0]

function row(
  condition?: ListedCondition,
  id = identity.credentialId,
): ScopedRow {
  return {
    ...inventoryRow({
      id,
      accountId: undefined,
      authMethod: 'antigravity',
      categories: [family.category],
      refreshAdapter: family.refreshAdapter,
    }),
    ...(condition && { condition }),
  }
}

function scenario(
  overrides: Partial<ClaustrumScopedClient> = {},
  chosenFamily: ConstructorParameters<
    typeof ClaustrumScopedCustody
  >[0]['family'] = family,
) {
  let rows = [row()]
  let enrollmentToken = token
  let recordVersion = servedVersion
  const report = mock(async (_input: ReportInput) => {})
  const clear = mock(async (_input: ClearInput) => true)
  const close = mock(() => {})
  const logs = captureLogger()
  const client: ClaustrumScopedClient = {
    listScoped: async () => ({ rows, view: 'view', ...unknownGrants }),
    getScoped: mock(async () => ({
      material: 'access',
      recordVersion,
      expiresAtMs,
    })),
    reportAuthFailureScoped: async () => {},
    reportCondition: report,
    clearCondition: clear,
    close,
    ...overrides,
  }
  const custody = new ClaustrumScopedCustody({
    client,
    family: chosenFamily,
    readToken: async () => ({ token: enrollmentToken, token_generation: 1 }),
    now: () => 1_000,
    logger: logs.logger,
    ...fakeTimers(),
  })
  return {
    custody,
    client,
    report,
    clear,
    close,
    logs: logs.records,
    list: (...listed: ScopedRow[]) => {
      rows = listed
      return custody.discover()
    },
    rotateToken: () => {
      enrollmentToken = nextToken
    },
    rotateVersion: () => {
      recordVersion++
    },
  }
}

test('vault owner login-condition fixtures match SHA256SUMS', async () => {
  const root = new URL('./fixtures/login-conditions-v1/', import.meta.url)
  const sha256 = (bytes: Uint8Array) =>
    createHash('sha256').update(bytes).digest('hex')
  const manifest = await readFile(new URL('SHA256SUMS', root))
  expect(sha256(manifest)).toBe(
    'a6ccbc2d37026abcdb1cdeec1ed7b18db0b753af3c2f6277654810596a9bad11',
  )
  for (const line of manifest.toString('utf8').trimEnd().split('\n')) {
    const [digest, name] = line.split('  ')
    expect(sha256(await readFile(new URL(name!, root)))).toBe(digest!)
  }
})

test('real client decodes the listing and sends the condition report and clear wire fields', async () => {
  const call = mock(
    async (_module: string, method: string, _params: object) => {
      switch (method) {
        case 'credential.list_scoped':
          return surfaces.listing_condition
        case 'credential.get_scoped':
          return {
            result: {
              credential_id: identity.credentialId,
              payload: [120],
              record_version: servedVersion,
              expires_at_ms: expiresAtMs,
            },
          }
        case 'credential.report_condition':
          return consumerOps.report_verification_required
        case 'credential.clear_condition':
          return consumerOps.clear_version_mismatch
        default:
          throw new Error(`unexpected method: ${method}`)
      }
    },
  )
  const client: ClaustrumScopedClient = await ClaustrumClient.connect({
    connectionFile: '/unused-test-connection',
    identity: { project_root: '/unused', harness: 'test', session: 'test' },
    connector: async () =>
      ({ call, close: () => {} }) as unknown as Awaited<
        ReturnType<ClaustrumConnector>
      >,
  })
  const custody = new ClaustrumScopedCustody({
    client,
    family,
    now: () => 1_000,
    readToken: async () => ({ token, token_generation: 1 }),
    logger: captureLogger().logger,
  })
  try {
    const { credentials } = await custody.discover()
    const attempt = await custody.authorize(identity)
    const expected = { ...identity, state: 'active' }
    if (!client.reportCondition) {
      expect(credentials).toStrictEqual([expected])
      expect(await custody.reportCondition(attempt, input)).toBe('unsupported')
      expect(await custody.clearCondition(attempt)).toBe('skipped')
      expect(call.mock.calls.map(([, method]) => method)).toEqual([
        'credential.list_scoped',
        'credential.get_scoped',
      ])
      return
    }
    expect(credentials).toStrictEqual([{ ...expected, condition: mark }])
    expect(await custody.reportCondition(attempt, input)).toBe('reported')
    expect(await custody.clearCondition(attempt)).toBe('reported')
    expect(
      call.mock.calls
        .slice(2)
        .map(([module, method, params]) => [module, method, params]),
    ).toStrictEqual([
      [
        'claustrum',
        'credential.report_condition',
        {
          credential_id: wireRow.id,
          record_version: servedVersion,
          reason: mark.reason,
          provider_status: 403,
          action_url: actionUrl,
          enrollment_token: token,
        },
      ],
      [
        'claustrum',
        'credential.clear_condition',
        {
          credential_id: wireRow.id,
          record_version: servedVersion,
          enrollment_token: token,
        },
      ],
    ])
  } finally {
    await custody.dispose()
  }
})

test('discovery preserves unmarked rows and ignores invalid conditions without rejecting them', async () => {
  const s = scenario()
  const invalid = [
    { reason: 'future_condition', sinceMs: 42 },
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN].map((sinceMs) => ({
      ...mark,
      sinceMs,
    })),
  ]
  const { credentials, skipped } = await s.list(
    row(mark),
    row(undefined, 'unmarked'),
    ...invalid.map((condition, index) => row(condition, `bad-${index}`)),
  )
  const expected = { ...identity, state: 'active' }
  expect(credentials).toStrictEqual([
    { ...expected, condition: mark },
    { ...expected, credentialId: 'unmarked' },
    ...invalid.map((_, index) => ({
      ...expected,
      credentialId: `bad-${index}`,
    })),
  ])
  expect(skipped).toStrictEqual([])
  expect(s.logs).toStrictEqual([])
  await s.custody.dispose()
})

test('classifying discovery gives the member the same login condition', async () => {
  const s = scenario(
    {},
    {
      category: family.category,
      refusalCodes: [],
      classify: () => ({ kind: 'mine', member: 'antigravity' }),
    },
  )
  expect((await s.list(row(mark))).credentials).toStrictEqual([
    { ...identity, member: 'antigravity', state: 'active', condition: mark },
  ])
  await s.custody.dispose()
})

test('report shares the original promise and uses served version and token provenance', async () => {
  const held = deferred<void>()
  const report = mock((_input: ReportInput) => held.promise)
  const s = scenario({ reportCondition: report })
  const first = await s.custody.authorize(identity)
  s.rotateToken()
  const second = await s.custody.authorize(identity)
  const pending = s.custody.reportCondition(first, input)
  expect(s.custody.reportCondition(second, input)).toBe(pending)
  held.resolve()
  expect(await pending).toBe('reported')
  expect(s.custody.reportCondition(second, input)).toBe(pending)
  expect(report.mock.calls).toStrictEqual([
    [
      {
        ...input,
        credentialId: identity.credentialId,
        recordVersion: servedVersion,
        enrollmentToken: token,
      },
    ],
  ])
  s.rotateVersion()
  const third = await s.custody.authorize(identity)
  expect(await s.custody.reportCondition(third, input)).toBe('reported')
  expect(report).toHaveBeenLastCalledWith({
    ...input,
    credentialId: identity.credentialId,
    recordVersion: servedVersion + 1,
    enrollmentToken: nextToken,
  })
  await s.custody.dispose()
})

test.each([
  ['provider_verification_required', 'http://accounts.google.com/check'],
  ['provider_verification_required', '/check'],
  ['provider_ineligible', actionUrl],
] as const)(
  'report drops a link for %s with input %s',
  async (reason, link) => {
    const s = scenario()
    const attempt = await s.custody.authorize(identity)
    expect(
      await s.custody.reportCondition(attempt, {
        ...input,
        reason,
        actionUrl: link,
      }),
    ).toBe('reported')
    expect(s.report.mock.calls).toStrictEqual([
      [
        {
          credentialId: identity.credentialId,
          recordVersion: servedVersion,
          enrollmentToken: token,
          reason,
          providerStatus: 403,
        },
      ],
    ])
    await s.custody.dispose()
  },
)

test('report skips unrecognized evidence and both condition calls reject a foreign receipt', async () => {
  const s = scenario()
  const other = scenario()
  const own = await s.custody.authorize(identity)
  expect(
    await s.custody.reportCondition(own, { ...input, providerStatus: 401 }),
  ).toBe('skipped')
  expect(
    await s.custody.reportCondition(own, {
      ...input,
      reason: 'future_condition' as VaultConditionReason,
    }),
  ).toBe('skipped')
  const foreign = await other.custody.authorize(identity)
  await expect(s.custody.reportCondition(foreign, input)).rejects.toMatchObject(
    { kind: 'no-receipt' },
  )
  await expect(s.custody.clearCondition(foreign)).rejects.toMatchObject({
    kind: 'no-receipt',
  })
  expect(s.report).not.toHaveBeenCalled()
  expect(s.clear).not.toHaveBeenCalled()
  await Promise.all([s.custody.dispose(), other.custody.dispose()])
})

test('kept receipts neither report nor clear a login condition', async () => {
  const s = scenario()
  await s.list(row(mark))
  await s.custody.authorize(identity)
  s.client.listScoped = async () => {
    throw new ClaustrumUnreachableError()
  }
  s.custody.transportLost()
  const kept = await s.custody.authorize(identity)
  expect(kept.fromKeptReceipt).toBe(true)
  expect(await s.custody.reportCondition(kept, input)).toBe('skipped')
  expect(await s.custody.clearCondition(kept)).toBe('skipped')
  expect(s.report).not.toHaveBeenCalled()
  expect(s.clear).not.toHaveBeenCalled()
  expect((await s.custody.authorize(identity)).fromKeptReceipt).toBe(true)
  await s.custody.dispose()
})

test('condition calls are unsupported on an older client with no methods', async () => {
  const s = scenario({ reportCondition: undefined, clearCondition: undefined })
  await s.list(row(mark))
  const attempt = await s.custody.authorize(identity)
  expect(await s.custody.reportCondition(attempt, input)).toBe('unsupported')
  expect(await s.custody.clearCondition(attempt)).toBe('unsupported')
  await s.custody.dispose()
})

test.each(['report', 'clear'] as const)(
  'unknown_method from %s disables both methods until client replacement',
  async (first) => {
    const unknown = new ClaustrumCredentialError(
      'unknown_method',
      'permanent',
      'gone',
    )
    const report = mock(async (_input: ReportInput) => {
      throw unknown
    })
    const clear = mock(async (_input: ClearInput) => {
      throw unknown
    })
    const s = scenario({ reportCondition: report, clearCondition: clear })
    const next = scenario()
    await s.list(row(mark))
    const attempt = await s.custody.authorize(identity)
    const pending =
      first === 'report'
        ? s.custody.reportCondition(attempt, input)
        : s.custody.clearCondition(attempt)
    expect(await pending).toBe('unsupported')
    const otherReason = { ...input, reason: 'provider_ineligible' } as const
    expect(await s.custody.reportCondition(attempt, otherReason)).toBe(
      'unsupported',
    )
    expect(await s.custody.clearCondition(attempt)).toBe('unsupported')
    expect(report).toHaveBeenCalledTimes(first === 'report' ? 1 : 0)
    expect(clear).toHaveBeenCalledTimes(first === 'clear' ? 1 : 0)
    // A new mark can be cleared by the replacement, but a sent report is not replayed.
    await s.list(row({ ...mark, sinceMs: mark.sinceMs + 1 }))
    s.custody.replaceClient(next.client)
    expect(await s.custody.reportCondition(attempt, otherReason)).toBe(
      'reported',
    )
    expect(await s.custody.clearCondition(attempt)).toBe('reported')
    if (first === 'report')
      expect(s.custody.reportCondition(attempt, input)).toBe(pending)
    expect(next.report).toHaveBeenCalledTimes(1)
    expect(next.clear).toHaveBeenCalledTimes(1)
    await Promise.all([s.custody.dispose(), next.custody.dispose()])
  },
)

test('condition errors give a redacted failure without retrying or changing outage state', async () => {
  const report = mock(async (_input: ReportInput) => {
    throw new ClaustrumUnreachableError()
  })
  const clear = mock((_input: ClearInput) => {
    throw new Error(`${token} ${actionUrl}`)
  })
  const s = scenario({ reportCondition: report, clearCondition: clear })
  await s.list(row(mark))
  const attempt = await s.custody.authorize(identity)
  for (let i = 0; i < 2; i++) {
    expect(await s.custody.reportCondition(attempt, input)).toBe('failed')
    expect(await s.custody.clearCondition(attempt)).toBe('failed')
  }
  expect(report).toHaveBeenCalledTimes(1)
  expect(clear).toHaveBeenCalledTimes(1)
  const details = {
    credentialId: identity.credentialId,
    recordVersion: servedVersion,
    reason: input.reason,
  }
  expect(s.logs).toStrictEqual([
    {
      level: 'debug',
      message: 'scoped login condition update failed',
      data: details,
    },
    {
      level: 'debug',
      message: 'scoped login condition update failed',
      data: details,
    },
  ])
  expect((await s.custody.authorize(identity)).fromKeptReceipt).toBeUndefined()
  await s.custody.dispose()
})

test('clear only sends once per listed mark, treats false as reported, and waits for the next listing', async () => {
  const held = deferred<boolean>()
  const clear = mock((_input: ClearInput) => held.promise)
  const s = scenario({ clearCondition: clear })
  const attempt = await s.custody.authorize(identity)
  await s.list(row())
  expect(await s.custody.clearCondition(attempt)).toBe('skipped')
  expect(clear).not.toHaveBeenCalled()
  await s.list(row(mark))
  s.rotateToken()
  s.rotateVersion()
  const second = await s.custody.authorize(identity)
  const first = s.custody.clearCondition(attempt)
  expect(s.custody.clearCondition(second)).toBe(first)
  held.resolve(false)
  expect(await first).toBe('reported')
  expect(s.custody.clearCondition(second)).toBe(first)
  expect(clear.mock.calls).toStrictEqual([
    [
      {
        credentialId: identity.credentialId,
        recordVersion: servedVersion,
        enrollmentToken: token,
      },
    ],
  ])
  expect(s.logs).toStrictEqual([
    {
      level: 'debug',
      message: 'scoped login condition not cleared',
      data: {
        credentialId: identity.credentialId,
        recordVersion: servedVersion,
        reason: mark.reason,
      },
    },
  ])
  await s.list(row({ ...mark, sinceMs: mark.sinceMs + 1 }))
  expect(await s.custody.clearCondition(second)).toBe('reported')
  expect(clear).toHaveBeenCalledTimes(2)
  expect(clear).toHaveBeenLastCalledWith({
    credentialId: identity.credentialId,
    recordVersion: servedVersion + 1,
    enrollmentToken: nextToken,
  })
  await s.list(row())
  expect(await s.custody.clearCondition(second)).toBe('skipped')
  expect(clear).toHaveBeenCalledTimes(2)
  await s.custody.dispose()
})

test('disposal gives condition calls one shared bounded drain', async () => {
  const held = deferred<void>()
  const report = mock((_input: ReportInput) => held.promise)
  const clear = mock(async (_input: ClearInput) => {
    await held.promise
    return true
  })
  const s = scenario({ reportCondition: report, clearCondition: clear })
  await s.list(row(mark))
  const attempt = await s.custody.authorize(identity)
  const reporting = s.custody.reportCondition(attempt, input)
  const clearing = s.custody.clearCondition(attempt)
  const onTimeout = mock((_count: number) => {})
  const started = performance.now()
  const disposing = s.custody.dispose(onTimeout)
  try {
    expect(s.close).not.toHaveBeenCalled()
    await disposing
    expect(performance.now() - started).toBeLessThan(2_500)
    expect(onTimeout.mock.calls).toStrictEqual([[2]])
    expect(s.close).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledTimes(1)
  } finally {
    held.resolve()
    await Promise.all([disposing, reporting, clearing])
  }
})
