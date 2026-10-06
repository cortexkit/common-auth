import { beforeEach, describe, expect } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  createCaptureSink,
  createLogger,
  createLoggerInstance,
  flushLogs,
  initLogger,
  resetLoggerForTest,
  setLogLevel,
} from '../../src/logger/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'

import { makeTempDir } from '../fixtures/scratch.js'

const hooks = lifetimeHooks()
const { afterEach, it } = hooks

let dir: string
let logFile: string
beforeEach(async () => {
  dir = await makeTempDir('logger-')
  logFile = join(dir, 'test.log')
  // configuredLevel() prefers the runtime level set by setLogLevel over the
  // floor a host passed to initLogger, so clear any runtime level a prior test
  // left set — these tests drive level through initLogger only.
  setLogLevel(undefined)
  initLogger({ file: logFile })
})
afterEach(() => {
  // Leave the logger uninitialised so a later test that asserts the
  // never-initialised behaviour is not writing into this test's file.
  resetLoggerForTest()
  rmSync(dir, { recursive: true, force: true })
})

describe('logger levels', () => {
  it('suppresses debug when level=info, includes warn', async () => {
    initLogger({ file: logFile, level: 'info' })
    const { createLogger, flushForTest } = await import(
      '../../src/logger/index.js'
    )
    const log = createLogger('quota')
    log.debug('hidden-debug-line')
    log.warn('shown-warn-line')
    await flushForTest()
    const txt = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
    expect(statSync(logFile).mode & 0o777).toBe(0o600)
    expect(txt).not.toContain('hidden-debug-line')
    expect(txt).toContain('shown-warn-line')
    expect(txt).toContain('[quota]')
  })
})

describe('logger safety', () => {
  it('circular payload preserves non-circular fields and marks [Circular]', async () => {
    initLogger({ file: logFile, level: 'debug' })
    const { createLogger, flushForTest } = await import(
      '../../src/logger/index.js'
    )
    const log = createLogger('transport')
    const circ: Record<string, unknown> = {
      name: 'x',
      secret_token: 'sk-LEAKME123',
      nested: { ok: 1 },
    }
    circ.self = circ
    expect(() => log.debug('circ-msg', circ)).not.toThrow()
    await flushForTest()
    await new Promise((r) => setTimeout(r, 10))
    const txt = readFileSync(logFile, 'utf8')
    expect(txt).toContain('circ-msg')
    expect(txt).not.toContain('sk-LEAKME')
    expect(txt).toContain('[Circular]')
    expect(txt).toContain('"ok":1')
    expect(txt).not.toContain('[unserializable]')
  })

  it('diamond shared ref (no cycle) serializes fully without [Circular]', async () => {
    initLogger({ file: logFile, level: 'debug' })
    const { createLogger, flushForTest } = await import(
      '../../src/logger/index.js'
    )
    const log = createLogger('transport')
    const shared = { x: 1 }
    const diamond = { a: shared, b: shared }
    expect(() => log.debug('diamond-msg', diamond)).not.toThrow()
    await flushForTest()
    await new Promise((r) => setTimeout(r, 10))
    const txt = readFileSync(logFile, 'utf8')
    expect(txt).toContain('diamond-msg')
    expect(txt).toContain('"x":1')
    expect(txt).not.toContain('[Circular]')
  })

  it('degrade-catch net still catches non-cycle throws (BigInt) and emits [unserializable]', async () => {
    initLogger({ file: logFile, level: 'debug' })
    const { createLogger, flushForTest } = await import(
      '../../src/logger/index.js'
    )
    const log = createLogger('transport')
    const bad = { big: BigInt(1) }
    expect(() => log.debug('bigint-msg', bad)).not.toThrow()
    await flushForTest()
    await new Promise((r) => setTimeout(r, 10))
    const txt = readFileSync(logFile, 'utf8')
    expect(txt).toContain('bigint-msg')
    expect(txt).toContain('[unserializable]')
  })
})

