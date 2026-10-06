# Bodies that outlive the cleanup hook

## Reproduction and evidence

Base: `e6abddafcc6de0d12a23c166c5e64ea6c8b35a4e`. Read `research/load-probe/LIFETIME.md`, `RPC-413.md`, and `test/fixtures/{test-lifetime,lifetime-hooks,drain-bodies}.ts`. The original raw stderr is `/Users/ufukaltinok/.local/share/cortexkit/aft/opencode/bash-tasks/ea8a61ec7b47cab6/bash-c3393bf82371dda0/io/stderr`, lines 881–940. The unchanged-expiry assertion belongs to `test/fs/with-lock.test.ts`, not `refresh-file-lock.test.ts`. The other two failures are in `refresh-file-lock.test.ts`. The log shows a 5.264 s test timeout followed by a body assertion, two approximately 10 s hook failures, and a late ENOENT at the final successor-owner read. Those observations do not establish that an unowned renewal timer caused the failures.

A real child runner reproduced the attribution leak on both Bun 1.3.14 (`0d9b296a`) and 1.4.2 (`744846f84`): test deadline 20 ms, body sleep 10.3 s, then `throw new Error('owned late assertion')`. With the original runner-facing `tracked()` promise, the child printed `Unhandled error between tests`, the original assertion and stack, and a hook failure on the successor. On this machine the default hook expired at approximately 5 s, rather than the approximately 10 s wall-clock durations in the supplied overloaded log. The body outlived both boundaries. No hook timeout was increased.

For a manual default-hook reproduction, copy `hook-overrun.fixture.ts` to a scratch `.test.ts` file, resolve its relative lifetime-hooks import to the original absolute path, replace `lifetimeHooks(200)` with `lifetimeHooks()`, remove the explicit `200` from `afterEach`, and replace `Bun.sleep(600)` with `Bun.sleep(10_300)`. Run `HOOK_OVERRUN_CONTROL=1 <bun> test <scratch-path>`. The original manual runs used the equivalent fixture before it was shortened. Do not put a >10 s child inside a default-budget parent test.

The permanent controls use an explicitly shorter 200 ms hook and a 600 ms body. Parent tests retain their default budgets. They exercise actual Bun abandonment, not a simulated promise timeout. The child fails its original test by name, and its successor setup does not execute while the previous body is running.

## Options evaluated before implementation

1. **Separate runner-facing outcome from body ownership (selected).** `tracked()` continues rejecting for direct consumers. Test registration instead calls `runnerBody()`, which captures the registration name, joins the same original body, and rethrows ordinary failures while teardown has not started. After teardown starts it reports an unexpected rejection visibly to stderr with `Late test body failure: <name>` and the original error (including its stack), but does not reject the promise Bun abandoned. Late successful/expected-cancellation completion is also recorded by name. No process-wide rejection handler is installed. Tests that complete normally record no late outcome.
2. **Drain deadline below the hook timeout plus cancellation.** `TestLifetime.drain()` in `test/fixtures/test-lifetime.ts` already aborts `TestLifetime.signal` before joining bodies. A new deadline cannot cancel arbitrary sleeps, assertions, or existing owned store methods that do not accept a signal. Running destructive cleanup before those bodies terminate would recreate the stale-state/ENOENT problem. Outcome separation would still be necessary. Rejected as the primary solution; no drain race was added.
3. **Make production operations cancellable.** This would require `src` API/implementation changes outside scope, and still could not cancel arbitrary body code. It was not necessary for attribution and was not implemented.

The approved design separates runner-facing outcomes, includes a named successor-wait diagnostic, and uses short child controls. Resource-ownership work also includes `test/fs/with-lock.test.ts`.

### Why late reporting cannot hide an ordinary test failure

`lifetimeHooks` starts teardown only in afterEach/afterAll or the next beforeEach. A runner-facing body that fulfilled/rejected normally has already settled before afterEach starts; an ordinary rejection is rethrown before `closing` becomes true. A still-running body at that point means Bun ended its test before its returned promise settled: its deadline has already failed it. The late diagnostic supplements that named failure, rather than turning a successful test into a successful silent catch. Direct `tracked()` callers still receive their original rejection, including unrelated assertions and timer aborts; only an error identical to `lifetime.signal.reason`, after `TestLifetime.drain()` aborts that signal, is expected cancellation.

