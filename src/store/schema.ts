import { createHash } from 'node:crypto'

/** Top-level key of the config file that holds everything the pool adds. */
export const POOL_KEY = 'commonAuthPool'
/** The pool schema this library reads and writes. */
export const POOL_SCHEMA_VERSION = 1
/** Property of `commonAuthPool` holding the per-row entries, keyed by local id. */
export const POOL_ROWS_KEY = 'rows'
/**
 * Property of `commonAuthPool` (since 0.8.0) holding, per id, the highest
 * credential epoch a row with that id held when the store last dropped it
 * from the pool. A row added later under the same id starts past it (see
 * `nextAddEpochIn`), so an attribution taken for the dropped row never
 * matches the new one. Older readers ignore it, and older writers keep it
 * as they keep every pool key they do not know.
 */
export const POOL_RETIRED_EPOCHS_KEY = 'retiredEpochs'
/** The `version` older readers of the same files expect at the top level. */
export const LEGACY_STORE_VERSION = 1
/**
 * How far ahead of the clock a stored `lastRefreshedAt` may sit and still be
 * trusted. Older readers of the state file apply the same bound, and a stamp
 * strictly above it counts as absent when they compare two copies of a token.
 */
export const REFRESH_STAMP_TOLERANCE_MS = 5 * 60_000

export type OAuthCredential = {
  type: 'oauth'
  access?: string
  refresh: string
  expires?: number
}

export type ApiKeyCredential = {
  type: 'api'
  apiKey: string
  baseURL: string
  authHeader?: 'authorization-bearer' | 'x-api-key'
}

export type PoolCredential = OAuthCredential | ApiKeyCredential

/**
 * What `rotate` takes. Rotation refreshes the secret of the endpoint a row
 * already has, so an API key may leave out `baseURL` (and `authHeader`) to
 * keep the row's; one it gives must equal the row's.
 */
export type RotateCredential =
  | OAuthCredential
  | (Omit<ApiKeyCredential, 'baseURL'> & { baseURL?: string })

/** A credential as stored: an OAuth credential also carries its refresh stamp. */
export type StoredCredential =
  | (OAuthCredential & { lastRefreshedAt?: number })
  | ApiKeyCredential

/** Quota codec supplied by `/quota`: the store never interprets the map itself. */
export interface QuotaCodec {
  validate(value: unknown): boolean
  merge(stored: unknown | undefined, observation: unknown): unknown
}

/**
 * What `ProviderStateCodec.onReplace` is told about a replacement: the row id,
 * the credential epoch the new credential starts, `previousIdentity` (the
 * identity the locked row recorded before the replace), `identity` (the
 * identity the replace records), and the provider state the caller handed to
 * `replace`, if any. Each identity is absent when none was recorded.
 */
export interface ProviderStateReplacement {
  id: string
  credentialEpoch: number
  previousIdentity?: string
  identity?: string
  incoming?: unknown
}

/**
 * Codec for the provider state a plugin keeps beside each row's credential
 * (a project id, a device fingerprint, eligibility times: whatever belongs to
 * that credential). The store never interprets the value: it stores it as
 * JSON, asks `validate` before every write and on every load, and calls the
 * hooks below where two values meet. Every hook is synchronous and runs
 * under the store locks.
 */
export interface ProviderStateCodec {
  validate(value: unknown): boolean
  /**
   * The part of a (valid) value that belongs to the credential: what is true
   * of the account the credential signs in to, such as a project id or a
   * device fingerprint, as opposed to what the plugin merely tracks about
   * its use, such as a cooldown or a cursor. The credential stamp covers the
   * digest of exactly this projection, so a foreign edit of it hides the
   * value, while the rest may change through `updateProviderState` without
   * the stamp being rewritten. It must be a pure function of the value that
   * returns JSON with a deterministic key order. Without it the whole value
   * is credential-bound.
   */
  credentialBound?(value: unknown): unknown
  /**
   * Combines the value on disk with one a write brings (`add` of a secret the
   * pool already holds, `rotate`, or a refresh whose provider returned a
   * state). Called only when the row has a value on disk; without it the
   * incoming value replaces the stored one. Its result is validated.
   */
  merge?(onDisk: unknown, incoming: unknown): unknown
  /**
   * The provider state of a row once `replace` gives it a new credential
   * epoch. `previous` is the old credential's value (undefined when the row
   * shows none). Returning undefined clears it. Without this hook a replace
   * keeps the value handed to `replace` and otherwise clears the state.
   */
  onReplace?(
    previous: unknown | undefined,
    replacement: ProviderStateReplacement,
  ): unknown | undefined
}

/**
 * Why a row shows no provider state although the state file holds one for it.
 *
 * `uncovered`: the value's credential-bound part (see
 * `ProviderStateCodec.credentialBound`) is not the one this store last
 * wrote beside the row's credential at its credential epoch and recorded
 * identity. Another writer edited it, or
 * wrote the credential beside it without knowing about it (an older version
 * of this library, which drops the coverage, or a writer that does not know
 * the pool at all), or it belongs to an earlier credential of the row.
 * `invalid`: the value is covered but the codec rejects it, or the store was
 * opened without a provider-state codec.
 */
export type ProviderStateDrop = 'uncovered' | 'invalid'

