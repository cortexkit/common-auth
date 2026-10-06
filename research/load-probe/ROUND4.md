# Round 4: stale-election workload and quota-action phase diagnostics

Base: `28e9d0ded7adb074a3d1a10a38c13fac66082ad4`. No production code, election-round count, test timeout, retry behavior, or skipped tests were changed. The two existing tests retain their names, assertions, real filesystem work and budgets. Logger rotation is outside this change.

## Historical failures: what the raw evidence actually says

Read-only evidence from the independent anthropic-auth integration worker (ANTAUTH)'s full-order run of the base common-auth suite: `/Users/ufukaltinok/Work/Projects/CortexKit/anthropic-auth/.cortexkit/alfonso/probes/common-auth-095-source-28e9d0d/parent-full.stderr.log`:

```text
919: (fail) acquireRefreshFileLock > elects one owner across 512 plain stale-lock contentions [35007.76ms]
920:   ^ a beforeEach/afterEach hook timed out for this test.
921: Late test body completion: elects one owner across 512 plain stale-lock contentions
943: Late test body completion: Check quotas polls each account once and prints its windows from the store
944: (fail) account actions > Check quotas polls each account once and prints its windows from the store [8942.17ms]
945:   ^ this test timed out after 5000ms.
```

The stale-election failure is an overrunning owned body joined by teardown, not a reported acquisition exception or assertion failure. The test has a 30 s body budget and Bun's default 5 s afterEach budget. `lifetimeHooks` registers the body with `runnerBody` and its afterEach runs `lifetime.drain` before directory deletion (`test/fixtures/lifetime-hooks.ts:43–58,89–93`). Drain marks the lifetime closing and joins tracked bodies before finalizers/cleanup (`test/fixtures/test-lifetime.ts:119–145`, `test/fixtures/drain-bodies.ts`). `Late test body completion` is emitted only when the body succeeds after that closing flag (`test-lifetime.ts:17–23`). Its appearance after the hook failure, and the ~30+5 s duration, confirm the body was still completing through teardown's budget. There is no `Waiting for previous test body` or late body failure for this case in the raw log. This explains the hook attribution; it does **not** identify the particular slow filesystem call or rule out a long scheduling pause inside a call. No historical per-round clocks existed.

Quota likewise finished late without a late assertion error. The raw run has no poll/write/print clocks, so the particular phase responsible for its historical 8.942 s remains untraced. New measurements below must not be represented as a reconstruction of that run.

## A. What the 512 elections search for; proposal: keep 512 for now

Each round plants an expired plain lock, launches two try-once acquisitions concurrently, requires exactly one non-null winner, and awaits its release. All 512 per-round assertions are retained. The source's exclusive `wx` creation (`src/fs/refresh-file-lock.ts:151–179`) first fails against the stale file. The acquisition loop (`:390–435`) then checks liveness, creates an exclusive eviction-marker directory and owner file, checks liveness again under that marker, checks marker ownership before and after deleting the stale lock, recreates exclusively, and checks marker ownership after recreation. Marker creation/recovery uses `:219–264`; a missing/renamed marker or failed marker creation can lead to a 0–3 ms retry backoff (`:182–186`). That is algorithm cadence, not a test correctness sleep.

The 512-round stale-lock contention test can encounter these acquisition orderings, but no runnable deterministic test at commit `28e9d0d` forces them:

1. Both contenders observe the original stale lock and race to `mkdir` the marker: one owns it and the other observes a fresh occupied marker and returns null.
2. A contender observes staleness before the other wins the marker and replaces the lock; its second liveness check must see the new live owner rather than delete it.
3. A contender's top-of-loop exclusive creation occurs in the gap after the marker holder removes the stale file but before the holder recreates it. The contender can win directly; the marker holder's exclusive recreation must then fail, yielding only one owner.
4. A delayed contender sees the newly live lock after the marker holder recreates it or releases the marker, rather than treating its earlier stale observation as permission to remove the successor.

The four stale-acquisition orderings above are permitted schedules, **not observed schedule counts**: neither the old test nor the round clocks identify which happened. Extreme pauses can additionally expire the marker or the 1 s winning lease, exposing marker-recovery/theft paths; normal plain rounds do not intentionally age a marker, so they are not deterministic coverage of theft during marker-owner publication or the post-recreation ownership fence. Future seam tests should also force those paths, rather than assume 512 random repetitions visited them.

