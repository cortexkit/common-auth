import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/** Canonicalize the parent even when the store file has not been created yet. */
export function canonicalLimitsPath(path: string): string {
  try {
    return join(realpathSync.native(dirname(path)), basename(path))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return resolve(path)
    throw error
  }
}