The successor still waits for the original drain. If that wait cannot finish, a timer at 90% of the hook budget rejects beforeEach with `Still waiting for previous test body: <name>`. The underlying drain continues, and the lifetime is not replaced unless it finishes. Thus the successor's setup is skipped rather than run against live predecessor state. The previous name is also printed immediately when such a wait begins, because a heavily stalled event loop can let Bun's own timeout run before the diagnostic timer. This is a beforeEach diagnostic deadline, not a deadline that permits early cleanup. The default Bun hook budget is unchanged.

Names are the captured registration titles; Bun's surrounding describe prefix is not reconstructed. This preserves the title even if the file's current lifetime changes later.

## Renewal ownership and lease-loss phase

- `refresh-file-lock.test.ts` already owns acquisitions through `lifetime.operation()`, registers each returned handle's `release()` as a finalizer, and releases both renewal seams through `unpark()`. Its two named bodies already own their handles and parked renewal work. `release()` stops/joins renewal; `whenLost()` deliberately remains pending after normal release and is not a join target. No change to that file was needed.
- The private-owner staging test in `with-lock.test.ts` released its handle only inside a `finally` entered **after** its first owner read and spy setup. A failure before that region could leak its renewing handle. Acquisition is now explicitly owned, and its handle is registered as a lifetime finalizer immediately after acquisition. The body's existing release remains, relying on the documented idempotent release contract. Its one-second observation-race timer is now cleared in `finally` instead of lingering after the renewal observation wins.
- `test/fixtures/renewal-ownership.test.ts` copies the original staging test into a child and throws immediately after acquiring the renewal handle, before the first owner read and the body's try/finally. Its successor verifies that the actual handle's release completed. Removing lifetime registration fails that successor. It does not compute an expectation from the same ownership helper or infer release from directory deletion.

The two refresh-file-lock tests deliberately advance their injected clock and acquire a successor while a renewal is parked: the intended lease/marker loss is **after `renewal-write-fenced`** or **after `renewal-write-ready`**, respectively. In the supplied failure the ENOENT is at the post-renewal successor read. Neither the short hook-overrun fixture nor the full-order runs below reproduced an additional row/lock lease being lost because a body overran. An external anthropic-auth suite report relayed for this investigation described a fixture `add` losing its row lease after the first write, then hook failures and late errors. Its source log was not provided here, and this investigation did not reproduce that phase. Do not infer it from isolation passes.

## Controls and mutation proofs

Commands: `bun test test/fixtures/hook-overrun.test.ts` and `bun test test/fixtures/renewal-ownership.test.ts`, Bun 1.4.2. Each mutation was marked `NON-VACUITY BREAK` to identify a deliberately disabled safeguard whose corresponding test must fail. Specific live files were staged first; `git diff --stat` was empty before mutation. Each mutation produced `1 file changed, 1 insertion(+), 1 deletion(-)`, and `git checkout -- <path> && touch <path>` restored an empty unstaged stat. No mutant was committed.

| Mutated control | Exact parent test that failed | Other parent tests |
| --- | --- | --- |
| Make runnerBody rethrow even after closing | abandoned body failure is visible by owner name and stack, not between tests | Other five hook controls passed; child printed `Unhandled error between tests` again |
| Move predecessor diagnostic timer past Bun's hook deadline | successor wait failure names the previous body without allowing successor setup | Other five hook controls passed; expected named error missing, native hook timeout remained |
| Omit lifetime handle finalizer in with-lock staging body | renewal staging lock is released by its lifetime when setup fails before the body finally | Sole parent control failed; child's successor release assertion received false |
| Omit late successful completion diagnostic | late body completion is recorded by owner while its timeout remains failed | Other six hook controls passed |

The six exact hook-control names present in the reporter and predecessor-timer mutation runs were:

