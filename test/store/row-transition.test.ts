import { beforeEach, expect } from 'bun:test'
import {
  DECLINE_TRANSITION,
  type PoolLoad,
  type PoolRow,
  type PoolStore,
  type ProviderStateCodec,
  type WriteStep,
} from '../../src/store/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import {
  blocked,
  deferred,
  oauth,
  type ParsedJson,
  rejectionOf,
  type Scenario,
  scenario,
} from './helpers.js'

const hooks = lifetimeHooks()
const { afterEach, test } = hooks

let s: Scenario
beforeEach(async () => {
  s = hooks.lifetime.manage(await scenario())
})
afterEach(() => s.cleanup())

/**
 * The provider state these tests keep: a project, which belongs to the
 * credential, and the times the account was last found ineligible and
 * eligible, which only record what requests saw.
 */
type Elig = {
  project?: string
  ineligibleAt?: number
  eligibleAt?: number
}

function isElig(value: unknown): value is Elig {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false
  const v = value as Record<string, unknown>
  return (
    (v.project === undefined || typeof v.project === 'string') &&
    (v.ineligibleAt === undefined || typeof v.ineligibleAt === 'number') &&
    (v.eligibleAt === undefined || typeof v.eligibleAt === 'number')
  )
}

/** Latest wins for each time; the incoming project wins when it names one. */
function mergeElig(onDisk: unknown, incoming: unknown): Elig {
  const a = onDisk as Elig
  const b = incoming as Elig
  const latest = (x?: number, y?: number) =>
    x === undefined ? y : y === undefined ? x : Math.max(x, y)
  const ineligibleAt = latest(a.ineligibleAt, b.ineligibleAt)
  const eligibleAt = latest(a.eligibleAt, b.eligibleAt)
  const project = b.project ?? a.project
  return {
    ...(project !== undefined ? { project } : {}),
    ...(ineligibleAt !== undefined ? { ineligibleAt } : {}),
    ...(eligibleAt !== undefined ? { eligibleAt } : {}),
  }
}

const eligCodec: ProviderStateCodec = {
  validate: isElig,
  credentialBound: (value) => ({ project: (value as Elig).project ?? null }),
  merge: mergeElig,
}

function open(overrides: Parameters<Scenario['open']>[0] = {}): PoolStore {
  return s.open({ providerState: eligCodec, ...overrides })
}

function rowsOf(load: PoolLoad): PoolRow[] {
  if (load.status !== 'ready') throw new Error(`expected ready: ${load.status}`)
  return load.rows
}

async function rowOf(store: PoolStore, id: string): Promise<PoolRow> {
  const row = rowsOf(await store.read()).find(
    (candidate) => candidate.id === id,
  )
  if (!row) throw new Error(`no row ${id}`)
  return row
}

function refreshOf(row: PoolRow): string {
  return row.credential?.type === 'oauth' ? row.credential.refresh : 'none'
}

/** Row a at credential A (epoch 1, account acct-a) with project P1. */
async function addA(store: PoolStore): Promise<void> {
  await store.add({
    id: 'a',
    credential: oauth('r-a1'),
    identity: 'acct-a',
    providerState: { project: 'P1' },
  })
}

const A1 = { credentialEpoch: 1, identity: 'acct-a' }

test('an attributed disable for a credential the row no longer holds is refused and writes nothing', async () => {
  const store = open()
  await addA(store)
  // A request went out on credential A at epoch 1; the row is then replaced
  // with credential B (epoch 2) before A's refusal arrives.
  await store.replace('a', oauth('r-b'), {
    identity: 'acct-a',
    providerState: { project: 'P1' },
  })
  const before = await s.bytes()

  const withState = await rejectionOf(
    store.disable('a', 'ineligible', {
      attribution: A1,
      providerState: (current) => mergeElig(current, { ineligibleAt: 100 }),
    }),
  )
  const plain = await rejectionOf(
    store.disable('a', 'ineligible', { attribution: A1 }),
  )

  for (const error of [withState, plain]) {
    expect(error.kind).toBe('attribution')
    expect(error.retryable).toBe(true)
    expect(error.phase).toBe('before-first-write')
  }
  expect(await s.bytes()).toEqual(before)
  const a = await rowOf(store, 'a')
  expect(a.enabled).toBe(true)
  expect(refreshOf(a)).toBe('r-b')
  expect(a.credentialEpoch).toBe(2)
})

