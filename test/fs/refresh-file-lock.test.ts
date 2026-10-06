import { beforeEach, describe, expect } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  acquireRefreshFileLock as acquireRawRefreshFileLock,
  LockOwnershipError,
} from '../../src/fs/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { observed } from '../fixtures/observed.js'
import { phaseClock } from '../fixtures/phase-clock.js'
import { makeTempDir } from '../fixtures/scratch.js'

const hooks = lifetimeHooks()
const { afterEach, it } = hooks
const acquireRefreshFileLock: typeof acquireRawRefreshFileLock = async (
  ...args
) => {
  const lifetime = hooks.lifetime
  const lock = await lifetime.operation(acquireRawRefreshFileLock(...args))
  if (lock) {
    lifetime.finish(() => lock.release())
    // whenLost() intentionally remains pending after a normal release. Join
    // release itself, not that subscription, before deleting the directory.
    return lock
  }
  return lock
}

let dir: string

beforeEach(async () => {
  dir = await makeTempDir('refresh-file-lock-')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

async function resolvesWithin(promise: Promise<void>, ms: number) {
  return await Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), ms)),
  ])
}

async function readLockOwner(lockPath: string) {
  return JSON.parse(await readFile(lockPath, 'utf8')) as {
    ownerId: string
    expiresAt: number
  }
}