- `old runner wiring exposes a body rejection after its hook is abandoned`
- `abandoned body failure is visible by owner name and stack, not between tests`
- `successor wait failure names the previous body without allowing successor setup`
- `normal completion records no late body outcome`
- `unowned late rejection remains an unattributed runner error`
- `ordinary body rejection fails its own test without a late outcome`

In each isolated mutation run, only the test named in its table row failed; every other name in this list passed. In the late-completion reporter mutation, all six names passed and only the newly added `late body completion is recorded by owner while its timeout remains failed` failed. The renewal-ownership mutation ran its sole parent test, so there were no unaffected parent tests in that invocation.

An initial broader mutation switched the `lifetimeHooks` test-registration wrapper back to `tracked()`. Both the named-body and successor-name controls failed because that also removed pending-name tracking. It was restored, then replaced by the isolated reporter mutation above to distinguish the two defenses.

The ordinary-success, ordinary-rejection and unrelated-unowned-rejection controls remained green under reporter removal. The unrelated rejection occurs after the normal body's completion during an independent afterAll wait; it remains an actual Bun `Unhandled error between tests`. The RPC cancellation fixture's uncancelled control deliberately returns its original tracked promise, so the new reporter cannot conceal Bun reporting an uncancelled request body's rejection between tests. Existing RPC assertions were not rewritten to accept different behavior.

## Full-order comparison (VM only)

VM: `tester@2.28.133.11`, snapshots in `/home/tester/hook-overrun-bg2aa/{base,branch}`. Both snapshots installed with `~/rt/bun-1.3.14/bun install --frozen-lockfile` (754 packages each), built before meaningful full-suite comparisons, and used Node 24.16.0 on PATH. No manifests or lockfiles changed.

An initial base VM setup run was accidentally before build and without Node 24 on PATH: 1089 pass, 14 fail, including missing self-package build output and Node-dependent tests. It is retained as `base/full-1.3.14.log`, but is not treated as lifecycle evidence. The corrected environment was then used for the comparisons, not a test-timeout retry.

| Snapshot/runtime/order | Result | Three named renewal tests |
| --- | --- | --- |
| Base, Bun 1.3.14, natural full order | 1110 pass, 10 existing skip, 1 fail; 1121 tests / 96 files | All three pass (103.29 ms, 112.74 ms, 66.49 ms) |
| Branch, Bun 1.3.14, natural full order (before adding successful-outcome control) | 1118 pass, 10 existing skip, 0 fail; 1128 tests / 98 files | All three pass (103.16 ms, 8.13 ms, 8.59 ms) |
| Base, Bun 1.3.14, one full order under 16 busy workers | 1111 pass, 10 existing skip, 0 fail; 1121 tests / 96 files, 144.79 s | All three pass (105.15 ms, 14.68 ms, 14.88 ms) |
| Branch, Bun 1.3.14, one full order under 16 busy workers (before adding successful-outcome control) | 1117 pass, 10 existing skip, 1 fail; 1128 tests / 98 files | All three pass (103.02 ms, 11.53 ms, 9.82 ms) |
| Branch, Bun 1.4.2, natural full order (before adding successful-outcome control) | 1118 pass, 10 existing skip, 0 fail; 1128 tests / 98 files, 104.22 s | All three pass |

The base natural failure was `runner timeout cancels json in its own drain without a between-tests rejection`: its child with lifetime cancellation enabled logged a fetch rejection of `undefined`, not the expected JSON AbortError, and an unattributed error. The branch natural/full-loaded controls passed; this is not evidence that every Bun cancellation race is fixed.

The branch loaded failure was the **untouched** `test/dump/dump.test.ts` test `the automatic sweep runs at most once per interval while sweep runs now`, line 978: an aged synthetic artifact was absent after the second dump, where the test expected it to remain. The test and relevant production code have no base/branch diff. Compared the full file on both snapshots using the same load-probe driver, one invocation each at 16 workers: **43/43 passed on base and 43/43 on branch** (target test 134.02 ms / 111.57 ms). In full-suite order base passed and branch failed. This records a load/order-sensitive interaction, not an exoneration based on isolation, and it was not fixed, retried or skipped.

