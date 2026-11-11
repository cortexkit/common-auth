import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Keep the simulated Windows backend, filesystem faults and clock in a child.
const originalRm = fs.rm
let remove = originalRm
mock.module('node:fs/promises', () => ({
  ...fs,
  rm: (path, options) => remove(path, options),
}))
Object.defineProperty(process, 'platform', { value: 'win32' })
const api = await import('@cortexkit/private-files')
const { PrivateFileError, setPrivateFilesBackendForTest } = await import(
  '../../src/fs/private-files.ts'
)
setPrivateFilesBackendForTest({
  ...api,
  verifySafeParent: async () => ({ ok: true }),
  createOwnerOnly: async (path) => fs.mkdir(path),
  createPrivateFile: async (path, bytes) =>
    fs.writeFile(path, bytes, { flag: 'wx', mode: 0o600 }),
  verifyOwnerOnly: async () => ({ ok: true }),
  verifyPrivatePath: async (path) => {
    await fs.stat(path)
  },
  readOwnerOnly: async (path) => fs.readFile(path),
})
const { acquireRefreshFileLock, setEvictionMarkerTestHooksForTest } =
  await import('../../src/fs/refresh-file-lock.ts')

// Advance only monotonic retry time, not lease/marker wall time. This checks
// the full six-second deadline without sleeping through it in every case.
let elapsed = 0
let sleeps = []
performance.now = () => elapsed
globalThis.setTimeout = (callback, ms, ...args) => {
  sleeps.push(ms)
  elapsed += ms
  // Retry time is virtual; scheduling hundreds of real timers only adds load
  // sensitivity. A microtask still resumes each retry asynchronously.
  queueMicrotask(() => callback(...args))
}
const root = await fs.mkdtemp(join(tmpdir(), 'releasing-lock-'))
const mode = process.argv[2]
let serial = 0
const faults = [
  { code: 'EBUSY' },
  { code: 'EPERM' },
  { code: 'EBUSY', reason: 'io-error', win32Code: 32 },
  { code: 'EPERM', reason: 'io-error', win32Code: 303 },
]
function refusal(path, detail, stage = 'remove') {
  return new PrivateFileError(
    path,
    stage,
    Object.assign(new Error('refused'), detail),
  )
}
async function context(onStep) {
  elapsed = 0
  sleeps = []
  remove = originalRm
  const path = join(root, `state-${serial++}`)
  const lockPath = `${path}.release.lock`
  const evictPath = `${lockPath}.evicting`
  const ownerPath = join(evictPath, 'owner.json')
  let confirmations = 0
  const lease = await acquireRefreshFileLock({
    path,
    name: 'release',
    ttlMs: 30_000,
    onStep: async (step) => {
      if (step === 'release-owner-confirmed') confirmations++
      await onStep?.(step, { evictPath, ownerPath })
    },
  })
  assert.ok(lease)
  return {
    lease,
    lockPath,
    evictPath,
    ownerPath,
    confirmations: () => confirmations,
  }
}
async function absent(path) {
  await assert.rejects(fs.stat(path), { code: 'ENOENT' })
}
async function owner(path, ownerId = 'successor') {
  await fs.writeFile(
    path,
    JSON.stringify({ ownerId, expiresAt: Date.now() + 30_000 }),
  )
}

