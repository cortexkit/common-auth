import { readFileSync } from 'node:fs'
import {
  type AddInput,
  openPoolStore,
  type PublishPlan,
} from '../../src/store/index.js'

const [configPath, statePath, operation, encoded] = process.argv.slice(2)
if (!configPath || !statePath || !encoded)
  throw new Error('missing child arguments')
const store = openPoolStore({
  provider: 'test',
  configPath,
  statePath,
  quota: { validate: () => true, merge: (_prior, next) => next },
  providerState: {
    validate: () => true,
    credentialBound: (value) => (value as { bound: unknown }).bound,
  },
  requireCredentialStamps: true,
  lockOptions: { retryMs: 1 },
  onLockEvent: (event) => {
    if (event.type !== 'acquired') return
    const path = `${event.path}.${event.name}.lock`
    const record = JSON.parse(readFileSync(path, 'utf8'))
    console.log(`lease:${JSON.stringify({ path, ownerId: record.ownerId })}`)
  },
  onStep: (step, info) => {
    if (
      (operation === 'add' &&
        info.operation === 'add' &&
        step === 'after-state-write') ||
      (operation === 'publish' &&
        info.operation === 'publishRoster' &&
        step === 'after-config-write')
    ) {
      console.log(`crash:${step}`)
      process.exit(17)
    }
  },
})
if (operation === 'add')
  await store.add(JSON.parse(encoded) as AddInput, {
    onExisting: 'stage-duplicate',
  })
else await store.publishRoster(JSON.parse(encoded) as PublishPlan)
