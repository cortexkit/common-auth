import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { parse } from 'jsonc-parser'
import * as privateFiles from '../../src/fs/private-files.js'
import * as locks from '../../src/fs/with-lock.js'
import { defineSettings } from '../../src/settings/define.js'
import { boolean, integer, object } from '../../src/settings/descriptors.js'
import type { SettingsEdit } from '../../src/settings/edit.js'
import { SettingsFs, setSettingsFsForTest } from '../../src/settings/fs.js'
import {
  type OpenSettingsOptions,
  openSettings,
  resetSettingsReportedForTest,
} from '../../src/settings/handle.js'
import {
  SettingsRefusal,
  type SettingsRefusalCode,
} from '../../src/settings/refusal.js'
import { setSettingsWriteStepHookForTest } from '../../src/settings/write.js'

const definition = defineSettings({
  plugin: 'example',
  settings: {
    x: { value: integer(), default: 1, hosts: 'both' },
    enabled: { value: boolean(), default: false, hosts: 'both' },
    wait: {
      value: integer(),
      default: 1,
      hosts: 'both',
      overrides: { host: true, model: true },
    },
    sidebar: {
      value: object({ collapsed: boolean(), width: integer() }),
      default: { collapsed: false, width: 10 },
      hosts: 'both',
    },
  },
})
const context = { host: 'pi' }
const edit = [{ setting: 'x', value: 2 }]
const realWithLock = locks.withLock
let root: string
let file: string
let warnings: unknown[][]
let restoreSpies: (() => void)[]

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'settings-update-'))
  file = join(root, 'example.jsonc')
  warnings = []
  restoreSpies = []
  resetSettingsReportedForTest()
})

afterEach(async () => {
  for (const restore of restoreSpies) restore()
  setSettingsFsForTest()
  setSettingsWriteStepHookForTest()
  await fs.rm(root, { recursive: true, force: true })
})

function handle(options: Partial<OpenSettingsOptions> = {}) {
  return openSettings(definition, {
    file,
    separateInstall: false,
    log: {
      warn: (...args: unknown[]) => warnings.push(args),
      info: () => {},
    },
    ...options,
  })
}

function fault(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`injected ${code}`), { code })
}

// Settings resolves text paths only; this override also declares Node's buffer overload.
function realpathOverride(
  fn: (path: Parameters<typeof fs.realpath>[0]) => Promise<string>,
): typeof fs.realpath {
  return fn as typeof fs.realpath
}

