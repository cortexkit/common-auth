// Usage: BUN_PROBE_RUNTIME=/path/to/bun bun research/load-probe/rpc-close-batch.mjs WORKERS
// Run all fifty whole-set processes without retrying failures or filtering tests.
import { spawnSync } from 'node:child_process'
const result = spawnSync(process.execPath, ['scripts/load-probe.mjs', 'test/rpc/request-errors.test.ts', '.', '50', process.argv[2] ?? '0'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, env: { ...process.env, TEST_BUN: './research/load-probe/rpc-close-runner.sh' } })
if (result.error) throw result.error
const names = ['a request body over the 1 MiB cap answers 413', 'a chunked request body that grows past the cap answers 413', 'streamed overflow keeps the socket open until the client finishes sending', 'a slow declared oversized upload receives complete 413 JSON']
for (const line of result.stdout.trim().split('\n')) {
  const record = JSON.parse(line)
  if (record.output) {
    const lines = record.output.split('\n')
    record.targets = Object.fromEntries(names.map((name) => [name, lines.filter((line) => line.includes(name) && /^\((pass|fail)\)/.test(line))]))
    record.failures = lines.filter((line) => line.startsWith('(fail)'))
    record.counts = lines.filter((line) => /^\s*\d+ (pass|fail|skip|expect)/.test(line) || line.startsWith('Ran '))
    record.bun = /bun test v([^\n]+)/.exec(record.output)?.[1]
    if (record.code === 0) delete record.output
  }
  console.log(JSON.stringify(record))
}
process.exitCode = result.status ?? 1
