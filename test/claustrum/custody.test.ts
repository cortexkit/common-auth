import { describe, expect, mock, test } from 'bun:test'
import {
  ClaustrumClient,
  type ClaustrumConnector,
} from '@cortexkit/claustrum-client'
import {
  type ClaustrumScopedClient,
  ClaustrumScopedCustody,
  ClaustrumUnreachableError,
  decideScopedRetryAfter401,
  isScopedCredentialRotation,
} from '../../src/claustrum/index.ts'
import type {
  ScopedWatchEnd,
  ScopedWatchNoticeShape,
} from '../../src/claustrum/watch.ts'
import {
  captureLogger,
  deferred,
  exhaustReceiptWait,
  fakeTimers,
  family,
  inventoryRow,
  realApiKeyRow,
  unknownGrants,
  until,
} from './helpers.ts'

const identity = {
  credentialId: 'oauth:test:work',
  credentialType: 'oauth' as const,
  accountIdentity: 'account-1',
}
const served = {
  credentialId: identity.credentialId,
  accountId: identity.accountIdentity,
}
const row = inventoryRow()

function fixture(
  overrides: Partial<ClaustrumScopedClient> = {},
  extra: Partial<ConstructorParameters<typeof ClaustrumScopedCustody>[0]> = {},
) {
  const gets: unknown[] = []
  const reports: unknown[] = []
  const logs = captureLogger()
  let token = '01'.repeat(32)
  const client: ClaustrumScopedClient = {
    listScoped: async () => ({ rows: [row], view: 'view-1', ...unknownGrants }),
    getScoped: async (input) => {
      gets.push(input)
      return {
        ...served,
        material: 'test-access',
        recordVersion: 7,
        expiresAtMs: 1_000_000,
      }
    },
    reportAuthFailureScoped: async (input) => {
      reports.push(input)
    },
    close: () => {},
    ...overrides,
  }
  const custody = new ClaustrumScopedCustody({
    client,
    family,
    readToken: async () => ({ token, token_generation: 1 }),
    now: () => 1_000,
    logger: logs.logger,
    ...extra,
  })
  return {
    custody,
    client,
    gets,
    reports,
    logs,
    rotate: () => {
      token = '02'.repeat(32)
    },
  }
}

