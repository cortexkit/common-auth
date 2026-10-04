import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { acquireRefreshFileLock } from '../../src/fs/refresh-file-lock.js'
import {
  countUnknownIdentityRows,
  type LockEvent,
  type PoolOperationError,
  type ProviderRefreshResult,
} from '../../src/store/index.js'
import { saveAccountState } from '../fixtures/legacy-openai-auth/accounts.js'
import {
  apiKey,
  deferred,
  oauth,
  rejectionOf,
  runChild,
  type Scenario,
  scenario,
  settlesWithin,
} from './helpers.js'

let s: Scenario
beforeEach(async () => {
  s = await scenario()
})
afterEach(() => s.cleanup())

function result(refresh: string, extra: Partial<ProviderRefreshResult> = {}) {
  return {
    access: `access-${refresh}`,
    refresh,
    expires: 4_000_000_000_000,
    ...extra,
  }
}

function pausedProvider(value: ProviderRefreshResult) {
  const entered = deferred()
  const release = deferred()
  const seen: string[] = []
  return {
    entered,
    release,
    seen,
    fn: async (credential: { refresh: string }) => {
      seen.push(credential.refresh)
      entered.resolve()
      await release.promise
      return value
    },
  }
}

async function rowsOf() {
  const load = await s.open().read()
  if (load.status !== 'ready') throw new Error(`pool is ${load.status}`)
  return load.rows
}

