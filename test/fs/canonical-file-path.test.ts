import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as syncFs from 'node:fs'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
// Through the public ./fs entry, which other plugins import.
import { canonicalFilePath, canonicalFilePathSync } from '../../src/fs/index.js'
import { makeTempDir } from '../fixtures/scratch.js'

let root: string
beforeEach(async () => {
  root = await makeTempDir()
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe.each(['async', 'sync'])('%s canonical file paths', (mode) => {
  function canonical(file: string) {
    return mode === 'async'
      ? canonicalFilePath(file, fs)
      : canonicalFilePathSync(file, syncFs)
  }

  test('regular and missing files use the canonical containing folder', async () => {
    const parent = join(root, 'actual')
    const alias = join(root, 'alias')
    await fs.mkdir(parent)
    await fs.symlink(parent, alias, 'dir')
    const canonicalParent = await fs.realpath(parent)
    for (const exists of [false, true]) {
      if (exists) await fs.writeFile(join(parent, 'settings.jsonc'), '{}')
      expect(await canonical(join(alias, 'settings.jsonc'))).toBe(
        join(canonicalParent, 'settings.jsonc'),
      )
    }
  })

  test('relative targets use the canonical link folder before parent traversal', async () => {
    const parent = join(root, 'actual')
    const nested = join(parent, 'nested')
    const alias = join(root, 'alias')
    await fs.mkdir(nested, { recursive: true })
    await fs.symlink(nested, alias, 'dir')
    const target = join(parent, 'settings.jsonc')
    await fs.writeFile(target, '{}')
    await fs.symlink('../settings.jsonc', join(nested, 'second'), 'file')
    await fs.symlink('second', join(nested, 'first'), 'file')
    expect(await canonical(join(alias, 'first'))).toBe(
      join(await fs.realpath(parent), 'settings.jsonc'),
    )
  })

  test('a dangling chain refuses instead of treating its target as a new file', async () => {
    const file = join(root, 'link')
    await fs.symlink('absent.jsonc', file, 'file')
    await expect(
      Promise.resolve().then(() => canonical(file)),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await fs.readdir(root)).toEqual(['link'])
  })

  test('file symlink loops have a bounded traversal', async () => {
    const first = join(root, 'first')
    await fs.symlink('second', first, 'file')
    await fs.symlink('first', join(root, 'second'), 'file')
    await expect(
      Promise.resolve().then(() => canonical(first)),
    ).rejects.toThrow('Too many file symlink hops')
  })
})
