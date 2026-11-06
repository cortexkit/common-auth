import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  mutateVaultRoster,
  projectVaultRoster,
} from '../../src/claustrum/roster.js'
import {
  acquireLimitsRegistry,
  createLimitsNamespace,
  createPoolLimitsAdapter,
  type LimitsAbandonReason,
  type LimitsClock,
  type LimitsCommand,
  LimitsEnvelopeConflictError,
  LimitsEnvelopeUnsupportedError,
  type LimitsPersistenceSnapshot,
  type PersistenceAdapter,
} from '../../src/limits/index.js'
import { createVaultLimitsAdapter } from '../../src/limits/vault.js'
import { oauth, scenario } from '../store/helpers.js'

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

class Clock implements LimitsClock {
  time = 100
  next = 0
  timers = new Map<number, { at: number; run: () => void }>()
  now = () => this.time
  setTimeout = (run: () => void, delay: number) => {
    const id = ++this.next
    this.timers.set(id, { at: this.time + delay, run })
    return id
  }
  clearTimeout = (id: unknown) => {
    this.timers.delete(id as number)
  }
  advance(ms: number) {
    this.time += ms
    for (const [id, timer] of this.timers) {
      if (timer.at <= this.time) {
        this.timers.delete(id)
        timer.run()
      }
    }
  }
}

