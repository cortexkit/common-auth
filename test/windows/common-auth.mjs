import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createOwnerOnly } from '@cortexkit/private-files'
import { createDumper } from '../../dist/dump/index.js'
import {
  acquireRefreshFileLock,
  PrivateFileError,
  writeJsonAtomic,
} from '../../dist/fs/index.js'
import { createLoggerInstance } from '../../dist/logger/index.js'
import { openPiSlot } from '../../dist/pi-slot/index.js'
import { discoverPortFile, writePortFile } from '../../dist/rpc/port-file.js'
import { createSidebarFile } from '../../dist/sidebar-file/index.js'

assert.ok(
  process.env.LOCALAPPDATA,
  'Windows requires a per-user local application-data root',
)
assert.equal(process.platform, 'win32', 'this harness must run on real Windows')
const here = dirname(fileURLToPath(import.meta.url))
const evidence = resolve(
  'windows-private-files-evidence',
  `${process.release.name}-${process.versions.bun ?? process.version}-${process.arch}`,
)
await mkdir(evidence, { recursive: true })
const powershell = join(
  process.env.SystemRoot,
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)
const timeout = 120_000

function helper(script, request) {
  // pwsh's module paths are incompatible with Windows PowerShell 5.1. Let the
  // child rebuild its own default module paths instead of inheriting pwsh's.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key.toUpperCase() !== 'PSMODULEPATH',
    ),
  )
  const child = spawn(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(here, script),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env },
  )
  let output = ''
  let errors = ''
  child.stdout.on('data', (bytes) => {
    output += bytes
  })
  child.stderr.on('data', (bytes) => {
    errors += bytes
  })
  child.stdin.end(JSON.stringify(request))
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${script} timed out`))
    }, timeout)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      code === 0
        ? resolve(output.trim())
        : reject(new Error(`${script} failed (${code}): ${errors}`))
    })
  })
  return { child, done }
}
async function inspect(paths, label) {
  const result = JSON.parse(
    await helper('inspect.ps1', { action: 'inspect', paths }).done,
  )
  assert.equal(result.filesystem, 'NTFS')
  for (const object of result.objects) {
    assert.equal(object.owner, result.sid)
    assert.ok(
      (object.control & 0x1004) === 0x1004,
      `protected present DACL: ${object.path}`,
    )
    assert.deepEqual(object.aces, [
      {
        type: 0,
        flags: object.directory ? 3 : 0,
        mask: 0x1f01ff,
        sid: result.sid,
      },
    ])
  }
  await writeFile(
    join(evidence, `${label}.json`),
    JSON.stringify(result, null, 2),
  )
}
async function privateRoot() {
  const root = join(
    process.env.LOCALAPPDATA,
    `common-auth-windows-${randomUUID()}`,
  )
  await createOwnerOnly(root, { kind: 'dir' })
  return root
}
async function hold(path, holdMs) {
  const running = helper('hold.ps1', { path, holdMs })
  await new Promise((resolve, reject) => {
    let output = ''
    running.child.stdout.on('data', (bytes) => {
      output += bytes
      if (output.includes('ready')) resolve()
    })
    running.done.catch(reject)
  })
  return running
}

test('real writers have independently inspected ACLs and deny a standard second user', {
  timeout,
}, async () => {
  const root = await privateRoot()
  let lease
  try {
    const atomic = join(root, 'state.json')
    await writeJsonAtomic(atomic, { secret: 'private fixture' })
    const port = await writePortFile(
      join(root, 'rpc'),
      { port: 12345, token: 'private bearer fixture', pid: process.pid },
      { secureDir: true },
    )
    const sidebarPath = join(root, 'sidebar', 'state.json')
    const sidebar = createSidebarFile({
      path: sidebarPath,
      defaultValue: {},
      normalize: (value) => value,
    })
    await sidebar.write({ active: 'private fixture' })
    assert.deepEqual(await sidebar.read(), { active: 'private fixture' })
    const logPath = join(root, 'logs', 'private.log')
    const logger = createLoggerInstance({ file: logPath })
    logger.createLogger('qualification').info('ordered one')
    const firstFlush = logger.flushLogs()
    logger.createLogger('qualification').info('ordered two')
    await Promise.all([firstFlush, logger.flushLogs()])
    const log = await readFile(logPath, 'utf8')
    assert.ok(log.indexOf('ordered one') < log.indexOf('ordered two'))
    const dumper = createDumper({ dir: join(root, 'dumps'), enabled: true })
    const dump = await dumper.dump({
      channel: 'qualification',
      session: 'private',
      bodyText: '{"prompt":"private prompt fixture"}',
    })
    assert.ok(dump)
    const response = await dumper.dumpResponse(dump, {
      status: 200,
      fields: { private: 'fixture' },
    })
    assert.ok(response)
    const authPath = join(root, 'pi', 'auth.json')
    const stashPath = join(root, 'stash', 'pi.json')
    await writeJsonAtomic(authPath, {
      anthropic: { type: 'api_key', key: 'private pi fixture' },
    })
    const slot = openPiSlot({
      authPath,
      stashPath,
      provider: 'anthropic',
      placeholderKey: 'vault-managed',
      privateParents: true,
    })
    await slot.enterVault()
    assert.deepEqual(await slot.inspect(), {
      slot: 'placeholder',
      stash: 'valid',
    })
    let finishRenewal
    const renewed = new Promise((resolve) => {
      finishRenewal = resolve
    })
    let markerInspected = false
    let initialExpiry
    lease = await acquireRefreshFileLock({
      path: atomic,
      name: 'qualification',
      ttlMs: 30_000,
      renew: true,
      renewIntervalMs: 20,
      onStep: async (step) => {
        if (step === 'renewal-owner-confirmed' && initialExpiry === undefined) {
          initialExpiry = JSON.parse(
            await readFile(`${atomic}.qualification.lock`, 'utf8'),
          ).expiresAt
        }
        if (step === 'renewal-finished') finishRenewal()
        if (step === 'eviction-marker-acquired' && !markerInspected) {
          markerInspected = true
          const marker = `${atomic}.qualification.lock.evicting`
          await inspect([marker, join(marker, 'owner.json')], 'lease-marker')
        }
      },
    })
    assert.ok(lease)
    assert.equal(
      await acquireRefreshFileLock({
        path: atomic,
        name: 'qualification',
        ttlMs: 30_000,
      }),
      null,
    )
    await lease.assertOwned()
    const leasePath = `${atomic}.qualification.lock`
    await renewed
    await lease.assertOwned()
    assert.ok(
      JSON.parse(await readFile(leasePath, 'utf8')).expiresAt > initialExpiry,
    )
    await lease.release()
    await lease.release()
    lease = await acquireRefreshFileLock({
      path: atomic,
      name: 'qualification',
      ttlMs: 30_000,
    })
    assert.ok(lease)
    const files = [
      atomic,
      port,
      sidebarPath,
      logPath,
      ...Object.values(dump.files),
      response,
      authPath,
      stashPath,
      leasePath,
    ]
    const directories = [root, ...new Set(files.map(dirname))]
    await inspect([...new Set([...directories, ...files])], 'writers')
    const denial = JSON.parse(
      await helper('inspect.ps1', {
        action: 'deny',
        directory: root,
        paths: files,
      }).done,
    )
    assert.equal(denial.publicRead, true)
    assert.equal(denial.standardUser, true)
    assert.equal(denial.directoryDenied, true)
    assert.equal(denial.filesDenied, true)
    assert.equal(denial.fileCount, files.length)
    await writeFile(
      join(evidence, 'second-user.json'),
      JSON.stringify(denial, null, 2),
    )
    await lease.release()
    await lease.release()
    lease = undefined
    await assert.rejects(access(leasePath))
    await assert.rejects(access(`${leasePath}.evicting`))
    assert.equal(await slot.exitVault(), 'restored')
    await assert.rejects(access(stashPath))
    assert.equal(
      JSON.parse(await readFile(authPath, 'utf8')).anthropic.key,
      'private pi fixture',
    )
  } finally {
    await lease?.release()
    await rm(root, { recursive: true, force: true })
  }
})

test('sharing violation released within retry budget publishes complete replacement', {
  timeout,
}, async () => {
  const root = await privateRoot()
  try {
    const path = join(root, 'replace.json')
    await writeJsonAtomic(path, { old: true })
    const held = await hold(path, 120)
    let missing = 0
    const observations = []
    const monitor = setInterval(() => {
      observations.push(
        access(path).catch(() => {
          missing++
        }),
      )
    }, 1)
    try {
      await writeJsonAtomic(path, { new: true })
    } finally {
      clearInterval(monitor)
      await held.done
      await Promise.all(observations)
    }
    assert.equal(missing, 0, 'destination was never unlinked')
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { new: true })
    await inspect([root, path], 'sharing-replaced')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('sharing violation beyond retry budget keeps the complete old destination', {
  timeout,
}, async () => {
  const root = await privateRoot()
  try {
    const path = join(root, 'replace.json')
    await writeJsonAtomic(path, { old: true })
    const before = await readFile(path)
    const held = await hold(path, 1_000)
    let failure
    try {
      await assert.rejects(writeJsonAtomic(path, { new: true }), (error) => {
        failure = error
        return (
          error instanceof PrivateFileError &&
          !error.published &&
          error.stage === 'rename'
        )
      })
      assert.deepEqual(await readFile(path), before)
      await writeFile(
        join(evidence, 'sharing-refusal.json'),
        JSON.stringify(
          {
            stage: failure.stage,
            code: failure.code,
            win32Code: failure.win32Code,
            attempts: failure.attempts,
            elapsedMs: failure.elapsedMs,
            published: failure.published,
          },
          null,
          2,
        ),
      )
    } finally {
      await held.done
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('unsafe private parent refuses before any secret file is written', {
  timeout,
}, async () => {
  const root = await privateRoot()
  try {
    await helper('inspect.ps1', { action: 'grant', path: root }).done
    const path = join(root, 'must-not-exist.json')
    await assert.rejects(
      writeJsonAtomic(path, { secret: 'never write this' }),
      (error) => error instanceof PrivateFileError && !error.published,
    )
    await assert.rejects(access(path))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('foreign grant on a port token is a typed refusal not discovery fallback', {
  timeout,
}, async () => {
  const root = await privateRoot()
  try {
    const path = await writePortFile(root, {
      port: 12345,
      pid: process.pid,
      token: 'never disclose this',
    })
    await helper('inspect.ps1', { action: 'grant', path }).done
    await assert.rejects(
      discoverPortFile(root, process.pid),
      (error) =>
        error instanceof PrivateFileError &&
        error.stage === 'read' &&
        !error.message.includes('never disclose this'),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('dedicated sidebar migration repairs owned objects without rewriting siblings', {
  timeout,
}, async () => {
  const root = await privateRoot()
  try {
    const parent = join(root, 'sidebar')
    const path = join(parent, 'state.json')
    const sibling = join(parent, 'unrelated.json')
    await writeJsonAtomic(path, { retained: 'private migration fixture' })
    await writeJsonAtomic(sibling, { unrelated: true })
    for (const fixture of [parent, path, sibling])
      await helper('inspect.ps1', { action: 'grant', path: fixture }).done
    const before = JSON.parse(
      await helper('inspect.ps1', {
        action: 'inspect',
        paths: [parent, path, sibling],
      }).done,
    )
    for (const fixture of before.objects)
      assert.ok(
        fixture.aces.some((ace) => ace.sid === 'S-1-1-0'),
        'foreign-grant fixture really exists',
      )
    const sidebar = createSidebarFile({
      path,
      defaultValue: {},
      normalize: (value) => value,
      secureDir: true,
    })
    await sidebar.update((current) => ({ ...current, migrated: true }))
    assert.deepEqual(await sidebar.read(), {
      retained: 'private migration fixture',
      migrated: true,
    })
    await inspect([root, parent, path], 'migration')
    const after = JSON.parse(
      await helper('inspect.ps1', { action: 'inspect', paths: [sibling] }).done,
    )
    assert.deepEqual(
      after.objects[0].aces,
      before.objects[2].aces,
      'migration must not rewrite an existing sibling',
    )
    const denial = JSON.parse(
      await helper('inspect.ps1', {
        action: 'deny',
        directory: parent,
        paths: [path],
      }).done,
    )
    assert.equal(denial.publicRead, true)
    assert.equal(denial.filesDenied, true)
    await writeFile(
      join(evidence, 'migration-second-user.json'),
      JSON.stringify(denial, null, 2),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('native absence and exclusive collision retain precise adapter codes', {
  timeout,
}, async () => {
  const { readPrivateText } = await import('../../dist/fs/private-files.js')
  const root = await privateRoot()
  try {
    const path = join(root, 'state.json')
    await assert.rejects(
      readPrivateText(path),
      (error) =>
        error instanceof PrivateFileError &&
        error.code === 'ENOENT' &&
        [2, 3].includes(error.win32Code),
    )
    await writeJsonAtomic(path, { old: true })
    const stage = `${path}.collision.tmp`
    await writeJsonAtomic(stage, { collision: true })
    await assert.rejects(
      writeJsonAtomic(path, { new: true }, { stageName: () => 'collision' }),
      (error) =>
        error instanceof PrivateFileError &&
        error.code === 'EEXIST' &&
        [80, 183].includes(error.win32Code) &&
        !error.published,
    )
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { old: true })
    assert.deepEqual(JSON.parse(await readFile(stage, 'utf8')), {
      collision: true,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
