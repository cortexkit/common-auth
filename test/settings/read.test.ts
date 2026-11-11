import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
} from 'bun:test'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { defineSettings } from '../../src/settings/define.js'
import { integer, oneOf } from '../../src/settings/descriptors.js'
import { setSettingsFsForTest } from '../../src/settings/fs.js'
import { openSettings } from '../../src/settings/handle.js'

// Windows reads settings files every time.
const cachedReads = process.platform !== 'win32'

const definition = defineSettings({
  plugin: 'read-test',
  settings: {
    x: { value: integer(), default: 1, hosts: 'both', project: 'allowed' },
    routing_mode: {
      value: oneOf(['a', 'b']),
      default: 'a',
      hosts: 'both',
    },
  },
})
const log = { warn() {}, info() {} }
const getOptions = { host: 'opencode' }
let home: string
let file: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'settings-read-'))
  file = join(home, 'user.jsonc')
})
afterEach(async () => {
  setSettingsFsForTest()
  await rm(home, { recursive: true, force: true })
})

// Replacing the inode makes cache invalidation independent of clock precision.
async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(`${path}.next`, text)
  await rename(`${path}.next`, path)
}

function countedFs() {
  const calls = {
    stat: [] as string[],
    lstat: [] as string[],
    read: [] as string[],
  }
  setSettingsFsForTest({
    stat: (async (...args: Parameters<typeof stat>) => {
      calls.stat.push(String(args[0]))
      return stat(...args)
    }) as typeof stat,
    lstat: (async (...args: Parameters<typeof lstat>) => {
      calls.lstat.push(String(args[0]))
      return lstat(...args)
    }) as typeof lstat,
    readFile: (async (...args: Parameters<typeof readFile>) => {
      calls.read.push(String(args[0]))
      return readFile(...args)
    }) as typeof readFile,
  })
  return {
    calls,
    reset() {
      calls.stat.length = 0
      calls.lstat.length = 0
      calls.read.length = 0
    },
  }
}

function projectFile(project: string): string {
  return join(project, '.cortexkit', 'read-test.jsonc')
}

