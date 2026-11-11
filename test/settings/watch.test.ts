import { beforeEach, expect, spyOn } from 'bun:test'
import { EventEmitter } from 'node:events'
import { readFileSync, type watch, writeFileSync } from 'node:fs'
import {
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import * as timers from 'node:timers'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { defineSettings } from '../../src/settings/define.js'
import { integer } from '../../src/settings/descriptors.js'
import { setSettingsFsForTest } from '../../src/settings/fs.js'
import { openSettings } from '../../src/settings/handle.js'
import {
  type TuiPreferencesWatchOptions,
  watchSettings,
  watchTuiPreferences,
} from '../../src/tui-prefs/watcher.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { observedState } from '../fixtures/observed.js'
import { makeTempDir } from '../fixtures/scratch.js'

const hooks = lifetimeHooks()
const { afterEach, test } = hooks
const definition = defineSettings({
  plugin: 'watch-test',
  settings: {
    x: { value: integer(), default: 1, hosts: 'both', project: 'allowed' },
  },
})
const log = { warn() {}, info() {} }
let dir: string
let file: string
let fired: number
const disposers: (() => void)[] = []

beforeEach(async () => {
  dir = await makeTempDir()
  file = join(dir, 'user.jsonc')
  fired = 0
})
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose()
  setSettingsFsForTest()
  await rm(dir, { recursive: true, force: true })
})

function handle(separateInstall = false, path = file) {
  return openSettings(definition, { file: path, log, separateInstall })
}

function start(options: TuiPreferencesWatchOptions = {}) {
  const dispose = watchSettings(file, () => fired++, options)
  disposers.push(dispose)
  return dispose
}

function nativeSeam() {
  const folders: string[] = []
  let closes = 0
  const listeners: ((event: string, filename: string) => void)[] = []
  const watchDirectory = ((folder: string, listener: unknown) => {
    folders.push(String(folder))
    listeners.push(listener as (event: string, filename: string) => void)
    return Object.assign(new EventEmitter(), { close: () => closes++ })
  }) as unknown as typeof watch
  return {
    watchDirectory,
    folders,
    closes: () => closes,
    emit: () => {
      for (const listener of listeners) listener('rename', 'user.jsonc')
    },
  }
}

async function changed(count: number, action: () => Promise<unknown>) {
  await action()
  await observedState(hooks.lifetime, () => fired >= count)
  // Let any duplicate native event finish its debounce before counting callbacks.
  await sleep(220)
  expect(fired).toBe(count)
}

test('handle.watch debounces the user file once and ignores project files', async () => {
  await writeFile(file, '{"x":2}')
  const project = join(dir, 'project')
  const projectFile = join(project, '.cortexkit', 'watch-test.jsonc')
  await mkdir(dirname(projectFile), { recursive: true })
  await writeFile(projectFile, '{"x":4}')
  const settings = handle()
  await settings.read({ project })
  disposers.push(settings.watch(() => fired++))
  writeFileSync(file, '{"x":3}')
  await sleep(100)
  expect(fired).toBe(0)
  await observedState(hooks.lifetime, () => fired >= 1)
  await sleep(250)
  expect(fired).toBe(1)
  expect(await settings.get('x', { host: 'pi' })).toBe(3)
  await writeFile(projectFile, '{"x":5}')
  await sleep(1_100)
  expect(fired).toBe(1)
})

test('settings native events wait 150 ms after the last event', async () => {
  await writeFile(file, '{"x":2}')
  const native = nativeSeam()
  start({ watchDirectory: native.watchDirectory })
  await writeFile(file, '{"x":3}')
  native.emit()
  await sleep(100)
  expect(fired).toBe(0)
  native.emit()
  await sleep(100)
  expect(fired).toBe(0)
  await observedState(hooks.lifetime, () => fired >= 1)
  await sleep(220)
  expect(fired).toBe(1)
})

test('handle.watch notifies once on deletion and once on same-byte recreation', async () => {
  const text = '{"x":2}'
  await writeFile(file, text)
  const settings = handle()
  disposers.push(settings.watch(() => fired++))
  await changed(1, () => unlink(file))
  expect(await settings.get('x', { host: 'pi' })).toBe(1)
  await changed(2, () => writeFile(file, text))
  expect(await settings.get('x', { host: 'pi' })).toBe(2)
})

