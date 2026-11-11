import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { LockOwnershipError } from '../../src/fs/with-lock.js'
import { setSettingsFsForTest } from '../../src/settings/fs.js'
import { SettingsRefusal } from '../../src/settings/refusal.js'
import {
  setSettingsWriteStepHookForTest,
  writeSettings,
} from '../../src/settings/write.js'

let root: string
let target: string
let events: string[]
let opened: { path: string; flags: unknown; mode: unknown }[]
let chmods: number[]

const original = '// saved by the user\n{"x": 1}\n'
const edited = '// saved by the user\n{"x": 2}\n'

function fault(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`injected ${code}`), { code })
}

function observeFs(failure?: { operation: string; error: Error }): void {
  function step(operation: string): void {
    events.push(operation)
    if (failure?.operation === operation) throw failure.error
  }
  setSettingsFsForTest({
    open: async (path, flags, mode) => {
      opened.push({ path: String(path), flags, mode })
      step('open')
      const file = await fs.open(path, flags, mode)
      return {
        async writeFile(data, options) {
          step('writeFile')
          return file.writeFile(data, options)
        },
        async chmod(mode) {
          chmods.push(Number(mode))
          step('chmod')
          return file.chmod(mode)
        },
        async sync() {
          step('sync')
          return file.sync()
        },
        async close() {
          await file.close()
          step('close')
        },
      } as Awaited<ReturnType<typeof fs.open>>
    },
    async rename(from, to) {
      step('rename')
      await fs.rename(from, to)
    },
    async link(from, to) {
      step('link')
      await fs.link(from, to)
    },
    async unlink(path) {
      step('unlink')
      await fs.unlink(path)
    },
  })
}

function write(overrides: Partial<Parameters<typeof writeSettings>[0]> = {}) {
  return writeSettings({
    target,
    text: edited,
    hasBom: false,
    existingMode: 0o644,
    lock: {
      async assertOwned() {
        events.push('assertOwned')
      },
    },
    ...overrides,
  })
}

async function expectNoTemp(): Promise<void> {
  expect(
    (await fs.readdir(root)).filter((name) => name.endsWith('.tmp')),
  ).toEqual([])
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'settings-write-'))
  target = join(root, 'settings.jsonc')
  events = []
  opened = []
  chmods = []
  await fs.writeFile(target, original)
  observeFs()
})

afterEach(async () => {
  setSettingsWriteStepHookForTest()
  setSettingsFsForTest()
  await fs.rm(root, { recursive: true, force: true })
})

