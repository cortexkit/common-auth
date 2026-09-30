// Stand-ins for the openai-auth modules the vendored accounts.ts excerpts
// import. Types and constants are copied from openai-auth main 5809e38c
// (custody.ts, custody-manifest.ts, paths.ts, provider.ts); the logger and
// the token-claim reader are stubbed because these tests never read them.

// custody.ts
export type ClaustrumMode = 'local' | 'claustrum'

// custody.ts
export type CustodyTransitionState = {
  manifestRevision: string
  storeGeneration: string
  fingerprints: {
    main?: string
    fallbacks: Record<string, string>
  }
}

// custody.ts
const CUSTODY_TOMBSTONE_PREFIX = 'claustrum-tombstone:v1:'
export function custodyTombstoneKey(provider: string): string {
  return `${CUSTODY_TOMBSTONE_PREFIX}${provider}`
}

// custody-manifest.ts
export const CUSTODY_OWNING_PROVIDER = 'openai'

// paths.ts
export interface AccountPaths {
  configPath: string
  statePath: string
}

// provider.ts
export type QuotaWindowName = string

// logger.ts (stub): the vendored writers log drops and writes; tests ignore it.
export function createLogger(_channel: string) {
  const ignore = (_message: string, _data?: unknown) => {}
  return { error: ignore, warn: ignore, info: ignore, debug: ignore }
}

// oauth.ts (stub): the fixtures' tokens carry no account claim.
export function extractAccountId(_tokens: {
  id_token: string
  access_token: string
  refresh_token: string
}): string | undefined {
  return undefined
}
