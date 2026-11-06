import { beforeEach, describe, expect } from 'bun:test'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  acquireRefreshFileLock as acquireRaw,
  setLeaseCreationTestHooksForTest,
} from '../../src/fs/refresh-file-lock.js'
import { withLock } from '../../src/fs/with-lock.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { observed } from '../fixtures/observed.js'
import { makeTempDir } from '../fixtures/scratch.js'

const hooks = lifetimeHooks()
const it = hooks.it.skipIf(process.platform === 'win32')
let dir: string
beforeEach(async () => {
  dir = await makeTempDir('lease-creation-')
})
hooks.afterEach(async () => {
  setLeaseCreationTestHooksForTest()
  await rm(dir, { recursive: true, force: true })
})

const acquire: typeof acquireRaw = (...args) =>
  hooks.lifetime.operation(
    acquireRaw(...args).then((lock) => {
      if (lock) hooks.lifetime.finish(() => lock.release())
      return lock
    }),
  )

function barrier() {
  let enter!: () => void
  let resume!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const resumed = new Promise<void>((resolve) => {
    resume = resolve
  })
  hooks.lifetime.unpark(() => resume())
  return { entered, enter, resumed, resume }
}

describe('POSIX lease creation', () => {
  for (const [phase, description] of [
    ['before-write', 'before writing'],
    ['before-link', 'before publishing'],
  ] as const) {
    it(`does not publish an ownerless lease when a creator exits ${description}`, async () => {
      const path = join(dir, 'state.json')
      const lockPath = `${path}.creation-crash.lock`
      const child = Bun.spawn(
        [
          process.execPath,
          new URL('./fixtures/lease-creation-crash.ts', import.meta.url)
            .pathname,
          path,
          phase,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      hooks.lifetime.unpark(() => {
        if (child.exitCode === null) child.kill()
      })
      const [code, stdout, stderr] = await observed(
        hooks.lifetime,
        hooks.lifetime.operation(
          Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]),
        ),
      )
      expect(code, stderr).toBe(73)
      expect(stdout).toBe('')
      expect(stderr).toBe('')

      const abandonedLease = await readFile(lockPath, 'utf8').catch((error) => {
        if (error.code !== 'ENOENT') throw error
        return null
      })
      const started = performance.now()
      const lock = await acquire({
        path,
        name: 'creation-crash',
        ttlMs: 10_000,
      })
      expect(
        lock,
        'A crashed creator must not block the next acquirer',
      ).not.toBeNull()
      expect(performance.now() - started).toBeLessThan(1_000)
      expect(abandonedLease).toBeNull()
      expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({
        ownerId: expect.any(String),
        expiresAt: expect.any(Number),
      })
      // A crash may orphan staging, but that name never participates in locking.
      expect(
        (await readdir(dir)).filter((name) => name.endsWith('.tmp')),
      ).toHaveLength(1)
      await lock!.release()
    })
  }

  it('publishes a complete private lease and removes staging after release', async () => {
    const path = join(dir, 'normal.json')
    const lockPath = `${path}.normal.lock`
    let staged = ''
    setLeaseCreationTestHooksForTest({
      beforeLink: async (tempPath, target) => {
        expect(target).toBe(lockPath)
        staged = await readFile(tempPath, 'utf8')
        expect(JSON.parse(staged)).toMatchObject({
          ownerId: expect.any(String),
          expiresAt: expect.any(Number),
        })
        expect((await stat(tempPath)).mode & 0o777).toBe(0o600)
        expect(await readdir(dir)).toEqual([basename(tempPath)])
      },
    })
    const lock = await acquire({ path, name: 'normal', ttlMs: 10_000 })
    expect(lock).not.toBeNull()
    expect(await readFile(lockPath, 'utf8')).toBe(staged)
    expect((await stat(lockPath)).mode & 0o777).toBe(0o600)
    expect(await readdir(dir)).toEqual(['normal.json.normal.lock'])
    await lock!.release()
    expect(await readdir(dir)).toEqual([])
  })

  it('keeps a live holder exclusive, cleans EEXIST staging, and acquires after release', async () => {
    const path = join(dir, 'contended.json')
    const options = { name: 'contended', ttlMs: 10_000 }
    const holder = await acquire({ path, ...options })
    expect(holder).not.toBeNull()
    const lockPath = `${path}.contended.lock`
    const owner = await readFile(lockPath, 'utf8')
    const refused = barrier()
    const cancellation = new AbortController()
    hooks.lifetime.unpark(() => cancellation.abort())
    let entered = false
    const pending = hooks.lifetime.operation(
      withLock(
        path,
        {
          ...options,
          timeoutMs: 2_000,
          signal: cancellation.signal,
          onStep: async (step) => {
            if (step === 'lock-read-ready') {
              refused.enter()
              await refused.resumed
            }
          },
        },
        async (lock) => {
          entered = true
          await lock.assertOwned()
        },
      ),
    )
    await observed(hooks.lifetime, refused.entered)
    expect(entered).toBe(false)
    expect(await readFile(lockPath, 'utf8')).toBe(owner)
    expect(await readdir(dir)).toEqual(['contended.json.contended.lock'])
    await holder!.release()
    refused.resume()
    await observed(hooks.lifetime, pending)
    expect(entered).toBe(true)
    expect(await readdir(dir)).toEqual([])
  })

  for (const code of ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV']) {
    it(`falls back to exclusive open on ${code} without leaking staging or bypassing a holder`, async () => {
      const path = join(dir, 'fallback.json')
      const options = { path, name: 'fallback', ttlMs: 10_000 }
      const lockPath = `${path}.fallback.lock`
      const writes: string[] = []
      const error = Object.assign(new Error('Hard links unavailable'), { code })
      setLeaseCreationTestHooksForTest({
        beforeWrite: (createdPath) => {
          writes.push(createdPath)
        },
        beforeLink: () => {
          throw error
        },
      })
      const holder = await acquire(options)
      expect(holder).not.toBeNull()
      expect(writes).toHaveLength(2)
      expect(writes[0]).toMatch(/\.lock\.[\w-]+\.tmp$/)
      expect(writes[1]).toBe(lockPath)
      const owner = await readFile(lockPath, 'utf8')
      expect(JSON.parse(owner).ownerId).toEqual(expect.any(String))
      expect(await acquire(options)).toBeNull()
      expect(await readFile(lockPath, 'utf8')).toBe(owner)
      expect(await readdir(dir)).toEqual(['fallback.json.fallback.lock'])
      await holder!.release()
      expect(await readdir(dir)).toEqual([])
      const next = await acquire(options)
      expect(next).not.toBeNull()
      await next!.release()
      expect(await readdir(dir)).toEqual([])
    })
  }

  for (const phase of ['beforeWrite', 'beforeLink'] as const) {
    it(`removes staging and preserves a ${phase} error without falling back`, async () => {
      const error = Object.assign(new Error('Creation denied'), {
        code: 'EACCES',
      })
      setLeaseCreationTestHooksForTest({
        [phase]: () => {
          throw error
        },
      })
      await expect(
        acquire({
          path: join(dir, 'failed.json'),
          name: 'failed',
          ttlMs: 10_000,
        }),
      ).rejects.toBe(error)
      expect(await readdir(dir)).toEqual([])
    })
  }
})
