import { mock } from 'bun:test'
import * as fs from 'node:fs'
import * as promises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const original = { ...promises }
const sync = { ...fs }
const scenario = process.argv[2] ?? 'saturated'
const writers = scenario === 'saturated' ? 4 : 1
const root = await original.mkdtemp(join(tmpdir(), 'pi-slot-renewal-'))
let now = Date.now()
const realNow = Date.now
Date.now = () => now
let pending = 0
let holding = true
let queuedStat = 0
let queuedUtimes = 0
let syncUpdates = 0
const release: (() => void)[] = []
const queued: (() => void)[] = []
const reached = Promise.withResolvers<void>()
function metadata<T>(
  kind: 'stat' | 'utimes',
  run: () => Promise<T>,
): Promise<T> {
  if (pending < 4) return run()
  if (kind === 'stat') queuedStat++
  else queuedUtimes++
  return new Promise<T>((resolve, reject) => {
    queued.push(() => void run().then(resolve, reject))
  })
}

// Keep builtin mocks in this child so other tests retain the real filesystem.
mock.module('node:fs/promises', () => ({
  ...original,
  stat: (...args: Parameters<typeof promises.stat>) =>
    metadata('stat', () => original.stat(...args)),
  utimes: (...args: Parameters<typeof promises.utimes>) =>
    metadata('utimes', () => original.utimes(...args)),
  open: async (...args: Parameters<typeof promises.open>) => {
    const handle = await original.open(...args)
    const flush = handle.sync.bind(handle)
    handle.sync = async () => {
      if (holding) {
        pending++
        const held = new Promise<void>((resolve) => release.push(resolve))
        if (pending === writers) reached.resolve()
        await held
        pending--
      }
      await flush()
    }
    return handle
  },
}))
mock.module('node:fs', () => ({
  ...sync,
  statSync: (...args: Parameters<typeof fs.statSync>) => {
    const observed = sync.statSync(...args)
    if (scenario === 'slow-stat') now += 11_001
    return observed
  },
  utimesSync: (...args: Parameters<typeof fs.utimesSync>) => {
    sync.utimesSync(...args)
    syncUpdates++
    if (scenario === 'slow-utimes') now += 11_001
  },
}))

try {
  const { createPiSlot } = await import('../../src/pi-slot/slot.js')
  const { acquirePiLock } = await import('../../src/pi-slot/lock.js')
  const renewals: (() => Promise<void>)[] = []
  const paths: string[] = []
  if (scenario.startsWith('slow-')) {
    let compromised = 0
    const authPath = join(root, 'auth.json')
    const lease = await acquirePiLock(
      authPath,
      () => compromised++,
      (renew) => {
        renewals.push(renew)
      },
    )
    await renewals[0]?.()
    await lease.release()
    console.log(
      JSON.stringify({
        compromised,
        lockRemains: sync.existsSync(`${authPath}.lock`),
        syncUpdates,
      }),
    )
  } else {
    const operations: Promise<void>[] = []
    for (let i = 0; i < writers; i++) {
      const dir = join(root, String(i))
      await original.mkdir(dir, { mode: 0o700 })
      const authPath = join(dir, 'auth.json')
      paths.push(`${authPath}.lock`)
      await original.writeFile(
        authPath,
        '{"openai":{"type":"api_key","key":"original"}}',
        { mode: 0o600 },
      )
      const slot = createPiSlot(
        {
          authPath,
          stashPath: join(dir, 'stash.json'),
          provider: 'openai',
          placeholderKey: 'vault-placeholder',
        },
        undefined,
        { onRenew: (renew) => renewals.push(renew) },
      )
      operations.push(slot.enterVault())
    }
    await reached.promise
    const before = paths.map((path) => sync.statSync(path).mtimeMs)
    now += 2_000
    let completed = 0
    const renewed = Promise.all(
      renewals.map(async (renew) => {
        await renew()
        completed++
      }),
    )
    if (scenario === 'single') await renewed
    // No elapsed-time assertion: drain the ready continuations while syncs stay held.
    for (let i = 0; i < 20; i++) await Promise.resolve()
    const result = {
      pending,
      completed,
      queuedStat,
      queuedUtimes,
      advanced: paths.map(
        (path, i) => sync.statSync(path).mtimeMs > (before[i] ?? Infinity),
      ),
    }
    holding = false
    for (const resume of release) resume()
    for (const resume of queued) resume()
    await renewed
    await Promise.all(operations)
    console.log(JSON.stringify(result))
  }
} finally {
  Date.now = realNow
  await original.rm(root, { recursive: true, force: true })
}
