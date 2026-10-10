import type { Stats } from 'node:fs'
import { rmdirSync, statSync } from 'node:fs'
import { mkdir, rmdir, stat, utimes } from 'node:fs/promises'

// Protocol source: proper-lockfile 4.1.2 lib/lockfile.js and lib/mtime-precision.js;
// line-level citations and the Pi lock options are recorded in docs/sources.md.
const STALE = 30_000
const UPDATE = STALE / 2
let precision: 's' | 'ms' | undefined
type Identity = { dev: number; ino: number; mtime: number }
const active = new Map<string, Identity>()
process.once('exit', () => {
  for (const [path, identity] of active) {
    try {
      const observed = statSync(path)
      if (
        sameDirectory(observed, identity) &&
        observed.mtime.getTime() === identity.mtime
      )
        rmdirSync(path)
    } catch {
      /* A compromised or already removed lock is not ours to clean up. */
    }
  }
})

function sameDirectory(observed: Stats, identity: Identity): boolean {
  return observed.dev === identity.dev && observed.ino === identity.ino
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined
}
function held(): Error {
  return Object.assign(new Error('Pi auth lock held'), { code: 'ELOCKED' })
}
async function remove(path: string): Promise<void> {
  try {
    await rmdir(path)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
}

async function acquire(path: string, stale: number): Promise<Identity> {
  try {
    await mkdir(path)
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error
    if (stale <= 0) throw held()
    let mtime: number
    try {
      mtime = (await stat(path)).mtime.getTime()
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return acquire(path, 0)
      throw error
    }
    if (!(mtime < Date.now() - stale)) throw held()
    // Match upstream: rmdir (ignore ENOENT), then one mkdir attempt without another stale check.
    await remove(path)
    return acquire(path, 0)
  }
  try {
    if (!precision) {
      const probe = new Date(Math.ceil(Date.now() / 1_000) * 1_000 + 5)
      await utimes(path, probe, probe)
    }
    const observed = await stat(path)
    const mtime = observed.mtime.getTime()
    precision ??= mtime % 1_000 === 0 ? 's' : 'ms'
    return { dev: observed.dev, ino: observed.ino, mtime }
  } catch (error) {
    await remove(path).catch(() => {})
    throw error
  }
}

/** The same mkdir/mtime/rmdir protocol as Pi's proper-lockfile, with realpath disabled. */
export async function acquirePiLock(
  authPath: string,
  onCompromised: () => void,
  onRenew?: (renew: () => Promise<void>) => void,
): Promise<{ release(): Promise<void> }> {
  const path = `${authPath}.lock`
  const identity = await acquire(path, STALE)
  let mtime = identity.mtime
  let lastUpdate = Date.now()
  let released = false
  let timer: ReturnType<typeof setTimeout> | undefined
  active.set(path, identity)

  function compromise() {
    released = true
    if (timer) clearTimeout(timer)
    active.delete(path)
    onCompromised()
  }
  function schedule(delay = UPDATE) {
    if (released) return
    timer = setTimeout(() => {
      void update()
    }, delay)
    timer.unref()
  }
  function retry(error: unknown) {
    if (released) return
    if (errorCode(error) === 'ENOENT' || lastUpdate + STALE < Date.now())
      compromise()
    else schedule(1_000)
  }
  async function update() {
    if (released) return
    let observed: Stats
    try {
      observed = await stat(path)
    } catch (error) {
      retry(error)
      return
    }
    if (released) return
    if (
      !sameDirectory(observed, identity) ||
      observed.mtime.getTime() !== mtime
    ) {
      compromise()
      return
    }
    const next = new Date(
      precision === 's' ? Math.ceil(Date.now() / 1_000) * 1_000 : Date.now(),
    )
    try {
      await utimes(path, next, next)
    } catch (error) {
      retry(error)
      return
    }
    if (released) return
    mtime = next.getTime()
    active.set(path, { ...identity, mtime })
    lastUpdate = Date.now()
    schedule()
  }
  // Tests can resume a paused renewal without waiting for the production timer.
  onRenew?.(async () => {
    if (timer) clearTimeout(timer)
    await update()
  })
  schedule()
  return {
    async release() {
      if (released) return
      released = true
      if (timer) clearTimeout(timer)
      active.delete(path)
      let observed: Stats
      try {
        observed = await stat(path)
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error
        compromise()
        return
      }
      if (
        !sameDirectory(observed, identity) ||
        mtime !== observed.mtime.getTime()
      ) {
        compromise()
        return
      }
      await remove(path)
    },
  }
}
