import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaustrumCredentialError } from '@cortexkit/claustrum-client'
import {
  ClaustrumConsumer,
  ClaustrumDiscoveryHub,
  type ClaustrumScopedClient,
  ClaustrumScopedCustody,
  ClaustrumUnreachableError,
  connectVaultHost,
  enrollmentAuthority,
  vaultAuthority,
} from '../../src/claustrum/index.js'
import { inventoryRow, unknownGrants } from './helpers.js'

const symbol = Symbol.for('cortexkit.vault')
const globals = globalThis as Record<symbol, unknown>
const family = { refreshAdapter: 'openai', category: 'openai-native' }
const identity = {
  credentialId: 'credential-one',
  credentialType: 'oauth' as const,
  accountIdentity: 'account-one',
}
const now = 1_000_000
const logger = { warn: () => {}, debug: () => {} }

function client(): ClaustrumScopedClient {
  return {
    listScoped: mock(async () => ({
      view: 'view-one',
      rows: [
        inventoryRow({
          id: identity.credentialId,
          authMethod: 'chatgpt',
          refreshAdapter: 'openai',
          accountId: identity.accountIdentity,
          categories: ['openai-native'],
        }),
      ],
      ...unknownGrants,
    })),
    getScoped: mock(async () => ({
      credentialId: identity.credentialId,
      accountId: identity.accountIdentity,
      recordVersion: 7,
      expiresAtMs: now + 600_000,
      material: 'host-access',
    })),
    reportAuthFailureScoped: mock(async () => {}),
    close: mock(() => {}),
  }
}