Full-suite command under 16 busy-loop workers, once for each base and branch snapshot:

```sh
export PATH="$HOME/rt/bun-1.3.14:$HOME/rt/node-v24.16.0-linux-x64/bin:$PATH"
BUN_PROBE_RUNTIME="$HOME/rt/bun-1.3.14/bun" \
TEST_BUN=./research/load-probe/hook-overrun-suite-runner.sh \
HOOK_JUNIT_OUT=loaded-test-results.xml \
bun scripts/load-probe.mjs full-suite all 1 16 > loaded-1.3.14.jsonl 2>&1
```

The wrapper intentionally ignores the probe's file/pattern arguments and executes exactly one full JUnit suite. The probe records raw child output and exit status in JSONL. Full-suite snapshots have their natural logs, JUnit files, loaded JSONL/JUnit and `dump-compare-1.3.14.jsonl`; these artifacts remain on the VM, rather than committing raw logs. No sustained load ran on the workstation. Existing ten opt-in OpenCode E2E skips were unchanged; no new skips/retries/timeout raises were introduced.

## Verification

Local Bun 1.4.2, TypeScript 7.0.2, Biome 2.5.14: build (8 local package manifests and 12 installed ranges checked), `tsc --noEmit`, lint and format checks passed. An initial focused run showed that the new reporter intercepted the RPC fixture's deliberately uncancelled body rejection, concealing the leak that test is meant to reproduce. The unowned-error fixture initially threw during its active test, rather than between tests. Both fixtures were corrected to preserve their original assertions. The corrected focused run passed 12/12 before addition of the late-completion control.

`aft_inspect` initially could not resolve `@cortexkit/common-auth/{fs,sidebar-file,tui-prefs}` in untouched TUI fixtures before build, and its Biome language server had not published diagnostics within the inspection budget. After build, inspection of the five changed implementation/test files was fresh with zero diagnostics. The authoritative build/typecheck passed.

### First delivery verification (before the readiness follow-up)

- `bun run build` — passed, TypeScript 7.0.2; 8 manifests and 12 installed dependency ranges checked.
- `bun run typecheck` (`tsc --noEmit`) — passed, TypeScript 7.0.2 (silent-success compiler gate).
- `bun run lint` and `bun run format:check` — passed, Biome 2.5.14; 226 files checked each.
- Local Bun 1.4.2 focused lifetime/lock suite — 52/52 passed, 749 assertions, six files.
- Final VM Bun 1.3.14 full JUnit — **1119 pass, 10 existing skip, 0 fail**, 1129 tests / 98 files, 242.66 s; check-sources **1112/1112 matched**.
- Final VM Bun 1.4.2 full JUnit — **1118 pass, 10 existing skip, 1 fail**, 1129 tests / 98 files, 201.51 s; check-sources **1111/1112 matched**, correctly failing on the RPC JSON-cancellation test. This gate is not claimed green.
- All eight new controls passed in the Bun 1.4.2 VM comparison, 34 assertions. Final Bun 1.3.14 full order also passed all new controls.

The final Bun 1.4.2 failure was the unchanged test `runner timeout cancels json in its own drain without a between-tests rejection`, line 53 of `test/fixtures/request-cancellation.test.ts`. It expected `CONTROL json rejection AbortError`; the owned child instead logged `CONTROL fetch rejection AbortError`, fulfilled its tracked body, and recorded named late completion. The deadline expired before it reached the JSON phase. There was no unattributed error from that child. The test file is identical on base and branch; the fixture change for the uncancelled control affects only `RPC_ABORT_LIFETIME !== '1'`, not this failing owned case.

Compared this file on base and branch and compared full-suite order as well, without retries of the failed gate:

| Bun 1.4.2 comparison | Base | Branch |
| --- | --- | --- |
| Full natural order | 1111 pass, 10 existing skip, 0 fail; 1121 tests / 96 files | Final run above: JSON phase-control failure |
| Full cancellation test file, one comparison invocation each | 4 pass, 1 fail: **same line 53, fetch AbortError instead of JSON AbortError** | 5/5 pass |

