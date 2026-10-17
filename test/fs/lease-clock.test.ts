import { expect } from 'bun:test'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { acquireRefreshFileLock, lockPathFor } from '../../src/fs/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { observed } from '../fixtures/observed.js'
import { makeTempDir } from '../fixtures/scratch.js'
import { deferred } from '../store/helpers.js'

const hooks = lifetimeHooks()
const { it } = hooks

it('public filesystem leases ignore injected clocks for expiry renewal and eviction', async () => {
  const dir = await makeTempDir()
  hooks.lifetime.finish(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'pool.json')
  const name = 'save'
  const ttlMs = 60_000
  const leasePath = lockPathFor(path, name)
  const renewed = deferred()
  const started = Date.now()
  let clock = 1_000_000
  const holder = await acquireRefreshFileLock({
    path,
    name,
    ttlMs,
    // @ts-expect-error Public callers cannot supply a lease clock, even though JavaScript can pass extra fields.
    now: () => clock,
    renew: true,
    renewIntervalMs: 10,
    onStep: (step) => {
      if (step === 'renewal-finished') renewed.resolve()
    },
  })
  expect(holder).not.toBeNull()
  try {
    expect(
      JSON.parse(await readFile(leasePath, 'utf8')).expiresAt,
    ).toBeGreaterThan(started)
    clock = 4_000_000_000_000
    await observed(hooks.lifetime, renewed.promise)
    await holder?.assertOwned()
    const expiry = JSON.parse(await readFile(leasePath, 'utf8')).expiresAt
    expect(expiry).toBeGreaterThan(Date.now())
    expect(expiry).toBeLessThanOrEqual(Date.now() + ttlMs)
    const contender = await acquireRefreshFileLock({ path, name, ttlMs })
    try {
      expect(contender).toBeNull()
    } finally {
      await contender?.release()
    }
  } finally {
    await holder?.release()
  }

  await writeFile(
    leasePath,
    `${JSON.stringify({ ownerId: 'expired', expiresAt: started - 1 })}\n`,
  )
  const replacement = await acquireRefreshFileLock({
    path,
    name,
    ttlMs,
    // @ts-expect-error A synthetic clock must not make an expired wall-time lease appear live.
    now: () => 1_000_000,
  })
  try {
    expect(replacement).not.toBeNull()
    await replacement?.assertOwned()
  } finally {
    await replacement?.release()
  }
})