test('a late attributed enable for a replaced credential does not switch the new credential back on', async () => {
  const store = open()
  await addA(store)
  // A verification of credential A at epoch 1 finds the account eligible
  // and records it.
  await store.updateProviderState('a', A1, (current) =>
    mergeElig(current, { eligibleAt: 100 }),
  )
  // The row is replaced with credential B, and B is refused and disabled.
  await store.replace('a', oauth('r-b'), {
    identity: 'acct-a',
    providerState: { project: 'P1' },
  })
  const B2 = { credentialEpoch: 2, identity: 'acct-a' }
  await store.disable('a', 'ineligible', {
    attribution: B2,
    providerState: (current) => mergeElig(current, { ineligibleAt: 200 }),
  })
  const before = await s.bytes()

  // The enable that A's verification asked for arrives late.
  const withState = await rejectionOf(
    store.enable('a', {
      attribution: A1,
      providerState: (current) => mergeElig(current, { eligibleAt: 150 }),
    }),
  )
  const plain = await rejectionOf(store.enable('a', { attribution: A1 }))

  for (const error of [withState, plain]) {
    expect(error.kind).toBe('attribution')
    expect(error.retryable).toBe(true)
  }
  expect(await s.bytes()).toEqual(before)
  const a = await rowOf(store, 'a')
  expect(a.enabled).toBe(false)
  expect(a.disabledReason).toBe('ineligible')
  expect(refreshOf(a)).toBe('r-b')
})

/** What a reader sees of row a: its enabled flag, reason and provider state. */
async function viewOf(store: PoolStore): Promise<string> {
  const a = await rowOf(store, 'a')
  const flag = a.enabled ? 'enabled' : `disabled:${a.disabledReason}`
  return `${flag} ${JSON.stringify(a.providerState ?? null)}`
}

const OLD = 'enabled {"project":"P1"}'
const NEW = 'disabled:ineligible {"project":"P1","ineligibleAt":100}'

const ineligible = (store: PoolStore) =>
  store.disable('a', 'ineligible', {
    attribution: A1,
    providerState: (current) => mergeElig(current, { ineligibleAt: 100 }),
  })

test('an attributed disable applies its reason and its provider state together', async () => {
  await addA(open())
  const reader = open()
  const seen: string[] = []
  const steps: string[] = []
  const store = open({
    onStep: async (step, info) => {
      if (info.rowId !== 'a') return
      steps.push(step)
      seen.push(`${step}: ${await viewOf(reader)}`)
    },
  })

  const result = await ineligible(store)

  expect(result).toEqual({
    id: 'a',
    providerStateOutcome: 'updated',
    providerState: { project: 'P1', ineligibleAt: 100 },
  })
  // The state write lands first, and from then on every reader sees both.
  expect(seen).toEqual([
    `before-state-write: ${OLD}`,
    `after-state-write: ${NEW}`,
    `before-config-write: ${NEW}`,
    `after-config-write: ${NEW}`,
  ])
  const a = await rowOf(reader, 'a')
  expect(a.torn).toBeUndefined()
  expect(a.candidate).toBe(false)
  expect(a.stamp).toBe('bound')
  const config = await s.config()
  expect(config.accounts[0].enabled).toBe(false)
  expect(config.commonAuthPool.rows.a.disabledReason).toBe('ineligible')
})

