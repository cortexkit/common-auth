import { decodeQuotaMap, isQuotaMap } from './map.js'
import { mergeQuotaObservation } from './merge.js'

export interface QuotaCodec {
  readonly validate: (value: unknown) => boolean
  /** Normalize persisted data before validation; older codecs may omit this. */
  readonly decode?: (value: unknown) => unknown
  readonly merge: (stored: unknown, observation: unknown) => unknown
}

/**
 * The quota codec the account-pool store (the `/store` subpath) takes when it
 * is opened: `validate` checks a stored per-row quota map and `merge` applies
 * an observation to one, so the store persists the map without interpreting
 * it.
 */
export const quotaCodec: QuotaCodec = Object.freeze({
  validate: isQuotaMap,
  decode: decodeQuotaMap,
  merge: mergeQuotaObservation,
})
