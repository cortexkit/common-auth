import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  createPrivateDirectory,
  createPrivateFile,
  readOwnerOnly,
  readPrivateFile,
  securePrivatePath,
  verifyOwnerOnly,
  verifyPrivatePath,
} from '../../dist/index.js'

assert.equal(
  process.platform,
  'win32',
  'This is a required real Windows test, not a portable mock',
)
const root = join(
  process.env.USERPROFILE,
  `common-auth-private-${crypto.randomUUID()}`,
)
const reports = []
const latencies = []
const script = fileURLToPath(new URL('./inspect.ps1', import.meta.url))
const powershell = join(
  process.env.SystemRoot,
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)

function inspect(mode, data) {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const child = spawn(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-Mode',
        mode,
      ],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PSModulePath: join(
            process.env.SystemRoot,
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'Modules',
          ),
        },
      },
    )
    let stdout = '',
      stderr = ''
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`Inspector ${mode} timed out`))
    }, 60000)
    child.stdout.on('data', (bytes) => {
      stdout += bytes
      if (stdout.length > 1024 * 1024) child.kill()
    })
    child.stderr.on('data', (bytes) => {
      stderr += bytes
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      reports.push({
        inspector: mode,
        elapsedMs: performance.now() - started,
        exitCode: code,
      })
      if (code !== 0)
        reject(new Error(`Inspector ${mode} exited ${code}: ${stderr}`))
      else {
        try {
          resolve(JSON.parse(stdout.replace(/^\uFEFF/, '')))
        } catch (error) {
          reject(error)
        }
      }
    })
    child.stdin.end(JSON.stringify(data))
  })
}

async function canonical(path, directory) {
  const sd = await inspect('inspect', { path })
  reports.push({ name: path, descriptor: sd })
  assert.equal(sd.owner, sd.currentUser)
  assert.equal(sd.control & 0x1004, 0x1004, 'present protected DACL')
  assert.deepEqual(sd.aces, [
    { type: 0, flags: directory ? 3 : 0, mask: 0x1f01ff, sid: sd.currentUser },
  ])
}

async function refused(operation) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.code, 'ERR_PRIVATE_FILES_SECURITY')
    assert.equal(typeof error.win32Code, 'number')
    reports.push({ refusal: error.message, win32Code: error.win32Code })
    return true
  })
}

before(async () => {
  reports.push({
    environment: await inspect('environment', {}),
    node: process.versions.node,
    bun: process.versions.bun ?? null,
    arch: process.arch,
  })
  const start = performance.now()
  await createPrivateDirectory(root)
  reports.push({ coldCreateMs: performance.now() - start })
})
after(async () => {
  const artifacts =
    process.env.PRIVATE_FILES_ARTIFACTS ?? 'private-files-evidence'
  await mkdir(artifacts, { recursive: true })
  latencies.sort((a, b) => a - b)
  const quantile = (p) =>
    latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))]
  await writeFile(
    join(
      artifacts,
      `acl-${process.versions.bun ? `bun-${process.versions.bun}` : 'node'}-${process.arch}${process.env.PRIVATE_FILES_NEGATIVE_CONTROL ? '-negative' : ''}.json`,
    ),
    JSON.stringify(
      {
        reports,
        writes: latencies.length,
        timing: {
          p50: quantile(0.5),
          p95: quantile(0.95),
          p99: quantile(0.99),
        },
      },
      null,
      2,
    ),
  )
  await rm(root, { recursive: true, force: true })
})

test('real ACL creation, independent descriptors, same-handle read and standard-user denial', async () => {
  const directory = join(root, 'private')
  const file = join(directory, 'token')
  await createPrivateDirectory(directory)
  await createPrivateFile(file, 'secret')
  await canonical(directory, true)
  await canonical(file, false)
  assert.equal((await readPrivateFile(file)).toString(), 'secret')
  const probe = await inspect('probe', {
    file,
    directory,
    runtime: process.execPath,
  })
  assert.equal(probe.standardUser, true)
  assert.equal(probe.controlRead, true)
  assert.equal(probe.fileDenied, true)
  assert.equal(probe.directoryDenied, true)
  assert.equal(probe.standardWriter, true)
  reports.push({ probe })
})

test('foreign-grant fixture refuses before reading bytes', async () => {
  const file = join(root, 'foreign')
  await createPrivateFile(file, 'never consume')
  await inspect('fixture', { path: file, kind: 'foreign' })
  const sd = await inspect('inspect', { path: file })
  assert.ok(
    sd.aces.some((ace) => ace.sid === 'S-1-1-0'),
    'fixture must really grant Everyone',
  )
  await refused(() => readPrivateFile(file))
  await refused(() => verifyPrivatePath(file, 'file'))
})

test('null-DACL, empty-DACL and foreign-owner fixtures refuse', async () => {
  for (const kind of ['null', 'empty', 'owner']) {
    const file = join(root, kind)
    await createPrivateFile(file, 'must not be read')
    await inspect('fixture', { path: file, kind })
    const sd = await inspect('inspect', { path: file })
    reports.push({ fixture: kind, descriptor: sd })
    if (kind === 'null') assert.equal(sd.aces, null)
    if (kind === 'empty') assert.deepEqual(sd.aces, [])
    if (kind === 'owner') assert.notEqual(sd.owner, sd.currentUser)
    await refused(() => readPrivateFile(file))
    if (kind === 'owner') await refused(() => securePrivatePath(file, 'file'))
  }
})

