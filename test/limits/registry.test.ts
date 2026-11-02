import { afterEach, expect, test } from 'bun:test'
import type {
  IdentityBinding,
  LimitsClock,
  LimitsCommand,
  LimitsPersistenceCommit,
  LimitsPersistenceSnapshot,
  LimitsRegistry,
  LimitsRegistryEvent,
  PersistenceAdapter,
} from '../../src/limits/index.js'
import {
  acquireLimitsRegistry,
  applyLimitsCommands,
  createLimitsNamespace,
  LIMITS_REGISTRY_KEY,
  LimitsPersistenceRefusal,
  scopeCovers,
} from '../../src/limits/index.js'
import { assertNotInsideHook, runInsideHook } from '../../src/store/hooks.js'

async function drain() {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}
class FakeClock implements LimitsClock {
  time = 0
  sequence = 0
  timers = new Map<number, { at: number; callback: () => void }>()
  now = () => this.time
  setTimeout(callback: () => void, delay: number) {
    const id = ++this.sequence
    this.timers.set(id, { at: this.time + delay, callback })
    return id
  }
  clearTimeout(timer: unknown) {
    this.timers.delete(timer as number)
  }
  async advance(ms: number) {
    const target = this.time + ms
    await drain()
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!next) break
      this.time = next[1].at
      this.timers.delete(next[0])
      next[1].callback()
      await drain()
    }
    this.time = target
    await drain()
  }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
let sequence = 0
const owners: LimitsRegistry[] = []
const gates: ReturnType<typeof deferred>[] = []
afterEach(async () => {
  for (const gate of gates.splice(0)) gate.resolve()
  for (const owner of owners.splice(0)) await owner.dispose()
})
function hold() {
  const gate = deferred()
  gates.push(gate)
  return gate
}
function fixture() {
  const clock = new FakeClock()
  const namespace = `memory:${++sequence}`
  const binding = (id: string): IdentityBinding => ({
    account: { namespace, accountId: id, incarnation: 'login-1' },
    credentialEpoch: 'epoch-1',
    identity: id,
  })
  const a = binding('A'),
    b = binding('B')
  let snapshot = createLimitsNamespace(namespace, 'generation-1')
  const bindings = [a, b]
  const listeners = new Set<() => void>()
  const state = {
    reads: 0,
    writes: 0,
    subscriptions: 0,
    unsubscriptions: 0,
    failRead: false,
    failWrite: false,
    notReady: false,
    reject: false,
    authoritative: true,
    loseAck: false,
    latency: 0,
    gate: undefined as ReturnType<typeof deferred> | undefined,
    onCommit: undefined as (() => Promise<void>) | undefined,
  }
  function view(): LimitsPersistenceSnapshot {
    return {
      snapshot: structuredClone(snapshot),
      bindings: structuredClone(bindings),
      authoritative: state.authoritative,
    }
  }
  const adapter: PersistenceAdapter = {
    namespace,
    async read() {
      state.reads++
      if (state.failRead) throw new Error('read unavailable')
      const result = view()
      if (state.latency)
        await new Promise<void>((resolve) =>
          clock.setTimeout(resolve, state.latency),
        )
      return result
    },
    async commit(commands): Promise<LimitsPersistenceCommit> {
      assertNotInsideHook('add')
      state.writes++
      if (state.gate) await state.gate.promise
      if (state.notReady) throw new LimitsPersistenceRefusal('pool-not-ready')
      if (state.failWrite) throw new Error('write unavailable')
      const result = state.reject
        ? {
            snapshot,
            outcomes: commands.map((command) => ({
              ...command,
              status: 'rejected' as const,
              reason: 'credential-epoch' as const,
            })),
          }
        : applyLimitsCommands(snapshot, commands, {
            now: clock.now(),
            bindings,
            authorizeEpoch: (observed, current) =>
              observed.credentialEpoch === current.credentialEpoch,
          })
      snapshot = result.snapshot
      await state.onCommit?.()
      if (state.loseAck) {
        state.loseAck = false
        throw new Error('lost acknowledgement')
      }
      return { ...view(), outcomes: result.outcomes }
    },
    subscribe(callback) {
      state.subscriptions++
      listeners.add(callback)
      return () => {
        state.unsubscriptions++
        listeners.delete(callback)
      }
    },
  }
  async function acquire(
    extra: Partial<Parameters<typeof acquireLimitsRegistry>[0]> = {},
  ) {
    const owner = await acquireLimitsRegistry({
      adapter,
      clock,
      isAccessRestrictive: (value) => value === 'blocked',
      ...extra,
    })
    owners.push(owner)
    return owner
  }
  function mark(
    owner: LimitsRegistry,
    id = `op-${++sequence}`,
    who = a,
  ): LimitsCommand {
    return {
      ...owner.observe(who),
      producerId: 'producer',
      operationId: id,
      type: 'mark',
      scope: { kind: 'pool' },
      window: 'rate',
      until: 100_000,
      evidenceAt: clock.now(),
      mergeLaw: 'max-until',
    }
  }
  function clear(
    owner: LimitsRegistry,
    id = `op-${++sequence}`,
  ): LimitsCommand {
    return {
      ...owner.observe(a),
      producerId: 'producer',
      operationId: id,
      type: 'clear',
      keys: [{ scope: { kind: 'pool' }, window: 'rate' }],
    }
  }
  function access(owner: LimitsRegistry, value = 'blocked'): LimitsCommand {
    return {
      ...owner.observe(a),
      producerId: 'producer',
      operationId: `op-${++sequence}`,
      type: 'access',
      state: value,
      eligibilityStateUpdatedAt: clock.now(),
    }
  }
  return {
    clock,
    a,
    b,
    bindings,
    state,
    adapter,
    acquire,
    mark,
    clear,
    access,
    durable: () => snapshot,
    recover: () => {
      const revision = snapshot.revision + 1
      snapshot = { ...snapshot, revision, lowWatermark: revision }
    },
    notify: () => {
      for (const listener of listeners) listener()
    },
  }
}