Together with the base Bun 1.3.14 full-order failure at the same phase-sensitive control, this proves the fixture can miss its intended phase on base too, but does not rule out a whole-suite interaction. No RPC timing, timeout, retry, skip or expected phase was changed to make this gate green. The completed implementation's focused controls passed; the unrelated final full-suite/source gate failure remains explicitly reported.

Final artifacts are `branch/final-full-1.3.14.log`, `final-test-results-1.3.14.xml`, `final-full-1.4.2.log`, `final-test-results-1.4.2.xml`, and `base/full-built-1.4.2.log` / `test-results-1.4.2.xml` under the VM snapshot directory above. Comment review found no unclear code comments; report wording was clarified to identify its artifacts, controls and exact cancellation reason.

## Follow-up: deterministic cancellation readiness and additional full-order evidence

### Establish the phase before the body deadline

`rpc-abort.fixture.ts` now prepares the socket/request in a real `beforeEach`, after `lifetimeHooks` creates the test's owner and **before** Bun starts the unchanged 50 ms body deadline. The fetch control waits for the server to receive the request. The JSON control flushes response headers, never sends a body byte in its normal mode, awaits the actual fetch response, and calls `response.json()` before returning from preparation. A fulfillment/rejection observer records the body's actual state.

The test asserts `phase === 'json'`, `state === 'pending'`, and that the server has not ended the response, then prints `CONTROL json pending`. Only after those assertions does it arm the legacy 100 ms abort timer. The legacy signal is an AbortController with that timer's TimeoutError; the lifetime mode combines it with the owning lifetime signal. Thus preparation cannot consume either cancellation budget. The body deadline and legacy cancellation delay are unchanged. The server withholds the body until cancellation; teardown closes connections only after the tracked body drains.

Both original branches remain: the old runner-facing/signal control emits a JSON TimeoutError between tests after its deadline; the lifetime control emits a JSON AbortError, completes its tracked body, and has no between-tests error. The parent test now requires the explicit pending-phase marker in both branches, not merely an error whose phase happened to be JSON.

The additional immediate-body control makes the server end with `{}`. Preparation consumes that response before checking state, so the test deterministically fails the pending-body assertion with `Received: "fulfilled"`, before any timeout is armed. Both old and lifetime modes are tested. Removing those pending-body assertions makes that new parent test red (`Expected: 1, Received: 0`); the other five cancellation tests pass. Removing lifetime cancellation only for the JSON mode makes the original JSON cancellation parent test red (TimeoutError instead of AbortError); the other five tests pass. Each mutation staged the live fixture first, recorded an empty unstaged diff, recorded a non-empty diff during mutation, and restored with checkout/touch to an empty unstaged diff. No test assertion or expected cancellation phase was weakened.

Commands on `tester@2.28.133.11`, from `/home/tester/hook-overrun-bg2aa/branch`: one batch of twenty complete cancellation-file invocations per runtime, with sixteen busy-loop workers:

```sh
TEST_BUN="$HOME/rt/bun-1.4.2/bun" "$HOME/rt/bun-1.4.2/bun" \
  scripts/load-probe.mjs test/fixtures/request-cancellation.test.ts '.*' 20 16
TEST_BUN="$HOME/rt/bun-1.3.14/bun" "$HOME/rt/bun-1.3.14/bun" \
  scripts/load-probe.mjs test/fixtures/request-cancellation.test.ts '.*' 20 16
```

**20/20 passed on Bun 1.4.2 and 20/20 passed on Bun 1.3.14.** Each invocation ran all six tests in the file, including old/new fetch and JSON cancellation, direct rejection preservation, and the immediate-body negative control: 120 passing parent cases and 900 assertions per runtime. JSON preparation is no longer a race against the test deadline. Raw evidence is `/home/tester/hook-overrun-bg2aa/branch/cancellation-ready-1.4.2.jsonl` and `cancellation-ready-1.3.14.jsonl` in the same directory on that VM.

### Bun 1.3.14 default hook budget

