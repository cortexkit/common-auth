import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  deletingLockCreateFixture,
  deletingMarkerFixture,
} from './deleting-marker-fixture.mjs'

// Isolate the Windows backend and platform branch from the POSIX test process.
Object.defineProperty(process, 'platform', { value: 'win32' })
const native = await import('@cortexkit/private-files')
const privateFiles = await import('../../src/fs/private-files.ts')
const { acquireRefreshFileLock } = await import(
  '../../src/fs/refresh-file-lock.ts'
)
const { withLock } = await import('../../src/fs/with-lock.ts')
const root = await fs.mkdtemp(join(tmpdir(), 'changing-lock-create-'))
const target = join(root, 'state.json')
const name = 'create-probe'
const lockPath = `${target}.${name}.lock`
const markerPath = `${lockPath}.evicting`
const ownerPath = join(markerPath, 'owner.json')
const bytes = JSON.stringify({ ownerId: 'holder', expiresAt: 1 })
const base = {
  ...native,
  verifySafeParent: async () => ({ ok: true }),
  createOwnerOnly: async (path) => fs.mkdir(path),
  createPrivateFile: async (path, data) =>
    fs.writeFile(path, data, { flag: 'wx', mode: 0o600 }),
  verifyOwnerOnly: async () => ({ ok: true }),
  verifyPrivatePath: async (path) => {
    await fs.stat(path)
  },
  readOwnerOnly: async (path) => fs.readFile(path),
}
const errorAt = (path, stage, reason = 'io-error', win32Code = 5) =>
  new privateFiles.PrivateFileError(path, stage, {
    code: 'ERR_PRIVATE_FILES_SECURITY',
    reason,
    win32Code,
  })
const options = { path: target, name, ttlMs: 30_000 }
privateFiles.setPrivateFilesBackendForTest(base)
try {
  const mode = process.argv[2]
  if (mode === 'marker') {
    await deletingMarkerFixture({
      root,
      api: base,
      privateFiles,
      acquireRefreshFileLock,
      stage: 'directory-create',
    })
    console.log(JSON.stringify({ deletionRaces: 1 }))
  } else if (mode === 'lock') {
    for (const outer of [undefined, withLock]) {
      await deletingLockCreateFixture({
        root,
        api: base,
        privateFiles,
        acquireRefreshFileLock,
        withLock: outer,
      })
    }
    console.log(JSON.stringify({ deletionRaces: 2 }))
  } else if (mode === 'persistent') {
    await persistentAcquire()
  } else if (mode === 'release') {
    await persistentRelease()
  } else if (mode === 'refused') {
    await refused()
  } else if (mode === 'renew') {
    await renewal()
  } else assert.fail(`unknown mode: ${mode}`)
} finally {
  privateFiles.setPrivateFilesBackendForTest()
  await fs.rm(root, { recursive: true, force: true })
}

async function persistentAcquire() {
  for (const path of [lockPath, markerPath]) {
    for (const outer of [false, true]) {
      await fs.writeFile(lockPath, bytes)
      const isMarker = path === markerPath
      if (isMarker) {
        await fs.mkdir(markerPath)
        await fs.writeFile(ownerPath, 'holder marker')
      }
      const stage = isMarker ? 'directory-create' : 'create'
      const operation = isMarker ? 'createOwnerOnly' : 'createPrivateFile'
      const first = errorAt(path, stage)
      const steps = []
      let attempts = 0
      privateFiles.setPrivateFilesBackendForTest({
        ...base,
        [operation]: async (candidate, ...args) => {
          if (resolve(candidate) !== path)
            return base[operation](candidate, ...args)
          attempts++
          throw attempts === 1 ? first : errorAt(path, stage)
        },
      })
      const start = performance.now()
      const onStep = (step) => steps.push(step)
      await assert.rejects(
        outer
          ? withLock(
              target,
              { ...options, timeoutMs: 90, onStep },
              async () => {
                assert.fail('refused create cannot enter the critical section')
              },
            )
          : acquireRefreshFileLock({ ...options, onStep }),
        (caught) => caught === first,
      )
      if (outer) {
        assert.ok(
          attempts > 9,
          'withLock must retry beyond one direct attempt bound',
        )
        assert.ok(performance.now() - start >= 90, 'use the acquire deadline')
      } else assert.equal(attempts, isMarker ? 8 : 9)
      assert.equal(await fs.readFile(lockPath, 'utf8'), bytes)
      assert.ok(!steps.includes('stale-lock-removed'))
      assert.ok(!steps.includes('stale-marker-stat'))
      if (isMarker)
        assert.equal(await fs.readFile(ownerPath, 'utf8'), 'holder marker')
      else await assert.rejects(fs.access(markerPath), { code: 'ENOENT' })
      await fs.rm(markerPath, { recursive: true, force: true })
    }
  }
  console.log(JSON.stringify({ persistent: 4 }))
}

