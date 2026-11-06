import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/**
 * Canonicalize a store path even when the store file, or folders above it,
 * have not been created yet. The nearest existing ancestor folder is resolved
 * through symlinks and junctions; the missing folders and the file name are
 * appended unchanged. Two aliases of one folder therefore agree before and
 * after a process creates the store's folder.
 */
export function canonicalLimitsPath(path: string): string {
  const absolute = resolve(path)
  const missing = [basename(absolute)]
  let folder = dirname(absolute)
  for (;;) {
    try {
      return join(realpathSync.native(folder), ...missing.reverse())
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      const parent = dirname(folder)
      // Nothing above exists (an unmounted drive or a removed root): keep the
      // plain absolute path, as earlier versions did for a missing parent.
      if (parent === folder) return absolute
      missing.push(basename(folder))
      folder = parent
    }
  }
}
