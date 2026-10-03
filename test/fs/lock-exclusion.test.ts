import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { rmSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import {
  acquireRefreshFileLock,
  type KeptAsideRecord,
  type RefreshFileLock,
} from '../../src/fs/index.js'
import {
  criticalSections,
  deferred,
  realHandleWrite,
  sleep,
  spyOnHandleWrites,
  withTimeout,
} from '../fixtures/lock-probes.js'
import { makeTempDir } from '../fixtures/scratch.js'

// Each test here drives one schedule of lock holders and contenders, pausing
// them at chosen points, and checks that no two of them are ever inside their
// critical sections at once, or that nobody touched a record or marker that
// was not theirs. The real-time test pauses a contender for over five seconds
// so its eviction marker goes stale on the wall clock.

let dir: string

beforeEach(async () => {
  dir = await makeTempDir('lock-exclusion-')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const STALL_MS = 5_300
const REAL_TIME_TIMEOUT = 25_000

async function readLease(path: string) {
  return JSON.parse(await fs.readFile(path, 'utf8')) as {
    ownerId: string
    expiresAt: number
    check?: string
  }
}

async function writeExpiredRecord(lockPath: string) {
  await fs.writeFile(
    lockPath,
    `${JSON.stringify({ ownerId: 'expired-holder', expiresAt: 0 })}\n`,
    { mode: 0o600 },
  )
}

/** Writes a record the way a 0.8.0 holder renews: a new file renamed over the path. */
async function renameReplace(lockPath: string, record: object) {
  const staged = `${lockPath}.test-staged`
  await fs.writeFile(staged, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  await fs.rename(staged, lockPath)
}

/** The identity and owner file of the eviction marker directory. */
async function markerSnapshot(markerPath: string) {
  const [info, owner] = await Promise.all([
    fs.stat(markerPath),
    fs.readFile(join(markerPath, 'owner.json'), 'utf8'),
  ])
  return { ino: info.ino, owner }
}

async function makeFreshMarker(markerPath: string, ownerId: string) {
  await fs.mkdir(markerPath)
  await fs.writeFile(
    join(markerPath, 'owner.json'),
    `${JSON.stringify({ ownerId, createdAt: Date.now() })}\n`,
    { mode: 0o600 },
  )
}

const injectedIo = (code: string) =>
  Object.assign(new Error(`injected ${code}`), { code })

describe('release never clears the lock path', () => {
  it('a release that loses the marker race to its successor never lets a third holder in beside the successor', async () => {
    const path = join(dir, 'release-handoff.json')
    const name = 'handoff'
    const markerPath = `${path}.${name}.lock.evicting`
    const bodies = criticalSections()
    let third: RefreshFileLock | null = null
    let thirdTried = false
    const tryThird = async () => {
      thirdTried = true
      third = await acquireRefreshFileLock({ path, name, ttlMs: 60_000 })
      if (third) bodies.enter('third')
    }
    // The handoff is steered through mkdir of the eviction marker. A release
    // that tries for the marker has its first attempt held until the
    // successor holds the marker, so it loses that race; its retry is held
    // until the successor is inside its critical section.
    let phase: 'idle' | 'release-first' | 'release-retry' = 'idle'
    const releaseFirstHeld = deferred()
    const allowReleaseFirst = deferred()
    const releaseFirstDone = deferred()
    const releaseRetryHeld = deferred()
    const allowReleaseRetry = deferred()
    const originalMkdir = fs.mkdir
    const mkdirSpy = spyOn(fs, 'mkdir').mockImplementation((async (
      ...args: Parameters<typeof fs.mkdir>
    ) => {
      if (String(args[0]) === markerPath && phase === 'release-first') {
        phase = 'idle'
        releaseFirstHeld.resolve()
        await allowReleaseFirst.promise
        try {
          return await originalMkdir(...args)
        } finally {
          releaseFirstDone.resolve()
        }
      }
      if (String(args[0]) === markerPath && phase === 'release-retry') {
        phase = 'idle'
        releaseRetryHeld.resolve()
        await allowReleaseRetry.promise
      }
      return originalMkdir(...args)
    }) as typeof fs.mkdir)
    const successorAtMarker = deferred()
    const resumeSuccessor = deferred()
    let successor: RefreshFileLock | null = null
    let releasing: Promise<void> | undefined
    try {
      const releaser = (await acquireRefreshFileLock({
        path,
        name,
        ttlMs: 60_000,
        onStep: async (step) => {
          // A release that clears the path moves the successor's record aside
          // here; the third contender tries in that moment.
          if (step === 'stale-lock-moved-aside') await tryThird()
        },
      }))!
      phase = 'release-first'
      releasing = releaser.release()
      const first = await withTimeout(
        Promise.race([
          releaseFirstHeld.promise.then(() => 'marker-attempt' as const),
          releasing.then(() => 'released' as const),
        ]),
        2_000,
      )
      const startSuccessor = (pauseAtMarker: boolean) =>
        acquireRefreshFileLock({
          path,
          name,
          ttlMs: 60_000,
          onStep: async (step) => {
            if (pauseAtMarker && step === 'eviction-marker-acquired') {
              successorAtMarker.resolve()
              await resumeSuccessor.promise
            }
          },
        })
      if (first === 'marker-attempt') {
        // The release gave its record up and now wants the marker to clear
        // the path; a waiting contender takes the marker first.
        const acquiring = startSuccessor(true)
        await withTimeout(successorAtMarker.promise, 1_000)
        phase = 'release-retry'
        allowReleaseFirst.resolve()
        await withTimeout(releaseFirstDone.promise, 1_000)
        resumeSuccessor.resolve()
        successor = await withTimeout(acquiring, 1_000)
        expect(successor).not.toBeNull()
        bodies.enter('successor')
        await withTimeout(releaseRetryHeld.promise, 1_000)
        allowReleaseRetry.resolve()
        await withTimeout(releasing, 2_000)
      } else {
        // The release finished without wanting the marker: the successor
        // takes the lock, then the third contender tries.
        phase = 'idle'
        successor = await startSuccessor(false)
        expect(successor).not.toBeNull()
        bodies.enter('successor')
      }
      if (!thirdTried) await tryThird()
      expect(bodies.overlaps).toEqual([])
      expect(third).toBeNull()
      await successor!.assertOwned()
    } finally {
      allowReleaseFirst.resolve()
      allowReleaseRetry.resolve()
      resumeSuccessor.resolve()
      await releasing?.catch(() => {})
      mkdirSpy.mockRestore()
      await successor?.release()
      await (third as RefreshFileLock | null)?.release()
    }
  })
})

describe('a live record moved off the lock path is never deleted', () => {
  for (const failure of ['lock-path-taken', 'put-back-failed'] as const) {
    it(`a live record that cannot go back is kept aside and reported (${failure})`, async () => {
      const path = join(dir, `kept-${failure}.json`)
      const lockPath = `${path}.kept.lock`
      await writeExpiredRecord(lockPath)
      const kept: KeptAsideRecord[] = []
      const originalLink = fs.link
      let failPutBack = false
      const linkSpy = spyOn(fs, 'link').mockImplementation((async (
        ...args: Parameters<typeof fs.link>
      ) => {
        if (failPutBack && String(args[0]).endsWith('.reaping'))
          throw injectedIo('EIO')
        return originalLink(...args)
      }) as typeof fs.link)
      try {
        const contender = await acquireRefreshFileLock({
          path,
          name: 'kept',
          ttlMs: 60_000,
          onRecordKeptAside: (record) => kept.push(record),
          onStep: async (step) => {
            if (step === 'stale-lock-confirmed') {
              // A live record replaces the expired one after the
              // contender's liveness check (a writer that takes no marker).
              await renameReplace(lockPath, {
                ownerId: 'displaced-holder',
                expiresAt: Date.now() + 60_000,
              })
            }
            if (step === 'stale-lock-moved-aside') {
              if (failure === 'put-back-failed') failPutBack = true
              else
                await fs.writeFile(
                  lockPath,
                  `${JSON.stringify({ ownerId: 'newer-holder', expiresAt: Date.now() + 60_000 })}\n`,
                  { flag: 'wx', mode: 0o600 },
                )
            }
          },
        })
        expect(contender).toBeNull()
        // The displaced record still exists, under its private name.
        const aside = (await fs.readdir(dir))
          .filter((entry) => entry.endsWith('.reaping'))
          .map((entry) => join(dir, entry))
        expect(aside).toHaveLength(1)
        expect((await readLease(aside[0]!)).ownerId).toBe('displaced-holder')
        expect(kept).toHaveLength(1)
        expect(kept[0]!.path).toBe(aside[0]!)
        expect(kept[0]!.reason).toBe(failure)
        expect(kept[0]!.lockPath).toBe(lockPath)
        if (failure === 'put-back-failed')
          expect((kept[0]!.error as NodeJS.ErrnoException).code).toBe('EIO')
      } finally {
        linkSpy.mockRestore()
      }
    })
  }

  it('a later contender removes leftovers beside the lock only once they have expired', async () => {
    const path = join(dir, 'sweep.json')
    const lockPath = `${path}.sweep.lock`
    await writeExpiredRecord(lockPath)
    const live = `${lockPath}.11111111-1111-4111-8111-111111111111.reaping`
    const expiredAside = `${lockPath}.22222222-2222-4222-8222-222222222222.reaping`
    const expiredStaged = `${lockPath}.33333333-3333-4333-8333-333333333333.creating`
    const unrelated = `${lockPath}.notes`
    await fs.writeFile(
      live,
      `${JSON.stringify({ ownerId: 'kept-holder', expiresAt: Date.now() + 60_000 })}\n`,
    )
    for (const leftover of [expiredAside, expiredStaged, unrelated])
      await fs.writeFile(
        leftover,
        `${JSON.stringify({ ownerId: 'gone', expiresAt: 0 })}\n`,
      )
    const lock = await acquireRefreshFileLock({
      path,
      name: 'sweep',
      ttlMs: 60_000,
    })
    try {
      expect(lock).not.toBeNull()
      expect((await readLease(live)).ownerId).toBe('kept-holder')
      expect(await fs.exists(expiredAside)).toBe(false)
      expect(await fs.exists(expiredStaged)).toBe(false)
      expect(await fs.exists(unrelated)).toBe(true)
    } finally {
      await lock?.release()
    }
  })
})

describe('a new record is complete the moment the lock path names it', () => {
  it('a creator paused between creating its record and writing it is never admitted beside a contender', async () => {
    const path = join(dir, 'publish.json')
    const name = 'publish'
    const lockPath = `${path}.${name}.lock`
    const held = deferred()
    const resume = deferred()
    let armed = true
    const originalWriteFile = fs.writeFile
    // An exclusive create of a lock record (of the lock path itself, or of a
    // private name beside it) opens the file and then writes it; this holds
    // the first one between the two, as an event-loop stall would.
    const writeSpy = spyOn(fs, 'writeFile').mockImplementation((async (
      ...args: Parameters<typeof fs.writeFile>
    ) => {
      const [file, data, options] = args
      if (
        armed &&
        String(file).startsWith(lockPath) &&
        !String(file).includes('.evicting') &&
        (options as { flag?: string } | undefined)?.flag === 'wx'
      ) {
        armed = false
        const handle = await fs.open(file as string, 'wx', 0o600)
        try {
          held.resolve()
          await resume.promise
          await handle.writeFile(data as Buffer)
        } finally {
          await handle.close()
        }
        return
      }
      return originalWriteFile(...args)
    }) as typeof fs.writeFile)
    const bodies = criticalSections()
    let creator: RefreshFileLock | null = null
    let contender: RefreshFileLock | null = null
    const creating = acquireRefreshFileLock({ path, name, ttlMs: 60_000 })
    try {
      await withTimeout(held.promise, 1_000)
      // A contender whose lease is short and whose clock runs ahead judges an
      // empty file at the lock path dead by its age.
      contender = await acquireRefreshFileLock({
        path,
        name,
        ttlMs: 1_000,
        now: () => Date.now() + 10_000,
      })
      if (contender) bodies.enter('contender')
      resume.resolve()
      creator = await withTimeout(creating, 1_000)
      if (creator) bodies.enter('creator')
      expect(bodies.overlaps).toEqual([])
    } finally {
      resume.resolve()
      await creating.catch(() => null)
      writeSpy.mockRestore()
      await creator?.release()
      await contender?.release()
    }
  })
})

describe('a contender that creates while a marker is held backs off', () => {
  it(
    'a third contender creating while a stalled reaper has a live record off the path is not admitted while a marker is held',
    async () => {
      const path = join(dir, 'gap.json')
      const name = 'gap'
      const lockPath = `${path}.${name}.lock`
      await writeExpiredRecord(lockPath)
      // The reaper has made its last marker check; this holds its rename of
      // the lock path, as a stall right before it would, past the marker's
      // five-second lifetime.
      const reaperHeld = deferred()
      const resumeReaper = deferred()
      let armed = true
      let reaperResumed = false
      const originalRename = fs.rename
      const renameSpy = spyOn(fs, 'rename').mockImplementation((async (
        ...args: Parameters<typeof fs.rename>
      ) => {
        if (armed && String(args[0]) === lockPath) {
          armed = false
          reaperHeld.resolve()
          await resumeReaper.promise
        }
        return originalRename(...args)
      }) as typeof fs.rename)
      const bodies = criticalSections()
      let third: RefreshFileLock | null = null
      let successor: RefreshFileLock | null = null
      const successorRenewing = deferred()
      const resumeRenewal = deferred()
      const reaping = acquireRefreshFileLock({
        path,
        name,
        ttlMs: 60_000,
        onStep: async (step) => {
          if (step === 'stale-lock-moved-aside' && reaperResumed) {
            third = await acquireRefreshFileLock({ path, name, ttlMs: 60_000 })
            if (third) bodies.enter('third')
          }
        },
      })
      try {
        await withTimeout(reaperHeld.promise, 1_500)
        await sleep(STALL_MS)
        let pausedRenewal = false
        successor = await acquireRefreshFileLock({
          path,
          name,
          ttlMs: 60_000,
          renew: true,
          renewIntervalMs: 20,
          onStep: async (step) => {
            if (step === 'renewal-owner-confirmed' && !pausedRenewal) {
              pausedRenewal = true
              successorRenewing.resolve()
              await resumeRenewal.promise
            }
          },
        })
        expect(successor).not.toBeNull()
        bodies.enter('successor')
        // The successor's renewal now holds the eviction marker.
        await withTimeout(successorRenewing.promise, 1_500)
        reaperResumed = true
        resumeReaper.resolve()
        expect(await withTimeout(reaping, 1_500)).toBeNull()
        expect(bodies.overlaps).toEqual([])
        expect(third).toBeNull()
      } finally {
        resumeReaper.resolve()
        resumeRenewal.resolve()
        renameSpy.mockRestore()
        const late = await reaping.catch(() => null)
        await late?.release()
        await successor?.release()
        await (third as RefreshFileLock | null)?.release()
      }
    },
    REAL_TIME_TIMEOUT,
  )
})

describe('the eviction marker is only ever removed by its owner', () => {
  it('recovering a stale marker never removes a fresh marker that replaced it', async () => {
    const path = join(dir, 'marker-recover.json')
    const lockPath = `${path}.recover.lock`
    const markerPath = `${lockPath}.evicting`
    await writeExpiredRecord(lockPath)
    await fs.mkdir(markerPath)
    const longAgo = new Date(Date.now() - 60_000)
    await fs.utimes(markerPath, longAgo, longAgo)
    const paused = deferred()
    const resume = deferred()
    const stealing = acquireRefreshFileLock({
      path,
      name: 'recover',
      ttlMs: 60_000,
      onStep: async (step) => {
        if (step === 'stale-marker-stat') {
          paused.resolve()
          await resume.promise
        }
      },
    })
    let stealer: RefreshFileLock | null = null
    try {
      await withTimeout(paused.promise, 1_000)
      // While the stealer pauses between judging the marker stale and
      // taking it, the stale marker goes and a fresh one takes its place.
      await fs.rm(markerPath, { recursive: true })
      await makeFreshMarker(markerPath, 'fresh-evicter')
      const fresh = await markerSnapshot(markerPath)
      resume.resolve()
      stealer = await withTimeout(stealing, 1_000)
      expect(await markerSnapshot(markerPath)).toEqual(fresh)
      expect(stealer).toBeNull()
    } finally {
      resume.resolve()
      await stealing.catch(() => null)
      await stealer?.release()
    }
  })

  it('releasing the marker never removes a newer marker that replaced it', async () => {
    const path = join(dir, 'marker-release.json')
    const lockPath = `${path}.release.lock`
    const markerPath = `${lockPath}.evicting`
    await writeExpiredRecord(lockPath)
    // The contender has checked that the marker is its own and is about to
    // remove it; this holds that removal while the marker is taken over and
    // replaced by a newer one.
    let armed = false
    let newer: Awaited<ReturnType<typeof markerSnapshot>> | undefined
    const originalRm = fs.rm
    const originalRename = fs.rename
    const replaceMarker = async (touched: unknown) => {
      if (!armed || String(touched) !== markerPath) return
      armed = false
      await originalRm(markerPath, { recursive: true, force: true })
      await makeFreshMarker(markerPath, 'newer-evicter')
      newer = await markerSnapshot(markerPath)
    }
    const rmSpy = spyOn(fs, 'rm').mockImplementation((async (
      ...args: Parameters<typeof fs.rm>
    ) => {
      await replaceMarker(args[0])
      return originalRm(...args)
    }) as typeof fs.rm)
    const renameSpy = spyOn(fs, 'rename').mockImplementation((async (
      ...args: Parameters<typeof fs.rename>
    ) => {
      await replaceMarker(args[0])
      return originalRename(...args)
    }) as typeof fs.rename)
    let lock: RefreshFileLock | null = null
    try {
      lock = await acquireRefreshFileLock({
        path,
        name: 'release',
        ttlMs: 60_000,
        onStep: (step) => {
          if (step === 'stale-lock-confirmed') armed = true
        },
      })
      expect(lock).not.toBeNull()
      expect(newer).toBeDefined()
      expect(await markerSnapshot(markerPath)).toEqual(newer!)
    } finally {
      rmSpy.mockRestore()
      renameSpy.mockRestore()
      await lock?.release()
    }
  })
})

describe('a holder trusts its own in-place writes', () => {
  it('assertOwned waits for its own renewal write instead of reporting the record unreadable', async () => {
    const path = join(dir, 'assert-during-write.json')
    let currentNow = 5_000
    const halfWritten = deferred()
    const finishWrite = deferred()
    let armed = false
    const writeSpy = spyOnHandleWrites(
      async () => {},
      async (handle, args) => {
        if (!armed) return realHandleWrite(handle, args)
        armed = false
        // Store the new owner id and expiry, then pause before the check, as
        // a write still in progress would look to a concurrent read.
        const [buffer, offset, length, position] = args as [
          Buffer,
          number,
          number,
          number,
        ]
        const split = buffer.indexOf('"check"')
        await realHandleWrite(handle, [buffer, offset, split, position])
        halfWritten.resolve()
        await finishWrite.promise
        await realHandleWrite(handle, [
          buffer,
          offset + split,
          length - split,
          position + split,
        ])
        return { bytesWritten: length, buffer }
      },
    )
    const lock = (await acquireRefreshFileLock({
      path,
      name: 'assert',
      ttlMs: 60_000,
      now: () => currentNow,
      renew: true,
      renewIntervalMs: 1,
    }))!
    try {
      currentNow = 6_000
      armed = true
      await withTimeout(halfWritten.promise, 1_000)
      const outcome = lock.assertOwned().then(
        () => 'owned' as const,
        () => 'lost' as const,
      )
      await sleep(50)
      finishWrite.resolve()
      expect(await withTimeout(outcome, 1_000)).toBe('owned')
      expect(lock.hasLost()).toBe(false)
    } finally {
      finishWrite.resolve()
      writeSpy.mockRestore()
      await lock.release()
    }
  })

  it('assertOwned reads again once before reporting a record that fails its check', async () => {
    const path = join(dir, 'assert-reread.json')
    const lockPath = `${path}.reread.lock`
    const lock = (await acquireRefreshFileLock({
      path,
      name: 'reread',
      ttlMs: 60_000,
    }))!
    const bytes = await fs.readFile(lockPath, 'utf8')
    const record = await readLease(lockPath)
    // Same length, wrong check: what a read overlapping a write could see.
    const torn = bytes.replace(record.check!, '0'.repeat(record.check!.length))
    let tornReads = 1
    const originalReadFile = fs.readFile
    const readSpy = spyOn(fs, 'readFile').mockImplementation((async (
      ...args: Parameters<typeof fs.readFile>
    ) => {
      if (tornReads > 0 && String(args[0]) === lockPath) {
        tornReads--
        return torn
      }
      return originalReadFile(...args)
    }) as typeof fs.readFile)
    try {
      await lock.assertOwned()
      expect(tornReads).toBe(0)
      expect(lock.hasLost()).toBe(false)
    } finally {
      readSpy.mockRestore()
      await lock.release()
    }
  })

  it('a renewal write that stores fewer than all its bytes fails the renewal closed', async () => {
    const path = join(dir, 'short-write.json')
    let currentNow = 5_000
    let armed = false
    let shortWritten = false
    let lostWhenFinished: boolean | undefined
    const finished = deferred()
    const writeSpy = spyOnHandleWrites(
      async () => {},
      async (handle, args) => {
        if (!armed) return realHandleWrite(handle, args)
        armed = false
        shortWritten = true
        const [buffer, offset, , position] = args as [
          Buffer,
          number,
          number,
          number,
        ]
        // Only the bytes up to the check are stored.
        const stored = buffer.indexOf('"check"')
        return realHandleWrite(handle, [buffer, offset, stored, position])
      },
    )
    const lock = (await acquireRefreshFileLock({
      path,
      name: 'short',
      ttlMs: 60_000,
      now: () => currentNow,
      renew: true,
      renewIntervalMs: 1,
      onStep: (step) => {
        // Judged when the renewal that wrote short finishes, not later.
        if (step === 'renewal-finished' && shortWritten) {
          lostWhenFinished ??= lock.hasLost()
          finished.resolve()
        }
      },
    }))!
    try {
      currentNow = 6_000
      armed = true
      await withTimeout(finished.promise, 1_000)
      expect(lostWhenFinished).toBe(true)
      expect((await lock.whenLost()).reason).toBe('renewal-failed')
      // The record at the path is a mix of the two writes, so contenders see
      // it as unreadable and judge it by its fresh mtime: still held.
      expect(
        await acquireRefreshFileLock({ path, name: 'short', ttlMs: 60_000 }),
      ).toBeNull()
    } finally {
      writeSpy.mockRestore()
      await lock.release()
    }
  })
})

describe('a record in the fixed-width format must be exactly ours', () => {
  it('a torn record whose splice renames a key is unreadable, not an old record', async () => {
    const path = join(dir, 'splice.json')
    const name = 'splice'
    const lockPath = `${path}.${name}.lock`
    let currentNow = 999
    const firstPause = deferred()
    const resumeFirst = deferred()
    const renewed = deferred()
    const resumeRenewals = deferred()
    let confirmed = 0
    // The first renewal is held before it writes, so the original record
    // can be read, then held once it has finished and released the eviction
    // marker, so no further renewal runs.
    const holder = (await acquireRefreshFileLock({
      path,
      name,
      ttlMs: 9_000,
      now: () => currentNow,
      renew: true,
      renewIntervalMs: 1,
      onStep: async (step) => {
        if (step === 'renewal-owner-confirmed' && ++confirmed === 1) {
          firstPause.resolve()
          await resumeFirst.promise
        }
        if (step === 'renewal-finished') {
          renewed.resolve()
          await resumeRenewals.promise
        }
      },
    }))!
    const bodies = criticalSections()
    const holderBody = bodies.enter('holder')
    let contender: RefreshFileLock | null = null
    try {
      await withTimeout(firstPause.promise, 1_000)
      const older = await fs.readFile(lockPath)
      currentNow = 1_000
      resumeFirst.resolve()
      await withTimeout(renewed.promise, 1_000)
      const newer = await fs.readFile(lockPath)
      expect((await readLease(lockPath)).expiresAt).toBe(10_000)
      expect(JSON.parse(older.toString('utf8')).expiresAt).toBe(9_999)
      // New bytes up to four digits into the expiry, four old bytes, then new
      // bytes again: valid JSON with the expiry 1000 and a key "chheck".
      const p = older.indexOf('"expiresAt":') + '"expiresAt":'.length
      const torn = Buffer.concat([
        newer.subarray(0, p + 4),
        older.subarray(p + 4, p + 8),
        newer.subarray(p + 8),
      ])
      expect(torn.length).toBe(newer.length)
      const parsed = JSON.parse(torn.toString('utf8'))
      expect(parsed.expiresAt).toBe(1_000)
      expect(Object.keys(parsed)).toEqual(['ownerId', 'expiresAt', 'chheck'])
      await fs.writeFile(lockPath, torn)
      // Both real expiries (9999 and 10000) are still ahead at 5000; the
      // spliced one (1000) is behind.
      contender = await acquireRefreshFileLock({
        path,
        name,
        ttlMs: 9_000,
        now: () => 5_000,
      })
      if (contender) bodies.enter('contender')
      expect(bodies.overlaps).toEqual([])
      expect(contender).toBeNull()
    } finally {
      holderBody.exit()
      resumeFirst.resolve()
      resumeRenewals.resolve()
      await holder.release()
      await contender?.release()
    }
  })
})