test('junction leaf and junction ancestor refuse', async () => {
  const target = join(root, 'target')
  await createPrivateDirectory(target)
  await createPrivateFile(join(target, 'token'), 'secret')
  const junction = join(root, 'junction')
  await inspect('fixture', { path: junction, kind: 'junction', target })
  await refused(() => verifyPrivatePath(junction, 'directory'))
  await refused(() => readPrivateFile(join(junction, 'token')))
  await refused(() =>
    createPrivateFile(join(junction, 'new'), 'must not write'),
  )
})

test('unsafe writable ancestor refuses private children and new creation', async () => {
  const directory = join(root, 'unsafe')
  await createPrivateDirectory(directory)
  const file = join(directory, 'token')
  await createPrivateFile(file, 'secret')
  await inspect('fixture', { path: directory, kind: 'foreign' })
  await refused(() => readPrivateFile(file))
  await refused(() =>
    createPrivateFile(join(directory, 'new'), 'must not write'),
  )
})

test('explicit current-owner migration and same-directory rename retain owner-only ACL and denial', async () => {
  const directory = join(root, 'migration')
  await createPrivateDirectory(directory)
  const file = join(directory, 'legacy')
  await createPrivateFile(file, 'legacy bytes')
  await inspect('fixture', { path: file, kind: 'foreign' })
  await securePrivatePath(file, 'file')
  await canonical(file, false)
  assert.equal((await readPrivateFile(file)).toString(), 'legacy bytes')
  const staging = join(directory, 'staging')
  await createPrivateFile(staging, 'replacement')
  await rename(staging, file)
  await verifyPrivatePath(file, 'file')
  await canonical(file, false)
  assert.equal((await readPrivateFile(file)).toString(), 'replacement')
  reports.push({
    afterMigrationAndRename: await inspect('probe', {
      file,
      directory,
      runtime: process.execPath,
    }),
  })
})

test('canonical inherited file and token default owner are accepted only in a private parent', async () => {
  const file = join(root, 'compatible-inherited')
  await createPrivateFile(file, 'compatible bytes')
  await inspect('fixture', { path: file, kind: 'inherited' })
  await inspect('fixture', { path: file, kind: 'defaultOwner' })
  const sd = await inspect('inspect', { path: file })
  assert.equal(sd.owner, sd.defaultOwner)
  assert.equal(sd.aces[0].flags, 16)
  assert.equal(sd.control & 0x1000, 0)
  reports.push({ compatibleInherited: sd })
  assert.deepEqual(await verifyOwnerOnly(file), { ok: true })
  assert.equal((await readOwnerOnly(file)).toString(), 'compatible bytes')
})

test('inherited foreign grant refuses', async () => {
  const directory = join(root, 'inherited-foreign-dir')
  await createPrivateDirectory(directory)
  const file = join(directory, 'token')
  await createPrivateFile(file, 'secret')
  await inspect('fixture', { path: directory, kind: 'inheritableForeign' })
  await inspect('fixture', { path: file, kind: 'inherited' })
  const sd = await inspect('inspect', { path: file })
  assert.ok(sd.aces.some((ace) => ace.sid === 'S-1-1-0' && ace.flags & 16))
  await refused(() => readOwnerOnly(file))
})

test('real Rust writers interoperate with typed verifier and same-handle reader', async () => {
  const executable = fileURLToPath(
    new URL(
      '../fixtures/rust/target/debug/private-files-rust-fixture.exe',
      import.meta.url,
    ),
  )
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [root], { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Rust fixture exited ${code}`)),
    )
  })
  const fixtures = [
    ['rust-subc-file', 'rust-subc'],
    ['rust-lease-dir/protected-file', 'rust-lease'],
    ['rust-lease-dir/inherited-file', 'rust-inherited'],
  ]
  const directory = join(root, 'rust-lease-dir')
  reports.push({ rustDirectory: await inspect('inspect', { path: directory }) })
  assert.deepEqual(await verifyOwnerOnly(directory), { ok: true })
  for (const [name, expected] of fixtures) {
    const file = join(root, name)
    const sd = await inspect('inspect', { path: file })
    reports.push({ rustFixture: name, descriptor: sd })
    assert.deepEqual(
      await verifyOwnerOnly(file),
      { ok: true },
      `Rust ACL refused: ${JSON.stringify(sd)}`,
    )
    assert.equal(
      (await readOwnerOnly(file)).toString(),
      expected,
      `Rust ACL: ${JSON.stringify(sd)}`,
    )
  }
})

test('warm secure writes yield to the event loop and record latency', async () => {
  let ticks = 0
  const timer = setInterval(() => {
    ticks++
  }, 1)
  try {
    await Promise.all(
      Array.from({ length: 32 }, async (_, index) => {
        const start = performance.now()
        const file = join(root, `timing-${index}`)
        await createPrivateFile(file, Buffer.alloc(1024 * 1024, 42))
        latencies.push(performance.now() - start)
        assert.equal((await readFile(file)).length, 1024 * 1024)
      }),
    )
  } finally {
    clearInterval(timer)
  }
  assert.ok(ticks > 0, 'async work must not monopolize the JS event loop')
  reports.push({ eventLoopTicks: ticks })
})