Existing deterministic tests force renewal/release marker theft (`does not let a stalled renewal overwrite a successor that stole its marker`, `does not let a stalled release remove a successor that stole its marker`) and renewal write-fence/post-write races. They do not force the four acquisition orderings above. `test/fs/with-lock.test.ts:101–131` observes `eviction-marker-acquired` and checks identity/private bytes, but does not park one contender against another. Missing-parent contention is also unforced and has no stale record. Archived `research/kernel-lock/results/repo-tests.xml` names successor-safety and exclusion tests; their source files are absent from the runnable `test/fs` at this base, so that XML is not current deterministic coverage.

History: both `git log --all -S 'elects one owner across 512 plain stale-lock contentions' -- test/fs/refresh-file-lock.test.ts` and `git log --all -S '512' -- test/fs/refresh-file-lock.test.ts` locate `5e5edcb8bd1fa3b60d18b1c7cac1db809955e82f`. Its message says it ported the supplied generation-fenced lock and raised the **unchanged** 512-round test budget to 30 s after a loaded runner exceeded 5 s. It does not explain an original statistical rationale for 512. The read-only reference in the consuming OpenAI authentication plugin, openai-auth, at `packages/core/src/tests/refresh-file-lock.test.ts:18–43` uses 128 and comments that 512 exhausted 5 s at load average 30. That is a workload tradeoff, not proof of equivalent coverage here.

**Proposal (not applied): keep 512 until the stale-acquisition orderings have deterministic seam-driven coverage.** Faster completion or matching openai-auth is insufficient justification for reducing the only repeated stale-acquisition race search. Its count is a cost/benefit choice, not a host-speed-independent correctness mechanism. A deterministic follow-up should make each ordering above happen and carry targeted exclusion controls; then 128 can reasonably be evaluated as a smoke backstop while retaining every per-round assertion. No claim that 512 establishes any quantified detection probability, or that these clocks fix the budget sensitivity.

## B. Quota action: real work, no missed correctness window found

`test/auth-menu/accounts.test.ts` seeds two accounts with two sequential store adds, opens the real menu and awaits it, then awaits the final store read. The mock poll contains no fetch, delay, polling loop or network work: A immediately returns its observation and B immediately throws `HTTP 503`. `checkQuotasAction` (`src/auth-menu/accounts.ts:361–411`) reads rows, sequentially polls/records each usable row, re-reads the stored rows, then prints their quota windows and per-account errors.

Each fresh OAuth add acquires row, provider-wide, then config/state save locks, writes state and config atomically, and releases locks (`src/store/rows.ts:506–514,618–649`, `src/store/mutate.ts:417–442`, `src/store/pool.ts:319–322`). Successful `recordQuota` takes config/state store locks and commits config once (`src/store/attribution.ts:56–105`). B's failed poll does not write a quota. Thus this fixture performs **five persisted file writes**, real lock acquisition/release, roster reads, and formatting. Lock retries sleep only if contention is encountered (50 ms plus jitter; `src/store/refresh-lock.ts:26–35,116–128`); our clocks do not assert that contention occurred.

The fake terminal delivers the four down keys and Enter on separate zero-delay timer turns so the selector can redraw (`test/auth-menu/helpers.ts:37–65`). These are event-delivery turns; menu completion is actually awaited, not judged after a fixed sleep or a positive polling window. Bypassing navigation would reduce exercised behavior without repairing a traced timing defect, so navigation remains. No missed fixed correctness wait or unobserved positive window found; no sweep-style repair/control is claimed. Budget remains 5000 ms.

### Failure-only phase clocks

`test/fixtures/phase-clock.ts` captures relative monotonic timestamps and prints only on failure or budget overrun. A budget timer emits an in-progress snapshot if Bun abandons the body before its finally runs; finally emits the completed failure/overrun trace and clears the timer. These clocks do not decide correctness or extend any deadline. For elections, round start/end identify completed-round cost and the current unfinished round. For quota: store add/read/recordQuota entry/exit, per-account poll entry/exit (including rejected B), store `onStep` write points, every terminal write, menu entry/exit and final verification read. Print traces cover both redraws and the final five quota lines.