describe('logger redaction', () => {
  it('redacts compound secret keys (accessToken, apiKey, clientSecret, bearerToken, refreshToken)', async () => {
    initLogger({ file: logFile, level: 'debug' })
    const { createLogger, flushForTest } = await import(
      '../../src/logger/index.js'
    )
    const log = createLogger('transport')
    log.info('compound-keys', {
      accessToken: 'should-be-redacted',
      apiKey: 'sk-should-be-redacted',
      clientSecret: 'should-be-redacted',
      bearerToken: 'should-be-redacted',
      refreshToken: 'should-be-redacted',
      password: 'should-be-redacted',
    })
    await flushForTest()
    const txt = readFileSync(logFile, 'utf8')
    expect(txt).not.toContain('should-be-redacted')
    expect(txt).toContain('"accessToken":"***REDACTED***"')
    expect(txt).toContain('"apiKey":"***REDACTED***"')
  })

  it('keeps non-secret camelCase keys (sessionKey, cacheKey, lastAccessAt)', async () => {
    initLogger({ file: logFile, level: 'debug' })
    const { createLogger, flushForTest } = await import(
      '../../src/logger/index.js'
    )
    const log = createLogger('transport')
    log.info('safe-keys', {
      sessionKey: 'sess-abc',
      cacheKey: 'cache-123',
      lastAccessAt: 1234567890,
      status: 'ok',
      mode: 'auto',
      level: 'info',
    })
    await flushForTest()
    const txt = readFileSync(logFile, 'utf8')
    expect(txt).toContain('"sessionKey":"sess-abc"')
    expect(txt).toContain('"cacheKey":"cache-123"')
    expect(txt).toContain('"lastAccessAt"')
    expect(txt).toContain('"status"')
  })

  it('redacts only the ChatGPT stable id, not the internal accountId key', async () => {
    initLogger({
      file: logFile,
      level: 'debug',
      extraSecretKeys: (key) =>
        ['chatgptaccountid', 'email', 'orgname', 'organizationname'].includes(
          key,
        ),
    })
    const { createLogger, flushForTest } = await import(
      '../../src/logger/index.js'
    )
    const log = createLogger('transport')
    log.info('account-keys', {
      // Bare accountId carries the INTERNAL id/key ('main' or a fallback id) in
      // every diagnostic log — safe and needed for debugging, so NOT redacted.
      accountId: 'main',
      chatgptAccountId: 'chatgpt-acc-456',
      'chatgpt-account-id': 'chatgpt-acc-789',
      chatgpt_account_id: 'chatgpt-acc-000',
    })
    await flushForTest()
    const txt = readFileSync(logFile, 'utf8')
    // Internal id stays visible.
    expect(txt).toContain('"accountId":"main"')
    // Every form of the ChatGPT stable id is redacted.
    expect(txt).not.toContain('chatgpt-acc-456')
    expect(txt).not.toContain('chatgpt-acc-789')
    expect(txt).not.toContain('chatgpt-acc-000')
    expect(txt).toContain('"chatgptAccountId":"***REDACTED***"')
    expect(txt).toContain('"chatgpt-account-id":"***REDACTED***"')
    expect(txt).toContain('"chatgpt_account_id":"***REDACTED***"')
  })

  it('redacts served identity email and organization values from emitted log lines', async () => {
    initLogger({
      file: logFile,
      level: 'debug',
      extraSecretKeys: (key) =>
        ['chatgptaccountid', 'email', 'orgname', 'organizationname'].includes(
          key,
        ),
    })
    const { createLogger, flushForTest } = await import(
      '../../src/logger/index.js'
    )
    const log = createLogger('transport')
    log.info('served-identity', {
      email: 'served.identity@example.test',
      orgName: 'Served Identity Organization',
    })
    await flushForTest()
    const txt = readFileSync(logFile, 'utf8')
    expect(txt).not.toContain('served.identity@example.test')
    expect(txt).not.toContain('Served Identity Organization')
    expect(txt).toContain('***REDACTED***')
  })

  it('keeps token COUNT keys (input_tokens, cached_tokens, output_tokens) unredacted', async () => {
    initLogger({ file: logFile, level: 'debug' })
    const { createLogger, flushForTest } = await import(
      '../../src/logger/index.js'
    )
    const log = createLogger('transport')
    log.info('token-counts', {
      input_tokens: 1500,
      cached_tokens: 800,
      output_tokens: 300,
    })
    await flushForTest()
    const txt = readFileSync(logFile, 'utf8')
    expect(txt).toContain('"input_tokens":1500')
    expect(txt).toContain('"cached_tokens":800')
    expect(txt).toContain('"output_tokens":300')
  })

  it('writes nothing at all before a host calls initLogger', async () => {
    resetLoggerForTest()
    const { createLogger, flushForTest } = await import(
      '../../src/logger/index.js'
    )
    const log = createLogger('commands')
    expect(() => {
      log.error('uninitialised-error-line')
      log.warn('uninitialised-warn-line')
      log.info('uninitialised-info-line')
      log.debug('uninitialised-debug-line')
      log.trace('uninitialised-trace-line')
    }).not.toThrow()
    await flushForTest()
    expect(existsSync(logFile)).toBe(false)
  })

  it('redacts simple secret keys (authorization, x-api-key, cookie, refresh, token)', async () => {
    initLogger({ file: logFile, level: 'debug' })
    const { createLogger, flushForTest } = await import(
      '../../src/logger/index.js'
    )
    const log = createLogger('transport')
    log.info('simple-keys', {
      authorization: 'Bearer secret',
      'x-api-key': 'k-abc',
      cookie: 'ses=xyz',
      refresh: 'rt-xyz',
      token: 'tok-abc',
    })
    await flushForTest()
    const txt = readFileSync(logFile, 'utf8')
    expect(txt).toContain('***REDACTED***')
  })

  it('writes no credential value when a command logs every secret shape at once', async () => {
    initLogger({
      file: logFile,
      level: 'debug',
      extraSecretKeys: (key) =>
        ['chatgptaccountid', 'email', 'orgname', 'organizationname'].includes(
          key,
        ),
    })
    const { createLogger, flushForTest } = await import(
      '../../src/logger/index.js'
    )
    const log = createLogger('commands')
    log.info('every-secret-shape', {
      authorization: 'Bearer ya29.a0AfB_byC-token-value',
      apiKey: 'sk-live-0123456789abcdef',
      idToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln',
      'chatgpt-account-id': 'chatgpt-acc-secret',
      clientSecret: 'cs-0123456789',
      accountId: 'main',
    })
    await flushForTest()
    const txt = readFileSync(logFile, 'utf8')
    expect(txt).not.toContain('ya29.a0AfB_byC-token-value')
    expect(txt).not.toContain('sk-live-0123456789abcdef')
    expect(txt).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(txt).not.toContain('chatgpt-acc-secret')
    expect(txt).not.toContain('cs-0123456789')
    expect(txt).toContain('"accountId":"main"')
  })

  it('masks token-shaped values and secret keys in structured data', async () => {
    initLogger({ file: logFile, level: 'debug' })
    const { createLogger, flushForTest } = await import(
      '../../src/logger/index.js'
    )
    const log = createLogger('transport')
    log.info('req', {
      authorization: 'Bearer sk-secret-abc123',
      headers: { 'x-api-key': 'k-9' },
      ok: 1,
    })
    await flushForTest()
    const txt = readFileSync(logFile, 'utf8')
    expect(txt).not.toContain('sk-secret-abc123')
    expect(txt).not.toContain('k-9')
    expect(txt).toContain('"ok":1')
    expect(txt).toMatch(/REDACTED|\*\*\*/)
  })

  it('redacts manifest handles embedded in messages without masking short ckh tokens', async () => {
    initLogger({ file: logFile, level: 'debug' })
    const { createLogger, flushForTest } = await import(
      '../../src/logger/index.js'
    )
    const log = createLogger('transport')
    const handle = `ckh_${'a'.repeat(43)}`
    log.warn(`daemon rejected ${handle}; short token ckh_x remains diagnostic`)
    await flushForTest()
    const txt = readFileSync(logFile, 'utf8')
    expect(txt).not.toContain(handle)
    expect(txt).toContain('***REDACTED***')
    expect(txt).toContain('ckh_x')
  })
})