test('handle.watch follows the user link lifecycle without watching its old target path', async () => {
  const targets = join(dir, 'targets')
  await mkdir(targets)
  const first = join(targets, 'first.jsonc')
  const second = join(targets, 'second.jsonc')
  await writeFile(first, '{"x":2}')
  await writeFile(second, '{"x":3}')
  await symlink(first, file)
  disposers.push(handle().watch(() => fired++))
  await changed(1, () => unlink(file))
  expect(await readFile(first, 'utf8')).toBe('{"x":2}')
  await changed(2, () => symlink(first, file))
  await changed(3, async () => {
    await unlink(file)
    await symlink(second, file)
  })
})

test('the 1,000 ms probe detects equal-length target rewrites with restored mtime', async () => {
  const target = join(dir, 'target.jsonc')
  await writeFile(target, '{"x":2}')
  const fixedTime = new Date('2020-01-01T00:00:00.000Z')
  await utimes(target, fixedTime, fixedTime)
  await symlink(target, file)
  const before = await stat(target)
  const native = nativeSeam()
  const probed: string[] = []
  start({
    watchDirectory: native.watchDirectory,
    fs: {
      stat: async (path) => {
        probed.push(path)
        return stat(path)
      },
    },
  })
  expect(native.folders).toEqual([dirname(file)])
  await sleep(20)
  await writeFile(target, '{"x":3}')
  await utimes(target, before.atime, before.mtime)
  const after = await stat(target)
  expect(after.size).toBe(before.size)
  expect(after.mtimeMs).toBe(before.mtimeMs)
  expect(after.ino).toBe(before.ino)
  expect(after.ctimeMs).not.toBe(before.ctimeMs)
  await sleep(250)
  expect(fired).toBe(0)
  await observedState(hooks.lifetime, () => fired >= 1)
  await sleep(1_100)
  expect(fired).toBe(1)
  expect(probed).toEqual([resolve(file), resolve(file)])
})

test('settings seed synchronously and use plain seam reads for later checks', async () => {
  await writeFile(file, '{"x":2}')
  const native = nativeSeam()
  const seeds: string[] = []
  const reads: string[] = []
  start({
    watchDirectory: native.watchDirectory,
    fs: {
      readFileSync: (path) => {
        seeds.push(path)
        return readFileSync(path, 'utf8')
      },
      readFile: async (path) => {
        reads.push(path)
        return readFile(path, 'utf8')
      },
    },
  })
  expect(seeds).toEqual([file])
  writeFileSync(file, '{"x":3}')
  native.emit()
  await observedState(hooks.lifetime, () => fired >= 1)
  expect(reads).toEqual([file])
  expect(fired).toBe(1)
})

test('settings use plain default reads and seed even in the Windows branch', async () => {
  const bundle = await Bun.build({
    entrypoints: [
      fileURLToPath(new URL('../../src/tui-prefs/watcher.ts', import.meta.url)),
    ],
    target: 'bun',
    define: { 'process.platform': '"win32"' },
    external: ['@cortexkit/private-files'],
  })
  expect(bundle.success).toBe(true)
  const copyPath = join(dir, 'windows-watcher.mjs')
  await writeFile(copyPath, await bundle.outputs[0]!.text())
  const copy = (await import(copyPath)) as {
    watchSettings: typeof watchSettings
  }
  await writeFile(file, '{"x":2}')
  const native = nativeSeam()
  disposers.push(
    copy.watchSettings(file, () => fired++, {
      watchDirectory: native.watchDirectory,
    }),
  )
  native.emit()
  await sleep(250)
  expect(
    fired,
    'an unchanged native event must not become the initial read',
  ).toBe(0)
  await writeFile(file, '{"x":3}')
  native.emit()
  await observedState(hooks.lifetime, () => fired >= 1)
  expect(fired).toBe(1)
})