describe('scoped custody client replacement', () => {
  test('reports a pre-swap 401 through the replacement with the original token and version', async () => {
    const first = fixture()
    const next = fixture({
      getScoped: async () => ({
        ...served,
        material: 'next-access',
        recordVersion: 8,
        expiresAtMs: 1_000_000,
      }),
    })
    const attempt = await first.custody.authorize(identity)
    first.rotate()
    first.custody.replaceClient(next.client)
    await first.custody.authorize(identity)
    await first.custody.reportFailure(attempt, 403, 'direct')
    await first.custody.reportFailure(attempt, 429, 'direct')
    expect(next.reports).toEqual([])
    await first.custody.reportFailure(attempt, 401, 'relay_status_field')
    expect(next.reports).toEqual([
      {
        credentialId: identity.credentialId,
        enrollmentToken: '01'.repeat(32),
        providerStatus: 401,
        recordVersion: 7,
        reporterSource: 'relay_status_field',
      },
    ])
    expect(first.reports).toEqual([])
  })

  test('authorizes and lists through the replacement client', async () => {
    const first = fixture()
    const next = fixture({
      listScoped: mock(async () => ({
        rows: [row],
        view: 'next-view',
        ...unknownGrants,
      })),
    })
    first.custody.replaceClient(next.client)
    expect((await first.custody.authorize(identity)).accessToken).toBe(
      'test-access',
    )
    expect(next.gets).toEqual([
      {
        credentialId: identity.credentialId,
        enrollmentToken: '01'.repeat(32),
        minTtlMs: 300_000,
      },
    ])
    expect(first.gets).toEqual([])
    expect((await first.custody.discover()).view).toBe('next-view')
    expect(next.client.listScoped).toHaveBeenCalledWith('01'.repeat(32))
  })

  test('keeps a last-good receipt across replacement and drops a kept 401 without reporting', async () => {
    const timers = fakeTimers()
    const first = fixture(
      {
        listScoped: async () => {
          throw new ClaustrumUnreachableError()
        },
      },
      timers,
    )
    const next = fixture({
      getScoped: async () => {
        throw new ClaustrumUnreachableError()
      },
      listScoped: async () => {
        throw new ClaustrumUnreachableError()
      },
    })
    try {
      const original = await first.custody.authorize(identity)
      first.custody.transportLost()
      const before = await first.custody.authorize(identity)
      expect(before.fromKeptReceipt).toBe(true)
      const state = first.custody.keptReceiptState()
      first.custody.replaceClient(next.client)
      expect(first.custody.keptReceiptState()).toEqual(state)
      const kept = await first.custody.authorize(identity)
      expect(kept.fromKeptReceipt).toBe(true)
      expect(kept.accessToken).toBe(original.accessToken)
      expect(kept.recordVersion).toBe(7)
      await first.custody.reportFailure(kept, 401, 'direct')
      expect(first.reports).toEqual([])
      expect(next.reports).toEqual([])
      await expect(
        exhaustReceiptWait(first.custody.authorize(identity), timers),
      ).rejects.toThrow()
    } finally {
      await first.custody.dispose()
    }
  })

  test('refuses another custody receipt after replacement', async () => {
    const first = fixture()
    const next = fixture()
    const foreign = await next.custody.authorize(identity)
    first.custody.replaceClient(next.client)
    await expect(
      first.custody.reportFailure(foreign, 401, 'direct'),
    ).rejects.toMatchObject({ kind: 'no-receipt' })
    expect(first.reports).toEqual([])
    expect(next.reports).toEqual([])
  })

  test('replacement never closes either client and disposal closes only the current client', async () => {
    const first = fixture({ close: mock(() => {}) })
    const next = fixture({ close: mock(() => {}) })
    first.custody.replaceClient(next.client)
    expect(first.client.close).not.toHaveBeenCalled()
    expect(next.client.close).not.toHaveBeenCalled()
    await first.custody.dispose()
    expect(first.client.close).not.toHaveBeenCalled()
    expect(next.client.close).toHaveBeenCalledTimes(1)
    expect(() => first.custody.replaceClient(first.client)).toThrow(
      expect.objectContaining({ kind: 'closed' }),
    )
    expect(() => first.custody.replaceClient(next.client)).toThrow(
      expect.objectContaining({ kind: 'closed' }),
    )
  })

  test('queued usage follows the replacement and retains ownership', async () => {
    const first = fixture({ reportUsageScoped: mock(async () => {}) })
    const next = fixture({ reportUsageScoped: mock(async () => {}) })
    await first.custody.authorize(identity)
    first.custody.reportUsage({
      credentialId: identity.credentialId,
      reading: { provider: 'test-provider', observedAtMs: 1 },
    })
    first.custody.replaceClient(next.client)
    await first.custody.dispose()
    expect(first.client.reportUsageScoped).not.toHaveBeenCalled()
    expect(next.client.reportUsageScoped).toHaveBeenCalledTimes(1)
    expect(next.client.reportUsageScoped).toHaveBeenCalledWith({
      credentialId: identity.credentialId,
      reading: { provider: 'test-provider', observedAtMs: 1 },
      enrollmentToken: '01'.repeat(32),
    })
  })

  function watchFixture() {
    let opened = false
    let notice!: (notice: ScopedWatchNoticeShape) => void
    const ended = deferred<ScopedWatchEnd>()
    const stop = mock(() => ended.resolve({ kind: 'ended' }))
    const f = fixture({
      watchScoped: mock((onNotice) => {
        opened = true
        notice = onNotice
        return { stop, closed: ended.promise }
      }),
    })
    return {
      ...f,
      stop,
      opened: () => opened,
      notify: (seq = 1) =>
        notice({ kind: 'changed', view: 'view-1', epoch: 'epoch', seq }),
    }
  }

  test('reopens watches on replacement with the same handle and discovers across the gap', async () => {
    const first = watchFixture()
    const next = watchFixture()
    const views: string[] = []
    const modes: string[] = []
    await first.custody.discover()
    const watch = first.custody.watchRoster({
      onView: (view) => {
        views.push(view)
      },
      onMode: (mode) => modes.push(mode),
    })
    try {
      await until(first.opened, 'first watch opens')
      first.notify()
      await until(() => watch.mode === 'watching', 'first watch accepted')
      first.custody.replaceClient(next.client)
      expect(first.stop).toHaveBeenCalledTimes(1)
      expect(watch.mode).toBe('polling')
      await until(next.opened, 'replacement watch opens')
      next.notify()
      await until(() => views.length === 1, 'discovery across replacement gap')
      expect(views).toEqual(['view-1'])
      expect(watch.mode).toBe('watching')
      expect(modes).toEqual(['watching', 'polling', 'watching'])
      first.notify(3)
      await Bun.sleep(0)
      expect(views).toEqual(['view-1'])
      watch.close()
      expect(next.stop).toHaveBeenCalledTimes(1)
    } finally {
      await first.custody.dispose()
    }
  })

  test('same-client replacement leaves its receipt and open watch unchanged', async () => {
    const first = watchFixture()
    const attempt = await first.custody.authorize(identity)
    const watch = first.custody.watchRoster({ onView: () => {} })
    try {
      await until(first.opened, 'watch opens')
      first.notify()
      first.custody.replaceClient(first.client)
      expect(first.stop).not.toHaveBeenCalled()
      expect(first.client.watchScoped).toHaveBeenCalledTimes(1)
      expect(watch.mode).toBe('watching')
      await first.custody.reportFailure(attempt, 401, 'direct')
      expect(first.reports).toHaveLength(1)
    } finally {
      watch.close()
      await first.custody.dispose()
    }
  })

  test('replacement waits for an in-flight watch discovery before discovering again', async () => {
    const first = watchFixture()
    const next = watchFixture()
    const blocked = deferred<void>()
    const onView = mock(() => blocked.promise)
    const watch = first.custody.watchRoster({ onView })
    try {
      await until(first.opened, 'first watch opens')
      first.notify()
      await until(
        () => onView.mock.calls.length === 1,
        'first discovery starts',
      )
      first.custody.replaceClient(next.client)
      await until(next.opened, 'replacement watch opens')
      next.notify()
      await Bun.sleep(0)
      expect(onView).toHaveBeenCalledTimes(1)
      blocked.resolve()
      await until(
        () => onView.mock.calls.length === 2,
        'replacement discovery starts',
      )
    } finally {
      blocked.resolve()
      watch.close()
      await first.custody.dispose()
    }
  })
})

