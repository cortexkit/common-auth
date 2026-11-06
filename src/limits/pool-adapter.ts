import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { PoolOperationError } from '../store/errors.js'
import type { PoolLimitsRow } from '../store/limits-namespace.js'
import type { PoolStore } from '../store/pool.js'
import { EnvelopeGuard } from './envelope.js'
import {
  EnvelopeHistory,
  EnvelopeRepair,
  type LimitsRecoveryLogger,
} from './envelope-loss.js'
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
  /** Receives redacted replacement warnings and background envelope-loss repair failures. */
  readonly logger?: LimitsRecoveryLogger
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

/**
 * Activate after initialize/load reports ready. Reads never acquire a write
 * lock; recovery is detached and commits merge under the store locks.
 */
export async function createPoolLimitsAdapter(
  options: PoolLimitsAdapterOptions,
): Promise<PersistenceAdapter> {
  const { store, namespace } = options
  if (!store.updateLimitsNamespace)
    throw new LimitsPersistenceRefusal('limits-unsupported')
  const update = store.updateLimitsNamespace.bind(store)
  const generation = randomUUID()
  let history = new EnvelopeHistory()
  const guard = new EnvelopeGuard(namespace, options.logger)
  const repair = new EnvelopeRepair(options.logger)
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
    return guard.decode(settings.settings.commonAuthLimits)
  }
  const read = async (
    previous?: LimitsNamespace,
  ): Promise<LimitsPersistenceSnapshot> => {
    guard.assertWritable()
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
      last = {
        snapshot:
          snapshot.snapshot ?? createLimitsNamespace(namespace, generation),
        bindings,
        authoritative: stable,
      }
      if (stable) {
        if (
          !snapshot.replacement &&
          history.lost(snapshot.snapshot, previous)
        ) {
          repair.schedule(() => adapter.commit([], previous))
          return {
            snapshot: history.recover(
              snapshot.snapshot,
              previous,
              namespace,
              now(),
            ),
            bindings,
            authoritative: false,
            degradedAgreement: true,
          }
        }
        if (snapshot.snapshot) history.remember(snapshot.snapshot)
        return last
      }
      bindings = checked
      snapshot = checkedSnapshot
    }
    return last as LimitsPersistenceSnapshot
  }
  const adapter: PersistenceAdapter = {
    namespace,
    read,
    subscribe: repair.subscribe,
    async commit(commands, previous) {
      guard.assertWritable()
      let committed: LimitsPersistenceCommit | undefined
      let replacement: ReturnType<EnvelopeGuard['decode']>['replacement']
      const onPublished = () => {
        if (guard.didCommit(replacement) && committed) {
          history = new EnvelopeHistory()
          history.remember(committed.snapshot, previous)
        }
      }
      try {
        await update(
          (envelope, rows) => {
            const bindings = bindingsOf(namespace, rows)
            const decoded = guard.decode(envelope)
            const present = decoded.snapshot
            replacement = decoded.replacement
            const degradedAgreement =
              !replacement && history.lost(present, previous)
            const result = applyLimitsCommands(
              degradedAgreement
                ? history.recover(present, previous, namespace, now())
                : (present ?? createLimitsNamespace(namespace, generation)),
              commands,
              {
                now: now(),
                bindings,
                authorizeEpoch: (observed, current) =>
                  observed.credentialEpoch === current.credentialEpoch,
              },
            )
            committed = {
              ...result,
              bindings,
              authoritative: true,
              degradedAgreement,
            }
            return result.snapshot
          },
          {
            beforePublish: () => guard.assertWritable(),
            onPublished,
          },
        )
      } catch (error) {
        // Store operations wrap mutator failures; preserve the typed terminal refusal.
        guard.assertWritable()
        if (
          error instanceof PoolOperationError &&
          (error.kind === 'pending-migration' || error.kind === 'load-error')
        )
          throw new LimitsPersistenceRefusal('pool-not-ready')
        throw error
      }
      if (!committed) throw new Error('Pool limits mutator was not called')
      onPublished()
      history.remember(committed.snapshot, previous)
      return committed
    },
  }
  await read()
  return adapter
}