it('capture sink receives only scrubbed messages and payloads', () => {
  const capture = createCaptureSink()
  initLogger({ file: logFile, captureSink: capture.sink })
  createLogger('capture').info('before eyJabc after', {
    authorization: 'credential',
    count: 2,
  })
  expect(capture.records).toEqual([
    {
      channel: 'capture',
      level: 'info',
      message: 'before ***REDACTED*** after',
      data: { authorization: '***REDACTED***', count: 2 },
    },
  ])
  capture.clear()
  expect(capture.records).toEqual([])
})

it('rotates at 5 MiB keeping three private generations', () => {
  writeFileSync(logFile, 'x'.repeat(5 * 1024 * 1024))
  for (let i = 1; i <= 3; i++)
    writeFileSync(`${logFile}.${i}`, `generation-${i}`)
  for (const file of [logFile, `${logFile}.1`, `${logFile}.2`, `${logFile}.3`])
    chmodSync(file, 0o644)
  createLogger('rotation').info('new-line')
  flushLogs()
  expect(readFileSync(logFile, 'utf8')).toContain('new-line')
  expect(statSync(`${logFile}.1`).size).toBe(5 * 1024 * 1024)
  expect(readFileSync(`${logFile}.2`, 'utf8')).toBe('generation-1')
  expect(readFileSync(`${logFile}.3`, 'utf8')).toBe('generation-2')
  expect(existsSync(`${logFile}.4`)).toBe(false)
  for (const file of [logFile, `${logFile}.1`, `${logFile}.2`, `${logFile}.3`])
    expect(statSync(file).mode & 0o777).toBe(0o600)
})

