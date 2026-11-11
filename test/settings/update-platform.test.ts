import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { parse } from 'jsonc-parser'
import {
  PrivateFileError,
  setPrivateFilesBackendForTest,
} from '../../src/fs/private-files.js'
import { defineSettings } from '../../src/settings/define.js'
import { integer } from '../../src/settings/descriptors.js'
import { setSettingsFsForTest } from '../../src/settings/fs.js'
import {
  type OpenSettingsOptions,
  openSettings,
  resetSettingsReportedForTest,
} from '../../src/settings/handle.js'
import {
  SettingsRefusal,
  type SettingsRefusalCode,
} from '../../src/settings/refusal.js'

const definition = defineSettings({
  plugin: 'example',
  settings: { x: { value: integer(), default: 1, hosts: 'both' } },
})
const context = { host: 'pi' }
const edits = [{ setting: 'x', value: 2 }]
const original = '// hand-made settings\n{"schema_version": 1, "x": 1}\n'
let root: string
let file: string
let originalUmask: number

beforeEach(async () => {
  originalUmask = process.umask()
  root = await fs.mkdtemp(join(tmpdir(), 'settings-update-platform-'))
  file = join(root, 'example.jsonc')
  resetSettingsReportedForTest()
})

afterEach(async () => {
  if (process.platform !== 'win32') process.umask(originalUmask)
  setSettingsFsForTest()
  setPrivateFilesBackendForTest()
  await fs.rm(root, { recursive: true, force: true })
})

function handle(options: Partial<OpenSettingsOptions> = {}) {
  return openSettings(definition, {
    file,
    separateInstall: false,
    log: { warn: () => {}, info: () => {} },
    ...options,
  })
}

