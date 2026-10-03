import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

// The lease reader of @cortexkit/common-auth 0.8.0, from src/fs/refresh-file-lock.ts
// at tag v0.8.0 (readOwner, lines 110-118, and lockIsLive, lines 172-185). In
// that release both are closures inside acquireRefreshFileLock; here the
// captured lockPath, ttlMs and now become parameters and nothing else changes.
// Plugins still running 0.8.0 read lock files written by newer releases this
// way, so a newer record must keep reading the same through it.

export async function readOwner(lockPath: string) {
  const legacyOwnerPath = join(lockPath, 'owner.json')
  try {
    return JSON.parse(await readFile(lockPath, 'utf8'))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EISDIR') throw error
    return JSON.parse(await readFile(legacyOwnerPath, 'utf8'))
  }
}

export async function lockIsLive(
  lockPath: string,
  ttlMs: number,
  now: () => number = Date.now,
) {
  try {
    const currentOwner = await readOwner(lockPath)
    return Number(currentOwner?.expiresAt) > now()
  } catch {
    try {
      const current = await stat(lockPath)
      return current.mtimeMs + ttlMs > now()
    } catch {
      // Lock doesn't exist — safe to acquire.
      return false
    }
  }
}
