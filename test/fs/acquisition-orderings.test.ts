import { beforeEach, describe, expect } from 'bun:test'
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { acquireRefreshFileLock } from '../../src/fs/refresh-file-lock.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { observed } from '../fixtures/observed.js'
import { makeTempDir } from '../fixtures/scratch.js'

const hooks = lifetimeHooks()
const { it, afterEach } = hooks
let dir: string
beforeEach(async () => {
  dir = await makeTempDir('acquisition-orderings-')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})
type Step = Parameters<
  NonNullable<Parameters<typeof acquireRefreshFileLock>[0]['onStep']>
>[0]

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

async function scenario() {
  const path = join(dir, 'tokens.json')
  const name = 'refresh'
  const lockPath = `${path}.${name}.lock`
  const marker = `${lockPath}.evicting`
  const now = Date.now()
  await writeFile(
    lockPath,
    JSON.stringify({ ownerId: 'original-stale', expiresAt: now - 1 }),
  )
  const expireMarker = async () => {
    await utimes(marker, new Date(now - 10_000), new Date(now - 10_000))
  }
  const staleMarker = async () => {
    await mkdir(marker)
    await expireMarker()
  }
  const owner = async () =>
    JSON.parse(await readFile(lockPath, 'utf8')) as {
      ownerId: string
      expiresAt: number
    }
  const start = (
    steps: string[],
    pause?:
      | { step: Step; gate: ReturnType<typeof barrier> }
      | { step: Step; gate: ReturnType<typeof barrier> }[],
  ) => {
    const operation = acquireRefreshFileLock({
      path,
      name,
      ttlMs: 60_000,
      now: () => now,
      onContended: () => {
        steps.push('live-owner-refused')
      },
      onStep: async (step) => {
        steps.push(step)
        for (const point of pause
          ? Array.isArray(pause)
            ? pause
            : [pause]
          : []) {
          if (step === point.step) await point.gate.park()
        }
      },
    })
    return hooks.lifetime.operation(
      operation.then((lock) => {
        if (lock) hooks.lifetime.finish(() => lock.release())
        return lock
      }),
    )
  }
  return { start, staleMarker, owner }
}
const stolen = [
  'stale-lock-observed',
  'eviction-marker-acquired',
  'stale-lock-confirmed',
  'stale-lock-removed',
]

describe('deterministic stale acquisition orderings', () => {
  it('ordering 1 refuses a fresh occupied eviction marker after observing the original stale lock', async () => {
    const s = await scenario()
    const a: string[] = [],
      b: string[] = []
    const gate = barrier(),
      firstObserved = barrier(),
      secondObserved = barrier()
    const first = s.start(a, [
      { step: 'stale-lock-observed', gate: firstObserved },
      { step: 'stale-lock-confirmed', gate },
    ])
    await observed(hooks.lifetime, firstObserved.entered)
    const challenger = s.start(b, {
      step: 'stale-lock-observed',
      gate: secondObserved,
    })
    await observed(hooks.lifetime, secondObserved.entered)
    firstObserved.resume()
    await observed(hooks.lifetime, gate.entered)
    expect((await s.owner()).ownerId).toBe('original-stale')
    secondObserved.resume()
    const second = await challenger
    expect(second).toBeNull()
    expect(b).toEqual(['stale-lock-observed'])
    expect((await s.owner()).ownerId).toBe('original-stale')
    gate.resume()
    const winner = await first
    expect(winner).not.toBeNull()
    expect(a).toEqual(stolen)
    expect((await s.owner()).ownerId).toBe(winner!.ownerId)
    await winner!.assertOwned()
  })

  it('ordering 2 rechecks liveness under the marker and preserves the replacement owner', async () => {
    const s = await scenario()
    const a: string[] = [],
      b: string[] = []
    const gate = barrier()
    const first = s.start(a, { step: 'stale-lock-observed', gate })
    await observed(hooks.lifetime, gate.entered)
    expect((await s.owner()).ownerId).toBe('original-stale')
    const winner = await s.start(b)
    expect(winner).not.toBeNull()
    const successor = await s.owner()
    gate.resume()
    expect(await first).toBeNull()
    expect(a).toEqual([
      'stale-lock-observed',
      'eviction-marker-acquired',
      'live-owner-refused',
    ])
    expect(b).toEqual(stolen)
    expect(await s.owner()).toEqual(successor)
    await winner!.assertOwned()
  })

  it('ordering 3 gives the top-of-loop exclusive create the deletion gap and refuses the holder recreate', async () => {
    const s = await scenario()
    await s.staleMarker()
    const a: string[] = [],
      b: string[] = []
    const retry = barrier(),
      gap = barrier()
    // The old marker was renamed away from the active pathname. Resuming its
    // removal lets the acquisition loop retry an exclusive lock-file create.
    const challenger = s.start(b, { step: 'stale-marker-claimed', gate: retry })
    await observed(hooks.lifetime, retry.entered)
    const holder = s.start(a, { step: 'stale-lock-removed', gate: gap })
    await observed(hooks.lifetime, gap.entered)
    retry.resume()
    const winner = await challenger
    expect(winner).not.toBeNull()
    const successor = await s.owner()
    gap.resume()
    expect(await holder).toBeNull()
    expect(a).toEqual(stolen)
    expect(b).toEqual([
      'stale-lock-observed',
      'stale-marker-stat',
      'stale-marker-claimed',
    ])
    expect(await s.owner()).toEqual(successor)
    await winner!.assertOwned()
  })

  it('ordering 4 refuses the newly live lock on retry after its earlier stale observation', async () => {
    const s = await scenario()
    await s.staleMarker()
    const a: string[] = [],
      b: string[] = []
    const gate = barrier()
    const delayed = s.start(a, { step: 'stale-marker-stat', gate })
    await observed(hooks.lifetime, gate.entered)
    expect((await s.owner()).ownerId).toBe('original-stale')
    const winner = await s.start(b)
    expect(winner).not.toBeNull()
    const successor = await s.owner()
    gate.resume()
    expect(await delayed).toBeNull()
    expect(a).toEqual([
      'stale-lock-observed',
      'stale-marker-stat',
      'live-owner-refused',
    ])
    expect(b).toEqual([
      'stale-lock-observed',
      'stale-marker-stat',
      'stale-marker-claimed',
      ...stolen,
    ])
    expect(await s.owner()).toEqual(successor)
    await winner!.assertOwned()
  })
})
