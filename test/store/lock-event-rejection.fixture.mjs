// Both runtimes exercise built JavaScript so Node and Bun observe the same delivery code.
import assert from 'node:assert/strict'
import { setImmediate as yieldTurn } from 'node:timers/promises'
import { acquireRefreshFileLock } from '../../dist/fs/refresh-file-lock.js'
import {
  acquirePoolLock,
  POOL_LOCK_DEFAULTS,
} from '../../dist/store/refresh-lock.js'

const [seam, rejectedKind, path] = process.argv.slice(2)
const spec = { name: 'rejected-observer', path }
const holder = await acquireRefreshFileLock({
  ...spec,
  ttlMs: 60_000,
  renew: false,
})
assert.ok(holder)
const events = []
let acquired
try {
  if (seam === 'store') {
    let resolveRefusal
    const refused = new Promise((resolve) => {
      resolveRefusal = resolve
    })
    const contender = acquirePoolLock(
      spec,
      { ...POOL_LOCK_DEFAULTS, renew: false },
      {
        now: Date.now,
        onLockEvent: (event) => {
          events.push(event.type)
          if (event.type === 'contended') resolveRefusal()
          if (event.type === rejectedKind)
            return Promise.reject(new Error(`observer rejected ${event.type}`))
        },
      },
    )
    await refused
    await holder.release()
    acquired = await contender
    await acquired.release()
    assert.ok(events.includes('contended'))
    assert.deepEqual(events.slice(-2), ['acquired', 'released'])
  } else {
    const refused = await acquireRefreshFileLock({
      ...spec,
      ttlMs: 60_000,
      renew: false,
      onContended: () => {
        events.push('contended')
        return Promise.reject(new Error('observer rejected fs contended'))
      },
    })
    assert.equal(refused, null)
    await holder.release()
    acquired = await acquireRefreshFileLock({
      ...spec,
      ttlMs: 60_000,
      renew: false,
    })
    assert.ok(acquired)
    await acquired.release()
    assert.deepEqual(events, ['contended'])
  }
  const next = await acquireRefreshFileLock({
    ...spec,
    ttlMs: 60_000,
    renew: false,
  })
  assert.ok(next)
  await next.release()
  // A rejected observer must stay harmless after the runtime processes promise rejections.
  await yieldTurn()
  console.log(
    JSON.stringify({
      seam,
      rejectedKind,
      acquiredAndReleased: true,
      reacquired: true,
      events,
    }),
  )
} finally {
  await acquired?.release()
  await holder.release()
}
