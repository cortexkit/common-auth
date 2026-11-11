import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { defineSettings } from '../../src/settings/define.js'
import { integer } from '../../src/settings/descriptors.js'
import { SettingsFs, setSettingsFsForTest } from '../../src/settings/fs.js'
import {
  openSettings,
  resetSettingsReportedForTest,
} from '../../src/settings/handle.js'
import type { ReportEntry } from '../../src/settings/snapshot.js'

const definition = defineSettings({
  plugin: 'levels-test',
  settings: {
    wait: {
      value: integer(),
      default: 10,
      hosts: 'both',
      project: 'allowed',
      overrides: { host: true, model: true },
    },
    private_value: { value: integer(), default: 20, hosts: 'both' },
  },
})
const host = { host: 'opencode' }
let home: string
let file: string
let project: string
let projectFile: string
let legacyFile: string

beforeEach(async () => {
  resetSettingsReportedForTest()
  home = await mkdtemp(join(tmpdir(), 'settings-levels-'))
  file = join(home, 'user.jsonc')
  project = join(home, 'project')
  projectFile = join(project, '.cortexkit', 'levels-test.jsonc')
  legacyFile = join(project, 'legacy.json')
})
afterEach(async () => {
  setSettingsFsForTest()
  resetSettingsReportedForTest()
  await rm(home, { recursive: true, force: true })
})

// Replacing the inode makes cache invalidation independent of clock precision.
async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(`${path}.next`, text)
  await rename(`${path}.next`, path)
}

function logger() {
  return { warn: mock((_message: string, _data?: unknown) => {}), info() {} }
}

function entry(
  kind: ReportEntry['file']['kind'],
  path: string,
  keyPath: string[],
  reason: ReportEntry['reason'],
): ReportEntry {
  return { file: { kind, path }, keyPath, reason }
}

