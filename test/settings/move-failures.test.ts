import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { parse } from 'jsonc-parser'
import {
  PrivateFileError,
  setPrivateFilesBackendForTest,
} from '../../src/fs/private-files.js'
import * as leases from '../../src/fs/refresh-file-lock.js'
import * as locking from '../../src/fs/with-lock.js'
import { defineSettings } from '../../src/settings/define.js'
import { integer } from '../../src/settings/descriptors.js'
import { setSettingsFsForTest } from '../../src/settings/fs.js'
import {
  type LegacySource,
  type MoveOptions,
  type MoveOutcome,
  type MoveSource,
  moveSettingsOnce,
  setSettingsMoveStepHookForTest,
} from '../../src/settings/move.js'
import { PoolOperationError } from '../../src/store/errors.js'
import {
  acquirePoolLock,
  LockStack,
  POOL_LOCK_DEFAULTS,
} from '../../src/store/refresh-lock.js'

const { lockPathFor, LockContentionError, LockOwnershipError } = locking
const definition = defineSettings({
  plugin: 'example',
  settings: { count: { value: integer(), default: 0, hosts: 'both' } },
})
const sourceText = '// keep the legacy file byte-identical\n{"count": 4}\n'
let root: string
let target: string
let warnings: unknown[][]
let restores: (() => void)[]

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'settings-move-failures-'))
  target = join(root, 'settings.jsonc')
  warnings = []
  restores = []
})

afterEach(async () => {
  setSettingsFsForTest()
  setSettingsMoveStepHookForTest()
  setPrivateFilesBackendForTest()
  for (const restore of restores.reverse()) restore()
  await fs.rm(root, { recursive: true, force: true })
})

function result(outcome: MoveOutcome) {
  return {
    outcome,
    unmapped: [],
    differing: [],
    noteFailures: [],
    postPublishFailures: [],
  }
}

function map(legacy: LegacySource[]) {
  return {
    entries: legacy.flatMap((source, index) =>
      source.present
        ? [{ source: index, setting: 'count', value: source.value }]
        : [],
    ),
    unmapped: [],
  }
}

function options(
  sources: MoveSource[],
  overrides: Partial<MoveOptions> = {},
): MoveOptions {
  return {
    definition,
    target,
    sources,
    separateInstall: false,
    fence: () => true,
    map,
    log: {
      warn: (...args: unknown[]) => warnings.push(args),
      info: () => {},
    },
    ...overrides,
  }
}

async function source(name = 'legacy.json'): Promise<MoveSource> {
  const path = join(root, name)
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, sourceText)
  return {
    path,
    host: 'opencode',
    locks: [{ path, name: 'preferences', timeoutMs: 100 }],
    read: (text) => (parse(text) as { count: number }).count,
  }
}

