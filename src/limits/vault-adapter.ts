import { randomUUID } from 'node:crypto'
import {
  mutateVaultRoster,
  readVaultRoster,
  type VaultRosterFile,
} from '../claustrum/roster.js'
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
    throw new TypeError('Invalid or unsupported vault limits namespace')
  return value as LimitsNamespace
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
  const now = options.now ?? Date.now
  const read = async (): Promise<LimitsPersistenceSnapshot> => {
    const roster = await readVaultRoster(path)
    return {
      snapshot: decodeEnvelope(roster?.limits, namespace, generation),
      bindings: bindingsOf(namespace, roster),
      authoritative: true,
    }
  }
  const adapter: PersistenceAdapter = {
    namespace,
    read,
    commit: (commands) =>
      mutateVaultRoster(path, (current) => {
        const bindings = bindingsOf(namespace, current)
        const result = applyLimitsCommands(
          decodeEnvelope(current?.limits, namespace, generation),
          commands,
          {
            now: now(),
            bindings,
            authorizeEpoch: (observed, authoritative) =>
              observed.credentialEpoch === authoritative.credentialEpoch,
          },
        )
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
          result: { ...result, bindings, authoritative: true },
        }
      }),
  }
  await read()
  return adapter
}
