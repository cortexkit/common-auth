import { type Attribution, recordQuota } from './attribution.js'
import type { PoolOperationError } from './errors.js'
import type { PoolLogger } from './hooks.js'
import {
  type HoldPoint,
  type InitializeOutcome,
  initializePool,
  readPool,
  type StoreContext,
} from './mutate.js'
import { type PullHook, PullScheduler } from './pull.js'
import {
  type ProviderRefresh,
  type RefreshOptions,
  type RefreshOutcome,
  refreshRow,
} from './refresh.js'
import {
  type LockEnvironment,
  POOL_LOCK_DEFAULTS,
  type PoolLockOptions,
  type PoolLockSpec,
} from './refresh-lock.js'
import {
  type AddInput,
  type AddResult,
  addRow,
  disableRow,
  enableRow,
  type RemoveOptions,
  type RemoveResult,
  type ReorderOptions,
  type ReorderResult,
  type RowOperationOptions,
  type RowToggleOptions,
  recordRowIdentity,
  removeRow,
  reorderRows,
  replaceRow,
  rotateRow,
} from './rows.js'
import type { PullReason, StoreRuntime } from './runtime.js'
import {
  POOL_SCHEMA_VERSION,
  type PoolCredential,
  type PoolRow,
  type QuotaCodec,
  type StoredCredential,
} from './schema.js'
import {
  readPoolSettings,
  type SettingsMutator,
  type SettingsRead,
  type UpdateSettingsOptions,
  type UpdateSettingsResult,
  updatePoolSettings,
} from './settings.js'

export interface OpenPoolStoreOptions {
  /** The provider every row of this pool belongs to; keys the provider-wide lock. */
  provider: string
  configPath: string
  statePath: string
  quota: QuotaCodec
  /** Injected clock for leases, refresh stamps and `addedAt`. */
  now?: () => number
  /**
   * Ordered store-lock list held across every read-modify-write. Defaults to
   * the older writers' `save` lock at the config path, then at the state path.
   */
  storeLocks?: readonly PoolLockSpec[]
  /** Defaults for every lock the store takes (see `POOL_LOCK_DEFAULTS`). */
  lockOptions?: Partial<PoolLockOptions>
  /** Overrides for the row locks only. */
  rowLockOptions?: Partial<PoolLockOptions>
  /** The provider-wide lock; defaults to `provider-<provider>` beside the state file. */
  providerLock?: PoolLockSpec
  /** Quota pull hook, fired without being awaited. */
  pull?: PullHook
  /** Receives every pull failure, since no caller awaits a pull. */
  onPullFailure?: (
    rowId: string,
    error: PoolOperationError,
  ) => void | Promise<void>
  logger?: PoolLogger
  /** Named write steps, awaited; a test seam for crash and ownership rows. */
  onStep?: StoreContext['onStep']
  /** Awaitable hold points on the refresh and pull paths; a test seam. */
  hold?: (point: HoldPoint, rowId: string) => void | Promise<void>
  onLockEvent?: LockEnvironment['onLockEvent']
  onLockStep?: LockEnvironment['onLockStep']
}

export type PoolLoad =
  | { status: 'ready'; schemaVersion: number; rows: PoolRow[] }
  | { status: 'pending-migration'; roster: unknown[] }
  | { status: 'error'; file: 'config' | 'state'; reason: string }

