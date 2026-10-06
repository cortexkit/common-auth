// A second process for crash and cross-process rows. It runs one store
// operation described by its JSON argument, prints `step:<name>` at each
// named write step, and exits with CRASH_EXIT_CODE when it reaches `exitAt`,
// so the observing test process survives the crash.
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import {
  openPoolStore,
  type PoolCredential,
  type WriteStep,
} from '../../src/store/index.js'
import { CRASH_EXIT_CODE, listCodec, objectStateCodec } from './helpers.js'

type Task = {
  configPath: string
  statePath: string
  op:
    | 'add'
    | 'replace'
    | 'rotate'
    | 'remove'
    | 'reorder'
    | 'addMany'
    | 'recordIdentity'
    | 'enable'
    | 'disable'
    | 'refresh'
  id: string
  ids?: string[]
  credential?: PoolCredential
  identity?: string
  /**
   * add: the provider state written with the credential. When given, the
   * child's store is opened with `objectStateCodec`.
   */
  providerState?: unknown
  /** recordIdentity: the credential epoch the identity lookup was issued for. */
  credentialEpoch?: number
  count?: number
  exitAt?: WriteStep
  /** Only lapse probes override the production lease length. */
  ttlMs?: number
  /** Only deliberate lapse probes disable production renewal. */
  renew?: boolean
  /** Blocks renewal after acquisition to measure event-loop starvation. */
  stallAfterAcquireMs?: number
  /** Allows renewal timers to run before the crash point. */
  pauseBeforeStateMs?: number
  /** Holds the crash point until every acquired lease completes renewal. */
  waitForRenewal?: boolean
  /** Parks the crash point until the parent has read a live lease. */
  waitForParentRead?: boolean
}

const task = JSON.parse(process.argv[2] ?? '{}') as Task
const parentRead = task.waitForParentRead
  ? new Promise<void>((resolve) => {
      process.stdin.once('data', () => resolve())
    })
  : Promise.resolve()
let stalled = false
const heldPaths = new Set<string>()
const initialExpiry = new Map<string, number>()
const renewedPaths = new Set<string>()
let acquisitionComplete = false
let renewalObserved = () => {}
const allRenewed = new Promise<void>((resolve) => {
  renewalObserved = resolve
})
const store = openPoolStore({
  provider: 'openai',
  configPath: task.configPath,
  statePath: task.statePath,
  quota: listCodec,
  ...(task.providerState !== undefined
    ? { providerState: objectStateCodec }
    : {}),
  // Crash operations use the same renewing leases as production. The parent
  // expires abandoned records only after this process has exited.
  lockOptions: {
    ...(task.ttlMs !== undefined ? { ttlMs: task.ttlMs } : {}),
    ...(task.renew !== undefined ? { renew: task.renew } : {}),
  },
  onLockEvent: (event) => {
    if (event.type === 'contended')
      console.log(`contended:${event.name}@${event.path}`)
    if (event.type !== 'acquired') return
    const path = `${event.path}.${event.name}.lock`
    heldPaths.add(path)
    const record = JSON.parse(readFileSync(path, 'utf8'))
    initialExpiry.set(path, record.expiresAt)
    console.log(
      `lease:${JSON.stringify({ path, ...record, acquiredAt: Date.now() })}`,
    )
    if (task.stallAfterAcquireMs && !stalled) {
      stalled = true
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        task.stallAfterAcquireMs,
      )
      console.log(
        `stalled:${JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), now: Date.now() })}`,
      )
    }
  },
  onLockStep: async (lock, step) => {
    if (!task.waitForRenewal || step !== 'renewal-finished') return
    const path = `${lock.path}.${lock.name}.lock`
    const record = JSON.parse(readFileSync(path, 'utf8'))
    if (record.expiresAt <= (initialExpiry.get(path) ?? Infinity)) return
    if (!renewedPaths.has(path)) {
      console.log(`renewed:${JSON.stringify({ path, ...record })}`)
      renewedPaths.add(path)
    }
    if (
      acquisitionComplete &&
      [...heldPaths].every((held) => renewedPaths.has(held))
    )
      renewalObserved()
  },
  onStep: async (step) => {
    if (step === 'before-state-write' && task.waitForRenewal) {
      await parentRead
      acquisitionComplete = true
      if ([...heldPaths].every((held) => renewedPaths.has(held)))
        renewalObserved()
      // Production renewal timers are unreferenced. Keep the child alive while
      // the write is parked, without using elapsed time as proof of renewal.
      const keepAlive = setInterval(() => {}, 1_000)
      try {
        await allRenewed
      } finally {
        clearInterval(keepAlive)
      }
    }
    if (step === 'before-state-write' && task.pauseBeforeStateMs) {
      await delay(task.pauseBeforeStateMs)
      for (const path of heldPaths)
        console.log(
          `renewed:${JSON.stringify({ path, ...JSON.parse(readFileSync(path, 'utf8')) })}`,
        )
    }
    console.log(`step:${step}`)
    if (step === task.exitAt) process.exit(CRASH_EXIT_CODE)
  },
})

const identity = task.identity !== undefined ? { identity: task.identity } : {}
console.log('started')
try {
  if (task.op === 'add') {
    await store.add({
      id: task.id,
      credential: task.credential as PoolCredential,
      ...identity,
      ...(task.providerState !== undefined
        ? { providerState: task.providerState }
        : {}),
    })
  } else if (task.op === 'replace') {
    await store.replace(task.id, task.credential as PoolCredential, identity)
  } else if (task.op === 'rotate') {
    await store.rotate(task.id, task.credential as PoolCredential, identity)
  } else if (task.op === 'remove') {
    await store.remove(task.id)
  } else if (task.op === 'recordIdentity') {
    await store.recordIdentity(task.id, task.identity ?? '', {
      credentialEpoch: task.credentialEpoch ?? 1,
    })
  } else if (task.op === 'enable') {
    await store.enable(task.id)
  } else if (task.op === 'disable') {
    await store.disable(task.id, 'manual')
  } else if (task.op === 'refresh') {
    // The provider hands back the task's credential, and its identity when
    // the task names one.
    const next = task.credential as { refresh: string; access?: string }
    await store.refresh(task.id, async () => ({
      access: next.access ?? `access-${next.refresh}`,
      refresh: next.refresh,
      expires: 4_000_000_000_000,
      ...identity,
    }))
  } else if (task.op === 'reorder') {
    await store.reorder(task.ids ?? [])
  } else if (task.op === 'addMany') {
    for (let index = 0; index < (task.count ?? 1); index++) {
      await store.add({
        id: `${task.id}-${index}`,
        credential: {
          type: 'oauth',
          refresh: `${task.id}-refresh-${index}`,
        },
      })
    }
  }
  console.log('done')
  process.exit(0)
} catch (error) {
  console.log(`failed:${(error as { kind?: string }).kind ?? String(error)}`)
  process.exit(1)
}