async function lockCases() {
  for (const detail of faults) {
    const c = await context()
    let attempts = 0
    let markerDrops = 0
    remove = async (path, options) => {
      if (path === c.evictPath) markerDrops++
      if (path === c.lockPath) {
        attempts++
        assert.equal(
          c.confirmations(),
          attempts,
          'each retry re-confirms the lock owner',
        )
        assert.equal(
          markerDrops,
          attempts - 1,
          'backoff must run outside the marker',
        )
        if (attempts === 1) throw refusal(path, detail)
      }
      return originalRm(path, options)
    }
    await c.lease.release()
    assert.equal(attempts, 2)
    assert.deepEqual(sleeps, [5])
    await absent(c.lockPath)
    await absent(c.evictPath)
    await c.lease.release()
    assert.equal(attempts, 2, 'confirmed release stays idempotent')
  }
  for (const detail of faults) {
    const c = await context()
    const original = refusal(c.lockPath, detail)
    let attempts = 0
    remove = async (path, options) => {
      if (path === c.lockPath) {
        attempts++
        assert.ok(
          elapsed < 6_000,
          'no deletion starts after the release deadline',
        )
        throw attempts === 1 ? original : refusal(path, faults[1])
      }
      return originalRm(path, options)
    }
    await assert.rejects(c.lease.release(), (error) => error === original)
    assert.ok(attempts > 1)
    assert.equal(elapsed, 6_000)
    assert.equal(
      JSON.parse(await fs.readFile(c.lockPath)).ownerId,
      c.lease.ownerId,
    )
    await absent(c.evictPath)
  }
  for (const [detail, stage, wrongPath] of [
    [{ code: 'EACCES' }],
    [{ code: 'EIO' }],
    [{ code: 'EPERM', reason: 'io-error', win32Code: 5 }],
    [{ code: 'EBUSY', reason: 'io-error', win32Code: 33 }],
    [{ code: 'EPERM', reason: 'wrong-owner', win32Code: 32 }],
    [{ code: 'EPERM', reason: 'extra-ace' }],
    [{ code: 'EPERM', win32Code: 32 }],
    [faults[0], 'read'],
    [faults[0], 'remove', true],
  ]) {
    const c = await context()
    const original = refusal(
      wrongPath ? join(root, 'unrelated') : c.lockPath,
      detail,
      stage,
    )
    let attempts = 0
    remove = async (path, options) => {
      if (path === c.lockPath) {
        attempts++
        throw original
      }
      return originalRm(path, options)
    }
    await assert.rejects(c.lease.release(), (error) => error === original)
    assert.equal(attempts, 1)
    assert.deepEqual(sleeps, [])
    assert.equal(
      JSON.parse(await fs.readFile(c.lockPath)).ownerId,
      c.lease.ownerId,
    )
  }
  const c = await context()
  let attempts = 0
  remove = async (path, options) => {
    if (path === c.lockPath) {
      attempts++
      await owner(path)
      throw refusal(path, faults[0])
    }
    return originalRm(path, options)
  }
  await c.lease.release()
  assert.equal(attempts, 1, 'a successor must not be deleted by the retry')
  assert.equal(c.confirmations(), 1)
  assert.equal(JSON.parse(await fs.readFile(c.lockPath)).ownerId, 'successor')

  for (const sharingFirst of [false, true]) {
    const c = await context()
    const original = refusal(c.lockPath, faults[0])
    let occupied = false
    const occupy = async () => {
      await fs.mkdir(c.evictPath)
      await owner(c.ownerPath)
      occupied = true
    }
    if (!sharingFirst) await occupy()
    remove = async (path, options) => {
      if (path === c.lockPath) throw original
      await originalRm(path, options)
      if (path === c.evictPath && !occupied) await occupy()
    }
    await assert.rejects(c.lease.release(), (error) =>
      sharingFirst
        ? error === original
        : error.stage === 'release-not-confirmed' && error.code === 'ETIMEDOUT',
    )
    assert.equal(elapsed, 6_000)
    assert.equal(
      JSON.parse(await fs.readFile(c.lockPath)).ownerId,
      c.lease.ownerId,
    )
  }
  for (const markerDetail of [faults[1], { code: 'EACCES' }]) {
    const c = await context()
    const lockError = refusal(c.lockPath, faults[0])
    const markerError = refusal(c.evictPath, markerDetail)
    remove = async (path, options) => {
      if (path === c.lockPath) throw lockError
      if (path === c.evictPath) throw markerError
      return originalRm(path, options)
    }
    await assert.rejects(
      c.lease.release(),
      (error) =>
        error === (markerDetail.code === 'EACCES' ? markerError : lockError),
    )
    assert.equal(elapsed, markerDetail.code === 'EACCES' ? 0 : 6_000)
    assert.equal(
      JSON.parse(await fs.readFile(c.lockPath)).ownerId,
      c.lease.ownerId,
    )
  }
}

async function markerCases() {
  for (const detail of faults) {
    for (const persistent of [false, true]) {
      const c = await context()
      const original = refusal(c.evictPath, detail)
      let attempts = 0
      remove = async (path, options) => {
        if (path === c.evictPath) {
          attempts++
          assert.ok(elapsed < 6_000)
          if (persistent || attempts === 1)
            throw attempts === 1 ? original : refusal(path, faults[1])
        }
        return originalRm(path, options)
      }
      if (persistent) {
        await assert.rejects(c.lease.release(), (error) => error === original)
        assert.ok(attempts > 1)
        assert.equal(elapsed, 6_000)
        assert.ok(await fs.stat(c.ownerPath))
        await absent(c.lockPath)
        continue
      } else {
        await c.lease.release()
        assert.equal(attempts, 2)
        assert.deepEqual(sleeps, [5])
      }
      await absent(c.lockPath)
      await absent(c.evictPath)
    }
  }
  for (const replacement of [
    'foreign-owner',
    'new-directory',
    'partial-delete',
  ]) {
    const c = await context()
    let attempts = 0
    remove = async (path, options) => {
      if (path === c.evictPath && ++attempts === 1) {
        if (replacement === 'new-directory') {
          await fs.rename(path, `${path}.displaced`)
          await fs.mkdir(path)
        }
        if (replacement === 'partial-delete') await originalRm(c.ownerPath)
        else await owner(c.ownerPath)
        throw refusal(path, faults[0])
      }
      return originalRm(path, options)
    }
    await c.lease.release()
    if (replacement === 'partial-delete') {
      assert.equal(attempts, 2)
      await absent(c.evictPath)
    } else {
      assert.equal(attempts, 1)
      assert.equal(
        JSON.parse(await fs.readFile(c.ownerPath)).ownerId,
        'successor',
      )
    }
    await absent(c.lockPath)
  }
}