describe('settings staged writer', () => {
  test('stages exclusively beside the target, syncs and closes before owned rename', async () => {
    expect(await write()).toEqual({ outcome: 'updated' })
    expect(opened).toHaveLength(1)
    const stage = opened[0]!
    expect(dirname(stage.path)).toBe(dirname(target))
    expect(basename(stage.path)).toMatch(
      /^settings\.jsonc\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/,
    )
    expect(stage.flags).toBe('wx')
    expect(stage.mode).toBe(0o644)
    expect(events).toEqual([
      'open',
      'writeFile',
      ...(process.platform === 'win32' ? [] : ['chmod']),
      'sync',
      'close',
      'assertOwned',
      'rename',
    ])
    expect(await fs.readFile(target, 'utf8')).toBe(edited)
    await expectNoTemp()
  })

  test.each([true, false])(
    'restores a stripped BOM only when hasBom=%s',
    async (hasBom) => {
      await fs.writeFile(target, `${hasBom ? '\uFEFF' : ''}${original}`)
      await write({ hasBom })
      expect(await fs.readFile(target, 'utf8')).toBe(
        `${hasBom ? '\uFEFF' : ''}${edited}`,
      )
      await expectNoTemp()
    },
  )

  test.skipIf(process.platform === 'win32')(
    'preserves POSIX permission bits but strips file type and special bits',
    async () => {
      await fs.chmod(target, 0o751)
      await write({ existingMode: 0o106751 })
      expect(chmods).toEqual([0o751])
      expect((await fs.stat(target)).mode & 0o7777).toBe(0o751)
    },
  )

  test.skipIf(process.platform === 'win32')(
    'keeps an existing 0644 file at 0644',
    async () => {
      await fs.chmod(target, 0o644)
      await write({ existingMode: (await fs.stat(target)).mode })
      expect((await fs.stat(target)).mode & 0o777).toBe(0o644)
    },
  )

  test('publishes a missing file with link then unlinks the temp, never rename', async () => {
    await fs.unlink(target)
    expect(await write({ existingMode: undefined })).toEqual({
      outcome: 'updated',
    })
    expect(events).toEqual([
      'open',
      'writeFile',
      'sync',
      'close',
      'assertOwned',
      'link',
      'unlink',
    ])
    expect(opened[0]!.mode).toBe(0o644)
    expect(chmods).toEqual([])
    expect(await fs.readFile(target, 'utf8')).toBe(edited)
    if (process.platform !== 'win32') {
      expect((await fs.stat(target)).mode & 0o777).toBe(
        0o644 & ~process.umask(),
      )
    }
    await expectNoTemp()
  })

  test('staged hook pauses after close and before the ownership fence', async () => {
    let staged!: () => void
    const reached = new Promise<void>((resolve) => {
      staged = resolve
    })
    let release!: () => void
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    const lost = new LockOwnershipError({ target, name: 'settings-write' })
    let owned = true
    setSettingsWriteStepHookForTest(async (step, paths) => {
      expect(step).toBe('staged')
      expect(paths.target).toBe(target)
      expect(paths.temp).toBe(opened[0]!.path)
      expect(await fs.readFile(paths.temp, 'utf8')).toBe(edited)
      expect(events.at(-1)).toBe('close')
      staged()
      await paused
    })
    const pending = write({
      lock: {
        async assertOwned() {
          events.push('assertOwned')
          if (!owned) throw lost
        },
      },
    })
    try {
      await reached
      expect(events).not.toContain('assertOwned')
      expect(events).not.toContain('rename')
      expect(await fs.readFile(target, 'utf8')).toBe(original)
      owned = false
    } finally {
      release()
    }
    await expect(pending).rejects.toBe(lost)
    expect(events.at(-2)).toBe('assertOwned')
    expect(events.at(-1)).toBe('unlink')
    expect(await fs.readFile(target, 'utf8')).toBe(original)
    await expectNoTemp()
  })

  test.each(['EPERM', 'EACCES', 'EBUSY'])(
    'Windows rename %s refuses as settings-busy without retry',
    async (code) => {
      const error = fault(code)
      observeFs({ operation: 'rename', error })
      await expect(write({ platform: 'win32' })).rejects.toMatchObject({
        name: 'SettingsRefusal',
        code: 'settings-busy',
        cause: error,
      })
      expect(events.filter((event) => event === 'rename')).toHaveLength(1)
      expect(chmods).toEqual([])
      expect(await fs.readFile(target, 'utf8')).toBe(original)
      await expectNoTemp()
    },
  )

  test.each(['linux', 'darwin'] as const)(
    '%s rename EBUSY is rethrown unchanged',
    async (platform) => {
      const error = fault('EBUSY')
      observeFs({ operation: 'rename', error })
      await expect(write({ platform })).rejects.toBe(error)
      expect(await fs.readFile(target, 'utf8')).toBe(original)
      await expectNoTemp()
    },
  )

  test('Windows unrelated rename IO error is rethrown unchanged', async () => {
    const error = fault('EIO')
    observeFs({ operation: 'rename', error })
    await expect(write({ platform: 'win32' })).rejects.toBe(error)
    expect(await fs.readFile(target, 'utf8')).toBe(original)
    await expectNoTemp()
  })

  test('missing-file publication refuses EEXIST and keeps the file that appeared', async () => {
    await fs.unlink(target)
    const appeared = '// published by another writer\n{"x": 9}\n'
    setSettingsWriteStepHookForTest(async () => {
      await fs.writeFile(target, appeared, { flag: 'wx' })
    })
    let caught: unknown
    try {
      await write({ existingMode: undefined })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(SettingsRefusal)
    expect(caught).toMatchObject({
      code: 'settings-busy',
      cause: { code: 'EEXIST' },
    })
    expect(events.filter((event) => event === 'link')).toHaveLength(1)
    expect(events).not.toContain('rename')
    expect(await fs.readFile(target, 'utf8')).toBe(appeared)
    await expectNoTemp()
  })

  test('temp unlink failure after link warns once and stays updated', async () => {
    await fs.unlink(target)
    const error = fault('EACCES')
    const warnings: { message: string; details?: Record<string, unknown> }[] =
      []
    observeFs({ operation: 'unlink', error })
    expect(
      await write({
        existingMode: undefined,
        logger: {
          warn: (message, details) => {
            warnings.push({ message, details })
          },
        },
      }),
    ).toEqual({ outcome: 'updated' })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.message).toContain('cleanup')
    expect(warnings[0]!.details).toEqual({
      target,
      temp: opened[0]!.path,
      error,
    })
    expect(events.filter((event) => event === 'unlink')).toHaveLength(1)
    expect(await fs.readFile(target, 'utf8')).toBe(edited)
    expect(await fs.readFile(opened[0]!.path, 'utf8')).toBe(edited)
  })

  test.each(['open', 'writeFile', 'chmod', 'sync', 'close', 'rename'])(
    '%s failure removes the temp and leaves the existing target unchanged',
    async (operation) => {
      const error = fault('EIO')
      observeFs({ operation, error })
      await expect(write({ platform: 'linux' })).rejects.toBe(error)
      expect(await fs.readFile(target, 'utf8')).toBe(original)
      if (operation !== 'open') {
        expect(events).toContain('close')
        expect(events.at(-1)).toBe('unlink')
      }
      if (operation !== 'rename') expect(events).not.toContain('rename')
      await expectNoTemp()
    },
  )

  test('staged hook failure removes the temp and does not publish', async () => {
    const error = new Error('hook failed')
    setSettingsWriteStepHookForTest(() => {
      throw error
    })
    await expect(write()).rejects.toBe(error)
    expect(events).not.toContain('assertOwned')
    expect(events).not.toContain('rename')
    expect(await fs.readFile(target, 'utf8')).toBe(original)
    await expectNoTemp()
  })

  test('failed missing-file link removes the temp without creating a target', async () => {
    await fs.unlink(target)
    const error = fault('EIO')
    observeFs({ operation: 'link', error })
    await expect(write({ existingMode: undefined })).rejects.toBe(error)
    expect(events.at(-1)).toBe('unlink')
    expect(await fs.readdir(root)).toEqual([])
  })

  test('exclusive-open failure does not delete a temp it did not create', async () => {
    const collision = fault('EEXIST')
    setSettingsFsForTest({
      async open(path) {
        opened.push({ path: String(path), flags: 'wx', mode: 0o644 })
        await fs.writeFile(path, 'belongs to another writer')
        throw collision
      },
      async unlink() {
        throw new Error('must not unlink unowned temp')
      },
    })
    await expect(write()).rejects.toBe(collision)
    expect(await fs.readFile(opened[0]!.path, 'utf8')).toBe(
      'belongs to another writer',
    )
    expect(await fs.readFile(target, 'utf8')).toBe(original)
  })
})