describe('scoped custody dispatch authorization', () => {
  test('a real apikey row is mine and serves with the derived api_key type', async () => {
    const key = realApiKeyRow()
    const { custody } = fixture(
      {
        listScoped: async () => ({ rows: [key], view: 'v', ...unknownGrants }),
        getScoped: async () => ({
          credentialId: key.id,
          material: 'static-key',
          recordVersion: 1,
          expiresAtMs: null,
        }),
      },
      {
        family: {
          category: 'llm-provider',
          refusalCodes: [],
          classify: (facts) =>
            facts.credentialType === 'api_key'
              ? { kind: 'mine', member: 'cerebras' }
              : { kind: 'not-mine' },
        },
      },
    )
    const inventory = await custody.discover()
    expect(inventory.credentials).toMatchObject([
      { credentialId: key.id, credentialType: 'api_key', member: 'cerebras' },
    ])
    expect(inventory.refused).toEqual([])
    expect(inventory.notMine).toBe(0)
    const credential = inventory.credentials[0]
    if (!credential) throw new Error('missing API-key credential')
    expect((await custody.authorize(credential)).credentialType).toBe('api_key')
  })

  test('authorizes every dispatch and rereads the consumer token', async () => {
    const f = fixture()
    await f.custody.authorize(identity)
    f.rotate()
    await f.custody.authorize(identity)
    expect(f.gets).toEqual([
      {
        credentialId: identity.credentialId,
        enrollmentToken: '01'.repeat(32),
        minTtlMs: 300_000,
      },
      {
        credentialId: identity.credentialId,
        enrollmentToken: '02'.repeat(32),
        minTtlMs: 300_000,
      },
    ])
  })

  test('does not reuse a successful credential when the next get refuses', async () => {
    let calls = 0
    const { custody } = fixture({
      getScoped: async () => {
        if (++calls > 1) throw new Error('revoked')
        return {
          ...served,
          material: 'test-access',
          recordVersion: 1,
          expiresAtMs: 1_000_000,
        }
      },
    })
    expect((await custody.authorize(identity)).accessToken).toBe('test-access')
    await expect(custody.authorize(identity)).rejects.toThrow()
    expect(calls).toBe(2)
  })

  test.each([
    { credentialId: 'other' },
    { accountId: 'replacement-account' },
    { expiresAtMs: 300_999 },
    { expiresAtMs: null },
    { recordVersion: Number.NaN },
    { recordVersion: -1 },
    { material: '' },
    { material: 'claustrum-tombstone:v1:test' },
    { material: 'secret\r\nheader' },
  ])('refuses invalid or changed serving identity %j', async (patch) => {
    const { custody } = fixture({
      getScoped: async () => ({
        ...served,
        material: 'test-access',
        recordVersion: 1,
        expiresAtMs: 1_000_000,
        ...patch,
      }),
    })
    await expect(custody.authorize(identity)).rejects.toThrow('Claustrum')
  })

  test('serves when the vault asserts no identity, and checks the plugin parse of the token instead', async () => {
    const reply = {
      credentialId: identity.credentialId,
      material: 'token-for-account-1',
      recordVersion: 1,
      expiresAtMs: 1_000_000,
    }
    const silent = fixture({ getScoped: async () => reply })
    expect((await silent.custody.authorize(identity)).accountIdentity).toBe(
      'account-1',
    )
    const parsed = fixture(
      { getScoped: async () => reply },
      { parseIdentity: (token) => token.replace('token-for-', '') },
    )
    expect((await parsed.custody.authorize(identity)).accessToken).toBe(
      'token-for-account-1',
    )
    const mismatch = fixture(
      { getScoped: async () => reply },
      { parseIdentity: () => 'account-2' },
    )
    await expect(mismatch.custody.authorize(identity)).rejects.toThrow(
      'identity changed',
    )
    const unclaimed = fixture(
      { getScoped: async () => reply },
      { parseIdentity: () => 'account-9' },
    )
    expect(
      (
        await unclaimed.custody.authorize({
          credentialId: identity.credentialId,
          credentialType: 'oauth',
        })
      ).accountIdentity,
    ).toBe('account-9')
  })

  test('the receipt keeps what the vault asserted apart from what the roster expected', async () => {
    const reply = {
      material: 'token-for-account-1',
      recordVersion: 1,
      expiresAtMs: 1_000_000,
    }
    const silent = await fixture({
      getScoped: async () => reply,
    }).custody.authorize(identity)
    expect(silent).toMatchObject({
      accountIdentity: 'account-1',
      expectedAccountIdentity: 'account-1',
      accountIdentitySource: 'expected',
    })
    expect(silent.assertedCredentialId).toBeUndefined()
    expect(silent.assertedAccountIdentity).toBeUndefined()
    const parsed = await fixture(
      { getScoped: async () => reply },
      { parseIdentity: (token) => token.replace('token-for-', '') },
    ).custody.authorize(identity)
    expect(parsed.accountIdentitySource).toBe('parsed')
    expect(parsed.assertedAccountIdentity).toBeUndefined()
    const asserted = await fixture().custody.authorize(identity)
    expect(asserted).toMatchObject({
      accountIdentity: 'account-1',
      assertedCredentialId: identity.credentialId,
      assertedAccountIdentity: 'account-1',
      accountIdentitySource: 'asserted',
    })
    const anonymous = await fixture({
      getScoped: async () => reply,
    }).custody.authorize({
      credentialId: identity.credentialId,
      credentialType: 'oauth',
    })
    expect(anonymous.accountIdentity).toBeUndefined()
    expect(anonymous.accountIdentitySource).toBe('none')
  })

  test('requireAssertion refuses a receipt unless the vault asserts the credential id and the expected account identity', async () => {
    const strict = (
      reply: Partial<Awaited<ReturnType<ClaustrumScopedClient['getScoped']>>>,
      parseIdentity?: (token: string) => string | undefined,
    ) =>
      fixture(
        {
          getScoped: async () => ({
            material: 'test-access',
            recordVersion: 1,
            expiresAtMs: 1_000_000,
            ...reply,
          }),
        },
        { requireAssertion: true, ...(parseIdentity && { parseIdentity }) },
      ).custody
    const refusals: Array<
      [
        string,
        ReturnType<typeof strict>,
        typeof identity | Omit<typeof identity, 'accountIdentity'>,
      ]
    > = [
      ['no served credential id', strict({ accountId: 'account-1' }), identity],
      [
        'no served account',
        strict({ credentialId: identity.credentialId }),
        identity,
      ],
      [
        'blank served account',
        strict({ credentialId: identity.credentialId, accountId: ' ' }),
        identity,
      ],
      [
        'parsed identity only',
        strict({ credentialId: identity.credentialId }, () => 'account-1'),
        identity,
      ],
      [
        'unknown expected account',
        strict(served),
        { credentialId: identity.credentialId, credentialType: 'oauth' },
      ],
      [
        'different served account',
        strict({ ...served, accountId: 'account-2' }),
        identity,
      ],
    ]
    for (const [name, custody, requested] of refusals) {
      const outcome = await custody.authorize(requested).then(
        () => `${name}: served`,
        (error: { kind?: string }) => `${name}: ${error.kind}`,
      )
      expect(outcome).toMatch(/: identity-(unasserted|changed)$/)
    }
    const ok = await strict(served).authorize(identity)
    expect(ok).toMatchObject({
      accountIdentity: 'account-1',
      assertedAccountIdentity: 'account-1',
      assertedCredentialId: identity.credentialId,
      accountIdentitySource: 'asserted',
    })
  })

  test('a static API key is served without an expiry and without a TTL demand', async () => {
    const f = fixture(
      {
        getScoped: async (input) => {
          f.gets.push(input)
          return {
            credentialId: 'apikey:test',
            material: 'sk-test-key',
            recordVersion: 2,
            expiresAtMs: null,
          }
        },
      },
      { family: { ...family, apiKeys: true } },
    )
    const attempt = await f.custody.authorize({
      credentialId: 'apikey:test',
      credentialType: 'api_key',
    })
    expect(attempt.accessToken).toBe('sk-test-key')
    expect(attempt.expiresAtMs).toBeNull()
    expect(f.gets).toEqual([
      { credentialId: 'apikey:test', enrollmentToken: '01'.repeat(32) },
    ])
  })

  test('reports only 401 using exact send-time enrollment and served version', async () => {
    const f = fixture()
    const attempt = await f.custody.authorize(identity)
    f.rotate()
    await f.custody.reportFailure(attempt, 403, 'direct')
    await f.custody.reportFailure(attempt, 429, 'direct')
    expect(f.reports).toHaveLength(0)
    await f.custody.reportFailure(attempt, 401, 'relay_status_field')
    expect(f.reports).toEqual([
      {
        credentialId: identity.credentialId,
        enrollmentToken: '01'.repeat(32),
        providerStatus: 401,
        recordVersion: 7,
        reporterSource: 'relay_status_field',
      },
    ])
    expect(JSON.stringify(attempt)).not.toContain('test-access')
    expect(JSON.stringify(attempt)).not.toContain('01'.repeat(32))
  })

  test('logs a delivered 401 report with its served version and no credential material', async () => {
    const f = fixture()
    const attempt = await f.custody.authorize(identity)
    await f.custody.reportFailure(attempt, 401, 'direct')
    const reported = f.logs.records.filter(
      (record) => record.message === 'scoped 401 reported',
    )
    expect(reported).toHaveLength(1)
    expect(reported[0]?.data).toEqual({
      credentialId: identity.credentialId,
      recordVersion: 7,
      reporterSource: 'direct',
    })
    const serialized = JSON.stringify(f.logs.records)
    expect(serialized).not.toContain('test-access')
    expect(serialized).not.toContain('01'.repeat(32))
  })

  test('does not log a 401 report the vault did not accept', async () => {
    const f = fixture({
      reportAuthFailureScoped: async () => {
        throw new Error('vault unavailable')
      },
    })
    const attempt = await f.custody.authorize(identity)
    await f.custody.reportFailure(attempt, 401, 'direct').catch(() => {})
    expect(
      f.logs.records.some((record) => record.message === 'scoped 401 reported'),
    ).toBe(false)
  })

  test('rejects a copied or foreign attempt receipt', async () => {
    const f = fixture()
    const attempt = await f.custody.authorize(identity)
    await expect(
      f.custody.reportFailure({ ...attempt }, 401, 'direct'),
    ).rejects.toThrow()
    await expect(
      fixture().custody.reportFailure(attempt, 401, 'direct'),
    ).rejects.toThrow()
  })

  test('close fences an in-flight credential reply', async () => {
    let resolve!: (
      value: Awaited<ReturnType<ClaustrumScopedClient['getScoped']>>,
    ) => void
    let entered!: () => void
    const started = new Promise<void>((r) => {
      entered = r
    })
    const { custody } = fixture({
      getScoped: () => {
        entered()
        return new Promise((r) => {
          resolve = r
        })
      },
    })
    const pending = custody.authorize(identity)
    await started
    custody.close()
    resolve({
      ...served,
      material: 'test-access',
      recordVersion: 1,
      expiresAtMs: 1_000_000,
    })
    await expect(pending).rejects.toThrow('closed')
  })

  test('aborted dispatch never asks the daemon for credentials', async () => {
    const f = fixture()
    await expect(
      f.custody.authorize(identity, AbortSignal.abort()),
    ).rejects.toThrow()
    expect(f.gets).toHaveLength(0)
  })
})

