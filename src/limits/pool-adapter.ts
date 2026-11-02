import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { PoolOperationError } from '../store/errors.js'
import type { PoolLimitsRow } from '../store/limits-namespace.js'
import type { PoolStore } from '../store/pool.js'
import type { IdentityBinding } from './identity.js'
import {
  applyLimitsCommands,
  createLimitsNamespace,
  type LimitsNamespace,
} from './namespace.js'
import {
  type LimitsPersistenceCommit,
  LimitsPersistenceRefusal,
  type LimitsPersistenceSnapshot,
  type PersistenceAdapter,
} from './persistence.js'

export interface PoolLimitsAdapterOptions {
  /** Canonical provider and store namespace, shared by every process using this pool. */
  readonly namespace: string
  readonly store: PoolStore
  readonly now?: () => number
}

function bindingsOf(
  namespace: string,
  rows: readonly PoolLimitsRow[],
): IdentityBinding[] {
  return rows.flatMap((row) =>
    row.credentialEpoch === undefined
      ? []
      : [
          {
            account: {
              namespace,
              accountId: row.id,
              // Pool epochs change on replacement, not on refresh or rotation.
              incarnation: String(row.credentialEpoch),
            },
            credentialEpoch: String(row.credentialEpoch),
            ...(row.identity === undefined ? {} : { identity: row.identity }),
          },
        ],
  )
}

function decodeEnvelope(
  value: unknown,
  namespace: string,
  generation: string,
): LimitsNamespace {
  if (value === undefined) return createLimitsNamespace(namespace, generation)
  if (
    value === null ||
    typeof value !== 'object' ||
    !('schemaVersion' in value) ||
    value.schemaVersion !== 1 ||
    !('namespace' in value) ||
    value.namespace !== namespace ||
    !('generation' in value) ||
    typeof value.generation !== 'string' ||
    !('revision' in value) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !('lowWatermark' in value) ||
    !Number.isSafeInteger(value.lowWatermark) ||
    (value.lowWatermark as number) < 0 ||
    !('marks' in value) ||
    !Array.isArray(value.marks) ||
    !('tombstones' in value) ||
    !Array.isArray(value.tombstones) ||
    !('operationIds' in value) ||
    !Array.isArray(value.operationIds) ||
    !('access' in value) ||
    !Array.isArray(value.access)
  )
    throw new TypeError('Invalid or unsupported pool limits namespace')
  return value as LimitsNamespace
}

/**
 * Activate after initialize/load reports ready. Reads never acquire a save or
 * row lock; only commit validates current row bindings and merges under the store locks.
 */
export async function createPoolLimitsAdapter(
  options: PoolLimitsAdapterOptions,
): Promise<PersistenceAdapter> {
  const { store, namespace } = options
  if (!store.updateLimitsNamespace)
    throw new LimitsPersistenceRefusal('limits-unsupported')
  const update = store.updateLimitsNamespace.bind(store)
  const generation = randomUUID()
  const now = options.now ?? Date.now
  const readBindings = async () => {
    const pool = await store.read()
    if (pool.status !== 'ready') {
      if (pool.status === 'error' && pool.kind === 'snapshot-contended')
        throw new Error(pool.reason)
      throw new LimitsPersistenceRefusal('pool-not-ready')
    }
    return bindingsOf(namespace, pool.rows)
  }
  const readEnvelope = async () => {
    const settings = await store.readSettings()
    if (settings.status !== 'ready')
      throw new LimitsPersistenceRefusal('pool-not-ready')
    return decodeEnvelope(
      settings.settings.commonAuthLimits,
      namespace,
      generation,
    )
  }
  const read = async (): Promise<LimitsPersistenceSnapshot> => {
    let bindings = await readBindings()
    let snapshot = await readEnvelope()
    let last: LimitsPersistenceSnapshot | undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      const checked = await readBindings()
      const checkedSnapshot = await readEnvelope()
      // A replacement between the envelope and binding reads must not make an
      // old envelope authoritative for a new incarnation. Recheck the envelope
      // too: its generation or revision can change while the rows stay the same.
      // Bounded retries keep a busy writer from delaying a provider request.
      const stable =
        isDeepStrictEqual(bindings, checked) &&
        isDeepStrictEqual(snapshot, checkedSnapshot)
      last = { snapshot, bindings, authoritative: stable }
      if (stable) return last
      bindings = checked
      snapshot = checkedSnapshot
    }
    return last as LimitsPersistenceSnapshot
  }
  const adapter: PersistenceAdapter = {
    namespace,
    read,
    async commit(commands) {
      let committed: LimitsPersistenceCommit | undefined
      try {
        await update((envelope, rows) => {
          const bindings = bindingsOf(namespace, rows)
          const result = applyLimitsCommands(
            decodeEnvelope(envelope, namespace, generation),
            commands,
            {
              now: now(),
              bindings,
              authorizeEpoch: (observed, current) =>
                observed.credentialEpoch === current.credentialEpoch,
            },
          )
          committed = { ...result, bindings, authoritative: true }
          return result.snapshot
        })
      } catch (error) {
        if (
          error instanceof PoolOperationError &&
          (error.kind === 'pending-migration' || error.kind === 'load-error')
        )
          throw new LimitsPersistenceRefusal('pool-not-ready')
        throw error
      }
      if (!committed) throw new Error('Pool limits mutator was not called')
      return committed
    },
  }
  await read()
  return adapter
}
