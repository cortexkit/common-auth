import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// This child overrides process.platform and mocks async filesystem calls before loading the logger, leaving the parent runner's POSIX module cache and filesystem unchanged.
const original = { ...fs }
const root = await original.mkdtemp(join(tmpdir(), 'windows-log-'))
const mode = process.argv[2]
const file = join(root, 'private.log')
let reads = 0
let replacements = 0
let creates = 0
let verifications = 0
let opens = 0
let closes = 0
let appends = 0
let failOpen = false
let failAppend = false
let denyLeaf = false
let appended
const live = new Set()
Object.defineProperty(process, 'platform', { value: 'win32' })
mock.module('node:fs/promises', () => ({
  ...original,
  rename: async (...args) => {
    replacements++
    return original.rename(...args)
  },
  open: async (...args) => {
    opens++
    if (failOpen) {
      failOpen = false
      throw Object.assign(new Error('open refused'), { code: 'EPERM' })
    }
    const handle = await original.open(...args)
    live.add(handle)
    return {
      stat: () => handle.stat(),
      appendFile: async (...values) => {
        if (failAppend) {
          failAppend = false
          throw Object.assign(new Error('append refused'), { code: 'EACCES' })
        }
        await handle.appendFile(...values)
        appends++
        appended?.()
      },
      close: async () => {
        await handle.close()
        live.delete(handle)
        closes++
      },
    }
  },
}))
const api = await import('@cortexkit/private-files')
const { setPrivateFilesBackendForTest, PrivateFileError } = await import(
  '../../src/fs/private-files.ts'
)
setPrivateFilesBackendForTest({
  ...api,
  createOwnerOnly: (path) => original.mkdir(path),
  createPrivateFile: async (path, bytes) => {
    creates++
    await original.writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
  },
  verifyOwnerOnly: async (path) => {
    verifications++
    await original.stat(path)
    return denyLeaf && path === file
      ? { ok: false, refusal: { reason: api.WRONG_OWNER, ownerSid: 'foreign' } }
      : { ok: true }
  },
  verifyPrivatePath: async (path, kind) => {
    const info = await original.stat(path)
    assert.ok(kind === 'file' ? info.isFile() : info.isDirectory())
  },
  readOwnerOnly: async (path) => {
    reads++
    return original.readFile(path)
  },
})
const { createLoggerInstance } = await import('../../src/logger/engine.ts')
const logger = createLoggerInstance({ file, level: 'debug' })
const log = logger.createLogger('append')
async function automaticFlush(message) {
  await new Promise((resolve) => {
    appended = resolve
    for (let i = 0; i < 50; i++) log.debug(`${message} ${i}`)
  })
  appended = undefined
}
try {
  if (mode === 'steady') {
    await automaticFlush('batch 0')
    const first = { reads, replacements, creates, verifications, opens }
    logger.configure({ file, level: 'debug' })
    for (let i = 1; i < 50; i++) await automaticFlush(`batch ${i}`)
    assert.equal(reads - first.reads, 0, 'steady flushes must not read the log')
    assert.equal(
      replacements - first.replacements,
      0,
      'steady flushes must not replace the log',
    )
    assert.equal(
      creates - first.creates,
      0,
      'steady flushes must not rewrite private stages',
    )
    assert.equal(
      verifications - first.verifications,
      0,
      'steady flushes must retain the verified handle',
    )
    assert.equal(opens, 1, 'automatic flushes must share one append handle')
    assert.equal(appends, 50)
    await logger.flushLogs()
    assert.equal(live.size, 0, 'explicit flush must close the append handle')
    assert.equal(closes, 1)
    const bytes = await original.readFile(file, 'utf8')
    assert.equal(bytes.split('\n').length - 1, 2500)
    assert.ok(bytes.indexOf('batch 0 0') < bytes.indexOf('batch 49 49'))
    console.log(
      JSON.stringify({
        mode,
        flushes: 50,
        readsAfterFirst: 0,
        replacementsAfterFirst: 0,
        opens,
        closes,
      }),
    )
  } else if (mode === 'rotation') {
    await original.writeFile(file, 'x'.repeat(5 * 1024 * 1024))
    log.info('after rotation')
    await logger.flushLogs()
    assert.equal((await original.stat(`${file}.1`)).size, 5 * 1024 * 1024)
    assert.match(await original.readFile(file, 'utf8'), /after rotation/)
    assert.equal(reads, 0)
    assert.equal(replacements, 1)
    assert.equal(live.size, 0)
    console.log(JSON.stringify({ mode, checked: true }))
  } else if (mode === 'refusal') {
    await original.writeFile(file, 'existing')
    denyLeaf = true
    log.info('must not append')
    await assert.rejects(
      logger.flushLogs(),
      (error) =>
        error instanceof PrivateFileError &&
        error.path === file &&
        error.stage === 'verify',
    )
    assert.equal(opens, 0)
    assert.equal(appends, 0)
    assert.equal(creates, 0)
    assert.equal(await original.readFile(file, 'utf8'), 'existing')
    console.log(JSON.stringify({ mode, checked: true }))
  } else if (mode === 'lifecycle') {
    await automaticFlush('before configure')
    const second = join(root, 'second.log')
    logger.configure({ file: second })
    log.info('after configure')
    await logger.flushLogs()
    assert.match(await original.readFile(file, 'utf8'), /before configure/)
    assert.doesNotMatch(
      await original.readFile(file, 'utf8'),
      /after configure/,
    )
    assert.match(await original.readFile(second, 'utf8'), /after configure/)
    assert.equal(live.size, 0)
    failOpen = true
    log.info('open error')
    await assert.rejects(
      logger.flushLogs(),
      (error) =>
        error instanceof PrivateFileError &&
        error.stage === 'log-open' &&
        error.code === 'EPERM',
    )
    log.info('open recovery')
    await logger.flushLogs()
    failAppend = true
    log.info('append error')
    await assert.rejects(
      logger.flushLogs(),
      (error) =>
        error instanceof PrivateFileError &&
        error.stage === 'log-append' &&
        error.code === 'EACCES',
    )
    assert.equal(live.size, 0)
    const verified = verifications
    log.info('append recovery')
    await logger.flushLogs()
    assert.ok(
      verifications > verified,
      'append recovery must verify before reopening',
    )
    assert.match(await original.readFile(second, 'utf8'), /append recovery/)
    assert.equal(live.size, 0)
    console.log(JSON.stringify({ mode, checked: true }))
  } else throw new Error(`unknown mode ${mode}`)
} finally {
  for (const handle of live) await handle.close()
  await original.rm(root, { recursive: true, force: true })
}