describe('scoped discovery', () => {
  test('filters by native protocol, not model vendor or credential ID spelling', async () => {
    const { custody } = fixture({
      listScoped: async () => ({
        ...unknownGrants,
        view: 'changed',
        rows: [
          row,
          { ...row, id: 'arbitrary-label', accountId: 'account-2' },
          { ...row, id: 'oauth:test:proxy', refreshAdapter: 'cursor' },
          {
            ...row,
            id: 'apikey:openrouter',
            credentialType: 'api_key',
            refreshAdapter: undefined,
          },
          { ...row, id: 'no-read', operations: ['sign'] },
          { ...row, id: 'other-grant', categories: ['other-native'] },
        ],
      }),
    })
    const inventory = await custody.discover()
    expect(inventory.view).toBe('changed')
    expect(
      inventory.credentials.map((credential) => credential.credentialId),
    ).toEqual([row.id, 'arbitrary-label'])
  })

  test('admits static API keys by type and category only when the family opts in', async () => {
    const rows = [
      row,
      {
        ...row,
        id: 'apikey:test',
        accountId: undefined,
        credentialType: 'api_key',
        refreshAdapter: undefined,
      },
      {
        ...row,
        id: 'apikey:claims-refresh',
        credentialType: 'api_key',
      },
    ]
    const off = fixture({
      listScoped: async () => ({ rows, view: 'v', ...unknownGrants }),
    })
    expect(
      (await off.custody.discover()).credentials.map((c) => c.credentialId),
    ).toEqual([row.id])
    const on = fixture(
      { listScoped: async () => ({ rows, view: 'v', ...unknownGrants }) },
      { family: { ...family, apiKeys: true } },
    )
    expect(
      (await on.custody.discover()).credentials.map((c) => [
        c.credentialId,
        c.credentialType,
      ]),
    ).toEqual([
      [row.id, 'oauth'],
      ['apikey:test', 'api_key'],
    ])
  })

  test('retains non-active inventory rows for reconciliation, not dispatch', async () => {
    const { custody } = fixture({
      listScoped: async () => ({
        ...unknownGrants,
        view: 'changed',
        rows: [{ ...row, state: 'needs_reauth' }],
      }),
    })
    expect((await custody.discover()).credentials[0]?.state).toBe(
      'needs_reauth',
    )
  })

  test('an absent identity is no claim, and a malformed record is skipped instead of refusing the inventory', async () => {
    const f = fixture({
      listScoped: async () => ({
        ...unknownGrants,
        view: 'changed',
        rows: [
          { ...row, accountId: undefined },
          { ...row, id: 'oauth:test:blank', accountId: ' ' },
          { ...row, id: 'oauth:test:dup', accountId: 'account-d' },
          { ...row, id: 'oauth:test:dup', accountId: 'account-e' },
          { ...row, id: 'oauth:test:ok', accountId: 'account-ok' },
        ],
      }),
    })
    const inventory = await f.custody.discover()
    expect(inventory.credentials).toEqual([
      { credentialId: row.id, credentialType: 'oauth', state: 'active' },
      {
        credentialId: 'oauth:test:ok',
        credentialType: 'oauth',
        accountIdentity: 'account-ok',
        state: 'active',
      },
    ])
    expect(inventory.skipped).toEqual([
      { credentialId: 'oauth:test:blank', reason: 'blank account identity' },
      { credentialId: 'oauth:test:dup', reason: 'duplicate credential id' },
      { credentialId: 'oauth:test:dup', reason: 'duplicate credential id' },
    ])
    expect(
      f.logs.records
        .filter((record) => record.level === 'warn')
        .map((record) => record.message),
    ).toEqual([
      'skipped malformed vault record',
      'skipped malformed vault record',
      'skipped malformed vault record',
    ])
  })
})