describe('acquireRefreshFileLock', () => {
  it('observes takeover on the next renewal and stops renewing', async () => {
    const path = join(dir, 'observed.json')
    const lockPath = `${path}.observed.lock`
    const tick = deferred()
    let ticks = 0
    const lock = (await acquireRefreshFileLock({
      path,
      name: 'observed',
      ttlMs: 10_000,
      renew: true,
      renewIntervalMs: 20,
      onStep: (step) => {
        if (step === 'renewal-finished') {
          ticks++
          tick.resolve()
        }
      },
    }))!
    try {
      expect(lock.ownerId).toBe((await readLockOwner(lockPath)).ownerId)
      await observed(hooks.lifetime, tick.promise)
      expect(lock.hasLost()).toBe(false)
      const successor = { ownerId: 'successor', expiresAt: Date.now() + 10_000 }
      await writeFile(lockPath, JSON.stringify(successor))
      const loss = await observed(hooks.lifetime, lock.whenLost())
      expect(loss).toMatchObject({
        reason: 'taken-over',
        expectedOwnerId: lock.ownerId,
        observedOwnerId: 'successor',
        observedExpiresAt: successor.expiresAt,
      })
      expect(lock.hasLost()).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 50))
      const stoppedTicks = ticks
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(ticks).toBe(stoppedTicks)
      await writeFile(
        lockPath,
        JSON.stringify({
          ownerId: lock.ownerId,
          expiresAt: Date.now() + 10_000,
        }),
      )
      await expect(lock.assertOwned()).rejects.toBeInstanceOf(
        LockOwnershipError,
      )
      expect(await lock.whenLost()).toBe(loss)
      await writeFile(lockPath, JSON.stringify(successor))
      await lock.release()
      await lock.release()
      expect(await readLockOwner(lockPath)).toEqual(successor)
    } finally {
      await lock.release()
    }
  })

  it('assertOwned observes takeover with ownership details without renewal', async () => {
    const path = join(dir, 'assert-observed.json')
    const lock = (await acquireRefreshFileLock({
      path,
      name: 'assert',
      ttlMs: 10_000,
    }))!
    const successor = {
      ownerId: 'assert-successor',
      expiresAt: Date.now() + 10_000,
    }
    await writeFile(`${path}.assert.lock`, JSON.stringify(successor))
    try {
      await lock.assertOwned()
      throw new Error('assertOwned accepted takeover')
    } catch (error) {
      expect(error).toBeInstanceOf(LockOwnershipError)
      expect((error as LockOwnershipError).message).toBe(
        `Lost assert lock for ${path}`,
      )
      expect((error as LockOwnershipError).details).toMatchObject({
        expectedOwnerId: lock.ownerId,
        observedOwnerId: successor.ownerId,
        observedExpiresAt: successor.expiresAt,
      })
    }
    expect((await observed(hooks.lifetime, lock.whenLost())).reason).toBe(
      'taken-over',
    )
    expect(lock.hasLost()).toBe(true)
    await lock.release()
    await lock.release()
    expect(await readLockOwner(`${path}.assert.lock`)).toEqual(successor)
  })

  it('assertion loss cancels a pending renewal timer', async () => {
    const path = join(dir, 'cancel-timer.json')
    let ticks = 0
    const lock = (await acquireRefreshFileLock({
      path,
      name: 'cancel',
      ttlMs: 10_000,
      renew: true,
      renewIntervalMs: 50,
      onStep: (step) => {
        if (step === 'renewal-finished') ticks++
      },
    }))!
    try {
      await writeFile(
        `${path}.cancel.lock`,
        JSON.stringify({
          ownerId: 'successor',
          expiresAt: Date.now() + 10_000,
        }),
      )
      await expect(lock.assertOwned()).rejects.toBeInstanceOf(
        LockOwnershipError,
      )
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(ticks).toBe(0)
    } finally {
      await lock.release()
    }
  })

  it('assertion loss fences an already in-flight renewal', async () => {
    for (const seam of [
      'renewal-owner-confirmed',
      'renewal-write-fenced',
      'renewal-write-ready',
    ] as const) {
      const path = join(dir, `inflight-loss-${seam}.json`)
      const paused = deferred()
      const resume = deferred()
      const finished = deferred()
      const lock = (await acquireRefreshFileLock({
        path,
        name: 'inflight',
        ttlMs: 10_000,
        renew: true,
        renewIntervalMs: 10,
        onStep: async (step) => {
          if (step === seam) {
            paused.resolve()
            await resume.promise
          }
          if (step === 'renewal-finished') finished.resolve()
        },
      }))!
      try {
        await observed(hooks.lifetime, paused.promise)
        const successor = {
          ownerId: 'successor',
          expiresAt: Date.now() + 10_000,
        }
        await writeFile(`${path}.inflight.lock`, JSON.stringify(successor))
        await expect(lock.assertOwned()).rejects.toBeInstanceOf(
          LockOwnershipError,
        )
        resume.resolve()
        await observed(hooks.lifetime, finished.promise)
        expect(await readLockOwner(`${path}.inflight.lock`)).toEqual(successor)
      } finally {
        resume.resolve()
        await lock.release()
      }
    }
  })

  it('assertOwned observes unreadable ownership', async () => {
    const path = join(dir, 'unreadable.json')
    const lock = (await acquireRefreshFileLock({
      path,
      name: 'unreadable',
      ttlMs: 10_000,
    }))!
    await writeFile(`${path}.unreadable.lock`, 'invalid json')
    await expect(lock.assertOwned()).rejects.toBeInstanceOf(LockOwnershipError)
    expect((await observed(hooks.lifetime, lock.whenLost())).reason).toBe(
      'unreadable',
    )
    expect(lock.hasLost()).toBe(true)
    await lock.release()
  })

  it('owner release is idempotent and leaves the loss promise pending', async () => {
    const path = join(dir, 'released.json')
    const lock = (await acquireRefreshFileLock({
      path,
      name: 'released',
      ttlMs: 10_000,
    }))!
    let lost = false
    void lock.whenLost().then(() => {
      lost = true
    })
    await lock.release()
    await lock.release()
    await expect(lock.assertOwned()).rejects.toBeInstanceOf(LockOwnershipError)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(lock.hasLost()).toBe(false)
    expect(lost).toBe(false)
    expect(existsSync(`${path}.released.lock`)).toBe(false)
  })

  it('observes terminal renewal failure when the owner file becomes unreadable', async () => {
    const path = join(dir, 'failed.json')
    const lockPath = `${path}.failed.lock`
    const lock = (await acquireRefreshFileLock({
      path,
      name: 'failed',
      ttlMs: 10_000,
      renew: true,
      renewIntervalMs: 20,
    }))!
    try {
      await writeFile(lockPath, 'invalid json')
      expect((await observed(hooks.lifetime, lock.whenLost())).reason).toBe(
        'renewal-failed',
      )
      expect(lock.hasLost()).toBe(true)
      await expect(lock.assertOwned()).rejects.toBeInstanceOf(
        LockOwnershipError,
      )
    } finally {
      await lock.release()
    }
  })

  it('renewal errors stop immediately when ownership cannot remain live', async () => {
    for (const reason of ['taken-over', 'expired'] as const) {
      const path = join(dir, `error-${reason}.json`)
      const finished = deferred()
      const lock = (await acquireRefreshFileLock({
        path,
        name: 'error',
        ttlMs: 10_000,
        renew: true,
        renewIntervalMs: 50,
        onStep: async (step) => {
          if (step === 'renewal-owner-confirmed') {
            const owner = await readLockOwner(`${path}.error.lock`)
            await writeFile(
              `${path}.error.lock`,
              JSON.stringify(
                reason === 'taken-over'
                  ? { ...owner, ownerId: 'successor' }
                  : { ...owner, expiresAt: 0 },
              ),
            )
            throw new Error('renewal failed after ownership changed')
          }
          if (step === 'renewal-finished') finished.resolve()
        },
      }))!
      try {
        await observed(hooks.lifetime, finished.promise)
        expect(lock.hasLost()).toBe(true)
        expect((await observed(hooks.lifetime, lock.whenLost())).reason).toBe(
          reason,
        )
      } finally {
        await lock.release()
      }
    }
  })

  it('observes expiry when renewal cannot extend an expired lease', async () => {
    const path = join(dir, 'expired.json')
    let now = 100
    const lock = (await acquireRefreshFileLock({
      path,
      name: 'expired',
      ttlMs: 10,
      now: () => now,
      renew: true,
      renewIntervalMs: 20,
    }))!
    try {
      now = 111
      expect((await observed(hooks.lifetime, lock.whenLost())).reason).toBe(
        'expired',
      )
      expect(lock.hasLost()).toBe(true)
    } finally {
      await lock.release()
    }
  })
  it('creates a missing parent directory before acquiring the lock', async () => {
    const path = join(dir, 'missing-sub', 'state.json')
    const lockPath = `${path}.missing-parent.lock`

    const lock = await acquireRefreshFileLock({
      name: 'missing-parent',
      path,
      ttlMs: 5_000,
    })

    expect(lock).not.toBeNull()
    expect(existsSync(lockPath)).toBe(true)

    await lock?.release()
    expect(existsSync(lockPath)).toBe(false)
  })

  it('allows only one contender when the parent directory is missing', async () => {
    const path = join(dir, 'missing-race', 'state.json')
    const options = {
      name: 'missing-parent-contention',
      path,
      ttlMs: 5_000,
    }

    const contenders = await Promise.all([
      acquireRefreshFileLock(options),
      acquireRefreshFileLock(options),
    ])
    const winners = contenders.filter((lock) => lock !== null)

    expect(winners).toHaveLength(1)

    await winners[0]?.release()
    const retry = await acquireRefreshFileLock(options)
    expect(retry).not.toBeNull()
    await retry?.release()
  })

  it('does not let a stalled renewal overwrite a successor that stole its marker', async () => {
    const path = join(dir, 'renewal-race.json')
    const name = 'renewal-race'
    const lockPath = `${path}.${name}.lock`
    const renewalConfirmed = deferred()
    const releaseRenewal = deferred()
    hooks.lifetime.unpark(() => releaseRenewal.resolve())
    const renewalFinished = deferred()
    const start = Date.now()
    let currentNow = start

    const first = await acquireRefreshFileLock({
      name,
      path,
      ttlMs: 100,
      now: () => currentNow,
      renew: true,
      renewIntervalMs: 1,
      onStep: async (step) => {
        if (step === 'renewal-owner-confirmed') {
          renewalConfirmed.resolve()
          await releaseRenewal.promise
        }
        if (step === 'renewal-finished') renewalFinished.resolve()
      },
    })
    expect(first).not.toBeNull()

    await observed(hooks.lifetime, renewalConfirmed.promise)
    currentNow = start + 10_000
    const successor = await acquireRefreshFileLock({
      name,
      path,
      ttlMs: 100,
      now: () => currentNow,
    })
    expect(successor).not.toBeNull()
    const successorOwner = await readLockOwner(lockPath)

    releaseRenewal.resolve()
    await observed(hooks.lifetime, renewalFinished.promise)

    expect(await readLockOwner(lockPath)).toEqual(successorOwner)
    await first?.release()
    await successor?.release()
  })

  it('does not let a stalled release remove a successor that stole its marker', async () => {
    const path = join(dir, 'release-race.json')
    const name = 'release-race'
    const lockPath = `${path}.${name}.lock`
    const releaseConfirmed = deferred()
    const releaseRemoval = deferred()
    hooks.lifetime.unpark(() => releaseRemoval.resolve())
    const start = Date.now()
    let currentNow = start

    const first = await acquireRefreshFileLock({
      name,
      path,
      ttlMs: 100,
      now: () => currentNow,
      onStep: async (step) => {
        if (step === 'release-owner-confirmed') {
          releaseConfirmed.resolve()
          await releaseRemoval.promise
        }
      },
    })
    expect(first).not.toBeNull()

    const firstRelease = first!.release()
    await observed(hooks.lifetime, releaseConfirmed.promise)
    currentNow = start + 10_000
    const successor = await acquireRefreshFileLock({
      name,
      path,
      ttlMs: 100,
      now: () => currentNow,
    })
    expect(successor).not.toBeNull()
    const successorOwner = await readLockOwner(lockPath)

    releaseRemoval.resolve()
    await firstRelease

    expect(existsSync(lockPath)).toBe(true)
    expect(await readLockOwner(lockPath)).toEqual(successorOwner)
    await successor?.release()
  })

  it('waits for an in-flight renewal before release can remove the lock', async () => {
    const path = join(dir, 'release-renewal-race.json')
    const name = 'release-renewal-race'
    const lockPath = `${path}.${name}.lock`
    const renewalWriteFenced = deferred()
    const releaseRenewal = deferred()
    hooks.lifetime.unpark(() => releaseRenewal.resolve())
    const renewalFinished = deferred()
    const currentNow = Date.now()

    const first = await acquireRefreshFileLock({
      name,
      path,
      ttlMs: 100,
      now: () => currentNow,
      renew: true,
      renewIntervalMs: 1,
      onStep: async (step) => {
        if (step === 'renewal-write-fenced') {
          renewalWriteFenced.resolve()
          await releaseRenewal.promise
        }
        if (step === 'renewal-finished') renewalFinished.resolve()
      },
    })
    expect(first).not.toBeNull()

    await observed(hooks.lifetime, renewalWriteFenced.promise)
    const release = first!.release()
    expect(await resolvesWithin(release, 50)).toBe(false)
    releaseRenewal.resolve()
    await observed(hooks.lifetime, renewalFinished.promise)
    await release

    expect(existsSync(lockPath)).toBe(false)
  })

  it('re-checks ownership after the renewal write seam before writing', async () => {
    const path = join(dir, 'renewal-write-seam-race.json')
    const name = 'renewal-write-seam-race'
    const lockPath = `${path}.${name}.lock`
    const renewalWriteFenced = deferred()
    const releaseRenewal = deferred()
    hooks.lifetime.unpark(() => releaseRenewal.resolve())
    const renewalFinished = deferred()
    const start = Date.now()
    let currentNow = start

    const first = await acquireRefreshFileLock({
      name,
      path,
      ttlMs: 100,
      now: () => currentNow,
      renew: true,
      renewIntervalMs: 1,
      onStep: async (step) => {
        if (step === 'renewal-write-fenced') {
          renewalWriteFenced.resolve()
          await releaseRenewal.promise
        }
        if (step === 'renewal-finished') renewalFinished.resolve()
      },
    })
    expect(first).not.toBeNull()

    await observed(hooks.lifetime, renewalWriteFenced.promise)
    currentNow = start + 10_000
    const successor = await acquireRefreshFileLock({
      name,
      path,
      ttlMs: 100,
      now: () => currentNow,
    })
    expect(successor).not.toBeNull()
    const successorOwner = await readLockOwner(lockPath)

    releaseRenewal.resolve()
    await observed(hooks.lifetime, renewalFinished.promise)

    expect(await readLockOwner(lockPath)).toEqual(successorOwner)
    await first?.release()
    await successor?.release()
  })

  it('relinquishes the lock when its marker is stolen after the final renewal check', async () => {
    const path = join(dir, 'renewal-post-write-race.json')
    const name = 'renewal-post-write-race'
    const lockPath = `${path}.${name}.lock`
    const renewalWriteReady = deferred()
    const releaseRenewal = deferred()
    hooks.lifetime.unpark(() => releaseRenewal.resolve())
    const renewalFinished = deferred()
    const start = Date.now()
    let currentNow = start

    const first = await acquireRefreshFileLock({
      name,
      path,
      ttlMs: 100,
      now: () => currentNow,
      renew: true,
      renewIntervalMs: 1,
      onStep: async (step) => {
        if (step === 'renewal-write-ready') {
          renewalWriteReady.resolve()
          await releaseRenewal.promise
        }
        if (step === 'renewal-finished') renewalFinished.resolve()
      },
    })
    expect(first).not.toBeNull()

    await observed(hooks.lifetime, renewalWriteReady.promise)
    currentNow = start + 10_000
    const successor = await acquireRefreshFileLock({
      name,
      path,
      ttlMs: 100,
      now: () => currentNow,
    })
    expect(successor).not.toBeNull()

    releaseRenewal.resolve()
    await observed(hooks.lifetime, renewalFinished.promise)

    expect(existsSync(lockPath)).toBe(false)
    expect((await observed(hooks.lifetime, first!.whenLost())).reason).toBe(
      'marker-lost',
    )
    expect(first!.hasLost()).toBe(true)
    await first?.release()
    await successor?.release()
  })

  it('preserves a successor record during post-write relinquish', async () => {
    const path = join(dir, 'renewal-relinquish-successor.json')
    const name = 'renewal-relinquish-successor'
    const lockPath = `${path}.${name}.lock`
    const renewalWriteReady = deferred()
    const relinquishRead = deferred()
    const allowRelinquishRead = deferred()
    hooks.lifetime.unpark(() => allowRelinquishRead.resolve())
    const releaseRenewal = deferred()
    hooks.lifetime.unpark(() => releaseRenewal.resolve())
    const renewalFinished = deferred()
    const start = Date.now()
    let currentNow = start

    const first = await acquireRefreshFileLock({
      name,
      path,
      ttlMs: 100,
      now: () => currentNow,
      renew: true,
      renewIntervalMs: 1,
      onStep: async (step) => {
        if (step === 'renewal-write-ready') {
          renewalWriteReady.resolve()
          await releaseRenewal.promise
        }
        if (step === 'relinquish-read') {
          relinquishRead.resolve()
          await allowRelinquishRead.promise
        }
        if (step === 'renewal-finished') renewalFinished.resolve()
      },
    })
    expect(first).not.toBeNull()

    await observed(hooks.lifetime, renewalWriteReady.promise)
    currentNow = start + 10_000
    const successor = await acquireRefreshFileLock({
      name,
      path,
      ttlMs: 100,
      now: () => currentNow,
    })
    expect(successor).not.toBeNull()
    const successorOwner = await readLockOwner(lockPath)

    releaseRenewal.resolve()
    await observed(hooks.lifetime, relinquishRead.promise)
    await writeFile(lockPath, `${JSON.stringify(successorOwner)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    allowRelinquishRead.resolve()
    await observed(hooks.lifetime, renewalFinished.promise)

    expect(existsSync(lockPath)).toBe(true)
    expect(await readLockOwner(lockPath)).toEqual(successorOwner)
    await first?.release()
    await successor?.release()
  })

  it('reschedules after marker contention and advances the lease', async () => {
    const path = join(dir, 'renewal-contention.json')
    const name = 'renewal-contention'
    const lockPath = `${path}.${name}.lock`
    const markerPath = `${lockPath}.evicting`
    const markerUnavailable = deferred()
    const renewed = deferred()
    const start = Date.now()
    let currentNow = start
    let sawRenewalWrite = false
    let planted = false
    let before: Awaited<ReturnType<typeof readLockOwner>>
    const lock = await acquireRefreshFileLock({
      name,
      path,
      ttlMs: 10_000,
      now: () => currentNow,
      renew: true,
      renewIntervalMs: 10,
      onStep: async (step) => {
        if (step === 'renewal-marker-unavailable') {
          markerUnavailable.resolve()
          currentNow = start + 100
          await rm(markerPath, { recursive: true, force: true })
        }
        if (step === 'renewal-write-fenced') sawRenewalWrite = true
        if (step !== 'renewal-finished') return
        if (!planted) {
          // Renewal has released its marker and cannot schedule its next
          // attempt until this observer returns. Plant contention in that gap.
          before = await readLockOwner(lockPath)
          await mkdir(markerPath)
          planted = true
          sawRenewalWrite = false
        } else if (sawRenewalWrite) renewed.resolve()
      },
    })
    expect(lock).not.toBeNull()
    let lossObserved = false
    void lock!.whenLost().then(() => {
      lossObserved = true
    })
    try {
      await markerUnavailable.promise
      await renewed.promise
      const after = await readLockOwner(lockPath)
      expect(after.ownerId).toBe(before!.ownerId)
      expect(after.expiresAt).toBeGreaterThan(before!.expiresAt)
      expect(lock!.hasLost()).toBe(false)
    } finally {
      await lock?.release()
    }
    expect(lossObserved).toBe(false)
  })

  it('reschedules after a renewal marker failure throws', async () => {
    const path = join(dir, 'renewal-throw.json')
    const name = 'renewal-throw'
    const lockPath = `${path}.${name}.lock`
    const injectedFailure = deferred()
    const renewed = deferred()
    const start = Date.now()
    let currentNow = start
    let injected = false
    let sawRenewalWrite = false

    const lock = await acquireRefreshFileLock({
      name,
      path,
      ttlMs: 10_000,
      now: () => currentNow,
      renew: true,
      renewIntervalMs: 10,
      onStep: (step) => {
        if (step === 'renewal-owner-confirmed' && !injected) {
          injected = true
          injectedFailure.resolve()
          throw new Error('injected renewal marker failure')
        }
        if (step === 'renewal-write-fenced') sawRenewalWrite = true
        if (step === 'renewal-finished' && sawRenewalWrite) renewed.resolve()
      },
    })
    expect(lock).not.toBeNull()
    const before = await readLockOwner(lockPath)

    await observed(hooks.lifetime, injectedFailure.promise)
    currentNow = start + 100
    await observed(hooks.lifetime, renewed.promise)

    const after = await readLockOwner(lockPath)
    expect(after.ownerId).toBe(before.ownerId)
    expect(after.expiresAt).toBeGreaterThan(before.expiresAt)
    expect(lock!.hasLost()).toBe(false)
    let lossObserved = false
    void lock!.whenLost().then(() => {
      lossObserved = true
    })
    await lock?.release()
    expect(lossObserved).toBe(false)
  })

  it('retries release after recovering a stale marker', async () => {
    const path = join(dir, 'release-stale-marker.json')
    const name = 'release-stale-marker'
    const lockPath = `${path}.${name}.lock`
    const markerPath = `${lockPath}.evicting`
    const lock = await acquireRefreshFileLock({ name, path, ttlMs: 10_000 })
    expect(lock).not.toBeNull()

    await mkdir(markerPath)
    await writeFile(
      join(markerPath, 'owner.json'),
      `${JSON.stringify({ ownerId: 'stale-marker', createdAt: 0 })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
    const staleAt = new Date(Date.now() - 10_000)
    await utimes(markerPath, staleAt, staleAt)

    await lock?.release()

    expect(existsSync(lockPath)).toBe(false)
  })

  it('elects one owner across 512 plain stale-lock contentions', async () => {
    // The callback tests above pause specific renewal and release races;
    // this test checks that simultaneous stale-lock attempts elect one owner.
    const path = join(dir, 'plain-contention.json')
    const name = 'plain-contention'
    const lockPath = `${path}.${name}.lock`

    const clock = phaseClock('Stale elections failure phases', 30_000)
    try {
      for (let round = 0; round < 512; round++) {
        clock.mark('round-start', { round })
        await writeFile(
          lockPath,
          `${JSON.stringify({ ownerId: 'stale-owner', expiresAt: 0 })}\n`,
          { encoding: 'utf8', mode: 0o600 },
        )
        const contenders = await Promise.all([
          acquireRefreshFileLock({ name, path, ttlMs: 1_000 }),
          acquireRefreshFileLock({ name, path, ttlMs: 1_000 }),
        ])
        const winners = contenders.filter((lock) => lock !== null)

        expect(winners).toHaveLength(1)
        await winners[0]?.release()
        clock.mark('round-end', { round })
      }
      clock.succeeded()
    } finally {
      clock.finish()
    }
  }, 30_000)
})
