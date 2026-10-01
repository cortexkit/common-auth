import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  acquireRefreshFileLock,
  withLock,
  writeJsonAtomic,
} from '../fs/index.js'
import {
  isQuotaMap,
  mergeQuotaObservation,
  type QuotaMap,
  type QuotaObservation,
} from '../quota/index.js'
import type { RoutingRow } from '../routing/index.js'
import type {
  ClaustrumScopedCustody,
  VaultCredential,
  VaultCredentialType,
  VaultInventory,
} from './custody.js'
import { ClaustrumConsumerError } from './errors.js'
import {
  acceptAccount,
  type DeclinedAccount,
  declineAccount,
  isDeclined,
  pruneDeclined,
} from './interlock.js'

/**
 * One vault account as the pool sees it. It carries no bearer material: the
 * access token is fetched from the vault for every send. Several vault
 * records logged into the same provider account collapse into one row, so
 * duplicate logins never count as extra quota.
 */
export interface VaultRosterRow {
  routeId: string
  credentialId: string
  credentialType: VaultCredentialType
  accountIdentity?: string
  /** Other credential ids logged into the same provider account. */
  aliases?: string[]
  state: string
  label: string
  email?: string
  orgName?: string
  enabled: boolean
  addedAt: number
  quota?: QuotaMap
  /**
   * The vault listed this record in a form this consumer could not use, so the
   * row is the last good projection kept as it was rather than dropped.
   */
  stale?: true
}

export interface VaultRosterFile {
  version: 1
  view?: string
  rows: VaultRosterRow[]
  declined: DeclinedAccount[]
}

/** How a vault credential is presented in the pool. */
export type AccountMapper = (credential: VaultCredential) => { label?: string }

export interface ProjectionOptions {
  /** Ids already used by local rows; a vault route never takes one. */
  reservedRouteIds?: ReadonlySet<string>
  /** Prefix for vault route ids, so they read differently from local ids. */
  routePrefix?: string
  mapAccount?: AccountMapper
  now?: number
}

export const DEFAULT_ROUTE_PREFIX = 'vault:'

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function defaultLabel(credential: VaultCredential): string {
  // `oauth:<provider>:<label>` is the vault's conventional spelling; use the
  // trailing label when present and fall back to the account's email.
  const parts = credential.credentialId.split(':')
  const label = parts.length >= 3 ? parts.slice(2).join(':').trim() : undefined
  return label || credential.email || credential.credentialId
}

function compatible(left?: string, right?: string): boolean {
  return left === undefined || right === undefined || left === right
}

function groupKey(credential: VaultCredential): string {
  return credential.accountIdentity !== undefined
    ? `identity:${credential.accountIdentity}`
    : `credential:${credential.credentialId}`
}

/**
 * Project the vault's list onto the previous roster. Pure: callers serialize
 * discovery and commit. Route ids, quota and the time an account was added
 * survive for the same account; a credential that now logs into a different
 * known account gets a new route id and no inherited quota.
 */