test('an attributed disable stopped at any write point shows the row either before it or after it', async () => {
  const expected: Record<WriteStep, string> = {
    'before-state-write': OLD,
    'after-state-write': NEW,
    'before-config-write': NEW,
    'after-config-write': NEW,
  }
  for (const [step, view] of Object.entries(expected)) {
    s.cleanup()
    s = hooks.lifetime.manage(await scenario())
    await addA(open())
    const before = await s.bytes()
    const store = open({
      onStep: (reached) => {
        if (reached === step) throw new Error(`stopped at ${step}`)
      },
    })
    await rejectionOf(ineligible(store))
    const reader = open()
    expect(`${step}: ${await viewOf(reader)}`).toBe(`${step}: ${view}`)
    if (step === 'before-state-write') expect(await s.bytes()).toEqual(before)
    const a = await rowOf(reader, 'a')
    // Between the writes the row is shown completed and is never a candidate.
    if (step === 'after-state-write' || step === 'before-config-write') {
      expect(a.torn).toBe(true)
      expect(a.candidate).toBe(false)
      expect((await s.config()).accounts[0].enabled).not.toBe(false)
    }
    // A plain enable afterwards completes the disable first, then enables
    // the row, and the transition left in the stamp never disables it again.
    await reader.enable('a')
    expect(`${step}: ${await viewOf(reader)}`).toBe(
      `${step}: enabled ${JSON.stringify(
        step === 'before-state-write'
          ? { project: 'P1' }
          : { project: 'P1', ineligibleAt: 100 },
      )}`,
    )
    const after = await rowOf(reader, 'a')
    expect(after.torn).toBeUndefined()
    expect(after.candidate).toBe(true)
  }
})

test('a disable stopped between its writes is shown only while its stamp binds the row', async () => {
  const edits: Record<string, (config: ParsedJson, state: ParsedJson) => void> =
    {
      // An older version's replace moved the config to another epoch.
      'epoch moved': (config) => {
        config.commonAuthPool.rows.a.credentialEpoch = 2
      },
      'identity changed': (config) => {
        config.accounts[0].accountId = 'acct-other'
      },
      // A transition this store would not write says nothing.
      'no reason': (_config, state) => {
        delete state.accounts.a.commonAuthPool.transition.reason
      },
    }
  for (const [name, edit] of Object.entries(edits)) {
    s.cleanup()
    s = hooks.lifetime.manage(await scenario())
    await addA(open())
    await rejectionOf(
      ineligible(
        open({
          onStep: (step) => {
            if (step === 'after-state-write') throw new Error('stopped')
          },
        }),
      ),
    )
    const config = await s.config()
    const state = await s.state()
    edit(config, state)
    await s.writeConfig(config)
    await s.writeState(state)
    const a = await rowOf(open(), 'a')
    expect(`${name}: ${a.enabled} ${a.torn}`).toBe(`${name}: true undefined`)
    // The provider state written with the transition is hidden with it,
    // except where only the transition itself is malformed.
    expect(`${name}: ${JSON.stringify(a.providerState ?? null)}`).toBe(
      name === 'no reason'
        ? `${name}: {"project":"P1","ineligibleAt":100}`
        : `${name}: null`,
    )
  }
})

test('an attributed disable and a concurrent merge of the provider state both land', async () => {
  for (const first of ['rotate', 'disable'] as const) {
    s.cleanup()
    s = hooks.lifetime.manage(await scenario())
    await addA(open())
    const gate = deferred()
    hooks.lifetime.unpark(() => gate.resolve())
    const entered = deferred()
    // Another writer brings a project for the same credential, merged with
    // the stored value by the codec.
    const rotator = open({
      onStep: async (step) => {
        if (first === 'rotate' && step === 'before-state-write') {
          entered.resolve()
          await gate.promise
        }
      },
    })
    const rotate = () =>
      rotator.rotate('a', oauth('r-a2'), {
        providerState: { project: 'P2', eligibleAt: 50 },
      })
    const disable = () =>
      open().disable('a', 'ineligible', {
        attribution: A1,
        providerState: async (current) => {
          if (first === 'disable') {
            entered.resolve()
            await gate.promise
          }
          return mergeElig(current, { ineligibleAt: 100 })
        },
      })

    const held = first === 'rotate' ? rotate() : disable()
    await entered.promise
    const beforeContender = await s.bytes()
    const waiting = first === 'rotate' ? disable() : rotate()
    // The second writer waits for the first one's locks.
    await blocked(
      hooks.lifetime,
      waiting,
      s.contended(hooks.lifetime, 'row-acct-a'),
    )
    expect(await s.bytes()).toEqual(beforeContender)
    gate.resolve()
    await Promise.all([held, waiting])

    const a = await rowOf(open(), 'a')
    expect(`${first}: ${a.enabled}/${a.disabledReason}`).toBe(
      `${first}: false/ineligible`,
    )
    expect(refreshOf(a)).toBe('r-a2')
    expect(a.providerState).toEqual({
      project: 'P2',
      ineligibleAt: 100,
      eligibleAt: 50,
    })
  }
})

