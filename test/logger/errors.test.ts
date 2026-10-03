import { afterEach, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import {
  createCaptureSink,
  createLoggerInstance,
  createRedactor,
} from '../../src/logger/index.js'
import { makeTempDir } from '../fixtures/scratch.js'

let dir: string | undefined
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

const TOKEN = 'sk-fixture-not-a-real-key-0123456789'
type Rendered = Record<string, unknown>

/**
 * Log `data` through one instance with both a file and a capture sink, and
 * return what each destination received: the capture record's data and the
 * JSON payload parsed back out of the file line.
 */
async function logBoth(
  data: unknown,
): Promise<{ file: Rendered; capture: Rendered }> {
  dir = await makeTempDir('fixture-logger-errors-')
  const file = join(dir, 'test.log')
  const capture = createCaptureSink()
  const instance = createLoggerInstance({ file, captureSink: capture.sink })
  instance.createLogger('errors').error('probe', data)
  instance.flushLogs()
  const line = readFileSync(file, 'utf8').trim()
  const payload = line.slice(line.indexOf(' probe ') + ' probe '.length)
  const captured = capture.records[0]?.data as Rendered
  // Both destinations get the same scrubbed value; the file holds its JSON.
  expect(JSON.parse(payload)).toEqual(JSON.parse(JSON.stringify(captured)))
  return { file: JSON.parse(payload), capture: captured }
}

class HttpError extends Error {
  override name = 'HttpError'
  code = 'E_UPSTREAM'
  // A getter on the class, as some HTTP clients define it, is not an own
  // property; the rendering still reads it.
  get status() {
    return 503
  }
  accessToken = 'should-not-appear'
}

it('the redactor renders an Error as its name, message and stack instead of an empty object', () => {
  const rendered = createRedactor().redact({ err: new Error('boom') }) as {
    err: Rendered
  }
  expect(rendered.err.name).toBe('Error')
  expect(rendered.err.message).toBe('boom')
  expect(String(rendered.err.stack)).toContain('boom')
  expect(Object.keys(rendered.err)).toEqual(['name', 'message', 'stack'])
})

it('a logged Error keeps its name, message and stack in the file and the capture sink', async () => {
  const both = await logBoth({ err: new Error('boom') })
  for (const data of [both.file, both.capture]) {
    const err = data.err as Rendered
    expect(err.name).toBe('Error')
    expect(err.message).toBe('boom')
    expect(String(err.stack)).toStartWith('Error: boom')
  }
})

it('a logged Error subclass keeps code and status and redacts its secret-shaped keys', async () => {
  const both = await logBoth(new HttpError('upstream unavailable'))
  for (const err of [both.file, both.capture]) {
    expect(err).toMatchObject({
      name: 'HttpError',
      message: 'upstream unavailable',
      code: 'E_UPSTREAM',
      status: 503,
      accessToken: '***REDACTED***',
    })
    expect(JSON.stringify(err)).not.toContain('should-not-appear')
  }
})

it('a logged error keeps a code its class defines on the prototype', async () => {
  // DOMException's code is an inherited getter, not an own property, so only
  // an explicit read of `code` finds it.
  const both = await logBoth(new DOMException('stopped', 'AbortError'))
  for (const err of [both.file, both.capture])
    expect(err).toMatchObject({
      name: 'AbortError',
      message: 'stopped',
      code: 20,
    })
})

it('an Error created in another realm renders like a local one', () => {
  const foreign = runInNewContext('new RangeError("elsewhere")')
  expect(foreign instanceof Error).toBe(false)
  expect(createRedactor().redact({ err: foreign })).toMatchObject({
    err: { name: 'RangeError', message: 'elsewhere' },
  })
})

it('an enumerable cause on an error is rendered once', () => {
  let reads = 0
  const err = new Error('outer') as Error & { cause: unknown }
  // Assignment makes `cause` an own enumerable property, which the entry
  // walk also lists; rendering it twice would double the work at every
  // level of a chain.
  err.cause = {
    get detail() {
      reads++
      return 'x'
    },
  }
  expect(createRedactor().redact(err)).toMatchObject({
    cause: { detail: 'x' },
  })
  expect(reads).toBe(1)
})

it('a logged cause chain renders every cause the same way', async () => {
  const inner = new TypeError('inner failure', { cause: 'root reason' })
  const outer = new Error('outer failure', { cause: inner })
  const both = await logBoth({ attempts: [{ err: outer }] })
  for (const data of [both.file, both.capture]) {
    const err = (data.attempts as { err: Rendered }[])[0]?.err as Rendered
    expect(err.message).toBe('outer failure')
    const cause = err.cause as Rendered
    expect(cause.name).toBe('TypeError')
    expect(cause.message).toBe('inner failure')
    expect(String(cause.stack)).toContain('inner failure')
    expect(cause.cause).toBe('root reason')
  }
})

it('a logged cyclic cause chain terminates with a circular marker', async () => {
  const first = new Error('first')
  const second = new Error('second', { cause: first })
  first.cause = second
  const self = new Error('self')
  self.cause = self
  const both = await logBoth({ first, self })
  for (const data of [both.file, both.capture]) {
    const err = data.first as Rendered
    expect((err.cause as Rendered).message).toBe('second')
    expect((err.cause as Rendered).cause).toBe('[Circular]')
    expect((data.self as Rendered).cause).toBe('[Circular]')
  }
})

it('a logged cause chain is cut off after eight errors', async () => {
  let err: Error = new Error('level 0')
  for (let level = 1; level < 20; level++)
    err = new Error(`level ${level}`, { cause: err })
  const both = await logBoth(err)
  for (const data of [both.file, both.capture]) {
    let current: unknown = data
    const messages: string[] = []
    while (current && typeof current === 'object') {
      messages.push(String((current as Rendered).message))
      current = (current as Rendered).cause
    }
    expect(messages).toEqual(
      Array.from({ length: 8 }, (_, index) => `level ${19 - index}`),
    )
    expect(current).toBe('[Truncated]')
  }
})

it('a token inside a logged error message and stack is redacted', async () => {
  const err = new Error(`request failed for ${TOKEN}`)
  err.stack = `${err.stack}\n    at handler (Bearer ${TOKEN})`
  const both = await logBoth({ err })
  for (const data of [both.file, both.capture]) {
    const rendered = data.err as Rendered
    expect(rendered.message).toBe('request failed for ***REDACTED***')
    expect(String(rendered.stack)).toStartWith(
      'Error: request failed for ***REDACTED***',
    )
    expect(String(rendered.stack)).toEndWith('at handler (***REDACTED***)')
    expect(JSON.stringify(data)).not.toContain(TOKEN)
  }
})