describe('lock order, ownership, hooks and refusal', () => {
  it('a refresh takes row, provider-wide and extra locks in order, never holds the store locks across the provider call, and releases in reverse after the hook', async () => {
    await s
      .open()
      .add({ id: 'a', credential: oauth('r-a'), identity: 'acct-1' })
    const log: string[] = []
    const held = new Set<string>()
    const store = s.open({
      onLockEvent: (event: LockEvent) => {
        const name = `${event.name}@${event.path === s.configPath ? 'config' : 'state'}`
        log.push(`${event.type} ${name}`)
        if (event.type === 'acquired') held.add(name)
        else held.delete(name)
      },
    })
    let heldDuringProvider: string[] = []
    const outcome = await store.refresh(
      'a',
      async () => {
        heldDuringProvider = [...held]
        log.push('provider')
        return result('r-a2')
      },
      {
        extraLocks: [
          { name: 'extra-1', path: s.statePath },
          { name: 'extra-2', path: s.statePath },
        ],
        onPersisted: async (_id, credential) => {
          log.push(
            `persisted ${credential.type === 'oauth' ? credential.refresh : ''}`,
          )
          const state = await s.state()
          expect(state.accounts.a.refresh).toBe('r-a2')
        },
      },
    )
    expect(outcome).toMatchObject({ status: 'rotated', rowId: 'a' })
    expect(heldDuringProvider).toEqual([
      'row-acct-1@state',
      'provider-openai@state',
      'extra-1@state',
      'extra-2@state',
    ])
    expect(log).toEqual([
      'acquired row-acct-1@state',
      'acquired provider-openai@state',
      'acquired extra-1@state',
      'acquired extra-2@state',
      'acquired save@config',
      'acquired save@state',
      'released save@state',
      'released save@config',
      'provider',
      'acquired save@config',
      'acquired save@state',
      'released save@state',
      'released save@config',
      'persisted r-a2',
      'released extra-2@state',
      'released extra-1@state',
      'released provider-openai@state',
      'released row-acct-1@state',
    ])
  })

  it('a row with no recorded identity takes its row lock under its local id', async () => {
    await s.open().add({ id: 'a', credential: oauth('r-a') })
    const names: string[] = []
    await s
      .open({
        onLockEvent: (event) => {
          if (event.type === 'acquired') names.push(event.name)
        },
      })
      .refresh('a', async () => result('r-a2'))
    expect(names[0]).toBe('row-a')
  })

  it('a provider failure reaches the failure hook before the outer locks release and fires no after-persist hook', async () => {
    await s.open().add({ id: 'a', credential: oauth('r-a') })
    const before = await s.bytes()
    const log: string[] = []
    const store = s.open({
      onLockEvent: (event) => {
        if (event.name !== 'save') log.push(`${event.type} ${event.name}`)
      },
    })
    const error = await rejectionOf(
      store.refresh(
        'a',
        async () => {
          throw new Error('provider down')
        },
        {
          onPersisted: () => void log.push('persisted'),
          onFailure: (_id, failure) => void log.push(`failure ${failure.kind}`),
        },
      ),
    )
    expect(error).toMatchObject({
      operation: 'refresh',
      kind: 'provider',
      phase: 'before-first-write',
      retryable: true,
    })
    expect(log).toEqual([
      'acquired row-a',
      'acquired provider-openai',
      'failure provider',
      'released provider-openai',
      'released row-a',
    ])
    expect(await s.bytes()).toEqual(before)
  })

  it('an extra lock held by a legacy holder makes the refresh wait and a rotation by that holder is the credential refreshed', async () => {
    await s.open().add({ id: 'a', credential: oauth('r-a') })
    const holder = await acquireRefreshFileLock({
      name: 'legacy-refresh',
      path: s.statePath,
      ttlMs: 10_000,
    })
    const seen: string[] = []
    const refresh = s.open().refresh(
      'a',
      async (credential) => {
        seen.push(credential.refresh)
        return result('r-after')
      },
      { extraLocks: [{ name: 'legacy-refresh', path: s.statePath }] },
    )
    expect(await settlesWithin(refresh, 300)).toBe(false)
    expect(seen).toEqual([])
    await saveAccountState(
      {
        version: 1,
        accounts: [
          {
            id: 'a',
            type: 'oauth',
            access: 'legacy-access',
            refresh: 'r-legacy',
            expires: 4_000_000_000_001,
            lastRefreshedAt: Date.now(),
          },
        ],
      },
      s.paths,
      { accounts: ['a'] },
    )
    await holder?.release()
    await refresh
    expect(seen).toEqual(['r-legacy'])
    expect((await s.state()).accounts.a.refresh).toBe('r-after')
  })

  it('an outer lease lost during a paused provider call fails the refresh without overwriting a successor rotation', async () => {
    await s.open().add({ id: 'a', credential: oauth('r-a') })
    let clock = Date.now()
    const provider = pausedProvider(result('r-stale'))
    const first = s.open({ now: () => clock })
    const refresh = first.refresh('a', provider.fn)
    await provider.entered.promise
    // The paused holder's leases expire; renewal cannot extend an expired one.
    clock += 60_000
    const successor = s.open({ now: () => clock })
    await successor.rotate('a', oauth('r-successor'))
    provider.release.resolve()
    const error = await rejectionOf(refresh)
    expect(error).toMatchObject({
      kind: 'lock-ownership',
      phase: 'before-first-write',
      retryable: true,
      committed: undefined,
    })
    const row = (await rowsOf())[0]
    expect(row?.credential).toMatchObject({ refresh: 'r-successor' })
    expect(row?.credentialEpoch).toBe(1)
  })

  it('an awaited refuse predicate refuses at each of its three sites and leaves the stored credential untouched', async () => {
    for (const site of [1, 2, 3]) {
      s.cleanup()
      s = await scenario()
      await s.open().add({ id: 'a', credential: oauth('r-a') })
      const before = await s.bytes()
      let calls = 0
      let providerCalls = 0
      const outcome = await s.open().refresh(
        'a',
        async () => {
          providerCalls++
          return result('r-new')
        },
        {
          refuse: async () => {
            calls++
            await new Promise((resolve) => setTimeout(resolve, 5))
            return calls === site ? `refused at ${site}` : undefined
          },
        },
      )
      expect(outcome).toEqual({
        status: 'refused',
        rowId: 'a',
        reason: `refused at ${site}`,
      })
      expect(providerCalls).toBe(site === 3 ? 1 : 0)
      const after = await s.bytes()
      expect(after.state).toBe(before.state)
    }
  })

  it('the refuse predicate sees the stored refresh token', async () => {
    await s.open().add({ id: 'a', credential: oauth('inert:marker') })
    let providerCalls = 0
    const outcome = await s.open().refresh(
      'a',
      async () => {
        providerCalls++
        return result('r-new')
      },
      {
        refuse: async (row) =>
          row.credential?.type === 'oauth' &&
          row.credential.refresh.startsWith('inert:')
            ? 'inert credential'
            : undefined,
      },
    )
    expect(outcome).toMatchObject({
      status: 'refused',
      reason: 'inert credential',
    })
    expect(providerCalls).toBe(0)
  })

  it('a throwing after-persist hook returns the post-commit hook error with the committed credential and no failure hook', async () => {
    await s.open().add({ id: 'a', credential: oauth('r-a') })
    let providerCalls = 0
    const failures: PoolOperationError[] = []
    const error = await rejectionOf(
      s.open().refresh(
        'a',
        async () => {
          providerCalls++
          return result('r-a2')
        },
        {
          onPersisted: () => {
            throw new Error('host slot write failed')
          },
          onFailure: (_id, failure) => void failures.push(failure),
        },
      ),
    )
    expect(error).toMatchObject({
      kind: 'after-persist-hook',
      phase: 'after-first-write',
      retryable: false,
    })
    expect(error.committed).toMatchObject({ refresh: 'r-a2' })
    expect((await s.state()).accounts.a.refresh).toBe('r-a2')
    expect(providerCalls).toBe(1)
    expect(failures).toEqual([])
  })
})