test('a strict store disables an unbound row on an attribution alone and refuses to write a provider state for it', async () => {
  await addA(open())
  // Another writer puts the same credential back without the stamp.
  const state = await s.state()
  delete state.accounts.a.commonAuthPool
  await s.writeState(state)
  const before = await s.bytes()
  const strict = open({ requireCredentialStamps: true })
  expect((await rowOf(strict, 'a')).unbound).toBe(true)

  const withState = await rejectionOf(ineligible(strict))
  const lenient = await rejectionOf(ineligible(open()))

  expect(withState.kind).toBe('unbound-credential')
  expect(lenient.kind).toBe('unbound-credential')
  expect(await s.bytes()).toEqual(before)
  expect((await rowOf(strict, 'a')).enabled).toBe(true)

  expect(await strict.disable('a', 'ineligible', { attribution: A1 })).toEqual({
    id: 'a',
  })
  const a = await rowOf(strict, 'a')
  expect(a.enabled).toBe(false)
  expect(a.disabledReason).toBe('ineligible')
  expect((await s.bytes()).state).toBe(before.state)

  // A stamp still bound to the lineage, epoch and identity, beside an
  // access token another writer swapped in: a lenient store may bind the
  // value to it, the strict one refuses the row as it refuses it everywhere.
  s.cleanup()
  s = hooks.lifetime.manage(await scenario())
  await addA(open())
  const swapped = await s.state()
  swapped.accounts.a.access = 'access-foreign'
  await s.writeState(swapped)
  const unswapped = await s.bytes()
  const refused = await rejectionOf(
    ineligible(open({ requireCredentialStamps: true })),
  )
  expect(refused.kind).toBe('unbound-credential')
  expect(refused.message).toContain('not the one this store stamped')
  expect(await s.bytes()).toEqual(unswapped)
  expect(await viewOf(open())).toBe(OLD)

  // A row holding no credential has none to write a provider state for.
  const bare = await s.state()
  delete bare.accounts.a.refresh
  await s.writeState(bare)
  const empty = await rejectionOf(
    ineligible(open({ requireCredentialStamps: true })),
  )
  expect(empty.kind).toBe('no-credential')
})

test('a provider-state mutator that declines leaves the row and both files as they were', async () => {
  const store = open()
  await addA(store)
  // A verification at the same epoch already found the account eligible
  // after the request whose refusal arrives now.
  await store.updateProviderState('a', A1, (current) =>
    mergeElig(current, { eligibleAt: 300 }),
  )
  const before = await s.bytes()
  const requestSentAt = 200
  const shown: unknown[] = []

  const result = await store.disable('a', 'ineligible', {
    attribution: A1,
    providerState: (current) => {
      shown.push(current)
      return ((current as Elig).eligibleAt ?? 0) > requestSentAt
        ? DECLINE_TRANSITION
        : mergeElig(current, { ineligibleAt: requestSentAt })
    },
  })

  expect(result).toEqual({ id: 'a', declined: true })
  expect(shown).toEqual([{ project: 'P1', eligibleAt: 300 }])
  expect(await s.bytes()).toEqual(before)
  expect((await rowOf(store, 'a')).enabled).toBe(true)

  // An enable declines the same way.
  await store.disable('a', 'manual')
  const disabled = await s.bytes()
  expect(
    await store.enable('a', {
      attribution: A1,
      providerState: () => DECLINE_TRANSITION,
    }),
  ).toEqual({ id: 'a', declined: true })
  expect(await s.bytes()).toEqual(disabled)
  // updateProviderState has no transition to decline: the value is not
  // JSON and is refused.
  const update = await rejectionOf(
    store.updateProviderState('a', A1, () => DECLINE_TRANSITION),
  )
  expect(update.kind).toBe('invalid-provider-state')
})

