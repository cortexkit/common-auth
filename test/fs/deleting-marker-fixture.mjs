import assert from 'node:assert/strict'
import { access, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// Native delete-pending opens can report ACCESS_DENIED (5) or DELETE_PENDING
// (303), depending on timing and the Windows API used. Inject 5 deterministically
// while removing the holder's marker, so the safety decision does not depend on
// winning that race.
export async function deletingMarkerFixture({
  root,
  api,
  privateFiles,
  acquireRefreshFileLock,
  stage,
}) {
  const target = join(root, 'state.json')
  const name = `deleting-marker-${stage}`
  const lockPath = `${target}.${name}.lock`
  const markerPath = `${lockPath}.evicting`
  const ownerPath = join(markerPath, 'owner.json')
  const lease = await acquireRefreshFileLock({
    path: target,
    name,
    ttlMs: 30_000,
  })
  assert.ok(lease)
  await privateFiles.createPrivateDirectoryExclusive(markerPath)
  await privateFiles.createPrivateBytes(
    ownerPath,
    JSON.stringify({ ownerId: 'holder', createdAt: Date.now() }),
  )
  let failures = 0
  const operation =
    stage === 'directory-create'
      ? 'createOwnerOnly'
      : stage === 'verify'
        ? 'verifyPrivatePath'
        : 'readOwnerOnly'
  const refusedPath = stage === 'directory-create' ? markerPath : ownerPath
  privateFiles.setPrivateFilesBackendForTest({
    ...api,
    [operation]: async (path, ...args) => {
      if (resolve(path) === refusedPath && failures < 4) {
        failures++
        // Repeated refusals force release through its existing backoff. The
        // fourth overlaps holder deletion; reads must then observe absence,
        // while exclusive directory creation must wait until it can succeed.
        if (failures === 4) await rm(markerPath, { recursive: true })
        throw new privateFiles.PrivateFileError(refusedPath, stage, {
          code: 'ERR_PRIVATE_FILES_SECURITY',
          reason: 'io-error',
          win32Code: 5,
        })
      }
      return api[operation](path, ...args)
    },
  })
  try {
    await lease.release()
    assert.equal(failures, 4)
    await assert.rejects(access(lockPath), { code: 'ENOENT' })
    await assert.rejects(access(markerPath), { code: 'ENOENT' })
  } finally {
    privateFiles.setPrivateFilesBackendForTest(api)
    await rm(markerPath, { recursive: true, force: true })
    await lease.release()
  }
}

export async function deletingLockCreateFixture({
  root,
  api,
  privateFiles,
  acquireRefreshFileLock,
  withLock,
}) {
  const target = join(root, 'state.json')
  const name = withLock ? 'deleting-lock-with-lock' : 'deleting-lock-direct'
  const lockPath = `${target}.${name}.lock`
  const holder = await acquireRefreshFileLock({
    path: target,
    name,
    ttlMs: 30_000,
  })
  assert.ok(holder)
  let failures = 0
  const steps = []
  // Exceed one direct acquire's attempt bound to exercise withLock's deadline.
  const refusals = withLock ? 12 : 4
  privateFiles.setPrivateFilesBackendForTest({
    ...api,
    createPrivateFile: async (path, ...args) => {
      if (resolve(path) === lockPath && failures < refusals) {
        failures++
        if (failures === refusals) await holder.release()
        throw new privateFiles.PrivateFileError(lockPath, 'create', {
          code: 'ERR_PRIVATE_FILES_SECURITY',
          reason: 'io-error',
          win32Code: 5,
        })
      }
      return api.createPrivateFile(path, ...args)
    },
  })
  let contender
  try {
    const options = {
      path: target,
      name,
      ttlMs: 30_000,
      onStep: (step) => steps.push(step),
    }
    if (withLock) {
      await withLock(target, { ...options, timeoutMs: 500 }, async (lock) => {
        await lock.assertOwned()
      })
    } else {
      contender = await acquireRefreshFileLock(options)
      assert.ok(contender)
      await contender.assertOwned()
      await contender.release()
    }
    assert.equal(failures, refusals)
    assert.ok(!steps.includes('stale-lock-observed'))
    await assert.rejects(access(lockPath), { code: 'ENOENT' })
  } finally {
    privateFiles.setPrivateFilesBackendForTest(api)
    await contender?.release()
    await holder.release()
  }
}