export interface PoolStore {
  /** Reads the pool and fires first-reading pulls; never writes a file itself. */
  load(): Promise<PoolLoad>
  /** Reads the pool without firing anything. */
  read(): Promise<PoolLoad>
  /**
   * Turns a pending-migration config into an empty pool (the pool key with no
   * row entries) in one locked config write, dropping the named top-level
   * keys and keeping the rest. The start of a plugin's migration; a ready
   * pool is left alone. Failures carry operation `initialize`.
   */
  initialize(input?: {
    dropKeys?: readonly string[]
  }): Promise<{ status: InitializeOutcome }>
  add(input: AddInput, options?: RowOperationOptions): Promise<AddResult>
  replace(
    id: string,
    credential: PoolCredential,
    input?: { identity?: string },
    options?: RowOperationOptions,
  ): Promise<{
    id: string
    credential: StoredCredential
    credentialEpoch: number
  }>
  rotate(
    id: string,
    credential: PoolCredential,
    input?: { identity?: string },
    options?: RowOperationOptions,
  ): Promise<{ id: string; credential: StoredCredential }>
  /**
   * Sets `enabled: false` and the entry's `disabledReason`. Takes the row
   * lock, then `extraLocks`, then the store locks (the row lock and
   * `extraLocks` since 0.2.3).
   */
  disable(
    id: string,
    reason: string,
    options?: RowToggleOptions,
  ): Promise<{ id: string }>
  /**
   * Clears `enabled: false` and `disabledReason` (since 0.2.3); refuses with
   * `duplicate-identity` when another enabled OAuth row holds the row's
   * identity. Locks as `disable`.
   */
  enable(id: string, options?: RowToggleOptions): Promise<{ id: string }>
  /**
   * Deletes the roster row, its per-row entry and its state-file credential
   * (since 0.2.3). Locks as `disable`; `protect` can refuse the id.
   */
  remove(id: string, options?: RemoveOptions): Promise<RemoveResult>
  /**
   * Sets the roster order (since 0.2.4) in one config write. `ids` must name
   * every roster id exactly once; anything else refuses with `invalid-order`
   * and writes nothing. Takes `extraLocks`, then the store locks; no row or
   * provider-wide lock. Roster rows and their entries are left unchanged.
   */
  reorder(
    ids: readonly string[],
    options?: ReorderOptions,
  ): Promise<ReorderResult>
  /**
   * The plugin's settings (since 0.2.6): every top-level key of the config
   * file except the pool-owned ones (`POOL_OWNED_KEYS`). Never writes.
   */
  readSettings(): Promise<SettingsRead>
  /**
   * One locked write of the plugin's settings (since 0.2.6) beside the pool,
   * in the config file. Refuses a result that sets a pool-owned key
   * (`invalid-input`). Takes `extraLocks`, then the store locks.
   */
  updateSettings(
    mutator: SettingsMutator,
    options?: UpdateSettingsOptions,
  ): Promise<UpdateSettingsResult>
  /**
   * Records the identity a lookup found for the row's credential. Since
   * 0.3.1 it takes the credential epoch the lookup was issued for, and
   * refuses a lookup that completes after the row was replaced
   * (`attribution`) or a row recorded for another account
   * (`identity-mismatch`).
   */
  recordIdentity(
    id: string,
    identity: string,
    attribution: Pick<Attribution, 'credentialEpoch'>,
    options?: RowOperationOptions,
  ): Promise<{ id: string; disabled: string[] }>
  refresh(
    id: string,
    provider: ProviderRefresh,
    options?: RefreshOptions,
  ): Promise<RefreshOutcome>
  recordQuota(
    id: string,
    attribution: Attribution,
    observation: unknown,
  ): Promise<void>
  /** Fires a pull for a row admission refused for want of a reading. */
  requestReading(id: string): void
  /** Resolves once every pull fired so far has settled. */
  pullsSettled(): Promise<void>
}

/**
 * Process-wide memory per config file: ids whose per-row entry a library
 * write dropped (not reused in this process), and rows a load-time pull
 * already fired for.
 */
const processMemory = new Map<
  string,
  { removedIds: Set<string>; firedAtLoad: Set<string> }
>()

function memoryFor(configPath: string) {
  let memory = processMemory.get(configPath)
  if (!memory) {
    memory = { removedIds: new Set(), firedAtLoad: new Set() }
    processMemory.set(configPath, memory)
  }
  return memory
}

