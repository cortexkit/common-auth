// A second process for crash and cross-process rows. It runs one store
// operation described by its JSON argument, prints `step:<name>` at each
// named write step, and exits with CRASH_EXIT_CODE when it reaches `exitAt`,
// so the observing test process survives the crash.
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
  /** Lease length of every lock the child takes; 1 s unless given. */
  ttlMs?: number
  /**
   * Renew the child's leases while it runs (off unless given). A crashed
   * child stops renewing, so its leases still lapse one lease length later;
   * a live child on a loaded machine no longer loses them mid-operation.
   */
  renew?: boolean
}

const task = JSON.parse(process.argv[2] ?? '{}') as Task
const store = openPoolStore({
  provider: 'openai',
  configPath: task.configPath,
  statePath: task.statePath,
  quota: listCodec,
  ...(task.providerState !== undefined
    ? { providerState: objectStateCodec }
    : {}),
  // A crashed child leaves its leases behind; short unrenewed leases let the
  // surviving process take the locks over within a test's time budget.
  lockOptions: { ttlMs: task.ttlMs ?? 1_000, renew: task.renew ?? false },
  onStep: (step) => {
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
