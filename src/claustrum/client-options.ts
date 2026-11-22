import {
  type ClaustrumClientOptions,
  storeIdentity,
} from '@cortexkit/claustrum-client'

export type CompatibleClaustrumClientOptions = ClaustrumClientOptions & {
  /** Project root for claustrum-client versions before 0.22 only. */
  projectRoot?: string
}

// Older clients need a project root to construct the identity. Claustrum's
// vault daemon does not use the root after validation, so newer clients omit
// it to avoid a refused route when the daemon cannot resolve the path.
const needsProjectRoot = storeIdentity.length !== 1
const compatibleStoreIdentity = storeIdentity as (
  rootOrStoragePath: string,
  storagePath?: string,
) => ReturnType<typeof storeIdentity>

export function defaultStoreIdentity(
  options: CompatibleClaustrumClientOptions,
) {
  const storagePath = options.storagePath ?? process.cwd()
  return needsProjectRoot
    ? compatibleStoreIdentity(options.projectRoot ?? process.cwd(), storagePath)
    : compatibleStoreIdentity(storagePath)
}

export function claustrumWireOptions(
  options: CompatibleClaustrumClientOptions,
): ClaustrumClientOptions {
  if (needsProjectRoot) return options
  const { projectRoot: _projectRoot, ...wireOptions } = options
  return wireOptions
}
