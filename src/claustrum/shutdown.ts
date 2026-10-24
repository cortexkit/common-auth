import type { ClaustrumLogger } from './errors.js'

/**
 * Give cancelled background work two seconds to release its handles without letting
 * an unresponsive connector or disk hold the host's shutdown indefinitely.
 */
export async function drainShutdown(
  pending: ReadonlySet<Promise<unknown>>,
  logger: Pick<ClaustrumLogger, 'warn'>,
): Promise<void> {
  if (!pending.size) return
  let timer: ReturnType<typeof setTimeout> | undefined
  let expired = false
  const drained = (async () => {
    while (!expired && pending.size) await Promise.allSettled([...pending])
  })()
  try {
    await Promise.race([
      drained,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          expired = true
          resolve()
        }, 2_000)
      }),
    ])
    if (expired && pending.size)
      logger.warn('claustrum shutdown drain timed out', {
        pendingOperations: pending.size,
      })
  } finally {
    expired = true
    clearTimeout(timer)
  }
}
