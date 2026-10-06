// Vendored for downgrade and mixed-version tests; see docs/sources.md.
// Verbatim excerpts of openai-auth packages/core/src/accounts.ts at main
// 5809e38c335481199221b97c5af9a839693b274b. Only the import block below is
// rewritten, and optional contention observers are threaded through save locks
// for mixed-version exclusion tests: the lock and atomic-write primitives come from this repository's
// src/fs, and the custody, logger, oauth, paths and provider symbols come from
// ./stubs.ts. Region markers name the source line range of each excerpt.
// biome-ignore-all lint/correctness/noUnusedVariables: excerpts keep symbols the entry points do not reach
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeJsonAtomic } from '../../../src/fs/atomic-write.js'
import { acquireRefreshFileLock } from '../../../src/fs/refresh-file-lock.js'
import {
  type AccountPaths,
  type ClaustrumMode,
  CUSTODY_OWNING_PROVIDER,
  type CustodyTransitionState,
  createLogger,
  custodyTombstoneKey,
  extractAccountId,
  type QuotaWindowName,
} from './stubs.js'

// --- accounts.ts lines 45-54 ---
const logR = createLogger('refresh')
const logA = createLogger('accounts')
// How long a holder's lock stays valid. A crashed holder blocks contenders for
// at most this long before the eviction path reclaims it.
const SAVE_ACCOUNTS_LOCK_TTL_MS = 10_000
// How long an acquirer waits before giving up. Deliberately NOT the TTL: with
// the two equal, a waiter can expire at the exact moment a live holder's lock
// does, so a legitimately-busy store is indistinguishable from a wedged one.
const SAVE_ACCOUNTS_LOCK_WAIT_MS = 15_000
const SAVE_ACCOUNTS_LOCK_RETRY_MS = 50

// --- accounts.ts lines 78-350 ---
// ---------------------------------------------------------------------------
// Window / quota types
// ---------------------------------------------------------------------------

export type AccountQuotaWindow = {
  usedPercent: number
  remainingPercent: number
  resetsAt?: string
  checkedAt: number
  windowMinutes?: number
}

export interface OAuthQuotaSnapshot {
  primary?: AccountQuotaWindow
  secondary?: AccountQuotaWindow
  resetCreditsAvailable?: number
  resetCreditsApplicable?: number
  spendControl?: OAuthSpendControlReading
  /**
   * Set when the source explicitly reported that the account has no credit
   * budget (wham's `spend_control` or `individual_limit` is null). An absent
   * `spendControl` alone only means the source did not carry the field: header
   * and WebSocket pushes never do, so merges keep the previous budget for them.
   * This marker is what lets a merge drop a budget that no longer exists.
   */
  spendControlCleared?: true
  credits?: OAuthCredits
}

export interface OAuthSpendControlReading {
  limit: number
  used: number
  remaining: number
  usedPercent: number
  remainingPercent: number
  resetsAt?: string
  unit?: string
  source?: string
  reached: boolean
}

export interface OAuthCredits {
  hasCredits: boolean
  unlimited: boolean
  overageLimitReached: boolean
  balance?: number
}

// ---------------------------------------------------------------------------
// Account types
// ---------------------------------------------------------------------------

export type AccountBase = {
  id: string
  label?: string
  enabled?: boolean
  addedAt?: number
  lastUsed?: number
  /** Stable ChatGPT account identifier extracted from the OAuth token claims. */
  accountId?: string
}

export type AccountOperationError = {
  message: string
  checkedAt: number
  nextRetryAt?: number
  retryCount?: number
  tokenHash?: string
}

export type OAuthAccount = AccountBase & {
  type: 'oauth'
  corrupt?: false
  access?: string
  refresh: string
  expires?: number
  lastRefreshedAt?: number
  lastRefreshError?: AccountOperationError
  lastQuotaRefreshError?: AccountOperationError
  quota?: OAuthQuotaSnapshot
}

export type CorruptOAuthAccount = AccountBase & {
  type: 'oauth'
  corrupt: true
  access?: undefined
  refresh?: undefined
  expires?: undefined
  lastRefreshedAt?: undefined
  lastRefreshError?: undefined
  lastQuotaRefreshError?: undefined
  quota?: undefined
}

export type ApiKeyAccount = AccountBase & {
  type: 'api'
  apiKey?: string
  baseURL: string
  authHeader?: 'authorization-bearer' | 'x-api-key'
}

export type FallbackAccount = OAuthAccount | CorruptOAuthAccount | ApiKeyAccount

export function isOAuthAccount(
  account: FallbackAccount,
): account is OAuthAccount {
  return account.type === 'oauth' && account.corrupt !== true
}

export function isApiKeyAccount(
  account: FallbackAccount,
): account is ApiKeyAccount {
  return account.type === 'api'
}

export function isValidApiBaseURL(value: string | undefined) {
  const raw = value?.trim()
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

// ---------------------------------------------------------------------------
// Storage types
// ---------------------------------------------------------------------------

export type RoutingMode = 'main-first' | 'fallback-first' | 'sticky-balanced'

export type KillswitchThresholds = Partial<
  Record<QuotaWindowName | '5h' | '1w', number>
>

export type KillswitchConfig = {
  enabled?: boolean
  main?: KillswitchThresholds
  accounts?: Record<string, KillswitchThresholds>
}

export interface ResetInFlight {
  redeemRequestId: string
  creditId: string
  startedAt: number
}

export interface ResetLastOutcome {
  code: string
  at: number
  previousOutcome?: {
    code: string
    at: number
  }
}

export interface ResetAccountState {
  inFlight?: ResetInFlight | Record<string, unknown>
  lastOutcome?: ResetLastOutcome
  cooldownUntil?: number
}

export type ResetStateByAccount = Record<string, ResetAccountState>

export type AccountStorage = {
  version: 1
  main?: {
    type: 'opencode'
    provider: 'openai'
  }
  routing?: {
    // Sticky-balanced retains a per-session pin in sidebar state; configuration
    // here selects only the routing policy, never the serving account itself.
    mode?: RoutingMode
  }
  fallbackOn?: number[]
  refresh?: {
    enabled?: boolean
    refreshBeforeExpiryMinutes?: number
    mainLastRefreshError?: AccountOperationError
    mainRefreshLeaseId?: string
    mainRefreshLeaseUntil?: number
    mainRefreshLeaseTokenHash?: string
  }
  quota?: {
    enabled?: boolean
    checkIntervalMinutes?: number
    refreshEveryNRequests?: number
    minimumRemaining?: Partial<Record<QuotaWindowName | '5h' | '1w', number>>
    failClosedOnUnknownQuota?: boolean
    mainQuota?: OAuthQuotaSnapshot
    mainQuotaCheckedAt?: number
    mainQuotaToken?: string
    mainLastQuotaApiError?: AccountOperationError
  }
  reset?: ResetStateByAccount
  dump?: {
    enabled?: boolean
  }
  costZeroing?: {
    enabled?: boolean
  }
  killswitch?: KillswitchConfig
  logging?: {
    level?: string
  }
  cachekeep?: {
    enabled?: boolean
    subagents?: boolean
    sustain?: boolean
    /** Clock-hour window start (0-23, inclusive) — keeps cachekeep idle warming
     *  inside `[startHour, endHour)` local hours. Omit to warm unconditionally. */
    startHour?: number
    /** Clock-hour window end (0-23, exclusive) — must differ from startHour
     *  to be honored; an unset or equal hour falls back to "always warm". */
    endHour?: number
  }
  /** Stable ChatGPT account identifier of the main account (extracted from OAuth token). */
  mainAccountId?: string
  claustrum?: {
    mode?: ClaustrumMode
    transition?: CustodyTransitionState
    rowHistory?: string[]
  }
  accounts: FallbackAccount[]
}

export function isCostZeroingEnabled(
  storage: Pick<AccountStorage, 'costZeroing'>,
): boolean {
  return storage.costZeroing?.enabled !== false
}

export type AccountRuntimeEntry = Partial<
  Pick<
    OAuthAccount,
    | 'access'
    | 'refresh'
    | 'expires'
    | 'lastUsed'
    | 'lastRefreshedAt'
    | 'lastRefreshError'
    | 'lastQuotaRefreshError'
    | 'quota'
  > &
    Pick<ApiKeyAccount, 'apiKey' | 'lastUsed'>
>

export type AccountRuntimeState = {
  version: 1
  main?: {
    quota?: OAuthQuotaSnapshot
    quotaCheckedAt?: number
    quotaToken?: string
    lastQuotaApiError?: AccountOperationError
    lastRefreshError?: AccountOperationError
    refreshLeaseId?: string
    refreshLeaseUntil?: number
    refreshLeaseTokenHash?: string
  }
  accounts?: Record<string, AccountRuntimeEntry>
}

export type AccountStateSaveScope = {
  mainQuota?: boolean
  mainRefresh?: boolean
  accounts?: true | string[]
}

// --- accounts.ts lines 374-386 ---
export type AccountRefreshError = {
  accountId: string
  message: string
}

export class AccountRemovedDuringRefreshError extends Error {
  readonly code = 'ACCOUNT_REMOVED_DURING_REFRESH'

  constructor(accountId: string) {
    super(`Fallback account ${accountId} was removed before refresh`)
    this.name = 'AccountRemovedDuringRefreshError'
  }
}

// --- accounts.ts lines 404-1865 ---
// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

const UNSAFE_RESET_ACCOUNT_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
])