An explicit manual probe, `research/load-probe/hook-timeout-default.fixture.ts`, registers `beforeEach(() => new Promise(() => {}))` with **no timeout argument** and no lifetime wrapper. Command: `npx --yes bun@1.3.14 test ./research/load-probe/hook-timeout-default.fixture.ts`. Bun 1.3.14 (`0d9b296a`) failed the sole probe at **5000.03 ms**, with its native `a beforeEach/afterEach hook timed out` diagnostic. Exit 1 is the intended measurement, not a passing suite test.

The normal default is therefore **5 seconds**, not 10 seconds. The approximately 10-second elapsed durations in the overloaded historical logs do not establish a ten-second configured budget. `lifetimeHooks` passing 5000 does not lower the normal default in this repository; no `setDefaultTimeout` use was found. Its explicit short parameter remains only for the child overrun control. The predecessor diagnostic timer remains the previously approved 90%-budget deadline; destructive cleanup still waits.

Runner-source corroboration: [CLI default](https://github.com/oven-sh/bun/blob/7e57e529/src/cli.zig#L341-L343) is `5 * std.time.ms_per_s`; [hook registration](https://github.com/oven-sh/bun/blob/7e57e529/src/bun.js/test/bun_test.zig#L42-L57) uses hook argument parsing; [timeout resolution](https://github.com/oven-sh/bun/blob/7e57e529/src/bun.js/test/ScopeFunctions.zig#L418-L421) prefers explicit timeout, then `setDefaultTimeout`, then runner default. This source commit is in the 1.3.13-to-1.3.14 release range; the exact released binary was independently measured above. Explicit 5000 would override an intentionally customized default, but none is configured in these runs.

### Three additional loaded full orders per revision

To keep the causal comparison stable, froze the hook-outcome implementation at **5add9a0**, without the new pre-deadline JSON preparation, in `/home/tester/hook-overrun-bg2aa/comparison-branch-5add9a0`. Base remains `e6abdda`. Ran three further full suites each on Bun 1.3.14, alternating base/branch, with the same full-suite wrapper, one invocation and 16 busy workers per run. These six runs are the requested additional comparisons, not retries until success. They retain the original branch's hook timeout and diagnostics unchanged.

| Loaded run | Base dump interval test | Branch 5add9a0 dump interval test | Other full-suite failures |
| --- | --- | --- | --- |
| Original run 1 | pass | fail at unchanged membership assertion, 146.75 ms | Branch: dump interval only |
| Additional run 2 | pass, 110.20 ms | pass, 107.91 ms | Base: old fetch and JSON phase controls; branch: none |
| Additional run 3 | pass, 140.80 ms | pass, 113.54 ms | Base: old JSON phase control; branch: none |
| Additional run 4 | pass, 179.78 ms | pass, 145.62 ms | Base and branch: old JSON phase control |

Additional base full-suite totals were 1109/2 fail, 1110/1 fail and 1110/1 fail; branch totals were 1119/0 fail, 1119/0 fail and 1118/1 fail, with ten existing opt-in skips each. Each base suite ran 1121 cases; each frozen branch suite ran 1129. Raw JSONL/JUnit artifacts are `loaded-extra-{2,3,4}.{jsonl,xml}` under `/home/tester/hook-overrun-bg2aa/base` and `/home/tester/hook-overrun-bg2aa/comparison-branch-5add9a0`. The dump failure did not recur naturally. This observation alone does not establish whether branch scheduling contributed to its first occurrence.

### Investigate the proposed branch effects, rather than relying on isolation passes

The original failing full-run output contains **no** `Waiting for previous test body`, `Late test body failure`, or `Late test body completion` diagnostics anywhere, including the dump file. Those console.error calls therefore did not execute in that run and cannot account for its dump assertion through extra printed output. The explicit native hook timeout is 5 seconds, equal to Bun 1.3.14's measured default, so it did not shorten that hook budget. The interval body failed at 146.75 ms, not through a hook timeout.

The unchanged test awaits its first dump and waits for three artifacts, then adds an aged synthetic artifact. That artifact-count check is **not a join of the first scheduled sweep**. `src/dump/index.ts:735-742` starts the sweep with `void sweepDumpDirectory(...)`; the sweep awaits directory lstat before readdir at lines 246–250. If the first sweep's directory read occurs after the synthetic artifact is added, that first sweep can remove it even though the second dump correctly schedules no sweep within the interval. The assertion then mistakes a still-running first sweep for an unwanted second sweep.

`research/load-probe/dump-sweep-overlap.mjs` demonstrates that exact ordering on both revisions without modifying production code or the original expectation. It copies the real interval test, parks the **first actual directory lstat**, lets the original body write the aged artifact and second dump, then releases that sweep and joins the actual unlink of the synthetic artifact. The original membership assertion fails on **base and branch**, with the same absent artifact and two surviving dump groups as the historical failure. The driver itself exits 0 only when the unchanged assertion fails by name, not by timeout. Neither timeout shortening nor named console output is needed for this reproduction. One VM invocation per snapshot, Bun 1.3.14, produced:

- Base: original interval assertion failed at 243.47 ms; one failing copied test, no timeout.
- Branch 5add9a0: original interval assertion failed at 527.16 ms; one failing copied test, no timeout.

The runner-facing wrapper adds promise continuations, so it can change scheduling relative to filesystem work; that remains a possible trigger for exposing the pre-existing sweep overlap. There is no captured trace proving which scheduling event triggered the original uninstrumented run. The overlap is now reproduced on base, but the original full-run trigger remains untraced. No dump source or original dump test was changed, and no isolation pass is presented as proof against a full-order interaction. Driver output is `/home/tester/hook-overrun-bg2aa/base/dump-overlap.log` and `/home/tester/hook-overrun-bg2aa/comparison-branch-5add9a0/dump-overlap.log`.

### Final readiness-fixed gates

The readiness fix supersedes the first delivery's failed RPC phase-control gate. No changes were made to `src`, the dump test, or the hook's configured timeout in this follow-up.

- Local Bun 1.4.2, TypeScript 7.0.2: build passed (8 package manifests, 12 installed ranges); `tsc --noEmit` passed; Biome 2.5.14 lint and format checks passed (226 files each).
- Scoped fixture diagnostics: fresh, zero errors/warnings; two unchanged TypeScript hints in direct rejection assertions.
- Final VM Bun 1.3.14 full JUnit: **1120 pass, 10 existing skip, 0 fail**, 1130 cases / 98 files, 4988 assertions, 154.32 s. `check-sources`: **1113/1113 matched**.
- Final VM Bun 1.4.2 full JUnit: **1120 pass, 10 existing skip, 0 fail**, 1130 cases / 98 files, 4988 assertions, 89.91 s. `check-sources`: **1113/1113 matched**.
- Both final full-order runs passed the dump interval test and deterministic fetch/JSON controls.
- Phase-guard mutation: `rpc-abort.fixture.ts`, `1 file changed, 1 insertion(+), 4 deletions(-)` while mutated; empty `git diff --stat` after checkout/touch. Sole failure was `JSON cancellation phase control rejects an immediately completed response body`; the other five tests passed.
- JSON lifetime-signal mutation: same fixture, `1 file changed, 3 insertions(+), 1 deletion(-)` while mutated; empty stat after checkout/touch. Sole failure was `runner timeout cancels json in its own drain without a between-tests rejection`; the other five tests passed.
- The other tests in both mutation runs are the file's unchanged exact titles: `runner timeout cancels fetch in its own drain without a between-tests rejection`, `lifetime aborts requests before joining bodies and before cleanup`, `lifetime preserves an unrelated body rejection during teardown`, `lifetime preserves a timer abort rather than treating it as teardown cancellation`, plus the non-mutated JSON control of the two named above.

Final VM artifacts: `/home/tester/hook-overrun-bg2aa/branch/ready-full-{1.3.14,1.4.2}.log` and `ready-test-results-{1.3.14,1.4.2}.xml`. Comment review covered all new/changed code comments; no unclear code comments remained. Report artifact paths were made explicit.
