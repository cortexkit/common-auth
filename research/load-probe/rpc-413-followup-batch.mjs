// Preserve the existing load generator; stop a batch when the test expecting
// a 413 for a body over 1 MiB fails. Count unrelated suite failures separately.
import { spawnSync } from 'node:child_process'
const workers = process.argv[2] ?? '0'
let passes = 0
let failures = 0
const limit = Number(process.argv[3] ?? '50')
for (let run = 1; run <= limit; run++) {
  const result = spawnSync(process.execPath, ['scripts/load-probe.mjs', 'test/rpc/request-errors.test.ts', '.', '1', workers], { encoding: 'utf8', env: { ...process.env, TEST_BUN: './research/load-probe/rpc-413-followup-runner.sh', RPC_413_TRACE_ALL: '1' } })
  console.log(JSON.stringify({ batchRun: run, loadProbeStatus: result.status, output: result.stdout, stderr: result.stderr, error: result.error?.message }))
  if (result.status !== 0) failures++
  else passes++
  if (result.error || /\(fail\) a request body over the 1 MiB cap answers 413/.test(result.stdout)) break
}
console.log(JSON.stringify({ summary: true, bun: Bun.version, workers: Number(workers), passes, failures, runs: passes + failures }))
