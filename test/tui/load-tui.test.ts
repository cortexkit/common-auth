import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { loadTui } from '@cortexkit/common-auth/tui'
import { makeRepoScratchDir } from '../fixtures/scratch.js'

const probe = 'opentui:runtime-module:%40opentui%2Fsolid'
const rawEntry = pathToFileURL(resolve('test/fixtures/tui/raw-entry.mjs')).href
const runtimeEntry = pathToFileURL(
  resolve('test/fixtures/tui/runtime-entry.mjs'),
).href

// Runs a real `npm pack` of this repository; npm's start-up alone can exceed
// bun's 5-second default on a loaded machine.
test('packed tui selector probes the exact id and imports only the selected absolute entry', async () => {
  const root = await makeRepoScratchDir()
  try {
    const exec = promisify(execFile)
    const { stdout } = await exec('npm', [
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      root,
    ])
    const [{ filename }] = JSON.parse(stdout)
    const unpacked = join(root, 'unpacked')
    await mkdir(unpacked)
    await exec('tar', ['-xzf', join(root, filename), '-C', unpacked])
    const manifest = await Bun.file(
      join(unpacked, 'package/package.json'),
    ).json()
    const selector = await import(
      pathToFileURL(join(unpacked, 'package', manifest.exports['./tui'].import))
        .href
    )
    for (const missing of [false, true]) {
      const calls: string[] = []
      const value = await selector.loadTui({
        rawEntry,
        runtimeEntry,
        importModule: async (specifier: string) => {
          calls.push(specifier)
          if (specifier === probe && missing)
            throw new Error(`Cannot find module '${probe}'`)
          return { default: specifier }
        },
      })
      expect(calls).toEqual([probe, missing ? rawEntry : runtimeEntry])
      expect(value).toBe(missing ? rawEntry : runtimeEntry)
    }
    for (const error of [
      new Error('initialization exploded'),
      new Error('Cannot find some-other-module'),
    ]) {
      const calls: string[] = []
      await expect(
        selector.loadTui({
          rawEntry,
          runtimeEntry,
          importModule: async (specifier: string) => {
            calls.push(specifier)
            throw error
          },
        }),
      ).rejects.toBe(error)
      expect(calls).toEqual([probe])
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)

test('default importer loads caller file URLs outside the library directory', async () => {
  expect(await loadTui({ rawEntry, runtimeEntry })).toBe('raw fixture')
  expect(
    await loadTui({ rawEntry: runtimeEntry, runtimeEntry: rawEntry }),
  ).toBe('runtime fixture')
})

test('selector rejects relative entries naming the offending option before importing', async () => {
  for (const option of ['rawEntry', 'runtimeEntry'] as const) {
    let calls = 0
    await expect(
      loadTui({
        rawEntry,
        runtimeEntry,
        [option]: './relative.mjs',
        importModule: async () => {
          calls++
          return {}
        },
      }),
    ).rejects.toThrow(option)
    expect(calls).toBe(0)
  }
})
