import { beforeEach, describe, expect } from 'bun:test'
import type {
  OpenPoolStoreOptions,
  PoolRow,
  PoolStore,
  WriteStep,
} from '../../src/store/index.js'
import {
  acquirePoolLock,
  POOL_LOCK_DEFAULTS,
} from '../../src/store/refresh-lock.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import {
  apiKey,
  blocked,
  oauth,
  type ParsedJson,
  rejectionOf,
  type Scenario,
  scenario,
} from './helpers.js'

const hooks = lifetimeHooks()
const { afterEach, it } = hooks

let s: Scenario
beforeEach(async () => {
  s = hooks.lifetime.manage(await scenario())
})
afterEach(() => s.cleanup())

const EXPIRES = 4_000_000_000_000
const OLD_URL = 'https://old.example.test/v1'
const NEW_URL = 'https://new.example.test/v1'

function strict(overrides: Partial<OpenPoolStoreOptions> = {}): PoolStore {
  return s.open({ requireCredentialStamps: true, ...overrides })
}

async function rowOf(store: PoolStore, id = 'a'): Promise<PoolRow> {
  const load = await store.read()
  if (load.status !== 'ready') throw new Error(`pool is ${load.status}`)
  const row = load.rows.find((candidate) => candidate.id === id)
  if (!row) throw new Error(`no row ${id}`)
  return row
}

async function editState(edit: (accounts: ParsedJson) => void): Promise<void> {
  const state = await s.state()
  edit(state.accounts)
  await s.writeState(state)
}

async function editConfig(edit: (config: ParsedJson) => void): Promise<void> {
  const config = await s.config()
  edit(config)
  await s.writeConfig(config)
}

/** The secret a row sends: its refresh token. */
function secretOf(row: PoolRow): string {
  if (row.credential?.type !== 'oauth') throw new Error('expected oauth')
  return row.credential.refresh
}

/**
 * Row `a`: an OAuth credential the store added and stamped for account
 * `acct-a` at epoch 1, with a quota reading recorded against it.
 */
async function seed(): Promise<void> {
  const store = s.open()
  await store.add({ id: 'a', credential: oauth('r-a'), identity: 'acct-a' })
  await store.recordQuota(
    'a',
    { credentialEpoch: 1, identity: 'acct-a' },
    'seen',
  )
}

interface Craft {
  title: string
  status: NonNullable<PoolRow['stamp']>
  edit(): Promise<void>
}

/** Ways the files can leave row `a`, each with the stamp status it loads as. */
const CRAFTS: Craft[] = [
  {
    title: 'no credential',
    status: 'none',
    edit: () =>
      editState((accounts) => {
        delete accounts.a
      }),
  },
  {
    title: 'no stamp',
    status: 'missing',
    edit: () =>
      editState((accounts) => {
        delete accounts.a.commonAuthPool
      }),
  },
  {
    title: 'no stamp and no per-row entry',
    status: 'missing',
    edit: async () => {
      await editState((accounts) => {
        delete accounts.a.commonAuthPool
      })
      await editConfig((config) => {
        delete config.commonAuthPool.rows.a
      })
    },
  },
  {
    title: 'a malformed stamp',
    status: 'malformed',
    edit: () =>
      editState((accounts) => {
        delete accounts.a.commonAuthPool.digest
      }),
  },
  {
    title: 'an out-of-range stamp epoch',
    status: 'malformed',
    edit: () =>
      editState((accounts) => {
        accounts.a.commonAuthPool.credentialEpoch = 2 ** 53
      }),
  },
  {
    title: 'a digest mismatch',
    status: 'mismatched',
    edit: () =>
      editState((accounts) => {
        accounts.a.refresh = 'r-swapped'
      }),
  },
  {
    title: 'an epoch mismatch',
    status: 'mismatched',
    edit: () =>
      editConfig((config) => {
        config.commonAuthPool.rows.a.credentialEpoch = 2
      }),
  },
  {
    title: 'a binding mismatch',
    status: 'mismatched',
    edit: () =>
      editState((accounts) => {
        accounts.a.commonAuthPool.binding = { identity: 'acct-other' }
      }),
  },
  {
    title: 'an access-only swap',
    status: 'mismatched',
    edit: () =>
      editState((accounts) => {
        accounts.a.access = 'access-foreign'
      }),
  },
  {
    title: 'an expiry-only change',
    status: 'mismatched',
    edit: () =>
      editState((accounts) => {
        accounts.a.expires = 1
      }),
  },
  {
    title: 'a stamp without a dispatch digest (as 0.4.3 wrote it)',
    status: 'legacy',
    edit: () =>
      editState((accounts) => {
        delete accounts.a.commonAuthPool.dispatch
        delete accounts.a.commonAuthPool.binding
      }),
  },
  {
    title: 'a stamp with a dispatch digest but no binding',
    status: 'malformed',
    edit: () =>
      editState((accounts) => {
        delete accounts.a.commonAuthPool.binding
      }),
  },
  {
    title: 'a non-string dispatch digest',
    status: 'malformed',
    edit: () =>
      editState((accounts) => {
        accounts.a.commonAuthPool.dispatch = 42
      }),
  },
  {
    title: 'a replace mark that is not true',
    status: 'malformed',
    edit: () =>
      editState((accounts) => {
        accounts.a.commonAuthPool.replace = 'yes'
      }),
  },
  { title: 'a bound stamp', status: 'bound', edit: async () => {} },
]