describe('scoped boundary failures', () => {
  test.each(['host-accessor-missing', 'host-accessor-failed'] as const)(
    'preserves %s when sanitizing unreachable requests and saved outages',
    async (reason) => {
      let now = 1_000
      const { custody, client } = fixture({}, { now: () => now })
      try {
        await custody.authorize(identity)
        client.getScoped = async () => {
          throw new ClaustrumUnreachableError(reason)
        }
        client.listScoped = async () => {
          throw new ClaustrumUnreachableError(reason)
        }
        await expect(custody.discover()).rejects.toMatchObject({ reason })
        expect((await custody.authorize(identity)).fromKeptReceipt).toBe(true)
        now = 1_000_000
        await expect(custody.authorize(identity)).rejects.toMatchObject({
          reason,
        })
        await expect(custody.authorize(identity)).rejects.toMatchObject({
          reason,
        })
      } finally {
        await custody.dispose()
      }
    },
  )

  test('does not coalesce overlapping authorizations', async () => {
    const f = fixture()
    await Promise.all([
      f.custody.authorize(identity),
      f.custody.authorize(identity),
    ])
    expect(f.gets).toHaveLength(2)
  })

  test('redacts unknown transport errors containing bearer params', async () => {
    const { custody } = fixture({
      getScoped: async () => {
        throw new Error(`failed params: ${'01'.repeat(32)}`)
      },
    })
    try {
      await custody.authorize(identity)
      throw new Error('authorization unexpectedly succeeded')
    } catch (error) {
      expect(String(error)).toBe(
        'ClaustrumConsumerError: Claustrum scoped operation unavailable',
      )
      expect(String(error)).not.toContain('01'.repeat(32))
    }
  })

  test('rejects a malformed consumer token before daemon dispatch', async () => {
    let called = false
    const custody = new ClaustrumScopedCustody({
      client: {
        listScoped: async () => {
          called = true
          return { rows: [], view: 'empty', ...unknownGrants }
        },
        getScoped: async () => {
          throw new Error('unexpected')
        },
        reportAuthFailureScoped: async () => {},
        close: () => {},
      },
      family,
      readToken: async () => ({ token: '', token_generation: 1 }),
    })
    await expect(custody.discover()).rejects.toThrow(
      'Invalid Claustrum enrollment token',
    )
    expect(called).toBe(false)
  })

  test('accepts JSON OAuth material without exposing it in the receipt projection', async () => {
    const { custody } = fixture({
      getScoped: async () => ({
        ...served,
        material: JSON.stringify({ access_token: 'test-json-access' }),
        recordVersion: 1,
        expiresAtMs: 1_000_000,
      }),
    })
    const attempt = await custody.authorize(identity)
    expect(attempt.accessToken).toBe('test-json-access')
    expect(JSON.stringify(attempt)).not.toContain('test-json-access')
  })
})