test('settings registry uses the resolved user path and stays separate from TUI watchers', async () => {
  const target = join(dir, 'target.jsonc')
  await writeFile(target, '{"x":2}')
  await symlink(target, file)
  const native = nativeSeam()
  start({ watchDirectory: native.watchDirectory })
  disposers.push(
    watchSettings(target, () => {}, { watchDirectory: native.watchDirectory }),
    watchTuiPreferences(file, () => {}, {
      watchDirectory: native.watchDirectory,
    }),
  )
  const registry = (
    globalThis as unknown as Record<symbol, Map<string, unknown>>
  )[Symbol.for('cortexkit.common-auth.settings.watchers.v1')]
  expect(registry).toBeInstanceOf(Map)
  expect(registry?.has(resolve(file))).toBe(true)
  expect(registry?.has(resolve(target))).toBe(true)
  expect(native.folders).toHaveLength(3)
})

test('the last handle subscriber stops the debounce, probe and native watcher', async () => {
  await writeFile(file, '{"x":2}')
  const native = nativeSeam()
  const setSpy = spyOn(timers, 'setTimeout')
  const clearSpy = spyOn(timers, 'clearTimeout')
  let probes = 0
  let second = 0
  let disposeFirst: (() => void) | undefined
  let disposeSecond: (() => void) | undefined
  try {
    disposeFirst = start({
      watchDirectory: native.watchDirectory,
      fs: {
        stat: async (path) => {
          probes++
          return stat(path)
        },
      },
    })
    disposeSecond = handle().watch(() => second++)
    disposers.push(disposeSecond)
    expect(native.folders).toHaveLength(1)
    await writeFile(file, '{"x":3}')
    native.emit()
    await observedState(hooks.lifetime, () => second >= 1)
    expect(fired).toBe(1)
    disposeFirst()
    expect(native.closes()).toBe(0)
    await writeFile(file, '{"x":4}')
    native.emit()
    await observedState(hooks.lifetime, () => second >= 2)
    expect(fired).toBe(1)
    native.emit()
    const watcherTimers = setSpy.mock.calls.flatMap((call, index) =>
      call[1] === 150 || call[1] === 1_000
        ? [setSpy.mock.results[index]?.value]
        : [],
    )
    expect(watcherTimers).toHaveLength(4)
    disposeSecond()
    disposeSecond()
    expect(native.closes()).toBe(1)
    // The poll and the pending debounce must both be explicitly cancelled.
    expect(clearSpy).toHaveBeenCalledWith(watcherTimers[0])
    expect(clearSpy).toHaveBeenCalledWith(watcherTimers.at(-1))
    const stoppedAt = probes
    native.emit()
    await sleep(1_100)
    expect(probes).toBe(stoppedAt)
    expect(second).toBe(2)
    expect(setSpy.mock.calls.filter((call) => call[1] === 1_000)).toHaveLength(
      1,
    )
  } finally {
    disposeFirst?.()
    disposeSecond?.()
    clearSpy.mockRestore()
    setSpy.mockRestore()
  }
})

test('separate-install watch and its disposer do nothing', async () => {
  await writeFile(file, '{"x":2}')
  const setSpy = spyOn(timers, 'setTimeout')
  let reads = 0
  let probes = 0
  setSettingsFsForTest({
    readFile: (async () => {
      reads++
      throw new Error('separate-install must not read')
    }) as typeof readFile,
    stat: (async () => {
      probes++
      throw new Error('separate-install must not stat')
    }) as typeof stat,
  })
  try {
    const dispose = handle(true).watch(() => fired++)
    disposers.push(dispose)
    expect(typeof dispose).toBe('function')
    expect(setSpy).not.toHaveBeenCalled()
    const registry = (
      globalThis as unknown as Record<symbol, Map<string, unknown>>
    )[Symbol.for('cortexkit.common-auth.settings.watchers.v1')]
    expect(registry?.has(file) ?? false).toBe(false)
    dispose()
    dispose()
    await writeFile(file, '{"x":3}')
    await sleep(1_100)
    expect(fired).toBe(0)
    expect(reads).toBe(0)
    expect(probes).toBe(0)
    expect(setSpy).not.toHaveBeenCalled()
  } finally {
    setSpy.mockRestore()
  }
})
