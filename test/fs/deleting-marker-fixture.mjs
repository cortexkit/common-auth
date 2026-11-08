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
  const operation = stage === 'verify' ? 'verifyPrivatePath' : 'readOwnerOnly'
  privateFiles.setPrivateFilesBackendForTest({
    ...api,
    [operation]: async (path, ...args) => {
      if (resolve(path) === ownerPath && failures < 4) {
        failures++
        // Two refused reads force release to use its existing backoff. The
        // fourth refusal overlaps the holder deleting its directory; only
        // the following ENOENT can establish that the owner is gone.
        if (failures === 4) await rm(markerPath, { recursive: true })
        throw new privateFiles.PrivateFileError(ownerPath, stage, {
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
