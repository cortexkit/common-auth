import { rmdirSync } from 'node:fs'
import { mkdir, rmdir, stat, utimes } from 'node:fs/promises'

// Protocol source: proper-lockfile 4.1.2 lib/lockfile.js and lib/mtime-precision.js;
// line-level citations and the Pi lock options are recorded in docs/sources.md.
const STALE = 30_000
const UPDATE = STALE / 2
let precision: 's' | 'ms' | undefined
const active = new Set<string>()
process.once('exit', () => {
  for (const path of active) {
    try {
      rmdirSync(path)
    } catch {
      /* A compromised or already removed lock is not ours to clean up. */
    }
  }
})

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

async function acquire(path: string, stale: number): Promise<number> {
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
    const mtime = (await stat(path)).mtime.getTime()
    precision ??= mtime % 1_000 === 0 ? 's' : 'ms'
    return mtime
  } catch (error) {
    await remove(path).catch(() => {})
    throw error
  }
}

/** The same mkdir/mtime/rmdir protocol as Pi's proper-lockfile, with realpath disabled. */
export async function acquirePiLock(
  authPath: string,
  onCompromised: () => void,
): Promise<{ release(): Promise<void> }> {
  const path = `${authPath}.lock`
  let mtime = await acquire(path, STALE)
  let lastUpdate = Date.now()
  let released = false
  let timer: ReturnType<typeof setTimeout> | undefined
  active.add(path)

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
    let observed: number
    try {
      observed = (await stat(path)).mtime.getTime()
    } catch (error) {
      retry(error)
      return
    }
    if (released) return
    if (observed !== mtime) {
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
    lastUpdate = Date.now()
    schedule()
  }
  schedule()
  return {
    async release() {
      if (released) return
      released = true
      if (timer) clearTimeout(timer)
      active.delete(path)
      await remove(path)
    },
  }
}
