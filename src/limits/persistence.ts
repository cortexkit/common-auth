import type { IdentityBinding } from './identity.js'
import type {
  LimitsCommand,
  LimitsCommandOutcome,
  LimitsNamespace,
} from './namespace.js'

/** Bindings and the namespace snapshot must be read from the same authoritative store view. */
export interface LimitsPersistenceSnapshot {
  readonly snapshot: LimitsNamespace
  readonly bindings: readonly IdentityBinding[]
  /** False for a cached or unverifiable view; it cannot restore agreement. */
  readonly authoritative: boolean
  /** An adapter repaired missing or rewritten namespace state; require a later authoritative read without this flag. */
  readonly degradedAgreement?: boolean
}

export type LimitsPersistenceOutcome = Omit<LimitsCommandOutcome, 'reason'> & {
  readonly reason?: LimitsCommandOutcome['reason'] | 'pool-not-ready'
}

export interface LimitsPersistenceCommit extends LimitsPersistenceSnapshot {
  readonly outcomes: readonly LimitsPersistenceOutcome[]
}

/**
 * One canonical namespace. Validate commands against current account identities
 * and credential epochs, then merge under the existing store lock. Never
 * implement commit by saving the caller's memory snapshot.
 */
export interface PersistenceAdapter {
  readonly namespace: string
  read(previous?: LimitsNamespace): Promise<LimitsPersistenceSnapshot>
  commit(
    commands: readonly LimitsCommand[],
    previous?: LimitsNamespace,
  ): Promise<LimitsPersistenceCommit>
  subscribe?(onChange: () => void): () => void
}

/** A definitive refusal settles commands; an ordinary I/O error leaves them queued. */
export class LimitsPersistenceRefusal extends Error {
  constructor(readonly code: 'pool-not-ready' | 'limits-unsupported') {
    super(code)
    this.name = 'LimitsPersistenceRefusal'
  }
}