const UNBOUND = CRAFTS.filter(
  (craft) => craft.status !== 'none' && craft.status !== 'bound',
)

/** A fresh pool holding row `a` as the craft leaves it. */
async function crafted(craft: Craft): Promise<void> {
  s.cleanup()
  s = hooks.lifetime.manage(await scenario())
  await seed()
  await craft.edit()
}

function provider(calls: string[]) {
  return async (credential: { refresh: string }) => {
    calls.push(credential.refresh)
    return {
      access: 'access-next',
      refresh: `${credential.refresh}-next`,
      expires: EXPIRES,
    }
  }
}

describe('credential stamp status', () => {
  it('every crafted row loads with its stamp status, and only strict mode makes it unbound', async () => {
    for (const craft of CRAFTS) {
      await crafted(craft)
      const loose = await rowOf(s.open())
      const tight = await rowOf(strict())
      expect({
        craft: craft.title,
        stamp: loose.stamp,
        looseCandidate: loose.candidate,
        looseUnbound: loose.unbound,
        tightStamp: tight.stamp,
        tightCandidate: tight.candidate,
        tightUnbound: tight.unbound,
      }).toEqual({
        craft: craft.title,
        stamp: craft.status,
        looseCandidate: craft.status !== 'none',
        looseUnbound: undefined,
        tightStamp: craft.status,
        tightCandidate: craft.status === 'bound',
        tightUnbound: craft.status === 'bound' ? undefined : true,
      })
    }
  }, 30_000)

  it('a replace binding is bound while it names the row identity and endpoint, and mismatched once the config disagrees', async () => {
    const store = s.open()
    await store.add({ id: 'a', credential: oauth('r-a'), identity: 'acct-a' })
    await store.replace('a', oauth('r-b'), { identity: 'acct-b' })
    expect((await rowOf(store)).stamp).toBe('bound')
    await editConfig((config) => {
      config.accounts[0].accountId = 'acct-c'
    })
    expect((await rowOf(store)).stamp).toBe('mismatched')

    // A binding that names no identity is not contradicted by one learnt later.
    await store.add({ id: 'n', credential: oauth('r-n') })
    await store.replace('n', oauth('r-n2'))
    await store.recordIdentity('n', 'acct-n', { credentialEpoch: 2 })
    expect((await rowOf(store, 'n')).stamp).toBe('bound')

    await store.add({
      id: 'k',
      credential: apiKey('key-1', { baseURL: OLD_URL }),
    })
    await store.replace('k', apiKey('key-2', { baseURL: NEW_URL }))
    expect((await rowOf(store, 'k')).stamp).toBe('bound')
    const index = (await s.config()).accounts.findIndex(
      (raw: ParsedJson) => raw.id === 'k',
    )
    await editConfig((config) => {
      config.accounts[index].baseURL = 'https://other.example.test/v1'
    })
    expect((await rowOf(store, 'k')).stamp).toBe('mismatched')
    await editConfig((config) => {
      config.accounts[index].baseURL = NEW_URL
      config.accounts[index].authHeader = 'x-api-key'
    })
    expect((await rowOf(store, 'k')).stamp).toBe('mismatched')
  })
})