function canSend(
  view: Awaited<ReturnType<LimitsRegistry['beforeDispatch']>>,
  binding: IdentityBinding,
) {
  return (
    !view.blocked &&
    !view.snapshot.marks.some(
      (mark) => mark.key.account.accountId === binding.account.accountId,
    )
  )
}

test('same-schema acquisitions share the process registry and retain one subscription', async () => {
  const f = fixture()
  const first = await f.acquire(),
    second = await f.acquire()
  const root = Reflect.get(globalThis, LIMITS_REGISTRY_KEY)
  expect(root.schemaVersion).toBe(1)
  expect(root.namespaces.has(f.adapter.namespace)).toBe(true)
  expect(f.state.subscriptions).toBe(1)
  first.enqueue(f.mark(first))
  expect(second.pendingCommands).toBe(1)
  await first.dispose()
  expect(f.state.unsubscriptions).toBe(0)
  await f.clock.advance(1000)
  expect(second.snapshot.marks).toHaveLength(1)
  await second.dispose()
  expect(f.state.unsubscriptions).toBe(1)
})

test('a different schema refuses activation instead of silently sharing memory', async () => {
  const key = Symbol.for('@cortexkit/common-auth/limits-registry/schema-v2')
  Reflect.set(globalThis, key, { schemaVersion: 2 })
  try {
    await expect(fixture().acquire()).rejects.toThrow('limits-schema-mismatch')
  } finally {
    Reflect.deleteProperty(globalThis, key)
  }
})

for (const kind of ['clear', 'access'] as const) {
  test(`pending ${kind} fences A only: B sends before A's acknowledgement`, async () => {
    const f = fixture(),
      owner = await f.acquire()
    if (kind === 'clear') {
      owner.enqueue(f.mark(owner))
      await owner.flush()
    }
    const gate = hold()
    f.state.gate = gate
    owner.enqueue(kind === 'clear' ? f.clear(owner) : f.access(owner))
    let aFinished = false
    const pendingA = owner.beforeDispatch(f.a).then((view) => {
      aFinished = true
      return view
    })
    const sends: string[] = []
    if (canSend(await owner.beforeDispatch(f.b), f.b)) sends.push('B')
    expect(sends).toEqual(['B'])
    expect(aFinished).toBe(false)
    expect(owner.pendingCommands).toBe(1)
    gate.resolve()
    const viewA = await pendingA
    expect(viewA.blocked).toBe(kind === 'access')
    expect(owner.pendingCommands).toBe(0)
  })
}

