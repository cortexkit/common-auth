# Logger rotation phase clocks

## Scope and timeout behavior

The test `rotates at 5 MiB keeping three private generations` still seeds a real
5 MiB file and three existing generations, and retains its original content,
size, retention and permission assertions. Neither `src/logger/engine.ts` nor the
runner's default 5000 ms timeout changed. Three recorded `renameSync` calls are
now asserted, proving that the engine's already-imported filesystem functions
actually reach the spies on both tested Bun versions.

Test-only spies pass through `writeFileSync`, `chmodSync`, `statSync`,
`renameSync`, `unlinkSync`, `appendFileSync`, `existsSync`, and `readFileSync`.
Each record contains the operation, source path basename, start offset from the
test body's start, and duration in milliseconds. `flushLogs` has a surrounding
phase as well. Assertions' filesystem reads are included. A rename's basename
is its source; the test's generation order determines its destination.

Ordinary successful runs print no clocks. An assertion failure, teardown
cancellation while the body is outstanding, or a body lasting at least 5000 ms
prints the full record to stderr under the test's name. A final event-loop yield
lets Bun deliver a deadline delayed by synchronous I/O. Reporting is deduplicated,
and spies and the cancellation listener are restored in `finally`.

A blocking synchronous syscall cannot run a cancellation listener on the same
JavaScript thread. Consequently, once the syscall returns, completed intervals
spanning the runner deadline are labeled **crossed the 5000 ms deadline**, not
claimed to be still running. An unfinished interval at cancellation is labeled
**in progress**. A syscall that never returns cannot produce an in-process
report; it also prevents this runner from making progress. This limitation and
the final-yield/interval approach were explicitly approved by the task giver.

For measurements only, `LOGGER_ROTATION_TIMINGS=/absolute/path.jsonl` opts into
appending raw phases to a separate file after spy restoration. It does not print
successful timings to stderr and is unset in normal tests and gates.

## Failure-output control

On macOS Bun 1.4.2, a temporary `NON-VACUITY BREAK` in the measurement wrapper
blocked the first real rename with `Atomics.wait(..., 6000)` before passing it
through. The runner exited **1**, with only the named rotation test failing:

```text
Logger rotation phase clocks: {"test":"rotates at 5 MiB keeping three private generations", ...}
renameSync test.log.2: startMs=2.980417 durationMs=6005.551541
status="crossed the 5000 ms deadline"
flushLogs: startMs=2.867792 durationMs=6006.156875
status="crossed the 5000 ms deadline"
Late test body completion: rotates at 5 MiB keeping three private generations
(fail) rotates at 5 MiB keeping three private generations [6013.63ms]
  ^ this test timed out after 5000ms.
0 pass, 24 filtered out, 1 fail, 10 expect() calls
```

The full stderr record included every completed setup, rotation, append and
assertion phase. The indexed live implementation was preserved before mutation;
`git diff --stat` showed `test/logger/rotation-clocks.ts | 2 ++` during the control
and was empty after `git checkout -- test/logger/rotation-clocks.ts` and `touch`.
The control was repeated on the final helper implementation and the restored
logger file then passed all 25 tests (97 expectations). No mutant is retained.
An initial control without the final yield/finally deadline
report failed by name after 18 seconds but printed no clocks, demonstrating why
an abort listener alone cannot cover synchronous overruns.

## Measurements

2026-10-06, base `28e9d0d`, instrumented test. The **entire logger engine test
file** (25 tests) ran 20 times per runtime on the Mac without generated load,
and 20 times per runtime on `tester@2.28.133.11` with 16 busy-loop workers.
Runtime groups were sequential on each host. Mac and VM groups ran concurrently;
no CPU load was injected on the Mac. All 80 subprocesses exited 0. Each group
produced exactly 20 rotation records. No historical multi-second rotation timeout
reproduced; these clocks are retained for the next occurrence.

Maximum single-call duration in milliseconds, over all 20 records per column:

| Operation | macOS 1.3.14 natural | macOS 1.4.2 natural | Linux 1.3.14 loaded | Linux 1.4.2 loaded |
| --- | ---: | ---: | ---: | ---: |
| writeFileSync | 8.324 | 50.615 | 9.758 | 15.691 |
| chmodSync | 0.114 | 1.886 | 0.017 | 0.015 |
| statSync | 0.181 | 0.022 | 0.011 | 3.524 |
| renameSync | 1.329 | 198.662 | 0.127 | 0.136 |
| unlinkSync | no calls | no calls | no calls | no calls |
| appendFileSync | 0.840 | 1.391 | 3.469 | 0.051 |
| existsSync | 0.117 | 0.021 | 0.012 | 0.009 |
| readFileSync | 0.184 | 7.198 | 3.369 | 3.779 |
| flushLogs (whole phase) | 2.267 | 199.489 | 3.721 | 3.932 |
| Whole file subprocess range | 594–778 | 583–2996 | 753–1129 | 707–816 |

The largest natural Mac rename was `test.log.2`, starting 52.543 ms after body
start and lasting 198.662 ms. It is evidence of filesystem latency, **not proof**
of the cause of the historical 5.7 s and 18.2 s failures. Rotation overwrites
`.3` via rename, so no unlink is expected; its spy remains installed to capture
any future use. `logger-rotation-counts.json` preserves exact maxima, worst
phase records, operation counts and all 20 subprocess/rotation durations per
group. Raw probe output is in `/tmp/rotation-mac-{version}.{runs,clocks}.jsonl`
on the Mac and `/home/tester/common-auth-logger-rotation/vm-{version}.{runs,clocks}.jsonl`
on the VM (also copied to Mac `/tmp`).

### Reproduction commands

Mac Bun 1.3.14 was selected with `npx --yes bun@1.3.14`; Mac `bun` is 1.4.2.
No dependencies or lockfiles changed. The VM received `git archive HEAD` plus
only the instrumented test files in `/home/tester/common-auth-logger-rotation`.
`~/rt/bun-1.3.14/bun install --frozen-lockfile` installed 754 packages there.

```sh
LOGGER_ROTATION_TIMINGS=/tmp/rotation-mac-1.3.14.clocks.jsonl \
  npx --yes bun@1.3.14 scripts/load-probe.mjs test/logger/engine.test.ts '.' 20 0 \
  > /tmp/rotation-mac-1.3.14.runs.jsonl
LOGGER_ROTATION_TIMINGS=/tmp/rotation-mac-1.4.2.clocks.jsonl \
  bun scripts/load-probe.mjs test/logger/engine.test.ts '.' 20 0 \
  > /tmp/rotation-mac-1.4.2.runs.jsonl
# On the VM, once for each version (1.3.14, then 1.4.2):
LOGGER_ROTATION_TIMINGS="$PWD/vm-$version.clocks.jsonl" \
  TEST_BUN="/home/tester/rt/bun-$version/bun" \
  "/home/tester/rt/bun-$version/bun" scripts/load-probe.mjs \
  test/logger/engine.test.ts '.' 20 16 > "vm-$version.runs.jsonl"
```

Probe exits, not printed pass strings alone, were checked. The probe itself
returns nonzero if any child exits nonzero.

## Gates

All required gates exited 0 on macOS Bun 1.4.2:

- `bun run build`: TypeScript 7.0.2; local dependency guard checked 8 manifests,
  installed-range guard checked 12 dependencies, package compilation succeeded.
- `bun run typecheck`: TypeScript 7.0.2, `tsc --noEmit` exited 0. An initial
  pre-build invocation could not resolve this package's self-imported `dist`
  declarations; building first resolved those baseline fixture errors.
- `bun run lint`: Biome 2.5.14 checked 228 files, no fixes or warnings.
- `bun run format:check`: Biome 2.5.14 checked 228 files, no fixes.
- `bun test --reporter=junit --reporter-outfile=test-results.xml`: 1123 passed,
  11 existing skips, 0 failed; 1134 tests across 98 files, 5003 expectations.
  Duration 162.32 seconds. No rotation diagnostic was printed on this green run.
- `bun scripts/check-sources.mjs docs/sources.md test-results.xml`: 1117 cells
  parsed and 1117 matched. No new test names were introduced, so no sources row
  was added. The generated JUnit output is not committed.
- Scoped AFT diagnostics for `test/logger/`: 5 files authoritatively analyzed,
  0 errors and 0 warnings; optional reachability metrics unavailable in this
  isolated worktree.