export function isSafeResetAccountKey(accountKey: string): boolean {
  return accountKey.length > 0 && !UNSAFE_RESET_ACCOUNT_KEYS.has(accountKey)
}

function isAccountRemovedDuringRefreshError(
  error: unknown,
): error is AccountRemovedDuringRefreshError {
  return (
    error instanceof AccountRemovedDuringRefreshError ||
    (isRecord(error) &&
      error.name === 'AccountRemovedDuringRefreshError' &&
      error.code === 'ACCOUNT_REMOVED_DURING_REFRESH')
  )
}

function normalizeAccountBase(value: Record<string, unknown>): AccountBase {
  return {
    id:
      typeof value.id === 'string' && value.id.trim()
        ? value.id.trim()
        : randomUUID(),
    label: typeof value.label === 'string' ? value.label : undefined,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined,
    addedAt: typeof value.addedAt === 'number' ? value.addedAt : undefined,
    lastUsed: typeof value.lastUsed === 'number' ? value.lastUsed : undefined,
    accountId:
      typeof value.accountId === 'string' ? value.accountId : undefined,
  }
}

function normalizeOperationError(
  value: unknown,
): AccountOperationError | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.message !== 'string') return undefined
  const checkedAt = Number(value.checkedAt)
  if (!Number.isFinite(checkedAt)) return undefined
  const nextRetryAt = Number(value.nextRetryAt)
  const retryCount = Number(value.retryCount)
  return {
    message: value.message,
    checkedAt,
    nextRetryAt: Number.isFinite(nextRetryAt) ? nextRetryAt : undefined,
    retryCount: Number.isFinite(retryCount) ? retryCount : undefined,
    tokenHash:
      typeof value.tokenHash === 'string' ? value.tokenHash : undefined,
  }
}

function normalizeQuota(value: unknown): OAuthAccount['quota'] {
  if (!isRecord(value)) return undefined
  const quota: OAuthQuotaSnapshot = {}
  for (const key of ['primary', 'secondary'] as const) {
    const window = value[key]
    if (!isRecord(window)) continue
    const usedPercent = Number(window.usedPercent)
    const remainingPercent = Number(window.remainingPercent)
    const checkedAt = Number(window.checkedAt)
    if (
      !Number.isFinite(usedPercent) ||
      !Number.isFinite(remainingPercent) ||
      !Number.isFinite(checkedAt)
    ) {
      continue
    }
    const windowMinutes =
      typeof window.windowMinutes === 'number'
        ? window.windowMinutes
        : Number.NaN
    quota[key] = {
      usedPercent,
      remainingPercent,
      checkedAt,
      resetsAt:
        typeof window.resetsAt === 'string' ? window.resetsAt : undefined,
      ...(Number.isFinite(windowMinutes) && windowMinutes > 0
        ? { windowMinutes }
        : {}),
    }
  }

  for (const key of [
    'resetCreditsAvailable',
    'resetCreditsApplicable',
  ] as const) {
    const credits = typeof value[key] === 'number' ? value[key] : Number.NaN
    if (Number.isFinite(credits) && credits >= 0) {
      quota[key] = credits
    }
  }

  const spendControl = value.spendControl
  if (isRecord(spendControl)) {
    const limit = Number(spendControl.limit)
    const used = Number(spendControl.used)
    const remaining = Number(spendControl.remaining)
    const usedPercent = Number(spendControl.usedPercent)
    const remainingPercent = Number(spendControl.remainingPercent)
    if (
      Number.isFinite(limit) &&
      Number.isFinite(used) &&
      Number.isFinite(remaining) &&
      Number.isFinite(usedPercent) &&
      Number.isFinite(remainingPercent) &&
      typeof spendControl.reached === 'boolean'
    ) {
      quota.spendControl = {
        limit,
        used,
        remaining,
        usedPercent,
        remainingPercent,
        resetsAt:
          typeof spendControl.resetsAt === 'string'
            ? spendControl.resetsAt
            : undefined,
        unit:
          typeof spendControl.unit === 'string' ? spendControl.unit : undefined,
        source:
          typeof spendControl.source === 'string'
            ? spendControl.source
            : undefined,
        reached: spendControl.reached,
      }
    }
  }

  const credits = value.credits
  if (
    isRecord(credits) &&
    typeof credits.hasCredits === 'boolean' &&
    typeof credits.unlimited === 'boolean' &&
    typeof credits.overageLimitReached === 'boolean'
  ) {
    const balance = Number(credits.balance)
    quota.credits = {
      hasCredits: credits.hasCredits,
      unlimited: credits.unlimited,
      overageLimitReached: credits.overageLimitReached,
      ...(Number.isFinite(balance) ? { balance } : {}),
    }
  }

  return Object.keys(quota).length ? quota : undefined
}

export function normalizeAccount(value: unknown): FallbackAccount | null {
  if (!isRecord(value)) return null
  if (value.type === 'api') {
    const baseURL =
      typeof value.baseURL === 'string' ? value.baseURL.trim() : ''
    const apiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : ''
    if (!isValidApiBaseURL(baseURL)) return null
    const authHeader =
      value.authHeader === 'x-api-key' ? 'x-api-key' : 'authorization-bearer'
    return {
      ...normalizeAccountBase(value),
      type: 'api',
      apiKey: apiKey || undefined,
      baseURL,
      authHeader,
    }
  }

  if (value.type !== 'oauth') return null
  if (value.corrupt === true) {
    if (typeof value.id !== 'string' || !value.id.trim()) return null
    return {
      ...normalizeAccountBase(value),
      type: 'oauth',
      corrupt: true,
    }
  }
  if (typeof value.refresh !== 'string' || !value.refresh.trim()) {
    if (
      !Object.hasOwn(value, 'refresh') ||
      typeof value.id !== 'string' ||
      !value.id.trim()
    )
      return null
    return {
      ...normalizeAccountBase(value),
      type: 'oauth',
      corrupt: true,
    }
  }

  return {
    ...normalizeAccountBase(value),
    type: 'oauth',
    access: typeof value.access === 'string' ? value.access : undefined,
    refresh: value.refresh,
    expires: typeof value.expires === 'number' ? value.expires : undefined,
    lastRefreshedAt:
      typeof value.lastRefreshedAt === 'number'
        ? value.lastRefreshedAt
        : undefined,
    lastRefreshError: normalizeOperationError(value.lastRefreshError),
    lastQuotaRefreshError: normalizeOperationError(value.lastQuotaRefreshError),
    quota: normalizeQuota(value.quota),
  }
}