async function cleanupCases() {
  for (const behavior of ['transient', 'persistent', 'replacement']) {
    const c = await context()
    const writeError = Object.assign(new Error('owner write refused'), {
      code: 'EIO',
    })
    setEvictionMarkerTestHooksForTest({ failOwnerWrite: () => writeError })
    let attempts = 0
    remove = async (path, options) => {
      if (path === c.evictPath) {
        attempts++
        if (behavior === 'persistent' || attempts === 1) {
          if (behavior === 'replacement') {
            await fs.rename(path, `${path}.displaced`)
            await fs.mkdir(path)
            await owner(c.ownerPath)
          }
          throw refusal(path, faults[0])
        }
      }
      return originalRm(path, options)
    }
    await assert.rejects(c.lease.release(), (error) => error === writeError)
    setEvictionMarkerTestHooksForTest()
    if (behavior === 'transient') {
      assert.equal(attempts, 2)
      await absent(c.evictPath)
    } else if (behavior === 'persistent') {
      assert.ok(attempts > 1)
      assert.equal(elapsed, 6_000)
      await absent(c.ownerPath)
    } else {
      assert.equal(attempts, 1)
      assert.equal(
        JSON.parse(await fs.readFile(c.ownerPath)).ownerId,
        'successor',
      )
    }
    assert.equal(
      JSON.parse(await fs.readFile(c.lockPath)).ownerId,
      c.lease.ownerId,
    )
  }
  {
    const c = await context()
    const writeError = Object.assign(new Error('owner write refused'), {
      code: 'EIO',
    })
    let ownerWrites = 0
    setEvictionMarkerTestHooksForTest({
      failOwnerWrite: () => (++ownerWrites === 2 ? writeError : undefined),
    })
    remove = async (path, options) => {
      if (path === c.lockPath || (path === c.evictPath && ownerWrites === 2))
        throw refusal(path, faults[0])
      return originalRm(path, options)
    }
    await assert.rejects(c.lease.release(), (error) => error === writeError)
    assert.equal(ownerWrites, 2)
    assert.equal(
      elapsed,
      6_000,
      'cleanup must share the release deadline, not restart it',
    )
    setEvictionMarkerTestHooksForTest()
  }
  for (const persistent of [false, true]) {
    let c
    c = await context(async (step) => {
      if (step !== 'stale-marker-claimed') return
      await fs.mkdir(c.evictPath)
      await owner(c.ownerPath)
    })
    await fs.mkdir(c.evictPath)
    await owner(c.ownerPath, 'stale-marker')
    await fs.utimes(c.evictPath, new Date(0), new Date(0))
    let attempts = 0
    let original
    remove = async (path, options) => {
      if (path.startsWith(`${c.evictPath}.`)) {
        attempts++
        assert.equal(
          JSON.parse(await fs.readFile(c.ownerPath)).ownerId,
          'successor',
        )
        original ??= refusal(path, faults[1])
        if (persistent || attempts === 1) throw original
        await originalRm(path, options)
        // The successor releases its own marker, making the next attempt free.
        await originalRm(c.evictPath, { recursive: true, force: true })
        return
      }
      return originalRm(path, options)
    }
    if (persistent) {
      await assert.rejects(c.lease.release(), (error) => error === original)
      assert.equal(elapsed, 6_000)
      assert.ok(attempts > 1)
      assert.equal(
        JSON.parse(await fs.readFile(c.lockPath)).ownerId,
        c.lease.ownerId,
      )
    } else {
      await c.lease.release()
      assert.equal(attempts, 2)
      await absent(c.lockPath)
      await absent(c.evictPath)
    }
  }
}

try {
  if (mode === 'lock') await lockCases()
  else if (mode === 'marker') await markerCases()
  else if (mode === 'cleanup') await cleanupCases()
  else assert.fail(`unknown mode ${mode}`)
  console.log(JSON.stringify({ mode, checked: true }))
} finally {
  setEvictionMarkerTestHooksForTest()
  await originalRm(root, { recursive: true, force: true })
}
