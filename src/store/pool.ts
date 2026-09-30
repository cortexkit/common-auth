import { type Attribution, recordQuota } from './attribution.js'
import type { PoolOperationError } from './errors.js'
import type { PoolLogger } from './hooks.js'
import { type HoldPoint, readPool, type StoreContext } from './mutate.js'
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
  type RowOperationOptions,
  recordRowIdentity,
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
  disable(
    id: string,
    reason: string,
    options?: Pick<RowOperationOptions, 'onFailure'>,
  ): Promise<{ id: string }>
  recordIdentity(
    id: string,
    identity: string,
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
        for (const row of result.rows)
          if (row.candidate && row.type === 'oauth' && row.needsFirstReading)
            pulls.fire(row.id, 'load')
      }
      return toLoad(result)
    },
    async read() {
      return toLoad(await readPool(ctx))
    },
    add: (input, callOptions) => addRow(rt, input, callOptions),
    replace: (id, credential, input, callOptions) =>
      replaceRow(rt, id, credential, input, callOptions),
    rotate: (id, credential, input, callOptions) =>
      rotateRow(rt, id, credential, input, callOptions),
    disable: (id, reason, callOptions) =>
      disableRow(rt, id, reason, callOptions),
    recordIdentity: (id, identity, callOptions) =>
      recordRowIdentity(rt, id, identity, callOptions),
    refresh: (id, provider, callOptions) =>
      refreshRow(rt, id, provider, callOptions),
    recordQuota: (id, attribution, observation) =>
      recordQuota(rt, id, attribution, observation),
    requestReading: (id) => pulls.fire(id, 'admission'),
    pullsSettled: () => pulls.settled(),
  }
}