function normalizeResetState(value: unknown): ResetStateByAccount | undefined {
  if (!isRecord(value)) return undefined

  const normalized = Object.create(null) as ResetStateByAccount
  for (const [accountId, candidate] of Object.entries(value)) {
    if (!isSafeResetAccountKey(accountId) || !isRecord(candidate)) continue

    const state: ResetAccountState = {}
    if (isRecord(candidate.inFlight)) {
      state.inFlight = { ...candidate.inFlight }
    }
    if (
      isRecord(candidate.lastOutcome) &&
      typeof candidate.lastOutcome.code === 'string' &&
      candidate.lastOutcome.code.length > 0 &&
      typeof candidate.lastOutcome.at === 'number' &&
      Number.isFinite(candidate.lastOutcome.at)
    ) {
      state.lastOutcome = {
        code: candidate.lastOutcome.code,
        at: candidate.lastOutcome.at,
        ...(isRecord(candidate.lastOutcome.previousOutcome) &&
        typeof candidate.lastOutcome.previousOutcome.code === 'string' &&
        candidate.lastOutcome.previousOutcome.code.length > 0 &&
        typeof candidate.lastOutcome.previousOutcome.at === 'number' &&
        Number.isFinite(candidate.lastOutcome.previousOutcome.at)
          ? {
              previousOutcome: {
                code: candidate.lastOutcome.previousOutcome.code,
                at: candidate.lastOutcome.previousOutcome.at,
              },
            }
          : {}),
      }
    }
    if (
      typeof candidate.cooldownUntil === 'number' &&
      Number.isFinite(candidate.cooldownUntil)
    ) {
      state.cooldownUntil = candidate.cooldownUntil
    }

    if (Object.keys(state).length > 0) normalized[accountId] = state
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

// Module-level dedup of the load-dropped-entries WARN. The preserve
// invariant keeps broken entries on disk indefinitely — every
// loadAccounts, every main-refresh tick — so logging the same drop set on
// every call is spam by construction. The first occurrence stays loud;
// identical repeats are suppressed; a change in the drop set (any new
// id appearing, an id being fixed and gone) yields a new key and re-warns.
//
// Dedup key: sorted, comma-joined ids. The set grows monotonically within
// the process; there is no reset. If the same logical drop recurs after
// a process restart it will re-warn — which is the desired behaviour
// because the operator opens a fresh log file on restart anyway.
//
// Keyed on the SORTED form so that id-ordering differences (e.g. drop
// set [a,b] vs [b,a] in different writes) deduplicate as the same event.
const warnedRosterDrops = new Set<string>()

function emitRosterDropWarning(droppedIds: readonly string[]): void {
  if (droppedIds.length === 0) return
  // JSON.stringify so id strings that contain a comma can't hash to the
  // same key as a comma-less split of the same characters — e.g.
  // {`a,b`} would join to `a,b`, colliding with {`a`, `b`} on join and
  // silently suppressing the second WARN.
  const key = JSON.stringify([...droppedIds].sort())
  if (warnedRosterDrops.has(key)) return
  warnedRosterDrops.add(key)
  logA.warn('account load-dropped, preserved on disk', {
    droppedIds,
  })
}

function normalizeStorage(value: unknown): AccountStorage | null {
  if (!isRecord(value) || !Array.isArray(value.accounts)) return null
  const inputAccounts = value.accounts
  const normalizedAccounts = inputAccounts
    .map(normalizeAccount)
    .filter((account): account is FallbackAccount => account != null)

  // A silent drop here is what ate a real account: normalizeAccount rejects
  // an oauth entry whose state-side refresh is missing, the next mutateAccounts
  // call writes the filtered roster, and the account is gone with no log. Emit
  // a WARN so any plain read path (loadAccounts) surfaces the same signal a
  // guard on the mutator would. Compare against pre-normalize string-id
  // records only, so an entry that survives normalization with a synthesized
  // id is never flagged as a drop.
  if (normalizedAccounts.length < inputAccounts.length) {
    const inputIds = new Set<string>()
    for (const candidate of inputAccounts) {
      if (
        isRecord(candidate) &&
        typeof candidate.id === 'string' &&
        candidate.id.trim()
      ) {
        inputIds.add(candidate.id.trim())
      }
    }
    const loadedIds = new Set(normalizedAccounts.map((account) => account.id))
    const dropped: string[] = []
    for (const id of inputIds) {
      if (!loadedIds.has(id)) dropped.push(id)
    }
    emitRosterDropWarning(dropped)
  }

  return {
    version: 1,
    main: { type: 'opencode', provider: 'openai' },
    routing: isRecord(value.routing) ? value.routing : undefined,
    fallbackOn: Array.isArray(value.fallbackOn)
      ? value.fallbackOn.filter((status) => Number.isInteger(status))
      : undefined,
    refresh: isRecord(value.refresh) ? value.refresh : undefined,
    quota: isRecord(value.quota) ? value.quota : undefined,
    reset: normalizeResetState(value.reset),
    dump: isRecord(value.dump) ? value.dump : undefined,
    costZeroing: isRecord(value.costZeroing) ? value.costZeroing : undefined,
    killswitch: isRecord(value.killswitch) ? value.killswitch : undefined,
    logging: isRecord(value.logging) ? value.logging : undefined,
    cachekeep: isRecord(value.cachekeep) ? value.cachekeep : undefined,
    mainAccountId:
      typeof value.mainAccountId === 'string' ? value.mainAccountId : undefined,
    claustrum: normalizeClaustrum(value.claustrum),
    accounts: normalizedAccounts,
  }
}

function normalizeClaustrum(value: unknown): AccountStorage['claustrum'] {
  if (!isRecord(value)) return undefined
  const mode = value.mode === 'claustrum' ? 'claustrum' : 'local'
  const transition = normalizeCustodyTransition(value.transition)
  const rowHistory = Array.isArray(value.rowHistory)
    ? value.rowHistory.filter(
        (entry): entry is string => typeof entry === 'string',
      )
    : undefined

  return {
    mode,
    transition,
    rowHistory,
  }
}

function normalizeCustodyTransition(
  value: unknown,
): CustodyTransitionState | undefined {
  if (!isRecord(value) || !isRecord(value.fingerprints)) return undefined
  if (
    typeof value.manifestRevision !== 'string' ||
    typeof value.storeGeneration !== 'string' ||
    !isRecord(value.fingerprints.fallbacks)
  ) {
    return undefined
  }
  const fallbacks = Object.fromEntries(
    Object.entries(value.fingerprints.fallbacks).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
  return {
    manifestRevision: value.manifestRevision,
    storeGeneration: value.storeGeneration,
    fingerprints: {
      main:
        typeof value.fingerprints.main === 'string'
          ? value.fingerprints.main
          : undefined,
      fallbacks,
    },
  }
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises'

async function readJsonIfPresent(path: string): Promise<{
  exists: boolean
  value: unknown
}> {
  try {
    return { exists: true, value: JSON.parse(await readFile(path, 'utf8')) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, value: null }
    }
    // Any other error (JSON parse failure, EACCES, etc.) must surface so
    // corruption or permission problems are not silently clobbered.
    throw error
  }
}

function objectWithDefinedEntries(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  )
}

/**
 * The set of account ids present in the CONFIG file (the authoritative account
 * roster). Returns null when the config is absent or unreadable/malformed, so
 * callers can fall back to non-pruning behavior rather than risk wiping live
 * state. The config never holds secrets (see accountConfig), so reading it here
 * is safe. Reads are lock-free but the file is written atomically, so a
 * concurrent write is seen as either the complete old or complete new file.
 *
 * Trims and skips blank ids per the rule in collectConfigRosterIds above.
 */
export async function readConfigRosterIds(
  path: string,
): Promise<Set<string> | null> {
  return (await readConfigRosterAndMode(path)).roster
}

async function readConfigRosterAndMode(path: string): Promise<{
  roster: Set<string> | null
  mode: ClaustrumMode
}> {
  let value: unknown
  try {
    value = (await readJsonIfPresent(path)).value
  } catch {
    return { roster: null, mode: 'claustrum' }
  }
  return {
    roster: collectConfigRosterIds(value),
    mode: claustrumMode(isRecord(value) ? value : undefined),
  }
}

function mergeConfigAndState(
  configValue: unknown,
  stateValue: unknown,
): unknown {
  if (!isRecord(configValue)) return configValue
  const state = isRecord(stateValue) ? stateValue : {}
  const mainState = isRecord(state.main) ? state.main : undefined
  const stateAccounts = isRecord(state.accounts) ? state.accounts : {}

  const quotaConfig = isRecord(configValue.quota) ? configValue.quota : {}
  const refreshConfig = isRecord(configValue.refresh) ? configValue.refresh : {}
  const mainQuotaSource = mainState ?? quotaConfig
  const mainRefreshSource = mainState ?? refreshConfig

  const hasAccounts = Array.isArray(configValue.accounts)
  const accounts = hasAccounts
    ? (configValue.accounts as unknown[]).map((account) => {
        if (!isRecord(account)) return account
        const stateAccount: Record<string, unknown> =
          typeof account.id === 'string' && isRecord(stateAccounts[account.id])
            ? (stateAccounts[account.id] as Record<string, unknown>)
            : {}
        return { ...account, ...stateAccount }
      })
    : undefined

  return omitUndefinedTopLevel({
    ...configValue,
    refresh: objectWithDefinedEntries({
      ...refreshConfig,
      mainLastRefreshError: mainRefreshSource.lastRefreshError,
      mainRefreshLeaseId: mainRefreshSource.refreshLeaseId,
      mainRefreshLeaseUntil: mainRefreshSource.refreshLeaseUntil,
      mainRefreshLeaseTokenHash: mainRefreshSource.refreshLeaseTokenHash,
    }),
    quota: objectWithDefinedEntries({
      ...quotaConfig,
      mainQuota: mainQuotaSource.quota,
      mainQuotaCheckedAt: mainQuotaSource.quotaCheckedAt,
      mainQuotaToken: mainQuotaSource.quotaToken,
      mainLastQuotaApiError: mainQuotaSource.lastQuotaApiError,
    }),
    accounts,
  })
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

export async function loadAccounts(paths: AccountPaths) {
  const config = await readJsonIfPresent(paths.configPath)
  if (!config.exists) return null
  const state = await readJsonIfPresent(paths.statePath)
  return normalizeStorage(mergeConfigAndState(config.value, state.value))
}

function omitUndefinedTopLevel(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  )
}

function accountConfig(account: FallbackAccount) {
  return objectWithDefinedEntries({
    id: account.id,
    label: account.label,
    type: account.type,
    corrupt:
      account.type === 'oauth' && account.corrupt === true ? true : undefined,
    enabled: account.enabled,
    addedAt: account.addedAt,
    accountId: account.accountId,
    baseURL: account.type === 'api' ? account.baseURL : undefined,
    authHeader: account.type === 'api' ? account.authHeader : undefined,
  })
}

function accountRuntimeState(account: FallbackAccount) {
  if (account.type === 'api') {
    return objectWithDefinedEntries({
      apiKey: account.apiKey,
      lastUsed: account.lastUsed,
    })
  }
  if (account.corrupt) return {}
  return objectWithDefinedEntries({
    access: account.access,
    refresh: account.refresh,
    expires: account.expires,
    lastUsed: account.lastUsed,
    lastRefreshedAt: account.lastRefreshedAt,
    lastRefreshError: account.lastRefreshError,
    lastQuotaRefreshError: account.lastQuotaRefreshError,
    quota: account.quota,
  })
}

function quotaSnapshotCheckedAt(quota: OAuthQuotaSnapshot | undefined) {
  return Math.max(
    quota?.primary?.checkedAt ?? 0,
    quota?.secondary?.checkedAt ?? 0,
  )
}

function copyRuntimeField<K extends keyof AccountRuntimeEntry>(
  target: AccountRuntimeEntry,
  source: AccountRuntimeEntry,
  key: K,
) {
  if (key in source) {
    target[key] = source[key]
  } else {
    delete target[key]
  }
}

function tokenFieldsMatch(
  existing: AccountRuntimeEntry,
  incoming: AccountRuntimeEntry,
) {
  return (
    existing.access === incoming.access &&
    existing.refresh === incoming.refresh &&
    existing.expires === incoming.expires &&
    existing.lastRefreshedAt === incoming.lastRefreshedAt
  )
}

function selectSameTokenState(
  existing: AccountRuntimeEntry,
  incoming: AccountRuntimeEntry,
) {
  if (!tokenFieldsMatch(existing, incoming)) return incoming
  if (!('lastRefreshError' in incoming)) return existing
  if (!('lastRefreshError' in existing)) return incoming
  return (incoming.lastRefreshError?.checkedAt ?? 0) >
    (existing.lastRefreshError?.checkedAt ?? 0)
    ? incoming
    : existing
}

// How far ahead of the local clock a lastRefreshedAt may sit and still be
// trusted. Small skew is normal (a clock slewed or stepped back slightly after
// another process wrote), and distrusting it would be dangerous: a stale save
// could then beat a just-rotated token and roll back its refresh token.
const FUTURE_REFRESH_STAMP_TOLERANCE_MS = 5 * 60_000

/**
 * lastRefreshedAt comes from the writer's clock, so it can sit far in the
 * future: a clock that ran ahead and was corrected, or a state file restored
 * from another machine. Taken at face value, such a stamp beats every genuine
 * refresh until the wall clock catches up, keeping an expired token and
 * discarding each new one. A stamp that far ahead says nothing reliable about
 * when the token was minted, so it counts as absent and the comparison falls
 * through to the other side's stamp, then to expires.
 */
function trustedRefreshStamp(stamp: number | undefined, now: number): number {
  if (stamp === undefined) return 0
  return stamp > now + FUTURE_REFRESH_STAMP_TOLERANCE_MS ? 0 : stamp
}

function applyNewerTokenState(
  merged: AccountRuntimeEntry,
  existing: AccountRuntimeEntry,
  incoming: AccountRuntimeEntry,
) {
  const now = Date.now()
  const existingRefreshAt = trustedRefreshStamp(existing.lastRefreshedAt, now)
  const incomingRefreshAt = trustedRefreshStamp(incoming.lastRefreshedAt, now)
  const existingExpires = existing.expires ?? 0
  const incomingExpires = incoming.expires ?? 0
  const tokenSource =
    incomingRefreshAt > existingRefreshAt
      ? incoming
      : existingRefreshAt > incomingRefreshAt
        ? existing
        : incomingExpires > existingExpires
          ? incoming
          : existingExpires > incomingExpires
            ? existing
            : selectSameTokenState(existing, incoming)

  copyRuntimeField(merged, tokenSource, 'access')
  copyRuntimeField(merged, tokenSource, 'refresh')
  copyRuntimeField(merged, tokenSource, 'expires')
  copyRuntimeField(merged, tokenSource, 'lastRefreshedAt')
  copyRuntimeField(merged, tokenSource, 'lastRefreshError')
}

function mergeAccountRuntimeState(
  existing: unknown,
  incoming: AccountRuntimeEntry,
  mode: ClaustrumMode,
): AccountRuntimeEntry {
  if (!isRecord(existing)) return incoming
  const existingEntry = existing as AccountRuntimeEntry
  const existingQuotaCheckedAt = quotaSnapshotCheckedAt(existingEntry.quota)
  const incomingQuotaCheckedAt = quotaSnapshotCheckedAt(incoming.quota)
  const existingQuotaIsNewer = existingQuotaCheckedAt > incomingQuotaCheckedAt
  const merged: AccountRuntimeEntry = existingQuotaIsNewer
    ? {
        ...existingEntry,
        ...incoming,
        quota: existingEntry.quota,
        lastQuotaRefreshError: existingEntry.lastQuotaRefreshError,
      }
    : { ...existingEntry, ...incoming }

  if (!existingQuotaIsNewer && !('lastQuotaRefreshError' in incoming)) {
    delete merged.lastQuotaRefreshError
  }
  if (!('lastRefreshError' in incoming)) {
    delete merged.lastRefreshError
  }
  if (
    typeof existingEntry.lastUsed === 'number' &&
    (!(typeof incoming.lastUsed === 'number') ||
      existingEntry.lastUsed > incoming.lastUsed)
  ) {
    merged.lastUsed = existingEntry.lastUsed
  }

  applyNewerTokenState(merged, existingEntry, incoming)
  if (
    mode === 'claustrum' &&
    // State persistence has no manager instance; the manifest's owning provider
    // is the fixed tenant boundary at this layer.
    existingEntry.refresh === custodyTombstoneKey(CUSTODY_OWNING_PROVIDER) &&
    incoming.refresh !== custodyTombstoneKey(CUSTODY_OWNING_PROVIDER)
  ) {
    copyRuntimeField(merged, existingEntry, 'access')
    copyRuntimeField(merged, existingEntry, 'refresh')
    copyRuntimeField(merged, existingEntry, 'expires')
    logA.warn('discarded stale credential write over a custody tombstone')
  }
  return merged
}

function configFromStorage(storage: AccountStorage): Record<string, unknown> {
  const refresh = storage.refresh
    ? objectWithDefinedEntries({
        enabled: storage.refresh.enabled,
        refreshBeforeExpiryMinutes: storage.refresh.refreshBeforeExpiryMinutes,
      })
    : undefined
  const quota = storage.quota
    ? objectWithDefinedEntries({
        enabled: storage.quota.enabled,
        checkIntervalMinutes: storage.quota.checkIntervalMinutes,
        refreshEveryNRequests: storage.quota.refreshEveryNRequests,
        minimumRemaining: storage.quota.minimumRemaining,
        failClosedOnUnknownQuota: storage.quota.failClosedOnUnknownQuota,
      })
    : undefined

  return omitUndefinedTopLevel({
    version: 1,
    main: storage.main,
    routing: storage.routing,
    fallbackOn: storage.fallbackOn,
    refresh,
    quota,
    reset: storage.reset,
    dump: storage.dump,
    costZeroing: storage.costZeroing,
    killswitch: storage.killswitch,
    logging: storage.logging,
    cachekeep: storage.cachekeep,
    mainAccountId: storage.mainAccountId,
    ...(storage.claustrum !== undefined
      ? {
          claustrum: {
            mode: storage.claustrum.mode ?? 'local',
            ...(storage.claustrum.transition
              ? { transition: storage.claustrum.transition }
              : {}),
            ...(storage.claustrum.rowHistory
              ? { rowHistory: storage.claustrum.rowHistory }
              : {}),
          },
        }
      : {}),
    accounts: storage.accounts.map(accountConfig),
  })
}

function mergeStorageForSave(
  latest: AccountStorage | null,
  incoming: AccountStorage,
): AccountStorage {
  if (!latest) return incoming

  const accounts = new Map<string, FallbackAccount>()
  for (const account of latest.accounts) accounts.set(account.id, account)
  for (const account of incoming.accounts) accounts.set(account.id, account)

  return {
    ...latest,
    ...incoming,
    accounts: [...accounts.values()],
  }
}

async function acquireSaveAccountsLock(
  path: string,
  renew = false,
  onContended?: (path: string) => void,
) {
  const startedAt = Date.now()
  const deadline = startedAt + SAVE_ACCOUNTS_LOCK_WAIT_MS
  let attempts = 0
  while (Date.now() <= deadline) {
    attempts++
    const lock = await acquireRefreshFileLock({
      name: 'save',
      ttlMs: SAVE_ACCOUNTS_LOCK_TTL_MS,
      path,
      renew,
      onContended: () => onContended?.(path),
    })
    if (lock) return lock

    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    // Jitter the poll so a burst of same-process acquirers does not resynchronize
    // into lockstep retries against the same instant.
    await sleep(
      Math.min(
        SAVE_ACCOUNTS_LOCK_RETRY_MS + jitterMs(SAVE_ACCOUNTS_LOCK_RETRY_MS),
        remainingMs,
      ),
    )
  }

  // Report attempts and the average gap between them, because they distinguish
  // two failures that look identical from the outside and need opposite fixes.
  //
  // This loop polls on a WALL-CLOCK deadline while its own progress is scheduled
  // by the event loop. Every session in this host process shares that loop, so
  // when they are streaming, a scheduled retry lands hundreds of ms late. The
  // wait then expires having barely tried, whether or not the lock was ever
  // busy. Measured: ~48 concurrent writers on a responsive loop peak under 0.9s
  // and never time out, while 12 writers on a saturated one fail routinely.
  //
  // So a gap near the retry interval means real contention: the loop was
  // responsive and other writers genuinely held the lock. A gap far above it
  // means starvation, and the lock may well have been free most of the window.
  // Do not claim a holder here — the timeout alone is not evidence of one.
  const elapsedMs = Date.now() - startedAt
  const averageGapMs = Math.round(elapsedMs / Math.max(1, attempts))
  throw new Error(
    `Timed out after ${elapsedMs}ms waiting for the account store lock on ${path} ` +
      `(${attempts} attempts, ~${averageGapMs}ms apart; retry interval is ` +
      `${SAVE_ACCOUNTS_LOCK_RETRY_MS}ms). A gap near the retry interval means ` +
      `lock contention; a much larger one means this process's event loop was ` +
      `saturated and the wait expired without getting scheduled.`,
  )
}

export function claustrumMode(
  storage: Pick<AccountStorage, 'claustrum'> | null | undefined,
): ClaustrumMode {
  return storage?.claustrum?.mode === 'claustrum' ? 'claustrum' : 'local'
}

export type AccountStoreTransaction = {
  read(): Promise<AccountStorage>
  write(storage: AccountStorage): Promise<void>
  writeMode(
    mode: ClaustrumMode,
    transition?: CustodyTransitionState,
  ): Promise<void>
}

export async function withAccountStoreTransaction<T>(
  action: (transaction: AccountStoreTransaction) => Promise<T>,
  paths: AccountPaths,
): Promise<T> {
  const { configPath: path, statePath } = paths
  const lock = await acquireSaveAccountsLock(path, true)
  try {
    const stateLock = await acquireSaveAccountsLock(statePath, true)
    try {
      const configJson = await readJsonIfPresent(path)
      const stateJson = await readJsonIfPresent(statePath)
      let current =
        (configJson.exists
          ? normalizeStorage(
              mergeConfigAndState(configJson.value, stateJson.value),
            )
          : null) ?? emptyAccountStorage()
      const currentAccountIds = new Set(
        current.accounts.map((account) => account.id),
      )

      const write = async (next: AccountStorage) => {
        const baseConfig = configFromStorage(next)
        const preserved = buildPreservedAdditions(
          configJson.value,
          currentAccountIds,
          new Set(),
        )
        const writtenIds = new Set(
          (Array.isArray(baseConfig.accounts) ? baseConfig.accounts : [])
            .map((entry) =>
              isRecord(entry) && typeof entry.id === 'string'
                ? entry.id.trim()
                : '',
            )
            .filter(Boolean),
        )
        const additions = preserved.filter(
          (entry) =>
            isRecord(entry) &&
            typeof entry.id === 'string' &&
            !writtenIds.has(entry.id.trim()),
        )
        const existing = isRecord(configJson.value) ? configJson.value : {}
        const nextConfig = {
          ...existing,
          ...baseConfig,
          accounts: [
            ...(Array.isArray(baseConfig.accounts) ? baseConfig.accounts : []),
            ...additions,
          ],
        }
        await writeJsonAtomic(path, nextConfig)
        await writeJsonAtomic(statePath, stateFromStorage(next))
        configJson.value = nextConfig
        current = structuredClone(next)
      }

      const writeMode = async (
        mode: ClaustrumMode,
        transition?: CustodyTransitionState,
      ) => {
        const existing = isRecord(configJson.value)
          ? configJson.value
          : { version: 1, accounts: [] }
        const existingClaustrum = isRecord(existing.claustrum)
          ? existing.claustrum
          : {}
        const rowHistory = Array.isArray(existingClaustrum.rowHistory)
          ? existingClaustrum.rowHistory.filter(
              (entry): entry is string => typeof entry === 'string',
            )
          : undefined
        const claustrum = {
          mode,
          ...(mode === 'claustrum' && transition ? { transition } : {}),
          ...(rowHistory ? { rowHistory } : {}),
        }
        const nextConfig = { ...existing, claustrum }
        await writeJsonAtomic(path, nextConfig)
        configJson.value = nextConfig
        current = {
          ...current,
          claustrum: {
            mode,
            ...(mode === 'claustrum' && transition ? { transition } : {}),
            ...(rowHistory ? { rowHistory } : {}),
          },
        }
      }

      return await action({
        read: async () => structuredClone(current),
        write,
        writeMode,
      })
    } finally {
      await stateLock.release()
    }
  } finally {
    await lock.release()
  }
}

export async function writeClaustrumModeAndTransition(
  paths: AccountPaths,
  mode: ClaustrumMode,
  transition?: CustodyTransitionState,
): Promise<void> {
  await withAccountStoreTransaction(
    (transaction) => transaction.writeMode(mode, transition),
    paths,
  )
}

function stateFromStorage(storage: AccountStorage): AccountRuntimeState {
  const accounts = Object.fromEntries(
    storage.accounts.map((account) => [
      account.id,
      accountRuntimeState(account),
    ]),
  )
  return {
    version: 1,
    main: objectWithDefinedEntries({
      quota: storage.quota?.mainQuota,
      quotaCheckedAt: storage.quota?.mainQuotaCheckedAt,
      quotaToken: storage.quota?.mainQuotaToken,
      lastQuotaApiError: storage.quota?.mainLastQuotaApiError,
      lastRefreshError: storage.refresh?.mainLastRefreshError,
      refreshLeaseId: storage.refresh?.mainRefreshLeaseId,
      refreshLeaseUntil: storage.refresh?.mainRefreshLeaseUntil,
      refreshLeaseTokenHash: storage.refresh?.mainRefreshLeaseTokenHash,
    }),
    accounts,
  }
}

export async function saveAccounts(
  storage: AccountStorage,
  paths: AccountPaths,
) {
  const path = paths.configPath
  // Serialize concurrent read-modify-write to prevent lost updates when
  // the CLI and a TUI command (or two commands) modify the store at once.
  //
  // Lock acquisition order: config-lock (outer) → state-lock (inner).
  // saveAccountState takes ONLY the state lock, so the order is always
  // config→state or state-only — no deadlock cycle.
  //
  // The state-lock is acquired BEFORE the state-file read so that the
  // read→write on the state file is atomic with respect to concurrent
  // saveAccountState callers. Without this, a concurrent saveAccountState
  // could write the state file in the window after saveAccounts read it
  // but before saveAccounts re-wrote it, producing a lost update.
  //
  // The caller supplies the state path, so the lock target and the write target
  // are identical within this call and consistent with every other state-file
  // accessor (loadAccounts, saveAccountState, migrate all take the same pair).
  const statePath = paths.statePath
  const lock = await acquireSaveAccountsLock(path)
  try {
    const stateLock = await acquireSaveAccountsLock(statePath)
    try {
      // Read the config file (not under state-lock — config-lock covers it).
      const configJson = await readJsonIfPresent(path)
      // Read the state file under the state-lock so no concurrent
      // saveAccountState can interleave between this read and our write.
      const stateJson = await readJsonIfPresent(statePath)
      const latest = configJson.exists
        ? normalizeStorage(
            mergeConfigAndState(configJson.value, stateJson.value),
          )
        : null
      const merged = mergeStorageForSave(latest, storage)
      const existing = isRecord(configJson.value) ? configJson.value : {}

      // Preserve load-dropped raw entries — shared pipeline with mutateAccounts
      // (no allowDrop seam here; this writer has no caller-driven removal
      // intent). The WARN lives on the shared helper. `latestAccountIds`
      // is the loaded (post-normalize) set: an id that survived the load
      // is NOT actually load-dropped and must not be re-appended as a raw
      // entry. `latest` can be null (no config file); in that case the
      // loaded set is empty and the emitted set is whatever the caller's
      // `storage` arg carries — which is fine because there is no raw
      // config to preserve from.
      const latestAccountIds = latest
        ? new Set(latest.accounts.map((a) => a.id))
        : new Set<string>()
      const preserved = buildPreservedAdditions(
        configJson.value,
        latestAccountIds,
        new Set(),
      )
      // Drop preserved entries whose ids the writer is already emitting via
      // the serialized output. trim() on both sides matches collectConfigRosterIds
      // and guards against whitespace-padded raw entries duplicating
      // already-trimmed serialized ids.
      const baseConfig = configFromStorage(merged)
      const writtenIds = new Set(
        (Array.isArray(baseConfig.accounts) ? baseConfig.accounts : [])
          .map((e) =>
            isRecord(e) && typeof e.id === 'string' ? e.id.trim() : '',
          )
          .filter(Boolean),
      )
      const additions = preserved.filter((raw) => {
        if (!isRecord(raw)) return false
        if (typeof raw.id !== 'string') return false
        return !writtenIds.has(raw.id.trim())
      })

      const nextConfig = {
        ...existing,
        ...baseConfig,
        accounts: [
          ...(Array.isArray(baseConfig.accounts) ? baseConfig.accounts : []),
          ...additions,
        ],
      }
      await writeJsonAtomic(path, nextConfig)
      await writeJsonAtomic(statePath, stateFromStorage(merged))
    } finally {
      await stateLock.release()
    }
  } finally {
    await lock.release()
  }
}

/**
 * Collects account ids from a parsed config value. Returns null when the
 * value is not a record or has no accounts array — callers should treat null
 * as "no roster to compare against" rather than an empty roster, since a
 * missing array is structurally different from an empty one (it implies the
 * user has never written a roster, not that they wrote an empty one).
 *
 * Roster rule (aligned with normalizeAccountBase above): an
 * entry counts as a roster member only when its `id` is a string with at
 * least one non-whitespace character. Non-record entries, entries whose id
 * is not a string, entries with a non-string id (number, boolean, null),
 * and entries with a blank/whitespace-only id are NOT in the roster.
 * `normalizeAccountBase` would synthesize a `randomUUID()` for any of those
 * cases — those synthesized ids are not authoritative and must never be
 * treated as load-dropped. Storing the trimmed form (rather than the raw
 * bytes) means downstream comparisons against `current.accounts.map(a=>a.id)`
 * (whose ids are already trimmed by normalizeAccountBase) match.
 */
function collectConfigRosterIds(value: unknown): Set<string> | null {
  if (!isRecord(value) || !Array.isArray(value.accounts)) return null
  const ids = new Set<string>()
  for (const account of value.accounts) {
    if (!isRecord(account)) continue
    if (typeof account.id !== 'string') continue
    const trimmed = account.id.trim()
    if (!trimmed) continue
    ids.add(trimmed)
  }
  return ids
}

/**
 * Picks the raw entries that should be preserved on a config write because
 * normalizeAccount rejected them. A load-dropped raw entry (its id is in
 * `rawIds` but not in `currentAccountIds`) is preserved verbatim from
 * `rawValue.accounts` so the next write cannot silently erase it. Ids in
 * `allowDrop` are not preserved — the caller is deliberately removing them.
 * The comparison is against `currentAccountIds` (the pre-mutator loaded
 * roster) so a legitimate removal by a mutator is NOT preserved back.
 *
 * Returns the raw entries in raw-file order (the order they appear in
 * `rawValue.accounts`); preserved entries are appended to the end of
 * nextConfig.accounts after the normalized ones.
 *
 * Credentials (e.g. a config-inline `refresh`) on a preserved raw entry
 * are NOT stripped before the write. Why: mergeConfigAndState spreads the
 * state entry over the config entry, so a refresh living only in the
 * config file is load-bearing — an account whose only token copy sits in
 * the config loads fine today. Stripping credentials here would convert a
 * recoverable account into a permanently dead one — the same argument that
 * makes preserve beat refuse-to-write, one layer down.
 */
function pickRawRosterEntriesForPreservation(
  rawValue: unknown,
  rawIds: Set<string>,
  currentAccountIds: Set<string>,
  allowDrop: Set<string>,
): {
  preservedRawEntries: Array<Record<string, unknown>>
  preservedIds: string[]
} {
  if (!isRecord(rawValue) || !Array.isArray(rawValue.accounts)) {
    return { preservedRawEntries: [], preservedIds: [] }
  }
  const preservedRawEntries: Array<Record<string, unknown>> = []
  const preservedIds: string[] = []
  for (const id of rawIds) {
    if (currentAccountIds.has(id)) continue
    if (allowDrop.has(id)) continue
    const rawEntry = rawValue.accounts.find(
      (acc): acc is Record<string, unknown> =>
        isRecord(acc) && typeof acc.id === 'string' && acc.id.trim() === id,
    )
    if (!rawEntry) continue
    preservedRawEntries.push(rawEntry)
    preservedIds.push(id)
  }
  return { preservedRawEntries, preservedIds }
}

/**
 * Walks a list of mixed-shape config entries (some are normalized account
 * configs, some are raw preserved entries passed through verbatim) and
 * collects the string ids. Used for the write-debug log so the
 * diagnostic surface reflects what landed on disk rather than what the
 * mutator returned.
 */
function collectStringIds(entries: unknown): string[] {
  if (!Array.isArray(entries)) return []
  const ids: string[] = []
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    if (typeof entry.id !== 'string') continue
    ids.push(entry.id)
  }
  return ids
}

/**
 * Returns the raw config entries that survived load-time rejection so a
 * subsequent writer can carry them back to disk verbatim instead of
 * silently erasing them. The WARN is emitted here (dedup'd by
 * emitRosterDropWarning) so the load-drop signal lives in one place —
 * the alternative (each writer owning its own iteration logic) is
 * drift-prone by construction: the next invariant change would land
 * on one writer only.
 *
 * `loadedIds` answers the load-side question: what ids survived
 * normalization? An id in that set is not actually load-dropped and
 * must not be preserved as a raw entry.
 *
 * The writer-side question — is this id already being emitted in the
 * caller's serialized output? — is the call site's responsibility. It
 * sees its own output (`configFromStorage(next)` for mutateAccounts,
 * `configFromStorage(merged)` for saveAccounts) and applies the dedup
 * filter there, with `id.trim()` on both sides. The split exists
 * because the helper has no view into the writer's specific output
 * and the trim must match `collectConfigRosterIds` on the load side.
 */
function buildPreservedAdditions(
  rawConfigValue: unknown,
  loadedIds: Set<string>,
  allowDrop: Set<string>,
): Array<Record<string, unknown>> {
  const rawIds = collectConfigRosterIds(rawConfigValue)
  if (rawIds === null) return []
  const { preservedRawEntries, preservedIds } =
    pickRawRosterEntriesForPreservation(
      rawConfigValue,
      rawIds,
      loadedIds,
      allowDrop,
    )
  emitRosterDropWarning(preservedIds)
  return preservedRawEntries
}

/**
 * Read-modify-write the account store atomically under the save lock.
 *
 * Unlike saveAccounts (which UNION-merges the incoming accounts with the latest
 * on-disk set so concurrent ADDS from another process are never lost), this
 * reads the freshest state under the lock and writes the mutator's result
 * AUTHORITATIVELY — no union. That is required for structural edits (remove,
 * reorder): a union cannot express a deletion (the removed id reappears from
 * `latest`) or a reordering (the union is seeded latest-first). Because the
 * mutator runs against freshly-read state under the lock, an add committed by a
 * concurrent process is still visible to it and preserved.
 *
 * The mutator may edit `current` in place and return it, or return a new
 * storage object. Returning undefined means "no change" and still rewrites the
 * freshly-read state (a harmless idempotent write).
 *
 * Load-time drop preservation: if normalizeAccount (called inside
 * normalizeStorage) rejects an account whose id IS in the raw config roster,
 * the previous behavior would erase that id silently on the next write. This
 * function now carries the dropped raw entry through to the written config
 * verbatim, so the on-disk state always matches the operator's intent (an
 * account they added, even if temporarily un-loadable, stays in their list
 * until they deliberately remove it).
 *
 * Removal seam: when the caller knows they are removing an id (e.g. the CLI
 * `remove` command) and that id may be load-dropped — in which case the
 * mutator cannot find it in `current.accounts` to splice it — the caller can
 * pass `options.allowDrop: [id]`. Ids in `allowDrop` are NOT preserved; the
 * mutator's splice still no-ops on a dropped id, but the absence of
 * preservation completes the removal end-to-end.
 */
interface MutateAccountsContext {
  /** Valid string ids read from the raw config while both store locks are held. */
  rawRosterIds: readonly string[]
  /** Ids retained after normalization and validation, before the mutator ran. */
  loadedRosterIds: readonly string[]
}

export async function mutateAccounts(
  mutate: (
    current: AccountStorage,
    context?: MutateAccountsContext,
  ) => AccountStorage | undefined,
  paths: AccountPaths,
  options: {
    allowDrop?: readonly string[]
    onContended?: (path: string) => void
  } = {},
): Promise<AccountStorage> {
  const path = paths.configPath
  const statePath = paths.statePath
  const lock = await acquireSaveAccountsLock(path, false, options.onContended)
  try {
    const stateLock = await acquireSaveAccountsLock(
      statePath,
      false,
      options.onContended,
    )
    try {
      const configJson = await readJsonIfPresent(path)
      const stateJson = await readJsonIfPresent(statePath)
      const current =
        (configJson.exists
          ? normalizeStorage(
              mergeConfigAndState(configJson.value, stateJson.value),
            )
          : null) ?? emptyAccountStorage()

      // Snapshot the pre-mutator account ids BEFORE running the mutator:
      // the mutator may edit `current.accounts` in place, so reading
      // current.accounts afterwards would observe the mutated set, not the
      // loaded one — and a legitimate removal by the mutator would look
      // identical to a load-time drop.
      // Snapshot the pre-mutator account ids BEFORE running the mutator:
      // the mutator may edit `current.accounts` in place, so reading
      // current.accounts afterwards would observe the mutated set, not the
      // loaded one — and a legitimate removal by the mutator would look
      // identical to a load-time drop.
      const currentAccountIds = new Set(current.accounts.map((a) => a.id))
      const rawRosterIds = collectConfigRosterIds(configJson.value) ?? new Set()
      const next =
        mutate(current, {
          rawRosterIds: [...rawRosterIds],
          loadedRosterIds: [...currentAccountIds],
        }) ?? current
      const nextAccountIds = new Set(next.accounts.map((account) => account.id))
      const removedIds = [...currentAccountIds].filter(
        (accountId) => !nextAccountIds.has(accountId),
      )
      if (removedIds.length > 0) {
        next.claustrum = {
          ...next.claustrum,
          mode: next.claustrum?.mode ?? 'local',
          rowHistory: [
            ...new Set([...(next.claustrum?.rowHistory ?? []), ...removedIds]),
          ],
        }
      }

      // Preserve load-dropped raw entries via the shared pipeline. The
      // comparison is against `currentAccountIds` (pre-mutator) so a
      // legitimate removal by the mutator is NOT preserved back onto disk
      // — if it was in current.accounts, normalizeAccount accepted it and
      // there is no load-time drop to preserve.
      const allowDrop = new Set(options.allowDrop ?? [])
      const preserved = buildPreservedAdditions(
        configJson.value,
        currentAccountIds,
        allowDrop,
      )
      // Drop preserved entries whose ids the mutator is already emitting in
      // normalized form via baseConfig.accounts — the live example is a
      // re-login: the mutator pushes a fresh entry for an id whose state
      // entry was missing, and a stale raw entry for the same id must
      // NOT be appended alongside it (round-4 had this regression). trim()
      // on both sides matches collectConfigRosterIds so a whitespace-
      // padded raw id doesn't sneak past the comparison.
      const baseConfig = configFromStorage(next)
      const writtenIds = new Set(
        (Array.isArray(baseConfig.accounts) ? baseConfig.accounts : [])
          .map((e) =>
            isRecord(e) && typeof e.id === 'string' ? e.id.trim() : '',
          )
          .filter(Boolean),
      )
      const additions = preserved.filter((raw) => {
        if (!isRecord(raw)) return false
        if (typeof raw.id !== 'string') return false
        return !writtenIds.has(raw.id.trim())
      })

      const existing = isRecord(configJson.value) ? configJson.value : {}
      const nextConfig = {
        ...existing,
        ...baseConfig,
        accounts: [
          ...(Array.isArray(baseConfig.accounts) ? baseConfig.accounts : []),
          ...additions,
        ],
      }
      await writeJsonAtomic(path, nextConfig)
      await writeJsonAtomic(statePath, stateFromStorage(next))
      // Log the actual written roster (nextConfig.accounts), not the
      // mutator's output (next.accounts). next.accounts omits preserved
      // entries — which this log was created specifically to surface — so
      // logging it here would defeat the post-incident forensic use.
      logA.debug('account config written', {
        accountCount: nextConfig.accounts.length,
        accountIds: collectStringIds(nextConfig.accounts),
      })
      return next
    } finally {
      await stateLock.release()
    }
  } finally {
    await lock.release()
  }
}

function emptyAccountStorage(): AccountStorage {
  return {
    version: 1,
    main: { type: 'opencode', provider: 'openai' },
    accounts: [],
  }
}

function applyMainQuotaStatePatch(
  state: AccountRuntimeState,
  storage: AccountStorage,
) {
  state.main = state.main ?? {}
  const existingCheckedAt =
    typeof state.main.quotaCheckedAt === 'number'
      ? state.main.quotaCheckedAt
      : quotaSnapshotCheckedAt(state.main.quota)
  const incomingCheckedAt =
    typeof storage.quota?.mainQuotaCheckedAt === 'number'
      ? storage.quota.mainQuotaCheckedAt
      : quotaSnapshotCheckedAt(storage.quota?.mainQuota)
  if (existingCheckedAt > incomingCheckedAt) return

  state.main.quota = storage.quota?.mainQuota
  state.main.quotaCheckedAt = storage.quota?.mainQuotaCheckedAt
  state.main.quotaToken = storage.quota?.mainQuotaToken
  state.main.lastQuotaApiError = storage.quota?.mainLastQuotaApiError
}

function applyMainRefreshStatePatch(
  state: AccountRuntimeState,
  storage: AccountStorage,
) {
  state.main = state.main ?? {}
  state.main.lastRefreshError = storage.refresh?.mainLastRefreshError
  state.main.refreshLeaseId = storage.refresh?.mainRefreshLeaseId
  state.main.refreshLeaseUntil = storage.refresh?.mainRefreshLeaseUntil
  state.main.refreshLeaseTokenHash = storage.refresh?.mainRefreshLeaseTokenHash
}

function pruneUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruneUndefined)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, pruneUndefined(entry)]),
  )
}

