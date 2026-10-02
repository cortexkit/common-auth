import { afterEach, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import {
  createCaptureSink,
  createLoggerInstance,
  type InitLoggerOptions,
} from '../../src/logger/index.js'
import { makeTempDir } from '../fixtures/scratch.js'

let dir: string | undefined
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

const SECRET = 'ya29.fixture-not-a-real-token-0123456789'

it('a sink-only logger instance delivers every scrubbed record', () => {
  const capture = createCaptureSink()
  const instance = createLoggerInstance({ captureSink: capture.sink })
  const log = instance.createLogger('sink-only')
  log.info('hello', { attempt: 1, access_token: SECRET })
  log.warn('second')
  log.debug('below the default info floor')
  instance.flushLogs()
  expect(capture.records).toEqual([
    {
      channel: 'sink-only',
      level: 'info',
      message: 'hello',
      data: { attempt: 1, access_token: '***REDACTED***' },
    },
    { channel: 'sink-only', level: 'warn', message: 'second', data: undefined },
  ])
})

it('a sink-only logger instance prints nothing and creates no file', async () => {
  dir = await makeTempDir('fixture-sink-only-')
  const entry = new URL('../../src/logger/index.ts', import.meta.url).href
  // A child process with an empty working directory shows both that nothing
  // reached stdout or stderr and that no file appeared, even after the
  // flush timer would have fired.
  const child = spawnSync(
    process.execPath,
    [
      '--eval',
      `
    import { createLoggerInstance } from ${JSON.stringify(entry)};
    const records = [];
    const instance = createLoggerInstance({ captureSink: (r) => records.push(r) });
    process.on('exit', () => instance.flushLogs());
    instance.createLogger('sink-only').info('hello');
    instance.createLogger('sink-only').warn('second');
    await new Promise((resolve) => setTimeout(resolve, 600));
    if (records.length !== 2) process.exit(3);
  `,
    ],
    { encoding: 'utf8', cwd: dir },
  )
  expect(child.status).toBe(0)
  expect(child.stdout).toBe('')
  expect(child.stderr).toBe('')
  expect(readdirSync(dir)).toEqual([])
})

it('a logger without a file or a capture sink does not type-check', () => {
  // @ts-expect-error A logger needs a file, a capture sink, or both.
  const options: InitLoggerOptions = { level: 'info' }
  expect(options.level).toBe('info')
})