test('cancels an in-flight scoped get without waiting for its reply', async () => {
  let entered!: () => void
  let reply!: (
    value: Awaited<ReturnType<ClaustrumScopedClient['getScoped']>>,
  ) => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const { custody } = fixture({
    getScoped: () => {
      entered()
      return new Promise((resolve) => {
        reply = resolve
      })
    },
  })
  const controller = new AbortController()
  const pending = custody.authorize(identity, controller.signal)
  await started
  controller.abort(new Error('dispatch cancelled'))
  await expect(pending).rejects.toThrow('dispatch cancelled')
  reply({
    ...served,
    material: 'test-access',
    recordVersion: 1,
    expiresAtMs: 1_000_000,
  })
})

test('preserves the producer contract allowing record version zero', async () => {
  const { custody } = fixture({
    getScoped: async () => ({
      ...served,
      material: 'test-access',
      recordVersion: 0,
      expiresAtMs: 1_000_000,
    }),
  })
  expect((await custody.authorize(identity)).recordVersion).toBe(0)
})

const wireRow = {
  id: identity.credentialId,
  account_id: identity.accountIdentity,
  type: 'oauth',
  categories: [family.category],
  serves: ['test-vendor'],
  refresh_adapter: family.refreshAdapter,
  operations: ['read'],
  state: 'active',
  record_version: 1,
}