async function persistentRelease() {
  const steps = []
  const lease = await acquireRefreshFileLock({
    ...options,
    onStep: (step) => steps.push(step),
  })
  assert.ok(lease)
  const held = await fs.readFile(lockPath, 'utf8')
  await fs.mkdir(markerPath)
  await fs.writeFile(ownerPath, 'holder marker')
  const old = new Date(Date.now() - 10_000)
  await fs.utimes(markerPath, old, old)
  const identity = await fs.stat(markerPath)
  const first = errorAt(markerPath, 'directory-create')
  let attempts = 0
  privateFiles.setPrivateFilesBackendForTest({
    ...base,
    createOwnerOnly: async (path, ...args) => {
      if (resolve(path) !== markerPath)
        return base.createOwnerOnly(path, ...args)
      attempts++
      throw attempts === 1 ? first : errorAt(markerPath, 'directory-create')
    },
  })
  try {
    const start = performance.now()
    await assert.rejects(lease.release(), (caught) => caught === first)
    assert.ok(
      performance.now() - start >= 6_000,
      'use the existing release deadline',
    )
    assert.ok(attempts > 1)
    assert.equal(await fs.readFile(lockPath, 'utf8'), held)
    assert.equal(await fs.readFile(ownerPath, 'utf8'), 'holder marker')
    assert.equal((await fs.stat(markerPath)).ino, identity.ino)
    assert.ok(!steps.includes('stale-marker-stat'))
    assert.ok(!steps.includes('stale-lock-removed'))
  } finally {
    privateFiles.setPrivateFilesBackendForTest(base)
    await fs.rm(markerPath, { recursive: true })
    await lease.release()
  }
  console.log(JSON.stringify({ persistent: 1 }))
}

async function refused() {
  for (const [path, stage, reason, code] of [
    [lockPath, 'create', 'wrong-owner', 5],
    [lockPath, 'create', 'io-error', 32],
    [lockPath, 'directory-create', 'io-error', 5],
    [join(root, 'other'), 'create', 'io-error', 5],
    [lockPath, 'safe-parent', 'io-error', 5],
    [markerPath, 'create', 'io-error', 5],
    [ownerPath, 'directory-create', 'io-error', 5],
    [ownerPath, 'create', 'io-error', 5],
    [lockPath, 'rename', 'io-error', 5],
  ]) {
    await fs.writeFile(lockPath, bytes)
    const error = errorAt(path, stage, reason, code)
    const steps = []
    let attempts = 0
    privateFiles.setPrivateFilesBackendForTest({
      ...base,
      createPrivateFile: async (candidate, ...args) => {
        // The owner-file refusal happens after our marker directory is made;
        // all other exclusions fail before any protocol object is created.
        if (path !== ownerPath || resolve(candidate) === ownerPath) {
          attempts++
          throw error
        }
        return base.createPrivateFile(candidate, ...args)
      },
    })
    await assert.rejects(
      withLock(
        target,
        { ...options, timeoutMs: 90, onStep: (step) => steps.push(step) },
        async () => assert.fail('unrelated refusal must not be retried'),
      ),
      (caught) => caught === error,
    )
    assert.equal(
      attempts,
      1,
      `${path}/${stage}/${reason}/${code} must refuse immediately`,
    )
    assert.equal(await fs.readFile(lockPath, 'utf8'), bytes)
    assert.ok(!steps.includes('stale-lock-removed'))
    // After an owner create refusal, cleanup confirms that the empty directory
    // belongs to this attempt before removal, rather than leaving an orphan.
    await assert.rejects(fs.access(markerPath), { code: 'ENOENT' })
  }
  console.log(JSON.stringify({ refused: 9 }))
}

async function renewal() {
  let failures = 0
  let finish
  const finished = new Promise((resolve) => {
    finish = resolve
  })
  const lease = await acquireRefreshFileLock({
    ...options,
    renew: true,
    renewIntervalMs: 5,
    onStep: (step) => {
      if (step === 'renewal-write-finished') finish()
    },
  })
  assert.ok(lease)
  // Production renewal timers are unref'ed; keep this isolated probe alive.
  const keepAlive = setInterval(() => {}, 1_000)
  privateFiles.setPrivateFilesBackendForTest({
    ...base,
    createOwnerOnly: async (path, ...args) => {
      if (resolve(path) === markerPath && failures < 4) {
        failures++
        throw errorAt(markerPath, 'directory-create')
      }
      return base.createOwnerOnly(path, ...args)
    },
  })
  // A terminal renewal refusal resolves whenLost instead of reaching publish.
  // Race those outcomes so a failure is an assertion, not a hanging probe.
  try {
    await Promise.race([
      finished,
      lease
        .whenLost()
        .then(() => assert.fail('busy marker create lost a live lease')),
    ])
    assert.equal(failures, 4)
    assert.equal(lease.hasLost(), false)
    await lease.assertOwned()
  } finally {
    clearInterval(keepAlive)
    privateFiles.setPrivateFilesBackendForTest(base)
    await lease.release()
  }
  console.log(JSON.stringify({ renewed: true }))
}
