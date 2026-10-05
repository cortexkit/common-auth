import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface AtomicWriteOptions {
  serialize?: (value: unknown) => string
  beforeRename?: () => Promise<void>
  /** Test seam for forcing staging-name collisions; defaults to randomUUID. */
  stageName?: () => string
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${(options.stageName ?? randomUUID)()}.tmp`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let created = false
  try {
    handle = await open(tempPath, 'wx', 0o600)
    created = true
    await handle.writeFile(
      options.serialize
        ? options.serialize(value)
        : `${JSON.stringify(value, null, 2)}\n`,
      'utf8',
    )
    await handle.chmod(0o600)
    await handle.close()
    handle = undefined
    await options.beforeRename?.()
    await rename(tempPath, path)
    created = false
  } finally {
    await handle?.close().catch(() => {})
    // A failed write can leave partial bytes, but a collision is not ours to remove.
    if (created) await rm(tempPath, { force: true }).catch(() => {})
  }
}