test.each([
  '',
  [{ ...wireRow, operations: 'read' }],
  [{ ...wireRow, id: 123 }],
  [{ ...wireRow, account_id: 123 }],
])(
  'producer decoder rejects malformed inventory before reconciliation: %j',
  async (credentials) => {
    let calls = 0
    const client = await ClaustrumClient.connect({
      connectionFile: '/unused-test-connection',
      identity: { project_root: '/unused', harness: 'test', session: 'test' },
      logger: () => {},
      connector: async () =>
        ({
          call: async () => {
            calls++
            return { result: { credentials, view: 'view' } }
          },
          close: () => {},
        }) as unknown as Awaited<ReturnType<ClaustrumConnector>>,
    })
    const custody = new ClaustrumScopedCustody({
      client,
      family,
      readToken: async () => ({ token: '01'.repeat(32), token_generation: 1 }),
    })
    try {
      await expect(custody.discover()).rejects.toThrow()
      expect(calls).toBe(1)
    } finally {
      custody.close()
    }
  },
)

test('only a changed record version for the same scoped credential and provider identity permits a 401 replay', () => {
  const attempt = {
    ...identity,
    accountIdentitySource: 'asserted' as const,
    accessToken: 'old',
    recordVersion: 7,
    expiresAtMs: 1_000_000,
  }
  expect(
    isScopedCredentialRotation(attempt, {
      ...attempt,
      accessToken: 'new',
      recordVersion: 8,
    }),
  ).toBe(true)
  for (const candidate of [
    undefined,
    { ...attempt, accessToken: 'new' },
    { ...attempt, credentialId: 'oauth:test:other', recordVersion: 8 },
    { ...attempt, accountIdentity: 'other-account', recordVersion: 8 },
  ]) {
    expect(isScopedCredentialRotation(attempt, candidate)).toBe(false)
  }
})

