# Dump response artifact phase clocks

## Incident and instrumentation

The test `response artifacts > response artifacts sanitize message fields and preserve diagnostics presence` once took 9980 ms against its unchanged 5000 ms deadline in a full local run of 37e5127. It had no assertion failure and subsequently passed 43/43 three times in isolation. That incident remains **UNEXPLAINED**; these measurements do not establish its cause.

The test now follows the logger rotation pattern, using a separate async-aware helper in `test/dump/response-clocks.ts`. There are no source or logger-test changes. Its existing assertions and timeout are unchanged. Additional assertions require exactly one intercepted writer `promises.open` and one `promises.rename`, proving that the writer's imported functions reach the spies.

Pass-through spies record `startMs` relative to body entry and `durationMs` through promise settlement, not just promise creation. They cover the writer's imported `node:fs/promises` functions (`mkdir`, `chmod`, `readdir`, `lstat`, `readFile`, `writeFile`, `open`, `rename`, `unlink`), the test's `stat`, and the opened FileHandle's `writeFile`, `chmod`, `close`, and `sync` (fsync). Sync counterparts additionally cover `openSync`, `writeFileSync`, `writeSync`, `renameSync`, `chmodSync`, `fchmodSync`, `mkdirSync`, `statSync`, `lstatSync`, `readFileSync`, `fsyncSync`, `closeSync`, `unlinkSync`, and `readdirSync`. The actual source uses the promise/handle surfaces; no sync calls were observed. `d.dump` and `d.dumpResponse` are timed as whole phases too.

On failure, elapsed body time >=5000 ms, or lifetime-signal cancellation, stderr receives a `Dump response phase clocks:` JSON record with every operation, basename, offset, duration when available, and status. An unfinished promise is `in progress`; a completed interval spanning 5000 ms is `crossed the 5000 ms deadline`. Cancellation reports immediately, before pending I/O settles. A duplicate-report guard preserves that first snapshot. Nested `finally` restores every spy and removes the listener after the body settles, even if reporting throws. Normal successful tests emit no clocks; probe runs explicitly set `DUMP_RESPONSE_TIMINGS` to collect successful phases in JSONL.

## Delayed-call control

On Mac Bun 1.4.2, a temporary `NON-VACUITY BREAK` inserted `await Bun.sleep(6000)` inside the measured `promises.rename` wrapper, before invoking the original. The Git index first held the live implementation and `git diff --stat` was empty. During mutation it showed:

```text
test/dump/response-clocks.ts | 8 +++++---
1 file changed, 5 insertions(+), 3 deletions(-)
```

`bun test test/dump/dump.test.ts` exited **1**, with exactly the named test failing: 42 pass, 1 fail, 43 tests, 149 assertions. All other tests in the file stayed green. The output included:

```text
Late test body completion: response artifacts sanitize message fields and preserve diagnostics presence
(fail) response artifacts > response artifacts sanitize message fields and preserve diagnostics presence [6005.74ms]
  ^ this test timed out after 5000ms.
```

The cancellation record at elapsed 5001.034 ms named both `d.dumpResponse` (offset 0.618 ms) and **`promises.rename` (offset 1.540 ms) as `in progress`**, with the rename's `.response.json.<random>.partial` basename. This proves async pending-call reporting, not merely a slow whole-test timer. The temporary delay was removed by restoring the helper using `git checkout -- test/dump/response-clocks.ts && touch test/dump/response-clocks.ts`; the subsequent `git diff --stat` was empty. No mutant was retained.

## Repeat probes (2026-10-06)

Base: main 6a81c898dcc77c85b253cfe0b2e9834d900de198 plus the two instrumented test files. Mac: macOS 27.0.1 / arm64, no generated load. VM: `tester@2.28.133.11`, Linux 6.8.0-142-generic / x86_64, 8 logical CPUs, **16 busy-loop workers**. The isolated VM directory was `/home/tester/common-auth-dump-response`, populated with `git archive HEAD` and the instrumented test files. VM `~/rt/bun-1.3.14/bun install --frozen-lockfile` succeeded (754 packages); manifests and lockfile were unchanged. The prepared Mac install was already cached and unchanged.

Each configuration ran the **entire file**, 20 separate subprocesses, using `scripts/load-probe.mjs test/dump/dump.test.ts . 20 WORKERS`. Every subprocess exited 0 and reported 43 pass / 0 fail; each configuration produced exactly 20 complete clock records. Both outer local commands and both remote probe commands exited 0. Total: 80 file runs / 3440 tests. **No reproduction** and no deadline/failure clock report in these runs. Clocks remain in place for the next occurrence.