/**
 * What the stamp beside a row's credential proves (see `CredentialStamp`).
 *
 * `none`: the row holds no credential, so there is nothing to stamp.
 * `bound`: the stamp was written with this credential (its digest matches),
 * names the row's credential epoch (1 for a row without a per-row entry),
 * the identity it records (or its recording none) and any endpoint it
 * records are the row's, and its dispatch digest matches everything a
 * request would send (the OAuth access and refresh tokens and expiry; the API
 * key with its `baseURL` and `authHeader`).
 * `missing`: the credential carries no stamp (written by a writer that does
 * not know about stamps, or one that dropped it).
 * `malformed`: the stamp is not one this store writes (wrong shape, or an
 * epoch outside the positive safe integers).
 * `mismatched`: the stamp was written for another credential, epoch,
 * identity, endpoint, or token to send than the row now holds.
 * `legacy`: a well-formed stamp written with this credential's secret but
 * with no dispatch digest (written by 0.4.3 or earlier), so it proves
 * neither the token sent nor the account or endpoint it goes to.
 */
export type CredentialStampStatus =
  | 'none'
  | 'bound'
  | 'missing'
  | 'malformed'
  | 'mismatched'
  | 'legacy'

/** One row of the pool as loaded. */
export interface PoolRow {
  id: string
  type: 'oauth' | 'api'
  label?: string
  enabled: boolean
  addedAt?: number
  /** Recorded wire identity (the roster row's `accountId`), when known. */
  identity?: string
  /** Undefined when the state file holds no usable credential for the row. */
  credential?: StoredCredential
  /** Stable hash of the credential's secret material; never persisted. */
  fingerprint?: string
  /** Undefined when the row has no per-row entry yet. */
  credentialEpoch?: number
  needsFirstReading: boolean
  disabledReason?: string
  /** Store-owned reservation; only `publishRoster` releases it for ordinary use. */
  staged?: { reservation: string }
  /** The opaque quota map, as validated by the codec. */
  quota?: unknown
  /**
   * The opaque provider state kept beside the credential, as validated by
   * the provider-state codec. Absent when the row has none, or when the one
   * on disk is not shown (see `providerStateDropped`).
   */
  providerState?: unknown
  /**
   * Set when the state file holds a provider state for the row that is not
   * shown, and why. The value stays on disk untouched until a write on the
   * row sets or clears it; the row itself stays usable.
   */
  providerStateDropped?: ProviderStateDrop
  hasEntry: boolean
  /** A row that may be refreshed, pulled for, or admitted. */
  candidate: boolean
  /** Set when the roster row or the per-row entry failed validation. */
  invalid?: 'roster' | 'entry'
  /**
   * Set when a replace stopped between its two writes: the state file holds
   * the new credential, stamped with the epoch and the identity or endpoint
   * it belongs to, and the config still holds the replaced row. Also set when
   * a write that gives a row its first identity (`recordIdentity`, or a
   * `rotate` or refresh that learns one) stopped after stamping the identity
   * and before recording it in the config, and when an attributed `disable`
   * or `enable` that changed the provider state stopped after its state
   * write and before flipping the row in the config. The row is shown as the
   * write leaves it once completed, is never a candidate, and the next store
   * write on it writes the config to match.
   */
  torn?: true
  /**
   * Whether the credential is the one the store last stamped for this row
   * (see `CredentialStampStatus`). Every row the store loads carries it; a
   * torn row reports the stamp of the row as it is shown completed. It is
   * optional only so that rows built by hand (test fixtures) still type.
   */
  stamp?: CredentialStampStatus
  /**
   * Set only when the store was opened with `requireCredentialStamps` and
   * the row's `stamp` is not `bound`: the row is never a candidate, and
   * `refresh`, quota pulls, `recordQuota`, `recordIdentity`, `rotate` and a
   * re-`add` onto it refuse with `unbound-credential`. Only `replace` (or a
   * new row) makes it usable again.
   */
  unbound?: true
}

/**
 * Key, inside a state-file account entry, of the stamp naming what the
 * credential beside it belongs to. Older readers ignore it.
 */
export const CREDENTIAL_STAMP_KEY = POOL_KEY

/**
 * What the config holds for a credential when its stamp is written: the
 * identity it belongs to (absent: none is known yet) and, for an API key, its
 * endpoint. For a replace it is the config the replace is about to write.
 */
export interface CredentialBinding {
  identity?: string
  baseURL?: string
  authHeader?: 'authorization-bearer' | 'x-api-key'
}

/**
 * Written beside every credential the store puts in the state file. It names
 * the credential epoch the credential belongs to and a digest of its secret,
 * so a stamp left beside a credential another writer put there afterwards is
 * recognisable and ignored.
 *
 * `digest` covers only the refresh token or API key: it names the credential
 * lineage, and torn-replace detection matches it, including against stamps
 * older versions wrote, so it keeps that exact definition. `dispatch` covers
 * everything a request sends (see `dispatchDigest`), so a token or endpoint
 * changed beside an unchanged lineage secret is caught; stamps written by
 * 0.4.3 or earlier lack it.
 *
 * `binding` is the config the credential was written beside (see
 * `CredentialBinding`); every write since 0.4.4 records it, earlier versions
 * only on replace. `replace` marks a stamp written by a replace, which is
 * what lets a reader complete a replace that stopped after writing the
 * credential: a stamp from any other write is never completed as torn.
 *
 * `providerState` is the digest of the credential-bound part of the provider
 * state beside the credential (see `providerStateDigest`); it is absent when
 * the row has none, so the stamp of a row without provider state is exactly
 * what 0.5.0 wrote. It is apart from `digest` and `dispatch`, which keep
 * their meaning: the credential's stamp status never depends on it.
 */