it('buffers until fifty lines or the 500 ms flush deadline', async () => {
  const log = createLogger('buffer')
  for (let i = 0; i < 49; i++) log.info(`line-${i}`)
  expect(existsSync(logFile)).toBe(false)
  log.info('line-49')
  expect(
    readFileSync(logFile, 'utf8').split('\n').filter(Boolean),
  ).toHaveLength(50)
  log.info('timer-line')
  expect(readFileSync(logFile, 'utf8')).not.toContain('timer-line')
  await new Promise((resolve) => setTimeout(resolve, 600))
  expect(readFileSync(logFile, 'utf8')).toContain('timer-line')
})

it('resolves host path and level providers at runtime with operator override', () => {
  let file = logFile
  let level: 'info' | 'debug' = 'info'
  initLogger({ file: () => file, level: () => level })
  const log = createLogger('providers')
  log.debug('hidden')
  level = 'debug'
  log.debug('visible')
  flushLogs()
  expect(readFileSync(logFile, 'utf8')).not.toContain('hidden')
  expect(readFileSync(logFile, 'utf8')).toContain('visible')
  file = join(dir, 'moved.log')
  setLogLevel('error')
  log.warn('overridden')
  log.error('operator')
  flushLogs()
  expect(readFileSync(file, 'utf8')).not.toContain('overridden')
  expect(readFileSync(file, 'utf8')).toContain('operator')
})

it('file and provider failures do not escape logging callers', () => {
  initLogger({ file: dir })
  expect(() => {
    createLogger('failure').info('line')
    flushLogs()
  }).not.toThrow()
  initLogger({
    file: () => {
      throw new Error('unavailable')
    },
  })
  expect(() => {
    createLogger('failure').info('line')
    flushLogs()
  }).not.toThrow()
  initLogger({
    file: logFile,
    level: () => {
      throw new Error('unavailable')
    },
  })
  expect(() => createLogger('failure').info('line')).not.toThrow()
})

it('host-installed exit handler synchronously flushes buffered logs', () => {
  const entry = new URL('../../src/logger/index.ts', import.meta.url).href
  const child = spawnSync(
    process.execPath,
    [
      '--eval',
      `
    import { initLogger, createLogger, flushLogs } from ${JSON.stringify(entry)};
    initLogger({ file: ${JSON.stringify(logFile)} });
    process.on('exit', flushLogs);
    createLogger('host').info('exit-buffered');
    process.exit(0);
  `,
    ],
    { encoding: 'utf8' },
  )
  expect(child.status).toBe(0)
  expect(child.stderr).toBe('')
  expect(readFileSync(logFile, 'utf8')).toContain('exit-buffered')
})

