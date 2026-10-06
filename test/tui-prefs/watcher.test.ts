import { beforeEach, expect, spyOn } from 'bun:test'
import { EventEmitter } from 'node:events'
import { type watch, writeFileSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as timers from 'node:timers'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  createTuiPreferenceWriter,
  watchTuiPreferences,
} from '../../src/tui-prefs/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { makeTempDir } from '../fixtures/scratch.js'

const hooks = lifetimeHooks()
const { afterEach, test } = hooks

let dir: string
let file: string
let fired: number
const disposers: (() => void)[] = []
beforeEach(async () => {
  dir = await makeTempDir()
  file = join(dir, 'tui-preferences.jsonc')
  fired = 0
})
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose()
  await rm(dir, { recursive: true, force: true })
})
function start(watchDirectory?: typeof watch) {
  const dispose = watchTuiPreferences(
    file,
    () => {
      fired++
    },
    { watchDirectory },
  )
  disposers.push(dispose)
  return dispose
}
function update(
  path: string[] = ['collapsed'],
  value: boolean | number = true,
) {
  return createTuiPreferenceWriter({
    file,
    pluginKey: 'plugin-a',
  }).queueTuiPreferenceUpdate(path, value)
}

test('fires after the file changes', async () => {
  await writeFile(file, '{}')
  start()
  await sleep(50)
  await update()
  await sleep(400)
  expect(fired).toBeGreaterThanOrEqual(1)
})
test('observes a change made immediately after the watcher returns', async () => {
  await writeFile(file, '{}')
  start()
  writeFileSync(file, '{"plugin-a":{"collapsed":true}}')
  await sleep(400)
  expect(fired).toBeGreaterThanOrEqual(1)
})
test('polls when directory watcher construction fails', async () => {
  await writeFile(file, '{}')
  start((() => {
    throw Object.assign(new Error('bad file descriptor'), { code: 'EBADF' })
  }) as unknown as typeof watch)
  await update()
  await sleep(400)
  expect(fired).toBeGreaterThanOrEqual(1)
})
test('debounces bursts into few callbacks', async () => {
  await writeFile(file, '{}')
  type Pending = { delay: number; run: () => void; unref: () => void }
  const pending = new Set<Pending>()
  const changed = Promise.withResolvers<void>()
  const polled = Promise.withResolvers<void>()
  const realSetTimeout = timers.setTimeout
  const realClearTimeout = timers.clearTimeout
  let intercepted = 0
  let cancelled = 0
  let polls = 0
  const setSpy = spyOn(timers, 'setTimeout').mockImplementation(((
    ...args: Parameters<typeof realSetTimeout>
  ) => {
    if (args[1] !== 100 && args[1] !== 150) return realSetTimeout(...args)
    intercepted++
    const timer: Pending = {
      delay: args[1],
      run: () => {
        pending.delete(timer)
        args[0]()
      },
      unref: () => {},
    }
    pending.add(timer)
    if (timer.delay === 100 && ++polls === 2) polled.resolve()
    return timer as unknown as ReturnType<typeof timers.setTimeout>
  }) as typeof realSetTimeout)
  const clearSpy = spyOn(timers, 'clearTimeout').mockImplementation((timer) => {
    if (pending.delete(timer as unknown as Pending)) cancelled++
    else realClearTimeout(timer as Parameters<typeof realClearTimeout>[0])
  })
  let event!: (event: string, filename: string) => void
  const watcher = Object.assign(new EventEmitter(), { close: () => {} })
  let dispose: (() => void) | undefined
  try {
    dispose = watchTuiPreferences(
      file,
      () => {
        fired++
        changed.resolve()
      },
      {
        watchDirectory: ((...args: unknown[]) => {
          event = args.at(-1) as typeof event
          return watcher
        }) as unknown as typeof watch,
      },
    )
    // Deliver the burst without advancing either timer. Awaited disk writes
    // can span poll windows on a busy host and are not a debounce burst.
    for (let i = 0; i < 5; i++) {
      writeFileSync(file, JSON.stringify({ pollMs: 1000 + i }))
      event('change', 'tui-preferences.jsonc')
    }
    expect(intercepted).toBe(6)
    expect(cancelled).toBe(4)
    const debounces = [...pending].filter((timer) => timer.delay === 150)
    expect(debounces).toHaveLength(1)
    expect(fired).toBe(0)
    debounces[0]?.run()
    await changed.promise
    expect(fired).toBe(1)
    // The independent poll observes the same final content, not five
    // intermediate states. Rescheduling proves the asynchronous read finished.
    const poll = [...pending].find((timer) => timer.delay === 100)
    expect(poll).toBeDefined()
    poll?.run()
    await polled.promise
    expect(intercepted).toBe(7)
    expect(fired).toBe(1)
  } finally {
    dispose?.()
    clearSpy.mockRestore()
    setSpy.mockRestore()
  }
})
test('missing directory returns a no-op disposer', () => {
  file = join(dir, 'nope', 'missing.jsonc')
  const dispose = start()
  expect(typeof dispose).toBe('function')
  dispose()
})
test('dispose stops callbacks', async () => {
  await writeFile(file, '{}')
  const dispose = start()
  await sleep(50)
  dispose()
  await update()
  await sleep(300)
  expect(fired).toBe(0)
})
test('ignores sibling files that share the preferences name as a prefix', async () => {
  await writeFile(file, '{}')
  start()
  await sleep(50)
  await writeFile(join(dir, 'tui-preferences.jsonc.backup'), 'noise')
  await sleep(300)
  expect(fired).toBe(0)
  await update()
  await sleep(400)
  expect(fired).toBeGreaterThanOrEqual(1)
})
test('does not fire when the file is rewritten with identical content', async () => {
  await writeFile(file, '{}')
  start()
  await sleep(50)
  await writeFile(file, '{}')
  await sleep(400)
  expect(fired).toBe(0)
})