**Write-clock interpretation:** store `before-*-write` is inside atomic writer's pre-rename callback, after staging, not the start of serialization/staging I/O (`src/store/mutate.ts:345–360`). Its paired `after-*-write` measures the ownership fence/rename tail. Outer store operation spans include staging, lock acquisition and release. Do not equate the small rename-tail intervals with total persistence cost. Poll spans include promise settlement; terminal write spans include capture of bytes in the fake terminal, not a physical terminal.

## Measurements

Natural runs only on this Mac, Bun **1.4.2**, **zero** injected workers. Loaded runs only on `tester@2.28.133.11`, isolated `/home/tester/common-auth-round4-bg753`, `scripts/load-probe.mjs`, **16 workers**, sequential case/runtime probes using explicit `~/rt/bun-1.3.14/bun` and `~/rt/bun-1.4.2/bun`. Three fixed samples per cell, not retries. VM install: Bun 1.3.14 frozen lockfile, 754 packages, no manifest/lock changes. In measurement copies only, the phase-clock `if (!succeeded || performance.now() - started >= budgetMs)` print condition was temporarily replaced with `if (true)` to collect successful traces; local fixture was staged before modification and restored with checkout + touch, empty working diff afterward. The committed fixture is failure-only. Successful measurement trace labels/reasons are not failure verdicts; **runner exit codes** determine the table.

Raw VM JSONL remains in the isolated VM directory as `loaded.{version}.{elections,quotas}.jsonl`. Natural raw files are `/tmp/bg753-natural-{elections,quotas}.jsonl`. `round4-probes.sh` records loaded invocations. Natural invocation uses the same file/name, `3 0` instead of `3 16`. `round4-summarize.py` parses those six JSONL files and verifies each summary's run/failure totals; `round4-counts.json` preserves every run's exit code and body duration, all completed-round aggregates and complete quota traces. Measurements include tracing overhead. These small samples do not estimate a tail failure rate.

### Election per-round cost (milliseconds)

Body times are from first clock creation through final trace; subprocess times additionally include Bun setup and lifetime drain. All samples completed 512 rounds.

| Host / Bun / workers | Passes | Body ms (three runs) | Round mean ms (three runs) | Round median ms (three runs) | Maximum round ms (three runs) |
| --- | --- | --- | --- | --- | --- |
| Mac / 1.4.2 / 0 | 3/3 | 8204.429, 6828.459, 7120.880 | 16.000, 13.325, 13.897 | 5.452, 5.325, 6.431 | 700.950, 1480.156, 223.416 |
| VM / 1.3.14 / 16 | 3/3 | 2923.901, 2105.537, 1639.682 | 5.682, 4.109, 3.180 | 0.752, 0.732, 0.754 | 178.755, 103.824, 121.995 |
| VM / 1.4.2 / 16 | 3/3 | 5558.935, 847.680, 528.381 | 10.853, 1.653, 1.030 | 0.947, 0.906, 0.852 | 128.772, 17.669, 13.029 |

The 30 s aggregate budget allows about 58.6 ms per round on average, before runner/setup/drain overhead. Real costs and outlier rounds vary substantially even without generated local load. None reproduced the historical overrun. The faster loaded VM does not imply load improves performance; different filesystems/hosts and ambient scheduling make cross-host comparisons uncontrolled.

### Quota phase costs (milliseconds, min–max across three samples)

| Host / Bun / workers | Passes; body range | Add A | Add B | Poll A / B | Record A | Menu including polls/writes | All terminal writes summed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Mac / 1.4.2 / 0 | 3/3; 43.516–392.801 | 14.923–42.346 | 10.970–249.601 | .031–.039 / .026–.035 | 5.110–87.784 | 14.511–126.441 | .094–.137 |
| VM / 1.3.14 / 16 | 3/3; 268.530–647.158 | 142.369–234.047 | 4.188–86.166 | .050–.088 / .043–.103 | 6.080–164.298 | 79.001–321.894 | .114–.249 |
| VM / 1.4.2 / 16 | 3/3; 92.440–286.593 | 40.927–114.704 | 16.669–102.545 | .049–.058 / .048–.076 | 3.097–38.202 | 26.676–106.509 | .110–.148 |

