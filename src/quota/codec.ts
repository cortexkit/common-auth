import { isQuotaMap } from './map.js'
import { mergeQuotaObservation } from './merge.js'

export interface QuotaCodec {
  readonly validate: (value: unknown) => boolean
  readonly merge: (stored: unknown, observation: unknown) => unknown
}

/**
 * The codec a pool store is opened with: it validates a stored per-row quota
 * map and merges an observation into one, so the store persists the map
 * without interpreting it.
 */
export const quotaCodec: QuotaCodec = Object.freeze({
  validate: isQuotaMap,
  merge: mergeQuotaObservation,
})
