import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parse } from 'jsonc-parser'
import { lockPathFor } from '../../src/fs/with-lock.js'
import { defineSettings } from '../../src/settings/define.js'
import { boolean, integer, object } from '../../src/settings/descriptors.js'
import { setSettingsFsForTest } from '../../src/settings/fs.js'
import {
  type MoveOptions,
  type MoveOutcome,
  moveSettingsOnce,
  setSettingsMoveStepHookForTest,
} from '../../src/settings/move.js'
import { LockStack } from '../../src/store/refresh-lock.js'

let root: string
let target: string
let warnings: unknown[][]
let infos: unknown[][]
let restoreSpies: (() => void)[]

const definition = defineSettings({
  plugin: 'example',
  settings: {
    enabled: { value: boolean(), default: true, hosts: 'both' },
    count: {
      value: integer(),
      default: 1,
      hosts: 'both',
      overrides: { host: true },
    },
    plain: { value: integer(), default: 0, hosts: 'both' },
    panel: {
      hosts: 'both',
      value: object({ width: integer(), height: integer() }),
      default: { width: 1, height: 2 },
    },
  },
})

function fault(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`injected ${code}`), { code })
}

async function exists(path: string): Promise<boolean> {
  return fs.access(path).then(
    () => true,
    () => false,
  )
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'settings-move-'))
  target = join(root, 'settings.jsonc')
  warnings = []
  infos = []
  restoreSpies = []
})

afterEach(async () => {
  setSettingsFsForTest()
  setSettingsMoveStepHookForTest()
  for (const restore of restoreSpies) restore()
  await fs.rm(root, { recursive: true, force: true })
})

function options(overrides: Partial<MoveOptions> = {}): MoveOptions {
  return {
    definition,
    target,
    separateInstall: false,
    sources: [],
    map: () => ({ entries: [], unmapped: [] }),
    fence: () => true,
    log: {
      warn: (...args: unknown[]) => warnings.push(args),
      info: (...args: unknown[]) => infos.push(args),
    },
    ...overrides,
  }
}

function result(outcome: MoveOutcome) {
  return {
    outcome,
    unmapped: [],
    differing: [],
    noteFailures: [],
    postPublishFailures: [],
  }
}

async function source(host = 'opencode', name = 'legacy.json') {
  const path = join(root, name)
  await fs.writeFile(path, '// untouched source\n{"count": 4}\n')
  return {
    host,
    path,
    locks: [{ path, name: 'save', timeoutMs: 100 }],
    read: parse,
  }
}

async function contents(): Promise<Record<string, unknown>> {
  return parse(await fs.readFile(target, 'utf8')) as Record<string, unknown>
}