async function refuses(
  pending: Promise<unknown>,
  code: SettingsRefusalCode,
): Promise<SettingsRefusal> {
  let caught: unknown
  try {
    await pending
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(SettingsRefusal)
  expect(caught).toMatchObject({ code })
  return caught as SettingsRefusal
}

describe('settings update platform contract', () => {
  test.each(['existing', 'missing'] as const)(
    'a missing file with parent=%s requires createMissing and creates nothing',
    async (parent) => {
      if (parent === 'missing')
        file = join(root, 'absent', 'nested', basename(file))
      const refusal = await refuses(
        handle().update(edits, context),
        'settings-unavailable',
      )
      expect(refusal.cause).toMatchObject({ code: 'ENOENT' })
      expect(await fs.readdir(root)).toEqual([])
      await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  test('createMissing creates missing ancestors and a versioned plugin template', async () => {
    file = join(root, 'new', 'nested', basename(file))
    const settings = handle({ createMissing: true })
    expect(await settings.update(edits, context)).toEqual({
      outcome: 'updated',
    })
    const text = await fs.readFile(file, 'utf8')
    expect(text).toStartWith('// example settings\n')
    expect(parse(text)).toEqual({ schema_version: 1, x: 2 })
    expect(await settings.get('x', context)).toBe(2)
    expect(await fs.readdir(dirname(file))).toEqual([basename(file)])
  })

  test.skipIf(process.platform === 'win32')(
    'POSIX update preserves an existing 0644 file despite a restrictive umask',
    async () => {
      await fs.writeFile(file, original)
      await fs.chmod(file, 0o644)
      await fs.chmod(root, 0o755)
      process.umask(0o077)
      expect(
        await handle({ createMissing: true }).update(edits, context),
      ).toEqual({
        outcome: 'updated',
      })
      expect((await fs.stat(file)).mode & 0o777).toBe(0o644)
      expect((await fs.stat(root)).mode & 0o777).toBe(0o755)
      expect(parse(await fs.readFile(file, 'utf8')).x).toBe(2)
    },
  )

  test.skipIf(process.platform === 'win32').each([
    { mask: 0o022, expected: 0o644 },
    { mask: 0o027, expected: 0o640 },
    { mask: 0o077, expected: 0o600 },
  ])('POSIX new file respects umask $mask', async ({ mask, expected }) => {
    process.umask(mask)
    expect(
      await handle({ createMissing: true }).update(edits, context),
    ).toEqual({
      outcome: 'updated',
    })
    expect((await fs.stat(file)).mode & 0o777).toBe(expected)
    expect(parse(await fs.readFile(file, 'utf8'))).toEqual({
      schema_version: 1,
      x: 2,
    })
  })

  test.skipIf(process.platform === 'win32')(
    'POSIX missing ancestors are 0700 and existing ancestors are left alone',
    async () => {
      await fs.chmod(root, 0o755)
      process.umask(0o022)
      const first = join(root, 'new')
      const second = join(first, 'nested')
      file = join(second, basename(file))
      expect(
        await handle({ createMissing: true }).update(edits, context),
      ).toEqual({
        outcome: 'updated',
      })
      expect((await fs.stat(first)).mode & 0o777).toBe(0o700)
      expect((await fs.stat(second)).mode & 0o777).toBe(0o700)
      expect((await fs.stat(root)).mode & 0o777).toBe(0o755)
    },
  )

  test('update syncs and closes the staged settings file before rename', async () => {
    await fs.writeFile(file, original)
    const events: string[] = []
    setSettingsFsForTest({
      open: async (path, flags, mode) => {
        const staged = await fs.open(path, flags, mode)
        return {
          writeFile: staged.writeFile.bind(staged),
          chmod: staged.chmod.bind(staged),
          async sync() {
            await staged.sync()
            events.push('sync')
          },
          async close() {
            await staged.close()
            events.push('close')
          },
        } as Awaited<ReturnType<typeof fs.open>>
      },
      async rename(from, to) {
        events.push('rename')
        await fs.rename(from, to)
      },
    })
    expect(await handle().update(edits, context)).toEqual({
      outcome: 'updated',
    })
    expect(events).toEqual(['sync', 'close', 'rename'])
    expect(parse(await fs.readFile(file, 'utf8')).x).toBe(2)
  })

  test.skipIf(process.platform !== 'win32').each([false, true])(
    'Windows inherited ACLs allow plain reads and updates with createMissing=%s',
    async (createMissing) => {
      await fs.writeFile(file, original)
      const api = await import('@cortexkit/private-files')
      // An inherited settings ACL need not satisfy the secret-file policy.
      expect((await api.verifyOwnerOnly(file)).ok).toBe(false)
      file = await fs.realpath(file)
      let reads = 0
      let stats = 0
      setSettingsFsForTest({
        readFile: (async (...args: Parameters<typeof fs.readFile>) => {
          if (String(args[0]) === file) reads++
          return fs.readFile(...args)
        }) as typeof fs.readFile,
        stat: (async (...args: Parameters<typeof fs.stat>) => {
          if (String(args[0]) === file) stats++
          return fs.stat(...args)
        }) as typeof fs.stat,
      })
      const settings = handle({ createMissing })
      expect(await settings.get('x', context)).toBe(1)
      expect(reads).toBe(1)
      expect(stats).toBeGreaterThanOrEqual(1)
      expect(await settings.update(edits, context)).toEqual({
        outcome: 'updated',
      })
      expect(reads).toBeGreaterThanOrEqual(2)
      expect(stats).toBeGreaterThanOrEqual(2)
      expect(await settings.get('x', context)).toBe(2)
      expect(settings.report()).toEqual([])
      expect((await api.verifyOwnerOnly(file)).ok).toBe(false)
      expect(await fs.readdir(root)).toEqual([basename(file)])
    },
  )

  test.skipIf(process.platform !== 'win32').each([false, true])(
    'Windows unsafe parent refuses update but not get with createMissing=%s',
    async (createMissing) => {
      await fs.writeFile(file, original)
      const folder = dirname(await fs.realpath(file))
      const api = await import('@cortexkit/private-files')
      const checked: string[] = []
      setPrivateFilesBackendForTest({
        ...api,
        verifySafeParent: async (path, policy) => {
          checked.push(path)
          if (path.toLowerCase() === folder.toLowerCase()) {
            return {
              ok: false,
              reason: api.WRITABLE_BY_OTHERS,
              path,
              level: path,
            }
          }
          return api.verifySafeParent(path, policy)
        },
      })
      let staged = 0
      setSettingsFsForTest({
        open: async (...args) => {
          staged++
          return fs.open(...args)
        },
      })
      const settings = handle({ createMissing })
      expect(await settings.get('x', context)).toBe(1)
      const refusal = await refuses(
        settings.update(edits, context),
        'settings-unavailable',
      )
      expect(refusal.cause).toBeInstanceOf(PrivateFileError)
      expect(refusal.cause).toMatchObject({
        stage: 'safe-parent',
        reason: 'writable-by-others',
      })
      expect(checked.map((path) => path.toLowerCase())).toContain(
        folder.toLowerCase(),
      )
      expect(staged).toBe(0)
      expect(await fs.readFile(file, 'utf8')).toBe(original)
      expect(await fs.readdir(root)).toEqual([basename(file)])
      expect(await settings.get('x', context)).toBe(1)
      expect(settings.report()).toEqual([])
    },
  )

  test.skipIf(process.platform !== 'win32')(
    'Windows rename EBUSY refuses update as settings-busy and keeps the file',
    async () => {
      await fs.writeFile(file, original)
      const busy = Object.assign(new Error('injected rename EBUSY'), {
        code: 'EBUSY',
      })
      const renames: string[] = []
      setSettingsFsForTest({
        async rename(_from, to) {
          renames.push(String(to))
          throw busy
        },
      })
      const refusal = await refuses(
        handle().update(edits, context),
        'settings-busy',
      )
      expect(refusal.cause).toBe(busy)
      expect(renames).toEqual([await fs.realpath(file)])
      expect(await fs.readFile(file, 'utf8')).toBe(original)
      expect(await fs.readdir(root)).toEqual([basename(file)])
    },
  )
})