describe('strict mode refuses unbound rows', () => {
  it('strict refresh refuses every unbound row before the provider call and writes nothing', async () => {
    for (const craft of UNBOUND) {
      await crafted(craft)
      const before = await s.bytes()
      const calls: string[] = []
      const error = await rejectionOf(strict().refresh('a', provider(calls)))
      expect({
        craft: craft.title,
        kind: error.kind,
        phase: error.phase,
        calls,
        bytes: await s.bytes(),
      }).toEqual({
        craft: craft.title,
        kind: 'unbound-credential',
        phase: 'before-first-write',
        calls: [],
        bytes: before,
      })
    }
  }, 30_000)

  it('strict pull of every unbound row reports unbound-credential with no request and writes nothing', async () => {
    for (const craft of UNBOUND) {
      await crafted(craft)
      const before = await s.bytes()
      let requests = 0
      const failures: string[] = []
      const store = strict({
        pull: async () => {
          requests++
          return 'reading'
        },
        onPullFailure: (_id, error) => {
          failures.push(`${error.kind} ${error.phase}`)
        },
      })
      await store.load()
      store.requestReading('a')
      await store.pullsSettled()
      expect({
        craft: craft.title,
        requests,
        failures,
        bytes: await s.bytes(),
      }).toEqual({
        craft: craft.title,
        requests: 0,
        failures: ['unbound-credential pull'],
        bytes: before,
      })
    }
  }, 30_000)

  it('strict recordQuota refuses every unbound row and writes nothing', async () => {
    for (const craft of UNBOUND) {
      await crafted(craft)
      const store = strict()
      const row = await rowOf(store)
      const before = await s.bytes()
      const error = await rejectionOf(
        store.recordQuota(
          'a',
          {
            credentialEpoch: row.credentialEpoch ?? 1,
            ...(row.identity !== undefined ? { identity: row.identity } : {}),
          },
          'late',
        ),
      )
      expect({
        craft: craft.title,
        kind: error.kind,
        phase: error.phase,
        bytes: await s.bytes(),
      }).toEqual({
        craft: craft.title,
        kind: 'unbound-credential',
        phase: 'pull',
        bytes: before,
      })
    }
  }, 30_000)

  it('strict recordIdentity refuses every unbound row and writes nothing', async () => {
    for (const craft of UNBOUND) {
      await crafted(craft)
      const store = strict()
      const row = await rowOf(store)
      const before = await s.bytes()
      const error = await rejectionOf(
        store.recordIdentity('a', 'acct-a', {
          credentialEpoch: row.credentialEpoch ?? 1,
        }),
      )
      expect({
        craft: craft.title,
        kind: error.kind,
        bytes: await s.bytes(),
      }).toEqual({
        craft: craft.title,
        kind: 'unbound-credential',
        bytes: before,
      })
    }
  }, 30_000)

  it('strict rotate refuses every unbound row and writes nothing', async () => {
    for (const craft of UNBOUND) {
      await crafted(craft)
      const before = await s.bytes()
      const error = await rejectionOf(strict().rotate('a', oauth('r-rotated')))
      expect({
        craft: craft.title,
        kind: error.kind,
        phase: error.phase,
        bytes: await s.bytes(),
      }).toEqual({
        craft: craft.title,
        kind: 'unbound-credential',
        phase: 'before-first-write',
        bytes: before,
      })
    }
  }, 30_000)

  it('strict add of the secret an unbound row holds refuses instead of rotating that row', async () => {
    for (const craft of UNBOUND) {
      await crafted(craft)
      const store = strict()
      const secret = secretOf(await rowOf(store))
      const before = await s.bytes()
      const error = await rejectionOf(
        store.add({ id: 'b', credential: oauth(secret), identity: 'acct-a' }),
      )
      expect({
        craft: craft.title,
        kind: error.kind,
        bytes: await s.bytes(),
      }).toEqual({
        craft: craft.title,
        kind: 'unbound-credential',
        bytes: before,
      })
    }
  }, 30_000)

  it('strict mode keeps a credential-less row out of reach of every path but replace', async () => {
    await crafted(CRAFTS[0] as Craft)
    const store = strict()
    const before = await s.bytes()
    const kinds = {
      add: (
        await rejectionOf(store.add({ id: 'a', credential: oauth('r-new') }))
      ).kind,
      rotate: (await rejectionOf(store.rotate('a', oauth('r-new')))).kind,
      recordIdentity: (
        await rejectionOf(
          store.recordIdentity('a', 'acct-a', { credentialEpoch: 1 }),
        )
      ).kind,
      refresh: (await rejectionOf(store.refresh('a', provider([])))).kind,
      recordQuota: (
        await rejectionOf(
          store.recordQuota('a', { credentialEpoch: 1, identity: 'acct-a' }, 1),
        )
      ).kind,
    }
    expect(kinds).toEqual({
      add: 'unbound-credential',
      rotate: 'unbound-credential',
      recordIdentity: 'unbound-credential',
      refresh: 'no-credential',
      recordQuota: 'no-credential',
    })
    expect(await s.bytes()).toEqual(before)
    await store.replace('a', oauth('r-new'), { identity: 'acct-new' })
    expect(await rowOf(store)).toMatchObject({
      stamp: 'bound',
      candidate: true,
      credentialEpoch: 2,
      identity: 'acct-new',
    })
  })

  it('strict mode lets every operation through on a bound row', async () => {
    await seed()
    const calls: string[] = []
    const failures: string[] = []
    const store = strict({
      pull: async () => 'pulled',
      onPullFailure: (_id, error) => {
        failures.push(error.kind)
      },
    })
    expect(await rowOf(store)).toMatchObject({
      stamp: 'bound',
      candidate: true,
    })
    await store.recordQuota(
      'a',
      { credentialEpoch: 1, identity: 'acct-a' },
      'direct',
    )
    store.requestReading('a')
    await store.pullsSettled()
    await store.recordIdentity('a', 'acct-a', { credentialEpoch: 1 })
    expect(await store.refresh('a', provider(calls))).toMatchObject({
      status: 'rotated',
    })
    await store.rotate('a', oauth('r-rotated'), { identity: 'acct-a' })
    expect(
      await store.add({ id: 'b', credential: oauth('r-rotated') }),
    ).toMatchObject({ id: 'a', outcome: 'rotated' })
    expect({ calls, failures }).toEqual({ calls: ['r-a'], failures: [] })
    expect(await rowOf(store)).toMatchObject({
      stamp: 'bound',
      candidate: true,
      credentialEpoch: 1,
      identity: 'acct-a',
      quota: { readings: ['seen', 'direct', 'pulled'] },
    })
  })
})