export interface CredentialStamp {
  credentialEpoch: number
  digest: string
  dispatch?: string
  binding?: CredentialBinding
  replace?: true
  providerState?: string
  staged?: StagedStamp
}

/** Original staged-add metadata, persisted with the credential before config exists. */
export interface StagedStamp {
  reservation: string
  label?: string
  disabledReason: string
  providerState?: string
}

/** Canonical JSON: recursively sorted object keys, preserved array order. */
export function canonicalJson(value: unknown): string {
  const normalized: unknown = JSON.parse(JSON.stringify(value))
  const encode = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`
    if (isRecord(item))
      return `{${Object.keys(item)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode(item[key])}`)
        .join(',')}}`
    return JSON.stringify(item)
  }
  return encode(normalized)
}

export function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function parseReservation(
  raw: unknown,
): { reservation: string } | undefined {
  if (
    !isRecord(raw) ||
    Object.keys(raw).length !== 1 ||
    typeof raw.reservation !== 'string' ||
    !raw.reservation
  )
    return undefined
  return { reservation: raw.reservation }
}

function parseStagedStamp(raw: unknown): StagedStamp | undefined {
  if (
    !isRecord(raw) ||
    typeof raw.reservation !== 'string' ||
    !raw.reservation ||
    typeof raw.disabledReason !== 'string'
  )
    return undefined
  if (
    Object.keys(raw).some(
      (key) =>
        !['reservation', 'label', 'disabledReason', 'providerState'].includes(
          key,
        ),
    )
  )
    return undefined
  if ('label' in raw && typeof raw.label !== 'string') return undefined
  if (
    'providerState' in raw &&
    (typeof raw.providerState !== 'string' ||
      !/^[a-f0-9]{64}$/.test(raw.providerState))
  )
    return undefined
  return raw as unknown as StagedStamp
}

/**
 * Key, inside a state-file account entry, of the provider state kept beside
 * the credential. Older readers ignore it.
 */
export const PROVIDER_STATE_KEY = 'commonAuthProviderState'

export type ConfigClassification =
  | { status: 'ready'; exists: boolean; config: Record<string, unknown> }
  | { status: 'pending-migration'; config: Record<string, unknown> }
  | { status: 'error'; reason: string }

export type StateClassification =
  | { status: 'ready'; exists: boolean; state: Record<string, unknown> }
  | { status: 'error'; reason: string }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

const UNSAFE_IDS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Ids are stored exactly as given. Older readers trim ids, so an id with
 * surrounding whitespace would be renamed by them; such ids, empty ids and
 * prototype keys are refused instead of being rewritten.
 */
export function idProblem(id: unknown): string | undefined {
  if (typeof id !== 'string' || id.length === 0) return 'id must be non-empty'
  if (id.trim() !== id) return 'id must not carry surrounding whitespace'
  if (UNSAFE_IDS.has(id)) return 'id is a reserved object key'
  return undefined
}