describe('Thalamus host vault', () => {
  let directory: string
  let previousMarker: string | undefined
  let previousAccessor: PropertyDescriptor | undefined
  const custodies: ClaustrumScopedCustody[] = []
  const consumers: ClaustrumConsumer[] = []
  const hubs: ClaustrumDiscoveryHub[] = []

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'common-auth-host-'))
    previousMarker = process.env.CORTEXKIT_VAULT_HOST
    previousAccessor = Object.getOwnPropertyDescriptor(globalThis, symbol)
    process.env.CORTEXKIT_VAULT_HOST = 'thalamus'
    delete globals[symbol]
  })

  afterEach(async () => {
    for (const consumer of consumers.splice(0)) await consumer.dispose()
    for (const hub of hubs.splice(0)) await hub.dispose()
    for (const custody of custodies.splice(0)) await custody.dispose()
    if (previousMarker === undefined) delete process.env.CORTEXKIT_VAULT_HOST
    else process.env.CORTEXKIT_VAULT_HOST = previousMarker
    if (previousAccessor)
      Object.defineProperty(globalThis, symbol, previousAccessor)
    else delete globals[symbol]
    mock.restore()
    await fs.rm(directory, { recursive: true, force: true })
  })

  function custody(
    options: Partial<
      ConstructorParameters<typeof ClaustrumScopedCustody>[0]
    > = {},
  ) {
    const value = new ClaustrumScopedCustody({
      family,
      pluginId: 'openai-auth',
      now: () => now,
      logger,
      ...options,
    })
    custodies.push(value)
    return value
  }

  function consumer(
    options: Partial<
      import('../../src/claustrum/index.js').ClaustrumConsumerOptions
    > = {},
  ) {
    const value = new ClaustrumConsumer({
      family,
      pluginId: 'openai-auth',
      tokenPath: join(directory, 'token.json'),
      rosterPath: join(directory, 'roster.json'),
      now: () => now,
      logger,
      ...options,
    })
    consumers.push(value)
    return value
  }

  test('marker selects host authority and never reads a present enrollment token', async () => {
    const paths = {
      tokenPath: join(directory, 'token.json'),
      statePath: join(directory, 'state.json'),
    }
    await fs.writeFile(
      paths.tokenPath,
      JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
      { mode: 0o600 },
    )
    expect(await enrollmentAuthority(paths, 'openai-auth-test')).toBe('vault')
    const read = spyOn(fs, 'open')
    const host = client()
    const accessor = mock(() => host)
    globals[symbol] = accessor
    expect(await vaultAuthority(paths, 'openai-auth-test')).toBe('host')
    const readToken = mock(async () => {
      throw new Error('token must not be read')
    })
    const direct = custody({ tokenPath: paths.tokenPath, readToken })
    expect((await direct.authorize(identity)).accessToken).toBe('host-access')
    expect((await direct.discover()).credentials).toHaveLength(1)
    await custody({ tokenPath: paths.tokenPath }).authorize(identity)
    expect(readToken).not.toHaveBeenCalled()
    expect(
      read.mock.calls.filter(([path]) => path === paths.tokenPath),
    ).toHaveLength(0)
    expect(accessor).toHaveBeenCalledWith('openai-auth')
    expect(host.getScoped).toHaveBeenCalledWith({
      credentialId: identity.credentialId,
      enrollmentToken: '',
      minTtlMs: 300_000,
    })
  })

  test('without marker an accessor is never touched and authority is unchanged', async () => {
    delete process.env.CORTEXKIT_VAULT_HOST
    const touched = mock(() => {
      throw new Error('unexpected accessor read')
    })
    Object.defineProperty(globalThis, symbol, {
      configurable: true,
      get: touched,
    })
    const paths = {
      tokenPath: join(directory, 'token.json'),
      statePath: join(directory, 'state.json'),
    }
    expect(await vaultAuthority(paths, 'openai-auth-test')).toBe(
      await enrollmentAuthority(paths, 'openai-auth-test'),
    )
    expect(() => connectVaultHost('openai-auth')).toThrow(
      ClaustrumUnreachableError,
    )
    const native = client()
    const direct = custody({
      client: native,
      readToken: async () => ({ token: '01'.repeat(32), token_generation: 1 }),
    })
    await direct.authorize(identity)
    expect(native.getScoped).toHaveBeenCalledWith({
      credentialId: identity.credentialId,
      enrollmentToken: '01'.repeat(32),
      minTtlMs: 300_000,
    })
    expect(touched).not.toHaveBeenCalled()
    process.env.CORTEXKIT_VAULT_HOST = 'Thalamus'
    expect(await vaultAuthority(paths, 'openai-auth-test')).toBe('local')
    expect(touched).not.toHaveBeenCalled()
  })

  test.each(['missing', 'throwing', 'missing-plugin-id'] as const)(
    '%s accessor fails closed without consulting local authority',
    async (mode) => {
      if (mode === 'throwing')
        globals[symbol] = () => {
          throw new Error('host secret')
        }
      if (mode === 'missing-plugin-id') globals[symbol] = () => client()
      const local = mock(() => false)
      const hosted = consumer({
        isCustodyActive: local,
        ...(mode === 'missing-plugin-id' && { pluginId: undefined }),
      })
      await expect(hosted.refresh()).rejects.toBeInstanceOf(
        ClaustrumUnreachableError,
      )
      expect(hosted.routingRows()).toEqual([])
      expect(local).not.toHaveBeenCalled()
    },
  )

  test('accessor installed after a failed connection is looked up on the next connect', async () => {
    const hosted = consumer()
    await expect(hosted.refresh()).rejects.toBeInstanceOf(
      ClaustrumUnreachableError,
    )
    globals[symbol] = () => client()
    expect((await hosted.refresh())?.rows).toHaveLength(1)
  })

  test.each([
    { code: 'connection_closed' },
    { name: 'ClaustrumUnreachableError' },
  ])('lost relay %j serves a kept receipt', async (failure) => {
    const host = client()
    globals[symbol] = () => host
    const direct = custody()
    await direct.authorize(identity)
    host.getScoped = mock(async () => {
      throw failure
    })
    const kept = await direct.authorize(identity)
    expect(kept.fromKeptReceipt).toBe(true)
    expect(kept.accessToken).toBe('host-access')
  })

  test('plain out-of-share refusal becomes ClaustrumCredentialError and drops the kept receipt', async () => {
    const host = client()
    globals[symbol] = () => host
    const direct = custody()
    await direct.authorize(identity)
    host.getScoped = mock(async () => {
      throw {
        code: 'not_found',
        class: 'permanent',
        action: 'gone',
        message: 'host secret',
      }
    })
    let refusal: unknown
    try {
      await direct.authorize(identity)
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(ClaustrumCredentialError)
    expect(refusal).toMatchObject({
      code: 'not_found',
      class: 'permanent',
      action: 'gone',
    })
    expect((refusal as Error).message).not.toContain('host secret')
    host.getScoped = mock(async () => {
      throw { code: 'connection_closed' }
    })
    await expect(direct.authorize(identity)).rejects.toBeInstanceOf(
      ClaustrumUnreachableError,
    )
  })

  test('401 reports use the client that served the receipt', async () => {
    const first = client()
    globals[symbol] = () => first
    const direct = custody()
    const receipt = await direct.authorize(identity)
    const second = client()
    globals[symbol] = () => second
    await direct.reportFailure(receipt, 401, 'direct')
    expect(first.reportAuthFailureScoped).toHaveBeenCalledWith({
      credentialId: identity.credentialId,
      enrollmentToken: '',
      providerStatus: 401,
      recordVersion: 7,
      reporterSource: 'direct',
    })
    expect(second.reportAuthFailureScoped).not.toHaveBeenCalled()
  })

  test('explicit adapters still win and are not structurally normalized', async () => {
    const accessor = mock(() => client())
    globals[symbol] = accessor
    const native = client()
    const failure = { code: 'not_found', class: 'permanent', action: 'gone' }
    native.getScoped = mock(async () => {
      throw failure
    })
    await expect(
      custody({ client: native }).authorize(identity),
    ).rejects.toMatchObject({ kind: 'unavailable' })
    await consumer({ connect: async () => native }).refresh()
    expect(accessor).not.toHaveBeenCalled()
  })

  test('watch, usage reports and insula go through the host client', async () => {
    const host = client()
    const stop = mock(() => {})
    host.watchScoped = mock(() => ({
      stop,
      closed: Promise.resolve({ kind: 'stopped' as const }),
    }))
    host.reportUsageScoped = mock(async () => {})
    host.insula = {
      connectionFile: 'host-relay',
      getUsage: mock(async () => ({ entries: [] })),
      watchUsage: mock(() => ({ stop, closed: Promise.resolve() })),
    }
    globals[symbol] = () => host
    const wrapped = connectVaultHost('openai-auth')
    const watch = wrapped.watchScoped?.(() => {}, { enrollmentToken: '' })
    await watch?.closed
    watch?.stop()
    await wrapped.reportUsageScoped?.({
      credentialId: identity.credentialId,
      enrollmentToken: '',
      reading: {
        provider: 'codex',
        account: identity.accountIdentity,
        observedAt: now,
        windows: [],
      },
    })
    await wrapped.insula?.getUsage()
    const usageWatch = wrapped.insula?.watchUsage?.(() => {})
    await usageWatch?.closed
    usageWatch?.stop()
    expect(host.watchScoped).toHaveBeenCalledTimes(1)
    expect(host.reportUsageScoped).toHaveBeenCalledTimes(1)
    expect(host.insula.getUsage).toHaveBeenCalledTimes(1)
    expect(host.insula.watchUsage).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(2)
    const minimal = client()
    globals[symbol] = () => minimal
    const withoutOptions = connectVaultHost('openai-auth')
    expect(withoutOptions.watchScoped).toBeUndefined()
    expect(withoutOptions.reportUsageScoped).toBeUndefined()
    expect(withoutOptions.insula).toBeUndefined()
  })

  test('consumer uses host insula and custody flushes usage without reading a token', async () => {
    const host = client()
    host.reportUsageScoped = mock(async () => {})
    host.insula = {
      connectionFile: 'host-relay',
      getUsage: mock(async () => ({ entries: [] })),
    }
    globals[symbol] = () => host
    const hosted = consumer({
      insula: { provider: 'codex', normalize: () => undefined },
    })
    await hosted.refreshInsulaQuota()
    expect(host.insula.getUsage).toHaveBeenCalledTimes(1)
    const readToken = mock(async () => {
      throw new Error('token must not be read')
    })
    const direct = custody({ readToken })
    await direct.authorize(identity)
    const reading = {
      provider: 'codex',
      observedAtMs: now,
      account: identity.accountIdentity,
    }
    direct.reportUsage({ credentialId: identity.credentialId, reading })
    await direct.dispose()
    expect(host.reportUsageScoped).toHaveBeenCalledWith({
      credentialId: identity.credentialId,
      enrollmentToken: '',
      reading,
    })
    expect(readToken).not.toHaveBeenCalled()
  })

  test('custody opens the host roster watch without reading a token', async () => {
    const host = client()
    const opened = Promise.withResolvers<unknown>()
    const ended = Promise.withResolvers<{ kind: 'stopped' }>()
    host.watchScoped = mock((_onNotice, options) => {
      opened.resolve(options)
      return {
        stop: () => ended.resolve({ kind: 'stopped' }),
        closed: ended.promise,
      }
    })
    globals[symbol] = () => host
    const readToken = mock(async () => {
      throw new Error('token must not be read')
    })
    const direct = custody({ readToken })
    const watch = direct.watchRoster({
      onView: () => {},
      view: () => 'view-one',
    })
    expect(await opened.promise).toEqual({ enrollmentToken: '' })
    watch.close()
    expect(readToken).not.toHaveBeenCalled()
  })

  test('discovery hub serves a hosted member without an enrollment token', async () => {
    const host = client()
    const accessor = mock(() => host)
    globals[symbol] = accessor
    const local = mock(() => false)
    const hub = new ClaustrumDiscoveryHub({
      stateDir: directory,
      hostGeneration: 'opencode2',
      classifierInput: {},
      members: ['openai'],
      tokenPath: join(directory, 'absent-token.json'),
      pluginId: 'claustrum-auth',
      family: {
        category: 'openai-native',
        refusalCodes: [],
        classify: () => ({ kind: 'mine', member: 'openai' }),
      },
      isCustodyActive: local,
      now: () => now,
      logger,
    })
    hubs.push(hub)
    const member = hub.member('openai', {})
    consumers.push(member)
    const roster = await member.refresh()
    expect(roster?.rows).toHaveLength(1)
    const row = roster?.rows[0]
    if (!row) throw new Error('host row missing')
    const receipt = await member.authorize(row.routeId)
    expect(receipt.accessToken).toBe('host-access')
    expect(accessor).toHaveBeenCalledWith('claustrum-auth')
    expect(local).not.toHaveBeenCalled()
  })
})
