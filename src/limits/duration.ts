/** Compact durations keep every numeric component below the hosts' retry codes. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return 'unknown'
  const seconds = Math.ceil(Math.max(0, ms) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.ceil(seconds / 60)
  const days = Math.floor(minutes / (24 * 60))
  if (days >= 100) return 'over 99 days'
  const hours = Math.floor(minutes / 60) % 24
  const remainingMinutes = minutes % 60
  if (days > 0) return `${days}d ${hours}h ${remainingMinutes}m`
  if (hours > 0) return `${hours}h ${remainingMinutes}m`
  return `${remainingMinutes}m`
}

export interface ResetFormatInput {
  readonly resetAt: number
  readonly now: number
}

export type ResetFormatter = (input: ResetFormatInput) => string

export const formatReset: ResetFormatter = ({ resetAt, now }) =>
  formatDuration(resetAt - now)
