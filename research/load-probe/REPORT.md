# Lock and store fixture timing investigation

## Scope and evidence

**The Linux loaded baseline did not reproduce any failure: all seven selected tests passed 20/20.** The original failures were on macOS (the supplied ANTAUTH Bun 1.3.14 log and the owner's run). The three fixture fixes therefore rest on source-traced races and active negative controls, not on a demonstrated before/after failure-rate improvement. No production change is delivered, no deadlines were raised, and no failed test was retried as a fix.

The supplied ANTAUTH stderr was read: it records `EEXIST` at the contention fixture's mkdir, the account overlap test's 5,000 ms timeout followed by an unhandled error, and the crash child's unchanged expiry assertion.

## Controlled load

The dedicated Linux host was `tester@2.28.133.11` (`openai-auth-test`, eight online CPUs). Each probe ran with **16 busy-loop child processes**, sequentially, using Bun **1.3.14**. No sustained busy load ran on the operator's Mac. The checkout was copied using tar over SSH, excluding node_modules; frozen installation installed 754 packages without lockfile changes.

Reproduce on a dedicated host only (`scripts/load-probe.mjs`):

```sh
TEST_BUN="$HOME/rt/bun-1.3.14/bun" \
  "$HOME/rt/bun-1.3.14/bun" scripts/load-probe.mjs \
  test/fs/refresh-file-lock.test.ts \
  'reschedules after marker contention and advances the lease' 20 16
```

The probe defaults to twice the CPU count, accepts a run count and worker count, and emits runtime/path, per-run exit status, duration and complete test output, then totals. Each run executes the selected test once; repetitions measure the population, not retry an assertion. Workers are killed in cleanup. Set workers to zero for natural (unloaded) repetitions.

Raw baseline and final JSONL records remain under `/home/tester/common-auth-bg27/` on that host (`fs`, `accounts`, `child`, `commands`, `refresh`, `rows`, `logger` with `.baseline.jsonl`; the repaired tests plus `teardown` with `.final.jsonl`). Duration ranges below are whole subprocess wall durations, including startup, not just test-body times.

## Results

| Test (file) | Traced mechanism | Fix or disposition | Baseline loaded failures/runs | Final loaded passes/runs | Negative control |
| --- | --- | --- | --- | --- | --- |
| reschedules after marker contention and advances the lease (`test/fs/refresh-file-lock.test.ts`) | A 10 ms renewal timer starts before the parent's owner read and mkdir; renewal takes the same `.evicting` directory. The fixture mkdir has no ownership fence. | Plant the contender marker in the first `renewal-finished` observer, after renewal releases its marker but before it reschedules. Observe actual contention, remove the marker there, advance the injected clock, and await the subsequent completed write. | 0/20 (121–253 ms) | 20/20 (181–422 ms) | Renewal preserves old expiry: named test alone fails its greater-than assertion. |
| refreshes of two accounts under their own provider locks are in their provider calls at the same time (`test/store/account-keyed-refresh.test.ts`) | `settlesWithin(both, 1000)` treats scheduler lateness as lack of overlap. After the runner timeout, old teardown releases providers, sleeps 50 ms and deletes files while the body can still perform final state reads. | Both provider entry promises form the barrier; release only after both entered. Register release before setup's first await. Track the entire body, including final state reads; capture scenario, releases and body set before teardown awaits; drain before cleanup. | 0/20 (414–1069 ms) | 20/20 (324–879 ms) | Use the shared default provider lock: only the named test fails the unchanged 5 s watchdog; teardown drains it with no unhandled error. |
| a crash child uses production leases and renewal, and only the exited child has its records expired (`test/store/child-lease.test.ts`) | `renewed:` used to mean snapshots after a fixed `(2 * ttl)/3 + 500` pause, not completed renewal. Delayed timer/marker I/O can outlive that pause. | At `before-state-write`, acquisition is complete. Keep the process referenced and wait for each acquired lease's `renewal-finished` observer to see a later expiry. Parent acknowledges its initial owner/expiry read before the crash may proceed. Compare that read with the announced expiry, not a later host clock sample. Production TTL, renewal cadence, deliberate 1200 ms stall, and 30 s runner budget remain unchanged. | 0/20 (9039–9769 ms) | 20/20 (4967–5410 ms) | Replace observed-renewal wait with immediate snapshots: only the named test fails its greater-than expiry assertion. |
| accounts lists the roster in order with enabled state, identity and quota summary (`test/commands/sections.test.ts`) | **No traced mechanism** for the reported macOS failure. Fixture clock is fixed; setup and menu operations are awaited. | Unchanged. Guaranteeing completion under arbitrary scheduler suspension would require changing the runner budget or replacing the real persistence work. Neither establishes a causal fix. | 0/20 (224–945 ms) | Not rerun as fixed; unchanged | Not required for unchanged tests, per parent ruling. |
| two rows with different known identities never overlap their provider calls (`test/store/refresh.test.ts`) | **No traced mechanism** for the reported macOS failure. There is a timed 300 ms negative assertion, but no existing live-lock contention-attempt seam proves when B has actually tried the provider lock. | Unchanged. Releasing A at B's row-acquired signal would weaken the non-overlap proof; dropping the negative check would silently remove it. | 0/20 (578–1881 ms) | Not rerun as fixed; unchanged | Not required for unchanged tests, per parent ruling. |
| a legacy state writer waits for the library store locks and neither write is lost (`test/store/rows.test.ts`) | **No traced mechanism** for the reported macOS failure. The vendored writer's contention attempt is not observable through an existing seam; its 300 ms negative check is not an arrival barrier. | Unchanged. Removing the check or releasing the library writer before the legacy writer's observed attempt would weaken the intermediate waiting claim. | 0/20 (505–906 ms) | Not rerun as fixed; unchanged | Not required for unchanged tests, per parent ruling. |
| rotates at 5 MiB keeping three private generations (`test/logger/engine.test.ts`) | **No traced mechanism** for the reported macOS failure. Setup, flush, rotation and assertions are synchronous; no fixture await/deadline explains the reported 5.7 s. | Unchanged. Sparse-file setup might reduce work but does not trace or fix a scheduler-sensitive mechanism, and is not presented as a causal fix. | 0/20 (111–204 ms) | Not rerun as fixed; unchanged | Not required for unchanged tests, per parent ruling. |
| teardown keeps a delayed body and its own scenario alive through its final state read (`test/store/drain-bodies.test.ts`) | New regression proof: park after provider release but before final disk read, substitute a successor scenario, and observe cleanup ordering. | Exercise the same drain helper as account teardown with explicit release/read/terminal barriers. Verify no deletion before terminal and no successor-state read. | New test | 20/20 (160–388 ms) | Old cleanup-before-drain order: only this test fails (`finished` true instead of false). |

All three ANTAUTH source triage hypotheses are confirmed. The child needed an additional acquisition-complete condition: earlier acquired locks can renew while later locks are still being acquired, so satisfying the currently-held set before `before-state-write` must not release the barrier.

## Natural runs, separate from load

- macOS, Bun **1.4.2**, no injected busy load: initial affected-file run passed **32/32**; initial new teardown test passed **1/1**. Final required full suite passed **1096**, skipped **11**, failed **0** across **92 files**. Thus each selected test and the teardown regression passed once in the final natural full run.
- Linux, Bun **1.3.14**, Node **24.16.0**, **no probe busy workers active**: final natural full suite passed **1096**, skipped **10**, failed **1** across **92 files**. All selected tests and the new teardown regression passed once. The unrelated failure was **`raw RPC transport bounds headers and response bodies before EOF`**, `test/rpc/client-transport.test.ts`: **144 ms** measured against **<100 ms**. RPC was left unchanged and not retried; parent will handle it separately.
- Negative controls ran unloaded on macOS, Bun **1.4.2**. Each selected mutation produced exactly one named failure and no other failed tests. Other tests were filtered, not silently counted as passes.

## Negative-control safety

Each mutation was staged against the live implementation first, applied separately with `NON-VACUITY BREAK`, run, then restored with `git checkout -- <path>` and `touch <path>`. For each, `git diff --stat` was non-empty during the mutation and empty after restore:

| Mutated file | Temporary change | Red test | During / after restore |
| --- | --- | --- | --- |
| `src/fs/refresh-file-lock.ts` | `writeOwner` retains the previously read expiry rather than extending it | reschedules after marker contention and advances the lease | 1 file, +2/-1 / empty |
| `test/store/account-keyed-refresh.test.ts` | account override factory returns undefined, using the shared provider lock | refreshes of two accounts under their own provider locks are in their provider calls at the same time | 1 file, +2/-1 / empty |
| `test/store/child.ts` | replace `await allRenewed` with immediate `renewed:` snapshots | a crash child uses production leases and renewal, and only the exited child has its records expired | 1 file, +2/-1 / empty |
| `test/store/drain-bodies.ts` | cleanup before awaiting complete bodies | teardown keeps a delayed body and its own scenario alive through its final state read | 1 file, +2/-1 / empty |

The parent permitted temporary production mutation only for changed tests when a fixture control cannot neutralize the property. The only production mutation was the expiry-extension control above; `src/` has no delivered diff. No real library defect was found.

## Gates

Final local gates: Bun 1.4.2, TypeScript 7.0.2, Biome 2.5.14:

- `bun run build`: passed; installed-range check covered 12 dependencies, TypeScript build exited zero.
- `bun run typecheck`: passed; TypeScript exited zero.
- `bun run lint`: passed; 212 files, no fixes.
- `bun run format:check`: passed; 212 files, no fixes.
- `bun test --reporter=junit --reporter-outfile=test-results.xml`: 1096 pass, 11 skip, zero failures, 24883 assertions.
- `bun scripts/check-sources.mjs docs/sources.md test-results.xml`: 1090 cells parsed and matched.

Additional Linux CI-runtime gates: build, typecheck, lint and format passed; the optional full suite had the unrelated RPC failure documented above, so its chained source check was not reached. The required source check passed locally. An initial local typecheck before building failed on missing self-package `dist` exports; building first resolved it without source changes.

The JUnit result is deleted before commit. Remaining test-runner watchdogs still bound broken barriers; no fixture can guarantee wall-clock completion under arbitrary OS suspension. The repairs remove elapsed-time decisions from the three identified fixture outcomes, not the runtime's safety watchdog.
