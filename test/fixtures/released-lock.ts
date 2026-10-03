import { readFile } from 'node:fs/promises'

/**
 * Whether a lock file is in the state a release leaves it: since 0.8.1 a
 * release does not remove its record (that would mean deleting whatever the
 * lock path names by then, possibly a successor's), it rewrites it with an
 * expiry in the past. So the path either holds no file, or a record whose
 * `expiresAt` is not after `now`. A record still being renewed would carry a
 * future expiry and fail this.
 */
export async function lockIsReleased(
  lockPath: string,
  now: number = Date.now(),
): Promise<boolean> {
  let text: string
  try {
    text = await readFile(lockPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
  const record = JSON.parse(text) as { expiresAt?: unknown }
  return typeof record.expiresAt === 'number' && record.expiresAt <= now
}
