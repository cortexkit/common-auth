import type { LimitsRecoveryLogger } from './envelope-loss.js'
import type { LimitsNamespace } from './namespace.js'

export type LimitsAbandonReason = 'conflict' | 'unsupported'

// Registries can be shared by independently bundled copies of common-auth.
const envelopeError = Symbol.for('@cortexkit/common-auth/limits-envelope-error')

/** Another writer replaced an envelope after this adapter already replaced one. */
export class LimitsEnvelopeConflictError extends Error {
  readonly [envelopeError] = 'conflict'
  constructor() {
    super('Conflicting limits envelope writers')
    this.name = 'LimitsEnvelopeConflictError'
  }
}

/** The envelope belongs to a schema this version must never overwrite. */
export class LimitsEnvelopeUnsupportedError extends Error {
  readonly [envelopeError] = 'unsupported'
  constructor() {
    super('Invalid or unsupported limits namespace schema')
    this.name = 'LimitsEnvelopeUnsupportedError'
  }
}

export function limitsEnvelopeAbandonReason(
  error: unknown,
): LimitsAbandonReason | undefined {
  const reason =
    error && typeof error === 'object' && Reflect.get(error, envelopeError)
  return reason === 'conflict' || reason === 'unsupported' ? reason : undefined
}

type Replacement = 'foreign-namespace' | 'malformed'
interface DecodedEnvelope {
  readonly snapshot?: LimitsNamespace
  readonly replacement?: Replacement
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
const revision = (value: unknown): boolean =>
  Number.isSafeInteger(value) && (value as number) >= 0
const finite = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value)
const cause = (value: unknown): boolean =>
  value === undefined || value === 'rate-limit' || value === 'payment-balance'
const arrayOf = (value: unknown, valid: (item: unknown) => boolean): boolean =>
  Array.isArray(value) && value.every(valid)

function account(value: unknown, namespace: string): boolean {
  return (
    record(value) &&
    value.namespace === namespace &&
    typeof value.accountId === 'string' &&
    typeof value.incarnation === 'string'
  )
}
function key(value: unknown, namespace: string): boolean {
  if (!record(value) || !record(value.scope)) return false
  const scope = value.scope
  return (
    account(value.account, namespace) &&
    typeof value.window === 'string' &&
    (scope.kind === 'pool' ||
      (scope.kind === 'family' && typeof scope.family === 'string') ||
      (scope.kind === 'model' && typeof scope.model === 'string'))
  )
}
function validEnvelope(
  value: Record<string, unknown>,
  namespace: string,
): boolean {
  return (
    value.namespace === namespace &&
    typeof value.generation === 'string' &&
    revision(value.revision) &&
    revision(value.lowWatermark) &&
    arrayOf(
      value.marks,
      (mark) =>
        record(mark) &&
        key(mark.key, namespace) &&
        ['latest-evidence', 'max-until', 'overwrite'].includes(
          mark.mergeLaw as string,
        ) &&
        arrayOf(
          mark.entries,
          (entry) =>
            record(entry) &&
            cause(entry.cause) &&
            finite(entry.until) &&
            finite(entry.evidenceAt) &&
            revision(entry.baseRevision) &&
            revision(entry.committedRevision),
        ),
    ) &&
    arrayOf(
      value.tombstones,
      (clear) =>
        record(clear) &&
        key(clear.key, namespace) &&
        revision(clear.revision) &&
        cause(clear.cause),
    ) &&
    arrayOf(
      value.operationIds,
      (op) =>
        record(op) &&
        typeof op.producerId === 'string' &&
        typeof op.operationId === 'string' &&
        revision(op.revision),
    ) &&
    arrayOf(
      value.access,
      (access) =>
        record(access) &&
        account(access.account, namespace) &&
        finite(access.eligibilityStateUpdatedAt) &&
        revision(access.committedRevision),
    )
  )
}

/** Public calls and background envelope-loss repairs share one replacement allowance. */
export class EnvelopeGuard {
  private replaced = false
  private terminal?:
    | LimitsEnvelopeConflictError
    | LimitsEnvelopeUnsupportedError

  constructor(
    private readonly namespace: string,
    private readonly logger?: LimitsRecoveryLogger,
  ) {}

  assertWritable(): void {
    if (this.terminal) throw this.terminal
  }

  decode(value: unknown): DecodedEnvelope {
    this.assertWritable()
    if (value === undefined) return {}
    let replacement: Replacement | undefined
    if (!record(value)) replacement = 'malformed'
    else if (value.schemaVersion !== 1) {
      this.terminal = new LimitsEnvelopeUnsupportedError()
      throw this.terminal
    } else if (
      typeof value.namespace === 'string' &&
      value.namespace !== this.namespace
    )
      replacement = 'foreign-namespace'
    else if (!validEnvelope(value, this.namespace)) replacement = 'malformed'
    if (!replacement) return { snapshot: value as LimitsNamespace }
    if (this.replaced) {
      this.terminal = new LimitsEnvelopeConflictError()
      throw this.terminal
    }
    return { replacement }
  }

  didCommit(replacement: Replacement | undefined): boolean {
    if (!replacement || this.replaced) return false
    this.replaced = true
    try {
      this.logger?.warn(`limits envelope replaced: ${replacement}`)
    } catch {
      // Diagnostics cannot change a durable replacement's result.
    }
    return true
  }
}
