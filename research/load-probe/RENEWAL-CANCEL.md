# Pending renewal timer cancellation

## Design note for source review

- **Shape:** the optional primitive `onStep` union adds `renewal-scheduled` and `renewal-cancelled`. These are string notifications, without an owner ID, timer handle or cancellation reason. Store `onLockStep` consumers forwarding primitive steps also see the widened union.
- **Emission sites:** `src/fs/refresh-file-lock.ts:414` emits scheduling after the timer is armed and unreferenced. `:111` emits cancellation after clearing the pending timer at `:109` and nulling its handle. Loss calls this helper at `:129`; release calls it at `:523`. Timer entry at `:334` nulls the handle so an in-flight attempt is not mislabeled as a pending timer cancellation.
- **Delivery:** synchronous invocation, never awaited. The helper at `src/fs/refresh-file-lock.ts:91–105` catches synchronous throws and absorbs returned promise/thenable rejections using the same narrowing and rejection-isolation pattern as the unchanged contention seam. Unreturned asynchronous work remains the observer's responsibility. Existing other `onStep` steps retain their awaited semantics.
- **Guarantee:** every armed renewal timer emits scheduling; clearing a still-pending timer on loss or release emits cancellation after the real clear call. Repeated loss/release cannot cancel the same pending timer twice. Normal release still does not resolve `whenLost()`. A fired timer is no longer pending, even while its renewal operation is in flight.
- **Limits:** scheduling does not promise the timer remains pending at a later point, and cancellation does not announce completion of an in-flight attempt. No timing, interval, lease, retry or join ordering changes. These observations cannot prove the absence of all future work by themselves; tests also capture the real timer calls. Exhaustive consumer switches can break on the widened union, documented in `docs/adoption-inventory.md`. Observers must explicitly filter unfamiliar steps rather than interpret them as completion.
- **Fast path:** absent observers and non-thenable callback results create no promises or extra scheduled work. The two new notifications do not introduce awaited pauses.

Source-only review commit: `fbb7c71` (only `src/fs/refresh-file-lock.ts`). The anthropic-auth and antigravity-auth integration reviewers (ANTAUTH and AGAUTH) should review that diff before integration. Main's test-only context was merged as requested (`3a66537e20aa6a5c98abdc1d6b74cbb36cd7b276`); the supplied seam base lacked ROUND4.md and its phase clocks. The contention seam is unchanged.

## Causal cancellation test

`assertion loss cancels a pending renewal timer` no longer guesses that renewal has not fired by using a 50 ms interval, or guesses cancellation by waiting 120 ms. It launches a fresh Bun child (`test/fixtures/renewal-timers.ts`) which captures the real global timer calls **before importing** the primitive that binds them, delegates to real timers, and restores the globals immediately after import. A fresh child avoids the ordinary fs entry point's cached bindings and avoids shared-suite global changes. An attempted same-process URL-query module instance did not isolate Bun's cached bindings, so it was replaced rather than reported as valid evidence.

The renewal interval is 60,000 ms, with a 120,000 ms lease. The child awaits scheduling, captures one pending timer with zero clears/completions, writes the successor, and captures the same precondition immediately before `assertOwned()`. It records the ownership error, awaits cancellation, and captures zero pending timers, one actual clear and zero completions, plus takeover loss details. The parent asserts all three snapshots. This checks both the notification and actual clear path rather than trusting an event emitted alongside a missing clear. The long interval prevents ordinary setup racing renewal; the captured precondition still detects an extreme setup pause that does let it fire. The proof is clearing a real pending one-shot timer, not an unbounded empirical claim that nothing ever executes again.

The same named test runs normal, synchronous-throwing, returned-rejection and never-settling observer modes. The latter three resolve each notification before returning their failure/pending result; they verify the new notifications are isolated and not awaited. Parent lifetime teardown kills an outstanding child and joins its exit and both streams. The parent's wait is `observed()`, so suppressing a notification fails through cancellation at the existing runner deadline instead of hanging. A child keepalive exists only so a missing notification cannot silently exit successfully; it is cleared on normal cleanup. No timeout increase, skips, test retries, or timer virtualization.

## Cancellation controls

Both source controls were applied individually after staging the live test/docs/fixture state and confirming an empty working `git diff --stat`. Each temporary deliberate defect was marked `NON-VACUITY BREAK` to distinguish it from live implementation, selected only the named cancellation test on Bun 1.4.2, and restored using `git checkout -- src/fs/refresh-file-lock.ts && touch src/fs/refresh-file-lock.ts`, with empty working diff afterward.

| Control | Result |
| --- | --- |
| Remove the real `clearRefreshLockRenewalTimeout(renewTimer)` call, retaining cancellation emission | exit 1; only `acquireRefreshFileLock > assertion loss cancels a pending renewal timer` failed, 16.43 ms. `afterCancel` actually has pending=1, cleared=0 instead of pending=0, cleared=1. 0 pass / 20 filtered / 1 fail. |
| Remove `notifyTimerStep('renewal-cancelled')`, retaining the real clear | exit 1; the same test failed at 5013.16 ms, with `Late test body failure: assertion loss cancels a pending renewal timer` and `Expected observation was not received before test cancellation`. 0 pass / 20 filtered / 1 fail; child killed, no hook overrun/hang. |

Each mutated stat was `src/fs/refresh-file-lock.ts | 2 +-`, one insertion/one deletion; each restored stat was empty. Raw control output: `/tmp/renewal-{clear,emission}-control.log` on the Mac. Other tests were filtered, not claimed to be passing controls.