describe('row lock and provider-wide lock schedules', () => {
  it('two rows with different known identities never overlap their provider calls', async () => {
    await s
      .open()
      .add({ id: 'a', credential: oauth('r-a'), identity: 'acct-1' })
    await s
      .open()
      .add({ id: 'b', credential: oauth('r-b'), identity: 'acct-2' })
    const names: Record<string, string[]> = { a: [], b: [] }
    const a = pausedProvider(result('r-a2'))
    const refreshA = s
      .open({
        onLockEvent: (event) => {
          if (event.type === 'acquired' && event.name !== 'save')
            names.a?.push(event.name)
        },
      })
      .refresh('a', a.fn)
    await a.entered.promise
    let bCalled = false
    const refreshB = s
      .open({
        onLockEvent: (event) => {
          if (event.type === 'acquired' && event.name !== 'save')
            names.b?.push(event.name)
        },
      })
      .refresh('b', async () => {
        bCalled = true
        return result('r-b2')
      })
    expect(await settlesWithin(refreshB, 300)).toBe(false)
    expect(bCalled).toBe(false)
    a.release.resolve()
    await Promise.all([refreshA, refreshB])
    expect(bCalled).toBe(true)
    expect(names).toEqual({
      a: ['row-acct-1', 'provider-openai'],
      b: ['row-acct-2', 'provider-openai'],
    })
  })

  it('a row whose identity is recorded while it waits retries once under the identity key', async () => {
    await s
      .open()
      .add({ id: 'a', credential: oauth('r-a'), identity: 'acct-1' })
    await s.open().add({ id: 'b', credential: oauth('r-b') })
    const a = pausedProvider(result('r-a2'))
    const refreshA = s.open().refresh('a', a.fn)
    await a.entered.promise
    const events: string[] = []
    const refreshB = s
      .open({
        onLockEvent: (event) => {
          if (event.name === 'save') return
          events.push(`${event.type} ${event.name}`)
          if (event.type === 'acquired' && event.name === 'row-b') {
            // An uncontrolled writer records b's identity while b waits.
            const config = JSON.parse(readFileSync(s.configPath, 'utf8'))
            config.accounts[1].accountId = 'acct-b'
            writeFileSync(s.configPath, JSON.stringify(config))
          }
        },
      })
      .refresh('b', async () => result('r-b2'))
    a.release.resolve()
    await refreshA
    expect(await refreshB).toMatchObject({
      status: 'rotated',
      identity: 'acct-b',
    })
    expect(events).toEqual([
      'acquired row-b',
      'acquired provider-openai',
      'released provider-openai',
      'released row-b',
      'acquired row-acct-b',
      'acquired provider-openai',
      'released provider-openai',
      'released row-acct-b',
    ])
  })

  it('a row whose identity changes twice while its lock is taken aborts retryably', async () => {
    await s.open().add({ id: 'b', credential: oauth('r-b') })
    const before = (await s.state()).accounts.b
    const setIdentity = (identity: string) => {
      const config = JSON.parse(readFileSync(s.configPath, 'utf8'))
      config.accounts[0].accountId = identity
      writeFileSync(s.configPath, JSON.stringify(config))
    }
    let providerCalls = 0
    const error = await rejectionOf(
      s
        .open({
          onLockEvent: (event) => {
            if (event.type !== 'acquired') return
            if (event.name === 'row-b') setIdentity('acct-1')
            if (event.name === 'row-acct-1') setIdentity('acct-2')
          },
        })
        .refresh('b', async () => {
          providerCalls++
          return result('r-b2')
        }),
    )
    expect(error).toMatchObject({ kind: 'row-key-changed', retryable: true })
    expect(providerCalls).toBe(0)
    expect((await s.state()).accounts.b).toEqual(before)
  })

  it('adding an unknown-identity row waits for a running refresh while an api-key add does not', async () => {
    await s
      .open()
      .add({ id: 'a', credential: oauth('r-a'), identity: 'acct-1' })
    const a = pausedProvider(result('r-a2'))
    const refreshA = s.open().refresh('a', a.fn)
    await a.entered.promise
    const addB = s.open().add({ id: 'b', credential: oauth('r-b') })
    expect(await settlesWithin(addB, 300)).toBe(false)
    await s.open().add({ id: 'k', credential: apiKey('key-k') })
    a.release.resolve()
    await Promise.all([refreshA, addB])
    await s.open().add({ id: 'c', credential: oauth('r-c') })
    await s.open().disable('c', 'manual')
    expect(countUnknownIdentityRows(await rowsOf())).toBe(1)
  })
})

