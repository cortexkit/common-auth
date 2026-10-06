import { spyOn } from 'bun:test'
import * as sync from 'node:fs'
import * as async from 'node:fs/promises'
import { basename } from 'node:path'

const testName =
  'response artifacts sanitize message fields and preserve diagnostics presence'
type Phase = {
  operation: string
  basename: string
  startMs: number
  durationMs?: number
}

/** Time real I/O through settlement so test-timeout teardown can name pending calls. */
export function responseClocks(signal: AbortSignal, origin: number) {
  const phases: Phase[] = []
  const restores: (() => void)[] = []
  let reported = false
  function begin(operation: string, path: unknown) {
    const phase: Phase = {
      operation,
      basename: basename(String(path)),
      startMs: performance.now() - origin,
    }
    phases.push(phase)
    return phase
  }
  function end(phase: Phase) {
    phase.durationMs = performance.now() - origin - phase.startMs
  }
  async function measure<T>(
    operation: string,
    path: unknown,
    work: () => Promise<T>,
  ) {
    const phase = begin(operation, path)
    try {
      return await work()
    } finally {
      end(phase)
    }
  }
  function report(reason: string) {
    if (reported) return
    reported = true
    console.error(
      'Dump response phase clocks:',
      JSON.stringify({
        test: testName,
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
  const syncOperations = [
    'openSync',
    'writeFileSync',
    'writeSync',
    'renameSync',
    'chmodSync',
    'fchmodSync',
    'mkdirSync',
    'statSync',
    'lstatSync',
    'readFileSync',
    'fsyncSync',
    'closeSync',
    'unlinkSync',
    'readdirSync',
  ] as const
  for (const operation of syncOperations) {
    const original = sync[operation]
    const spy = spyOn(sync, operation).mockImplementation(
      (...args: unknown[]) => {
        const phase = begin(`fs.${operation}`, args[0])
        try {
          return Reflect.apply(original, sync, args)
        } finally {
          end(phase)
        }
      },
    )
    restores.push(() => spy.mockRestore())
  }
  const asyncOperations = [
    'writeFile',
    'rename',
    'chmod',
    'mkdir',
    'stat',
    'lstat',
    'readFile',
    'unlink',
    'readdir',
  ] as const
  for (const operation of asyncOperations) {
    const original = async[operation]
    const spy = spyOn(async, operation).mockImplementation(((
      ...args: unknown[]
    ) =>
      measure(`promises.${operation}`, args[0], () =>
        Reflect.apply(original, async, args),
      )) as typeof original)
    restores.push(() => spy.mockRestore())
  }
  const originalOpen = async.open
  const openSpy = spyOn(async, 'open').mockImplementation(
    (...args: Parameters<typeof async.open>) =>
      measure('promises.open', args[0], async () => {
        const handle = await Reflect.apply(originalOpen, async, args)
        // FileHandle methods are a separate surface from the module functions.
        for (const operation of [
          'writeFile',
          'chmod',
          'close',
          'sync',
        ] as const) {
          const original = handle[operation]
          const spy = spyOn(handle, operation).mockImplementation(
            (...methodArgs: unknown[]) =>
              measure<void>(`FileHandle.${operation}`, args[0], () =>
                Reflect.apply(original, handle, methodArgs),
              ),
          )
          restores.push(() => spy.mockRestore())
        }
        return handle
      }),
  )
  restores.push(() => openSpy.mockRestore())
  return {
    phases,
    measure,
    finish(failed: boolean) {
      if (failed || performance.now() - origin >= 5000)
        report(failed ? 'test failure' : 'body exceeded the 5000 ms deadline')
    },
    restore() {
      for (const restore of restores.reverse()) restore()
      signal.removeEventListener('abort', cancelled)
      // DUMP_RESPONSE_TIMINGS saves phases to a file; unset keeps successful tests quiet.
      const output = process.env.DUMP_RESPONSE_TIMINGS
      if (output) sync.appendFileSync(output, `${JSON.stringify(phases)}\n`)
    },
  }
}
