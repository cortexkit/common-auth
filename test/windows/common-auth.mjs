import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  access as fsAccess,
  readFile as fsReadFile,
  rm as fsRm,
  writeFile as fsWriteFile,
  mkdir,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createOwnerOnly } from '@cortexkit/private-files'
import { createDumper } from '../../dist/dump/index.js'
import {
  acquireRefreshFileLock as acquireLease,
  writeJsonAtomic as atomicWrite,
  PrivateFileError,
} from '../../dist/fs/index.js'
import { readPrivateText, verifyPrivate } from '../../dist/fs/private-files.js'
import { createLoggerInstance } from '../../dist/logger/index.js'
import { openPiSlot as piSlot } from '../../dist/pi-slot/index.js'
import {
  discoverPortFile as discoverPort,
  writePortFile as writePort,
} from '../../dist/rpc/port-file.js'
import { createSidebarFile } from '../../dist/sidebar-file/index.js'
import {
  ownChild,
  pending,
  progress,
  timedOut,
  watchdogFailures,
  withWatchdog,
} from './watchdog.mjs'

const runner = process.versions.bun
  ? await import('bun:test')
  : await import('node:test')
const nativeTest = runner.test
const registerTest = nativeTest
const after = process.versions.bun ? runner.afterAll : runner.after
let registeredTests = 0
function test(name, options, body) {
  const budget =
    name.includes('second user') || name.includes('migration') ? 60_000 : 30_000
  registeredTests++
  progress('test-registered', {
    name,
    count: registeredTests,
    runner: process.versions.bun ? 'bun:test' : 'node:test',
  })
  const run = () => withWatchdog(name, budget, body)
  if (process.versions.bun) registerTest(name, run, budget + 10_000)
  else registerTest(name, { ...options, timeout: budget + 10_000 }, run)
}
after(() => {
  // Native IO cannot be cancelled. A failed watchdog must not leave the runner
  // alive indefinitely after all tests have reported their failures.
  if (watchdogFailures) setTimeout(() => process.exit(1), 1_000)
})

const access = (path) => pending(`access ${path}`, () => fsAccess(path))
const readFile = (path, ...args) =>
  pending(`readFile ${path}`, () => fsReadFile(path, ...args))
const writeFile = (path, ...args) =>
  pending(`evidence write ${path}`, () => fsWriteFile(path, ...args))
const rm = (path, options) => {
  if (timedOut()) {
    progress('private-fixture-retained', { path })
    return Promise.resolve()
  }
  return pending(`cleanup ${path}`, () => fsRm(path, options))
}
const writeJsonAtomic = (path, ...args) =>
  pending(`atomic JSON ${path}`, () => atomicWrite(path, ...args))
const writePortFile = (path, ...args) =>
  pending(`RPC port publication ${path}`, () => writePort(path, ...args))
const discoverPortFile = (path, ...args) =>
  pending(`RPC discovery ${path}`, () => discoverPort(path, ...args))
async function acquireRefreshFileLock(options) {
  const lease = await pending(`lease acquire ${options.path}`, () =>
    acquireLease({
      ...options,
      onStep: async (step) => {
        progress('lease-step', { step })
        await options.onStep?.(step)
      },
    }),
  )
  return (
    lease && {
      ...lease,
      assertOwned: () =>
        pending(`lease assertOwned ${options.path}`, () => lease.assertOwned()),
      release: () =>
        pending(`lease release ${options.path}`, () => lease.release()),
    }
  )
}
function openPiSlot(options) {
  const slot = piSlot(options)
  return {
    inspect: () =>
      pending(`Pi inspect ${options.authPath}`, () => slot.inspect()),
    enterVault: () =>
      pending(`Pi stash enter ${options.stashPath}`, () => slot.enterVault()),
    exitVault: () =>
      pending(`Pi stash exit ${options.stashPath}`, () => slot.exitVault()),
  }
}

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
try {
  await withWatchdog('harness evidence setup', 10_000, () =>
    pending('evidence directory mkdir', () =>
      mkdir(evidence, { recursive: true }),
    ),
  )
} catch (error) {
  setTimeout(() => process.exit(1), 1_000)
  throw error
}
const powershell = join(
  process.env.SystemRoot,
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)
const timeout = 45_000

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
  ownChild(child)
  let output = ''
  let errors = ''
  child.stdout.on('data', (bytes) => {
    output += bytes
    progress('powershell-stdout', {
      script,
      action: request.action,
      output: bytes.toString(),
    })
  })
  child.stderr.on('data', (bytes) => {
    errors += bytes
    progress('powershell-stderr', {
      script,
      action: request.action,
      output: bytes.toString(),
    })
  })
  child.stdin.end(JSON.stringify(request))
  const done = pending(
    `PowerShell ${script} ${request.action ?? 'hold'}`,
    () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill()
          reject(new Error(`${script} timed out`))
        }, timeout)
        child.on('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          code === 0
            ? resolve(output.trim())
            : reject(new Error(`${script} failed (${code}): ${errors}`))
        })
      }),
  )
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
  await pending(`private root create ${root}`, () =>
    createOwnerOnly(root, { kind: 'dir' }),
  )
  return root
}
async function hold(path, holdMs) {
  const running = helper('hold.ps1', { path, holdMs })
  await pending(
    `wait for no-delete-sharing handle ${path}`,
    () =>
      new Promise((resolve, reject) => {
        let output = ''
        running.child.stdout.on('data', (bytes) => {
          output += bytes
          if (output.includes('ready')) resolve()
        })
        running.done.catch(reject)
      }),
  )
  return running
}