describe('strict mode and writers that land while an operation waits', () => {
  it('a credential swapped in during a strict refresh provider call is refused at commit and nothing is written', async () => {
    await seed()
    let swapped: { config: string | null; state: string | null } | undefined
    const store = strict({
      hold: async (point) => {
        if (point !== 'refresh-before-provider') return
        await editState((accounts) => {
          accounts.a.refresh = 'r-foreign'
        })
        swapped = await s.bytes()
      },
    })
    const calls: string[] = []
    const error = await rejectionOf(store.refresh('a', provider(calls)))
    expect({ kind: error.kind, phase: error.phase, calls }).toEqual({
      kind: 'unbound-credential',
      phase: 'before-first-write',
      calls: ['r-a'],
    })
    expect(await s.bytes()).toEqual(swapped as never)
    expect(await rowOf(store)).toMatchObject({
      stamp: 'mismatched',
      unbound: true,
    })
  })

  it('a credential swapped in during a strict pull request is refused when the reading is recorded', async () => {
    await seed()
    let swapped: { config: string | null; state: string | null } | undefined
    const failures: string[] = []
    let requests = 0
    const store = strict({
      hold: async (point) => {
        if (point !== 'pull-before-request') return
        await editState((accounts) => {
          accounts.a.refresh = 'r-foreign'
        })
        swapped = await s.bytes()
      },
      pull: async () => {
        requests++
        return 'late'
      },
      onPullFailure: (_id, error) => {
        failures.push(error.kind)
      },
    })
    store.requestReading('a')
    await store.pullsSettled()
    expect({ requests, failures }).toEqual({
      requests: 1,
      failures: ['unbound-credential'],
    })
    expect(await s.bytes()).toEqual(swapped as never)
  })

  it('a credential swapped in while a strict rotate waits on the row lock is refused at the locked re-read', async () => {
    await seed()
    const held = await acquirePoolLock(
      { name: 'row-acct-a', path: s.statePath },
      { ...POOL_LOCK_DEFAULTS, renew: false },
      { now: Date.now },
    )
    const rotation = strict().rotate('a', oauth('r-rotated'))
    try {
      await blocked(
        hooks.lifetime,
        rotation,
        s.contended(hooks.lifetime, 'row-acct-a'),
      )
      await editState((accounts) => {
        accounts.a.refresh = 'r-foreign'
      })
    } finally {
      await held.release()
    }
    const swapped = await s.bytes()
    const error = await rejectionOf(rotation)
    expect({ kind: error.kind, phase: error.phase }).toEqual({
      kind: 'unbound-credential',
      phase: 'before-first-write',
    })
    expect(await s.bytes()).toEqual(swapped)
  })
})