/** Same URL rule the older readers apply to an API-key row's `baseURL`. */
export function isValidBaseURL(value: unknown): boolean {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return false
  try {
    const url = new URL(raw)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

function secretOf(credential: PoolCredential | StoredCredential): string {
  return credential.type === 'oauth'
    ? `oauth\0${credential.refresh}`
    : `api\0${credential.apiKey}`
}

export function fingerprintOf(
  credential: PoolCredential | StoredCredential,
): string {
  return createHash('sha256').update(secretOf(credential)).digest('hex')
}

/**
 * The digest a credential stamp carries. It is kept apart from the
 * fingerprint (a different input prefix) so the persisted value is never the
 * dedupe key.
 */
export function credentialDigest(
  credential: PoolCredential | StoredCredential,
): string {
  return createHash('sha256')
    .update(`credential-stamp\0${secretOf(credential)}`)
    .digest('hex')
}

/**
 * The digest of everything a request made with the credential sends or is
 * served by: the OAuth access token, refresh token and expiry (the expiry
 * decides whether the access token is used or refreshed first), or the API
 * key with the `baseURL` and header it is sent to. Its input prefix differs
 * from both the fingerprint's and `credentialDigest`'s, so it never equals
 * either. The parts are JSON-encoded as a list, so no two credentials share
 * an input. An access token or expiry the state file cannot hold as loaded
 * (not a string, not a finite number) counts as absent, which is how
 * `buildRawRows` loads it back.
 */
export function dispatchDigest(
  credential: PoolCredential | StoredCredential,
): string {
  const parts =
    credential.type === 'oauth'
      ? [
          'oauth',
          typeof credential.access === 'string' ? credential.access : null,
          credential.refresh,
          typeof credential.expires === 'number' &&
          Number.isFinite(credential.expires)
            ? credential.expires
            : null,
        ]
      : [
          'api',
          credential.apiKey,
          credential.baseURL.trim(),
          credential.authHeader ?? 'authorization-bearer',
        ]
  return createHash('sha256')
    .update(`credential-dispatch\0${JSON.stringify(parts)}`)
    .digest('hex')
}

/**
 * The stamp for a credential written into a row at `credentialEpoch`, beside
 * the config `binding` describes. `replace` is set only by a replace.
 */
export function stampFor(
  credential: PoolCredential | StoredCredential,
  credentialEpoch: number,
  binding: CredentialBinding,
  options: { replace?: boolean; providerState?: string } = {},
): CredentialStamp {
  return {
    credentialEpoch,
    digest: credentialDigest(credential),
    dispatch: dispatchDigest(credential),
    binding: { ...binding },
    ...(options.replace ? { replace: true as const } : {}),
    ...(options.providerState !== undefined
      ? { providerState: options.providerState }
      : {}),
  }
}

/**
 * The digest a stamp carries for a provider state: of its credential-bound
 * part (`ProviderStateCodec.credentialBound`, the whole value without it), as
 * it serializes. The store only ever stores values that survive a JSON round
 * trip unchanged, so the digest of a value read back from disk equals the one
 * computed when it was written. Its input prefix differs from every other
 * digest the store writes.
 */
export function providerStateDigest(
  codec: Pick<ProviderStateCodec, 'credentialBound'> | undefined,
  value: unknown,
): string {
  const bound = codec?.credentialBound ? codec.credentialBound(value) : value
  return createHash('sha256')
    .update(`provider-state\0${JSON.stringify(bound ?? null)}`)
    .digest('hex')
}

/**
 * The provider-state digest of the stamp in a state-file account entry, when
 * that stamp binds it to this row: written with this credential (its lineage
 * digest matches), at this credential epoch, naming this recorded identity.
 * Whether the value beside it still has that digest is checked apart, by
 * `providerStateFields`; this alone is what a write that keeps the value
 * carries into the stamp it writes, so a value no stamp of this store bound
 * to the row stays unbound rather than being vouched for, and one edited
 * after it was bound stays detectably edited.
 */
export function boundProviderStateDigest(
  account: unknown,
  credential: PoolCredential | StoredCredential | undefined,
  credentialEpoch: number | undefined,
  identity: string | undefined,
): string | undefined {
  if (!credential || credentialEpoch === undefined) return undefined
  if (!isRecord(account) || !Object.hasOwn(account, PROVIDER_STATE_KEY))
    return undefined
  const stamp = parseStamp(account[CREDENTIAL_STAMP_KEY])
  if (
    !stamp ||
    stamp.providerState === undefined ||
    stamp.digest !== credentialDigest(credential) ||
    stamp.credentialEpoch !== credentialEpoch ||
    stamp.binding?.identity !== identity
  )
    return undefined
  return stamp.providerState
}

/**
 * A credential epoch is a positive safe integer. Above `MAX_SAFE_INTEGER`,
 * adding one may give back the same number, so a replace would not move the
 * epoch and nothing could tell the old credential's work from the new one's.
 */
export function isCredentialEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1
}

/** A well-formed stamp, or undefined for anything else (which is ignored). */
export function parseStamp(raw: unknown): CredentialStamp | undefined {
  if (!isRecord(raw)) return undefined
  const epoch = raw.credentialEpoch
  if (!isCredentialEpoch(epoch)) return undefined
  if (typeof raw.digest !== 'string') return undefined
  if ('dispatch' in raw && typeof raw.dispatch !== 'string') return undefined
  if ('replace' in raw && raw.replace !== true) return undefined
  if ('providerState' in raw && typeof raw.providerState !== 'string')
    return undefined
  const staged = 'staged' in raw ? parseStagedStamp(raw.staged) : undefined
  if ('staged' in raw && !staged) return undefined
  const marks = {
    ...(staged ? { staged } : {}),
    ...(typeof raw.dispatch === 'string' ? { dispatch: raw.dispatch } : {}),
    ...(raw.replace === true ? { replace: true as const } : {}),
    ...(typeof raw.providerState === 'string'
      ? { providerState: raw.providerState }
      : {}),
  }
  // Every stamp that carries a dispatch digest or a provider-state digest is
  // written with a binding; one without is not a stamp this store writes,
  // and it would leave the row's identity unchecked.
  if (!('binding' in raw))
    return 'dispatch' in raw ||
      'replace' in raw ||
      'providerState' in raw ||
      'staged' in raw
      ? undefined
      : { credentialEpoch: epoch, digest: raw.digest }
  const binding = raw.binding
  if (!isRecord(binding)) return undefined
  if (
    'identity' in binding &&
    (typeof binding.identity !== 'string' || !binding.identity)
  )
    return undefined
  if ('baseURL' in binding && !isValidBaseURL(binding.baseURL)) return undefined
  if (
    'authHeader' in binding &&
    binding.authHeader !== 'authorization-bearer' &&
    binding.authHeader !== 'x-api-key'
  )
    return undefined
  return {
    credentialEpoch: epoch,
    digest: raw.digest,
    ...marks,
    binding: {
      ...(typeof binding.identity === 'string'
        ? { identity: binding.identity }
        : {}),
      ...(typeof binding.baseURL === 'string'
        ? { baseURL: binding.baseURL.trim() }
        : {}),
      ...(binding.authHeader === 'authorization-bearer' ||
      binding.authHeader === 'x-api-key'
        ? { authHeader: binding.authHeader }
        : {}),
    },
  }
}

/**
 * Whether the binding of a stamp is the row's: the identity it names (or its
 * naming none) must be exactly the row's recorded identity, and an endpoint
 * it names must be the one the row sends its API key to.
 *
 * Every write that gives a row an identity (`add`, `replace`, `rotate` or a
 * refresh that learns one, `recordIdentity`) writes the stamp naming it
 * before the config, so this store never leaves a config identity beside a
 * stamp that names none or another: that is another writer's doing and is
 * `mismatched`. The reverse, a stamp naming an identity beside a config that
 * has none, is such a write stopped between its two writes: the row as
 * `buildRawRows` reads it from the files is `mismatched`, but `loadRows`,
 * which every reader goes through, shows it with the identity recorded (see
 * `torn.ts`), where it is `bound`.
 */
function bindingAgrees(
  binding: CredentialBinding,
  credential: StoredCredential,
  identity: string | undefined,
): boolean {
  if (binding.identity !== identity) return false
  if (
    binding.baseURL !== undefined &&
    (credential.type !== 'api' || credential.baseURL !== binding.baseURL)
  )
    return false
  if (
    binding.authHeader !== undefined &&
    (credential.type !== 'api' || credential.authHeader !== binding.authHeader)
  )
    return false
  return true
}

/**
 * The stamp status of a loaded row (see `CredentialStampStatus`).
 * `credentialEpoch` is undefined only when the row's per-row entry exists but
 * failed validation, in which case no stamp can match it.
 */
function stampStatusOf(
  credential: StoredCredential | undefined,
  credentialEpoch: number | undefined,
  identity: string | undefined,
  account: unknown,
): CredentialStampStatus {
  if (!credential) return 'none'
  if (!isRecord(account) || !Object.hasOwn(account, CREDENTIAL_STAMP_KEY))
    return 'missing'
  const stamp = parseStamp(account[CREDENTIAL_STAMP_KEY])
  if (!stamp) return 'malformed'
  if (stamp.digest !== credentialDigest(credential)) return 'mismatched'
  // A stamp from 0.4.3 or earlier proves neither the token sent nor (its
  // binding being optional and identity-lenient) the account, so it is
  // reported as such whatever else it says, and never as bound.
  if (stamp.dispatch === undefined) return 'legacy'
  if (stamp.credentialEpoch !== credentialEpoch) return 'mismatched'
  // `parseStamp` refuses a stamp with a dispatch digest and no binding.
  if (!stamp.binding || !bindingAgrees(stamp.binding, credential, identity))
    return 'mismatched'
  if (stamp.dispatch !== dispatchDigest(credential)) return 'mismatched'
  return 'bound'
}

/** A parsed file, or the reason it could not be parsed. */
export type FileRead =
  | { exists: false }
  | { exists: true; value: unknown }
  | { exists: true; parseError: unknown }

export function classifyConfig(read: FileRead): ConfigClassification {
  if (!read.exists) return { status: 'ready', exists: false, config: {} }
  if ('parseError' in read)
    return { status: 'error', reason: 'config file is not valid JSON' }
  const value = read.value
  if (!isRecord(value))
    return { status: 'error', reason: 'config root is not an object' }
  if ('accounts' in value && !Array.isArray(value.accounts))
    return { status: 'error', reason: 'config accounts is not an array' }
  if (!(POOL_KEY in value)) {
    return Array.isArray(value.accounts)
      ? { status: 'pending-migration', config: value }
      : { status: 'ready', exists: true, config: value }
  }
  const pool = value[POOL_KEY]
  if (!isRecord(pool))
    return { status: 'error', reason: `${POOL_KEY} is not an object` }
  const version = pool.schemaVersion
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
    return { status: 'error', reason: `${POOL_KEY}.schemaVersion is invalid` }
  if (version > POOL_SCHEMA_VERSION)
    return {
      status: 'error',
      reason: `${POOL_KEY}.schemaVersion ${version} is newer than ${POOL_SCHEMA_VERSION}`,
    }
  if (POOL_ROWS_KEY in pool && !isRecord(pool[POOL_ROWS_KEY]))
    return {
      status: 'error',
      reason: `${POOL_KEY}.${POOL_ROWS_KEY} is not an object`,
    }
  return { status: 'ready', exists: true, config: value }
}

export function classifyState(read: FileRead): StateClassification {
  if (!read.exists) return { status: 'ready', exists: false, state: {} }
  if ('parseError' in read)
    return { status: 'error', reason: 'state file is not valid JSON' }
  if (!isRecord(read.value))
    return { status: 'error', reason: 'state root is not an object' }
  if ('accounts' in read.value && !isRecord(read.value.accounts))
    return { status: 'error', reason: 'state accounts is not an object' }
  return { status: 'ready', exists: true, state: read.value }
}

export function rosterOf(config: Record<string, unknown>): unknown[] {
  return Array.isArray(config.accounts) ? config.accounts : []
}

export function entriesOf(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const pool = config[POOL_KEY]
  if (!isRecord(pool)) return {}
  const rows = pool[POOL_ROWS_KEY]
  return isRecord(rows) ? rows : {}
}

function stateAccountsOf(
  state: Record<string, unknown>,
): Record<string, unknown> {
  return isRecord(state.accounts) ? state.accounts : {}
}

/** The reason a roster row cannot be loaded, mirroring the older readers. */
function rosterRowProblem(raw: unknown): string | undefined {
  if (!isRecord(raw)) return 'not an object'
  const problem = idProblem(raw.id)
  if (problem) return problem
  if (raw.type === 'api')
    return isValidBaseURL(raw.baseURL) ? undefined : 'invalid baseURL'
  if (raw.type === 'oauth') return undefined
  return 'unknown type'
}

interface ParsedEntry {
  credentialEpoch: number
  needsFirstReading: boolean
  disabledReason?: string
  quota?: unknown
}

function parseEntry(raw: unknown, codec: QuotaCodec): ParsedEntry | undefined {
  if (!isRecord(raw)) return undefined
  const epoch = raw.credentialEpoch
  if (!isCredentialEpoch(epoch)) return undefined
  if ('needsFirstReading' in raw && typeof raw.needsFirstReading !== 'boolean')
    return undefined
  if ('disabledReason' in raw && typeof raw.disabledReason !== 'string')
    return undefined
  if ('quota' in raw && !codec.validate(raw.quota)) return undefined
  if ('staged' in raw && !parseReservation(raw.staged)) return undefined
  return {
    credentialEpoch: epoch,
    needsFirstReading: raw.needsFirstReading === true,
    ...(typeof raw.disabledReason === 'string'
      ? { disabledReason: raw.disabledReason }
      : {}),
    ...('quota' in raw ? { quota: raw.quota } : {}),
  }
}

function credentialFor(
  raw: Record<string, unknown>,
  stateEntry: unknown,
): StoredCredential | undefined {
  if (!isRecord(stateEntry)) return undefined
  if (raw.type === 'api') {
    const apiKey =
      typeof stateEntry.apiKey === 'string' ? stateEntry.apiKey.trim() : ''
    if (!apiKey) return undefined
    return {
      type: 'api',
      apiKey,
      baseURL: String(raw.baseURL).trim(),
      authHeader:
        raw.authHeader === 'x-api-key' ? 'x-api-key' : 'authorization-bearer',
    }
  }
  if (raw.corrupt === true) return undefined
  const refresh = stateEntry.refresh
  if (typeof refresh !== 'string' || !refresh.trim()) return undefined
  return {
    type: 'oauth',
    refresh,
    ...(typeof stateEntry.access === 'string'
      ? { access: stateEntry.access }
      : {}),
    ...(typeof stateEntry.expires === 'number'
      ? { expires: stateEntry.expires }
      : {}),
    ...(typeof stateEntry.lastRefreshedAt === 'number'
      ? { lastRefreshedAt: stateEntry.lastRefreshedAt }
      : {}),
  }
}

/** The first roster row with this id (the one the pool loads). */
export function rosterRowIn(
  config: Record<string, unknown>,
  id: string,
): Record<string, unknown> | undefined {
  return rosterOf(config).find(
    (raw): raw is Record<string, unknown> => isRecord(raw) && raw.id === id,
  )
}

/** The pool object of a config, created (empty) when absent. */
function ensurePool(config: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(config[POOL_KEY])) config[POOL_KEY] = {}
  return config[POOL_KEY] as Record<string, unknown>
}