describe('logger instances', () => {
  const read = (path: string) =>
    existsSync(path) ? readFileSync(path, 'utf8') : ''

  it('two logger instances in one process keep their own files and levels', () => {
    const fileA = join(dir, 'a.log')
    const fileB = join(dir, 'b.log')
    const a = createLoggerInstance({ file: fileA, level: 'info' })
    const b = createLoggerInstance({ file: fileB, level: 'debug' })
    a.createLogger('plugin-a').info('info-from-a')
    a.createLogger('plugin-a').debug('debug-from-a')
    b.createLogger('plugin-b').debug('debug-from-b')
    a.flushLogs()
    b.flushLogs()
    expect(read(fileA)).toContain('info-from-a')
    expect(read(fileA)).not.toContain('debug-from-a')
    expect(read(fileA)).not.toContain('from-b')
    expect(read(fileB)).toContain('debug-from-b')
    expect(read(fileB)).not.toContain('from-a')
  })

  it('instances keep their own redaction and capture sink', () => {
    const captureA = createCaptureSink()
    const captureB = createCaptureSink()
    const a = createLoggerInstance({
      file: join(dir, 'a.log'),
      captureSink: captureA.sink,
      extraSecretKeys: (key) => key === 'email',
    })
    const b = createLoggerInstance({
      file: join(dir, 'b.log'),
      captureSink: captureB.sink,
    })
    a.createLogger('a').info('a-line', { email: 'person@example.com' })
    b.createLogger('b').info('b-line', { email: 'person@example.com' })
    expect(captureA.records).toEqual([
      {
        channel: 'a',
        level: 'info',
        message: 'a-line',
        data: { email: '***REDACTED***' },
      },
    ])
    expect(captureB.records).toEqual([
      {
        channel: 'b',
        level: 'info',
        message: 'b-line',
        data: { email: 'person@example.com' },
      },
    ])
  })

  it('initLogger and setLogLevel on the module logger leave an instance alone', () => {
    const own = join(dir, 'own.log')
    const instance = createLoggerInstance({ file: own, level: 'info' })
    // Another plugin sharing this module configures the default logger.
    initLogger({ file: logFile, level: 'trace' })
    setLogLevel('trace')
    const log = instance.createLogger('own')
    log.debug('instance-debug')
    log.info('instance-info')
    createLogger('default').info('default-info')
    flushLogs()
    expect(read(own)).toBe('')
    instance.flushLogs()
    expect(read(own)).toContain('instance-info')
    expect(read(own)).not.toContain('instance-debug')
    expect(read(own)).not.toContain('default-info')
    expect(read(logFile)).toContain('default-info')
    expect(read(logFile)).not.toContain('instance-info')
  })

  it('an instance runtime level overrides only its own floor and survives reconfiguring', () => {
    const own = join(dir, 'own.log')
    const moved = join(dir, 'moved.log')
    const instance = createLoggerInstance({ file: own, level: 'info' })
    instance.setLogLevel('error')
    instance.createLogger('own').warn('instance-warn')
    createLogger('default').warn('default-warn')
    instance.configure({ file: moved, level: 'trace' })
    instance.createLogger('own').warn('after-configure-warn')
    instance.createLogger('own').error('after-configure-error')
    instance.flushLogs()
    flushLogs()
    expect(read(own)).toBe('')
    expect(read(moved)).not.toContain('after-configure-warn')
    expect(read(moved)).toContain('after-configure-error')
    expect(read(logFile)).toContain('default-warn')
  })

  it('initLogger returns the module default logger as an instance', () => {
    const instance = initLogger({ file: logFile, level: 'info' })
    instance.setLogLevel('debug')
    createLogger('module').debug('module-debug')
    flushLogs()
    expect(read(logFile)).toContain('module-debug')
  })
})