describe('identity', () => {
  it('a refresh records the identity it returns, the next refresh keys by it, and the quota recorded under the local id stays attached', async () => {
    const store = s.open()
    await store.add({ id: 'a', credential: oauth('r-a') })
    await store.recordQuota('a', { credentialEpoch: 1 }, 'reading-1')
    await store.refresh('a', async () => result('r-a2', { identity: 'acct-1' }))
    let row = (await rowsOf())[0]
    expect(row).toMatchObject({
      identity: 'acct-1',
      quota: { readings: ['reading-1'] },
    })
    const names: string[] = []
    await s
      .open({
        onLockEvent: (event) => {
          if (event.type === 'acquired') names.push(event.name)
        },
      })
      .refresh('a', async () => result('r-a3'))
    expect(names[0]).toBe('row-acct-1')
    row = (await rowsOf())[0]
    expect(row?.credential).toMatchObject({ refresh: 'r-a3' })
  })

  it('two unknown-identity rows with different fingerprints never merge or share a reading', async () => {
    const store = s.open()
    await store.add({ id: 'a', credential: oauth('r-a') })
    await store.add({ id: 'b', credential: oauth('r-b') })
    await store.recordQuota('a', { credentialEpoch: 1 }, 'only-a')
    const rows = await rowsOf()
    expect(rows.map((row) => [row.id, row.enabled, row.quota])).toEqual([
      ['a', true, { readings: ['only-a'] }],
      ['b', true, undefined],
    ])
  })

  it('a refresh write-back revealing a duplicate disables the later row without deleting it', async () => {
    const store = s.open()
    await store.add({ id: 'a', credential: oauth('r-a'), identity: 'acct-1' })
    await store.add({ id: 'b', credential: oauth('r-b') })
    await store.refresh('b', async () => result('r-b2', { identity: 'acct-1' }))
    const rows = await rowsOf()
    expect(
      rows.map((row) => [row.id, row.enabled, row.disabledReason]),
    ).toEqual([
      ['a', true, undefined],
      ['b', false, 'duplicate-identity'],
    ])
    expect((await s.state()).accounts.b.refresh).toBe('r-b2')
  })
})