/** The per-row entries of a config, created (empty) when absent. */
export function ensureEntries(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const pool = ensurePool(config)
  if (!isRecord(pool[POOL_ROWS_KEY])) pool[POOL_ROWS_KEY] = {}
  return pool[POOL_ROWS_KEY] as Record<string, unknown>
}

export function entryIn(
  config: Record<string, unknown>,
  id: string,
): Record<string, unknown> | undefined {
  const entries = entriesOf(config)
  const entry = Object.hasOwn(entries, id) ? entries[id] : undefined
  return isRecord(entry) ? entry : undefined
}

/** Sets an entry as an own property, so an id such as `toString` is safe. */
export function setEntryIn(
  config: Record<string, unknown>,
  id: string,
  entry: Record<string, unknown>,
): void {
  Object.defineProperty(ensureEntries(config), id, {
    value: entry,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

/**
 * The credential epoch recorded for a dropped id (see
 * `POOL_RETIRED_EPOCHS_KEY`), or undefined when none is. A value that is not
 * a credential epoch counts as none.
 */
export function retiredEpochIn(
  config: Record<string, unknown>,
  id: string,
): number | undefined {
  const pool = config[POOL_KEY]
  if (!isRecord(pool)) return undefined
  const retired = pool[POOL_RETIRED_EPOCHS_KEY]
  if (!isRecord(retired) || !Object.hasOwn(retired, id)) return undefined
  const epoch = retired[id]
  return isCredentialEpoch(epoch) ? epoch : undefined
}

/**
 * The epoch a per-row entry claims, read without validating the rest of the
 * entry, or undefined when it names none a reader would accept.
 */
function entryEpochIn(
  config: Record<string, unknown>,
  id: string,
): number | undefined {
  const epoch = entryIn(config, id)?.credentialEpoch
  return isCredentialEpoch(epoch) ? epoch : undefined
}

/**
 * The credential epoch `add` gives a new row with this id: one past the
 * highest epoch the id is known to have held, which is the epoch recorded
 * when the store dropped it, or the epoch of an entry left behind by a writer
 * that removed only its roster row; 1 for an id the pool never held.
 *
 * An attribution names a row by id and credential epoch (and identity), and
 * an id is chosen by the plugin, so it is often the same one again (`main`).
 * Were a re-added row to start at epoch 1 again, an attribution taken for the
 * removed row's credential would match the new credential exactly, in this
 * process or any other. Starting past every earlier epoch makes such an
 * attribution fail as it does after a `replace`. The result may lie past the
 * safe integers (an id whose last row was at `Number.MAX_SAFE_INTEGER`);
 * `add` refuses such an id.
 */
export function nextAddEpochIn(
  config: Record<string, unknown>,
  id: string,
): number {
  return (
    Math.max(retiredEpochIn(config, id) ?? 0, entryEpochIn(config, id) ?? 0) + 1
  )
}

/**
 * Records, in a config being written, the epochs of the ids it drops: for
 * each, the epoch its entry claims (1 for a row without one, the epoch such a
 * row is at), kept only when above what is already recorded, so the record
 * for an id never goes down. Valid recorded values of other ids are kept; a
 * record that is not an object, or a value in it that is not an epoch, says
 * nothing and is replaced. An entry whose epoch cannot be read records 1.
 */
export function retireEpochsIn(
  config: Record<string, unknown>,
  dropped: Iterable<string>,
): void {
  const ids = [...dropped]
  if (ids.length === 0) return
  const pool = ensurePool(config)
  const previous = isRecord(pool[POOL_RETIRED_EPOCHS_KEY])
    ? (pool[POOL_RETIRED_EPOCHS_KEY] as Record<string, unknown>)
    : {}
  const next: Record<string, unknown> = {}
  const define = (id: string, epoch: number) =>
    Object.defineProperty(next, id, {
      value: epoch,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  for (const [id, epoch] of Object.entries(previous))
    if (isCredentialEpoch(epoch)) define(id, epoch)
  for (const id of ids)
    define(
      id,
      Math.max(retiredEpochIn(config, id) ?? 0, entryEpochIn(config, id) ?? 1),
    )
  pool[POOL_RETIRED_EPOCHS_KEY] = next
}

/**
 * Builds the rows of a ready pool from the files exactly as they are, without
 * looking at credential stamps (see `loadRows` for the rows every reader
 * gets). A roster row the older readers would reject, a duplicate id, or a
 * malformed per-row entry makes that one row invalid (never a candidate) and
 * blocks nothing else.
 */
export function buildRawRows(
  config: Record<string, unknown>,
  state: Record<string, unknown>,
  codec: QuotaCodec,
  providerCodec?: ProviderStateCodec,
): PoolRow[] {
  const entries = entriesOf(config)
  const stateAccounts = stateAccountsOf(state)
  const seen = new Set<string>()
  const rows: PoolRow[] = []
  for (const raw of rosterOf(config)) {
    const problem = rosterRowProblem(raw)
    const id = isRecord(raw) && typeof raw.id === 'string' ? raw.id : undefined
    if (problem || !isRecord(raw) || id === undefined || seen.has(id)) {
      if (id !== undefined && !seen.has(id)) seen.add(id)
      if (id !== undefined)
        rows.push({
          id,
          type: isRecord(raw) && raw.type === 'api' ? 'api' : 'oauth',
          enabled: false,
          needsFirstReading: true,
          hasEntry: Object.hasOwn(entries, id),
          candidate: false,
          invalid: 'roster',
          stamp: 'none',
        })
      continue
    }
    seen.add(id)
    const type = raw.type === 'api' ? 'api' : 'oauth'
    const hasEntry = Object.hasOwn(entries, id)
    const entry = hasEntry ? parseEntry(entries[id], codec) : undefined
    const rawEntry = entries[id]
    const reserved = isRecord(rawEntry) && Object.hasOwn(rawEntry, 'staged')
    const staged = reserved ? parseReservation(rawEntry.staged) : undefined
    const credential = credentialFor(raw, stateAccounts[id])
    const enabled = raw.enabled !== false
    // A row without a per-row entry is at credential epoch 1 (the epoch the
    // store stamps and later gives it), so its stamp is checked against 1.
    const stampEpoch = entry ? entry.credentialEpoch : hasEntry ? undefined : 1
    const identity =
      typeof raw.accountId === 'string' && raw.accountId
        ? raw.accountId
        : undefined
    const row: PoolRow = {
      id,
      type,
      enabled,
      needsFirstReading: entry ? entry.needsFirstReading : type === 'oauth',
      hasEntry,
      candidate: false,
      ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
      ...(typeof raw.addedAt === 'number' ? { addedAt: raw.addedAt } : {}),
      ...(identity !== undefined ? { identity } : {}),
      ...(credential
        ? { credential, fingerprint: fingerprintOf(credential) }
        : {}),
      ...(entry ? { credentialEpoch: entry.credentialEpoch } : {}),
      ...(staged ? { staged } : {}),
      ...(entry?.disabledReason !== undefined
        ? { disabledReason: entry.disabledReason }
        : {}),
      ...(entry && 'quota' in entry ? { quota: entry.quota } : {}),
      ...providerStateFields(
        stateAccounts[id],
        credential,
        stampEpoch,
        identity,
        providerCodec,
      ),
      stamp: stampStatusOf(credential, stampEpoch, identity, stateAccounts[id]),
    }
    if (hasEntry && !entry) {
      row.invalid = 'entry'
    } else {
      row.candidate = enabled && credential !== undefined && !reserved
    }
    rows.push(row)
  }
  return rows
}

/**
 * The provider-state fields of a loaded row. A value on disk is shown only
 * when the stamp beside the credential binds a provider state to this row's
 * credential, epoch and identity (see `boundProviderStateDigest`), the codec
 * accepts the value, and the value's credential-bound part has the digest
 * that stamp names. Otherwise the row says why it shows none and stays
 * usable: the value is the plugin's own derived data, which it can rebuild,
 * and the credential beside it may well be sound.
 */
function providerStateFields(
  account: unknown,
  credential: StoredCredential | undefined,
  credentialEpoch: number | undefined,
  identity: string | undefined,
  codec: ProviderStateCodec | undefined,
): Pick<PoolRow, 'providerState' | 'providerStateDropped'> {
  if (!isRecord(account) || !Object.hasOwn(account, PROVIDER_STATE_KEY))
    return {}
  const digest = boundProviderStateDigest(
    account,
    credential,
    credentialEpoch,
    identity,
  )
  if (digest === undefined) return { providerStateDropped: 'uncovered' }
  const value = account[PROVIDER_STATE_KEY]
  // The value is validated before it is projected, so the projection only
  // ever sees a value of the shape the codec accepts.
  if (!codec?.validate(value)) return { providerStateDropped: 'invalid' }
  if (providerStateDigest(codec, value) !== digest)
    return { providerStateDropped: 'uncovered' }
  return { providerState: value }
}

/** The row-lock key: recorded wire identity when known, else the local id. */
export function rowLockKey(row: Pick<PoolRow, 'id' | 'identity'>): string {
  return row.identity ?? row.id
}

/**
 * The refresh stamp a write persists: the clock, raised to one past a prior
 * stamp that is still trusted, so a stale copy of the previous token can never
 * compare newer than the rotation. A prior stamp beyond the trust bound says
 * nothing and is ignored.
 */
export function rotationStamp(prior: number | undefined, now: number): number {
  if (prior === undefined || prior > now + REFRESH_STAMP_TOLERANCE_MS)
    return now
  return Math.max(now, prior + 1)
}

/** True when a rotation stamped now would itself be past the trust bound. */
export function rotationStampUntrusted(
  prior: number | undefined,
  now: number,
): boolean {
  return rotationStamp(prior, now) > now + REFRESH_STAMP_TOLERANCE_MS
}

/** The legacy-shaped roster row for a new row. */
export function rosterRowFor(input: {
  id: string
  credential: PoolCredential
  identity?: string
  label?: string
  addedAt: number
}): Record<string, unknown> {
  const { id, credential, identity, label, addedAt } = input
  return {
    id,
    ...(label !== undefined ? { label } : {}),
    type: credential.type,
    addedAt,
    ...(identity !== undefined ? { accountId: identity } : {}),
    ...(credential.type === 'api'
      ? {
          baseURL: credential.baseURL.trim(),
          authHeader: credential.authHeader ?? 'authorization-bearer',
        }
      : {}),
  }
}

/** The state-file fields a credential occupies, in the older readers' names. */
export function stateFieldsFor(
  credential: PoolCredential,
  lastRefreshedAt: number | undefined,
): Record<string, unknown> {
  if (credential.type === 'api') return { apiKey: credential.apiKey }
  return {
    ...(credential.access !== undefined ? { access: credential.access } : {}),
    refresh: credential.refresh,
    ...(credential.expires !== undefined
      ? { expires: credential.expires }
      : {}),
    ...(lastRefreshedAt !== undefined ? { lastRefreshedAt } : {}),
  }
}

export function storedCredential(
  credential: PoolCredential,
  lastRefreshedAt: number | undefined,
): StoredCredential {
  if (credential.type === 'api')
    return {
      ...credential,
      baseURL: credential.baseURL.trim(),
      authHeader: credential.authHeader ?? 'authorization-bearer',
    }
  return {
    ...credential,
    ...(lastRefreshedAt !== undefined ? { lastRefreshedAt } : {}),
  }
}

export function credentialProblem(
  credential: unknown,
  options: { baseURLOptional?: boolean } = {},
): string | undefined {
  if (!isRecord(credential)) return 'credential must be an object'
  if (credential.type === 'oauth') {
    if (typeof credential.refresh !== 'string' || !credential.refresh.trim())
      return 'oauth credential needs a refresh token'
    return undefined
  }
  if (credential.type === 'api') {
    if (typeof credential.apiKey !== 'string' || !credential.apiKey.trim())
      return 'api credential needs an api key'
    if (credential.apiKey.trim() !== credential.apiKey)
      return 'api key must not carry surrounding whitespace'
    const omitted = options.baseURLOptional && credential.baseURL === undefined
    if (!omitted && !isValidBaseURL(credential.baseURL))
      return 'api credential needs a valid baseURL'
    return undefined
  }
  return 'credential type must be oauth or api'
}
