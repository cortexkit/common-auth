import type { QuotaMap } from '../../src/quota/index.js'
import type { RoutingRow } from '../../src/routing/index.js'

export function oauth(id: string, quota?: QuotaMap): RoutingRow {
  return { id, kind: 'oauth', ...(quota === undefined ? {} : { quota }) }
}

export function apiKey(id: string): RoutingRow {
  return { id, kind: 'api-key' }
}
