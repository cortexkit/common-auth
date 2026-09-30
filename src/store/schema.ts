import { createHash } from 'node:crypto'

/** Top-level key of the config file that holds everything the pool adds. */
export const POOL_KEY = 'commonAuthPool'
/** The pool schema this library reads and writes. */
export const POOL_SCHEMA_VERSION = 1
/** Property of `commonAuthPool` holding the per-row entries, keyed by local id. */
export const POOL_ROWS_KEY = 'rows'
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

/** A credential as stored: an OAuth credential also carries its refresh stamp. */
export type StoredCredential =
  | (OAuthCredential & { lastRefreshedAt?: number })
  | ApiKeyCredential

/** Quota codec supplied by `/quota`: the store never interprets the map itself. */
export interface QuotaCodec {
  validate(value: unknown): boolean
  merge(stored: unknown | undefined, observation: unknown): unknown
}

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
  /** The opaque quota map, as validated by the codec. */
  quota?: unknown
  hasEntry: boolean
  /** A row that may be refreshed, pulled for, or admitted. */
  candidate: boolean
  /** Set when the roster row or the per-row entry failed validation. */
  invalid?: 'roster' | 'entry'
}

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

export function fingerprintOf(
  credential: PoolCredential | StoredCredential,
): string {
  const secret =
    credential.type === 'oauth'
      ? `oauth\0${credential.refresh}`
      : `api\0${credential.apiKey}`
  return createHash('sha256').update(secret).digest('hex')
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
  if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 1)
    return undefined
  if ('needsFirstReading' in raw && typeof raw.needsFirstReading !== 'boolean')
    return undefined
  if ('disabledReason' in raw && typeof raw.disabledReason !== 'string')
    return undefined
  if ('quota' in raw && !codec.validate(raw.quota)) return undefined
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

/**
 * Builds the rows of a ready pool. A roster row the older readers would
 * reject, a duplicate id, or a malformed per-row entry makes that one row
 * invalid (never a candidate) and blocks nothing else.
 */
export function buildRows(
  config: Record<string, unknown>,
  state: Record<string, unknown>,
  codec: QuotaCodec,
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
        })
      continue
    }
    seen.add(id)
    const type = raw.type === 'api' ? 'api' : 'oauth'
    const hasEntry = Object.hasOwn(entries, id)
    const entry = hasEntry ? parseEntry(entries[id], codec) : undefined
    const credential = credentialFor(raw, stateAccounts[id])
    const enabled = raw.enabled !== false
    const row: PoolRow = {
      id,
      type,
      enabled,
      needsFirstReading: entry ? entry.needsFirstReading : type === 'oauth',
      hasEntry,
      candidate: false,
      ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
      ...(typeof raw.addedAt === 'number' ? { addedAt: raw.addedAt } : {}),
      ...(typeof raw.accountId === 'string' && raw.accountId
        ? { identity: raw.accountId }
        : {}),
      ...(credential
        ? { credential, fingerprint: fingerprintOf(credential) }
        : {}),
      ...(entry ? { credentialEpoch: entry.credentialEpoch } : {}),
      ...(entry?.disabledReason !== undefined
        ? { disabledReason: entry.disabledReason }
        : {}),
      ...(entry && 'quota' in entry ? { quota: entry.quota } : {}),
    }
    if (hasEntry && !entry) {
      row.invalid = 'entry'
    } else {
      row.candidate = enabled && credential !== undefined
    }
    rows.push(row)
  }
  return rows
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

export function credentialProblem(credential: unknown): string | undefined {
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
    if (!isValidBaseURL(credential.baseURL))
      return 'api credential needs a valid baseURL'
    return undefined
  }
  return 'credential type must be oauth or api'
}
