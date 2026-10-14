import { beforeEach, describe, expect } from 'bun:test'
import { readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { acquireRefreshFileLock } from '../../src/fs/refresh-file-lock.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { observed } from '../fixtures/observed.js'
import { makeTempDir } from '../fixtures/scratch.js'

const hooks = lifetimeHooks()
const { it, afterEach } = hooks
let path: string
const now = 2_000_000_000_000
beforeEach(async () => {
  path = join(await makeTempDir('stale-lock-identity-'), 'tokens')
})
afterEach(async () => {
  await rm(join(path, '..'), { recursive: true, force: true })
})
const lockPath = () => `${path}.refresh.lock`
type Options = Parameters<typeof acquireRefreshFileLock>[0]
function start(onStep?: Options['onStep']) {
  return hooks.lifetime.operation(
    acquireRefreshFileLock({
      path,
      name: 'refresh',
      ttlMs: 10_000,
      now: () => now,
      onStep,
    }).then((lock) => {
      if (lock) hooks.lifetime.finish(() => lock.release())
      return lock
    }),
  )
}
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
  return {
    entered,
    resume,
    park: async () => {
      enter()
      await resumed
    },
  }
}
async function stale() {
  await writeFile(
    lockPath(),
    JSON.stringify({ ownerId: 'expired', expiresAt: now - 1 }),
  )
}

describe('stale lock identity', () => {
  it('missing lock retries exclusive create without an eviction marker', async () => {
    await stale()
    const gap = barrier()
    const steps: string[] = []
    let removed = false
    const contender = start(async (step) => {
      steps.push(step)
      if (step === 'lock-read-ready' && !removed) {
        removed = true
        await rm(lockPath())
      }
      if (step === 'lock-missing') await gap.park()
    })
    await observed(hooks.lifetime, gap.entered)
    expect(
      await stat(`${lockPath()}.evicting`).catch((error) => error.code),
    ).toBe('ENOENT')
    const holder = await start()
    expect(holder).not.toBeNull()
    const bytes = await readFile(lockPath())
    gap.resume()
    expect(await contender).toBeNull()
    expect(await readFile(lockPath())).toEqual(bytes)
    await holder!.assertOwned()
    expect(steps).not.toContain('stale-lock-observed')
    expect(steps).not.toContain('stale-lock-removed')
  })

  it('missing lock under the marker preserves a fresh exclusive creator', async () => {
    await stale()
    const gap = barrier()
    const steps: string[] = []
    const contender = start(async (step) => {
      steps.push(step)
      if (step === 'eviction-marker-acquired') await rm(lockPath())
      if (step === 'lock-missing') await gap.park()
    })
    await observed(hooks.lifetime, gap.entered)
    const holder = await start()
    expect(holder).not.toBeNull()
    const bytes = await readFile(lockPath())
    gap.resume()
    expect(await contender).toBeNull()
    expect(await readFile(lockPath())).toEqual(bytes)
    await holder!.assertOwned()
    expect(steps).not.toContain('stale-lock-confirmed')
    expect(steps).not.toContain('stale-lock-removed')
  })

  for (const replacement of [
    'fresh',
    'expired',
    'same-owner-new-expiry',
    'legacy',
  ] as const) {
    it(`preserves ${replacement} replacement after stale confirmation`, async () => {
      await stale()
      const gate = barrier()
      const steps: string[] = []
      let paused = false
      const contender = start(async (step) => {
        steps.push(step)
        if (step === 'stale-lock-confirmed' && !paused) {
          paused = true
          await gate.park()
        }
        // Stop after the first retry so even another expired record must survive.
        if (step === 'lock-read-ready' && paused)
          throw new Error('retry observed')
      }).catch((error: unknown) => {
        if (error instanceof Error && error.message === 'retry observed')
          return null
        throw error
      })
      await observed(hooks.lifetime, gate.entered)
      await rm(lockPath())
      let holder: Awaited<ReturnType<typeof start>> = null
      if (replacement === 'fresh') holder = await start()
      else {
        await writeFile(
          lockPath(),
          JSON.stringify({
            ...(replacement === 'legacy'
              ? {}
              : {
                  ownerId:
                    replacement === 'same-owner-new-expiry'
                      ? 'expired'
                      : 'different',
                }),
            expiresAt: now - 2,
          }),
        )
      }
      const bytes = await readFile(lockPath()).catch(() => null)
      gate.resume()
      expect(await contender).toBeNull()
      expect(await readFile(lockPath()).catch(() => null)).toEqual(bytes)
      expect(steps).not.toContain('stale-lock-removed')
      await holder?.assertOwned()
    })
  }

  it('evicts a genuinely expired lock', async () => {
    await stale()
    const steps: string[] = []
    const holder = await start((step) => {
      steps.push(step)
    })
    expect(holder).not.toBeNull()
    expect(steps).toContain('stale-lock-removed')
    expect(JSON.parse(await readFile(lockPath(), 'utf8')).ownerId).toBe(
      holder!.ownerId,
    )
    await holder!.assertOwned()
  })

  it('missing lock at the removal fence retries creation without removal', async () => {
    await stale()
    const steps: string[] = []
    let removed = false
    const holder = await start(async (step) => {
      steps.push(step)
      if (step === 'stale-lock-confirmed' && !removed) {
        removed = true
        await rm(lockPath())
      }
    })
    expect(holder).not.toBeNull()
    expect(steps).not.toContain('stale-lock-removed')
    await holder!.assertOwned()
  })

  it('renewal refuses expiry after its last awaited write barrier', async () => {
    let clock = now
    const ready = barrier()
    const finished = barrier()
    const holder = await acquireRefreshFileLock({
      path,
      name: 'refresh',
      ttlMs: 100,
      now: () => clock,
      renew: true,
      renewIntervalMs: 1,
      onStep: async (step) => {
        if (step === 'renewal-write-ready') await ready.park()
        if (step === 'renewal-finished') {
          finished.resume()
          await finished.park()
        }
      },
    })
    expect(holder).not.toBeNull()
    hooks.lifetime.finish(() => holder!.release())
    await observed(hooks.lifetime, ready.entered)
    const bytes = await readFile(lockPath())
    clock += 101
    ready.resume()
    await observed(hooks.lifetime, finished.entered)
    expect(await readFile(lockPath())).toEqual(bytes)
    expect((await observed(hooks.lifetime, holder!.whenLost())).reason).toBe(
      'expired',
    )
  })

  it('preserves a different legacy stat identity after stale confirmation', async () => {
    await writeFile(lockPath(), 'legacy')
    await utimes(lockPath(), new Date(now - 20_000), new Date(now - 20_000))
    const gate = barrier()
    const contender = start(async (step) => {
      if (step === 'stale-lock-confirmed') await gate.park()
    })
    await observed(hooks.lifetime, gate.entered)
    await writeFile(lockPath(), 'replacement legacy')
    await utimes(lockPath(), new Date(now + 10_000), new Date(now + 10_000))
    gate.resume()
    expect(await contender).toBeNull()
    expect(await readFile(lockPath(), 'utf8')).toBe('replacement legacy')
  })
})
