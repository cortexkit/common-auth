import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const mode = process.argv[2]
// Keep the Windows branch and backend injection isolated from other suites.
if (mode === 'simulated')
  Object.defineProperty(process, 'platform', { value: 'win32' })
const api = await import('@cortexkit/private-files')
const { PrivateFileError, setPrivateFilesBackendForTest } = await import(
  '../../src/fs/private-files.ts'
)
const { withLock, lockPathFor } = await import('../../src/fs/with-lock.ts')
const root = await fs.mkdtemp(join(tmpdir(), 'changing-lock-read-'))
const target = join(root, 'state.json')
const name = 'claustrum-roster-write'
const lockPath = lockPathFor(target, name)
const heldBytes = JSON.stringify({
  ownerId: 'holder',
  expiresAt: Date.now() + 30_000,
})
const nativeError = (win32Code, reason = 'io-error') =>
  Object.assign(new Error('Cannot open pinned object'), {
    code: 'ERR_PRIVATE_FILES_SECURITY',
    reason,
    win32Code,
  })

try {
  if (mode === 'simulated') await simulated()
  else await native()
} finally {
  setPrivateFilesBackendForTest()
  await fs.rm(root, { recursive: true, force: true })
}

async function simulated() {
  const base = {
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
  }
  let transient = 0
  let persistent = 0
  let refused = 0
  for (const step of ['lease-contention-read-ready', 'lock-read-ready']) {
    for (const stage of ['read', 'verify']) {
      for (const win32Code of [32, 303]) {
        await fs.writeFile(lockPath, heldBytes)
        let armed = false
        let failures = 0
        const steps = []
        const fail = async (path) => {
          if (!armed || resolve(path) !== lockPath) return
          armed = false
          failures++
          // Remove the holder's file before the simulated read or verification fails.
          await fs.rm(lockPath)
          throw nativeError(win32Code)
        }
        setPrivateFilesBackendForTest({
          ...base,
          [stage === 'read' ? 'readOwnerOnly' : 'verifyPrivatePath']: async (
            path,
          ) => {
            await fail(path)
            return stage === 'read' ? fs.readFile(path) : undefined
          },
        })
        let committed = false
        await withLock(
          target,
          {
            name,
            ttlMs: 10_000,
            timeoutMs: 500,
            onStep: (event) => {
              steps.push(event)
              if (event === step && failures === 0) armed = true
            },
          },
          async (lock) => {
            await lock.assertOwned()
            committed = true
          },
        )
        assert.equal(failures, 1)
        assert.equal(committed, true)
        assert.ok(!steps.includes('stale-lock-removed'))
        transient++
      }
    }
  }
  for (const win32Code of [32, 303]) {
    // An unreadable expired owner must not be inferred stale and removed.
    const bytes = JSON.stringify({
      ownerId: 'holder',
      expiresAt: Date.now() - 1_000,
    })
    await fs.writeFile(lockPath, bytes)
    const error = new PrivateFileError(lockPath, 'read', nativeError(win32Code))
    let reads = 0
    const steps = []
    setPrivateFilesBackendForTest({
      ...base,
      readOwnerOnly: async () => {
        reads++
        throw error
      },
    })
    const start = performance.now()
    await assert.rejects(
      withLock(
        target,
        {
          name,
          ttlMs: 10_000,
          timeoutMs: 90,
          onStep: (step) => {
            steps.push(step)
          },
        },
        async () => {
          assert.fail('unreadable holder cannot be acquired')
        },
      ),
      (caught) => caught === error,
    )
    assert.ok(reads > 1, 'persistent sharing errors must be retried')
    assert.ok(
      performance.now() - start >= 90,
      'retries must use the acquire deadline',
    )
    assert.equal(await fs.readFile(lockPath, 'utf8'), bytes)
    assert.ok(!steps.includes('stale-lock-removed'))
    persistent++
  }
  for (const [reason, win32Code, stage, path] of [
    ['io-error', 5, 'read', lockPath],
    ['io-error', 1117, 'read', lockPath],
    ['io-error', undefined, 'read', lockPath],
    ['wrong-owner', 32, 'read', lockPath],
    ['extra-ace', 32, 'read', lockPath],
    ['unsafe-ancestor', 32, 'read', lockPath],
    ['reparse-point', 32, 'read', lockPath],
    ['io-error', 32, 'create', lockPath],
    ['io-error', 32, 'read', join(root, 'unrelated')],
    ['io-error', 32, 'read', join(`${lockPath}.evicting`, 'owner.json')],
    ['wrong-owner', 303, 'verify', lockPath],
    ['io-error', 5, 'verify', lockPath],
  ]) {
    await fs.writeFile(lockPath, heldBytes)
    const error = new PrivateFileError(
      path,
      stage,
      nativeError(win32Code, reason),
    )
    let reads = 0
    setPrivateFilesBackendForTest({
      ...base,
      readOwnerOnly: async () => {
        reads++
        throw error
      },
    })
    await assert.rejects(
      withLock(target, { name, ttlMs: 10_000, timeoutMs: 90 }, async () => {
        assert.fail('refused owner cannot be acquired')
      }),
      (caught) => caught === error,
    )
    assert.equal(
      reads,
      1,
      `${reason}/${win32Code}/${stage}/${path} must fail immediately`,
    )
    assert.equal(await fs.readFile(lockPath, 'utf8'), heldBytes)
    refused++
  }
  console.log(JSON.stringify({ transient, persistent, refused }))
}

