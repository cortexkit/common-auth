# Round 3: transport caps and an actual debounce burst

Base: `5babf7aaff8343f75bbfa67279ef2f1c9a246807`. Two tests repaired; the other five named cases remain unchanged. No production changes, timeout increases, retries, or added skips. Existing test names and provenance rows remain valid. Read the prior `REPORT.md` and `FOLLOWUP.md` before tracing these cases.

## Mechanisms and dispositions

### 1. RPC: bounds headers and response bodies before EOF — fixed

`src/rpc/rpc-client.ts:48–58` starts a total call deadline and destroys the socket on settlement. Its data handler rejects headers over 16 KiB (`:94–98`) and bodies over 8 MiB (`:128–129`). The fixture sends an oversized response but never ends the connection. The former `<100 ms` check tried to distinguish size rejection from the 150 ms deadline, but measured port discovery, filesystem work, connection establishment and scheduling too. It could fail even when the data guard worked; elapsed duration is not direct evidence of which settlement path ran. Linux baseline reproduced the strict elapsed assertion, including unloaded 111/129 ms on 1.3.14 and 123/146 ms on 1.4.2.

The helper now awaits the server socket's actual `close` event rather than sleeping 20 ms. Only the bounds case holds the RPC deadline callback using a test-only global timer spy: exactly the 150 ms call is intercepted; other delays pass through to the original timer. A harmless zero-delay timer supplies a cancellable real handle, but the deadline callback is never invoked. Each exchange asserts exactly one intercepted deadline. The peer supplies neither EOF nor reset; fallback and client-initiated closure must therefore occur from received data, not timeout. This does not raise the production or runner budget; it substitutes a controlled timer for this size-limit proof. The stalled-response test still exercises the real 150 ms deadline. Spies restore in `finally`, along with socket/server cleanup.

Negative controls individually remove the header and body caps; each makes the bounds test alone fail at its unchanged 5000 ms runner deadline. The body control completes the header iteration first (three assertions), proving it reaches the second payload. Without either guard, the peer deliberately stays open and the held deadline cannot rescue the test. These controls are isolated child test runs; the runner terminates them rather than leaving their intentionally unresolved exchange in a later suite.

### 2. Watcher: debounces bursts into few callbacks — fixed

`src/tui-prefs/watcher.ts:32–38` clears the previous 150 ms debounce timer per directory event. Independently, `:61–72` polls every 100 ms, reporting changed file text (`:26–31`). The old fixture did five sequential **awaited** locked preference writes (`src/tui-prefs/tui-preferences.ts:81–88,112–120`), then slept. Five writes are not necessarily one debounce burst: scheduler/disk delays can carry them across multiple poll or debounce windows. Five callbacks are consistent with five separately observed states, even with correct event debounce. The historical macOS failure's exact poll/event sequence is not recorded; the mechanism is traced, not a reconstructed execution trace.

Use the existing `watchDirectory` injection to capture its event listener. Synchronously write five states and deliver five events while the watcher timers are manually held. Test-only spies on `node:timers` intercept only delays 100 and 150; every other delay and non-fixture handle passes through. Assert six timer calls (one poll, five debounces), four cancellations and exactly one surviving debounce. Fire that timer and await `onChange`, requiring exactly one callback. Fire the independent poll afterward and await its rescheduling, which happens only after the asynchronous read finishes; require seven total calls and still exactly one change callback. This separates burst coalescing from polling intermediate contents, without removing either path. The assertions explicitly establish that the already imported named ESM timer bindings were intercepted on both Bun versions, rather than assuming spies affect imports. Dispose and restore both spies in `finally`.

The stricter exactly-one/cancellation assertions replace the former `<5` approximation because the fixture now delivers a defined burst, not five asynchronously spaced writes. No test name changed meaning: coalescing remains the property. Removing `clearTimeout` from the debounce scheduler yields exactly this test red, `Expected: 4; Received: 0` cancellations.

### 3. 512 plain stale-lock contentions — unchanged

The test at `test/fs/refresh-file-lock.test.ts:784–806` serially performs **512 rounds**, each writing a stale record, awaiting two concurrent try-once acquisitions, requiring one winner, then awaiting release. `src/fs/refresh-file-lock.ts:151–179,219–239,390–440` uses exclusive creation, stale checking, exclusive eviction-marker acquisition, marker ownership fences and exclusive recreation. There is no correctness sleep to replace; every operation is already awaited. Its 30 s budget covers many real filesystem calls. A one-second lease also remains a potential susceptibility to extreme pauses, though it was not implicated in these VM runs.

The reported 30 s macOS exhaustion at load ~35 was not reproduced and remains **untraced as a specific historical cause**. Replacing disk operations with mocks, reducing 512 rounds, or splitting them into separately budgeted tests would not demonstrate a host-speed-independent repair of the same aggregate test. Keep all 512 elections and the 30 s budget. No fix and no negative control claimed.

### 4. Command menu roster section — unchanged, historical cause untraced