## Per-call election marks and measured overhead

The 512-round test retains every assertion, all 512 rounds and its 30 s budget. Existing `phaseClock.span()` records start/end in `finally` around stale-record writing, contender A acquisition, contender B acquisition, and winner release. The acquisitions are still launched together, not serialized. On an overrun the last unmatched start identifies the pending call(s); settled rejection also receives an end. The marks diagnose cost, not a correctness deadline. A blocked event loop can delay the diagnostic timer itself.

Natural Mac measurements, Bun 1.4.2, zero injected workers: exactly three runs with the added spans followed by three without them. The unmarked measurement copy omits only the new spans, retaining old round clocks and all work/assertions. It was restored from the staged live test with checkout + touch; nonempty stat during measurement (23 lines, 8 insertions/15 deletions), empty afterward. No measurement mutant remains.

| Instrumentation | Test body ms (three runs) | Mean ms | Mean per round ms |
| --- | --- | ---: | ---: |
| Added per-call marks | 1101.09, 677.75, 705.34 | 828.06 | 1.6173 |
| Original round-only marks | 569.59, 788.19, 938.63 | 765.47 | 1.4951 |

Observed difference: **62.59 ms per 512-round test**, **0.12225 ms per round**, about **8.18%** of the unmarked sample mean. Each run exits 0, with 512 assertions. This is a six-run sequential sample including uncontrolled filesystem/scheduling noise, not an isolated CPU microbenchmark or confidence interval; the overlapping distributions do not establish a stable causal overhead estimate. Eight extra timestamp/event records per round (4096 per test) and span promise continuations are added. No successful trace output is enabled for these measurements. Raw files: `/tmp/renewal-{marks,no-marks}-natural.jsonl`; exact exits, subprocess/test durations and means are preserved in `renewal-counts.json`.

## VM loaded renewal runs

Dedicated load-test host `tester@2.28.133.11`, separate source/install directory `/home/tester/common-auth-renewal-bg2671` so these tests do not modify another worker's checkout. Source snapshot transferred with `git archive HEAD` plus the changed test/fixture/docs. Bun 1.3.14 frozen install: 754 packages, no manifest/lockfile changes. Node 24.16.0 prepended to PATH. Runtime groups sequential; no generated load on the Mac.

For each runtime 1.4.2 and 1.3.14:

```sh
TEST_BUN="$HOME/rt/bun-$version/bun" "$HOME/rt/bun-$version/bun" \
  scripts/load-probe.mjs test/fs/refresh-file-lock.test.ts \
  'assertion loss cancels a pending renewal timer' 20 16 \
  > "renewal-loaded-$version.jsonl"
```

Both probe exits 0; **20/20 successful subprocesses per runtime**, 16 busy-loop workers, one selected test/12 assertions in each subprocess. Bun 1.4.2 test duration range 120.70–176.68 ms (mean 153.93); Bun 1.3.14 range 303.65–681.09 ms (mean 433.07). These samples do not estimate a tail failure rate. Raw files remain on the VM and copied to Mac `/tmp/renewal-loaded-{1.4.2,1.3.14}.jsonl`; `renewal-counts.json` preserves all 40 exits and durations. Probe summaries and every runner exit were checked, not pass-string matching alone.

## Gates

Exit-code gated against the source/install directory on the VM described above, with Bun 1.4.2, TypeScript 7.0.2, Biome 2.5.14 and Node 24.16.0:

- `bun run build`: exit 0; 6 local manifests and 12 installed ranges checked; TypeScript build passed.
- `bun run typecheck`: exit 0, `tsc --noEmit` silent success.
- `bun run lint`, `bun run format:check`: exit 0, each checked 232 files, no fixes.
- `bun test --reporter=junit --reporter-outfile=renewal-results-1.4.2.xml`: exit 0; 1136 pass / 10 existing skips / 0 fail; 1146 tests across 99 files, 5064 assertions, 64.80 s.
- `bun scripts/check-sources.mjs docs/sources.md renewal-results-1.4.2.xml`: exit 0; 1129 test-title cells from `docs/sources.md` parsed and matched against passing JUnit test cases.
- `~/rt/bun-1.3.14/bun test --reporter=junit --reporter-outfile=renewal-results-1.3.14.xml`: exit 0; 1136 pass / 10 existing skips / 0 fail; 1146 tests across 99 files, 5064 assertions, 73.42 s.
- `~/rt/bun-1.3.14/bun scripts/check-sources.mjs docs/sources.md renewal-results-1.3.14.xml`: exit 0; 1129 test-title cells from `docs/sources.md` parsed and matched against passing JUnit test cases.

Raw gate log copied to Mac `/tmp/renewal-vm-gates.log`; JUnit remains in the VM snapshot, not committed. Local narrow test file previously passed 21 tests / 590 assertions before expanding observer modes; final cancellation test passes with 12 assertions. An initial fixture prototype failed typecheck and its pending-timer assertion due to cached module bindings; the fresh-child implementation resolved those errors, and final gates above include it. No package manifests or dependency lockfiles changed. Research artifacts are outside Biome's configured scope. Final scoped AFT diagnostics cover all three TypeScript files with 0 errors/0 warnings (five pre-existing await hints); optional Tier-2 metrics unavailable. Comment review found no unclear code comments; report prose was clarified to define integration reviewers, deliberate control labels, source-directory isolation and source-cell matching.
