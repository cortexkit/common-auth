import { spyOn } from 'bun:test'
import * as fs from 'node:fs'
import { basename } from 'node:path'

type Phase = {
  operation: string
  basename: string
  startMs: number
  durationMs?: number
}

/** Preserve real I/O while retaining evidence if the runner abandons the body. */
export function rotationClocks(signal: AbortSignal, origin: number) {
  const phases: Phase[] = []
  let reported = false
  function measure<T>(operation: string, path: unknown, work: () => T): T {
    const phase: Phase = {
      operation,
      basename: basename(String(path)),
      startMs: performance.now() - origin,
    }
    phases.push(phase)
    try {
      return work()
    } finally {
      phase.durationMs = performance.now() - origin - phase.startMs
    }
  }
  function report(reason: string) {
    if (reported) return
    reported = true
    console.error(
      'Logger rotation phase clocks:',
      JSON.stringify({
        test: 'rotates at 5 MiB keeping three private generations',
        reason,
        elapsedMs: performance.now() - origin,
        phases: phases.map((phase) => ({
          ...phase,
          status:
            phase.durationMs === undefined
              ? 'in progress'
              : phase.startMs <= 5000 &&
                  phase.startMs + phase.durationMs >= 5000
                ? 'crossed the 5000 ms deadline'
                : 'completed',
        })),
      }),
    )
  }
  const cancelled = () => report('teardown cancellation (runner timeout)')
  signal.addEventListener('abort', cancelled, { once: true })
  const operations = [
    ['writeFileSync', fs.writeFileSync],
    ['chmodSync', fs.chmodSync],
    ['statSync', fs.statSync],
    ['renameSync', fs.renameSync],
    ['unlinkSync', fs.unlinkSync],
    ['appendFileSync', fs.appendFileSync],
    ['existsSync', fs.existsSync],
    ['readFileSync', fs.readFileSync],
  ] as const
  const spies = operations.map(([operation, original]) =>
    spyOn(fs, operation).mockImplementation((...args: unknown[]) =>
      measure(operation, args[0], () => Reflect.apply(original, fs, args)),
    ),
  )
  return {
    phases,
    measure,
    report,
    finish(failed: boolean) {
      if (failed || performance.now() - origin >= 5000)
        report(failed ? 'test failure' : 'body exceeded the 5000 ms deadline')
    },
    restore() {
      for (const spy of spies) spy.mockRestore()
      signal.removeEventListener('abort', cancelled)
      // An explicit output path saves successful measurement runs separately
      // without printing their clocks to stderr during normal tests.
      const output = process.env.LOGGER_ROTATION_TIMINGS
      if (output) fs.appendFileSync(output, `${JSON.stringify(phases)}\n`)
    },
  }
}