export async function saveAccountState(
  storage: AccountStorage,
  paths: AccountPaths,
  scope: AccountStateSaveScope = {
    mainQuota: true,
    mainRefresh: true,
    accounts: true,
  },
  options: { onContended?: (path: string) => void } = {},
) {
  const statePath = paths.statePath
  // Serialize concurrent read-modify-write on the state file to prevent lost
  // updates when two callers (e.g. quota push + sidebar refresh) race.
  const lock = await acquireSaveAccountsLock(
    statePath,
    false,
    options.onContended,
  )
  try {
    const existing = (await readJsonIfPresent(statePath)).value
    const next: AccountRuntimeState = isRecord(existing)
      ? ({ ...existing, version: 1 } as AccountRuntimeState)
      : { version: 1 }

    if (scope.mainQuota) applyMainQuotaStatePatch(next, storage)
    if (scope.mainRefresh) applyMainRefreshStatePatch(next, storage)

    if (scope.accounts) {
      const ids = scope.accounts === true ? null : new Set(scope.accounts)
      // Authoritative account roster from the CONFIG file (the account list of
      // record). A caller's in-memory `storage` may be stale — e.g. a background
      // refresh holding a snapshot from before a concurrent removal — so gating
      // state writes on the roster prevents re-introducing a removed account's
      // secrets (access/refresh/apiKey) into the state file. Read unlocked: the
      // config is written atomically (temp+rename), so this sees a complete
      // file, and the state lock we hold serializes the state write itself.
      const { roster, mode } = await readConfigRosterAndMode(paths.configPath)
      next.accounts = { ...(isRecord(next.accounts) ? next.accounts : {}) }
      for (const account of storage.accounts) {
        if (ids && !ids.has(account.id)) continue
        // Skip accounts no longer in the roster (removed out from under a stale
        // snapshot). When the roster is unreadable (null) fall back to today's
        // merge-only behavior rather than risk wiping live secrets.
        if (roster && !roster.has(account.id)) continue
        next.accounts[account.id] = mergeAccountRuntimeState(
          next.accounts[account.id],
          accountRuntimeState(account),
          mode,
        )
      }
      if (ids) {
        for (const id of ids) {
          if (!storage.accounts.some((account) => account.id === id)) {
            delete next.accounts[id]
          }
        }
      }
      // Prune orphan state entries whose id is absent from the roster — clears
      // secrets already at rest for a removed account (and closes the
      // mutateAccounts config-then-state crash window on the next state write).
      if (roster) {
        for (const id of Object.keys(next.accounts)) {
          if (!roster.has(id)) delete next.accounts[id]
        }
      }
    }

    await writeJsonAtomic(statePath, pruneUndefined(next))
  } finally {
    await lock.release()
  }
}