describe('strict mode recovery', () => {
  it('strict replace of an unbound row binds fresh material at the next epoch and drops what was observed', async () => {
    await crafted(CRAFTS[1] as Craft)
    const store = strict()
    expect(await rowOf(store)).toMatchObject({
      unbound: true,
      identity: 'acct-a',
      quota: { readings: ['seen'] },
    })
    const result = await store.replace('a', oauth('r-fresh'), {
      identity: 'acct-new',
    })
    expect(result.credentialEpoch).toBe(2)
    const row = await rowOf(store)
    expect(row).toMatchObject({
      stamp: 'bound',
      candidate: true,
      credentialEpoch: 2,
      identity: 'acct-new',
      needsFirstReading: true,
    })
    expect(row.unbound).toBeUndefined()
    expect(row.quota).toBeUndefined()

    // A replace that names no identity leaves the row with none.
    await crafted(CRAFTS[7] as Craft)
    await strict().replace('a', oauth('r-fresh'))
    expect(await rowOf(strict())).toMatchObject({
      stamp: 'bound',
      candidate: true,
      credentialEpoch: 2,
    })
    expect((await rowOf(strict())).identity).toBeUndefined()
  })

  it('strict add of an unbound row secret refuses, and replacing the row then binds it', async () => {
    await crafted(CRAFTS[1] as Craft)
    const store = strict()
    const error = await rejectionOf(
      store.add({ id: 'b', credential: oauth('r-a') }),
    )
    expect(error.kind).toBe('unbound-credential')
    await store.replace('a', oauth('r-a'), { identity: 'acct-a' })
    expect(await rowOf(store)).toMatchObject({
      stamp: 'bound',
      candidate: true,
      credentialEpoch: 2,
    })
    expect((await rowOf(store)).quota).toBeUndefined()
    expect(
      await store.add({ id: 'b', credential: oauth('r-a') }),
    ).toMatchObject({ id: 'a', outcome: 'rotated' })
  })
})

