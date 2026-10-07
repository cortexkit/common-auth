import { beforeEach, expect } from 'bun:test'
import type {
  Attribution,
  PoolOperationError,
  PoolRow,
  PoolStore,
  ProviderStateCodec,
} from '../../src/store/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { observed } from '../fixtures/observed.js'
import {
  blocked,
  deferred,
  oauth,
  rejectionOf,
  runChild,
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

const A1 = { credentialEpoch: 1, identity: 'acct-a' }

async function rowOf(store: PoolStore): Promise<PoolRow> {
  const load = await store.read()
  if (load.status !== 'ready') throw new Error(`pool is ${load.status}`)
  const row = load.rows.find((candidate) => candidate.id === 'a')
  if (!row) throw new Error('no row a')
  return row
}

for (const operation of ['replace', 'rotate'] as const) {
  test(`an attributed ${operation} with a matching epoch and identity succeeds`, async () => {
    const store = s.open()
    await store.add({ id: 'a', credential: oauth('r-a'), identity: 'acct-a' })
    await store[operation](
      'a',
      oauth('r-new'),
      { identity: 'acct-a' },
      { attribution: A1 },
    )
    const row = await rowOf(store)
    expect(row.credentialEpoch).toBe(operation === 'replace' ? 2 : 1)
    expect(row.identity).toBe('acct-a')
    expect(row.credential).toMatchObject({ refresh: 'r-new' })
    expect(row.stamp).toBe('bound')
  })

  test(`an attributed ${operation} with no identity matches only a row with no identity`, async () => {
    const store = s.open()
    await store.add({ id: 'a', credential: oauth('r-a') })
    await store[operation](
      'a',
      oauth('r-new'),
      {},
      { attribution: { credentialEpoch: 1 } },
    )
    const row = await rowOf(store)
    expect(row.identity).toBeUndefined()
    expect(row.credentialEpoch).toBe(operation === 'replace' ? 2 : 1)
    expect(row.credential).toMatchObject({ refresh: 'r-new' })
  })

  test(`an attributed ${operation} with a stale epoch refuses before hooks and writes nothing`, async () => {
    const store = s.open()
    await store.add({ id: 'a', credential: oauth('r-a'), identity: 'acct-a' })
    await store.replace('a', oauth('r-successor'), { identity: 'acct-a' })
    const before = await s.bytes()
    const writes: string[] = []
    let replacementCalls = 0
    let mergeCalls = 0
    const providerState: ProviderStateCodec = {
      validate: (value) => value !== null && typeof value === 'object',
      onReplace: () => {
        replacementCalls++
        return {}
      },
      merge: () => {
        mergeCalls++
        return {}
      },
    }
    const failures: Array<{ id: string; error: PoolOperationError }> = []
    const writer = s.open({
      providerState,
      onStep: (step) => {
        writes.push(step)
      },
    })
    const error = await rejectionOf(
      writer[operation](
        'a',
        oauth('r-late'),
        { providerState: {} },
        {
          attribution: A1,
          onFailure: (id, error) => {
            failures.push({ id, error })
          },
        },
      ),
    )
    expect(error.kind).toBe('attribution')
    expect(error.retryable).toBe(true)
    expect(error.phase).toBe('before-first-write')
    expect(failures).toEqual([{ id: 'a', error }])
    expect(writes).toEqual([])
    expect(replacementCalls).toBe(0)
    expect(mergeCalls).toBe(0)
    expect(await s.bytes()).toEqual(before)
  })

  for (const [label, recorded, identity] of [
    ['absent against recorded', 'acct-b', undefined],
    ['another recorded identity', 'acct-b', 'acct-a'],
    ['recorded against absent', undefined, 'acct-a'],
  ] as const) {
    test(`an attributed ${operation} refuses ${label} and writes nothing`, async () => {
      const store = s.open()
      await store.add({
        id: 'a',
        credential: oauth('r-a'),
        ...(recorded !== undefined ? { identity: recorded } : {}),
      })
      const before = await s.bytes()
      const error = await rejectionOf(
        store[operation](
          'a',
          oauth('r-late'),
          {},
          {
            attribution: {
              credentialEpoch: 1,
              ...(identity !== undefined ? { identity } : {}),
            },
          },
        ),
      )
      expect(error.kind).toBe('attribution')
      expect(error.retryable).toBe(true)
      expect(error.phase).toBe('before-first-write')
      expect(await s.bytes()).toEqual(before)
    })
  }

  test(`an attributed ${operation} refuses an id removed and re-added with the same identity`, async () => {
    const store = s.open()
    await store.add({ id: 'a', credential: oauth('r-a'), identity: 'acct-a' })
    await store.remove('a')
    // Another process can reuse the id; this process remembers its removal.
    const child = runChild({
      ...s.paths,
      op: 'add',
      id: 'a',
      credential: oauth('r-readded'),
      identity: 'acct-a',
    })
    expect(await child.exited).toBe(0)
    const writer = s.open()
    expect((await rowOf(writer)).credentialEpoch).toBe(2)
    const before = await s.bytes()
    const error = await rejectionOf(
      writer[operation]('a', oauth('r-late'), {}, { attribution: A1 }),
    )
    expect(error.kind).toBe('attribution')
    expect(await s.bytes()).toEqual(before)
  })

  test(`an attributed ${operation} of a removed id stays unknown-row`, async () => {
    const store = s.open()
    await store.add({ id: 'a', credential: oauth('r-a'), identity: 'acct-a' })
    await store.remove('a')
    const before = await s.bytes()
    const error = await rejectionOf(
      store[operation]('a', oauth('r-late'), {}, { attribution: A1 }),
    )
    expect(error.kind).toBe('unknown-row')
    expect(await s.bytes()).toEqual(before)
  })

  test(`an attributed ${operation} rejects an invalid epoch before writing`, async () => {
    const store = s.open()
    await store.add({ id: 'a', credential: oauth('r-a') })
    const before = await s.bytes()
    for (const credentialEpoch of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const error = await rejectionOf(
        store[operation](
          'a',
          oauth('r-late'),
          {},
          { attribution: { credentialEpoch } },
        ),
      )
      expect(error.kind).toBe('invalid-input')
      expect(await s.bytes()).toEqual(before)
    }
  })
}

async function interruptedReplace(): Promise<void> {
  const store = s.open()
  await store.add({ id: 'a', credential: oauth('r-a'), identity: 'acct-a' })
  const writer = s.open({
    onStep: (step) => {
      if (step === 'after-state-write')
        throw new Error('stopped after state write')
    },
  })
  const error = await rejectionOf(
    writer.replace('a', oauth('r-b'), { identity: 'acct-b' }),
  )
  expect(error.phase).toBe('after-first-write')
  const row = await rowOf(store)
  expect(row.torn).toBe(true)
  expect(row.credentialEpoch).toBe(2)
  expect(row.identity).toBe('acct-b')
}

for (const requireCredentialStamps of [false, true]) {
  const mode = requireCredentialStamps ? 'strict' : 'default'
  for (const operation of ['replace', 'rotate'] as const) {
    test(`a fenced ${operation} in ${mode} mode leaves an interrupted replace untouched on mismatch`, async () => {
      await interruptedReplace()
      const before = await s.bytes()
      const steps: string[] = []
      const writer = s.open({
        requireCredentialStamps,
        onStep: (step) => {
          steps.push(step)
        },
      })
      // The current row is the projected replacement, not the old config half.
      const fences: Attribution[] = [
        A1,
        { credentialEpoch: 2, identity: 'acct-a' },
      ]
      for (const attribution of fences) {
        const error = await rejectionOf(
          writer[operation]('a', oauth('r-late'), {}, { attribution }),
        )
        expect(error.kind).toBe('attribution')
        expect(error.phase).toBe('before-first-write')
        expect(await s.bytes()).toEqual(before)
      }
      expect(steps).toEqual([])
      expect((await rowOf(writer)).torn).toBe(true)
    })

    test(`a fenced ${operation} in ${mode} mode completes an interrupted replace when attribution matches`, async () => {
      await interruptedReplace()
      const steps: string[] = []
      const writer = s.open({
        requireCredentialStamps,
        onStep: (step) => {
          steps.push(step)
        },
      })
      await writer[operation](
        'a',
        oauth('r-next'),
        { identity: 'acct-b' },
        { attribution: { credentialEpoch: 2, identity: 'acct-b' } },
      )
      expect(steps.slice(0, 2)).toEqual([
        'before-config-write',
        'after-config-write',
      ])
      const row = await rowOf(writer)
      expect(row.torn).toBeUndefined()
      expect(row.stamp).toBe('bound')
      expect(row.credentialEpoch).toBe(operation === 'replace' ? 3 : 2)
      expect(row.identity).toBe('acct-b')
      expect(row.credential).toMatchObject({ refresh: 'r-next' })
      expect((await s.config()).commonAuthPool.rows.a.credentialEpoch).toBe(
        row.credentialEpoch,
      )
    })
  }
}

test('two replacements attributed to the same epoch race under real locks and only one writes', async () => {
  await s.open().add({ id: 'a', credential: oauth('r-a'), identity: 'acct-a' })
  const entered = deferred()
  const release = deferred()
  hooks.lifetime.unpark(() => release.resolve())
  let winnerBytes: Awaited<ReturnType<Scenario['bytes']>> | undefined
  const first = s.open({
    onStep: async (step) => {
      if (step === 'before-state-write') {
        entered.resolve()
        await release.promise
      }
      if (step === 'after-config-write') winnerBytes = await s.bytes()
    },
  })
  const losingSteps: string[] = []
  let refusedBytes: Awaited<ReturnType<Scenario['bytes']>> | undefined
  const second = s.open({
    onStep: (step) => {
      losingSteps.push(step)
    },
    onLockStep: async (lock, step) => {
      if (lock.name === 'row-acct-a' && step === 'release-owner-confirmed')
        refusedBytes = await s.bytes()
    },
  })
  const winner = first.replace(
    'a',
    oauth('r-winner'),
    { identity: 'acct-a' },
    { attribution: A1 },
  )
  await observed(hooks.lifetime, entered.promise)
  const loser = second.replace(
    'a',
    oauth('r-loser'),
    { identity: 'acct-a' },
    { attribution: A1 },
  )
  const refused = rejectionOf(loser)
  await blocked(
    hooks.lifetime,
    loser,
    s.contended(hooks.lifetime, 'row-acct-a'),
  )
  release.resolve()
  const [result, error] = await Promise.all([winner, refused])
  expect(result.credentialEpoch).toBe(2)
  expect(error.kind).toBe('attribution')
  expect(error.retryable).toBe(true)
  expect(losingSteps).toEqual([])
  expect(winnerBytes).toBeDefined()
  if (!winnerBytes) throw new Error('winner did not write its config')
  expect(refusedBytes).toEqual(winnerBytes)
  expect(await s.bytes()).toEqual(winnerBytes)
  expect((await rowOf(s.open())).credential).toMatchObject({
    refresh: 'r-winner',
  })
})
