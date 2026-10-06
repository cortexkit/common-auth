/** Capture diagnostics without making elapsed time a correctness assertion. */
export function phaseClock(label: string, budgetMs: number) {
  const started = performance.now()
  const events: Array<Record<string, unknown>> = []
  let succeeded = false
  const mark = (phase: string, detail: Record<string, unknown> = {}) => {
    events.push({
      phase,
      ms: Number((performance.now() - started).toFixed(3)),
      ...detail,
    })
  }
  const print = (reason: string) =>
    console.error(label, JSON.stringify({ reason, events }))
  // Bun can abandon the body before its finally runs. Retain an overrun
  // snapshot as well as the final trace once the owned body finishes.
  const timer = setTimeout(() => print('overrun'), budgetMs)
  return {
    mark,
    async span<T>(
      phase: string,
      detail: Record<string, unknown>,
      work: () => Promise<T>,
    ): Promise<T> {
      mark(`${phase}-start`, detail)
      try {
        return await work()
      } finally {
        mark(`${phase}-end`, detail)
      }
    },
    succeeded() {
      succeeded = true
    },
    finish() {
      clearTimeout(timer)
      mark('trace-finish')
      if (!succeeded || performance.now() - started >= budgetMs)
        print(succeeded ? 'overrun-complete' : 'failure')
    },
  }
}
