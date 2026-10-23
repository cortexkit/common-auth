import { quotaCodec } from '../../src/quota/index.js'
import { openPoolStore } from '../../src/store/index.js'

const [configPath, statePath, mode, account] = process.argv.slice(2)
if (!configPath || !statePath || !account)
  throw new Error('missing pool arguments')
let acquisitions = 0
let retries = 0
const store = openPoolStore({
  provider: 'openai',
  configPath,
  statePath,
  quota: quotaCodec,
  coalesceQuota: mode === 'coalesced',
  quotaDrainTimeoutMs: 5_000,
  lockOptions: { timeoutMs: 25, retryMs: 2 },
  onLockEvent: (event) => {
    if (event.type === 'acquired' && event.path === configPath) acquisitions++
  },
  onStep: async (step) => {
    if (step === 'before-config-write') await Bun.sleep(5)
  },
  logger: {
    warn: (message) => {
      if (message === 'pool quota publication delayed; retrying') {
        retries++
        console.log(JSON.stringify({ type: 'retry' }))
      } else throw new Error(message)
    },
  },
})
const readings = 120
let accepted = 0
let timeouts = 0
await Promise.all(
  Array.from({ length: readings }, async (_, index) => {
    try {
      await store.recordQuota(
        'a',
        { credentialEpoch: 1 },
        {
          checkedAt: index + 1,
          readings: [{ label: `${account}:${index}`, usedPercent: index }],
          counters: { [account]: { checkedAt: index + 1, value: index + 1 } },
        },
      )
      accepted++
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'kind' in error &&
        error.kind === 'lock-contention'
      )
        timeouts++
      else throw error
    }
  }),
)
console.log(JSON.stringify({ type: 'queued', readings, accepted, timeouts }))
await new Promise<void>((resolve) =>
  process.stdin.once('data', () => resolve()),
)
await store.dispose()
console.log(JSON.stringify({ type: 'done', acquisitions, retries }))