async function absent(path: string): Promise<void> {
  await expect(fs.lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
}

async function released(sources: MoveSource[]): Promise<void> {
  await absent(lockPathFor(target, 'settings-move'))
  for (const source of sources)
    for (const spec of source.locks)
      await absent(lockPathFor(spec.path, spec.name))
}

async function unpublished(sources: MoveSource[]): Promise<void> {
  await absent(target)
  for (const source of sources) await absent(`${source.path}.MOVED_READPLEASE`)
  expect(
    (await fs.readdir(dirname(target))).filter((name) => name.endsWith('.tmp')),
  ).toEqual([])
  await released(sources)
}

async function moved(sources: MoveSource[]): Promise<void> {
  expect(await moveSettingsOnce(options(sources))).toEqual(result('moved'))
  expect(parse(await fs.readFile(target, 'utf8'))).toEqual({
    schema_version: 1,
    count: 4,
  })
  for (const source of sources) {
    expect(await fs.readFile(source.path, 'utf8')).toBe(sourceText)
    expect(
      await fs.readFile(`${source.path}.MOVED_READPLEASE`, 'utf8'),
    ).toContain(target)
  }
  await released(sources)
}

describe('settings move lock failures', () => {
  const rows = [
    'timeout',
    'safe-parent',
    'sharing-record',
    'sharing-other-path',
    'sharing-other-name',
    'verify-security',
    'ownership',
    'io-error',
  ] as const

  for (const where of ['move', 'source'] as const) {
    for (const wrapped of [false, true]) {
      test.each([...rows])(
        `${where} lock maps %s (${wrapped ? 'wrapped' : 'direct'})`,
        async (row) => {
          const sources = [await source(), await source('second.json')]
          const spec =
            where === 'move'
              ? { path: target, name: 'settings-move' }
              : sources[1]!.locks[0]!
          const record = lockPathFor(spec.path, spec.name)
          const original =
            row === 'timeout'
              ? new LockContentionError({
                  target: spec.path,
                  name: spec.name,
                  timeoutMs: 1,
                })
              : row === 'ownership'
                ? new LockOwnershipError({ target: spec.path, name: spec.name })
                : new PrivateFileError(
                    row === 'sharing-other-path'
                      ? join(root, 'unrelated.lock')
                      : row === 'sharing-other-name'
                        ? lockPathFor(spec.path, 'other')
                        : record,
                    row === 'safe-parent'
                      ? 'safe-parent'
                      : row === 'verify-security'
                        ? 'verify'
                        : 'read',
                    row === 'safe-parent' || row === 'verify-security'
                      ? {
                          code: 'ERR_PRIVATE_FILES_SECURITY',
                          reason: 'wrong-owner',
                        }
                      : {
                          code: 'EIO',
                          reason: 'io-error',
                          win32Code: row === 'io-error' ? 1117 : 32,
                        },
                  )
          const error = wrapped
            ? new PoolOperationError({
                operation: 'updateSettings',
                phase: 'before-first-write',
                retryable: false,
                kind: 'unexpected',
                cause: new Error('wrapper', { cause: original }),
              })
            : original
          if (where === 'move') {
            const spy = spyOn(locking, 'withLock').mockRejectedValue(error)
            restores.push(() => spy.mockRestore())
          } else {
            const acquire = LockStack.prototype.acquire
            const spy = spyOn(
              LockStack.prototype,
              'acquire',
            ).mockImplementation(async function (this: LockStack, lock) {
              if (lock.path === spec.path && lock.name === spec.name)
                throw error
              return acquire.call(this, lock)
            })
            restores.push(() => spy.mockRestore())
          }
          const release = spyOn(LockStack.prototype, 'releaseAll')
          restores.push(() => release.mockRestore())
          const busy =
            row === 'timeout' ||
            (row === 'sharing-record' && process.platform === 'win32')
          const actual = await moveSettingsOnce(options(sources))
          expect(actual).toEqual({
            ...result(busy ? 'busy' : 'failed'),
            cause: error,
          })
          expect(actual.cause).toBe(error)
          expect(release).toHaveBeenCalledTimes(where === 'move' ? 0 : 1)
          await unpublished(sources)
        },
      )
    }
  }

  test('a real source timeout releases earlier locks and retries after the holder releases', async () => {
    const sources = [await source(), await source('second.json')]
    const spec = sources[1]!.locks[0]!
    const holder = await acquirePoolLock(spec, POOL_LOCK_DEFAULTS, {})
    try {
      const actual = await moveSettingsOnce(options(sources))
      expect(actual).toEqual({
        ...result('busy'),
        cause: expect.any(LockContentionError),
      })
      expect(actual.cause).toMatchObject({
        details: { target: spec.path, name: spec.name },
      })
      await absent(lockPathFor(sources[0]!.path, 'preferences'))
      await absent(lockPathFor(target, 'settings-move'))
      await absent(target)
      for (const source of sources)
        await absent(`${source.path}.MOVED_READPLEASE`)
      await holder.assertOwned()
    } finally {
      await holder.release()
    }
    await moved(sources)
  })

  test('an assertion failure after a lock is pushed releases both source locks', async () => {
    const sources = [await source(), await source('second.json')]
    const assertAll = LockStack.prototype.assertAll
    const cause = new LockOwnershipError({
      target: sources[0]!.path,
      name: 'preferences',
    })
    let assertions = 0
    const spy = spyOn(LockStack.prototype, 'assertAll').mockImplementation(
      async function (this: LockStack) {
        if (++assertions === 2) {
          expect(this.held).toHaveLength(2)
          throw cause
        }
        return assertAll.call(this)
      },
    )
    restores.push(() => spy.mockRestore())
    expect(await moveSettingsOnce(options(sources))).toEqual({
      ...result('failed'),
      cause,
    })
    expect(assertions).toBe(2)
    await unpublished(sources)
    spy.mockRestore()
    await moved(sources)
  })

  test('source ownership expiring during map fails before publication and releases every lock', async () => {
    const sources = [await source(), await source('second.json')]
    sources[1]!.locks[0] = {
      ...sources[1]!.locks[0]!,
      ttlMs: 1_000,
      renew: false,
    }
    const actual = await moveSettingsOnce(
      options(sources, {
        map: async (legacy) => {
          await Bun.sleep(1_050)
          return map(legacy)
        },
      }),
    )
    expect(actual).toEqual({
      ...result('failed'),
      cause: expect.any(LockOwnershipError),
    })
    expect(actual.cause).toMatchObject({
      details: { target: sources[1]!.path, name: 'preferences' },
    })
    await unpublished(sources)
    sources[1]!.locks[0] = { ...sources[1]!.locks[0]!, ...POOL_LOCK_DEFAULTS }
    await moved(sources)
  })

  test.skipIf(process.platform !== 'win32').each(['source', 'target'] as const)(
    'Windows safe-parent refusal of the %s folder fails without publishing',
    async (where) => {
      const sources = [await source(), await source('host/second.json')]
      const refused =
        where === 'source' ? dirname(sources[1]!.path) : dirname(target)
      const api = await import('@cortexkit/private-files')
      const checks: string[] = []
      setPrivateFilesBackendForTest({
        ...api,
        verifySafeParent: async (folder, policy) => {
          checks.push(folder)
          if (folder === refused)
            return {
              ok: false,
              reason: api.WRITABLE_BY_OTHERS,
              path: folder,
              level: folder,
            }
          return api.verifySafeParent(folder, policy)
        },
      })
      const actual = await moveSettingsOnce(options(sources))
      expect(actual).toEqual({
        ...result('failed'),
        cause: expect.any(PrivateFileError),
      })
      expect(actual.cause).toMatchObject({
        path: refused,
        stage: 'safe-parent',
        reason: 'writable-by-others',
      })
      expect(checks).toContain(refused)
      await unpublished(sources)
      setPrivateFilesBackendForTest()
      await moved(sources)
    },
  )
})

describe('settings move pre-publication failures', () => {
  test.each([
    'unreadable',
    'reader',
    'map',
    'fence-before-lock',
    'fence-under-lock',
    'absent-map-source',
    'out-of-range-map-source',
    'stage-sync',
    'staged-hook',
    'link',
  ] as const)(
    '%s fails with cause, cleans up and can retry',
    async (failure) => {
      const sources = [await source(), await source('second.json')]
      const cause = Object.assign(new Error(`injected ${failure}`), {
        code: 'EACCES',
      })
      const overrides: Partial<MoveOptions> = {}
      if (failure === 'unreadable') {
        setSettingsFsForTest({
          readFile: (async (
            path: Parameters<typeof fs.readFile>[0],
            opts: Parameters<typeof fs.readFile>[1],
          ) => {
            if (String(path) === sources[1]!.path) throw cause
            return fs.readFile(path, opts)
          }) as typeof fs.readFile,
        })
      } else if (failure === 'reader') {
        sources[1]!.read = () => {
          throw cause
        }
      } else if (failure === 'map') {
        overrides.map = () => {
          throw cause
        }
      } else if (failure.startsWith('fence-')) {
        let calls = 0
        overrides.fence = () => {
          calls++
          if (failure === 'fence-before-lock' || calls === 2) throw cause
          return true
        }
      } else if (failure.endsWith('map-source')) {
        if (failure === 'absent-map-source') await fs.unlink(sources[1]!.path)
        overrides.map = () => ({
          entries: [
            {
              source: failure === 'absent-map-source' ? 1 : 2,
              setting: 'count',
              value: 4,
            },
          ],
          unmapped: [],
        })
      } else if (failure === 'stage-sync') {
        setSettingsFsForTest({
          open: async (path, flags, mode) => {
            const file = await fs.open(path, flags, mode)
            if (String(path).endsWith('.tmp'))
              file.sync = async () => {
                throw cause
              }
            return file
          },
        })
      } else if (failure === 'staged-hook') {
        setSettingsMoveStepHookForTest((step) => {
          if (step === 'staged') throw cause
        })
      } else if (failure === 'link') {
        setSettingsFsForTest({
          link: async () => {
            throw cause
          },
        })
      }
      const release = spyOn(LockStack.prototype, 'releaseAll')
      restores.push(() => release.mockRestore())
      const actual = await moveSettingsOnce(options(sources, overrides))
      expect(actual).toEqual({ ...result('failed'), cause: expect.any(Error) })
      if (failure.endsWith('map-source')) {
        expect(actual.cause).toBeInstanceOf(TypeError)
      } else expect(actual.cause).toBe(cause)
      expect(release).toHaveBeenCalledTimes(
        failure === 'fence-before-lock' ? 0 : 1,
      )
      await unpublished(sources)
      setSettingsFsForTest()
      setSettingsMoveStepHookForTest()
      sources[1]!.read = (text) => (parse(text) as { count: number }).count
      await fs.writeFile(sources[1]!.path, sourceText)
      await moved(sources)
    },
  )

  test.each(['locked', 'map'] as const)(
    'a skipped source lock folder appearing during %s returns busy, then retries with its values',
    async (when) => {
      const first = {
        host: 'opencode',
        path: join(root, 'absent-host', 'legacy.json'),
        locks: [
          {
            path: join(root, 'absent-host', 'legacy.json'),
            name: 'save',
            timeoutMs: 100,
          },
        ],
        read: (text: string) => (parse(text) as { count: number }).count,
      }
      const second = await source('second.json')
      const sources = [first, second]
      let holder: Awaited<ReturnType<typeof acquirePoolLock>> | undefined
      let appeared = false
      const appear = async () => {
        expect(appeared).toBe(false)
        appeared = true
        await fs.mkdir(dirname(first.path))
        holder = await acquirePoolLock(first.locks[0]!, POOL_LOCK_DEFAULTS, {})
        await fs.writeFile(first.path, '{"count": 9}\n')
      }
      const atLocked = Promise.withResolvers<void>()
      const resume = Promise.withResolvers<void>()
      if (when === 'locked')
        setSettingsMoveStepHookForTest(async (step) => {
          if (step !== 'locked') return
          atLocked.resolve()
          await resume.promise
        })
      try {
        const pending = moveSettingsOnce(
          options(sources, {
            map: async (legacy) => {
              if (when === 'map') await appear()
              return map(legacy)
            },
          }),
        )
        if (when === 'locked') {
          await atLocked.promise
          try {
            await appear()
          } finally {
            resume.resolve()
          }
        }
        expect(await pending).toEqual(result('busy'))
        await absent(target)
        for (const source of sources)
          await absent(`${source.path}.MOVED_READPLEASE`)
        await absent(lockPathFor(target, 'settings-move'))
        await absent(lockPathFor(second.path, 'preferences'))
        await holder!.assertOwned()
        expect(
          (await fs.readdir(root)).filter((name) => name.endsWith('.tmp')),
        ).toEqual([])
      } finally {
        resume.resolve()
        await holder?.release()
        setSettingsMoveStepHookForTest()
      }
      await released(sources)
      const retried = await moveSettingsOnce(options(sources))
      expect(retried.outcome).toBe('moved')
      expect(parse(await fs.readFile(target, 'utf8'))).toEqual({
        schema_version: 1,
        count: 9,
      })
      await released(sources)
    },
  )

  test('a target appearing at before-publish wins byte-for-byte without notes', async () => {
    const sources = [await source()]
    const bytes = Buffer.from('// external target\r\n{"count": 99}\r\n')
    const steps: string[] = []
    setSettingsMoveStepHookForTest(async (step, { temp }) => {
      steps.push(step)
      if (step === 'before-publish') {
        expect(parse(await fs.readFile(temp!, 'utf8'))).toEqual({
          schema_version: 1,
          count: 4,
        })
        await fs.writeFile(target, bytes, { flag: 'wx' })
      }
    })
    expect(await moveSettingsOnce(options(sources))).toEqual(
      result('aborted-target-appeared'),
    )
    expect(steps).toEqual(['locked', 'staged', 'before-publish'])
    expect(await fs.readFile(target)).toEqual(bytes)
    await absent(`${sources[0]!.path}.MOVED_READPLEASE`)
    expect(
      (await fs.readdir(root)).filter((name) => name.endsWith('.tmp')),
    ).toEqual([])
    await released(sources)
  })
})

describe('settings move commit point', () => {
  for (const step of ['temp-unlink', 'directory-sync'] as const) {
    test.skipIf(step === 'directory-sync' && process.platform === 'win32')(
      `${step} after the link is reported without losing publication or notes`,
      async () => {
        const sources = [await source(), await source('second.json')]
        const cause = new Error(`injected ${step}`)
        let injected = 0
        let staged: string | undefined
        setSettingsMoveStepHookForTest((step, { temp }) => {
          if (step === 'staged') staged = temp
        })
        setSettingsFsForTest({
          unlink: async (path) => {
            if (step === 'temp-unlink' && String(path) === staged) {
              expect(parse(await fs.readFile(target, 'utf8'))).toEqual({
                schema_version: 1,
                count: 4,
              })
              injected++
              throw cause
            }
            return fs.unlink(path)
          },
          open: async (path, flags, mode) => {
            const file = await fs.open(path, flags, mode)
            if (step === 'directory-sync' && String(path) === dirname(target)) {
              file.sync = async () => {
                expect(parse(await fs.readFile(target, 'utf8'))).toEqual({
                  schema_version: 1,
                  count: 4,
                })
                injected++
                throw cause
              }
            }
            return file
          },
        })
        expect(await moveSettingsOnce(options(sources))).toEqual({
          ...result('moved'),
          postPublishFailures: [{ step, error: cause }],
        })
        expect(injected).toBe(1)
        expect(warnings).toHaveLength(1)
        expect(warnings[0]![1]).toMatchObject({ error: cause })
        expect(parse(await fs.readFile(target, 'utf8'))).toEqual({
          schema_version: 1,
          count: 4,
        })
        for (const source of sources) {
          expect(await fs.readFile(source.path, 'utf8')).toBe(sourceText)
          expect(
            await fs.readFile(`${source.path}.MOVED_READPLEASE`, 'utf8'),
          ).toContain(target)
        }
        if (step === 'temp-unlink') {
          expect(await fs.readFile(staged!)).toEqual(await fs.readFile(target))
        } else await absent(staged!)
        await released(sources)
      },
    )
  }

  test.each(['moved', 'failed', 'fence-closed'] as const)(
    'move-lock release rejection preserves %s',
    async (outcome) => {
      const sources = [await source(), await source('second.json')]
      const releaseError = new Error('injected move lock release rejection')
      const mapError = new Error('injected map failure')
      const acquire = leases.acquireRefreshFileLock
      let releases = 0
      const spy = spyOn(leases, 'acquireRefreshFileLock').mockImplementation(
        async (opts) => {
          const lock = await acquire(opts)
          if (!lock || opts.path !== target || opts.name !== 'settings-move')
            return lock
          return {
            ...lock,
            release: async (signal) => {
              await lock.release(signal)
              releases++
              throw releaseError
            },
          }
        },
      )
      restores.push(() => spy.mockRestore())
      const releaseAll = spyOn(LockStack.prototype, 'releaseAll')
      restores.push(() => releaseAll.mockRestore())
      let fences = 0
      const actual = await moveSettingsOnce(
        options(sources, {
          fence: () => ++fences === 1 || outcome !== 'fence-closed',
          map: (legacy) => {
            if (outcome === 'failed') throw mapError
            return map(legacy)
          },
        }),
      )
      expect(actual).toEqual({
        ...result(outcome),
        ...(outcome === 'failed' ? { cause: mapError } : {}),
        postPublishFailures:
          outcome === 'moved'
            ? [{ step: 'lock-release', error: releaseError }]
            : [],
      })
      expect(releases).toBe(1)
      expect(releaseAll).toHaveBeenCalledTimes(1)
      expect(warnings).toEqual([
        ['Settings move lock release failed', { error: releaseError }],
      ])
      if (outcome === 'moved') {
        expect(parse(await fs.readFile(target, 'utf8'))).toEqual({
          schema_version: 1,
          count: 4,
        })
        for (const source of sources)
          expect(
            await fs.readFile(`${source.path}.MOVED_READPLEASE`, 'utf8'),
          ).toContain(target)
        await released(sources)
      } else await unpublished(sources)
    },
  )

  test('two async callers on the real move lock produce exactly one move', async () => {
    const sources = [await source()]
    const locked = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const contenderEntered = Promise.withResolvers<void>()
    let maps = 0
    let fences = 0
    setSettingsMoveStepHookForTest(async (step) => {
      if (step !== 'locked') return
      locked.resolve()
      await resume.promise
    })
    const opts = options(sources, {
      fence: () => {
        if (++fences === 3) contenderEntered.resolve()
        return true
      },
      map: (legacy) => {
        maps++
        return map(legacy)
      },
    })
    const first = moveSettingsOnce(opts)
    await locked.promise
    const second = moveSettingsOnce(opts)
    try {
      await contenderEntered.promise
      await fs.lstat(lockPathFor(target, 'settings-move'))
    } finally {
      resume.resolve()
    }
    const outcomes = await Promise.all([first, second])
    expect(outcomes).toEqual([result('moved'), result('done-already')])
    expect(maps).toBe(1)
    expect(parse(await fs.readFile(target, 'utf8'))).toEqual({
      schema_version: 1,
      count: 4,
    })
    expect(await fs.readFile(sources[0]!.path, 'utf8')).toBe(sourceText)
    expect(
      await fs.readFile(`${sources[0]!.path}.MOVED_READPLEASE`, 'utf8'),
    ).toContain(target)
    await released(sources)
  })

  test('a child killed after staging leaves no target and the next attempt removes its temp', async () => {
    const sources = [await source()]
    const child = Bun.spawn(
      [
        process.execPath,
        'test/settings/fixtures/move-child.ts',
        target,
        sources[0]!.path,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const stderr = new Response(child.stderr).text()
    let staged = ''
    try {
      const reader = child.stdout.getReader()
      let message = ''
      while (!message.includes('\n')) {
        const chunk = await reader.read()
        if (chunk.done)
          throw new Error(`child exited before staging: ${await stderr}`)
        message += new TextDecoder().decode(chunk.value)
      }
      reader.releaseLock()
      const ready = JSON.parse(message.trim()) as { step: string; temp: string }
      expect(ready.step).toBe('staged')
      staged = ready.temp
      expect(dirname(staged)).toBe(dirname(target))
      expect(basename(staged)).toMatch(
        /^settings\.jsonc\.move-[0-9a-f-]+\.tmp$/,
      )
      expect(parse(await fs.readFile(staged, 'utf8'))).toEqual({
        schema_version: 1,
        count: 4,
      })
      await absent(target)
      await absent(`${sources[0]!.path}.MOVED_READPLEASE`)
    } finally {
      child.kill('SIGKILL')
      await child.exited
    }
    expect(await stderr).toBe('')
    await absent(target)
    const removed: string[] = []
    setSettingsFsForTest({
      unlink: async (path) => {
        if (String(path) === staged) {
          await fs.lstat(lockPathFor(target, 'settings-move'))
          await fs.lstat(lockPathFor(sources[0]!.path, 'preferences'))
          await absent(target)
          removed.push(staged)
        }
        return fs.unlink(path)
      },
    })
    await moved(sources)
    expect(removed).toEqual([staged])
    await absent(staged)
    // The killed process leaves a real 10-second move lease; recovery waits for expiry.
  }, 20_000)
})
