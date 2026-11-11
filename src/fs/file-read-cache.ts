import type { Stats } from 'node:fs'
import { lstat, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

type FileIdentity = Stats | 'absent'

async function identity(
  path: string,
  probe: typeof stat,
): Promise<FileIdentity | undefined> {
  try {
    // Match the reader: private readers reject links, while readFile follows
    // them and needs the target's identity, not the link's identity.
    const metadata = await probe(path)
    return metadata.isFile() ? metadata : undefined
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'absent'
      : undefined
  }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  if (left === 'absent' || right === 'absent') return left === right
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

/** Process-local reads, capped at 64 path sets with one value per resolved set. */
export class FileReadCache<T> {
  readonly #probe: typeof stat
  readonly #entries = new Map<
    string,
    { identities: FileIdentity[]; value: T }
  >()

  constructor(
    options: {
      followSymlinks?: boolean
      stat?: typeof stat
      lstat?: typeof lstat
    } = {},
  ) {
    this.#probe = options.followSymlinks
      ? (options.stat ?? stat)
      : (options.lstat ?? lstat)
  }

  async read(
    paths: readonly string[],
    read: (resolvedPaths: string[]) => Promise<T>,
    validateHit?: (identities: readonly FileIdentity[]) => void,
  ): Promise<T> {
    const resolvedPaths = paths.map((path) => resolve(path))
    const key = JSON.stringify(resolvedPaths)
    const probed = await Promise.all(
      resolvedPaths.map((path) => identity(path, this.#probe)),
    )
    const identities = probed.every((entry) => entry !== undefined)
      ? probed
      : undefined
    const cached = this.#entries.get(key)
    if (
      identities &&
      cached &&
      identities.every((entry, index) => {
        const previous = cached.identities[index]
        return previous !== undefined && sameIdentity(entry, previous)
      })
    ) {
      validateHit?.(identities)
      return cached.value
    }
    // A failed probe or read must not leave a previous successful value reusable.
    this.#entries.delete(key)
    const value = await read(resolvedPaths)
    if (identities) {
      if (this.#entries.size >= 64) {
        const oldest = this.#entries.keys().next().value
        if (oldest !== undefined) this.#entries.delete(oldest)
      }
      this.#entries.set(key, { identities, value })
    }
    return value
  }
}