async function refuses(
  result: Promise<unknown>,
  code: SettingsRefusalCode,
  cause?: unknown,
): Promise<SettingsRefusal> {
  let caught: unknown
  try {
    await result
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(SettingsRefusal)
  expect((caught as SettingsRefusal).code).toBe(code)
  if (cause !== undefined) expect((caught as Error).cause).toBe(cause)
  return caught as SettingsRefusal
}

async function contents(path = file) {
  return parse((await fs.readFile(path, 'utf8')).replace(/^\uFEFF/, ''))
}

describe('settings update', () => {
  test('separate installs refuse without filesystem calls', async () => {
    const calls: string[] = []
    for (const key of Object.keys(SettingsFs) as (keyof typeof SettingsFs)[]) {
      const spy = spyOn(SettingsFs, key).mockImplementation(() => {
        calls.push(key)
        throw new Error('unexpected filesystem call')
      })
      restoreSpies.push(() => spy.mockRestore())
    }
    await refuses(
      handle({ separateInstall: true }).update(edit, context),
      'settings-unavailable',
    )
    expect(calls).toEqual([])
  })

  test('a missing folder refuses before taking a lock and creates nothing', async () => {
    file = join(root, 'missing', 'example.jsonc')
    const lock = spyOn(locks, 'withLock')
    restoreSpies.push(() => lock.mockRestore())
    let cause: unknown
    setSettingsFsForTest({
      stat: (async (path: Parameters<typeof fs.stat>[0]) => {
        try {
          return await fs.stat(path)
        } catch (error) {
          cause = error
          throw error
        }
      }) as typeof fs.stat,
    })
    const refusal = await refuses(
      handle().update(edit, context),
      'settings-unavailable',
    )
    expect(cause).toMatchObject({ code: 'ENOENT' })
    expect(refusal.cause).toBe(cause)
    expect(lock).not.toHaveBeenCalled()
    expect(await fs.readdir(root)).toEqual([])
  })

  test('createMissing prepares private folders before locking and starts a template', async () => {
    file = join(root, 'new', 'nested', 'example.jsonc')
    const events: string[] = []
    setSettingsFsForTest({
      mkdir: (async (
        path: Parameters<typeof fs.mkdir>[0],
        options: Parameters<typeof fs.mkdir>[1],
      ) => {
        events.push('mkdir')
        expect([path, options]).toEqual([
          dirname(file),
          { recursive: true, mode: 0o700 },
        ])
        return fs.mkdir(path, options)
      }) as typeof fs.mkdir,
      realpath: realpathOverride(async (path) => {
        events.push('realpath')
        return fs.realpath(path)
      }),
    })
    expect(await handle({ createMissing: true }).update(edit, context)).toEqual(
      {
        outcome: 'updated',
      },
    )
    if (process.platform !== 'win32') {
      expect(events[0]).toBe('mkdir')
      const mask = process.umask()
      for (const folder of [dirname(file), dirname(dirname(file))]) {
        expect((await fs.stat(folder)).mode & 0o777).toBe(0o700 & ~mask)
      }
    }
    expect(await contents()).toEqual({ schema_version: 1, x: 2 })
    expect(await fs.readFile(file, 'utf8')).toContain('// example settings')
  })

  test('folder creation errors keep their filesystem cause and create nothing', async () => {
    const cause = fault('EACCES')
    setSettingsFsForTest({
      mkdir: async () => {
        throw cause
      },
    })
    if (process.platform === 'win32') {
      const ensure = spyOn(
        privateFiles,
        'ensurePrivateDirectory',
      ).mockRejectedValue(cause)
      restoreSpies.push(() => ensure.mockRestore())
    }
    await refuses(
      handle({ createMissing: true }).update(edit, context),
      'settings-unavailable',
      cause,
    )
    expect(await fs.readdir(root)).toEqual([])
  })

  test.each(['ELOOP', 'EACCES', 'ENOTDIR', 'EIO'])(
    'a realpath %s refuses with its cause and creates nothing',
    async (code) => {
      const cause = fault(code)
      setSettingsFsForTest({
        realpath: async () => {
          throw cause
        },
      })
      await refuses(
        handle({ createMissing: true }).update(edit, context),
        'settings-unavailable',
        cause,
      )
      expect(await fs.readdir(root)).toEqual([])
    },
  )

  test.each(['EACCES', 'EIO'])(
    'a fallback lstat %s refuses with its cause',
    async (code) => {
      const cause = fault(code)
      setSettingsFsForTest({
        lstat: async () => {
          throw cause
        },
      })
      await refuses(
        handle({ createMissing: true }).update(edit, context),
        'settings-unavailable',
        cause,
      )
      expect(await fs.readdir(root)).toEqual([])
    },
  )

  test.each([1, 2])(
    'a regular file realpath ENOENT on resolution %i uses its canonical parent',
    async (failedResolution) => {
      const parent = join(root, 'actual')
      const alias = join(root, 'alias')
      await fs.mkdir(parent)
      await fs.symlink(parent, alias, 'dir')
      file = join(alias, 'example.jsonc')
      await fs.writeFile(file, '{"x":1}')
      const canonical = join(await fs.realpath(root), 'actual', 'example.jsonc')
      const paths: unknown[] = []
      let resolutions = 0
      const lock = spyOn(locks, 'withLock')
      restoreSpies.push(() => lock.mockRestore())
      setSettingsFsForTest({
        realpath: realpathOverride(async (path) => {
          paths.push(path)
          if (path === file && ++resolutions === failedResolution)
            throw fault('ENOENT')
          return fs.realpath(path)
        }),
      })
      const lstat = spyOn(SettingsFs, 'lstat')
      restoreSpies.push(() => lstat.mockRestore())
      expect((await fs.lstat(file)).isFile()).toBe(true)
      expect(await handle().update(edit, context)).toEqual({
        outcome: 'updated',
      })
      expect(lock.mock.calls[0]?.[0]).toBe(canonical)
      expect(lstat).toHaveBeenCalledTimes(1)
      expect(lstat).toHaveBeenCalledWith(file)
      expect(paths).toEqual(
        failedResolution === 1 ? [file, alias, file] : [file, file, alias],
      )
      expect(await contents(canonical)).toEqual({ x: 2 })
    },
  )

  test('a missing target uses its real parent and parent-resolution errors keep their cause', async () => {
    const cause = fault('EACCES')
    setSettingsFsForTest({
      realpath: realpathOverride(async (path) => {
        if (path === dirname(file)) throw cause
        return fs.realpath(path)
      }),
    })
    await refuses(
      handle({ createMissing: true }).update(edit, context),
      'settings-unavailable',
      cause,
    )
    expect(await fs.readdir(root)).toEqual([])
  })

  test('a missing file requires createMissing and preserves the read error cause', async () => {
    const cause = fault('ENOENT')
    setSettingsFsForTest({
      readFile: async () => {
        throw cause
      },
    })
    await refuses(handle().update(edit, context), 'settings-unavailable', cause)
    expect(await fs.readdir(root)).toEqual([])
  })

  test.each(['EACCES', 'EISDIR', 'EIO'])(
    'a readFile %s refuses even with createMissing',
    async (code) => {
      const source = '{"x":1}'
      await fs.writeFile(file, source)
      const cause = fault(code)
      setSettingsFsForTest({
        readFile: async () => {
          throw cause
        },
      })
      await refuses(
        handle({ createMissing: true }).update(edit, context),
        'settings-unavailable',
        cause,
      )
      expect(await fs.readFile(file, 'utf8')).toBe(source)
      expect(await fs.readdir(root)).toEqual([basename(file)])
    },
  )

  test.each(['', ' \t\r\n', '\uFEFF \n'])(
    'an empty existing file %j starts a template without needing createMissing',
    async (source) => {
      await fs.writeFile(file, source)
      expect(await handle().update(edit, context)).toEqual({
        outcome: 'updated',
      })
      expect(await contents()).toEqual({ schema_version: 1, x: 2 })
      const text = await fs.readFile(file, 'utf8')
      expect(text.startsWith('\uFEFF')).toBe(source.startsWith('\uFEFF'))
      expect(text).toContain('// example settings')
    },
  )

  test.each([
    ['{"x":', 'settings-unparseable'],
    ['[]', 'settings-unparseable'],
    ['{"x":1,"x":2}', 'settings-unparseable'],
    ['{"wait":{"pi":1,"pi":2}}', 'settings-unparseable'],
    ['{"unknown":{"nested":{"a":1,"a":2}}}', 'settings-unparseable'],
    ['{"schema_version":2,"x":1}', 'settings-newer-version'],
  ] as const)('refuses %s without changing any bytes', async (source, code) => {
    await fs.writeFile(file, source)
    const staged = spyOn(SettingsFs, 'open')
    restoreSpies.push(() => staged.mockRestore())
    await refuses(handle().update(edit, context), code)
    expect(staged).not.toHaveBeenCalled()
    expect(await fs.readFile(file, 'utf8')).toBe(source)
  })

  test.each(['', '\uFEFF'])(
    'preserves %j BOM, comments, order and unknown keys through update',
    async (bom) => {
      const source = `${bom}{\n  // future setting\n  "unknown": 9,\n  "x" :  1, // keep\n  "enabled": false,\n}\n`
      await fs.writeFile(file, source)
      expect(await handle().update(edit, context)).toEqual({
        outcome: 'updated',
      })
      expect(await fs.readFile(file, 'utf8')).toBe(
        source.replace('"x" :  1', '"x" :  2'),
      )
    },
  )

  test.each(['{"x":1}', '{"x" :  1e0}', '\uFEFF{ /* keep */ "x":1}'])(
    'a net-equal batch on %s stages nothing and preserves bytes',
    async (source) => {
      await fs.writeFile(file, source)
      const staged = spyOn(SettingsFs, 'open')
      restoreSpies.push(() => staged.mockRestore())
      const settings = handle()
      expect(
        await settings.update([{ setting: 'x', value: 1 }], context),
      ).toEqual({ outcome: 'unchanged' })
      expect(
        await settings.update([...edit, { setting: 'x', value: 1 }], context),
      ).toEqual({ outcome: 'unchanged' })
      expect(staged).not.toHaveBeenCalled()
      expect(await fs.readFile(file, 'utf8')).toBe(source)
    },
  )

  test('a valid object-field edit keeps invalid siblings stored and reported', async () => {
    await fs.writeFile(file, '{"sidebar":{"collapsed":"yes"}}')
    const settings = handle()
    expect(
      await settings.update(
        [{ setting: 'sidebar', path: ['width'], value: 3 }],
        context,
      ),
    ).toEqual({ outcome: 'updated' })
    expect(await settings.get('sidebar', context)).toEqual({
      width: 3,
      collapsed: false,
    })
    expect(await contents()).toEqual({
      sidebar: { collapsed: 'yes', width: 3 },
    })
    expect(settings.report()).toEqual([
      {
        file: { kind: 'user', path: file },
        keyPath: ['sidebar', 'collapsed'],
        reason: 'invalid-value',
      },
    ])
  })

  test.each([
    { setting: 'unknown', value: 3 },
    { setting: 'x', value: 'bad' },
    { setting: 'sidebar', path: ['other'], value: 3 },
  ] satisfies SettingsEdit[])(
    'one invalid edit %j refuses the entire batch',
    async (invalid) => {
      const source = '{"x":1}'
      await fs.writeFile(file, source)
      const staged = spyOn(SettingsFs, 'open')
      restoreSpies.push(() => staged.mockRestore())
      await refuses(
        handle().update([...edit, invalid], context),
        'settings-invalid-value',
      )
      expect(staged).not.toHaveBeenCalled()
      expect(await fs.readFile(file, 'utf8')).toBe(source)
    },
  )

  test('model then host override destinations are wired through the handle', async () => {
    await fs.writeFile(file, '{"wait":{"default":1,"pi":2,"model-a":3}}')
    const settings = handle()
    expect(
      await settings.update([{ setting: 'wait', value: 4 }], {
        host: 'pi',
        model: 'model-a',
      }),
    ).toEqual({ outcome: 'updated' })
    expect(
      await settings.update([{ setting: 'wait', value: 5 }], context),
    ).toEqual({ outcome: 'updated' })
    expect(await contents()).toEqual({
      wait: { default: 1, pi: 5, 'model-a': 4 },
    })
  })

  test('a symlink update preserves the link and edits its target', async () => {
    const target = join(root, 'actual.jsonc')
    await fs.writeFile(target, '{"x":1}')
    await fs.symlink(target, file, 'file')
    expect(await handle().update(edit, context)).toEqual({ outcome: 'updated' })
    expect((await fs.lstat(file)).isSymbolicLink()).toBe(true)
    expect(await contents(target)).toEqual({ x: 2 })
  })

  test('a dangling link refuses with the realpath cause and creates no target', async () => {
    const target = join(root, 'absent.jsonc')
    await fs.symlink(target, file, 'file')
    let cause: unknown
    setSettingsFsForTest({
      realpath: realpathOverride(async (path) => {
        try {
          return await fs.realpath(path)
        } catch (error) {
          cause = error
          throw error
        }
      }),
    })
    const refusal = await refuses(
      handle({ createMissing: true }).update(edit, context),
      'settings-unavailable',
    )
    expect(cause).toMatchObject({ code: 'ENOENT' })
    expect(refusal.cause).toBe(cause)
    expect((await fs.lstat(file)).isSymbolicLink()).toBe(true)
    expect(await fs.readdir(root)).toEqual([basename(file)])
  })

  test('a symlink loop refuses and creates nothing', async () => {
    const other = join(root, 'loop.jsonc')
    await fs.symlink(other, file, 'file')
    await fs.symlink(file, other, 'file')
    await refuses(
      handle({ createMissing: true }).update(edit, context),
      'settings-unavailable',
    )
    expect((await fs.lstat(file)).isSymbolicLink()).toBe(true)
    expect((await fs.lstat(other)).isSymbolicLink()).toBe(true)
    expect((await fs.readdir(root)).sort()).toEqual(
      [basename(file), basename(other)].sort(),
    )
  })

  test('a retargeted link under the lock refuses busy and leaves both targets untouched', async () => {
    const first = join(root, 'first.jsonc')
    const second = join(root, 'second.jsonc')
    await fs.writeFile(first, '{"x":1}')
    await fs.writeFile(second, '{"x":3}')
    await fs.symlink(first, file, 'file')
    let resolutions = 0
    setSettingsFsForTest({
      realpath: realpathOverride(async (path) => {
        if (path === file && ++resolutions === 2) {
          await fs.unlink(file)
          await fs.symlink(second, file, 'file')
        }
        return fs.realpath(path)
      }),
    })
    await refuses(handle().update(edit, context), 'settings-busy')
    expect(await fs.readFile(first, 'utf8')).toBe('{"x":1}')
    expect(await fs.readFile(second, 'utf8')).toBe('{"x":3}')
    expect((await fs.lstat(file)).isSymbolicLink()).toBe(true)
    expect((await fs.readdir(root)).length).toBe(3)
  })

  test('symlink and target handles share a renewable canonical lock and keep concurrent edits', async () => {
    const target = join(root, 'actual.jsonc')
    await fs.writeFile(target, '{"x":1,"enabled":false}')
    await fs.symlink(target, file, 'file')
    const canonical = await fs.realpath(target)
    const lock = spyOn(locks, 'withLock')
    restoreSpies.push(() => lock.mockRestore())
    const firstStaged = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<void>()
    let stages = 0
    setSettingsWriteStepHookForTest(async () => {
      if (++stages === 1) {
        firstStaged.resolve()
        await releaseFirst.promise
      }
    })
    const first = handle({ lockTimeoutMs: 1234 }).update(edit, context)
    await firstStaged.promise
    const second = handle({ file: target }).update(
      [{ setting: 'enabled', value: true }],
      context,
    )
    releaseFirst.resolve()
    expect(await Promise.all([first, second])).toEqual([
      { outcome: 'updated' },
      { outcome: 'updated' },
    ])
    expect(await contents(target)).toEqual({ x: 2, enabled: true })
    expect((await fs.lstat(file)).isSymbolicLink()).toBe(true)
    expect(lock).toHaveBeenCalledTimes(2)
    expect(lock.mock.calls.map(([path]) => path)).toEqual([
      canonical,
      canonical,
    ])
    expect(lock.mock.calls[0]?.[1]).toEqual({
      name: 'settings-write',
      ttlMs: 10_000,
      timeoutMs: 1234,
      renew: true,
    })
    expect(lock.mock.calls[1]?.[1]).toEqual({
      name: 'settings-write',
      ttlMs: 10_000,
      timeoutMs: 2000,
      renew: true,
    })
  })

  test('a held settings-write lock refuses busy with the contention cause', async () => {
    await fs.writeFile(file, '{"x":1}')
    const target = await fs.realpath(file)
    await realWithLock(
      target,
      { name: 'settings-write', ttlMs: 10_000, timeoutMs: 0 },
      async () => {
        let caught: unknown
        try {
          await handle({ lockTimeoutMs: 0 }).update(edit, context)
        } catch (error) {
          caught = error
        }
        expect(caught).toBeInstanceOf(SettingsRefusal)
        expect(caught).toMatchObject({
          code: 'settings-busy',
          cause: expect.any(locks.LockContentionError),
        })
      },
    )
    expect(await fs.readFile(file, 'utf8')).toBe('{"x":1}')
  })

  test('a release rejection after rename warns once but still returns updated', async () => {
    await fs.writeFile(file, '{"x":1}')
    const cause = new Error('injected release rejection')
    const lock = spyOn(locks, 'withLock').mockImplementation(
      async (target, options, callback) => {
        await realWithLock(target, options, callback)
        throw cause
      },
    )
    restoreSpies.push(() => lock.mockRestore())
    expect(await handle().update(edit, context)).toEqual({ outcome: 'updated' })
    expect(await contents()).toEqual({ x: 2 })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toEqual([
      'Settings lock release failed',
      { target: await fs.realpath(file), error: cause },
    ])
  })

  test('a release rejection preserves a callback refusal and warns only for release', async () => {
    await fs.writeFile(file, '{"x":')
    const cause = new Error('injected release rejection')
    const lock = spyOn(locks, 'withLock').mockImplementation(
      async (target, options, callback) => {
        await realWithLock(target, options, callback).catch(() => {})
        throw cause
      },
    )
    restoreSpies.push(() => lock.mockRestore())
    await refuses(handle().update(edit, context), 'settings-unparseable')
    expect(warnings).toHaveLength(1)
    expect(await fs.readFile(file, 'utf8')).toBe('{"x":')
  })

  test('a normal callback refusal is not logged as a release failure', async () => {
    await fs.writeFile(file, '{"x":')
    await refuses(handle().update(edit, context), 'settings-unparseable')
    expect(warnings).toEqual([])
  })
})