test('an attributed enable applies its provider state with the flag, also when stopped between its writes', async () => {
  for (const step of [
    undefined,
    'after-state-write',
    'before-config-write',
  ] as const) {
    s.cleanup()
    s = hooks.lifetime.manage(await scenario())
    const setup = open()
    await addA(setup)
    await ineligible(setup)
    const enable = (store: PoolStore) =>
      store.enable('a', {
        attribution: A1,
        providerState: (current) => mergeElig(current, { eligibleAt: 200 }),
      })
    const store = open({
      onStep: (reached) => {
        if (reached === step) throw new Error(`stopped at ${step}`)
      },
    })
    if (step === undefined)
      expect(await enable(store)).toEqual({
        id: 'a',
        providerStateOutcome: 'updated',
        providerState: { project: 'P1', ineligibleAt: 100, eligibleAt: 200 },
      })
    else await rejectionOf(enable(store))
    const reader = open()
    expect(`${step}: ${await viewOf(reader)}`).toBe(
      `${step}: enabled {"project":"P1","ineligibleAt":100,"eligibleAt":200}`,
    )
    // The next write completes the enable in the config.
    await reader.updateProviderState('a', A1, (current) => current)
    expect((await s.config()).accounts[0].enabled).toBe(true)
    expect((await s.config()).commonAuthPool.rows.a.disabledReason).toBe(
      undefined,
    )
    expect((await rowOf(reader, 'a')).candidate).toBe(true)
  }
})

test('an enable stopped between its writes keeps one enabled row per identity once completed', async () => {
  const store = open()
  await addA(store)
  await ineligible(store)
  await rejectionOf(
    open({
      onStep: (step) => {
        if (step === 'after-state-write') throw new Error('stopped')
      },
    }).enable('a', {
      attribution: A1,
      providerState: (current) => mergeElig(current, { eligibleAt: 200 }),
    }),
  )
  // A writer that does not know about transitions adds an enabled row for
  // the same account before the enable is completed.
  const config = await s.config()
  config.accounts.unshift({
    id: 'z',
    type: 'oauth',
    accountId: 'acct-a',
    enabled: true,
  })
  await s.writeConfig(config)

  const rows = rowsOf(await open().read())
  expect(
    rows.filter((row) => row.enabled && row.identity === 'acct-a'),
  ).toHaveLength(1)
  expect(rows.find((row) => row.id === 'a')?.disabledReason).toBe(
    'duplicate-identity',
  )
})

test('an attributed enable of an enabled row writes its provider state alone', async () => {
  const store = open()
  await addA(store)
  const before = await s.bytes()

  const result = await store.enable('a', {
    attribution: A1,
    providerState: (current) => mergeElig(current, { eligibleAt: 200 }),
  })

  expect(result.providerStateOutcome).toBe('updated')
  const after = await s.bytes()
  expect(after.config).toBe(before.config)
  expect(after.state).not.toBe(before.state)
  expect(
    Object.hasOwn((await s.state()).accounts.a.commonAuthPool, 'transition'),
  ).toBe(false)
  expect(await viewOf(store)).toBe('enabled {"project":"P1","eligibleAt":200}')
})

test('a provider-state change on disable or enable needs an attribution and a codec', async () => {
  await addA(open())
  const before = await s.bytes()
  const unattributed = await rejectionOf(
    open().disable('a', 'ineligible', { providerState: () => ({}) }),
  )
  const noCodec = await rejectionOf(
    s.open().enable('a', { attribution: A1, providerState: () => ({}) }),
  )
  const badEpoch = await rejectionOf(
    open().disable('a', 'ineligible', { attribution: { credentialEpoch: 0 } }),
  )
  expect([unattributed.kind, noCodec.kind, badEpoch.kind]).toEqual([
    'invalid-input',
    'invalid-input',
    'invalid-input',
  ])
  expect(await s.bytes()).toEqual(before)

  // A malformed entry has no epoch to hold an attribution against.
  const config = await s.config()
  config.commonAuthPool.rows.a.credentialEpoch = 'one'
  await s.writeConfig(config)
  const malformed = await s.bytes()
  const invalid = await rejectionOf(
    open().disable('a', 'ineligible', { attribution: A1 }),
  )
  expect(invalid.kind).toBe('invalid-row')
  expect(await s.bytes()).toEqual(malformed)
})