Maximum durations in milliseconds (maximum over all occurrences, not sum; request writes overlap):

| Operation | Mac 1.3.14 | Mac 1.4.2 | VM 1.3.14 / 16 workers | VM 1.4.2 / 16 workers |
| --- | ---: | ---: | ---: | ---: |
| d.dump | 2.725 | 1.442 | 46.719 | 4.310 |
| promises.mkdir | 1.261 | 0.561 | 26.731 | 3.603 |
| promises.chmod | 0.316 | 0.272 | 8.040 | 0.101 |
| promises.readdir | 0.807 | 0.140 | 3.344 | 1.943 |
| promises.writeFile | 1.194 | 0.802 | 33.902 | 0.193 |
| d.dumpResponse | 5.694 | 4.653 | 46.199 | 10.668 |
| promises.open | 2.890 | 0.945 | 43.746 | 4.496 |
| FileHandle.writeFile | 0.834 | 3.365 | 3.867 | 3.117 |
| FileHandle.chmod | 0.990 | 0.204 | 4.755 | 2.692 |
| FileHandle.close | 3.336 | 0.377 | 3.478 | 1.481 |
| promises.rename | 0.236 | 0.706 | 2.366 | 4.989 |
| promises.readFile | 0.181 | 1.980 | 3.093 | 2.686 |
| promises.stat | 0.062 | 0.813 | 12.762 | 3.789 |

All other wrapped operations were **not observed**, rather than measured as zero. The promise readFile and stat are the existing artifact assertions; writer recovery/cleanup operations did not occur in this successful path.

Commands (fresh output paths prevent appending earlier measurements):

```sh
# Mac, unloaded, Bun 1.3.14 (cached npm runtime)
npx --yes --package bun@1.3.14 --call 'bun --version; DUMP_RESPONSE_TIMINGS=/tmp/dump-mac-1.3.14.clocks.jsonl bun scripts/load-probe.mjs test/dump/dump.test.ts . 20 0 > /tmp/dump-mac-1.3.14.runs.jsonl'
# Mac, unloaded, installed Bun 1.4.2
DUMP_RESPONSE_TIMINGS=/tmp/dump-mac-1.4.2.clocks.jsonl bun scripts/load-probe.mjs test/dump/dump.test.ts . 20 0 > /tmp/dump-mac-1.4.2.runs.jsonl
# VM, once per version: 1.3.14, then 1.4.2
DUMP_RESPONSE_TIMINGS="$PWD/vm-$version.clocks.jsonl" \
  TEST_BUN="/home/tester/rt/bun-$version/bun" \
  "/home/tester/rt/bun-$version/bun" scripts/load-probe.mjs \
  test/dump/dump.test.ts . 20 16 > "vm-$version.runs.jsonl"
```

In the probe's first JSONL output record, `runtime` is Bun's Node-compatibility `process.version` (v24.3.0 / v26.3.0), not its Bun version. Actual runtime binaries were checked as Bun 1.3.14 and 1.4.2.

## Gates

Final gates use local Bun 1.4.2, TypeScript 7.0.2 and Biome 2.5.14. All six required gates exited 0:

| Gate | Result |
| --- | --- |
| `bun run build` | Passed; 8 local package manifests and 12 installed dependency ranges checked, followed by `tsc -p tsconfig.build.json` (silent success). |
| `bun run typecheck` | Passed; `tsc --noEmit` (silent success). |
| `bun run lint` | Passed; 234 files, no fixes, 2 warnings for dynamic namespace access in the test-only spy loops. |
| `bun run format:check` | Passed; 234 files, no fixes. |
| `bun test --reporter=junit --reporter-outfile=test-results.xml` | Passed; 1142 pass, 11 skip, 0 fail, 5119 assertions, 1153 tests across 100 files (83.72 s). |
| `bun scripts/check-sources.mjs docs/sources.md test-results.xml` | Passed; 1136 cells parsed and matched. |

The existing skips require a real private group or opt-in OpenCode placement setup. No new test names were added, so no sources-table changes were required. The initial pre-build typecheck also found missing self-package declarations in unrelated TUI fixtures; running the required build generated those declarations and the subsequent typecheck passed. No unrelated source changes were needed.
