import { expect } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  mutateVaultRoster,
  projectVaultRoster,
  readVaultRoster,
} from '../../src/claustrum/roster.js'
import { EnvelopeHistory } from '../../src/limits/envelope-loss.js'
import {
  acquireLimitsRegistry,
  applyLimitsCommands,
  createLimitsNamespace,
  createPoolLimitsAdapter,
  type LimitsCommand,
  type LimitsNamespace,
  type LimitsPersistenceCommit,
  type LimitsPersistenceSnapshot,
  type PersistenceAdapter,
} from '../../src/limits/index.js'
import { createVaultLimitsAdapter } from '../../src/limits/vault.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { observed } from '../fixtures/observed.js'
import { oauth, runChild, type Scenario, scenario } from '../store/helpers.js'

const hooks = lifetimeHooks()
const { it, afterEach } = hooks
const scenarios: Scenario[] = []
afterEach(() => {
  for (const s of scenarios.splice(0)) s.cleanup()
})

async function fixture(kind: 'pool' | 'vault') {
  const s = hooks.lifetime.manage(await scenario('envelope-loss-'))
  scenarios.push(s)
  const path = join(s.dir, 'roster.json')
  const namespace = `${kind}:${path}`
  const store = s.open()
  if (kind === 'pool') {
    await store.add({ id: 'a', credential: oauth('a'), identity: 'account-a' })
  } else {
    const roster = projectVaultRoster(
      undefined,
      {
        view: 'initial',
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
  }
  const adapter = () =>
    kind === 'pool'
      ? createPoolLimitsAdapter({ namespace, store: s.open(), now: () => 100 })
      : createVaultLimitsAdapter({ namespace, path, now: () => 100 })
  const durable = async (): Promise<LimitsNamespace | undefined> =>
    kind === 'pool'
      ? (await s.config()).commonAuthLimits
      : ((await readVaultRoster(path))?.limits as LimitsNamespace | undefined)
  // Simulate an older writer, bypassing the new writers' preservation rules.
  const replace = async (envelope: LimitsNamespace | undefined) => {
    if (kind === 'pool') {
      const config = await s.config()
      if (envelope === undefined) delete config.commonAuthLimits
      else config.commonAuthLimits = envelope
      await s.writeConfig(config)
    } else {
      const roster = await readVaultRoster(path)
      await writeFile(path, JSON.stringify({ ...roster, limits: envelope }))
    }
  }
  return { s, path, namespace, adapter, durable, replace }
}

function mark(
  view: LimitsPersistenceSnapshot,
  operationId = 'mark',
): Extract<LimitsCommand, { type: 'mark' }> {
  return {
    type: 'mark',
    producerId: 'p1',
    operationId,
    binding: view.bindings[0]!,
    baseRevision: view.snapshot.revision,
    scope: { kind: 'pool' },
    window: 'requests',
    until: 100_000,
    evidenceAt: 100,
    mergeLaw: 'max-until',
  }
}

function clear(view: LimitsPersistenceSnapshot): LimitsCommand {
  return {
    type: 'clear',
    producerId: 'p2',
    operationId: 'clear',
    binding: view.bindings[0]!,
    baseRevision: view.snapshot.revision,
    keys: [{ scope: { kind: 'pool' }, window: 'requests' }],
  }
}

function childView(output: string, prefix: string): LimitsPersistenceCommit {
  const line = output.split('\n').find((line) => line.startsWith(prefix))
  if (!line) throw new Error(`Missing child snapshot: ${prefix}`)
  return JSON.parse(line.slice(prefix.length))
}

for (const kind of ['pool', 'vault'] as const) {
  for (const cause of [
    'missing',
    'generation',
    'rollback',
    'tombstone',
  ] as const) {
    it(`${kind} recovers ${cause} envelope loss without resurrecting a cleared mark`, async () => {
      const f = await fixture(kind)
      const adapter = await f.adapter()
      const marked = await adapter.commit([mark(await adapter.read())])
      const cleared = await adapter.commit([clear(marked)])
      const rewritten =
        cause === 'missing'
          ? undefined
          : {
              ...(cause === 'rollback' ? marked.snapshot : cleared.snapshot),
              ...(cause === 'generation' && {
                generation: 'older-writer-generation',
                revision: 100,
              }),
              ...(cause === 'tombstone' && { tombstones: [], revision: 3 }),
            }
      await f.replace(rewritten)
      const repaired = await adapter.read()
      expect(repaired.degradedAgreement).toBe(true)
      expect(repaired.authoritative).toBe(true)
      expect(repaired.snapshot.revision).toBeGreaterThan(
        Math.max(2, rewritten?.revision ?? 0),
      )
      expect(repaired.snapshot.lowWatermark).toBeGreaterThanOrEqual(
        repaired.snapshot.revision,
      )
      expect(repaired.snapshot.marks).toEqual([])
      expect(repaired.snapshot.tombstones).toEqual(cleared.snapshot.tombstones)
      expect(repaired.snapshot.operationIds).toEqual(
        cleared.snapshot.operationIds,
      )
      if (rewritten)
        expect(repaired.snapshot.generation).toBe(rewritten.generation)
      expect(await f.durable()).toEqual(repaired.snapshot)
      expect((await adapter.read()).degradedAgreement).not.toBe(true)
    })
  }

  it(`${kind} recovery barrier rejects P1 before P2 repairs and preserves the shorter fresh max-until deadline`, async () => {
    const f = await fixture(kind)
    await f.replace({
      ...createLimitsNamespace(f.namespace, 'original'),
      revision: 48,
    })
    const p1 = await f.adapter()
    const at49 = await p1.commit([mark(await p1.read(), 'long')])
    expect(at49.snapshot.revision).toBe(49)
    const queued = mark(at49, 'queued-at-49')
    const child = runChild({
      ...f.s.paths,
      op: 'limits-envelope-loss',
      kind,
      namespace: f.namespace,
      path: f.path,
    })
    hooks.lifetime.unpark(() => child.continue())
    const exited = hooks.lifetime.operation(child.exited)
    await observed(hooks.lifetime, child.printed('cleared:'))
    const at50 = childView(child.output(), 'cleared:')
    expect(at50.snapshot.revision).toBe(50)
    expect(at50.snapshot.tombstones[0]?.revision).toBe(50)
    await f.replace(undefined)
    const recovered = await p1.read()
    expect(recovered.degradedAgreement).toBe(true)
    expect(recovered.snapshot.revision).toBe(50)
    expect(recovered.snapshot.lowWatermark).toBeGreaterThanOrEqual(50)
    const rejected = await p1.commit([queued])
    expect(rejected.outcomes).toMatchObject([
      { status: 'rejected', reason: 'below-watermark' },
    ])
    expect(rejected.snapshot.tombstones).toEqual([])
    expect(child.output()).not.toContain('restored:')
    const fresh = await p1.commit([
      { ...mark(recovered, 'fresh'), until: 2_000 },
    ])
    expect(
      fresh.snapshot.marks[0]?.entries
        .map((e) => e.until)
        .sort((a, b) => a - b),
    ).toEqual([2_000, 100_000])
    child.continue()
    expect(await exited, child.output()).toBe(0)
    const restored = childView(child.output(), 'restored:')
    expect(restored.degradedAgreement).toBe(true)
    expect(restored.snapshot.generation).toBe(recovered.snapshot.generation)
    expect(restored.snapshot.revision).toBeGreaterThan(fresh.snapshot.revision)
    expect(restored.snapshot.tombstones).toEqual(at50.snapshot.tombstones)
    expect(restored.snapshot.marks[0]?.entries).toEqual([
      {
        until: 2_000,
        evidenceAt: 100,
        baseRevision: recovered.snapshot.revision,
        committedRevision: fresh.snapshot.revision,
      },
    ])
    expect((await p1.read()).snapshot).toEqual(restored.snapshot)
    expect(await f.durable()).toEqual(restored.snapshot)
  })

  it(`${kind} detects loss at commit without an intervening reload`, async () => {
    const f = await fixture(kind)
    const adapter = await f.adapter()
    const marked = await adapter.commit([mark(await adapter.read())])
    await adapter.commit([clear(marked)])
    await f.replace(undefined)
    const result = await adapter.commit([mark(marked, 'stale')])
    expect(result.degradedAgreement).toBe(true)
    expect(result.outcomes[0]).toMatchObject({
      status: 'rejected',
      reason: 'below-watermark',
    })
    expect(result.snapshot.marks).toEqual([])
    expect(result.snapshot.tombstones[0]?.revision).toBe(2)
  })

  it(`${kind} replacement adapter recovers the registry's retained snapshot`, async () => {
    const f = await fixture(kind)
    const original = await f.adapter()
    const marked = await original.commit([mark(await original.read())])
    const cleared = await original.commit([clear(marked)])
    await f.replace(undefined)
    const replacement = await f.adapter()
    const recovered = await replacement.read(cleared.snapshot)
    expect(recovered.degradedAgreement).toBe(true)
    expect(recovered.snapshot.revision).toBeGreaterThan(
      cleared.snapshot.revision,
    )
    expect(recovered.snapshot.tombstones).toEqual(cleared.snapshot.tombstones)
    expect(recovered.snapshot.marks).toEqual([])
  })

  for (const state of ['blocked', 'eligible'] as const) {
    it(`${kind} barrier ${state === 'blocked' ? 'rebases restrictive' : 'does not replay permissive'} access`, async () => {
      const f = await fixture(kind)
      const adapter = await f.adapter()
      const marked = await adapter.commit([mark(await adapter.read())])
      await adapter.commit([clear(marked)])
      const attempts: LimitsCommand[] = []
      const rejections: string[] = []
      const tracked: PersistenceAdapter = {
        ...adapter,
        async commit(commands, previous) {
          attempts.push(...commands)
          return adapter.commit(commands, previous)
        },
      }
      const owner = await acquireLimitsRegistry({
        adapter: tracked,
        isAccessRestrictive: (value) => value === 'blocked',
        onRejected: (_command, outcome) =>
          rejections.push(outcome.reason ?? ''),
      })
      try {
        const command: LimitsCommand = {
          ...owner.observe(marked.bindings[0]!),
          producerId: 'access-producer',
          operationId: 'access-operation',
          type: 'access',
          state,
          eligibilityStateUpdatedAt: 123,
        }
        await f.replace(undefined)
        owner.enqueue(command)
        await owner.flush()
        expect(rejections).toEqual(['below-watermark'])
        expect(attempts).toHaveLength(state === 'blocked' ? 2 : 1)
        if (state === 'blocked') {
          expect(attempts[1]).toEqual({ ...command, baseRevision: 3 })
        }
        expect(owner.pendingCommands).toBe(0)
        expect(owner.degradedAgreement).toBe(true)
        const other = await f.adapter()
        const durable = await other.read()
        expect(durable.snapshot.access.map((entry) => entry.state)).toEqual(
          state === 'blocked' ? ['blocked'] : [],
        )
        const child = runChild({
          ...f.s.paths,
          op: 'limits-envelope-loss',
          kind,
          namespace: f.namespace,
          path: f.path,
          inspect: true,
        })
        expect(
          await hooks.lifetime.operation(child.exited),
          child.output(),
        ).toBe(0)
        const inspected = childView(
          child.output(),
          'inspected:',
        ) as LimitsPersistenceCommit & { blocked: boolean }
        expect(inspected.blocked).toBe(state === 'blocked')
        expect(inspected.snapshot.access).toEqual(durable.snapshot.access)
        await owner.reload()
        expect(owner.degradedAgreement).toBe(false)
      } finally {
        await owner.dispose()
      }
    })
  }
}

it('repeated barriers stop restrictive access retries and retain a degraded dispatch fence', async () => {
  const namespace = `memory:bounded:${Date.now()}`
  const binding = {
    account: { namespace, accountId: 'a', incarnation: '1' },
    credentialEpoch: '1',
  }
  let snapshot = createLimitsNamespace(namespace, 'generation')
  const attempts: LimitsCommand[] = []
  const adapter: PersistenceAdapter = {
    namespace,
    async read() {
      return { snapshot, bindings: [binding], authoritative: true }
    },
    async commit(commands) {
      attempts.push(...commands)
      // Fail fast if retry bounding regresses, rather than hanging the test.
      if (attempts.length > 4) throw new Error('retry budget exceeded')
      const revision = snapshot.revision + 1
      snapshot = { ...snapshot, revision, lowWatermark: revision }
      return {
        ...applyLimitsCommands(snapshot, commands, {
          now: 100,
          bindings: [binding],
          authorizeEpoch: () => true,
        }),
        bindings: [binding],
        authoritative: true,
      }
    },
  }
  const owner = await acquireLimitsRegistry({
    adapter,
    isAccessRestrictive: (value) => value === 'blocked',
  })
  try {
    const command: LimitsCommand = {
      ...owner.observe(binding),
      type: 'access',
      state: 'blocked',
      producerId: 'producer',
      operationId: 'operation',
      eligibilityStateUpdatedAt: 100,
    }
    owner.enqueue(command)
    await owner.flush()
    expect(attempts.map((c) => c.baseRevision)).toEqual([0, 1, 2, 3])
    expect(
      attempts.every(
        (c) =>
          c.producerId === command.producerId &&
          c.operationId === command.operationId,
      ),
    ).toBe(true)
    expect(owner.pendingCommands).toBe(0)
    await owner.reload()
    expect(owner.degradedAgreement).toBe(true)
    expect((await owner.beforeDispatch(binding)).blocked).toBe(true)
    expect(attempts).toHaveLength(4)
    expect(snapshot.access).toEqual([])
  } finally {
    await owner.dispose()
  }
})

it('recovery unions present state by merge law, revision and access evidence order', () => {
  const namespace = 'memory:union'
  const account = { namespace, accountId: 'a', incarnation: '1' }
  const key = { account, scope: { kind: 'pool' as const }, window: 'requests' }
  const old: LimitsNamespace = {
    ...createLimitsNamespace(namespace, 'old'),
    revision: 50,
    tombstones: [{ key, revision: 50 }],
    operationIds: [{ producerId: 'p', operationId: 'clear', revision: 50 }],
    access: [
      {
        account,
        state: 'blocked',
        eligibilityStateUpdatedAt: 200,
        committedRevision: 48,
      },
    ],
  }
  const present: LimitsNamespace = {
    ...createLimitsNamespace(namespace, 'present'),
    revision: 60,
    marks: [
      {
        key,
        mergeLaw: 'max-until',
        entries: [
          {
            until: 100_000,
            evidenceAt: 100,
            baseRevision: 49,
            committedRevision: 59,
          },
          {
            until: 2_000,
            evidenceAt: 100,
            baseRevision: 51,
            committedRevision: 60,
          },
        ],
      },
    ],
    operationIds: [
      { producerId: 'p', operationId: 'clear', revision: 51 },
      { producerId: 'q', operationId: 'fresh', revision: 60 },
    ],
    access: [
      {
        account,
        state: 'eligible',
        eligibilityStateUpdatedAt: 100,
        committedRevision: 60,
      },
    ],
  }
  const history = new EnvelopeHistory()
  history.remember(old)
  expect(history.lost(present)).toBe(true)
  const recovered = history.recover(present, undefined, namespace, 100)
  expect(recovered.generation).toBe('present')
  expect(recovered.revision).toBe(61)
  expect(recovered.lowWatermark).toBe(61)
  expect(recovered.marks[0]?.entries).toEqual([present.marks[0]!.entries[1]!])
  expect(recovered.access).toEqual(old.access)
  expect(recovered.operationIds.map((op) => op.revision)).toEqual([51, 60])
  expect(recovered.tombstones).toEqual(old.tombstones)
  const compacted = { ...old, revision: 51, lowWatermark: 50, tombstones: [] }
  expect(history.lost(compacted)).toBe(false)
})

for (const mergeLaw of ['overwrite', 'latest-evidence'] as const) {
  it(`recovery applies ${mergeLaw} to retained and present contributions`, () => {
    const namespace = `memory:${mergeLaw}`
    const account = { namespace, accountId: 'a', incarnation: '1' }
    const key = {
      account,
      scope: { kind: 'pool' as const },
      window: 'requests',
    }
    const old: LimitsNamespace = {
      ...createLimitsNamespace(namespace, 'old'),
      revision: 10,
      marks: [
        {
          key,
          mergeLaw,
          entries: [
            {
              until: 100_000,
              evidenceAt: 100,
              baseRevision: 9,
              committedRevision: 10,
            },
          ],
        },
      ],
      access: [
        {
          account,
          state: 'blocked',
          eligibilityStateUpdatedAt: 100,
          committedRevision: 10,
        },
      ],
    }
    const present: LimitsNamespace = {
      ...createLimitsNamespace(namespace, 'present'),
      revision: 11,
      marks: [
        {
          key,
          mergeLaw,
          entries: [
            {
              until: 2_000,
              evidenceAt: 100,
              baseRevision: 10,
              committedRevision: 11,
            },
          ],
        },
      ],
      access: [
        {
          account,
          state: 'eligible',
          eligibilityStateUpdatedAt: 100,
          committedRevision: 11,
        },
      ],
    }
    const history = new EnvelopeHistory()
    history.remember(old)
    const recovered = history.recover(present, undefined, namespace, 100)
    expect(recovered.marks).toEqual(present.marks)
    expect(recovered.access).toEqual(present.access)
  })
}