test('real admin config parent permits write read lock and RPC publication', {
  timeout,
}, async () => {
  const dir = join(process.env.USERPROFILE, '.config', 'opencode')
  await mkdir(dir, { recursive: true })
  const before = JSON.parse(
    await helper('inspect.ps1', {
      action: 'inspect',
      paths: [dir, process.env.USERPROFILE],
    }).done,
  )
  assert.ok(
    before.objects[0].aces.some(
      (ace) => ace.sid === 'S-1-5-18' && ace.flags & 16,
    ),
  )
  const path = join(dir, `common-auth-${randomUUID()}.json`)
  let port
  try {
    await writeJsonAtomic(path, { realConfig: true })
    assert.deepEqual(JSON.parse(await readPrivateText(path)), {
      realConfig: true,
    })
    const lease = await acquireRefreshFileLock({
      path,
      name: 'config-proof',
      ttlMs: 30_000,
      renew: false,
    })
    assert.ok(lease)
    await lease.assertOwned()
    assert.equal(
      await acquireRefreshFileLock({
        path,
        name: 'config-proof',
        ttlMs: 30_000,
        renew: false,
      }),
      null,
    )
    await lease.release()
    port = await writePortFile(dir, {
      port: 34567,
      token: 'config-proof-token',
      pid: process.pid,
    })
    assert.equal(
      JSON.parse(await readPrivateText(port)).token,
      'config-proof-token',
    )
    await inspect([path, port], 'real-admin-config-files')
    const after = JSON.parse(
      await helper('inspect.ps1', {
        action: 'inspect',
        paths: [dir, process.env.USERPROFILE],
      }).done,
    )
    assert.deepEqual(
      after.objects,
      before.objects,
      'existing profile/config ACLs must not be tightened',
    )
    await writeFile(
      join(evidence, 'real-admin-config-parent.json'),
      JSON.stringify(after, null, 2),
    )
  } finally {
    await rm(path, { force: true })
    if (port) await rm(port, { force: true })
  }
})

test('real standard second user config supports inherited secret migration and all writers', {
  timeout,
}, async () => {
  const result = JSON.parse(
    await helper('inspect.ps1', {
      action: 'config-user',
      runtime: process.execPath,
    }).done,
  )
  assert.equal(result.standardUser, true)
  assert.equal(result.sid, process.env.COMMON_AUTH_PROBE_SID)
  for (const name of ['write', 'read', 'lock', 'migration', 'rpc'])
    assert.equal(result.checks[name], true)
  assert.equal(result.checks.runtime, process.versions.bun ?? process.version)
  assert.match(result.checks.dir, /\\\.config\\opencode$/i)
  assert.ok(
    result.before.aces.some((ace) => ace.flags & 16 && ace.sid === 'S-1-5-18'),
  )
  await writeFile(
    join(evidence, 'real-standard-config-migration.json'),
    JSON.stringify(result, null, 2),
  )
})

