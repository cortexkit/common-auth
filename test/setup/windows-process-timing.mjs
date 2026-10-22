import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  listSetupProcesses,
  ProcessInspectionError,
} from '@cortexkit/common-auth/setup'

assert.equal(process.platform, 'win32', 'Timing requires real tasklist and CIM')
console.log(
  `${process.version} ${process.platform}/${process.arch}: 10 process listings, then 10 fence listings`,
)
// A separate live runtime ensures every listing exercises CIM, not only tasklist.
const child = spawn(
  process.execPath,
  ['-e', 'process.send("ready"); setInterval(() => {}, 1000)'],
  { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
)
const exited = once(child, 'close')
let failed = 0
try {
  const [ready] = await once(child, 'message', {
    signal: AbortSignal.timeout(20_000),
  })
  assert.equal(ready, 'ready')
  // The full listing (tasklist, then a PowerShell Get-CimInstance query for
  // Node and Bun command lines), then the single Get-CimInstance query a real
  // setup fence runs.
  for (const { listing, hostImagesOnly } of [
    { listing: 'full', hostImagesOnly: false },
    { listing: 'fence', hostImagesOnly: true },
  ]) {
    for (let iteration = 1; iteration <= 10; iteration++) {
      try {
        const processes = await listSetupProcesses(undefined, {
          hostImagesOnly,
          onStep: (details) =>
            console.log(JSON.stringify({ listing, iteration, ...details })),
        })
        if (
          !processes.some((entry) => entry.pid === child.pid && entry.command)
        ) {
          failed++
          console.log(
            JSON.stringify({ listing, iteration, outcome: 'probe-missing' }),
          )
          continue
        }
        console.log(JSON.stringify({ listing, iteration, outcome: 'listed' }))
      } catch (error) {
        failed++
        // Never print arbitrary exception messages or process command lines.
        console.log(
          JSON.stringify({
            listing,
            iteration,
            outcome: 'refused',
            ...(error instanceof ProcessInspectionError
              ? {
                  step: error.step,
                  exitCode: error.exitCode,
                  signal: error.signal,
                  timedOut: error.timedOut,
                  durationMs: error.durationMs,
                }
              : {}),
          }),
        )
      }
    }
  }
} finally {
  child.kill()
  await exited
}
console.log(`20 listings completed: ${20 - failed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
