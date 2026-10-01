/** A local clock-hour range in which idle caches are kept warm. */
export interface CacheKeepWindow {
  startHour: number
  endHour: number
}

/**
 * Reads a persisted `{ startHour, endHour }` pair. Anything other than two
 * distinct whole hours in 0-23 is no window at all, which callers treat as
 * "always warm".
 */
export function normalizeCacheKeepWindow(
  value: unknown,
): CacheKeepWindow | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const startHour = Number(record.startHour)
  const endHour = Number(record.endHour)
  if (
    !Number.isInteger(startHour) ||
    !Number.isInteger(endHour) ||
    startHour < 0 ||
    startHour > 23 ||
    endHour < 0 ||
    endHour > 23 ||
    startHour === endHour
  ) {
    return undefined
  }
  return { startHour, endHour }
}

/** Whether the local hour of `now` falls inside the window; no window is never inside. */
export function isWithinCacheKeepWindow(
  window: CacheKeepWindow | undefined,
  now = new Date(),
): boolean {
  if (!window) return false
  const hour = now.getHours()
  if (window.startHour < window.endHour) {
    return hour >= window.startHour && hour < window.endHour
  }
  // Overnight wrap (e.g. 22-6): in window at or after the start, or before the end.
  return hour >= window.startHour || hour < window.endHour
}
