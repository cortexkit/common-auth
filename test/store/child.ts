// A second process for crash and cross-process rows. It runs one store
// operation described by its JSON argument, prints `step:<name>` at each
// named write step, and exits with CRASH_EXIT_CODE when it reaches `exitAt`,
// so the observing test process survives the crash.
import {
  openPoolStore,
  type PoolCredential,
  type WriteStep,
} from '../../src/store/index.js'
import { CRASH_EXIT_CODE, listCodec } from './helpers.js'

type Task = {
  configPath: string
  statePath: string
  op: 'add' | 'replace' | 'rotate' | 'remove' | 'reorder' | 'addMany'
  id: string
  ids?: string[]
  credential?: PoolCredential
  identity?: string
  count?: number
  exitAt?: WriteStep
}

const task = JSON.parse(process.argv[2] ?? '{}') as Task
const store = openPoolStore({
  provider: 'openai',
  configPath: task.configPath,
  statePath: task.statePath,
  quota: listCodec,
  // A crashed child leaves its leases behind; short unrenewed leases let the
  // surviving process take the locks over within a test's time budget.
  lockOptions: { ttlMs: 1_000, renew: false },
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
    })
  } else if (task.op === 'replace') {
    await store.replace(task.id, task.credential as PoolCredential, identity)
  } else if (task.op === 'rotate') {
    await store.rotate(task.id, task.credential as PoolCredential, identity)
  } else if (task.op === 'remove') {
    await store.remove(task.id)
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
