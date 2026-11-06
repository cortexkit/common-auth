import { randomUUID } from 'node:crypto'
import {
  mutateVaultRoster,
  readVaultRoster,
  type VaultRosterFile,
} from '../claustrum/roster.js'
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
import type {
  LimitsPersistenceSnapshot,
  PersistenceAdapter,
} from './persistence.js'

export interface VaultLimitsAdapterOptions {
  /** Canonical provider and roster namespace, shared by every process using this roster. */
  readonly namespace: string
  readonly path: string
  readonly now?: () => number
  /** Receives redacted replacement warnings and background envelope-loss repair failures. */
  readonly logger?: LimitsRecoveryLogger
}

function bindingsOf(
  namespace: string,
  roster: VaultRosterFile | undefined,
): IdentityBinding[] {
  return (roster?.rows ?? []).map((row) => ({
    account: {
      namespace,
      accountId: row.routeId,
      // Credential ids can change within the same provider account; addedAt
      // survives those changes but changes when a removed route returns.
      incarnation: String(row.addedAt),
    },
    credentialEpoch: String(row.addedAt),
    ...(row.accountIdentity === undefined
      ? {}
      : { identity: row.accountIdentity }),
  }))
}

/**
 * Reads use one atomic roster snapshot. Commits re-read both limits and row
 * bindings under the roster's existing write lock, without accessing local
 * account-pool files.
 */
export async function createVaultLimitsAdapter(
  options: VaultLimitsAdapterOptions,
): Promise<PersistenceAdapter> {
  const { namespace, path } = options
  const generation = randomUUID()
  let history = new EnvelopeHistory()
  const guard = new EnvelopeGuard(namespace, options.logger)
  const repair = new EnvelopeRepair(options.logger)
  const now = options.now ?? Date.now
  const read = async (
    previous?: LimitsNamespace,
  ): Promise<LimitsPersistenceSnapshot> => {
    guard.assertWritable()
    const roster = await readVaultRoster(path)
    const { snapshot: present, replacement } = guard.decode(roster?.limits)
    if (!replacement && history.lost(present, previous)) {
      repair.schedule(() => adapter.commit([], previous))
      return {
        snapshot: history.recover(present, previous, namespace, now()),
        bindings: bindingsOf(namespace, roster),
        authoritative: false,
        degradedAgreement: true,
      }
    }
    if (present) history.remember(present)
    return {
      snapshot: present ?? createLimitsNamespace(namespace, generation),
      bindings: bindingsOf(namespace, roster),
      authoritative: true,
    }
  }
  const adapter: PersistenceAdapter = {
    namespace,
    read,
    subscribe: repair.subscribe,
    commit: async (commands, previous) => {
      guard.assertWritable()
      let replacement: ReturnType<EnvelopeGuard['decode']>['replacement']
      let publishedSnapshot: LimitsNamespace | undefined
      const onPublished = () => {
        if (guard.didCommit(replacement) && publishedSnapshot) {
          history = new EnvelopeHistory()
          history.remember(publishedSnapshot, previous)
        }
      }
      const committed = await mutateVaultRoster(
        path,
        (current) => {
          const bindings = bindingsOf(namespace, current)
          const decoded = guard.decode(current?.limits)
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
              authorizeEpoch: (observed, authoritative) =>
                observed.credentialEpoch === authoritative.credentialEpoch,
            },
          )
          publishedSnapshot = result.snapshot
          return {
            next: {
              ...(current ?? {
                version: 1,
                complete: true,
                rows: [],
                declined: [],
              }),
              limits: result.snapshot,
            },
            result: {
              ...result,
              bindings,
              authoritative: true,
              degradedAgreement,
            },
          }
        },
        {
          beforePublish: async () => guard.assertWritable(),
          onPublished,
        },
      )
      onPublished()
      history.remember(committed.snapshot, previous)
      return committed
    },
  }
  await read()
  return adapter
}
