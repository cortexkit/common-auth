import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import * as api from '@cortexkit/private-files'
import {
  setPrivateFilesBackendForTest,
  writePrivateAtomic,
} from '../../dist/fs/private-files.js'
import { LockStack, POOL_LOCK_DEFAULTS } from '../../dist/store/refresh-lock.js'

assert.equal(
  process.platform,
  'win32',
  'Timing requires real Windows native IO',
)
assert.ok(process.env.LOCALAPPDATA, 'Timing requires a real Windows profile')
console.log(
  JSON.stringify({
    runtime: process.version,
    bun: globalThis.Bun?.version,
    platform: process.platform,
    arch: process.arch,
    iterations: 10,
    lockCounts: [1, 2, 3],
  }),
)

const root = join(
  process.env.LOCALAPPDATA,
  `common-publish-timing-${randomUUID()}`,
)
await api.createOwnerOnly(root, { kind: 'dir' })
let sample
let lockIndex
const backend = { ...api }
const methods = [
  'verifySafeParent',
  'verifyOwnerOnly',
  'verifyPrivatePath',
  'readOwnerOnly',
]
// Wrap the real backend without replacing its IO or security checks. Record only
// calls inside the ownership fence, not acquisition, staging or post-write checks.
setPrivateFilesBackendForTest({
  ...api,
  ...Object.fromEntries(
    methods.map((method) => [
      method,
      async (...args) => {
        const current = sample
        const started = performance.now()
        try {
          return await backend[method](...args)
        } finally {
          current?.steps.push({
            lock: lockIndex,
            step: method,
            durationMs: performance.now() - started,
          })
        }
      },
    ]),
  ),
})

try {
  for (const lockCount of [1, 2, 3]) {
    // Disable renewal so unrelated timer IO cannot enter the measured fence.
    const locks = new LockStack(
      { ...POOL_LOCK_DEFAULTS, ttlMs: 300_000, renew: false },
      {},
    )
    try {
      for (let index = 0; index < lockCount; index++) {
        const held = await locks.acquire({
          path: join(root, `lock-${lockCount}-${index}`),
          name: 'pool-config',
        })
        const assertOwned = held.assertOwned.bind(held)
        held.assertOwned = async () => {
          lockIndex = index
          const current = sample
          const started = performance.now()
          try {
            await assertOwned()
          } finally {
            current?.locks.push({
              lock: index,
              durationMs: performance.now() - started,
            })
            lockIndex = undefined
          }
        }
      }
      for (let iteration = 1; iteration <= 10; iteration++) {
        const result = { lockCount, iteration, steps: [], locks: [] }
        let outcome
        await writePrivateAtomic(join(root, `state-${lockCount}.json`), '{}', {
          // This is the store Transaction.write ownership callback, without its
          // optional test-only onStep observer: assert every held lease in order.
          beforeRename: async () => {
            assert.equal(sample, undefined)
            sample = result
            const started = performance.now()
            try {
              await locks.assertAll()
            } finally {
              result.beforeRenameMs = performance.now() - started
              sample = undefined
            }
          },
          onOutcome: (value) => {
            outcome = value
          },
        })
        assert.equal(outcome.published, true)
        assert.equal(outcome.attempts, 1)
        assert.equal(result.locks.length, lockCount)
        for (const method of methods) {
          assert.equal(
            result.steps.filter((step) => step.step === method).length,
            lockCount,
            `Expected one ${method} per held lease`,
          )
        }
        const nativeMs = result.steps.reduce(
          (total, step) => total + step.durationMs,
          0,
        )
        console.log(
          JSON.stringify({
            ...result,
            nativeMs,
            otherMs: result.beforeRenameMs - nativeMs,
          }),
        )
      }
    } finally {
      await locks.releaseAll()
    }
  }
  console.log(
    '30 measured publications passed; each renamed on its first attempt',
  )
} finally {
  setPrivateFilesBackendForTest()
  await rm(root, { recursive: true, force: true })
}
