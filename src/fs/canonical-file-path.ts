import type * as syncFs from 'node:fs'
import type * as fs from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

type FilePathFs = Pick<typeof fs, 'lstat' | 'readlink' | 'realpath'>
type FilePathSyncFs = Pick<
  typeof syncFs,
  'lstatSync' | 'readlinkSync' | 'realpathSync'
>
const maxSymlinkHops = 40

/**
 * Canonical path of a file that other processes may replace by write-and-rename.
 *
 * On Linux, Bun's realpath on such a file can answer "<file> (deleted)" (Bun
 * 1.3) or ENOENT (Bun 1.4) during the rename. So this resolves the folder with
 * realpath and appends the name, then follows a file symlink one readlink hop at
 * a time, at most 40 hops. A missing file resolves to its would-be path; a
 * dangling link or a loop throws. Pass `node:fs/promises` (or a test double).
 */
export async function canonicalFilePath(
  file: string,
  fs: FilePathFs,
): Promise<string> {
  let target = file
  for (let hops = 0; ; hops++) {
    // Bun can report an unlinked inode's " (deleted)" name for realpath(file).
    target = join(await fs.realpath(dirname(target)), basename(target))
    let isSymlink: boolean
    try {
      isSymlink = (await fs.lstat(target)).isSymbolicLink()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && hops === 0)
        return target
      throw error
    }
    if (!isSymlink) return target
    if (hops >= maxSymlinkHops) throw new Error('Too many file symlink hops')
    target = resolve(dirname(target), await fs.readlink(target))
  }
}

/** Synchronous counterpart of canonicalFilePath; pass `node:fs`. */
export function canonicalFilePathSync(
  file: string,
  fs: FilePathSyncFs,
): string {
  let target = file
  for (let hops = 0; ; hops++) {
    target = join(fs.realpathSync(dirname(target)), basename(target))
    let isSymlink: boolean
    try {
      isSymlink = fs.lstatSync(target).isSymbolicLink()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && hops === 0)
        return target
      throw error
    }
    if (!isSymlink) return target
    if (hops >= maxSymlinkHops) throw new Error('Too many file symlink hops')
    target = resolve(dirname(target), fs.readlinkSync(target))
  }
}
