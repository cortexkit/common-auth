import { mock } from 'bun:test'
import * as filesystem from '../../src/fs/index.js'

const [path, account = '0', start = '0'] = process.argv.slice(2)
if (!path) throw new Error('roster path required')
let acquisitions = 0
let dropped = 0
let retries = 0
const realWithLock = filesystem.withLock
// Count entry into the real filesystem lock, not calls that merely enqueue.
mock.module('../../src/fs/index.js', () => ({
  ...filesystem,
  withLock: (
    target: string,
    options: filesystem.LockOptions,
    fn: (lock: { assertOwned(): Promise<void> }) => Promise<unknown>,
  ) =>
    realWithLock(target, options, async (lock) => {
      if (options.name === 'claustrum-roster-write') acquisitions++
      return fn(lock)
    }),
}))
mock.module('../../src/logger/index.js', () => ({
  createLogger: () => ({
    warn: () => retries++,
    debug: () => {},
    info: () => {},
  }),
}))
const roster = await import('../../src/claustrum/roster.js')
const pending: Promise<unknown>[] = []
let readings = 0
await Bun.sleep(Math.max(0, Number(start) - Date.now()))
const until = performance.now() + 2_000
do {
  readings++
  pending.push(
    roster
      .recordVaultQuota(path, {
        routeId: `vault:${account}`,
        credentialId: `credential:${account}`,
        accountIdentity: account,
        accountIdentitySource: 'asserted',
        observation: {
          checkedAt: readings,
          readings: [{ label: 'primary', usedPercent: readings }],
        },
      })
      .catch(() => {
        dropped++
      }),
  )
  await Bun.sleep(5)
} while (performance.now() < until)
await Promise.all(pending)
// Implementations without a detached writer have no shutdown drain to await.
const drain = (
  roster as typeof roster & {
    drainVaultQuota?: (path: string, timeoutMs?: number) => Promise<void>
  }
).drainVaultQuota
await drain?.(path, 10_000)
console.log(
  JSON.stringify({ account, readings, acquisitions, dropped, retries }),
)