describe('replace and a live refresh', () => {
  it('a replace started in another process waits for a paused refresh, which persists first', async () => {
    await s.open().add({ id: 'r', credential: oauth('r-old') })
    const provider = pausedProvider(result('r-rotated'))
    const refresh = s.open().refresh('r', provider.fn)
    await provider.entered.promise
    const child = runChild({
      configPath: s.configPath,
      statePath: s.statePath,
      op: 'replace',
      id: 'r',
      credential: oauth('r-replacement'),
    })
    await child.printed('started')
    await new Promise((resolve) => setTimeout(resolve, 400))
    let row = (await rowsOf())[0]
    expect(row).toMatchObject({ credentialEpoch: 1 })
    expect(row?.credential).toMatchObject({ refresh: 'r-old' })
    provider.release.resolve()
    expect(await refresh).toMatchObject({ status: 'rotated' })
    expect(await child.exited).toBe(0)
    row = (await rowsOf())[0]
    expect(row).toMatchObject({ credentialEpoch: 2 })
    expect(row?.credential).toMatchObject({ refresh: 'r-replacement' })
  })
})

describe('refresh identity continuity', () => {
  it('a contradicted known identity persists the successor bound but disabled without propagating it', async () => {
    const store = s.open({ requireCredentialStamps: true })
    await store.add({ id: 'a', credential: oauth('r-old'), identity: 'acct-A' })
    await store.add({ id: 'b', credential: oauth('r-b'), identity: 'acct-B' })
    const hooks: string[] = []
    const outcome = await store.refresh(
      'a',
      async () => result('r-new', { identity: 'acct-B' }),
      {
        onPersisted: () => {
          hooks.push('persisted')
        },
      },
    )
    expect(outcome).toMatchObject({
      status: 'identity-contradicted',
      rowId: 'a',
      expectedIdentity: 'acct-A',
      returnedIdentity: 'acct-B',
      credential: { refresh: 'r-new' },
    })
    expect(hooks).toEqual([])
    const load = await s.open({ requireCredentialStamps: true }).read()
    if (load.status !== 'ready') throw new Error('expected ready')
    const row = load.rows.find((row) => row.id === 'a')
    expect(row).toMatchObject({
      identity: 'acct-A',
      enabled: false,
      candidate: false,
      stamp: 'bound',
      credential: { refresh: 'r-new' },
      disabledReason:
        'identity-contradicted: {"expectedIdentity":"acct-A","returnedIdentity":"acct-B"}',
    })
    expect(row?.torn).toBeUndefined()
    expect(row?.unbound).toBeUndefined()
    expect((await s.config()).accounts[0].accountId).toBe('acct-A')
    expect(load.rows.find((row) => row.id === 'b')?.credential).toMatchObject({
      refresh: 'r-b',
    })
    expect(
      (await rejectionOf(store.refresh('a', async () => result('unused'))))
        .kind,
    ).toBe('row-disabled')
    await store.enable('a')
    expect((await rowsOf()).find((row) => row.id === 'a')?.candidate).toBe(true)
  })

  it('matching, learnt and absent refresh identities retain ordinary rotation and propagation', async () => {
    for (const [id, known, returned, expected] of [
      ['same', 'acct-A', 'acct-A', 'acct-A'],
      ['learn', undefined, 'acct-B', 'acct-B'],
      ['absent', 'acct-C', undefined, 'acct-C'],
    ] as const) {
      const store = s.open({ requireCredentialStamps: true })
      await store.add({
        id,
        credential: oauth(`old-${id}`),
        ...(known !== undefined ? { identity: known } : {}),
      })
      const hooks: string[] = []
      expect(
        await store.refresh(
          id,
          async () => result(`new-${id}`, { identity: returned }),
          {
            onPersisted: () => {
              hooks.push(id)
            },
          },
        ),
      ).toMatchObject({ status: 'rotated', identity: expected })
      expect(hooks).toEqual([id])
      expect((await rowsOf()).find((row) => row.id === id)).toMatchObject({
        identity: expected,
        enabled: true,
        candidate: true,
        stamp: 'bound',
        credential: { refresh: `new-${id}` },
      })
    }
  })
})
