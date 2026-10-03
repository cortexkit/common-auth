import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  acquireRefreshFileLock,
  LockOwnershipError,
  type RefreshFileLock,
  withLock,
  writeJsonAtomic,
} from '../../src/fs/index.js'
import * as v080 from '../fixtures/lock-0.8.0/reader.js'
import { makeTempDir } from '../fixtures/scratch.js'

// These tests pin one property: a holder whose lease has expired, whose
// eviction marker was taken, or which merely paused at some await, never
// changes or deletes a lease record that belongs to someone else. The real-time
// tests pause a holder long enough (over five seconds) for both its one-second
// lease and its five-second eviction marker to go stale on the wall clock, with
// no injected clock; the others jump an injected clock instead.

let dir: string

beforeEach(async () => {
  dir = await makeTempDir('lock-successor-safety-')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${ms}ms`)),
          ms,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function readLease(lockPath: string) {
  return JSON.parse(await fs.readFile(lockPath, 'utf8')) as {
    ownerId: string
    expiresAt: number
    check?: string
  }
}

/** The bytes and the file identity of the record at the lock path. */
async function snapshot(lockPath: string) {
  const [bytes, info] = await Promise.all([
    fs.readFile(lockPath, 'utf8'),
    fs.stat(lockPath),
  ])
  return { bytes, ino: info.ino }
}

/** Writes a record the way a 0.8.0 holder renews: a new file renamed over the path. */
async function renameReplace(lockPath: string, record: object) {
  const staged = `${lockPath}.test-staged`
  await fs.writeFile(staged, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  await fs.rename(staged, lockPath)
}

const STALL_MS = 5_300
const REAL_TIME_TIMEOUT = 25_000

describe('a former lock owner never displaces a successor', () => {
  it(
    'a renewal stalled before its write cannot free a successor lease to a third process',
    async () => {
      const target = join(dir, 'data.json')
      const lockPath = `${target}.probe.lock`
      const paused = deferred()
      const resumeRenewal = deferred()
      const renewalFinished = deferred()
      const successorEntered = deferred()
      const resumeSuccessor = deferred()
      let pausedOnce = false
      let successorLock: { assertOwned(): Promise<void> } | undefined
      let successorRun: Promise<string> | undefined
      let child: ReturnType<typeof Bun.spawn> | undefined
      await writeJsonAtomic(target, { counter: 0 })
      const former = (await acquireRefreshFileLock({
        path: target,
        name: 'probe',
        ttlMs: 1_000,
        renew: true,
        renewIntervalMs: 40,
        onStep: async (step) => {
          if (step === 'renewal-finished' && pausedOnce)
            renewalFinished.resolve()
          if (step === 'renewal-write-ready' && !pausedOnce) {
            pausedOnce = true
            paused.resolve()
            await resumeRenewal.promise
          }
        },
      }))!
      try {
        await withTimeout(paused.promise, 1_500)
        // Wall-clock time expires both the one-second lease and the five-second
        // eviction marker the paused renewal holds.
        await sleep(STALL_MS)
        successorRun = withLock(
          target,
          { name: 'probe', ttlMs: 60_000, timeoutMs: 1_500, renew: false },
          async (lock) => {
            successorLock = lock
            await lock.assertOwned()
            const data = JSON.parse(await fs.readFile(target, 'utf8'))
            await fs.mkdir(join(dir, 'occupied'))
            successorEntered.resolve()
            await resumeSuccessor.promise
            // The body relies on exclusion alone for its read-modify-write and
            // does not call assertOwned() again before committing, so a second
            // holder running at the same time would lose one increment.
            await writeJsonAtomic(target, { counter: data.counter + 1 })
            await fs.rm(join(dir, 'occupied'), { recursive: true })
            return 'fulfilled'
          },
        )
        void successorRun.catch(() => {})
        await withTimeout(successorEntered.promise, 1_500)
        await successorLock!.assertOwned()
        const successorLease = await snapshot(lockPath)

        resumeRenewal.resolve()
        const loss = await withTimeout(former.whenLost(), 1_500)
        expect(loss.reason).toBe('marker-lost')
        await withTimeout(renewalFinished.promise, 1_500)

        // The successor's record was neither rewritten nor removed.
        expect(await snapshot(lockPath)).toEqual(successorLease)
        await successorLock!.assertOwned()

        const fixture = fileURLToPath(
          new URL('../fixtures/lock-third-writer.ts', import.meta.url),
        )
        child = Bun.spawn([process.execPath, fixture, dir, '8000'], {
          stdout: 'pipe',
          stderr: 'pipe',
        })
        // The third process must wait: the successor still holds the lock.
        await sleep(400)
        expect(existsSync(join(dir, 'third.json'))).toBe(false)
        expect(child.exitCode).toBeNull()

        resumeSuccessor.resolve()
        expect(await withTimeout(successorRun, 1_500)).toBe('fulfilled')
        const exit = await withTimeout(child.exited, 9_000)
        expect(exit).toBe(0)
        const third = JSON.parse(
          await fs.readFile(join(dir, 'third.json'), 'utf8'),
        )
        expect(third).toEqual({ acquired: true, collision: false })
        expect(JSON.parse(await fs.readFile(target, 'utf8'))).toEqual({
          counter: 2,
        })
      } finally {
        resumeRenewal.resolve()
        resumeSuccessor.resolve()
        if (child && child.exitCode === null) {
          child.kill()
          await child.exited
        }
        if (successorRun) await successorRun.catch(() => {})
        await former.release()
      }
    },
    REAL_TIME_TIMEOUT,
  )

  it(
    'a release stalled after confirming its ownership leaves a successor lease in place',
    async () => {
      const path = join(dir, 'release-confirmed.json')
      const lockPath = `${path}.probe.lock`
      const paused = deferred()
      const resume = deferred()
      const former = (await acquireRefreshFileLock({
        path,
        name: 'probe',
        ttlMs: 1_000,
        onStep: async (step) => {
          if (step === 'release-owner-confirmed') {
            paused.resolve()
            await resume.promise
          }
        },
      }))!
      const release = former.release()
      let successor: RefreshFileLock | null = null
      try {
        await withTimeout(paused.promise, 1_500)
        await sleep(STALL_MS)
        successor = await acquireRefreshFileLock({
          path,
          name: 'probe',
          ttlMs: 60_000,
        })
        expect(successor).not.toBeNull()
        const successorLease = await snapshot(lockPath)
        resume.resolve()
        await withTimeout(release, 1_500)
        expect(await snapshot(lockPath)).toEqual(successorLease)
        await successor!.assertOwned()
      } finally {
        resume.resolve()
        await release
        await successor?.release()
      }
    },
    REAL_TIME_TIMEOUT,
  )

  it(
    'a release stalled just before it touches the lock path leaves a successor lease in place',
    async () => {
      // No callback sits between a release's last check and its first change to
      // the lock path, so this holds back that change itself: the first rm or
      // rename of the lock path after release starts waits until the successor
      // holds the lock, as it would if the releasing process stopped running
      // right after its last check.
      const path = join(dir, 'release-syscall.json')
      const lockPath = `${path}.probe.lock`
      const paused = deferred()
      const resume = deferred()
      let armed = false
      const hold = async (touched: unknown) => {
        if (!armed || String(touched) !== lockPath) return
        armed = false
        paused.resolve()
        await resume.promise
      }
      const originalRm = fs.rm
      const originalRename = fs.rename
      const rmSpy = spyOn(fs, 'rm').mockImplementation(
        async (...args: Parameters<typeof fs.rm>) => {
          await hold(args[0])
          return originalRm(...args)
        },
      )
      const renameSpy = spyOn(fs, 'rename').mockImplementation(
        async (...args: Parameters<typeof fs.rename>) => {
          await hold(args[0])
          return originalRename(...args)
        },
      )
      let release: Promise<void> | undefined
      let successor: RefreshFileLock | null = null
      try {
        const former = (await acquireRefreshFileLock({
          path,
          name: 'probe',
          ttlMs: 1_000,
        }))!
        armed = true
        release = former.release()
        await withTimeout(paused.promise, 1_500)
        await sleep(STALL_MS)
        successor = await acquireRefreshFileLock({
          path,
          name: 'probe',
          ttlMs: 60_000,
        })
        expect(successor).not.toBeNull()
        const successorLease = await snapshot(lockPath)
        resume.resolve()
        await withTimeout(release, 1_500)
        expect(await snapshot(lockPath)).toEqual(successorLease)
        await successor!.assertOwned()
      } finally {
        resume.resolve()
        await release
        rmSpy.mockRestore()
        renameSpy.mockRestore()
        await successor?.release()
      }
    },
    REAL_TIME_TIMEOUT,
  )

  for (const step of [
    'eviction-marker-acquired',
    'renewal-owner-confirmed',
    'renewal-write-fenced',
    'renewal-write-ready',
    'renewal-finished',
  ] as const) {
    it(`a renewal stalled at ${step} cannot displace a successor`, async () => {
      const path = join(dir, `renewal-${step}.json`)
      const lockPath = `${path}.sweep.lock`
      const paused = deferred()
      const resume = deferred()
      const finished = deferred()
      let pausedOnce = false
      const start = Date.now()
      let currentNow = start
      const former = (await acquireRefreshFileLock({
        path,
        name: 'sweep',
        ttlMs: 100,
        now: () => currentNow,
        renew: true,
        renewIntervalMs: 1,
        onStep: async (seen) => {
          if (seen === step && !pausedOnce) {
            pausedOnce = true
            paused.resolve()
            await resume.promise
          }
          if (seen === 'renewal-finished' && pausedOnce) finished.resolve()
        },
      }))!
      let successor: RefreshFileLock | null = null
      try {
        await withTimeout(paused.promise, 1_000)
        currentNow = start + 10_000
        successor = await acquireRefreshFileLock({
          path,
          name: 'sweep',
          ttlMs: 60_000,
          now: () => currentNow,
        })
        expect(successor).not.toBeNull()
        const successorLease = await snapshot(lockPath)
        resume.resolve()
        await withTimeout(finished.promise, 1_000)
        await sleep(20)
        expect(await snapshot(lockPath)).toEqual(successorLease)
        await successor!.assertOwned()
        await expect(former.assertOwned()).rejects.toBeInstanceOf(
          LockOwnershipError,
        )
      } finally {
        resume.resolve()
        await former.release()
        await successor?.release()
      }
    })
  }

  for (const step of [
    'stale-marker-stat',
    'stale-marker-claimed',
    'eviction-marker-acquired',
    'stale-lock-confirmed',
    'stale-lock-moved-aside',
  ] as const) {
    it(`a contender stalled at ${step} cannot displace a successor`, async () => {
      const path = join(dir, `acquire-${step}.json`)
      const lockPath = `${path}.sweep.lock`
      const markerPath = `${lockPath}.evicting`
      await fs.writeFile(
        lockPath,
        `${JSON.stringify({ ownerId: 'expired-holder', expiresAt: 0 })}\n`,
        { mode: 0o600 },
      )
      if (step === 'stale-marker-stat' || step === 'stale-marker-claimed') {
        // Those two steps are only reached while recovering a stale marker.
        await fs.mkdir(markerPath)
        const longAgo = new Date(Date.now() - 60_000)
        await fs.utimes(markerPath, longAgo, longAgo)
      }
      const paused = deferred()
      const resume = deferred()
      let pausedOnce = false
      const start = Date.now()
      let currentNow = start
      const stalled = acquireRefreshFileLock({
        path,
        name: 'sweep',
        ttlMs: 60_000,
        now: () => currentNow,
        onStep: async (seen) => {
          if (seen === step && !pausedOnce) {
            pausedOnce = true
            paused.resolve()
            await resume.promise
          }
        },
      })
      let successor: RefreshFileLock | null = null
      let late: RefreshFileLock | null = null
      try {
        await withTimeout(paused.promise, 1_000)
        currentNow = start + 10_000
        successor = await acquireRefreshFileLock({
          path,
          name: 'sweep',
          ttlMs: 60_000,
          now: () => currentNow,
        })
        expect(successor).not.toBeNull()
        const successorLease = await snapshot(lockPath)
        resume.resolve()
        late = await withTimeout(stalled, 1_000)
        expect(await snapshot(lockPath)).toEqual(successorLease)
        await successor!.assertOwned()
        if (late) {
          await expect(late.assertOwned()).rejects.toBeInstanceOf(
            LockOwnershipError,
          )
        }
      } finally {
        resume.resolve()
        await late?.release()
        await successor?.release()
      }
    })
  }

  it('a contender that finds a live record after its liveness check puts it back', async () => {
    const path = join(dir, 'reap-live.json')
    const lockPath = `${path}.reap.lock`
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({ ownerId: 'expired-holder', expiresAt: 0 })}\n`,
    )
    const contender = await acquireRefreshFileLock({
      path,
      name: 'reap',
      ttlMs: 60_000,
      onStep: async (step) => {
        if (step !== 'stale-lock-confirmed') return
        // A writer that takes no eviction marker (as some older releases
        // renew) replaces the expired record with a live one meanwhile.
        await renameReplace(lockPath, {
          ownerId: 'live-holder',
          expiresAt: Date.now() + 60_000,
        })
      },
    })
    expect(contender).toBeNull()
    expect((await readLease(lockPath)).ownerId).toBe('live-holder')
  })

  it('a contender putting a displaced record back never overwrites a newer one', async () => {
    const path = join(dir, 'reap-restore.json')
    const lockPath = `${path}.reap.lock`
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({ ownerId: 'expired-holder', expiresAt: 0 })}\n`,
    )
    let newer: Awaited<ReturnType<typeof snapshot>> | undefined
    const contender = await acquireRefreshFileLock({
      path,
      name: 'reap',
      ttlMs: 60_000,
      onStep: async (step) => {
        if (step === 'stale-lock-confirmed') {
          await renameReplace(lockPath, {
            ownerId: 'displaced-holder',
            expiresAt: Date.now() + 60_000,
          })
        }
        if (step === 'stale-lock-moved-aside') {
          // The path is empty for a moment; another contender creates a lease.
          await fs.writeFile(
            lockPath,
            `${JSON.stringify({ ownerId: 'newer-holder', expiresAt: Date.now() + 60_000 })}\n`,
            { flag: 'wx', mode: 0o600 },
          )
          newer = await snapshot(lockPath)
        }
      },
    })
    expect(contender).toBeNull()
    expect(newer).toBeDefined()
    expect(await snapshot(lockPath)).toEqual(newer!)
    const leftovers = (await fs.readdir(dir)).filter((entry) =>
      entry.includes('.reap.lock.'),
    )
    expect(leftovers).toEqual([])
  })

  it('renewal re-reads its record before writing and stops on a lease that expired while it paused', async () => {
    const path = join(dir, 'renewal-reread.json')
    const lockPath = `${path}.reread.lock`
    const paused = deferred()
    const resume = deferred()
    const finished = deferred()
    let pausedOnce = false
    const start = Date.now()
    let currentNow = start
    const lock = (await acquireRefreshFileLock({
      path,
      name: 'reread',
      ttlMs: 100,
      now: () => currentNow,
      renew: true,
      renewIntervalMs: 1,
      onStep: async (step) => {
        if (step === 'renewal-owner-confirmed' && !pausedOnce) {
          pausedOnce = true
          paused.resolve()
          await resume.promise
        }
        if (step === 'renewal-finished' && pausedOnce) finished.resolve()
      },
    }))!
    try {
      await withTimeout(paused.promise, 1_000)
      const before = await readLease(lockPath)
      // Past the lease, well short of the five-second marker: nobody else
      // takes the marker, so only the re-read can notice the expiry.
      currentNow = start + 1_000
      resume.resolve()
      await withTimeout(finished.promise, 1_000)
      expect(lock.hasLost()).toBe(true)
      expect((await lock.whenLost()).reason).toBe('expired')
      expect(await readLease(lockPath)).toEqual(before)
    } finally {
      resume.resolve()
      await lock.release()
    }
  })

  it('renewal reports takeover at once when its record was replaced under its write', async () => {
    const path = join(dir, 'renewal-replaced.json')
    const lockPath = `${path}.replaced.lock`
    const paused = deferred()
    const resume = deferred()
    const finished = deferred()
    let pausedOnce = false
    let lostWhenFinished: boolean | undefined
    const lock = (await acquireRefreshFileLock({
      path,
      name: 'replaced',
      ttlMs: 60_000,
      renew: true,
      renewIntervalMs: 1,
      onStep: async (step) => {
        if (step === 'renewal-write-ready' && !pausedOnce) {
          pausedOnce = true
          paused.resolve()
          await resume.promise
        }
        if (step === 'renewal-finished' && pausedOnce) {
          lostWhenFinished ??= lock.hasLost()
          finished.resolve()
        }
      },
    }))!
    const foreign = {
      ownerId: 'foreign-holder',
      expiresAt: Date.now() + 60_000,
    }
    try {
      await withTimeout(paused.promise, 1_000)
      // A writer that takes no eviction marker replaces the file; this
      // holder's marker is untouched, so only the file identity shows it.
      await renameReplace(lockPath, foreign)
      resume.resolve()
      await withTimeout(finished.promise, 1_000)
      expect(lostWhenFinished).toBe(true)
      expect(await lock.whenLost()).toMatchObject({
        reason: 'taken-over',
        observedOwnerId: 'foreign-holder',
      })
      expect(await readLease(lockPath)).toEqual(foreign)
    } finally {
      resume.resolve()
      await lock.release()
    }
  })

  it('a holder that loses its marker after writing expires its own record for contenders', async () => {
    const path = join(dir, 'relinquish-expire.json')
    const lockPath = `${path}.relinquish.lock`
    const paused = deferred()
    const resume = deferred()
    const finished = deferred()
    let pausedOnce = false
    const lock = (await acquireRefreshFileLock({
      path,
      name: 'relinquish',
      ttlMs: 60_000,
      renew: true,
      renewIntervalMs: 1,
      onStep: async (step) => {
        if (step === 'renewal-write-ready' && !pausedOnce) {
          pausedOnce = true
          paused.resolve()
          await resume.promise
        }
        if (step === 'renewal-finished' && pausedOnce) finished.resolve()
      },
    }))!
    let contender: RefreshFileLock | null = null
    try {
      await withTimeout(paused.promise, 1_000)
      await fs.rm(`${lockPath}.evicting`, { recursive: true, force: true })
      resume.resolve()
      await withTimeout(finished.promise, 1_000)
      expect((await lock.whenLost()).reason).toBe('marker-lost')
      const record = await readLease(lockPath)
      expect(record.ownerId).toBe(lock.ownerId)
      expect(record.expiresAt).toBeLessThanOrEqual(Date.now())
      contender = await acquireRefreshFileLock({
        path,
        name: 'relinquish',
        ttlMs: 60_000,
      })
      expect(contender).not.toBeNull()
    } finally {
      resume.resolve()
      await lock.release()
      await contender?.release()
    }
  })

  it('relinquishing after marker loss leaves a foreign record in its own file alone', async () => {
    const path = join(dir, 'relinquish-foreign.json')
    const lockPath = `${path}.relinquish.lock`
    const paused = deferred()
    const resume = deferred()
    const finished = deferred()
    let pausedOnce = false
    const foreign = {
      ownerId: 'foreign-holder',
      expiresAt: Date.now() + 60_000,
    }
    const lock = (await acquireRefreshFileLock({
      path,
      name: 'relinquish',
      ttlMs: 60_000,
      renew: true,
      renewIntervalMs: 1,
      onStep: async (step) => {
        if (step === 'renewal-write-ready' && !pausedOnce) {
          pausedOnce = true
          paused.resolve()
          await resume.promise
        }
        if (step === 'relinquish-read') {
          // A writer that rewrites the file in place (rather than renaming a
          // new one over it) puts its record into this holder's own file.
          await fs.writeFile(lockPath, `${JSON.stringify(foreign)}\n`)
        }
        if (step === 'renewal-finished' && pausedOnce) finished.resolve()
      },
    }))!
    try {
      await withTimeout(paused.promise, 1_000)
      await fs.rm(`${lockPath}.evicting`, { recursive: true, force: true })
      resume.resolve()
      await withTimeout(finished.promise, 1_000)
      expect((await lock.whenLost()).reason).toBe('marker-lost')
      expect(await readLease(lockPath)).toEqual(foreign)
    } finally {
      resume.resolve()
      await lock.release()
    }
  })

  it('a release that cannot take the marker still expires its own record', async () => {
    const path = join(dir, 'release-no-marker.json')
    const lockPath = `${path}.release.lock`
    const lock = (await acquireRefreshFileLock({
      path,
      name: 'release',
      ttlMs: 60_000,
    }))!
    // A fresh marker held by someone else blocks the removal step.
    await fs.mkdir(`${lockPath}.evicting`)
    await fs.writeFile(
      join(`${lockPath}.evicting`, 'owner.json'),
      `${JSON.stringify({ ownerId: 'other-evicter', createdAt: Date.now() })}\n`,
    )
    await lock.release()
    const record = await readLease(lockPath)
    expect(record.ownerId).toBe(lock.ownerId)
    expect(record.expiresAt).toBeLessThanOrEqual(Date.now())
  })
})

describe('lease records carry an integrity check', () => {
  it('assertOwned fails closed on a record whose integrity check does not match', async () => {
    const path = join(dir, 'integrity-assert.json')
    const lockPath = `${path}.integrity.lock`
    const lock = (await acquireRefreshFileLock({
      path,
      name: 'integrity',
      ttlMs: 60_000,
    }))!
    try {
      const record = await readLease(lockPath)
      expect(typeof record.check).toBe('string')
      await fs.writeFile(
        lockPath,
        `${JSON.stringify({ ...record, check: '0000000000000000' })}\n`,
      )
      await expect(lock.assertOwned()).rejects.toBeInstanceOf(
        LockOwnershipError,
      )
      expect((await lock.whenLost()).reason).toBe('unreadable')
    } finally {
      await lock.release()
    }
  })

  it('a torn renewal record is unreadable to assertOwned', async () => {
    const path = join(dir, 'integrity-torn.json')
    const lockPath = `${path}.torn.lock`
    let currentNow = 5_000
    const firstPause = deferred()
    const resumeFirst = deferred()
    const secondPause = deferred()
    const resume = deferred()
    let ticks = 0
    const lock = (await acquireRefreshFileLock({
      path,
      name: 'torn',
      ttlMs: 10_000,
      now: () => currentNow,
      renew: true,
      renewIntervalMs: 1,
      onStep: async (step) => {
        if (step !== 'renewal-owner-confirmed') return
        ticks++
        if (ticks === 1) {
          firstPause.resolve()
          await resumeFirst.promise
        } else {
          secondPause.resolve()
          await resume.promise
        }
      },
    }))!
    try {
      await withTimeout(firstPause.promise, 1_000)
      const first = await fs.readFile(lockPath)
      currentNow = 6_000
      resumeFirst.resolve()
      // The second tick starts only after the first renewal has written.
      await withTimeout(secondPause.promise, 1_000)
      const second = await fs.readFile(lockPath)
      expect(second.length).toBe(first.length)
      // A reader that raced the in-place renewal write could see the new
      // expiry followed by the old check.
      const split = second.indexOf('"check"')
      expect(split).toBeGreaterThan(0)
      const torn = Buffer.concat([
        second.subarray(0, split),
        first.subarray(split),
      ])
      expect(JSON.parse(torn.toString('utf8')).expiresAt).toBe(16_000)
      await fs.writeFile(lockPath, torn)
      await expect(lock.assertOwned()).rejects.toBeInstanceOf(
        LockOwnershipError,
      )
      expect((await lock.whenLost()).reason).toBe('unreadable')
    } finally {
      resumeFirst.resolve()
      resume.resolve()
      await lock.release()
    }
  })

  it('contenders judge a record whose integrity check does not match by its mtime', async () => {
    const path = join(dir, 'integrity-mtime.json')
    const lockPath = `${path}.integrity.lock`
    // Claims to be live, but the check fails and the file is old: stale.
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({ ownerId: 'other', expiresAt: Date.now() + 60_000, check: '0000000000000000' })}\n`,
    )
    const longAgo = new Date(Date.now() - 60_000)
    await fs.utimes(lockPath, longAgo, longAgo)
    const taken = await acquireRefreshFileLock({
      path,
      name: 'integrity',
      ttlMs: 10_000,
    })
    expect(taken).not.toBeNull()
    await taken?.release()

    // Claims to be expired, but the check fails and the file is fresh: live.
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({ ownerId: 'other', expiresAt: 0, check: '0000000000000000' })}\n`,
    )
    const refused = await acquireRefreshFileLock({
      path,
      name: 'integrity',
      ttlMs: 10_000,
    })
    expect(refused).toBeNull()
  })
})

describe('lease records interoperate with 0.8.0', () => {
  it('the 0.8.0 reader reads records this release writes, renews and expires', async () => {
    const path = join(dir, 'interop-new.json')
    const lockPath = `${path}.interop.lock`
    let currentNow = 5_000
    const firstPause = deferred()
    const resumeFirst = deferred()
    const renewed = deferred()
    const releasePaused = deferred()
    const resumeRelease = deferred()
    let ticks = 0
    const lock = (await acquireRefreshFileLock({
      path,
      name: 'interop',
      ttlMs: 10_000,
      now: () => currentNow,
      renew: true,
      renewIntervalMs: 1,
      onStep: async (step) => {
        if (step === 'renewal-owner-confirmed' && ++ticks === 1) {
          firstPause.resolve()
          await resumeFirst.promise
        }
        if (step === 'renewal-finished' && ticks === 1) renewed.resolve()
        if (step === 'release-owner-confirmed') {
          releasePaused.resolve()
          await resumeRelease.promise
        }
      },
    }))!
    const clock = () => currentNow
    await withTimeout(firstPause.promise, 1_000)
    expect(await v080.readOwner(lockPath)).toMatchObject({
      ownerId: lock.ownerId,
      expiresAt: 15_000,
    })
    expect(await v080.lockIsLive(lockPath, 10_000, clock)).toBe(true)

    currentNow = 6_000
    resumeFirst.resolve()
    await withTimeout(renewed.promise, 1_000)
    const renewedOwner = await v080.readOwner(lockPath)
    expect(renewedOwner.ownerId).toBe(lock.ownerId)
    expect(renewedOwner.expiresAt).toBeGreaterThanOrEqual(16_000)

    const release = lock.release()
    try {
      await withTimeout(releasePaused.promise, 1_000)
      // Released but not yet removed: an expired record under our identity.
      const expired = await v080.readOwner(lockPath)
      expect(expired.ownerId).toBe(lock.ownerId)
      expect(expired.expiresAt).toBeLessThanOrEqual(currentNow)
      expect(await v080.lockIsLive(lockPath, 10_000, clock)).toBe(false)
    } finally {
      resumeRelease.resolve()
      await release
    }
    expect(existsSync(lockPath)).toBe(false)
  })

  it('this release reads records 0.8.0 writes', async () => {
    const path = join(dir, 'interop-old.json')
    const lockPath = `${path}.interop.lock`
    // 0.8.0 writes exactly these bytes: compact JSON, two keys, a newline.
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({ ownerId: 'old-holder', expiresAt: Date.now() + 60_000 })}\n`,
      { mode: 0o600 },
    )
    expect(
      await acquireRefreshFileLock({ path, name: 'interop', ttlMs: 10_000 }),
    ).toBeNull()

    await fs.writeFile(
      lockPath,
      `${JSON.stringify({ ownerId: 'old-holder', expiresAt: 0 })}\n`,
      { mode: 0o600 },
    )
    const lock = await acquireRefreshFileLock({
      path,
      name: 'interop',
      ttlMs: 10_000,
    })
    expect(lock).not.toBeNull()
    expect((await readLease(lockPath)).ownerId).toBe(lock!.ownerId)
    await lock!.assertOwned()
    await lock!.release()
  })
})