`test/commands/sections.test.ts:60–85` awaits real population, disable and menu opening with a fixed fixture clock. `src/commands/builtins.ts:233–284,660–670` reads the store snapshot and maps the roster into lines, details and actions. No negative timer window, missing event barrier, or unawaited menu step was found. These persistence operations can be slower on a busy host, but that is not a trace of the reported 5.6 s event. No reduction in persistence coverage, timeout change or speculative fixture rewrite. No fix/control claimed.

### 5a. Two known identities do not overlap provider calls — unchanged; missing attempt seam

`test/store/refresh.test.ts:330–369` parks A inside its provider callback, starts B with a different row identity, checks non-settlement and no B callback in a 300 ms window, releases A, then awaits both and verifies row/provider lock names. The shared provider-wide lock, not row identity, serializes the calls (`src/store/refresh.ts:156–163,217–222`; `src/store/pool.ts:342–348`). `src/store/refresh-lock.ts:26–35,89–127` uses a 10 s lease, 15 s acquisition budget and 50 ms retry plus jitter. Its `onLockEvent` only reports acquired/released; `onLockStep` exposes renewal/release/stale-takeover steps, not a failed attempt on a live lock. A live-lock observation returns null before those steps (`src/fs/refresh-file-lock.ts:390–396`).

Neither B's earlier row acquisition nor a pre-attempt hook proves B actually encountered the occupied provider lock. Needed seam: an awaited `onLockEvent({ event: 'contended', name, path })` after a real try-once returns null because the observed owner is live, before retry sleep. Then keep A parked until B reports provider-lock contention, assert B's provider has not entered, release A and await completion. A direct observer that reports the live-owner rejection from the underlying lock would be even more precise. No source changes allowed, so stop this repair at the exact seam request rather than replace the 300 ms window with a weaker assertion. The historical 9.7 s runtime is untraced. No fix/control claimed.

### 5b. Legacy state writer waits and preserves both writes — unchanged; missing attempt seam

`test/store/rows.test.ts:450–478` pauses the library `add` at the awaited `before-state-write` hook while it owns store locks, starts the vendored `saveAccountState`, makes the same 300 ms negative judgment, then releases and checks both writes survived. Library transactions acquire config then state save locks (`src/store/pool.ts:319–322`; `src/store/mutate.ts:417–440`). The vendored writer acquires the state's save lock before read/merge/write (`test/fixtures/legacy-openai-auth/accounts.ts:1721–1786`), using its own polling acquisition (`:1086–1109`). It has no failed-live-lock-attempt observer. Library hooks cannot observe the legacy contender.

Needed seam: a test-observable, awaited contention callback in the vendored state-save lock acquisition loop after a real failed attempt observes the live owner, before retry sleep. Await that while the library writer stays paused, then assert the legacy write is incomplete before releasing the library barrier. Do not merely wait for a pre-acquire notification or remove the waiting assertion; neither proves the attempted exclusion. Leave unchanged rather than modify the vendored reference's lock contract or add a production seam. Historical 11.5 s remains untraced. No fix/control claimed.

### 6. Logger rotation — unchanged, historical cause untraced

`test/logger/engine.test.ts:357–372` synchronously seeds a real 5 MiB file and three generations, chmods them, logs and calls `flushLogs()`, then verifies size, retained generation bytes, deletion of generation four, and all private permissions. `src/logger/engine.ts:94–117,179–210` rotates synchronously by stat/rename/chmod and appends buffered text. The 500 ms background timer is cancelled by explicit flush; the test does not wait for it. No async race, lock wait, correctness sleep or retry seam explains the 5.7 s macOS run. Sparse-file setup might reduce setup I/O, but would be an optimization without a traced cause, not a barrier repair. Leave the real fixture and assertions intact. No fix/control claimed.

## Linux measurements

All sustained load ran only on `tester@2.28.133.11` in `/home/tester/common-auth-round3`, using `scripts/load-probe.mjs`. Eight online CPUs, 16 CPU busy-loop processes; probes run sequentially. Both explicit runtimes were exercised: `~/rt/bun-1.3.14/bun` and `~/rt/bun-1.4.2/bun`. Source transferred with `git archive HEAD | ssh ... tar -x`; frozen VM install with Bun 1.3.14 installed 754 packages, no manifest or lock changes. Baseline uses the base tests; final replaces only the two repaired test files. No sustained load on the Mac. Natural means zero injected workers, not a guarantee that the shared VM has no ambient activity.

`round3-probes.sh` records the exact file/name matrix and invocation (5 natural, 10 loaded per case/runtime/phase). Raw output remains on the VM as `{baseline,final}.{version}.{workers}.{case}.jsonl`. `round3-counts.json` contains all 56 summaries and subprocess-duration ranges. Counts below are **passes/runs**, not omitted failures. For unchanged cases, “after” is remeasurement, not a repair claim.

