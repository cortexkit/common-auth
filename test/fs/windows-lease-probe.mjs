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
  readOwnerOnly: async (path) => originalRead(path),
})
const { acquireRefreshFileLock } = await import(
  '../../src/fs/refresh-file-lock.ts'
)
const path = join(root, 'state')
const lockPath = `${path}.classification.lock`
try {
  if (mode === 'acquire') {
    await originalWrite(
      lockPath,
      JSON.stringify({
        ownerId: 'other-owner',
        expiresAt: Date.now() + 30_000,
      }),
      { mode: 0o600 },
    )
    await assert.rejects(
      acquireRefreshFileLock({ path, name: 'classification', ttlMs: 30_000 }),
      (error) => error instanceof PrivateFileError && error.code === errno,
    )
  } else {
    const lease = await acquireRefreshFileLock({
      path,
      name: 'classification',
      ttlMs: 30_000,
      renew: mode === 'renew',
      renewIntervalMs: 5,
    })
    assert.ok(lease)
    if (mode === 'release') {
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
