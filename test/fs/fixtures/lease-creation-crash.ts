import {
  acquireRefreshFileLock,
  setLeaseCreationTestHooksForTest,
} from '../../../src/fs/refresh-file-lock.js'

const path = process.argv[2]
if (!path) throw new Error('Expected a scratch path for the lease')
const crash = () => process.exit(73)
setLeaseCreationTestHooksForTest(
  process.argv[3] === 'before-link'
    ? { beforeLink: crash }
    : { beforeWrite: crash },
)
await acquireRefreshFileLock({
  path,
  name: 'creation-crash',
  ttlMs: 10_000,
})
throw new Error('Expected to exit during lease creation')