| Case | Bun | Natural before | Natural after | Loaded before | Loaded after |
| --- | --- | --- | --- | --- | --- |
| RPC bounds | 1.3.14 | 3/5 | 5/5 | 0/10 | 10/10 |
| RPC bounds | 1.4.2 | 3/5 | 5/5 | 2/10 | 10/10 |
| Watcher debounce | 1.3.14 | 5/5 | 5/5 | 10/10 | 10/10 |
| Watcher debounce | 1.4.2 | 5/5 | 5/5 | 10/10 | 10/10 |
| 512 stale elections | 1.3.14 | 5/5 | 5/5 | 10/10 | 10/10 |
| 512 stale elections | 1.4.2 | 5/5 | 5/5 | 10/10 | 10/10 |
| Command roster | 1.3.14 | 5/5 | 5/5 | 10/10 | 10/10 |
| Command roster | 1.4.2 | 5/5 | 5/5 | 10/10 | 10/10 |
| Provider exclusion | 1.3.14 | 5/5 | 5/5 | 10/10 | 10/10 |
| Provider exclusion | 1.4.2 | 5/5 | 5/5 | 10/10 | 10/10 |
| Legacy writer | 1.3.14 | 5/5 | 5/5 | 10/10 | 10/10 |
| Legacy writer | 1.4.2 | 5/5 | 5/5 | 10/10 | 10/10 |
| Logger rotation | 1.3.14 | 5/5 | 5/5 | 10/10 | 10/10 |
| Logger rotation | 1.4.2 | 5/5 | 5/5 | 10/10 | 10/10 |

RPC before/after failure improvement is observed. Watcher historical failure did not reproduce here; the source/fixture timing dependency is eliminated rather than a failure-rate improvement claimed. VM results do not explain non-reproduced macOS wall durations.

## Negative controls and restoration

Parent explicitly authorized **temporary source mutants for red controls only**, one at a time, restored before commit. Live implementation was staged first; `git diff --stat` was empty before each mutation. Each mutant included `NON-VACUITY BREAK`. Natural macOS Bun 1.4.2 runs, no injected load:

| Mutated file/change | Exact reddened test | Captured failure | Working diff during / after checkout + touch |
| --- | --- | --- | --- |
| `src/rpc/rpc-client.ts`: header cap compared to Infinity | raw RPC transport bounds headers and response bodies before EOF | 0 pass, 3 filtered, 1 fail; timed out after 5000 ms (5001.82 ms) | 1 file, +2/-1 / empty |
| `src/rpc/rpc-client.ts`: body cap compared to Infinity | raw RPC transport bounds headers and response bodies before EOF | 0 pass, 3 filtered, 1 fail; 3 assertions; timed out after 5000 ms (5002.09 ms) | 1 file, +2/-1 / empty |
| `src/tui-prefs/watcher.ts`: remove previous debounce clearTimeout | debounces bursts into few callbacks | 0 pass, 7 filtered, 1 fail; Expected 4, Received 0 cancellations | 1 file, +1/-1 / empty |

Only the named test ran in each control; other tests were filtered, not presented as passing controls. None of the runs hung: Bun exited nonzero. Source diff restored empty after each; no source changes committed.

## Final gates and limitations

Natural macOS Bun **1.4.2**, TypeScript **7.0.2**, Biome **2.5.14**:

- `bun test test/rpc/client-transport.test.ts test/tui-prefs/watcher.test.ts`: **12 pass, 0 fail**, 44 assertions.
- `bun run build`: passed, 8 local manifests and 12 dependency ranges checked; TypeScript build exit zero.
- `bun run typecheck`: passed, `tsc --noEmit` exit zero. Initial pre-build run exposed generated self-export resolution gaps and the new timer spy overload typing errors; building and fixing the explicit timer function signatures resolved them before final gates.
- `bun run lint` and `bun run format:check`: passed, **216 files** at the complete test-gate run; no fixes. Research artifacts added afterward receive another lint/format gate; the repository's Biome configuration excludes `research/`, so those artifacts are checked by JSON parsing and shell syntax instead.
- `bun test --reporter=junit --reporter-outfile=test-results.xml`: **1102 pass, 11 existing skips, 0 fail**, 7057 assertions, 1113 tests across 94 files; one run, no retry. All seven requested cases passed.
- `bun scripts/check-sources.mjs docs/sources.md test-results.xml`: **1096 cells parsed, 1096 matched**. No test names or provenance rows added or removed.
- `aft_inspect` on both changed tests: authoritative diagnostics, **0 errors, 0 warnings**; Tier-2 analysis unavailable in this worktree.
- `bash -n research/load-probe/round3-probes.sh`: shell syntax passed; Python JSON verification parsed **56 summaries**, checked all 56 pass/fail totals. Final lint/format rerun again checked **216 files**, no fixes. A direct Biome format attempt on the JSON reported it ignored by configuration; no formatting check is claimed for excluded research artifacts.
- Comment review: five blocks / nine lines across three changed files, none flagged after clarifying that probe workers saturate CPUs.

JUnit scratch is deleted after source verification. No load logs or installed dependencies copied back to the Mac. Store contention repairs require the named missing seam; the other unchanged cases are deliberately not claimed fixed.