describe('settings levels', () => {
  test('project values apply only to allowed settings and an explicit project', async () => {
    await put(file, '{ "wait": 2, "private_value": 21 }')
    await put(projectFile, '{ "wait": 3, "private_value": 99 }')
    const paths: string[] = []
    setSettingsFsForTest({
      stat: (async (...args: Parameters<typeof stat>) => {
        paths.push(String(args[0]))
        return stat(...args)
      }) as typeof stat,
    })
    const log = logger()
    const legacyProject = mock(() => undefined)
    const handle = openSettings(definition, {
      file,
      log,
      separateInstall: false,
      legacyProject,
    })
    expect(await handle.get('wait', host)).toBe(2)
    expect(paths).toEqual([file])
    expect(handle.report()).toEqual([])
    expect(await handle.get('wait', { ...host, project })).toBe(3)
    expect(await handle.get('private_value', { ...host, project })).toBe(21)
    expect(await handle.get('wait', host)).toBe(2)
    expect(handle.report()).toEqual([
      entry('project', projectFile, ['private_value'], 'user-only-in-project'),
    ])
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(legacyProject).not.toHaveBeenCalled()
    await unlink(file)
    expect(await handle.get('private_value', { ...host, project })).toBe(20)
    expect(await handle.get('wait', host)).toBe(10)
  })

  test('the legacy reader supplies the cached project level only while the new file is absent', async () => {
    await put(file, '{ "wait": 2 }')
    await put(legacyFile, '{ "old_wait": 7 }')
    const reader = mock((text: string) => ({
      wait: JSON.parse(text).old_wait,
      private_value: 99,
      unknown: true,
    }))
    const legacyProject = mock((requested: string) => {
      expect(requested).toBe(project)
      return { path: legacyFile, read: reader }
    })
    const handle = openSettings(definition, {
      file,
      log: logger(),
      separateInstall: false,
      legacyProject,
    })
    expect(await handle.get('wait', host)).toBe(2)
    expect(legacyProject).not.toHaveBeenCalled()
    expect(await handle.get('wait', { ...host, project })).toBe(7)
    expect(await handle.get('private_value', { ...host, project })).toBe(20)
    expect(handle.report()).toEqual([
      entry(
        'legacy-project',
        legacyFile,
        ['private_value'],
        'user-only-in-project',
      ),
      entry('legacy-project', legacyFile, ['unknown'], 'unknown-key'),
    ])
    const calls: string[] = []
    setSettingsFsForTest({
      stat: (async (...args: Parameters<typeof stat>) => {
        calls.push(String(args[0]))
        return stat(...args)
      }) as typeof stat,
      readFile: mock(readFile) as typeof readFile,
    })
    await handle.read({ project })
    expect(calls.toSorted()).toEqual([file, projectFile, legacyFile].toSorted())
    expect(SettingsFs.readFile).not.toHaveBeenCalled()
    expect(reader).toHaveBeenCalledTimes(1)
    await put(legacyFile, '{ "old_wait": 8 }')
    expect(await handle.get('wait', { ...host, project })).toBe(8)
    expect(reader).toHaveBeenCalledTimes(2)
    await put(projectFile, '{}')
    legacyProject.mockClear()
    await handle.read({ project })
    expect(handle.report()).toEqual([])
    expect(await handle.get('wait', { ...host, project })).toBe(2)
    expect(legacyProject).not.toHaveBeenCalled()
    expect(reader).toHaveBeenCalledTimes(2)
  })

  test.each(['unparseable', 'unreadable'] as const)(
    'an existing %s project file replaces legacy reports without consulting legacy',
    async (reason) => {
      await put(file, '{ "wait": 2 }')
      await put(legacyFile, '{ "wait": 7, "unknown": true }')
      const reader = mock(JSON.parse)
      const legacyProject = mock(() => ({ path: legacyFile, read: reader }))
      const handle = openSettings(definition, {
        file,
        log: logger(),
        separateInstall: false,
        legacyProject,
      })
      expect(await handle.get('wait', { ...host, project })).toBe(7)
      expect(handle.report()).toEqual([
        entry('legacy-project', legacyFile, ['unknown'], 'unknown-key'),
      ])
      await put(projectFile, reason === 'unparseable' ? 'garbage' : '{}')
      if (reason === 'unreadable') {
        setSettingsFsForTest({
          readFile: (async (...args: Parameters<typeof readFile>) => {
            if (String(args[0]) === projectFile)
              throw Object.assign(new Error('denied'), { code: 'EACCES' })
            return readFile(...args)
          }) as typeof readFile,
        })
      }
      legacyProject.mockClear()
      await handle.read({ project })
      expect(handle.report()).toEqual([
        entry('project', projectFile, [], reason),
      ])
      expect(await handle.get('wait', { ...host, project })).toBe(2)
      expect(legacyProject).not.toHaveBeenCalled()
      expect(reader).toHaveBeenCalledTimes(1)
    },
  )

  test('a throwing legacy reader is cached and reported unreadable, then recovers after a file change', async () => {
    await put(legacyFile, 'bad old format')
    const reader = mock((text: string) => JSON.parse(text))
    const log = logger()
    const handle = openSettings(definition, {
      file,
      log,
      separateInstall: false,
      legacyProject: () => ({ path: legacyFile, read: reader }),
    })
    expect(await handle.get('wait', { ...host, project })).toBe(10)
    await handle.read({ project })
    expect(reader).toHaveBeenCalledTimes(1)
    expect(handle.report()).toEqual([
      entry('legacy-project', legacyFile, [], 'unreadable'),
    ])
    expect(log.warn).toHaveBeenCalledTimes(1)
    await put(legacyFile, '{ "wait": 6 }')
    expect(await handle.get('wait', { ...host, project })).toBe(6)
    expect(handle.report()).toEqual([])
  })

  test.each([
    { reason: 'unknown-key', text: '{ "unknown": 1 }', keyPath: ['unknown'] },
    {
      reason: 'override-not-allowed',
      text: '{ "private_value": { "default": 2 } }',
      keyPath: ['private_value'],
    },
    {
      reason: 'user-only-in-project',
      text: '{ "private_value": 2 }',
      keyPath: ['private_value'],
    },
    {
      reason: 'invalid-value',
      text: '{ "wait": { "default": 4, "pi": "bad" } }',
      keyPath: ['wait', 'pi'],
    },
    {
      reason: 'invalid-schema-version',
      text: '{ "schema_version": 0 }',
      keyPath: ['schema_version'],
    },
    {
      reason: 'newer-version-key-ignored',
      text: '{ "schema_version": 2, "unknown": 1 }',
      keyPath: ['unknown'],
    },
    {
      reason: 'duplicate-key',
      text: '{ "wait": 2, "wait": 3 }',
      keyPath: ['wait'],
    },
    { reason: 'unparseable', text: 'garbage', keyPath: [] },
    { reason: 'unreadable', text: '{}', keyPath: [] },
  ] as const)(
    '$reason produces one report entry per handle and one warn per process',
    async ({ reason, text, keyPath }) => {
      const kind = reason === 'user-only-in-project' ? 'project' : 'user'
      const path = kind === 'project' ? projectFile : file
      await put(path, text)
      if (reason === 'unreadable') {
        setSettingsFsForTest({
          readFile: (async (...args: Parameters<typeof readFile>) => {
            if (String(args[0]) === path)
              throw Object.assign(new Error('denied'), { code: 'EACCES' })
            return readFile(...args)
          }) as typeof readFile,
        })
      }
      const logs = [logger(), logger()] as const
      const handles = logs.map((log) =>
        openSettings(definition, {
          file,
          log,
          separateInstall: false,
        }),
      )
      const options = { ...host, ...(kind === 'project' ? { project } : {}) }
      const expectedValue =
        reason === 'invalid-value' ? 4 : reason === 'duplicate-key' ? 3 : 10
      for (const handle of handles) {
        expect(await handle.get('wait', options)).toBe(expectedValue)
        await handle.read(options)
        expect(handle.report()).toEqual([
          entry(kind, path, [...keyPath], reason),
        ])
      }
      const warnings = logs.flatMap((log) => log.warn.mock.calls)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.[0]).toContain(reason)
      expect(warnings[0]?.[1]).toEqual(entry(kind, path, [...keyPath], reason))
      const reported = Reflect.get(
        globalThis,
        Symbol.for('cortexkit.common-auth.settings.reported.v1'),
      )
      expect(reported).toBeInstanceOf(Set)
      expect(reported.has(JSON.stringify([path, keyPath, reason]))).toBe(true)
    },
  )

  test('warning identities include file path, key path and reason, but not file kind', async () => {
    await put(file, '{ "first": 1, "second": 2 }')
    await put(projectFile, '{ "first": 1 }')
    const log = logger()
    const handle = openSettings(definition, {
      file,
      log,
      separateInstall: false,
    })
    await handle.read({ project })
    expect(log.warn).toHaveBeenCalledTimes(3)
    await put(file, '{ "schema_version": 2, "first": 1 }')
    await handle.read()
    expect(log.warn).toHaveBeenCalledTimes(4)
    const other = openSettings(definition, {
      file: projectFile,
      log,
      separateInstall: false,
    })
    await other.read()
    expect(other.report()).toEqual([
      entry('user', projectFile, ['first'], 'unknown-key'),
    ])
    expect(log.warn).toHaveBeenCalledTimes(4)
  })

  test('get does not await logging', async () => {
    await put(file, '{ "unknown": true }')
    const never = new Promise<void>(() => {})
    const warn = mock(() => never)
    const handle = openSettings(definition, {
      file,
      log: { warn, info() {} },
      separateInstall: false,
    })
    expect(await handle.get('wait', host)).toBe(10)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(handle.report()).toEqual([
      entry('user', file, ['unknown'], 'unknown-key'),
    ])
  })

  test('the internal warning reset lets a retained entry be logged again', async () => {
    await put(file, '{ "unknown": true }')
    const log = logger()
    const handle = openSettings(definition, {
      file,
      log,
      separateInstall: false,
    })
    await handle.read()
    expect(log.warn).toHaveBeenCalledTimes(1)
    resetSettingsReportedForTest()
    await handle.read()
    expect(log.warn).toHaveBeenCalledTimes(2)
    expect(handle.report()).toEqual([
      entry('user', file, ['unknown'], 'unknown-key'),
    ])
  })

  test('legacy failures retain the last good snapshot, but deletion discards it', async () => {
    const reader = mock(JSON.parse)
    const handle = openSettings(definition, {
      file,
      log: logger(),
      separateInstall: false,
      legacyProject: () => ({ path: legacyFile, read: reader }),
    })
    expect(await handle.get('wait', { ...host, project })).toBe(10)
    expect(reader).not.toHaveBeenCalled()
    expect(handle.report()).toEqual([])
    await put(legacyFile, '{ "wait": 7, "unknown": true }')
    expect(await handle.get('wait', { ...host, project })).toBe(7)
    await put(legacyFile, 'garbage')
    expect(await handle.get('wait', { ...host, project })).toBe(7)
    expect(handle.report()).toEqual([
      entry('legacy-project', legacyFile, [], 'unreadable'),
      entry('legacy-project', legacyFile, ['unknown'], 'unknown-key'),
    ])
    await unlink(legacyFile)
    expect(await handle.get('wait', { ...host, project })).toBe(10)
    expect(handle.report()).toEqual([])
    await put(legacyFile, '[]')
    expect(await handle.get('wait', { ...host, project })).toBe(10)
    expect(handle.report()).toEqual([
      entry('legacy-project', legacyFile, [], 'unparseable'),
    ])
  })

  test('a stale legacy read cannot replace a newer project selection or its reports', async () => {
    await put(legacyFile, '{ "wait": 7, "unknown": true }')
    const captured = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let pause = true
    setSettingsFsForTest({
      readFile: (async (...args: Parameters<typeof readFile>) => {
        const text = await readFile(...args)
        if (String(args[0]) === legacyFile && pause) {
          pause = false
          captured.resolve()
          await release.promise
        }
        return text
      }) as typeof readFile,
    })
    const handle = openSettings(definition, {
      file,
      log: logger(),
      separateInstall: false,
      legacyProject: () => ({ path: legacyFile, read: JSON.parse }),
    })
    const oldRead = handle.get('wait', { ...host, project })
    await captured.promise
    try {
      await put(projectFile, '{ "wait": 3 }')
      expect(await handle.get('wait', { ...host, project })).toBe(3)
    } finally {
      release.resolve()
    }
    expect(await oldRead).toBe(3)
    expect(handle.report()).toEqual([])
  })

  test('a separate install makes no filesystem calls or legacy callbacks and returns defaults', async () => {
    await put(file, '{ "wait": 2, "unknown": true }')
    await put(projectFile, '{ "wait": 3 }')
    await put(legacyFile, '{ "wait": 4 }')
    const calls: string[] = []
    setSettingsFsForTest(
      Object.fromEntries(
        Object.keys(SettingsFs).map((name) => [
          name,
          () => {
            calls.push(name)
            throw new Error(`Unexpected settings filesystem call: ${name}`)
          },
        ]),
      ) as unknown as typeof SettingsFs,
    )
    const legacyProject = mock(() => ({ path: legacyFile, read: JSON.parse }))
    const log = logger()
    const handle = openSettings(definition, {
      file,
      log,
      separateInstall: true,
      legacyProject,
    })
    await handle.read({ project })
    expect(await handle.get('wait', { ...host, project })).toBe(10)
    expect(await handle.get('private_value', { ...host, project })).toBe(20)
    expect(handle.report()).toEqual([])
    expect(calls).toEqual([])
    expect(log.warn).not.toHaveBeenCalled()
    expect(legacyProject).not.toHaveBeenCalled()
  })
})