async function fixture(kind: 'pool' | 'vault') {
  const logs: unknown[][] = []
  const waiters: (() => void)[] = []
  const waitForWarning = () =>
    new Promise<void>((resolve) => {
      waiters.push(resolve)
    })
  const logger = {
    warn: (...args: unknown[]) => {
      logs.push(args)
      for (const resolve of waiters.splice(0)) resolve()
    },
  }
  if (kind === 'pool') {
    const s = await scenario('limits-envelope-')
    cleanups.push(() => s.cleanup())
    const store = s.open()
    await store.add({
      id: 'a',
      credential: oauth('r-a'),
      identity: 'account-a',
    })
    return {
      path: s.configPath,
      namespace: `pool:${s.configPath}`,
      logs,
      waitForWarning,
      make: (namespace: string) =>
        createPoolLimitsAdapter({ namespace, store, logger, now: () => 100 }),
      put: (value: unknown) => store.updateLimitsNamespace!(() => value),
      underLock: (work: () => Promise<unknown>) =>
        store.updateLimitsNamespace!(work),
    }
  }
  const directory = await mkdtemp(join(tmpdir(), 'limits-envelope-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'roster.json')
  const roster = projectVaultRoster(
    undefined,
    {
      view: 'test',
      skipped: [],
      credentials: [
        {
          credentialId: 'a',
          credentialType: 'oauth',
          state: 'active',
          accountIdentity: 'account-a',
        },
      ],
    },
    { now: 10 },
  )
  await mutateVaultRoster(path, () => ({ next: roster, result: undefined }))
  return {
    path,
    namespace: `vault:${path}`,
    logs,
    waitForWarning,
    make: (namespace: string) =>
      createVaultLimitsAdapter({ namespace, path, logger, now: () => 100 }),
    put: async (limits: unknown) => {
      await mutateVaultRoster(path, (current) => ({
        next: { ...current!, limits },
        result: undefined,
      }))
    },
    underLock: async (work: () => Promise<unknown>) => {
      await mutateVaultRoster(path, async (current) => ({
        next: { ...current!, limits: await work() },
        result: undefined,
      }))
    },
  }
}

function mark(
  view: LimitsPersistenceSnapshot,
  operationId = 'mark',
): LimitsCommand {
  return {
    type: 'mark',
    producerId: 'test',
    operationId,
    binding: view.bindings[0]!,
    baseRevision: view.snapshot.revision,
    scope: { kind: 'pool' },
    window: 'requests',
    until: 60_000,
    evidenceAt: 100,
    mergeLaw: 'overwrite',
  }
}

async function own(
  adapter: PersistenceAdapter,
  clock = new Clock(),
  onAbandon?: (reason: LimitsAbandonReason) => void,
) {
  const registry = await acquireLimitsRegistry({
    adapter,
    clock,
    onAbandon,
    isAccessRestrictive: () => true,
  })
  cleanups.push(() => registry.dispose())
  return registry
}

for (const phase of ['before-config-write', 'after-config-write'] as const) {
  test(`pool replacement budget follows publication across a ${phase} failure`, async () => {
    const s = await scenario('limits-publish-')
    cleanups.push(() => s.cleanup())
    const store = s.open()
    await store.add({ id: 'a', credential: oauth('r-a') })
    const namespace = `publish:${s.configPath}`
    const foreign = createLimitsNamespace(`${namespace}:old`, 'old')
    await store.updateLimitsNamespace!(() => foreign)
    let fail = true
    const faulty = s.open({
      onStep: (step, info) => {
        if (
          fail &&
          info.operation === 'updateLimitsNamespace' &&
          step === phase
        )
          throw new Error('publication-step-failed')
      },
    })
    const logs: string[] = []
    const adapter = await createPoolLimitsAdapter({
      namespace,
      store: faulty,
      logger: {
        warn: (message) => {
          logs.push(message)
        },
      },
    })
    await expect(adapter.commit([])).rejects.toThrow('publication-step-failed')
    fail = false
    if (phase === 'before-config-write') {
      expect(logs).toEqual([])
      await adapter.commit([])
    }
    expect(logs).toEqual(['limits envelope replaced: foreign-namespace'])
    expect((await adapter.read()).snapshot.namespace).toBe(namespace)
    await store.updateLimitsNamespace!(() => foreign)
    const before = await readFile(s.configPath, 'utf8')
    await expect(adapter.commit([])).rejects.toBeInstanceOf(
      LimitsEnvelopeConflictError,
    )
    expect(await readFile(s.configPath, 'utf8')).toBe(before)
  })
}

test('vault publication notification observes the published envelope exactly once', async () => {
  const f = await fixture('vault')
  let published = 0
  await mutateVaultRoster(
    f.path,
    (current) => ({
      next: {
        ...current!,
        limits: createLimitsNamespace(f.namespace, 'published'),
      },
      result: undefined,
    }),
    {
      onPublished: () => {
        published++
        expect(JSON.parse(readFileSync(f.path, 'utf8')).limits.generation).toBe(
          'published',
        )
      },
    },
  )
  expect(published).toBe(1)
})

for (const kind of ['pool', 'vault'] as const) {
  for (const corruption of [
    'foreign-namespace',
    'malformed',
    'nested',
    'non-object',
  ] as const) {
    test(`${kind} cold ${corruption} envelope serves and replaces exactly once`, async () => {
      const f = await fixture(kind)
      const old = await f.make(`${f.namespace}:old`)
      const live = await old.commit([mark(await old.read())])
      if (corruption === 'malformed')
        await f.put({
          ...live.snapshot,
          namespace: f.namespace,
          revision: 'bad',
        })
      if (corruption === 'nested')
        await f.put({ ...live.snapshot, namespace: f.namespace, marks: [null] })
      if (corruption === 'non-object') await f.put(null)
      const before = await readFile(f.path, 'utf8')
      const adapter = await f.make(f.namespace)
      const view = await adapter.read()
      expect(view.authoritative).toBe(true)
      expect(view.degradedAgreement).not.toBe(true)
      expect(view.snapshot.namespace).toBe(f.namespace)
      expect(view.snapshot.marks).toEqual([])
      const registry = await own(adapter)
      expect((await registry.beforeDispatch(view.bindings[0]!)).blocked).toBe(
        false,
      )
      expect(await readFile(f.path, 'utf8')).toBe(before)
      const result = await adapter.commit([mark(view, 'new')], view.snapshot)
      expect(result.snapshot.namespace).toBe(f.namespace)
      expect(result.snapshot.marks).toHaveLength(1)
      const persisted = JSON.parse(await readFile(f.path, 'utf8'))
      expect(
        kind === 'pool' ? persisted.commonAuthLimits : persisted.limits,
      ).toEqual(result.snapshot)
      await adapter.read()
      await adapter.commit([])
      expect(f.logs).toEqual([
        [
          `limits envelope replaced: ${corruption === 'foreign-namespace' ? corruption : 'malformed'}`,
        ],
      ])
      const delayed = await adapter.commit([mark(live, 'delayed')])
      expect(delayed.outcomes[0]).toMatchObject({
        status: 'rejected',
        reason: 'wrong-namespace',
      })
    })
  }

  test(`${kind} competing namespaces stop instead of replacing in a loop`, async () => {
    const f = await fixture(kind)
    const first = await f.make(f.namespace)
    await first.commit([mark(await first.read())])
    const second = await f.make(`${f.namespace}:other`)
    await second.commit([])
    await first.commit([])
    const before = await readFile(f.path, 'utf8')
    await expect(second.read()).rejects.toBeInstanceOf(
      LimitsEnvelopeConflictError,
    )
    await expect(second.commit([])).rejects.toBeInstanceOf(
      LimitsEnvelopeConflictError,
    )
    await expect(own(second)).rejects.toBeInstanceOf(
      LimitsEnvelopeConflictError,
    )
    expect(await readFile(f.path, 'utf8')).toBe(before)
    await f.put(createLimitsNamespace(`${f.namespace}:other`, 'restored'))
    const restored = await readFile(f.path, 'utf8')
    await expect(second.commit([])).rejects.toBeInstanceOf(
      LimitsEnvelopeConflictError,
    )
    await expect(first.commit([])).rejects.toBeInstanceOf(
      LimitsEnvelopeConflictError,
    )
    expect(await readFile(f.path, 'utf8')).toBe(restored)
    expect(f.logs).toHaveLength(2)
  })

  test(`${kind} unsupported envelope rejects activation, acquisition and repair without writes`, async () => {
    const f = await fixture(kind)
    const adapter = await f.make(f.namespace)
    const view = await adapter.commit([mark(await adapter.read())])
    await f.put({ schemaVersion: 2, future: ['keep'] })
    const before = await readFile(f.path, 'utf8')
    await expect(f.make(f.namespace)).rejects.toBeInstanceOf(
      LimitsEnvelopeUnsupportedError,
    )
    await expect(own(adapter)).rejects.toBeInstanceOf(
      LimitsEnvelopeUnsupportedError,
    )
    await expect(adapter.commit([], view.snapshot)).rejects.toBeInstanceOf(
      LimitsEnvelopeUnsupportedError,
    )
    expect(await readFile(f.path, 'utf8')).toBe(before)
    await f.put(view.snapshot)
    const restored = await readFile(f.path, 'utf8')
    await expect(adapter.read()).rejects.toBeInstanceOf(
      LimitsEnvelopeUnsupportedError,
    )
    await expect(adapter.commit([])).rejects.toBeInstanceOf(
      LimitsEnvelopeUnsupportedError,
    )
    expect(await readFile(f.path, 'utf8')).toBe(restored)
  })

  for (const reason of ['conflict', 'unsupported'] as const) {
    test(`${kind} ${reason} abandonment ignores an in-flight commit and drops its next batch`, async () => {
      const f = await fixture(kind)
      await f.put(createLimitsNamespace(`${f.namespace}:old`, 'old'))
      const adapter = await f.make(f.namespace)
      await adapter.commit([])
      let release!: () => void
      let committed!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const started = new Promise<void>((resolve) => {
        committed = resolve
      })
      let writes = 0
      let events = 0
      const registry = await acquireLimitsRegistry({
        adapter: {
          ...adapter,
          commit: async (commands, previous) => {
            writes++
            const result = await adapter.commit(commands, previous)
            committed()
            await held
            return result
          },
        },
        clock: new Clock(),
        isAccessRestrictive: () => true,
        onEvent: () => {
          events++
        },
      })
      cleanups.push(() => {
        release()
        return registry.dispose()
      })
      const command = mark(await adapter.read())
      registry.enqueue(command)
      const writing = registry.flush()
      await started
      registry.enqueue({
        ...command,
        type: 'access',
        operationId: 'later',
        eligibilityStateUpdatedAt: 100,
        state: 'restricted',
      })
      const dispatch = registry.beforeDispatch(command.binding)
      await f.put(
        reason === 'conflict'
          ? createLimitsNamespace(`${f.namespace}:foreign`, 'foreign')
          : { schemaVersion: 2 },
      )
      const before = await readFile(f.path, 'utf8')
      await registry.reload()
      expect(registry.abandoned).toBe(reason)
      expect((await dispatch).blocked).toBe(false)
      release()
      await writing
      await registry.dispose()
      expect(events).toBe(0)
      expect(writes).toBe(1)
      expect(registry.pendingCommands).toBe(0)
      expect(await readFile(f.path, 'utf8')).toBe(before)
    })

    test(`${kind} queued internal repair cannot overwrite a ${reason} envelope`, async () => {
      const f = await fixture(kind)
      await f.put(createLimitsNamespace(`${f.namespace}:old`, 'old'))
      const adapter = await f.make(f.namespace)
      const saved = await adapter.commit([mark(await adapter.read())])
      await f.put(undefined)
      const warned = f.waitForWarning()
      const injected =
        reason === 'conflict'
          ? createLimitsNamespace(`${f.namespace}:other`, 'other')
          : { schemaVersion: 2, future: ['keep'] }
      await f.underLock(async () => {
        // Loss schedules a repair behind this lock; the repair must recheck the envelope.
        expect((await adapter.read(saved.snapshot)).degradedAgreement).toBe(
          true,
        )
        return injected
      })
      const before = await readFile(f.path, 'utf8')
      await warned
      expect(f.logs.at(-1)?.[0]).toBe(
        'limits envelope recovery failed; agreement remains degraded',
      )
      expect(await readFile(f.path, 'utf8')).toBe(before)
      await expect(adapter.commit([])).rejects.toBeInstanceOf(
        reason === 'conflict'
          ? LimitsEnvelopeConflictError
          : LimitsEnvelopeUnsupportedError,
      )
    })

    test(`${kind} hydrated ${reason} abandons tracking and never blocks dispatch or flushes`, async () => {
      const f = await fixture(kind)
      await f.put(createLimitsNamespace(`${f.namespace}:old`, 'old'))
      const adapter = await f.make(f.namespace)
      await adapter.commit([])
      const clock = new Clock()
      let reads = 0
      let writes = 0
      const counted: PersistenceAdapter = {
        ...adapter,
        read: async (previous) => {
          reads++
          return adapter.read(previous)
        },
        commit: async (commands, previous) => {
          writes++
          return adapter.commit(commands, previous)
        },
      }
      const reasons: LimitsAbandonReason[] = []
      const registry = await own(counted, clock, (value) => {
        reasons.push(value)
      })
      const other = await own(counted, clock, () => {
        throw new Error('observer')
      })
      const view = await adapter.read()
      const command = mark(view)
      registry.enqueue(command)
      registry.enqueue({
        ...command,
        type: 'access',
        operationId: 'access',
        eligibilityStateUpdatedAt: 100,
        state: 'restricted',
      })
      expect(clock.timers.size).toBeGreaterThan(0)
      await f.put(
        reason === 'conflict'
          ? createLimitsNamespace(`${f.namespace}:foreign`, 'foreign')
          : { schemaVersion: 2, future: ['keep'] },
      )
      const before = await readFile(f.path, 'utf8')
      await registry.reload()
      expect(registry.abandoned).toBe(reason)
      expect(other.abandoned).toBe(reason)
      expect(reasons).toEqual([reason])
      expect(registry.pendingCommands).toBe(0)
      expect(clock.timers.size).toBe(0)
      expect(registry.snapshot.marks).toEqual([])
      const attempts = reads
      clock.advance(30_000)
      registry.enqueue({ ...command, operationId: 'ignored' })
      await registry.reload()
      await registry.flush()
      expect(
        (
          await registry.beforeDispatch({
            ...view.bindings[0]!,
            credentialEpoch: 'changed',
          })
        ).blocked,
      ).toBe(false)
      expect(registry.pendingCommands).toBe(0)
      await registry.dispose()
      await other.dispose()
      expect(reads).toBe(attempts)
      expect(writes).toBe(0)
      expect(clock.timers.size).toBe(0)
      expect(await readFile(f.path, 'utf8')).toBe(before)
    })
  }
}
