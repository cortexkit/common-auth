import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoScratchRoot = fileURLToPath(new URL('../.scratch/', import.meta.url))

/** Create an isolated project outside the repository's dependency tree. */
export async function makeTempDir(prefix = 'common-auth-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

/** Keep generated fixtures inside the repository so dependencies remain reachable. */
export async function makeRepoScratchDir(prefix = 'fixture-'): Promise<string> {
  await mkdir(repoScratchRoot, { recursive: true })
  const directory = join(repoScratchRoot, `${prefix}${randomUUID()}`)
  await mkdir(directory)
  return directory
}