test('rejected clear grants no availability and rejected restrictive access survives clean reads', async () => {
  const f = fixture(),
    owner = await f.acquire()
  owner.enqueue(f.mark(owner))
  await owner.flush()
  f.state.reject = true
  owner.enqueue(f.clear(owner))
  expect(owner.snapshot.marks).toHaveLength(1)
  expect(canSend(await owner.beforeDispatch(f.a), f.a)).toBe(false)
  owner.enqueue(f.access(owner))
  expect((await owner.beforeDispatch(f.a)).blocked).toBe(true)
  await owner.reload()
  expect(owner.pendingCommands).toBe(0)
  expect((await owner.beforeDispatch(f.a)).blocked).toBe(true)
  expect(owner.degradedAgreement).toBe(true)
  f.state.reject = false
  await f.clock.advance(1)
  owner.enqueue(f.access(owner, 'eligible'))
  await owner.flush()
  await owner.reload()
  expect((await owner.beforeDispatch(f.a)).blocked).toBe(false)
  expect(owner.degradedAgreement).toBe(false)
})

test('not-ready commits settle as rejected without waiting forever on a clear', async () => {
  const f = fixture(),
    owner = await f.acquire()
  owner.enqueue(f.mark(owner))
  await owner.flush()
  f.state.notReady = true
  owner.enqueue(f.clear(owner))
  expect(canSend(await owner.beforeDispatch(f.a), f.a)).toBe(false)
  expect(owner.pendingCommands).toBe(0)
})

test('write failure degrades until settlement plus an authoritative snapshot; reload failure also degrades', async () => {
  const f = fixture(),
    owner = await f.acquire()
  f.state.failWrite = true
  owner.enqueue(f.access(owner))
  await owner.flush()
  expect(owner.degradedAgreement).toBe(true)
  await owner.reload()
  expect(owner.degradedAgreement).toBe(true)
  expect(owner.pendingCommands).toBe(1)
  expect((await owner.beforeDispatch(f.a)).blocked).toBe(true)
  f.state.failWrite = false
  await owner.flush()
  f.state.authoritative = false
  await owner.reload()
  expect(owner.degradedAgreement).toBe(true)
  f.state.authoritative = true
  await owner.reload()
  expect(owner.degradedAgreement).toBe(false)
  f.state.failRead = true
  await owner.reload()
  expect(owner.degradedAgreement).toBe(true)
  f.state.failRead = false
  await owner.reload()
  expect(owner.degradedAgreement).toBe(false)
  owner.enqueue(f.mark(owner))
  f.state.failRead = true
  await owner.reload()
  f.state.failRead = false
  await owner.reload()
  expect(owner.degradedAgreement).toBe(true)
  await owner.flush()
  await owner.reload()
  expect(owner.degradedAgreement).toBe(false)
})

test('timed publication is a 1000 ms debounce with no request-path write wait', async () => {
  const f = fixture(),
    owner = await f.acquire()
  owner.enqueue(f.mark(owner))
  expect(owner.snapshot.marks).toHaveLength(1)
  expect(owner.snapshot.revision).toBe(0)
  expect(owner.snapshot.operationIds).toHaveLength(0)
  expect(owner.observe(f.a).baseRevision).toBe(0)
  expect(canSend(await owner.beforeDispatch(f.b), f.b)).toBe(true)
  await f.clock.advance(500)
  owner.enqueue(f.mark(owner))
  await f.clock.advance(999)
  expect(f.state.writes).toBe(0)
  const gate = hold()
  f.state.gate = gate
  await f.clock.advance(1)
  expect(f.state.writes).toBe(1)
  expect(f.durable().marks).toHaveLength(0)
  expect(canSend(await owner.beforeDispatch(f.b), f.b)).toBe(true)
  gate.resolve()
  await owner.flush()
  expect(f.durable().marks).toHaveLength(1)
})

test('a mark recorded inside onPersisted publishes outside its inherited store-hook context', async () => {
  const f = fixture(),
    owner = await f.acquire()
  const onPersisted = () => {
    owner.enqueue(f.mark(owner))
  }
  await runInsideHook('add', onPersisted)
  await f.clock.advance(999)
  expect(f.state.writes).toBe(0)
  await f.clock.advance(1)
  expect(f.state.writes).toBe(1)
  expect(f.durable().marks).toHaveLength(1)
  expect(owner.degradedAgreement).toBe(false)
})

async function acquireOtherProcess(f: ReturnType<typeof fixture>) {
  const processRegistry = Reflect.get(globalThis, LIMITS_REGISTRY_KEY)
  Reflect.deleteProperty(globalThis, LIMITS_REGISTRY_KEY)
  try {
    return await f.acquire()
  } finally {
    Reflect.set(globalThis, LIMITS_REGISTRY_KEY, processRegistry)
  }
}

