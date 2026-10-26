import type { QuotaCommitTimer } from '../../src/quota/commit-interval.js'

/** Advances only quota scheduling; filesystem operations still run normally. */
export function manualQuotaTimer() {
  let now = 0
  const tasks = new Set<{ at: number; run: () => Promise<void> }>()
  const clock: QuotaCommitTimer = {
    now: () => now,
    schedule(delayMs, run) {
      const task = { at: now + delayMs, run }
      tasks.add(task)
      return { cancel: () => tasks.delete(task) }
    },
  }
  return {
    clock,
    async advance(ms: number) {
      const end = now + ms
      for (;;) {
        const next = [...tasks]
          .filter((task) => task.at <= end)
          .sort((a, b) => a.at - b.at)[0]
        if (!next) break
        tasks.delete(next)
        now = next.at
        await next.run()
      }
      now = end
    },
  }
}