test('records both arms of a scoped 401 retry decision without credential material', () => {
  const logs = captureLogger()
  const attempt = {
    ...identity,
    accountIdentitySource: 'asserted' as const,
    accessToken: 'served-secret',
    recordVersion: 7,
    expiresAtMs: 1_000_000,
  }
  const rotated = {
    ...attempt,
    accessToken: 'rotated-secret',
    recordVersion: 8,
  }
  const retried = [
    decideScopedRetryAfter401('model', attempt, rotated, logs.logger),
    decideScopedRetryAfter401(
      'cachekeep',
      attempt,
      { ...attempt },
      logs.logger,
    ),
    decideScopedRetryAfter401('prime', attempt, undefined, logs.logger),
    decideScopedRetryAfter401(
      'pi-model',
      attempt,
      { ...rotated, accountIdentity: 'other-account' },
      logs.logger,
    ),
    decideScopedRetryAfter401(
      'pi-model-relay',
      attempt,
      { ...rotated, credentialId: 'oauth:test:other' },
      logs.logger,
    ),
  ]
  expect(retried).toEqual([true, false, false, false, false])
  expect(
    logs.records
      .filter((record) => record.message === 'scoped 401 re-authorized')
      .map((record) => record.data),
  ).toEqual([
    {
      site: 'model',
      credentialId: identity.credentialId,
      servedVersion: 7,
      currentVersion: 8,
      retry: true,
      reason: 'rotated',
    },
    {
      site: 'cachekeep',
      credentialId: identity.credentialId,
      servedVersion: 7,
      currentVersion: 7,
      retry: false,
      reason: 'version-unchanged',
    },
    {
      site: 'prime',
      credentialId: identity.credentialId,
      servedVersion: 7,
      currentVersion: null,
      retry: false,
      reason: 'reauthorize-failed',
    },
    {
      site: 'pi-model',
      credentialId: identity.credentialId,
      servedVersion: 7,
      currentVersion: 8,
      retry: false,
      reason: 'account-changed',
    },
    {
      site: 'pi-model-relay',
      credentialId: identity.credentialId,
      servedVersion: 7,
      currentVersion: 8,
      retry: false,
      reason: 'credential-changed',
    },
  ])
  expect(JSON.stringify(logs.records)).not.toContain('secret')
})