test('active reader excludes A within 1000 ms plus latency, stops after 5 s idle, and reloads on resume', async () => {
  const f = fixture(),
    writer = await f.acquire(),
    reader = await acquireOtherProcess(f)
  await reader.beforeDispatch(f.a)
  await f.clock.advance(1)
  writer.enqueue(f.mark(writer))
  await writer.flush()
  f.state.latency = 40
  await f.clock.advance(1040)
  expect(canSend(await reader.beforeDispatch(f.a), f.a)).toBe(false)
  for (let i = 0; i < 3; i++) {
    await f.clock.advance(700)
    expect(canSend(await reader.beforeDispatch(f.a), f.a)).toBe(false)
  }
  await f.clock.advance(5000)
  const reads = f.state.reads
  await f.clock.advance(10_000)
  expect(f.state.reads).toBe(reads)
  let finished = false
  const resumed = reader.beforeDispatch(f.a).then((view) => {
    finished = true
    return view
  })
  await drain()
  expect(finished).toBe(false)
  expect(f.state.reads).toBe(reads + 1)
  await f.clock.advance(40)
  expect(canSend(await resumed, f.a)).toBe(false)
})

test('stale concurrent dispatches join one read; fresh dispatches do not read each time', async () => {
  const f = fixture(),
    owner = await f.acquire()
  for (let i = 0; i < 5; i++) await owner.beforeDispatch(f.b)
  expect(f.state.reads).toBe(1)
  await f.clock.advance(15_000)
  f.state.latency = 40
  const first = owner.beforeDispatch(f.a),
    second = owner.beforeDispatch(f.b)
  await drain()
  const reads = f.state.reads
  await f.clock.advance(40)
  await Promise.all([first, second])
  expect(f.state.reads).toBe(reads)
})

test('notifications reconcile a clear before the next periodic reload', async () => {
  const f = fixture(),
    writer = await f.acquire(),
    reader = await acquireOtherProcess(f)
  writer.enqueue(f.mark(writer))
  await writer.flush()
  await reader.reload()
  writer.enqueue(f.clear(writer))
  await writer.flush()
  f.notify()
  await drain()
  expect(reader.snapshot.marks).toHaveLength(0)
})

test('dispose flushes and unsubscribes; replacement waits for handoff and hydrates before dispatch', async () => {
  const f = fixture(),
    owner = await f.acquire()
  owner.enqueue(f.mark(owner))
  const gate = hold()
  f.state.gate = gate
  const disposing = owner.dispose()
  const replacing = f.acquire()
  await drain()
  expect(f.state.subscriptions).toBe(1)
  gate.resolve()
  await disposing
  const replacement = await replacing
  expect(f.state.unsubscriptions).toBe(1)
  expect(f.state.subscriptions).toBe(2)
  expect(canSend(await replacement.beforeDispatch(f.a), f.a)).toBe(false)
  await f.clock.advance(2000)
  expect(f.state.writes).toBe(1)
  expect(() => owner.enqueue(f.mark(replacement))).toThrow(
    'limits-registry-disposed',
  )
})

test('failed dispose retains the journal and control fence through replacement hydration', async () => {
  const f = fixture(),
    owner = await f.acquire()
  f.state.failWrite = true
  owner.enqueue(f.access(owner))
  await owner.dispose()
  const replacement = await f.acquire()
  expect(replacement.pendingCommands).toBe(1)
  expect(replacement.degradedAgreement).toBe(true)
  expect((await replacement.beforeDispatch(f.a)).blocked).toBe(true)
  expect(canSend(await replacement.beforeDispatch(f.b), f.b)).toBe(true)
  f.state.failWrite = false
  await replacement.flush()
  await replacement.reload()
  expect(replacement.pendingCommands).toBe(0)
  expect(replacement.degradedAgreement).toBe(false)
  expect((await replacement.beforeDispatch(f.a)).blocked).toBe(true)
})

