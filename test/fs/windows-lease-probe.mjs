import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolate the overridden process.platform and mocked filesystem from POSIX tests.
const originalRm = fs.rm
const originalRead = fs.readFile
const originalWrite = fs.writeFile
const originalMkdir = fs.mkdir
const originalStat = fs.stat
const root = await fs.mkdtemp(join(tmpdir(), 'lease-classification-'))
const mode = process.argv[2]
const errno = process.argv[3] ?? 'EBUSY'
let denyWrites = mode === 'acquire'
let contentionReadReady = false
let vanishedReads = 0
let renewalDisplaced = false
Object.defineProperty(process, 'platform', { value: 'win32' })
if (mode === 'release')
  mock.module('node:fs/promises', () => ({
    ...fs,
    rm: async (path, options) => {
      if (String(path).endsWith('.lock'))
        throw Object.assign(new Error('IO refused'), { code: errno })
      return originalRm(path, options)
    },
  }))
const api = await import('@cortexkit/private-files')
const { setPrivateFilesBackendForTest, PrivateFileError } = await import(
  '../../src/fs/private-files.ts'
)
setPrivateFilesBackendForTest({
  ...api,
  verifySafeParent: async () => ({ ok: true }),
  createOwnerOnly: async (path) => {
    await originalMkdir(path)
  },
  createPrivateFile: async (path, bytes) => {
    if (denyWrites)
      throw Object.assign(new Error('IO refused'), { code: errno })
    await originalWrite(path, bytes, { flag: 'wx', mode: 0o600 })
  },
  verifyOwnerOnly: async (path) => {
    await originalStat(path)
    return { ok: true }
  },
  verifyPrivatePath: async (path, kind) => {
    const info = await originalStat(path)
    if (kind === 'file' ? !info.isFile() : !info.isDirectory())
      throw new Error('wrong kind')
  },
  readOwnerOnly: async (path) => {
    if (
      (mode === 'vanishing-acquire' || mode === 'contention-refusal') &&
      contentionReadReady
    ) {
      contentionReadReady = false
      if (mode === 'vanishing-acquire') {
        await originalRm(path)
        vanishedReads++
      }
      throw Object.assign(new Error('Cannot open pinned object'), {
        code: 'ERR_PRIVATE_FILES_SECURITY',
        reason: errno === 'wrong-owner' ? errno : 'io-error',
        win32Code:
          mode === 'vanishing-acquire' ? 2 : errno === 'EBUSY' ? 32 : 5,
      })
    }
    return originalRead(path)
  },
})
const { acquireRefreshFileLock } = await import(
  '../../src/fs/refresh-file-lock.ts'
)
const { LockOwnershipError } = await import('../../src/fs/with-lock.ts')
const path = join(root, 'state')
const lockPath = `${path}.classification.lock`
try {
  if (
    mode === 'acquire' ||
    mode === 'vanishing-acquire' ||
    mode === 'contention-refusal'
  ) {
    await originalWrite(
      lockPath,
      JSON.stringify({
        ownerId: 'other-owner',
        expiresAt: Date.now() + 30_000,
      }),
      { mode: 0o600 },
    )
    const acquiring = acquireRefreshFileLock({
      path,
      name: 'classification',
      ttlMs: 30_000,
      onStep: (step) => {
        if (step === 'lease-contention-read-ready') contentionReadReady = true
      },
    })
    if (mode === 'vanishing-acquire') {
      const lease = await acquiring
      assert.ok(lease, 'contender must acquire the vanished lock')
      assert.equal(vanishedReads, 1)
      assert.equal(
        JSON.parse(await originalRead(lockPath, 'utf8')).ownerId,
        lease.ownerId,
      )
      await lease.assertOwned()
      await lease.release()
    } else {
      await assert.rejects(
        acquiring,
        (error) =>
          error instanceof PrivateFileError &&
          (mode === 'contention-refusal'
            ? error.stage === 'read' &&
              error.reason === (errno === 'wrong-owner' ? errno : 'io-error') &&
              error.win32Code === (errno === 'EBUSY' ? 32 : 5)
            : error.code === errno),
      )
      assert.equal(
        JSON.parse(await originalRead(lockPath, 'utf8')).ownerId,
        'other-owner',
      )
    }
  } else {
    const lease = await acquireRefreshFileLock({
      path,
      name: 'classification',
      ttlMs: 30_000,
      renew: mode === 'renew' || mode.endsWith('-renew'),
      renewIntervalMs: 5,
      onStep: async (step) => {
        if (
          mode.endsWith('-renew') &&
          step === 'renewal-write-ready' &&
          !renewalDisplaced
        ) {
          renewalDisplaced = true
          await displaceOwner()
        }
      },
    })
    assert.ok(lease)
    if (mode.startsWith('missing-') || mode.startsWith('replaced-')) {
      if (mode.endsWith('-assert')) await displaceOwner()
      else {
        const loss = await lease.whenLost()
        assert.equal(loss.reason, 'renewal-failed')
        assert.equal(renewalDisplaced, true)
      }
      await assert.rejects(lease.assertOwned(), (error) =>
        mode.startsWith('missing-')
          ? error instanceof PrivateFileError && error.code === 'ENOENT'
          : error instanceof LockOwnershipError ||
            (error instanceof PrivateFileError &&
              error.stage === 'before-rename' &&
              error.cause instanceof LockOwnershipError),
      )
      assert.equal(lease.hasLost(), true)
      await lease.release()
      await lease.release()
      await assert.rejects(lease.assertOwned())
      if (mode.startsWith('missing-')) {
        await assert.rejects(originalStat(lockPath), { code: 'ENOENT' })
      } else {
        assert.equal(
          JSON.parse(await originalRead(lockPath, 'utf8')).ownerId,
          'successor',
        )
      }
    } else if (mode === 'release') {
      await assert.rejects(
        lease.release(),
        (error) =>
          error instanceof PrivateFileError &&
          error.stage === 'remove' &&
          error.code === errno,
      )
      assert.equal(
        JSON.parse(await originalRead(lockPath, 'utf8')).ownerId,
        lease.ownerId,
      )
    } else {
      denyWrites = true
      assert.equal((await lease.whenLost()).reason, 'renewal-failed')
      await assert.rejects(
        lease.assertOwned(),
        (error) => error instanceof PrivateFileError && error.code === errno,
      )
      assert.equal(lease.hasLost(), true)
    }
  }
  console.log(JSON.stringify({ mode, errno, checked: true }))
} finally {
  await originalRm(root, { recursive: true, force: true })
}

async function displaceOwner() {
  if (mode.startsWith('missing-')) await originalRm(lockPath)
  else
    await originalWrite(
      lockPath,
      JSON.stringify({ ownerId: 'successor', expiresAt: Date.now() + 30_000 }),
    )
}