describe('strict mode and an interrupted replace', () => {
  const STEPS: WriteStep[] = [
    'before-state-write',
    'after-state-write',
    'before-config-write',
    'after-config-write',
  ]

  it('a strict replace interrupted at each write is whole or torn, never unbound, and a pull completes it forward', async () => {
    for (const step of STEPS) {
      s.cleanup()
      s = hooks.lifetime.manage(await scenario())
      await s
        .open()
        .add({ id: 'a', credential: oauth('r-old'), identity: 'acct-old' })
      let armed = true
      const writer = strict({
        onStep: (at, info) => {
          if (armed && info.operation === 'replace' && at === step) {
            armed = false
            throw new Error(`stopped at ${step}`)
          }
        },
      })
      await writer
        .replace('a', oauth('r-new'), { identity: 'acct-new' })
        .catch(() => undefined)
      const landed = step !== 'before-state-write'
      const torn =
        step === 'after-state-write' || step === 'before-config-write'
      const seen = await rowOf(strict())
      expect({
        step,
        stamp: seen.stamp,
        unbound: seen.unbound,
        torn: seen.torn,
        candidate: seen.candidate,
        epoch: seen.credentialEpoch,
        identity: seen.identity,
      }).toEqual({
        step,
        stamp: 'bound',
        unbound: undefined,
        torn: torn ? true : undefined,
        candidate: !torn,
        epoch: landed ? 2 : 1,
        identity: landed ? 'acct-new' : 'acct-old',
      })

      const failures: string[] = []
      const reader = strict({
        pull: async () => 'reading',
        onPullFailure: (_id, error) => {
          failures.push(error.kind)
        },
      })
      await reader.load()
      await reader.pullsSettled()
      const after = await rowOf(strict())
      expect({
        step,
        failures,
        stamp: after.stamp,
        torn: after.torn,
        candidate: after.candidate,
        epoch: after.credentialEpoch,
        quota: after.quota,
      }).toEqual({
        step,
        failures: [],
        stamp: 'bound',
        torn: undefined,
        candidate: true,
        epoch: landed ? 2 : 1,
        quota: { readings: ['reading'] },
      })
    }
  }, 30_000)

  it('a strict write never completes an unbound row as if it were torn', async () => {
    const crafts: Array<[string, (accounts: ParsedJson) => void]> = [
      [
        'a stamp ahead with a binding but another digest',
        (accounts) => {
          accounts.a.commonAuthPool = {
            credentialEpoch: 2,
            digest: 'written-for-another-credential',
            binding: { identity: 'acct-x' },
          }
        },
      ],
      [
        'a stamp ahead with the right digest but no binding',
        (accounts) => {
          accounts.a.commonAuthPool.credentialEpoch = 2
          delete accounts.a.commonAuthPool.binding
        },
      ],
      [
        'no stamp',
        (accounts) => {
          delete accounts.a.commonAuthPool
        },
      ],
    ]
    for (const [title, edit] of crafts) {
      s.cleanup()
      s = hooks.lifetime.manage(await scenario())
      await seed()
      await editState(edit)
      const store = strict()
      await store.disable('a', 'probe')
      await store.enable('a')
      const row = await rowOf(store)
      expect({
        title,
        torn: row.torn,
        unbound: row.unbound,
        candidate: row.candidate,
        epoch: (await s.config()).commonAuthPool.rows.a.credentialEpoch,
        identity: (await s.config()).accounts[0].accountId,
      }).toEqual({
        title,
        torn: undefined,
        unbound: true,
        candidate: false,
        epoch: 1,
        identity: 'acct-a',
      })
    }
  }, 30_000)
})

describe('strict mode off', () => {
  it('without requireCredentialStamps every unbound row loads and is operated on as before', async () => {
    for (const craft of UNBOUND) {
      await crafted(craft)
      const store = s.open({ pull: async () => 'pulled' })
      const row = await rowOf(store)
      // The pull goes first: it gives a row without a per-row entry its
      // entry, which a reading recorded directly needs.
      store.requestReading('a')
      await store.pullsSettled()
      const epoch = row.credentialEpoch ?? 1
      await store.recordQuota(
        'a',
        { credentialEpoch: epoch, identity: 'acct-a' },
        'direct',
      )
      await store.recordIdentity('a', 'acct-a', { credentialEpoch: epoch })
      const readded = await store.add({
        id: 'b',
        credential: oauth(secretOf(row)),
      })
      await store.rotate('a', oauth('r-rotated'))
      const calls: string[] = []
      const refreshed = await store.refresh('a', provider(calls))
      const after = await rowOf(store)
      expect({
        craft: craft.title,
        candidate: row.candidate,
        unbound: row.unbound,
        readded: readded.outcome,
        refreshed: refreshed.status,
        calls,
        quota: after.quota,
      }).toEqual({
        craft: craft.title,
        candidate: true,
        unbound: undefined,
        readded: 'rotated',
        refreshed: 'rotated',
        calls: ['r-rotated'],
        quota: {
          readings: row.hasEntry
            ? ['seen', 'pulled', 'direct']
            : ['pulled', 'direct'],
        },
      })
    }

    await crafted(CRAFTS[0] as Craft)
    expect(
      await s.open().add({ id: 'a', credential: oauth('r-new') }),
    ).toMatchObject({ outcome: 'completed' })
  }, 60_000)
})