test('mark and success events fire once, including a retried commit whose acknowledgement was lost', async () => {
  const f = fixture(),
    events: LimitsRegistryEvent[] = [],
    owner = await f.acquire({ onEvent: (event) => events.push(event) })
  const mark = f.mark(owner)
  f.state.loseAck = true
  owner.enqueue(mark)
  await owner.flush()
  expect(events).toHaveLength(0)
  await owner.flush()
  expect(events.map((event) => event.type)).toEqual(['mark'])
  owner.enqueue(mark)
  await owner.flush()
  owner.enqueue(f.clear(owner), 'success')
  await owner.flush()
  await owner.reload()
  expect(events.map((event) => event.type)).toEqual(['mark', 'success'])
  expect(events.map((event) => event.revision)).toEqual([1, 2])
})

test('family marks cover that family only and 300 sessions retain at most 256 activity records', async () => {
  const f = fixture(),
    owner = await f.acquire()
  owner.enqueue({
    ...f.mark(owner),
    type: 'mark',
    scope: { kind: 'family', family: 'claude' },
    until: 100_000,
    evidenceAt: 0,
    mergeLaw: 'max-until',
    window: 'rate',
  })
  await owner.flush()
  const scope = owner.snapshot.marks[0]!.key.scope
  expect(scopeCovers(scope, 'claude-sonnet', () => 'claude')).toBe(true)
  expect(scopeCovers(scope, 'gemini', () => 'gemini')).toBe(false)
  for (let i = 0; i < 300; i++)
    owner.activity.recordAccepted({
      sessionId: `session-${i}`,
      accountKey: f.a.account,
      currentAccountKey: f.a.account,
      lastAcceptedAt: i,
    })
  expect(owner.activity.size).toBe(256)
  expect(owner.activity.get('session-0')).toBeUndefined()
  expect(owner.activity.get('session-43')).toBeUndefined()
  expect(owner.activity.get('session-44')).toBeDefined()
  expect(owner.activity.get('session-299')).toBeDefined()
})

test('a mark queued during commit keeps its debounce and dispose delivers the committed event', async () => {
  const f = fixture(),
    events: LimitsRegistryEvent[] = []
  const owner = await f.acquire({ onEvent: (event) => events.push(event) })
  f.state.onCommit = async () => {
    f.state.onCommit = undefined
    await runInsideHook('add', () =>
      owner.enqueue(f.mark(owner, 'from-hook', f.b)),
    )
  }
  owner.enqueue(f.mark(owner))
  await owner.flush()
  expect(f.state.writes).toBe(1)
  expect(owner.pendingCommands).toBe(1)
  await f.clock.advance(999)
  expect(f.state.writes).toBe(1)
  await f.clock.advance(1)
  expect(f.state.writes).toBe(2)
  owner.enqueue(f.clear(owner), 'success')
  await owner.dispose()
  expect(events.map((event) => event.type)).toEqual(['mark', 'mark', 'success'])
})

test('a restrictive access command rejected by a recovery barrier is rebased and committed', async () => {
  const f = fixture(),
    owner = await f.acquire()
  const command = f.access(owner)
  f.recover()
  owner.enqueue(command)
  await owner.flush()
  expect(f.state.writes).toBe(2)
  expect(owner.pendingCommands).toBe(0)
  expect(f.durable().access[0]?.state).toBe('blocked')
  await owner.reload()
  expect(owner.degradedAgreement).toBe(false)
  expect((await owner.beforeDispatch(f.a)).blocked).toBe(true)
})

test('replacement retires a rejected access restriction but an unknown identity does not erase a known one', async () => {
  const f = fixture(),
    owner = await f.acquire()
  f.state.reject = true
  owner.enqueue(f.access(owner))
  await owner.flush()
  f.bindings[0] = { ...f.a, identity: undefined }
  await owner.reload()
  expect((await owner.beforeDispatch(f.a)).blocked).toBe(true)
  f.bindings[0] = {
    ...f.a,
    account: { ...f.a.account, incarnation: 'login-2' },
    identity: 'replacement',
  }
  await owner.reload()
  expect((await owner.beforeDispatch(f.bindings[0])).blocked).toBe(false)
  expect((await owner.beforeDispatch(f.a)).blocked).toBe(true)
})

test('a delayed older read cannot roll back a newer committed snapshot', async () => {
  const f = fixture(),
    owner = await f.acquire()
  f.state.latency = 40
  const reading = owner.reload()
  owner.enqueue(f.mark(owner))
  await owner.flush()
  await f.clock.advance(40)
  await reading
  expect(owner.snapshot.revision).toBe(1)
  expect(owner.snapshot.marks).toHaveLength(1)
})
