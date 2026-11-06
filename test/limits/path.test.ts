import { afterEach, expect, test } from 'bun:test'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as limits from '../../src/limits/index.js'

const directories: string[] = []
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true })
})

test('canonicalLimitsPath resolves symlinked parents without requiring a store file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'limits-path-'))
  directories.push(directory)
  const real = join(directory, 'RealFolder')
  const alias = join(directory, 'alias')
  await mkdir(real)
  await symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const expected = join(realpathSync.native(real), 'Store.JSON')
  expect(limits.canonicalLimitsPath(join(real, 'Store.JSON'))).toBe(expected)
  expect(limits.canonicalLimitsPath(join(alias, 'Store.JSON'))).toBe(expected)
})

test('canonicalLimitsPath resolves the nearest existing ancestor when folders are missing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'limits-path-'))
  directories.push(directory)
  const real = join(directory, 'RealFolder')
  const alias = join(directory, 'alias')
  await mkdir(real)
  await symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir')
  // Neither `NotYet` nor `Deeper` exists, so only `RealFolder` can be resolved.
  const expected = join(
    realpathSync.native(real),
    'NotYet',
    'Deeper',
    'Store.JSON',
  )
  expect(
    limits.canonicalLimitsPath(join(alias, 'NotYet', 'Deeper', 'Store.JSON')),
  ).toBe(expected)
  expect(
    limits.canonicalLimitsPath(join(real, 'NotYet', 'Deeper', 'Store.JSON')),
  ).toBe(expected)
  // Creating the folders later doesn't change the result.
  await mkdir(join(real, 'NotYet', 'Deeper'), { recursive: true })
  expect(
    limits.canonicalLimitsPath(join(alias, 'NotYet', 'Deeper', 'Store.JSON')),
  ).toBe(expected)
})

test('canonicalLimitsPath makes a relative path with missing folders absolute', () => {
  const path = 'missing-limits-folder/../missing-limits-folder/Store.JSON'
  expect(limits.canonicalLimitsPath(path)).toBe(
    join(
      realpathSync.native(process.cwd()),
      'missing-limits-folder',
      'Store.JSON',
    ),
  )
})