Paired file-write tails (state A, config A, state B, config B, quota config A respectively): Mac .583–1.547 / .451–1.258 / .627–1.069 / .296–1.410 / .479–2.308 ms; VM 1.3.14 .255–28.868 / .143–.357 / .198–.256 / .238–.907 / .200–.218 ms; VM 1.4.2 .357–10.721 / .177–12.996 / .224–16.290 / .161–.351 / .199–12.438 ms. Store-read spans range .257–14.150 / .289–91.067 / .202–23.560 ms on these three configurations. Final verification reads range .173–1.234 / 1.728–16.782 / .372–9.466 ms.

The measured expensive phases are real store operations and awaited reads/navigation, not mock polling or printing. None reproduces 8.942 s. Report the historical phase cause as unknown; preserve these diagnostics for the next full-order failure rather than raising the budget or removing persistence/navigation coverage.

## Two-winner control and restoration

The task reviewer authorized temporarily changing exclusive lock creation to non-exclusive creation solely for this control, restored before delivery. Explicitly staged `src/fs/refresh-file-lock.ts` and confirmed empty `git diff --stat`, then changed the initial `tryAcquire` creation from `flag: 'wx'` to `flag: 'w'`, marked `NON-VACUITY BREAK`. This permits both real concurrent acquisitions to return owners, breaking actual exclusive creation (not merely changing an expected assertion). Run only:

`bun test test/fs/refresh-file-lock.test.ts --test-name-pattern 'elects one owner across 512 plain stale-lock contentions'`

Bun 1.4.2 exit **1**; exact red test `acquireRefreshFileLock > elects one owner across 512 plain stale-lock contentions`; `Expected length: 1`, `Received length: 2`; **0 pass, 20 filtered, 1 fail, 1 assertion**. Failure clock captured round 0 start and final failure. No other test failed; other tests were filtered, not passing controls. Working diff while mutated: `src/fs/refresh-file-lock.ts | 3 ++-`, 1 file, 2 insertions/1 deletion. `git checkout -- src/fs/refresh-file-lock.ts && touch src/fs/refresh-file-lock.ts` restored an empty complete working diff and empty `git diff --stat -- src/`. No source change committed. An initial identical control also exited 1 and was restored, then the documented control was repeated after explicitly staging the source path to meet the restoration protocol. This is a positive detection control, not proof that every stale-marker fence is defended; it reaches exclusive creation, not all four acquisition schedules.

## Gates (natural Mac, exit-code gated)

Bun **1.4.2**, TypeScript **7.0.2**, Biome **2.5.14**:

- `bun run build`: exit 0; 8 package manifests / 12 installed dependency ranges checked, TypeScript build passed.
- `bun run typecheck`: `tsc --noEmit`, exit 0 (silent success).
- `bun test test/fs/refresh-file-lock.test.ts test/auth-menu/accounts.test.ts`: **31 pass, 0 fail, 629 assertions**, 2 files. Both clocks silent on successful runs.
- `bun run lint` and `bun run format:check`: exit 0, **228 files**, no fixes.
- `bun test --reporter=junit --reporter-outfile=test-results.xml`: exit 0, **1123 pass, 11 existing skips, 0 fail, 5002 assertions**, 1134 tests across 98 files, 114.39 s; single run. No new skips.
- `bun scripts/check-sources.mjs docs/sources.md test-results.xml`: exit 0, **1117 cells parsed / matched**. No new test titles or provenance rows needed. JUnit scratch removed after checking.
- Scoped `aft_inspect`: authoritative diagnostics for all three changed TypeScript files, **0 errors / 0 warnings**, six existing await hints in the lock tests; Tier-2 unavailable.
- `bash -n research/load-probe/round4-probes.sh`: exit 0. Python summarizer parsed six probe groups / 18 runs and checked all six failure totals. Research artifacts are excluded from Biome; no claim of Biome checking those artifacts. Final lint/format rerun again checked 228 files without fixes; Python 3.9.6 parsed the summary script and verified six groups / 18 runs with all 512-round counts intact.
- Comment review: six code comment blocks / nine lines, no unclear code comments. Report prose was clarified to identify the independent integration run, reviewer authorization, plugin comparison and temporary output condition.

## Limitations and follow-up

Keep 512, unchanged budget. Add deterministic acquisition-race coverage before reconsidering a smoke count. Quota is instrumented, not declared repaired. Historical raw logs establish late body completion but lack the needed per-phase evidence. Do not infer a lock defect or a fixed wait solely from wall time. A severely blocked event loop can defer the clock's own overrun snapshot; finally still prints the completed trace when the body resumes.