test('runner temp and Users Modify parents refuse with writable-by-others', {
  timeout,
}, async () => {
  assert.ok(process.env.RUNNER_TEMP)
  const root = await privateRoot()
  try {
    await helper('inspect.ps1', { action: 'users-modify', path: root }).done
    for (const parent of [process.env.RUNNER_TEMP, root]) {
      const path = join(parent, `common-auth-refused-${randomUUID()}.json`)
      await assert.rejects(
        writeJsonAtomic(path, { secret: 'never written' }),
        (error) =>
          error instanceof PrivateFileError &&
          error.reason === 'writable-by-others',
      )
      await assert.rejects(access(path))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Administrators-owned inherited legacy file migrates in place without changing ownership', {
  timeout,
}, async () => {
  const dir = join(process.env.USERPROFILE, '.config', 'opencode')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `common-auth-admin-legacy-${randomUUID()}.json`)
  try {
    await helper('inspect.ps1', { action: 'admin-legacy', path }).done
    const before = JSON.parse(
      await helper('inspect.ps1', { action: 'inspect', paths: [path] }).done,
    )
    assert.equal(before.objects[0].owner, 'S-1-5-32-544')
    assert.equal(before.objects[0].control & 0x1000, 0)
    assert.ok(
      before.objects[0].aces.some(
        (ace) => ace.flags & 16 && ace.sid === 'S-1-5-18',
      ),
    )
    await verifyPrivate(path, 'file', true)
    assert.deepEqual(JSON.parse(await readPrivateText(path)), { legacy: true })
    const after = JSON.parse(
      await helper('inspect.ps1', { action: 'inspect', paths: [path] }).done,
    )
    assert.equal(after.objects[0].owner, before.objects[0].owner)
    assert.equal(after.objects[0].control & 0x1004, 0x1004)
    assert.deepEqual(after.objects[0].aces, [
      { type: 0, flags: 0, mask: 0x1f01ff, sid: after.sid },
    ])
    await writeFile(
      join(evidence, 'admin-owned-legacy-migration.json'),
      JSON.stringify({ before, after }, null, 2),
    )
  } finally {
    await rm(path, { force: true })
  }
})

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
    await pending('sidebar write', () =>
      sidebar.write({ active: 'private fixture' }),
    )
    assert.deepEqual(await pending('sidebar read', () => sidebar.read()), {
      active: 'private fixture',
    })
    const logPath = join(root, 'logs', 'private.log')
    const logger = createLoggerInstance({ file: logPath })
    logger.createLogger('qualification').info('ordered one')
    const firstFlush = logger.flushLogs()
    logger.createLogger('qualification').info('ordered two')
    await pending('ordered logger flush', () =>
      Promise.all([firstFlush, logger.flushLogs()]),
    )
    const log = await readFile(logPath, 'utf8')
    assert.ok(log.indexOf('ordered one') < log.indexOf('ordered two'))
    for (let batch = 0; batch < 50; batch++)
      for (let line = 0; line < 50; line++)
        logger.createLogger('qualification').info(`append ${batch} ${line}`)
    await pending('persistent logger append and close', () =>
      logger.flushLogs(),
    )
    const appendedLog = await readFile(logPath, 'utf8')
    assert.equal(appendedLog.split('\n').length - 1, 2502)
    await writeJsonAtomic(logPath, null, {
      serialize: () => `${appendedLog}${'x'.repeat(5 * 1024 * 1024)}`,
    })
    logger.createLogger('qualification').info('after rotation')
    await pending('verified logger rotation and close', () =>
      logger.flushLogs(),
    )
    assert.ok((await readFile(`${logPath}.1`, 'utf8')).startsWith(appendedLog))
    assert.ok((await readFile(logPath, 'utf8')).includes('after rotation'))
    const dumper = createDumper({ dir: join(root, 'dumps'), enabled: true })
    const dump = await pending('dump artifacts', () =>
      dumper.dump({
        channel: 'qualification',
        session: 'private',
        bodyText: '{"prompt":"private prompt fixture"}',
      }),
    )
    assert.ok(dump)
    const response = await pending('dump response', () =>
      dumper.dumpResponse(dump, {
        status: 200,
        fields: { private: 'fixture' },
      }),
    )
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
    await pending(
      'wait for first lease renewal-finished callback',
      () => renewed,
    )
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
      `${logPath}.1`,
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
    if (!timedOut()) await lease?.release()
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
    for (const fixture of [path, sibling])
      await helper('inspect.ps1', { action: 'grant', path: fixture }).done
    const before = JSON.parse(
      await helper('inspect.ps1', {
        action: 'inspect',
        paths: [parent, path, sibling],
      }).done,
    )
    for (const fixture of before.objects.slice(1))
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
    await pending('sidebar permission migration and update', () =>
      sidebar.update((current) => ({ ...current, migrated: true })),
    )
    assert.deepEqual(await pending('sidebar read', () => sidebar.read()), {
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
      pending('native missing-file read', () => readPrivateText(path)),
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