describe('settings move', () => {
  test('separate install performs no filesystem calls and creates nothing', async () => {
    const calls: string[] = []
    const fail = async () => {
      calls.push('filesystem')
      throw new Error('unexpected filesystem access')
    }
    setSettingsFsForTest({
      lstat: fail,
      stat: fail,
      readFile: fail,
      mkdir: fail,
      open: fail,
      readdir: fail,
      link: fail,
      unlink: fail,
      realpath: fail,
      rename: fail,
    })
    expect(
      await moveSettingsOnce(
        options({ separateInstall: true, target: join(root, 'absent', 's') }),
      ),
    ).toEqual(result('separate-install'))
    expect(calls).toEqual([])
    expect(await fs.readdir(root)).toEqual([])
  })

  test.each(['file', 'dangling-link'])(
    'existing %s target is done-already',
    async (kind) => {
      if (kind === 'file') await fs.writeFile(target, 'keep exactly\n')
      else await fs.symlink(join(root, 'missing'), target)
      expect(await moveSettingsOnce(options())).toEqual(result('done-already'))
      if (kind === 'file')
        expect(await fs.readFile(target, 'utf8')).toBe('keep exactly\n')
      else expect((await fs.lstat(target)).isSymbolicLink()).toBe(true)
      expect(await fs.readdir(root)).toEqual(['settings.jsonc'])
    },
  )

  test('target lstat permission errors fail with the cause and no target', async () => {
    const cause = fault('EACCES')
    setSettingsFsForTest({
      lstat: async () => {
        throw cause
      },
    })
    expect(await moveSettingsOnce(options())).toEqual({
      ...result('failed'),
      cause,
    })
    expect(await fs.readdir(root)).toEqual([])
  })

  test('a closed fence creates no target folder', async () => {
    expect(
      await moveSettingsOnce(
        options({
          target: join(root, 'absent', 's'),
          fence: () => false,
        }),
      ),
    ).toEqual(result('fence-closed'))
    expect(await fs.readdir(root)).toEqual([])
  })

  test('rechecks a fence that closes while taking source locks', async () => {
    const legacy = await source()
    let open = true
    const acquire = LockStack.prototype.acquire
    const spy = spyOn(LockStack.prototype, 'acquire').mockImplementation(
      async function (this: LockStack, spec) {
        const held = await acquire.call(this, spec)
        open = false
        return held
      },
    )
    restoreSpies.push(() => spy.mockRestore())
    expect(
      await moveSettingsOnce(options({ sources: [legacy], fence: () => open })),
    ).toEqual(result('fence-closed'))
    expect(await exists(target)).toBe(false)
    expect(await exists(lockPathFor(legacy.path, 'save'))).toBe(false)
    expect(await exists(`${legacy.path}.MOVED_READPLEASE`)).toBe(false)
  })

  test('rechecks a target that appears while taking source locks', async () => {
    const legacy = await source()
    const acquire = LockStack.prototype.acquire
    const spy = spyOn(LockStack.prototype, 'acquire').mockImplementation(
      async function (this: LockStack, spec) {
        const held = await acquire.call(this, spec)
        await fs.writeFile(target, 'appeared during lock acquisition')
        return held
      },
    )
    restoreSpies.push(() => spy.mockRestore())
    expect(await moveSettingsOnce(options({ sources: [legacy] }))).toEqual(
      result('done-already'),
    )
    expect(await fs.readFile(target, 'utf8')).toBe(
      'appeared during lock acquisition',
    )
    expect(await exists(lockPathFor(legacy.path, 'save'))).toBe(false)
  })

  test('creates only the target folder and skips absent Pi lock folders and readers', async () => {
    const missing = join(root, 'pi-not-installed', 'legacy.json')
    target = join(root, 'new', 'nested', 'settings.jsonc')
    let readerCalls = 0
    const mkdirs: { path: string; options: unknown }[] = []
    setSettingsFsForTest({
      mkdir: (async (path, opts) => {
        mkdirs.push({ path: String(path), options: opts })
        return fs.mkdir(path, opts)
      }) as typeof fs.mkdir,
    })
    const sources = [
      {
        host: 'pi',
        path: missing,
        locks: [{ path: missing, name: 'save' }],
        read: () => {
          readerCalls++
          return {}
        },
      },
    ]
    expect(
      await moveSettingsOnce(
        options({
          sources,
          map: (legacy) => {
            expect(legacy).toEqual([
              { host: 'pi', path: missing, present: false },
            ])
            return { entries: [], unmapped: [] }
          },
        }),
      ),
    ).toEqual(result('moved'))
    expect(readerCalls).toBe(0)
    expect(await contents()).toEqual({ schema_version: 1 })
    expect(mkdirs).toEqual(
      process.platform === 'win32'
        ? []
        : [
            {
              path: dirname(target),
              options: { recursive: true, mode: 0o700 },
            },
          ],
    )
    expect(await exists(dirname(missing))).toBe(false)
    if (process.platform !== 'win32') {
      for (const folder of [dirname(target), dirname(dirname(target))]) {
        expect((await fs.stat(folder)).mode & 0o777).toBe(
          0o700 & ~process.umask(),
        )
      }
    }
  })

  test('takes source locks in order after the move lock and deduplicates resolved path and name', async () => {
    const first = await source()
    const second = await source('pi', 'pi.json')
    const extra = { path: first.path, name: 'state', timeoutMs: 100 }
    first.locks.push(extra)
    second.locks.push({
      path: `${root}/./${basename(first.path)}`,
      name: 'save',
      timeoutMs: 5,
    })
    const acquired: string[] = []
    const acquire = LockStack.prototype.acquire
    const spy = spyOn(LockStack.prototype, 'acquire').mockImplementation(
      async function (this: LockStack, spec) {
        expect(await exists(lockPathFor(target, 'settings-move'))).toBe(true)
        acquired.push(`${resolve(spec.path)}:${spec.name}`)
        return acquire.call(this, spec)
      },
    )
    restoreSpies.push(() => spy.mockRestore())
    expect(
      await moveSettingsOnce(options({ sources: [first, second] })),
    ).toEqual(result('moved'))
    expect(acquired).toEqual([
      `${first.path}:save`,
      `${first.path}:state`,
      `${second.path}:save`,
    ])
    for (const spec of [...first.locks, ...second.locks]) {
      expect(await exists(lockPathFor(resolve(spec.path), spec.name))).toBe(
        false,
      )
    }
    expect(await exists(lockPathFor(target, 'settings-move'))).toBe(false)
  })

  test('reads present sources once through plain readFile and maps their reader values under the locks', async () => {
    const legacy = await source()
    const sourceText = await fs.readFile(legacy.path, 'utf8')
    const reads: string[] = []
    let readerCalls = 0
    setSettingsFsForTest({
      readFile: (async (
        path: Parameters<typeof fs.readFile>[0],
        encoding: Parameters<typeof fs.readFile>[1],
      ) => {
        reads.push(String(path))
        expect(encoding).toBe('utf8')
        return fs.readFile(path, encoding)
      }) as typeof fs.readFile,
    })
    expect(
      await moveSettingsOnce(
        options({
          sources: [
            {
              ...legacy,
              read: (text) => {
                readerCalls++
                expect(text).toBe(sourceText)
                return { transformed: 7 }
              },
            },
          ],
          map: async (sources) => {
            expect(await exists(lockPathFor(target, 'settings-move'))).toBe(
              true,
            )
            expect(await exists(lockPathFor(legacy.path, 'save'))).toBe(true)
            expect(sources).toEqual([
              {
                host: legacy.host,
                path: legacy.path,
                present: true,
                value: { transformed: 7 },
              },
            ])
            return {
              entries: [{ source: 0, setting: 'count', value: 7 }],
              unmapped: [],
            }
          },
        }),
      ),
    ).toEqual(result('moved'))
    expect(reads).toEqual([legacy.path])
    expect(readerCalls).toBe(1)
    expect(await contents()).toEqual({ schema_version: 1, count: 7 })
    expect(await fs.readFile(legacy.path, 'utf8')).toBe(sourceText)
  })

  test('removes only stale move UUID temps under the locks before reading', async () => {
    const legacy = await source()
    const stale = `${target}.move-00000000-0000-4000-8000-000000000001.tmp`
    const unrelated = `${target}.move-not-a-uuid.tmp`
    const writerTemp = `${target}.00000000-0000-4000-8000-000000000001.tmp`
    for (const path of [stale, unrelated, writerTemp])
      await fs.writeFile(path, 'old')
    const unlinked: string[] = []
    setSettingsFsForTest({
      unlink: async (path) => {
        if (String(path) === stale) {
          expect(await exists(lockPathFor(target, 'settings-move'))).toBe(true)
          expect(await exists(lockPathFor(legacy.path, 'save'))).toBe(true)
        }
        unlinked.push(String(path))
        await fs.unlink(path)
      },
    })
    expect(
      await moveSettingsOnce(
        options({
          sources: [
            {
              ...legacy,
              read: (text) => {
                expect(unlinked).toEqual([stale])
                return parse(text)
              },
            },
          ],
        }),
      ),
    ).toEqual(result('moved'))
    expect(await exists(stale)).toBe(false)
    expect(await fs.readFile(unrelated, 'utf8')).toBe('old')
    expect(await fs.readFile(writerTemp, 'utf8')).toBe('old')
  })

  test('reports plugin unmapped entries alongside undeclared and descriptor-invalid values', async () => {
    const legacy = await source()
    const unmapped = [{ source: 0, key: 'old_key', reason: 'plugin-reason' }]
    const moved = await moveSettingsOnce(
      options({
        sources: [legacy],
        map: () => ({
          unmapped,
          entries: [
            { source: 0, setting: 'typo', value: 3 },
            { source: 0, setting: 'constructor', value: 3 },
            { source: 0, setting: 'count', value: 1.5 },
            { source: 0, setting: 'count', value: { pi: 2 } },
            { source: 0, setting: 'panel', value: { width: 3, unknown: true } },
            { source: 0, setting: 'panel', value: { width: 3 } },
            { source: 0, setting: 'enabled', value: false },
          ],
        }),
      }),
    )
    expect(moved).toEqual({
      ...result('moved'),
      unmapped: [
        ...unmapped,
        { source: 0, key: 'typo', reason: 'unknown-setting' },
        { source: 0, key: 'constructor', reason: 'unknown-setting' },
        { source: 0, key: 'count', reason: 'invalid-value' },
        { source: 0, key: 'count', reason: 'invalid-value' },
        { source: 0, key: 'panel', reason: 'invalid-value' },
      ],
    })
    expect(await contents()).toEqual({
      schema_version: 1,
      enabled: false,
      panel: { width: 3 },
    })
  })

  test('deep-equal values give one plain value despite different object key order', async () => {
    const sources = [await source(), await source('pi', 'pi.json')]
    expect(
      await moveSettingsOnce(
        options({
          sources,
          map: () => ({
            unmapped: [],
            entries: [
              { source: 1, setting: 'panel', value: { height: 2, width: 1 } },
              { source: 0, setting: 'panel', value: { width: 1, height: 2 } },
              { source: 0, setting: 'count', value: 4 },
              { source: 1, setting: 'count', value: 4 },
            ],
          }),
        }),
      ),
    ).toEqual(result('moved'))
    expect(await contents()).toEqual({
      schema_version: 1,
      count: 4,
      panel: { width: 1, height: 2 },
    })
    expect(infos).toEqual([])
  })

  test('retains differing first host values without a loss report', async () => {
    const sources = [await source(), await source('pi', 'pi.json')]
    expect(
      await moveSettingsOnce(
        options({
          sources,
          map: () => ({
            unmapped: [],
            entries: [
              { source: 1, setting: 'count', value: 2 },
              { source: 0, setting: 'count', value: 1 },
            ],
          }),
        }),
      ),
    ).toEqual(result('moved'))
    expect(await contents()).toEqual({
      schema_version: 1,
      count: { default: 1, pi: 2 },
    })
    expect(infos).toEqual([])
  })

  test.each(['no-host-overrides', 'unknown-host'])(
    'keeps the primary and reports differing values once: %s',
    async (kind) => {
      const secondaryHost = kind === 'no-host-overrides' ? 'pi' : 'other'
      const sources = [
        await source(),
        await source(secondaryHost, 'other.json'),
      ]
      const setting = kind === 'no-host-overrides' ? 'plain' : 'count'
      const values = [
        { source: 0, host: 'opencode', value: 1 },
        { source: 1, host: secondaryHost, value: 2 },
      ]
      const moved = await moveSettingsOnce(
        options({
          sources,
          map: () => ({
            unmapped: [],
            entries: [
              { source: 1, setting, value: 2 },
              { source: 0, setting, value: 1 },
            ],
          }),
        }),
      )
      expect(moved).toEqual({
        ...result('moved'),
        differing: [{ setting, values }],
      })
      expect(await contents()).toEqual({ schema_version: 1, [setting]: 1 })
      expect(infos).toHaveLength(1)
      expect(infos[0]?.[0]).toContain(setting)
      expect(infos[0]?.[1]).toEqual({ values })
    },
  )

  test('same-host conflicts keep the first host entry and record all values in source order', async () => {
    const sources = [
      await source(),
      await source('opencode', 'second.json'),
      await source('pi', 'pi.json'),
    ]
    const values = [
      { source: 0, host: 'opencode', value: 1 },
      { source: 1, host: 'opencode', value: 3 },
      { source: 2, host: 'pi', value: 2 },
    ]
    expect(
      await moveSettingsOnce(
        options({
          sources,
          map: () => ({
            unmapped: [],
            entries: values.toReversed().map(({ source, value }) => ({
              source,
              setting: 'count',
              value,
            })),
          }),
        }),
      ),
    ).toEqual({
      ...result('moved'),
      differing: [{ setting: 'count', values }],
    })
    expect(await contents()).toEqual({
      schema_version: 1,
      count: { default: 1, pi: 2 },
    })
    expect(infos).toHaveLength(1)
  })

  test('renders a dated path header and declaration order independently of map source order', async () => {
    const sources = [await source(), await source('pi', 'pi.json')]
    const entries = [
      { source: 0, setting: 'plain', value: 8 },
      { source: 0, setting: 'count', value: 1 },
      { source: 0, setting: 'enabled', value: false },
      { source: 1, setting: 'plain', value: 9 },
      { source: 1, setting: 'count', value: 2 },
      { source: 1, setting: 'enabled', value: false },
    ]
    const start = new Date().toISOString().slice(0, 10)
    expect(
      (
        await moveSettingsOnce(
          options({ sources, map: () => ({ entries, unmapped: [] }) }),
        )
      ).outcome,
    ).toBe('moved')
    const forward = await fs.readFile(target, 'utf8')
    const end = new Date().toISOString().slice(0, 10)
    expect(forward).toMatch(
      /^\/\/ Settings moved on \d{4}-\d{2}-\d{2} \(UTC\) from:/,
    )
    expect([start, end]).toContain(
      forward.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '',
    )
    for (const source of sources) expect(forward).toContain(source.path)
    expect(Object.keys(await contents())).toEqual([
      'schema_version',
      'enabled',
      'count',
      'plain',
    ])
    const secondTarget = join(root, 'second.jsonc')
    expect(
      (
        await moveSettingsOnce(
          options({
            target: secondTarget,
            sources,
            map: () => ({ entries: entries.toReversed(), unmapped: [] }),
          }),
        )
      ).outcome,
    ).toBe('moved')
    const reverse = await fs.readFile(secondTarget, 'utf8')
    expect(reverse.slice(reverse.indexOf('{'))).toBe(
      forward.slice(forward.indexOf('{')),
    )
  })

  test('stages exclusively at 0644, syncs before asserting source ownership and linking, then writes notes', async () => {
    const legacy = await source()
    const original = await fs.readFile(legacy.path)
    const events: string[] = []
    const stages: string[] = []
    const assertAll = LockStack.prototype.assertAll
    const spy = spyOn(LockStack.prototype, 'assertAll').mockImplementation(
      async function (this: LockStack) {
        events.push('assertAll')
        return assertAll.call(this)
      },
    )
    restoreSpies.push(() => spy.mockRestore())
    setSettingsFsForTest({
      open: async (path, flags, mode) => {
        const file = await fs.open(path, flags, mode)
        if (String(path).endsWith('.MOVED_READPLEASE')) {
          events.push('note')
          expect(flags).toBe('wx')
          expect(await exists(target)).toBe(true)
          return file
        }
        if (String(path) === dirname(target)) return file
        stages.push(String(path))
        expect(flags).toBe('wx')
        expect(mode).toBe(0o644)
        events.push('stage')
        return {
          writeFile: file.writeFile.bind(file),
          sync: async () => {
            events.push('sync')
            await file.sync()
          },
          close: async () => {
            events.push('close')
            await file.close()
          },
        } as Awaited<ReturnType<typeof fs.open>>
      },
      link: async (from, to) => {
        events.push('link')
        expect(await exists(lockPathFor(target, 'settings-move'))).toBe(true)
        expect(await exists(lockPathFor(legacy.path, 'save'))).toBe(true)
        await fs.link(from, to)
      },
    })
    expect(await moveSettingsOnce(options({ sources: [legacy] }))).toEqual(
      result('moved'),
    )
    expect(stages).toHaveLength(1)
    expect(stages[0]).toMatch(
      /\.move-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/,
    )
    expect(events).toEqual([
      'assertAll',
      'stage',
      'sync',
      'close',
      'assertAll',
      'link',
      'note',
    ])
    expect(await fs.readFile(legacy.path)).toEqual(original)
    expect(
      await fs.readFile(`${legacy.path}.MOVED_READPLEASE`, 'utf8'),
    ).toContain(target)
    expect(
      await fs.readFile(`${legacy.path}.MOVED_READPLEASE`, 'utf8'),
    ).toMatch(/rollback.*loses changes/i)
    expect(
      (await fs.readdir(root)).filter((path) => path.endsWith('.tmp')),
    ).toEqual([])
    if (process.platform !== 'win32')
      expect((await fs.stat(target)).mode & 0o777).toBe(
        0o644 & ~process.umask(),
      )
  })

  test('lost move ownership before publication leaves no target or notes', async () => {
    const legacy = await source()
    setSettingsMoveStepHookForTest(async (step) => {
      if (step === 'staged')
        await fs.rm(lockPathFor(target, 'settings-move'), {
          recursive: true,
          force: true,
        })
    })
    expect(
      await moveSettingsOnce(options({ sources: [legacy] })),
    ).toMatchObject({
      outcome: 'failed',
      cause: { name: 'LockOwnershipError' },
    })
    expect(await exists(target)).toBe(false)
    expect(await fs.readdir(root)).toEqual([basename(legacy.path)])
  })

  test('link EEXIST keeps the new target byte-identical and writes no notes', async () => {
    const legacy = await source()
    setSettingsFsForTest({
      link: async (from, to) => {
        await fs.writeFile(to, 'new target wins\n')
        await fs.link(from, to)
      },
    })
    expect(await moveSettingsOnce(options({ sources: [legacy] }))).toEqual(
      result('aborted-target-appeared'),
    )
    expect(await fs.readFile(target, 'utf8')).toBe('new target wins\n')
    expect(await exists(`${legacy.path}.MOVED_READPLEASE`)).toBe(false)
    expect(
      (await fs.readdir(root)).filter((path) => path.endsWith('.tmp')),
    ).toEqual([])
  })

  test('keeps an existing note and never opens the source for writing', async () => {
    const legacy = await source()
    const original = await fs.readFile(legacy.path)
    const note = `${legacy.path}.MOVED_READPLEASE`
    await fs.writeFile(note, 'old note, keep exactly\n')
    setSettingsFsForTest({
      open: async (path, flags, mode) => {
        expect(String(path)).not.toBe(legacy.path)
        return fs.open(path, flags, mode)
      },
    })
    expect(await moveSettingsOnce(options({ sources: [legacy] }))).toEqual(
      result('moved'),
    )
    expect(await fs.readFile(note, 'utf8')).toBe('old note, keep exactly\n')
    expect(await fs.readFile(legacy.path)).toEqual(original)
    expect(warnings).toEqual([])
  })

  test('note failure is warned and listed without failing the committed move or later notes', async () => {
    const sources = [await source(), await source('pi', 'pi.json')]
    const note = `${sources[0]!.path}.MOVED_READPLEASE`
    const cause = fault('EACCES')
    setSettingsFsForTest({
      open: async (path, flags, mode) => {
        if (String(path) === note) throw cause
        return fs.open(path, flags, mode)
      },
    })
    expect(await moveSettingsOnce(options({ sources }))).toEqual({
      ...result('moved'),
      noteFailures: [{ path: note, error: cause }],
    })
    expect(await contents()).toEqual({ schema_version: 1 })
    expect(await exists(`${sources[1]!.path}.MOVED_READPLEASE`)).toBe(true)
    expect(warnings).toHaveLength(1)
    for (const source of sources)
      expect(await fs.readFile(source.path, 'utf8')).toBe(
        '// untouched source\n{"count": 4}\n',
      )
  })
})