async function native() {
  assert.equal(process.platform, 'win32')
  await api.securePrivatePath(root, 'directory')
  await api.createPrivateFile(lockPath, heldBytes)
  let failures = 0
  let observed
  let checkedRewrite = false
  const steps = []
  const replacement = JSON.stringify({
    ownerId: 'successor',
    expiresAt: Date.now() + 30_000,
  })
  // Start PowerShell before the acquire deadline; only the handle/open race
  // belongs inside that budget, not cold process startup on a Windows runner.
  const holder = await holdForChange(mode, replacement)
  setPrivateFilesBackendForTest({
    ...api,
    readOwnerOnly: async (path) => {
      if (resolve(path) !== lockPath || failures !== 0)
        return api.readOwnerOnly(path)
      // Verification already finished. Pin the holder exclusively during its
      // delete/rewrite so the real native reader (not an injected error) fails.
      await holder.open()
      try {
        return await api.readOwnerOnly(path)
      } catch (error) {
        observed = new PrivateFileError(path, 'read', error)
        failures++
        assert.equal(error.reason, 'io-error')
        assert.equal(
          error.win32Code,
          32,
          'native ERROR_SHARING_VIOLATION must be retained',
        )
        throw observed
      } finally {
        await holder.finish()
      }
    },
  })
  let committed = false
  await withLock(
    target,
    {
      name,
      ttlMs: 10_000,
      timeoutMs: 3_000,
      onStep: async (step) => {
        steps.push(step)
        if (mode === 'rewrite' && failures === 1 && !checkedRewrite) {
          assert.equal(
            await fs.readFile(lockPath, 'utf8'),
            replacement,
            'retry must preserve the successor',
          )
          checkedRewrite = true
          // The successor now releases its own file; the contender never deletes it.
          await fs.rm(lockPath)
        }
      },
    },
    async (lock) => {
      await lock.assertOwned()
      committed = true
    },
  ).finally(() => holder.finish())
  assert.equal(failures, 1)
  assert.equal(committed, true)
  assert.ok(!steps.includes('stale-lock-removed'))
  assert.equal(checkedRewrite, mode === 'rewrite')
  console.log(
    JSON.stringify({
      action: mode,
      win32Code: observed.win32Code,
      reason: observed.reason,
      stage: observed.stage,
      failures,
      committed,
    }),
  )
}

async function holdForChange(action, replacement) {
  const script = `
    $ErrorActionPreference = 'Stop'
    [Console]::Out.WriteLine('started')
    [Console]::Out.Flush()
    if ([Console]::ReadLine() -ne 'open') { exit 0 }
    $options = if ($env:LOCK_READ_ACTION -eq 'delete') { [IO.FileOptions]::DeleteOnClose } else { [IO.FileOptions]::None }
    $file = [IO.FileStream]::new($env:LOCK_READ_PATH, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 4096, $options)
    try {
      [Console]::Out.WriteLine('ready')
      [Console]::Out.Flush()
      $null = [Console]::ReadLine()
      if ($env:LOCK_READ_ACTION -eq 'rewrite') {
        $bytes = [Text.Encoding]::UTF8.GetBytes($env:LOCK_READ_BYTES)
        $file.Position = 0
        $file.Write($bytes, 0, $bytes.Length)
        $file.SetLength($bytes.Length)
        $file.Flush()
      }
    } finally { $file.Dispose() }
  `
  const child = Bun.spawn(
    [
      'powershell.exe',
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ],
    {
      env: {
        ...process.env,
        LOCK_READ_PATH: lockPath,
        LOCK_READ_ACTION: action,
        LOCK_READ_BYTES: replacement,
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const stderr = new Response(child.stderr).text()
  const reader = child.stdout.getReader()
  async function line() {
    let text = ''
    while (!text.includes('\n')) {
      const result = await reader.read()
      if (result.done) {
        await child.exited
        assert.fail(`holder exited before its handshake: ${await stderr}`)
      }
      text += new TextDecoder().decode(result.value)
    }
    return text.trim()
  }
  assert.equal(await line(), 'started')
  let finishing
  return {
    async open() {
      child.stdin.write('open\n')
      await child.stdin.flush()
      assert.equal(await line(), 'ready')
    },
    finish() {
      finishing ??= (async () => {
        child.stdin.write('release\n')
        await child.stdin.end()
        assert.equal(await child.exited, 0, await stderr)
        assert.equal(await stderr, '')
        reader.releaseLock()
      })()
      return finishing
    },
  }
}