export function projectVaultRoster(
  previous: VaultRosterFile | undefined,
  inventory: VaultInventory,
  options: ProjectionOptions = {},
): VaultRosterFile {
  const now = options.now ?? Date.now()
  const prefix = options.routePrefix ?? DEFAULT_ROUTE_PREFIX
  const reserved = options.reservedRouteIds ?? new Set<string>()
  const previousRows = previous?.rows ?? []
  const declined = pruneDeclined(
    previous?.declined ?? [],
    inventory.credentials,
  )

  const groups = new Map<string, VaultCredential[]>()
  for (const credential of inventory.credentials) {
    const key = groupKey(credential)
    const group = groups.get(key) ?? []
    group.push(credential)
    groups.set(key, group)
  }

  const used = new Set<VaultRosterRow>()
  const taken = new Set<string>(reserved)
  const projected: Array<{ row: VaultRosterRow; previousIndex: number }> = []

  const sortedGroups = [...groups.values()].sort((left, right) =>
    (left[0]?.credentialId ?? '').localeCompare(right[0]?.credentialId ?? ''),
  )
  for (const group of sortedGroups) {
    const ordered = group.toSorted((left, right) =>
      left.credentialId.localeCompare(right.credentialId),
    )
    const active = ordered.filter((entry) => entry.state === 'active')
    const choices = active.length ? active : ordered
    const members = new Set(ordered.map((entry) => entry.credentialId))
    const bound = previousRows.find(
      (row) =>
        !used.has(row) &&
        members.has(row.credentialId) &&
        compatible(
          row.accountIdentity,
          ordered.find((entry) => entry.credentialId === row.credentialId)
            ?.accountIdentity,
        ),
    )
    const representative =
      choices.find((entry) => entry.credentialId === bound?.credentialId) ??
      choices[0]
    if (!representative) continue
    const identity = representative.accountIdentity
    const existing =
      bound ??
      (identity === undefined
        ? undefined
        : previousRows.find(
            (row) => !used.has(row) && row.accountIdentity === identity,
          ))
    if (existing) used.add(existing)
    let routeId = existing?.routeId
    if (!routeId || reserved.has(routeId)) {
      const base = `${prefix}${representative.credentialId}${
        identity === undefined ? '' : `~${hash(identity).slice(0, 10)}`
      }`
      routeId = base
      for (let suffix = 2; taken.has(routeId); suffix++)
        routeId = `${base}~${suffix}`
    }
    taken.add(routeId)
    const aliases = ordered
      .map((entry) => entry.credentialId)
      .filter((id) => id !== representative.credentialId)
    const mapped = options.mapAccount?.(representative) ?? {}
    projected.push({
      previousIndex: existing ? previousRows.indexOf(existing) : Infinity,
      row: {
        routeId,
        credentialId: representative.credentialId,
        credentialType: representative.credentialType,
        ...(identity !== undefined && { accountIdentity: identity }),
        ...(aliases.length && { aliases }),
        state: representative.state,
        label: mapped.label?.trim() || defaultLabel(representative),
        ...(representative.email !== undefined && {
          email: representative.email,
        }),
        ...(representative.orgName !== undefined && {
          orgName: representative.orgName,
        }),
        enabled: !ordered.some((entry) =>
          isDeclined(declined, entry.credentialId, entry.accountIdentity),
        ),
        addedAt: existing?.addedAt ?? now,
        ...(existing?.quota !== undefined && { quota: existing.quota }),
      },
    })
  }

  // A record skipped as malformed keeps its last good projection: skipping it
  // must not read as the account having been removed from the vault.
  const skippedIds = new Set(
    inventory.skipped.flatMap((record) =>
      record.credentialId === undefined ? [] : [record.credentialId],
    ),
  )
  previousRows.forEach((row, previousIndex) => {
    if (used.has(row) || !skippedIds.has(row.credentialId)) return
    if (taken.has(row.routeId)) return
    taken.add(row.routeId)
    projected.push({ previousIndex, row: { ...row, stale: true } })
  })

  projected.sort((left, right) =>
    left.previousIndex === right.previousIndex
      ? left.row.credentialId.localeCompare(right.row.credentialId)
      : left.previousIndex - right.previousIndex,
  )
  return {
    version: 1,
    view: inventory.view,
    rows: projected.map((entry) => entry.row),
    declined,
  }
}

/**
 * The rows `/routing` selects among. Only enabled, active accounts route;
 * a declined or cold vault account stays listed for the menu but never
 * reaches admission.
 */
export function vaultRoutingRows(
  roster: VaultRosterFile | undefined,
): RoutingRow[] {
  return (roster?.rows ?? [])
    .filter((row) => row.enabled && row.state === 'active')
    .map((row) => ({
      id: row.routeId,
      kind: row.credentialType === 'oauth' ? 'oauth' : 'api-key',
      ...(row.quota !== undefined && { quota: row.quota }),
    }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function decodeRow(value: unknown): VaultRosterRow | undefined {
  if (
    !isRecord(value) ||
    typeof value.routeId !== 'string' ||
    typeof value.credentialId !== 'string' ||
    (value.credentialType !== 'oauth' && value.credentialType !== 'api_key') ||
    typeof value.state !== 'string' ||
    typeof value.label !== 'string' ||
    typeof value.enabled !== 'boolean' ||
    typeof value.addedAt !== 'number' ||
    !optionalString(value.accountIdentity) ||
    !optionalString(value.email) ||
    !optionalString(value.orgName) ||
    (value.aliases !== undefined &&
      (!Array.isArray(value.aliases) ||
        !value.aliases.every((alias) => typeof alias === 'string'))) ||
    (value.quota !== undefined && !isQuotaMap(value.quota))
  )
    return undefined
  return value as unknown as VaultRosterRow
}

function decodeRoster(value: unknown): VaultRosterFile {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !optionalString(value.view) ||
    !Array.isArray(value.rows) ||
    !Array.isArray(value.declined)
  )
    throw new ClaustrumConsumerError(
      'invalid-state',
      'Claustrum roster file is not valid',
    )
  const rows: VaultRosterRow[] = []
  for (const entry of value.rows) {
    const row = decodeRow(entry)
    if (!row)
      throw new ClaustrumConsumerError(
        'invalid-state',
        'Claustrum roster file is not valid',
      )
    rows.push(row)
  }
  const declined: DeclinedAccount[] = []
  for (const entry of value.declined) {
    if (
      !isRecord(entry) ||
      typeof entry.credentialId !== 'string' ||
      !optionalString(entry.accountIdentity)
    )
      throw new ClaustrumConsumerError(
        'invalid-state',
        'Claustrum roster file is not valid',
      )
    declined.push(entry as unknown as DeclinedAccount)
  }
  return {
    version: 1,
    ...(typeof value.view === 'string' && { view: value.view }),
    rows,
    declined,
  }
}

export async function readVaultRoster(
  path: string,
): Promise<VaultRosterFile | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new ClaustrumConsumerError(
      'invalid-state',
      'Claustrum roster file is not valid',
    )
  }
  return decodeRoster(value)
}

