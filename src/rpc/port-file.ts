import { createHash, randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { RpcLogChannel } from './index.js'

export interface PortFileEntry {
  port: number
  token: string
  pid: number
  startedAt: number
}

/**
 * A PID a liveness probe may address. `process.kill(0 | negative, 0)` signals
 * a process group rather than a process, and an unsafe integer cannot name a
 * real process, so neither is ever probed.
 */
function isProbeablePid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0
}

function pidAlive(pid: number): boolean {
  if (!isProbeablePid(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function createManagedRpcStateDirPredicate(
  directoryPrefix: string,
): (name: string) => boolean {
  return (name) => isManagedRpcStateDir(name, directoryPrefix)
}

export function isManagedRpcStateDir(
  name: string,
  directoryPrefix: string,
): boolean {
  if (/^[0-9a-f]{16}$/.test(name)) return true
  return (
    name.startsWith(directoryPrefix) &&
    /^[0-9a-f]{16}$/.test(name.slice(directoryPrefix.length))
  )
}

export function getRpcDir(
  rpcRoot: string,
  directoryPrefix: string,
  projectDirectory: string,
): string {
  return join(
    rpcRoot,
    directoryPrefix +
      createHash('sha256').update(projectDirectory).digest('hex').slice(0, 16),
  )
}

/** The PID a port file's name claims, or undefined for a malformed name. */
function filenamePid(name: string): number | undefined {
  const match = /^port-(\d+)\.json$/.exec(name)
  return match ? Number(match[1]) : undefined
}

/**
 * An entry a client may connect to: its PID is probeable and matches the PID
 * in its file name (a mismatch means the file was not written by the server
 * it names), its port is a real TCP port, and its token is non-empty (an
 * absent token would otherwise be sent as `Bearer undefined`).
 */
function isUsablePortFileEntry(
  value: unknown,
  name: string,
): value is PortFileEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false
  const { pid, port, token } = value as {
    pid?: unknown
    port?: unknown
    token?: unknown
  }
  return (
    isProbeablePid(pid) &&
    filenamePid(name) === pid &&
    typeof port === 'number' &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65_535 &&
    typeof token === 'string' &&
    token.length > 0
  )
}

async function removeCorruptPortFile(
  portFile: string,
  log?: RpcLogChannel,
): Promise<void> {
  log?.debug('rpc corrupt port file', { pid: process.pid, portFile })
  await unlink(portFile).catch(() => {})
}

export async function writePortFile(
  dir: string,
  entry: { port: number; token: string; pid: number },
  options: {
    secureDir?: boolean
    beforeWrite?: () => void | Promise<void>
    /** Test seam for forcing staging-name collisions; defaults to randomUUID. */
    stageName?: () => string
  } = {},
): Promise<string> {
  // The directory can be removed by another project's sweep between our
  // mkdir and the first open/rename, so the whole create-then-rename
  // unit is retried once on ENOENT. The retry recreates the directory; a
  // persistent ENOENT (e.g. permission, read-only parent) will surface on
  // the second attempt — failing fast beats an unbounded loop.
  const writeOnce = async (): Promise<string> => {
    await mkdir(dir, {
      recursive: true,
      mode: options.secureDir ? 0o700 : undefined,
    })
    if (options.secureDir) await chmod(dir, 0o700)
    await options.beforeWrite?.()
    const full: PortFileEntry = { ...entry, startedAt: Date.now() }
    const target = join(dir, `port-${entry.pid}.json`)
    const tmp = `${target}.${(options.stageName ?? randomUUID)()}.tmp`
    let handle: Awaited<ReturnType<typeof open>> | undefined
    let created = false
    try {
      handle = await open(tmp, 'wx', 0o600)
      created = true
      await handle.writeFile(JSON.stringify(full), 'utf8')
      await handle.chmod(0o600)
      await handle.close()
      handle = undefined
      await rename(tmp, target)
      created = false
    } finally {
      await handle?.close().catch(() => {})
      // Remove token-bearing staging bytes only if this call created them.
      if (created) await unlink(tmp).catch(() => {})
    }
    return target
  }
  try {
    return await writeOnce()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return await writeOnce()
    }
    throw error
  }
}

export async function sweepRpcState(
  root: string,
  activeDir: string,
  isManagedDir: (name: string) => boolean,
  log?: RpcLogChannel,
): Promise<void> {
  let projectDirs: Dirent<string>[]
  try {
    projectDirs = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }

  const active = resolve(activeDir)
  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory() || !isManagedDir(projectDir.name)) {
      continue
    }
    const dir = join(root, projectDir.name)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    for (const name of names) {
      if (!name.startsWith('port-') || !name.endsWith('.json')) continue
      const portFile = join(dir, name)
      let raw: string | undefined
      try {
        raw = await readFile(portFile, 'utf8')
      } catch {
        continue
      }
      if (raw === undefined) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        await removeCorruptPortFile(portFile, log)
        continue
      }
      if (!isUsablePortFileEntry(parsed, name)) {
        await removeCorruptPortFile(portFile, log)
        continue
      }
      const entry = parsed
      if (!pidAlive(entry.pid)) await unlink(portFile).catch(() => {})
    }
    if (resolve(dir) !== active) await rmdir(dir).catch(() => {})
  }
}

export interface DiscoverPortFileOptions {
  /**
   * Return only the expected PID's entry, or null; never fall back to
   * another live server. Without an expected PID nothing matches, so the
   * result is null. Off by default, when a missing or unmatched expected PID
   * falls back to the newest live entry.
   */
  exactPid?: boolean
}

/** Internal cache validation: probe only the selected file and its PID. */
export async function portFileIdentity(
  dir: string,
  entry: PortFileEntry,
): Promise<string | null> {
  if (!pidAlive(entry.pid)) return null
  const path = join(resolve(dir), `port-${entry.pid}.json`)
  try {
    const info = await stat(path)
    return `${path}:${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}`
  } catch {
    return null
  }
}

export async function discoverPortFile(
  dir: string,
  expectedPid?: number,
  options: DiscoverPortFileOptions = {},
): Promise<PortFileEntry | null> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return null
  }
  const live: PortFileEntry[] = []
  for (const name of names) {
    if (!name.startsWith('port-') || !name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(
        await readFile(join(dir, name), 'utf8'),
      ) as PortFileEntry
      if (isUsablePortFileEntry(parsed, name)) {
        if (pidAlive(parsed.pid)) live.push(parsed)
        else await unlink(join(dir, name)).catch(() => {})
      }
    } catch {}
  }
  if (live.length === 0) return null
  const candidates =
    expectedPid !== undefined && expectedPid >= 1
      ? live.filter((entry) => entry.pid === expectedPid)
      : []
  if (options.exactPid === true && candidates.length === 0) return null
  const entries = candidates.length > 0 ? candidates : live
  const sortTime = (entry: PortFileEntry) =>
    typeof entry.startedAt === 'number' && Number.isFinite(entry.startedAt)
      ? entry.startedAt
      : -Infinity
  return entries.sort((a, b) => sortTime(b) - sortTime(a))[0] ?? null
}
