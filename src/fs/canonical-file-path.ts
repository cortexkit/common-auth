import type * as syncFs from 'node:fs'
import type * as fs from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

type FilePathFs = Pick<typeof fs, 'lstat' | 'readlink' | 'realpath'>
type FilePathSyncFs = Pick<
  typeof syncFs,
  'lstatSync' | 'readlinkSync' | 'realpathSync'
>
const maxSymlinkHops = 40

/** Resolve file aliases without realpath on an atomically replaced file. */
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

/** Synchronous counterpart for watcher registration before the first write. */
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