// --- accounts.ts lines 2031-2104 ---
/**
 * Content discriminator: an openai-auth.json is recognized as an account store
 * if it contains BOTH a `version` key AND an `accounts` key. Otherwise it is
 * treated as a settings-only config file.
 */
function isAccountStore(value: Record<string, unknown>): boolean {
  return typeof value.version === 'number' && Array.isArray(value.accounts)
}

/**
 * Migrate an existing single-slot token into the multi-account store.
 *
 * Reads the existing token via the caller-provided `getAuth` (the ONLY
 * read path — there is no `client.auth.get`). If a token exists and the
 * config file is NOT yet an account store (content discriminator), seeds
 * it as the primary OAuth account.
 *
 * Idempotent: a second run is a no-op because the content discriminator
 * will already match.
 *
 * Tolerates expired/revoked tokens (migrates them; refresh handles validity).
 *
 * Guards against first-run races with the same save-lock order used by
 * structural account writes.
 */
export async function migrateIfNeeded(
  existingToken:
    | { type: 'oauth'; access: string; refresh: string; expires: number }
    | undefined,
  paths: AccountPaths,
) {
  const path = paths.configPath
  const statePath = paths.statePath
  const lock = await acquireSaveAccountsLock(path)
  try {
    const stateLock = await acquireSaveAccountsLock(statePath)
    try {
      const existing = await readJsonIfPresent(path)
      if (existing.exists && isRecord(existing.value)) {
        if (isAccountStore(existing.value)) return // already migrated
      }

      if (!existingToken) return // no token to migrate

      const storage: AccountStorage = {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
      }

      // Extract the stable ChatGPT account id from the main token so we
      // can reject attempts to add main as a fallback later.
      if (existingToken.access) {
        const accountId = extractAccountId({
          id_token: '',
          access_token: existingToken.access,
          refresh_token: existingToken.refresh,
        })
        if (accountId) storage.mainAccountId = accountId
      }

      // Merge with existing transport keys so saving the account store preserves webSockets/rawWebSocket/dump/dumpDir.
      const existingFields =
        existing.exists && isRecord(existing.value) ? existing.value : {}
      const nextConfig = { ...existingFields, ...configFromStorage(storage) }
      await writeJsonAtomic(path, nextConfig)
      await writeJsonAtomic(statePath, stateFromStorage(storage))
    } finally {
      await stateLock.release()
    }
  } finally {
    await lock.release()
  }
}

// --- accounts.ts lines 2118-2120 ---
function jitterMs(maxMs: number) {
  return Math.floor(Math.random() * (maxMs + 1))
}

// Test access to the private content discriminator, without editing its text.
export { isAccountStore }