const WRITE_LOCK = {
  name: 'claustrum-roster-write',
  ttlMs: 10_000,
  timeoutMs: 5_000,
}
const DISCOVERY_LEASE = { name: 'claustrum-roster', ttlMs: 30_000 }

/**
 * Read, change and write the roster under its write lock. `change` returns
 * undefined to leave the file as it is.
 */
export async function mutateVaultRoster<T>(
  path: string,
  change: (
    current: VaultRosterFile | undefined,
  ) =>
    | Promise<{ next?: VaultRosterFile; result: T }>
    | { next?: VaultRosterFile; result: T },
): Promise<T> {
  return withLock(path, WRITE_LOCK, async (lock) => {
    const current = await readVaultRoster(path)
    const { next, result } = await change(current)
    if (next) {
      await lock.assertOwned()
      await writeJsonAtomic(path, next)
    }
    return result
  })
}

/** Mark a vault account declined; it stays listed but never routes. */
export function declineVaultRoute(path: string, routeId: string) {
  return mutateVaultRoster(path, (current) => {
    const row = current?.rows.find((entry) => entry.routeId === routeId)
    if (!current || !row)
      throw new ClaustrumConsumerError(
        'route-unavailable',
        'Claustrum route is not in the roster',
      )
    const declined = declineAccount(
      current.declined,
      row.credentialId,
      row.accountIdentity,
    )
    return {
      next: {
        ...current,
        declined,
        rows: current.rows.map((entry) =>
          entry === row ? { ...entry, enabled: false } : entry,
        ),
      },
      result: undefined,
    }
  })
}

/** Lift the user's decline for a vault account and every alias of it. */
export function acceptVaultRoute(path: string, routeId: string) {
  return mutateVaultRoster(path, (current) => {
    const row = current?.rows.find((entry) => entry.routeId === routeId)
    if (!current || !row)
      throw new ClaustrumConsumerError(
        'route-unavailable',
        'Claustrum route is not in the roster',
      )
    return {
      next: {
        ...current,
        declined: acceptAccount(current.declined, [
          row.credentialId,
          ...(row.aliases ?? []),
        ]),
        rows: current.rows.map((entry) =>
          entry === row ? { ...entry, enabled: true } : entry,
        ),
      },
      result: undefined,
    }
  })
}

/**
 * Merge a quota observation into a vault row through `/quota`'s merge. The
 * write is fenced on the account: an observation taken for an identity the
 * row no longer holds is dropped, so a slow read for a replaced account can
 * never land on its successor. Returns whether the observation was kept.
 */
export function recordVaultQuota(
  path: string,
  input: {
    routeId: string
    observation: QuotaObservation
    accountIdentity?: string
  },
): Promise<boolean> {
  return mutateVaultRoster(path, (current) => {
    const row = current?.rows.find((entry) => entry.routeId === input.routeId)
    if (
      !current ||
      !row ||
      !compatible(row.accountIdentity, input.accountIdentity)
    )
      return { result: false }
    const quota = mergeQuotaObservation(row.quota, input.observation)
    return {
      next: {
        ...current,
        rows: current.rows.map((entry) =>
          entry === row ? { ...entry, quota } : entry,
        ),
      },
      result: true,
    }
  })
}

/**
 * Discover and commit the roster. The lease covers the list call and the
 * commit, not just the write: an opaque view cannot tell a delayed old reply
 * from a newer one, so a run that lost its lease is refused at commit. A
 * failed list, or custody switching off mid-run, never writes anything; a
 * peer holding the lease means its last committed roster is served instead.
 */
export async function refreshVaultRoster(options: {
  path: string
  custody: Pick<ClaustrumScopedCustody, 'discover'>
  isActive?: () => boolean | Promise<boolean>
  signal?: AbortSignal
  projection?: ProjectionOptions | (() => ProjectionOptions)
}): Promise<VaultRosterFile | undefined> {
  options.signal?.throwIfAborted()
  const active = async () => (await options.isActive?.()) ?? true
  if (!(await active())) return undefined
  const lease = await acquireRefreshFileLock({
    ...DISCOVERY_LEASE,
    path: options.path,
    renew: true,
  })
  if (!lease) {
    const persisted = await readVaultRoster(options.path)
    options.signal?.throwIfAborted()
    if (!persisted?.view)
      throw new ClaustrumConsumerError(
        'roster-busy',
        'Claustrum account discovery is already in progress',
      )
    return persisted
  }
  try {
    const inventory = await options.custody.discover(options.signal)
    options.signal?.throwIfAborted()
    return await mutateVaultRoster(options.path, async (current) => {
      if (!(await active())) return { result: undefined }
      options.signal?.throwIfAborted()
      await lease.assertOwned()
      const projection =
        typeof options.projection === 'function'
          ? options.projection()
          : options.projection
      const next = projectVaultRoster(current, inventory, projection)
      const changed = JSON.stringify(current) !== JSON.stringify(next)
      return { ...(changed && { next }), result: next }
    })
  } finally {
    await lease.release()
  }
}
