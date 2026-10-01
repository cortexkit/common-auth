/**
 * Every refusal this subpath raises itself. Producer refusals from the vault
 * keep arriving as the client's own `ClaustrumCredentialError` (a `code`, a
 * `class` and an `action`), so callers can tell the vault's verdict apart from
 * a consumer-side check.
 */
export type ClaustrumConsumerFailureKind =
  | 'closed'
  | 'not-enrolled'
  | 'invalid-token'
  | 'unavailable'
  | 'identity-changed'
  | 'insufficient-validity'
  | 'invalid-material'
  | 'not-active'
  | 'route-unavailable'
  | 'route-declined'
  | 'no-receipt'
  | 'unsafe-file'
  | 'invalid-state'
  | 'wrong-consumer'
  | 'roster-busy'
  | 'host-slot-login'
  | 'host-slot-placeholder'
  | 'placeholder-refresh'

export class ClaustrumConsumerError extends Error {
  readonly kind: ClaustrumConsumerFailureKind

  constructor(kind: ClaustrumConsumerFailureKind, message: string) {
    super(message)
    this.name = 'ClaustrumConsumerError'
    this.kind = kind
  }
}

/** The structural logger every class here accepts; `/logger`'s `createLogger` satisfies it. */
export interface ClaustrumLogger {
  warn(message: string, data?: unknown): void
  debug(message: string, data?: unknown): void
}