describe('settings reads', () => {
  test('an unchanged user file costs one seam stat and no read or lstat', async () => {
    await put(file, '{ "x": 2 }')
    const fs = countedFs()
    const handle = openSettings(definition, {
      file,
      log,
      separateInstall: false,
    })
    await handle.read()
    expect(fs.calls).toEqual({
      stat: cachedReads ? [file] : [],
      lstat: [],
      read: [file],
    })
    fs.reset()
    await handle.read()
    expect(fs.calls).toEqual({
      stat: cachedReads ? [file] : [],
      lstat: [],
      read: cachedReads ? [] : [file],
    })
    expect(handle.report()).toEqual([])
  })

  test('an unchanged symlinked user file costs one seam stat and no read', async () => {
    const target = join(home, 'target.jsonc')
    await put(target, '{ "x": 2 }')
    await symlink(target, file)
    const fs = countedFs()
    const handle = openSettings(definition, {
      file,
      log,
      separateInstall: false,
    })
    expect(await handle.get('x', getOptions)).toBe(2)
    fs.reset()
    expect(await handle.get('x', getOptions)).toBe(2)
    expect(fs.calls).toEqual({
      stat: cachedReads ? [file] : [],
      lstat: [],
      read: cachedReads ? [] : [file],
    })
    await put(target, '{ "x": 3 }')
    expect(await handle.get('x', getOptions)).toBe(3)
    expect(handle.report()).toEqual([])
  })

  test('an unchanged unparseable file is cached as an outcome', async () => {
    await put(file, 'garbage')
    const fs = countedFs()
    const handle = openSettings(definition, {
      file,
      log,
      separateInstall: false,
    })
    await handle.read()
    fs.reset()
    expect(await handle.get('x', getOptions)).toBe(1)
    expect(fs.calls).toEqual({
      stat: cachedReads ? [file] : [],
      lstat: [],
      read: cachedReads ? [] : [file],
    })
    expect(handle.report()).toEqual([
      {
        file: { kind: 'user', path: file },
        keyPath: [],
        reason: 'unparseable',
      },
    ])
  })

  test('an unchanged project file costs one seam stat and no read', async () => {
    const project = join(home, 'project')
    const path = projectFile(project)
    await put(file, '{ "x": 2 }')
    await put(path, '{ "x": 3 }')
    const fs = countedFs()
    const handle = openSettings(definition, {
      file,
      log,
      separateInstall: false,
    })
    expect(await handle.get('x', { ...getOptions, project })).toBe(3)
    fs.reset()
    await handle.read({ project })
    expect(fs.calls.stat.toSorted()).toEqual(
      cachedReads ? [file, path].toSorted() : [],
    )
    expect(fs.calls.read.toSorted()).toEqual(
      cachedReads ? [] : [file, path].toSorted(),
    )
    expect(fs.calls.lstat).toEqual([])
  })

  test('65 project paths evict the oldest cache and report state, not the user', async () => {
    await put(file, '{ "x": 2, "user_unknown": true }')
    const fs = countedFs()
    const handle = openSettings(definition, {
      file,
      log,
      separateInstall: false,
    })
    const projects = Array.from({ length: 65 }, (_, index) =>
      join(home, `p${index}`),
    )
    for (const project of projects) {
      await put(projectFile(project), '{ "x": 3, "project_unknown": true }')
    }
    const first = projects[0] as string
    const second = projects[1] as string
    for (const project of projects.slice(0, 64)) await handle.read({ project })
    // A hit must not make the first insertion younger than the second.
    await handle.read({ project: first })
    await handle.read({ project: projects[64] })
    const reportedPaths = handle.report().map((entry) => entry.file.path)
    expect(reportedPaths).toHaveLength(65)
    expect(reportedPaths).not.toContain(projectFile(first))
    expect(reportedPaths).toContain(projectFile(second))
    expect(reportedPaths).toContain(file)
    fs.reset()
    await handle.read({ project: first })
    expect(fs.calls.stat.toSorted()).toEqual(
      cachedReads ? [file, projectFile(first)].toSorted() : [],
    )
    expect(fs.calls.read).toEqual(
      cachedReads ? [projectFile(first)] : [file, projectFile(first)],
    )
    expect(handle.report().map((entry) => entry.file.path)).toContain(
      projectFile(first),
    )
    expect(handle.report().map((entry) => entry.file.path)).not.toContain(
      projectFile(second),
    )
  })

  test('an evicted project loses its last good snapshot as well as its entries', async () => {
    const handle = openSettings(definition, {
      file,
      log,
      separateInstall: false,
    })
    const first = join(home, 'first')
    await put(projectFile(first), '{ "x": 2, "unknown": 1 }')
    expect(await handle.get('x', { ...getOptions, project: first })).toBe(2)
    for (let index = 0; index < 64; index++) {
      await handle.read({ project: join(home, `other-${index}`) })
    }
    await put(projectFile(first), 'garbage')
    expect(await handle.get('x', { ...getOptions, project: first })).toBe(1)
    expect(handle.report()).toEqual([
      {
        file: { kind: 'project', path: projectFile(first) },
        keyPath: [],
        reason: 'unparseable',
      },
    ])
  })

  test('a persistent EACCES stat costs one stat and one read attempt per read', async () => {
    const calls = { stat: 0, read: 0 }
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' })
    setSettingsFsForTest({
      stat: (async () => {
        calls.stat++
        throw denied
      }) as typeof stat,
      lstat: (async () => {
        throw new Error('must follow symlinks')
      }) as typeof lstat,
      readFile: (async () => {
        calls.read++
        throw denied
      }) as typeof readFile,
    })
    const handle = openSettings(definition, {
      file,
      log,
      separateInstall: false,
    })
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await handle.get('x', getOptions)).toBe(1)
      expect(calls).toEqual({ stat: cachedReads ? attempt : 0, read: attempt })
      expect(handle.report()).toEqual([
        {
          file: { kind: 'user', path: file },
          keyPath: [],
          reason: 'unreadable',
        },
      ])
    }
  })

  test.each(['unparseable', 'unreadable'] as const)(
    '%s reads retain the last good snapshot and its entries',
    async (reason) => {
      await put(file, '{ "x": 2, "unknown": true }')
      let denyRead = false
      setSettingsFsForTest({
        readFile: (async (...args: Parameters<typeof readFile>) => {
          if (denyRead)
            throw Object.assign(new Error('denied'), { code: 'EACCES' })
          return readFile(...args)
        }) as typeof readFile,
      })
      const handle = openSettings(definition, {
        file,
        log,
        separateInstall: false,
      })
      expect(await handle.get('x', getOptions)).toBe(2)
      await put(file, reason === 'unparseable' ? 'garbage' : '{ "x": 3 }')
      denyRead = reason === 'unreadable'
      expect(await handle.get('x', getOptions)).toBe(2)
      expect(handle.report()).toEqual([
        { file: { kind: 'user', path: file }, keyPath: [], reason },
        {
          file: { kind: 'user', path: file },
          keyPath: ['unknown'],
          reason: 'unknown-key',
        },
      ])
    },
  )

  test.each(['user', 'project'] as const)(
    'deleting a %s file discards its snapshot before an unparseable recreation',
    async (kind) => {
      const project = kind === 'project' ? join(home, 'project') : undefined
      const path = project === undefined ? file : projectFile(project)
      const handle = openSettings(definition, {
        file,
        log,
        separateInstall: false,
      })
      await put(path, '{ "x": 2, "unknown": true }')
      expect(await handle.get('x', { ...getOptions, project })).toBe(2)
      await unlink(path)
      expect(await handle.get('x', { ...getOptions, project })).toBe(1)
      expect(handle.report()).toEqual([])
      await put(path, 'garbage')
      expect(await handle.get('x', { ...getOptions, project })).toBe(1)
      expect(handle.report()).toEqual([
        { file: { kind, path }, keyPath: [], reason: 'unparseable' },
      ])
    },
  )

  test.each(['user', 'project'] as const)(
    'a stale %s read cannot restore a snapshot or report after a newer deletion',
    async (kind) => {
      const project = kind === 'project' ? join(home, 'project') : undefined
      const path = project === undefined ? file : projectFile(project)
      await put(path, '{ "x": 2, "old_unknown": true }')
      const captured = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let pause = true
      setSettingsFsForTest({
        readFile: (async (...args: Parameters<typeof readFile>) => {
          const text = await readFile(...args)
          if (String(args[0]) === path && pause) {
            pause = false
            captured.resolve()
            await release.promise
          }
          return text
        }) as typeof readFile,
      })
      const handle = openSettings(definition, {
        file,
        log,
        separateInstall: false,
      })
      const oldRead = handle.get('x', { ...getOptions, project })
      try {
        await captured.promise
        await unlink(path)
        await handle.read({ project })
        expect(handle.report()).toEqual([])
      } finally {
        release.resolve()
        await oldRead
      }
      expect(await oldRead).toBe(1)
      expect(handle.report()).toEqual([])
      await put(path, 'garbage')
      expect(await handle.get('x', { ...getOptions, project })).toBe(1)
      expect(handle.report()).toEqual([
        { file: { kind, path }, keyPath: [], reason: 'unparseable' },
      ])
    },
  )

  test('get reads changes without a watcher and preserves inferred value types', async () => {
    await put(file, '{ "x": 2, "routing_mode": "b" }')
    const handle = openSettings(definition, {
      file,
      log,
      separateInstall: false,
    })
    expect(await handle.get('x', getOptions)).toBe(2)
    const mode = handle.get('routing_mode', getOptions)
    expectTypeOf(mode).toEqualTypeOf<Promise<'a' | 'b'>>()
    expect(await mode).toBe('b')
    await put(file, '{ "x": 3 }')
    expect(await handle.get('x', getOptions)).toBe(3)
  })

  test('get observes a same-length in-place rewrite with restored timestamps', async () => {
    await writeFile(file, '{ "x": 2 }')
    // Whole-second timestamps can be restored exactly on every platform.
    await utimes(file, 123, 123)
    const before = await stat(file)
    const handle = openSettings(definition, {
      file,
      log,
      separateInstall: false,
    })
    expect(await handle.get('x', getOptions)).toBe(2)
    await writeFile(file, '{ "x": 3 }')
    await utimes(file, before.atime, before.mtime)
    const after = await stat(file)
    expect([after.dev, after.ino, after.size, after.mtimeMs]).toEqual([
      before.dev,
      before.ino,
      before.size,
      before.mtimeMs,
    ])
    expect(await handle.get('x', getOptions)).toBe(3)
  })

  test('an undeclared name rejects with TypeError and does not add a report entry', async () => {
    await put(file, '{ "x": 2 }')
    const fs = countedFs()
    const handle = openSettings(definition, {
      file,
      log,
      separateInstall: false,
    })
    // @ts-expect-error The handle accepts only declared setting names.
    const result = handle.get('typo', getOptions)
    await expect(result).rejects.toBeInstanceOf(TypeError)
    await expect(result).rejects.toThrow('typo')
    expect(handle.report()).toEqual([])
    expect(fs.calls).toEqual({ stat: [], lstat: [], read: [] })
  })

  test('report is synchronous and holds each project at its last read', async () => {
    await put(file, '{ "user_unknown": true }')
    const first = join(home, 'first')
    const second = join(home, 'second')
    await put(projectFile(first), '{ "first_unknown": true }')
    await put(projectFile(second), '{ "second_unknown": true }')
    const fs = countedFs()
    const handle = openSettings(definition, {
      file,
      log,
      separateInstall: false,
    })
    await handle.read({ project: first })
    await handle.read({ project: second })
    await put(projectFile(first), '{}')
    fs.reset()
    const entries = handle.report()
    expect(Array.isArray(entries)).toBe(true)
    expect(entries).toEqual([
      {
        file: { kind: 'user', path: file },
        keyPath: ['user_unknown'],
        reason: 'unknown-key',
      },
      {
        file: { kind: 'project', path: projectFile(first) },
        keyPath: ['first_unknown'],
        reason: 'unknown-key',
      },
      {
        file: { kind: 'project', path: projectFile(second) },
        keyPath: ['second_unknown'],
        reason: 'unknown-key',
      },
    ])
    expect(fs.calls).toEqual({ stat: [], lstat: [], read: [] })
    entries[0]?.keyPath.push('changed')
    expect(handle.report()[0]?.keyPath).toEqual(['user_unknown'])
    await handle.read({ project: first })
    expect(handle.report().map((entry) => entry.file.path)).toEqual([
      file,
      projectFile(second),
    ])
  })

  test('a separate install reads no files and resolves defaults with an empty report', async () => {
    await put(file, '{ "x": 2, "unknown": true }')
    const fs = countedFs()
    const handle = openSettings(definition, {
      file,
      log,
      separateInstall: true,
    })
    await handle.read({ project: home })
    expect(await handle.get('x', { ...getOptions, project: home })).toBe(1)
    expect(handle.report()).toEqual([])
    expect(fs.calls).toEqual({ stat: [], lstat: [], read: [] })
  })
})