function toLoad(result: Awaited<ReturnType<typeof readPool>>): PoolLoad {
  if (result.status === 'ready')
    return {
      status: 'ready',
      schemaVersion: POOL_SCHEMA_VERSION,
      rows: result.rows,
    }
  if (result.status === 'pending-migration')
    return {
      status: 'pending-migration',
      roster: Array.isArray(result.config.accounts)
        ? result.config.accounts
        : [],
    }
  return result
}

export function openPoolStore(options: OpenPoolStoreOptions): PoolStore {
  const memory = memoryFor(options.configPath)
  const lockDefaults: PoolLockOptions = {
    ...POOL_LOCK_DEFAULTS,
    ...options.lockOptions,
  }
  const ctx: StoreContext = {
    provider: options.provider,
    configPath: options.configPath,
    statePath: options.statePath,
    codec: options.quota,
    now: options.now ?? Date.now,
    storeLocks: options.storeLocks ?? [
      { name: 'save', path: options.configPath },
      { name: 'save', path: options.statePath },
    ],
    lockDefaults,
    lockEnv: {
      now: options.now ?? Date.now,
      ...(options.onLockEvent ? { onLockEvent: options.onLockEvent } : {}),
      ...(options.onLockStep ? { onLockStep: options.onLockStep } : {}),
    },
    removedIds: memory.removedIds,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.onStep ? { onStep: options.onStep } : {}),
    ...(options.hold ? { hold: options.hold } : {}),
  }
  const pulls = new PullScheduler(
    () => rt,
    options.pull,
    options.onPullFailure,
    memory.firedAtLoad,
    options.logger,
  )
  const rt: StoreRuntime = {
    ctx,
    providerLock: options.providerLock ?? {
      name: `provider-${encodeURIComponent(options.provider)}`,
      path: options.statePath,
    },
    rowLockOptions: options.rowLockOptions ?? {},
    firePull: (id: string, reason: PullReason) => pulls.fire(id, reason),
  }

  return {
    async load() {
      const result = await readPool(ctx)
      if (result.status === 'ready') {
        // A torn row is no candidate, but its pull is fired too: the pull
        // completes the row on disk before reading it, so an interrupted
        // replace of an OAuth row heals at the next load.
        for (const row of result.rows)
          if (
            (row.candidate || (row.torn && row.enabled)) &&
            row.type === 'oauth' &&
            row.needsFirstReading
          )
            pulls.fire(row.id, 'load')
      }
      return toLoad(result)
    },
    async read() {
      return toLoad(await readPool(ctx))
    },
    async initialize(input = {}) {
      return { status: await initializePool(ctx, input.dropKeys ?? []) }
    },
    add: (input, callOptions) => addRow(rt, input, callOptions),
    replace: (id, credential, input, callOptions) =>
      replaceRow(rt, id, credential, input, callOptions),
    rotate: (id, credential, input, callOptions) =>
      rotateRow(rt, id, credential, input, callOptions),
    disable: (id, reason, callOptions) =>
      disableRow(rt, id, reason, callOptions),
    enable: (id, callOptions) => enableRow(rt, id, callOptions),
    remove: (id, callOptions) => removeRow(rt, id, callOptions),
    reorder: (ids, callOptions) => reorderRows(rt, ids, callOptions),
    readSettings: () => readPoolSettings(rt),
    updateSettings: (mutator, callOptions) =>
      updatePoolSettings(rt, mutator, callOptions),
    recordIdentity: (id, identity, attribution, callOptions) =>
      recordRowIdentity(rt, id, identity, attribution, callOptions),
    refresh: (id, provider, callOptions) =>
      refreshRow(rt, id, provider, callOptions),
    recordQuota: (id, attribution, observation) =>
      recordQuota(rt, id, attribution, observation),
    requestReading: (id) => pulls.fire(id, 'admission'),
    pullsSettled: () => pulls.settled(),
  }
}
