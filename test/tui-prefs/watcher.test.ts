import { afterEach, beforeEach, expect, test } from 'bun:test'
import { writeFileSync, type watch } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  createTuiPreferenceWriter,
  watchTuiPreferences,
} from '../../src/tui-prefs/index.js'
import { makeTempDir } from '../fixtures/scratch.js'

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
  start()
  await sleep(50)
  for (let i = 0; i < 5; i++) await update(['pollMs'], 1000 + i)
  await sleep(400)
  expect(fired).toBeGreaterThanOrEqual(1)
  expect(fired).toBeLessThan(5)
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
