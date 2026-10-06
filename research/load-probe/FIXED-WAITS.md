# Fixed-wait sweep

Locations below refer to base `d1717a73dbcee649568147f1af77bbbcb45ac27b`, so removed waits retain a stable location. This inventory excludes imports and timer type annotations because neither is a runtime wait. Positive observations now use the actual promise or cancellation-aware state observation; if an observation never arrives, Bun's existing per-test timeout fails that test by name, then teardown cancels the wait so cleanup can finish. Poll delays are cadence, not correctness windows. `observed` and `observedState` end on lifetime cancellation and report missing observations as named late body failures.

## Inventory

| Base file:line | Class | Action / required seam |
| --- | --- | --- |
| test/store/attribution.test.ts:164 | Negative contention opportunity, 200 ms | Resolved: use `observed` to await the pull operation's config `save` lock refusal while it tries to capture the credential and epoch. Assert no request and no settlement, then release the parked replace operation. See CONTENDED.md. |
| test/store/refresh.test.ts:529 | Negative, 400 ms | Resolved: child prints `contended:row-r@<statePath>` from its store observer; await it with cancellation and assert child exit is still pending and the row unchanged. |
| test/store/pull.test.ts:52 | Positive, 1 s race | Await load itself via `observed`; pending pulls remain parked until teardown. |
| test/store/pull.test.ts:57 | Positive, 4 s polling deadline | Await the third pull callback's deferred via `observed`. |
| test/store/pull.test.ts:218 | Positive state polling, 10 ms cadence | Already cancellation-aware at base; retained, no elapsed-time decision. |
| test/store/hooks.test.ts:199 | Deliberate, 5 ms | Retained: timer-originated reentry is the scenario; completion already observed by deferreds. |
| test/store/hooks.test.ts:57 | Positive rejection latency, 100 ms | Remove elapsed-time verdict; await each actual rejection with cancellation and assert PoolReentryError. Same-row operations still run while the hook holds its locks, so lock-waiting deadlock fails by runner name instead of a host-speed bound. |
| test/store/hooks.test.ts:214 | Positive, 5 s race | Await the continuation result via `observed`, then assert its credential. |
| test/store/renewal.test.ts:52 | Positive, 2 s polling deadline | Observe renewal counts without a deadline via cancellation-aware `observedState`. Covers both provider/row locks and store locks. |
| test/store/refresh.test.ts:263 | Deliberate, 5 ms | Retained: asynchronous refusal predicate must be awaited at each refusal site. |
| test/store/refresh.test.ts:197 | Negative, 300 ms | Resolved: await `contended` for `legacy-refresh`; assert refresh pending and no provider call before the legacy holder releases. |
| test/store/refresh.test.ts:365 | Negative, 300 ms | Resolved: await `contended` for `provider-openai`; assert refresh pending and no second provider call before releasing the first. |
| test/store/refresh.test.ts:453 | Negative, 300 ms | Resolved: await add's `provider-openai` refusal; assert add pending and no new roster row, then release refresh. |
| test/store/rows.test.ts:401 | Negative, 300 ms | Resolved: await library `save` refusal at config path; assert add pending and neither file written, then release legacy holder. |
| test/store/rows.test.ts:446 | Negative, 300 ms | Resolved: test-only vendored writer observer forwards primitive live-owner refusal at config `save`; assert legacy writer pending and its row absent before releasing library write. |
| test/store/rows.test.ts:478 | Negative, 300 ms | Resolved: test-only vendored writer observer forwards primitive live-owner refusal at state `save`; assert legacy writer pending and `lastUsed` unchanged before releasing library write. |
| test/store/row-transition.test.ts:359 | Negative, 300 ms | Resolved: await competing writer's `row-acct-a` refusal in both operation orders; assert pending and files unchanged before releasing the holder. |
| test/store/reorder.test.ts:177 | Negative, 300 ms | Resolved: await `extra-1` refusal; assert reorder pending, then await the independent write and assert no reorder lock acquisition or order change before release. |
| test/store/remove-enable.test.ts:250 | Negative, 300 ms | Resolved: await removal's `row-acct-a` refusal; assert pending and roster intact before releasing refresh. |
| test/store/account-keyed-refresh.test.ts:291 | Negative, 300 ms | Resolved: await add's `row-acct-A` refusal; assert pending and no added row before releasing refresh. |
| test/store/account-keyed-refresh.test.ts:378 | Negative, 300 ms | Resolved: await refresh's initial `row-y` refusal; assert pending and no provider call before releasing identity-write gate. |
| test/store/account-keyed-refresh.test.ts:385 | Negative, 300 ms | Resolved: await re-keyed refresh's `row-acct-A` refusal; assert pending and no provider call before releasing the in-flight row. |
| test/store/account-keyed-refresh.test.ts:449 | Negative, 1 s | Resolved: park first provider call, await second refresh's `provider-openai` refusal and assert pending/no overlap, then release. Account-keyed positive overlap still awaits both entries. |
| test/store/credential-stamps.test.ts:586 | Negative, 300 ms | Resolved: await rotation's `row-acct-a` refusal before swapping credentials, then release and assert locked re-read refuses the swap. |
| test/store/helpers.ts:130 | Negative helper timer | Resolved: `settlesWithin` removed after all callers were converted; `blocked` awaits cancellation-aware refusal and checks settlement without an elapsed window. |
| test/store/child.ts:129 | Deliberate keepalive interval | Retained: holds child alive while a crash seam is parked, not an assertion. |
| test/store/child.ts:137 | Deliberate parameterized delay | Retained: caller-selected pause before state write models a stalled writer. |
| test/store/timeout-isolation.fixture.ts:28 | Deliberate, 100 ms | Retained: keeps real work beyond teardown's former fixed sleep to test ownership. |
| test/logger/engine.test.ts:79 | Positive, 10 ms | Removed: awaited `flushForTest` has already synchronously written the circular payload. |
| test/logger/engine.test.ts:98 | Positive, 10 ms | Removed: awaited flush has written the diamond payload. |
| test/logger/engine.test.ts:114 | Positive, 10 ms | Removed: awaited flush has written the BigInt fallback. |
| test/logger/engine.test.ts:388 | Positive, 600 ms | Observe `timer-line` in the actual file, without manually flushing: retains coverage of the real 500 ms flush timer. |
| test/logger/sink-only.test.ts:61 | Positive/quiet-window, 600 ms | Removed: sink delivery is synchronous and schedules no file timer; explicitly flush before checking two records and no output/files. |
| test/fs/refresh-file-lock.test.ts:46 | Positive helper, 1 s race | Removed helper: all 24 uses await the loss/step promise via `observed`. Individual call sites listed below. |
| test/fs/refresh-file-lock.test.ts:98 | Positive | Await renewal-finished tick. |
| test/fs/refresh-file-lock.test.ts:102 | Positive | Await takeover loss. |
| test/fs/refresh-file-lock.test.ts:160 | Positive | Await assertOwned loss. |
| test/fs/refresh-file-lock.test.ts:225 | Positive | Await paused renewal. |
| test/fs/refresh-file-lock.test.ts:235 | Positive | Await renewal completion. |
| test/fs/refresh-file-lock.test.ts:253 | Positive | Await unreadable-owner loss. |
| test/fs/refresh-file-lock.test.ts:292 | Positive | Await terminal renewal loss. |
| test/fs/refresh-file-lock.test.ts:331 | Positive | Await renewal completion for each terminal error reason. |
| test/fs/refresh-file-lock.test.ts:333 | Positive | Await loss for each terminal error reason. |
| test/fs/refresh-file-lock.test.ts:353 | Positive | Await expiry loss. |
| test/fs/refresh-file-lock.test.ts:426 | Positive | Await renewal owner confirmation. |
| test/fs/refresh-file-lock.test.ts:438 | Positive | Await renewal completion. |
| test/fs/refresh-file-lock.test.ts:470 | Positive | Await release owner confirmation. |
| test/fs/refresh-file-lock.test.ts:516 | Positive | Await renewal write fence. |
| test/fs/refresh-file-lock.test.ts:520 | Positive | Await renewal completion after release starts. |
| test/fs/refresh-file-lock.test.ts:554 | Positive | Await renewal write fence. |
| test/fs/refresh-file-lock.test.ts:566 | Positive | Await renewal completion. |
| test/fs/refresh-file-lock.test.ts:601 | Positive | Await renewal write-ready seam. |
| test/fs/refresh-file-lock.test.ts:612 | Positive | Await renewal completion. |
| test/fs/refresh-file-lock.test.ts:615 | Positive | Await relinquished-owner loss. |
| test/fs/refresh-file-lock.test.ts:658 | Positive | Await renewal write-ready seam. |
| test/fs/refresh-file-lock.test.ts:670 | Positive | Await relinquish read. |
| test/fs/refresh-file-lock.test.ts:676 | Positive | Await renewal completion. |
| test/fs/refresh-file-lock.test.ts:770 | Positive | Await injected renewal failure callback. |
| test/fs/refresh-file-lock.test.ts:772 | Positive, 500 ms race | Await renewed callback instead of `resolvesWithin(...).toBe(true)`. |
| test/fs/refresh-file-lock.test.ts:110 | Negative, 50 ms | Retained: allows an in-flight tick to finish before no-more-ticks window; needs renewal cancellation/join seam. |
| test/fs/refresh-file-lock.test.ts:112 | Negative, 60 ms | Retained: needs explicit cancelled-renewal timer/attempt event. |
| test/fs/refresh-file-lock.test.ts:193 | Negative, 120 ms | Resolved: await `onRenewalTimer('scheduled')` and `onRenewalTimer('cancelled')` in a fresh child; capture real timer arms/clears to prove the renewal timer is pending immediately before `assertOwned()` detects takeover and cleared afterward, with zero `renewal-finished` callbacks. See RENEWAL-CANCEL.md. |
| test/fs/refresh-file-lock.test.ts:274 | Negative, 30 ms | Retained: needs explicit loss-subscription/no-renewal event after owner release. |
| test/fs/refresh-file-lock.test.ts:518 | Negative, 50 ms race | Retained: needs release attempt/join refusal while renewal is in-flight. |
| test/fs/refresh-file-lock.test.ts:63 | Negative helper timer | Retained solely for in-flight release non-completion. |
| test/fs/with-lock.test.ts:207 | Negative, 1100 ms | Retained for both fulfillment/rejection: needs cancelled-renewal timer/attempt event after release. |
| test/fs/with-lock.test.ts:221 | Negative, 1500 ms | Retained: needs explicit default renewal scheduling decision, not silent unchanged bytes. |
| test/sidebar-file/sidebar-file.test.ts:249 | Positive, 7200 ms | Observe actual expiry advance of at least 3000 ms while write remains parked; owner/mode assertions unchanged. |
| test/tui-prefs/tui-preferences.test.ts:222 | Positive, 5000 ms | Observe actual expiry advance while staged write remains parked; owner/mode assertions unchanged. |
| test/tui-prefs/watcher.test.ts:55 | Deliberate startup yield, 50 ms | Removed from positive test: watcher returns ready; await its callback instead. |
| test/tui-prefs/watcher.test.ts:57 | Positive, 400 ms | Observe callback count with cancellation-aware state poll. |
| test/tui-prefs/watcher.test.ts:64 | Positive, 400 ms | Observe immediate-write callback. |
| test/tui-prefs/watcher.test.ts:73 | Positive, 400 ms | Observe polling fallback callback. |
| test/tui-prefs/watcher.test.ts:162 | Deliberate startup yield, 50 ms | Retained as part of negative dispose scenario; needs readiness seam to remove. |
| test/tui-prefs/watcher.test.ts:165 | Negative, 300 ms | Retained: needs attempted dispatch on disposed watcher, explicitly refused. |
| test/tui-prefs/watcher.test.ts:171 | Deliberate startup yield, 50 ms | Retained as part of sibling-file negative scenario; needs readiness seam. |
| test/tui-prefs/watcher.test.ts:173 | Negative, 300 ms | Retained: needs sibling event/poll processed-but-ignored signal. |
| test/tui-prefs/watcher.test.ts:176 | Positive, 400 ms | Observe subsequent real preferences callback. |
| test/tui-prefs/watcher.test.ts:182 | Deliberate startup yield, 50 ms | Retained as part of identical-content negative scenario; needs readiness seam. |
| test/tui-prefs/watcher.test.ts:184 | Negative, 400 ms | Retained: needs completed identical-content comparison/no-dispatch signal. |
| test/tui-prefs/watcher.test.ts:90 | Deliberate controlled 100/150 ms timers | Retained: fake timers are driven directly, not awaited by wall clock, to test debounce and poll ordering. |
| test/dump/dump.test.ts:510 | Positive, 1 s bounded polling | Removed helper; observe capped sweep's actual directory contents via cancellation-aware state poll. |
| test/dump/dump.test.ts:952 | Positive helper call | Await three-file state, then assert exact retained paths. |
| test/dump/dump.test.ts:964 | Negative, 100 ms | Retained: uncapped no-eviction claim needs explicit refused sweep scheduling event to replace a quiet window. |
| test/cachekeep/warm.test.ts:100 | Positive, 30 ms | Await adapter send deferred, retains real self-armed timer path. |
| test/cachekeep/warm.test.ts:313 | Deliberate, 0 ms | Retained: yields while first prewarm is parked. |
| test/cachekeep/warm.test.ts:315 | Deliberate, 0 ms | Retained: yields after second tick to exercise non-reentry. |
| test/cachekeep/warm.test.ts:112 | Deliberate, 1000000 ms interval | Retained: intercepted interval is kept from firing; tests drive ticks directly. |
| test/cachekeep/helpers.ts:35 | Deliberate yield helper | Retained: only zero-duration scheduling callers remain. |
| test/commands/failure-projection.test.ts:177 | Positive, 2 s polling deadline | Await notifier deferred, preserving exact projected-message assertion. |
| test/commands/command-session-isolation.test.ts:63 | Positive setup yield, 0 ms | Await login entry deferred before rebinding session; teardown releases login gate. |
| test/commands/command-session-isolation.test.ts:83 | Positive, 2 s polling deadline | Await notifier deferred before exact session/message assertion. |
| test/commands/command-session-isolation.test.ts:122 | Deliberate, 0 ms | Retained: yield before releasing two invocation gates in opposite order. |
| test/commands/command-session-isolation.test.ts:23 | Deliberate yield helper | Retained for the concurrent-invocation scenario only. |
| test/claustrum/enrollment.test.ts:459 | Positive lock-holder entry, 10 ms | Await first proposal entry deferred before second reconcile; gate still released on teardown. |
| test/claustrum/roster.test.ts:150 | Negative, 30 ms | Retained: separate Claustrum roster acquisition does not deliver the store's `onLockEvent`; needs its own refusal hook. Changing src/claustrum is outside the store seam and the allowed source paths, so its 30 ms window remains. |
| test/opencode2/integration.test.ts:127 | Deliberate, 5 ms | Retained: slow pool writer demonstrates callback awaiting. |
| test/opencode2/integration.test.ts:130 | Positive registration yield, 0 ms | Await returned registration promise via `observed`. |
| test/opencode2/integration.test.ts:145 | Positive registration yield, 0 ms | Await returned registration promise via `observed`. |
| test/opencode2/integration.test.ts:155 | Positive registration yield, 0 ms | Await returned registration promise via `observed`. |
| test/opencode2/install.test.ts:287 | Deliberate, 5 ms | Retained: slow listener proves listener completion is awaited. |
| test/opencode2/fake-host.ts:86 | Deliberate, 0 ms | Retained: fake host event-loop turn. |
| test/opencode2/attempts.test.ts:180 | Deliberate, 0 ms | Retained: listener/callback turn yield after controlled host events. |
| test/opencode2/e2e/placement.e2e.test.ts:92 | Positive, 60 s startup deadline | Remove independent deadline; health polling stops on lifetime cancellation and each fetch also receives cancellation. |
| test/opencode2/e2e/placement.e2e.test.ts:97 | Deliberate request timeout, 1 s | Retained: one failed health request must allow another attempt; composed with lifetime cancellation. |
| test/opencode2/e2e/placement.e2e.test.ts:100 | Positive poll cadence, 250 ms | Retained cadence; no longer decides readiness by elapsed time. |
| test/opencode2/e2e/placement.e2e.test.ts:198 | Deliberate cleanup watchdog, 90 s | Retained: SIGKILL fallback while finishing child cleanup, not test correctness. |
| test/opencode2/e2e/placement.e2e.test.ts:211 | Deliberate cleanup watchdog, 10 s | Retained: server SIGKILL fallback during cleanup. |
| test/rpc/stop-runtime.test.ts:30 | Positive stop race, 500 ms | Await stop itself in child; parent awaits exit via `observed`, kills child on cancellation. Removed elapsed upper-bound assertion. |
| test/rpc/stop-runtime.test.ts:101 | Positive process-exit bound, 1 s | Assert the actual apply-deadline timer is unreferenced, then await child exit with cancellation instead of elapsed upper-bound assertion. Direct timer observation preserves the contract even if a wrongly referenced deadline would eventually expire. |
| test/rpc/client-proxy.test.ts:52 | Positive EOF watchdog, 1 s | Await EOF directly in child; parent awaits exit with cancellation and kills child on teardown. |
| test/rpc/client-proxy.test.ts:43 | Deliberate, 100 ms | Retained: slow handler exercises 10 ms client timeout behavior. |
| test/rpc/rpc-server.test.ts:445 | Deliberate, 3000 ms | Retained: real slow handler tests default socket-timeout behavior. |
| test/rpc/rpc-server.test.ts:626 | Deliberate, 300 ms | Retained: slow handler tests per-call client timeout. |
| test/rpc/rpc-server.test.ts:657 | Deliberate, 300 ms | Retained: delayed response tests pending-request timeout. |
| test/rpc/rpc-server.test.ts:459 | Deliberate fetch watchdog, 15 s | Retained: slow-handler scenario request watchdog. |
| test/rpc/request-errors.test.ts:67 | Deliberate fetch watchdog, 5 s | Retained: bounds each request in the deadline/error scenarios; composed with lifetime cancellation. |
| test/rpc/request-errors.test.ts:201 | Deliberate, 900 ms | Retained: handler exceeds 150 ms apply deadline; assertions intentionally test configured deadline semantics. |
| test/rpc/request-errors.test.ts:218 | Deliberate, 20 ms | Retained: handler completes below 1 s apply deadline. |
| test/rpc/port-file.test.ts:71 | Deliberate, 5 ms | Retained: distinguishes timestamps on sequential writes, not asynchronous progress. |
| test/rpc/port-file.test.ts:44 | Deliberate child, 30 s | Retained: supplies a live PID for discovery; killed by fixture cleanup. |
| test/rpc/client-transport.test.ts:28 | Deliberate controlled deadline | Retained: suppresses RPC deadline so framing must cause rejection. |
| test/rpc/client-transport.test.ts:69 | Deliberate, 5 ms | Retained: delayed frame fixture for transport contract. |
| test/auth-menu/helpers.ts:56 | Deliberate, 0 ms | Retained: schedules the input pump on an event-loop turn. |
| test/fixtures/lifetime-hooks.ts:22 | Deliberate drain watchdog | Retained: names a stuck previous body before hook deadline, never asserts operation correctness. |
| test/fixtures/lifetime-isolation.test.ts:54 | Deliberate, 200 ms | Retained: resumes copied body beyond 100 ms runner timeout to test late-body ownership. |
| test/fixtures/hook-overrun.fixture.ts:6 | Deliberate, 200 ms | Retained: unrelated hook-overrun control. |
| test/fixtures/hook-overrun.fixture.ts:13 | Deliberate, 100 ms | Retained: body resumes after 20 ms deadline. |
| test/fixtures/hook-overrun.fixture.ts:29 | Deliberate, 150 ms | Retained: unjoined operation outlives body. |
| test/fixtures/hook-overrun.fixture.ts:33 | Deliberate, 100 ms | Retained: body deliberately overruns. |
| test/fixtures/hook-overrun.fixture.ts:40 | Deliberate, 600 ms | Retained: fixture simulates slow operation. |
| test/fixtures/rpc-abort.fixture.ts:114 | Deliberate abort timer | Retained: external abort follows body deadline so lifetime cancellation must win. |
| test/fixtures/legacy-openai-auth/accounts.ts:1104 | Deliberate computed retry delay | Retained: vendored lock-contention retry scenario, bounded by its production lock timeout. |

The timed contention tests in `fs/with-lock`, `sidebar-file`, and `tui-prefs` intentionally assert the configured lock timeout, rather than waiting for unrelated work to be ready. Lease timestamp tolerances and RPC apply-deadline assertions likewise test clock/deadline contracts. No test timeout was raised and no new retries or skips were added.

## Verification and controls

See `fixed-waits-controls.json` for independently applied fixture mutations, exact failing test names, captured named late failures, and non-empty/empty diff evidence. Controls suppress the observation consumed by a changed wait, not an unrelated assertion. Every mutation is applied alone after staging the live state, restored from the index, and checked for an empty working diff. Synchronous-flush controls suppress the fixture's log emission and fail at the assertion itself. Two additional RPC controls neutralize the actual timer's `unref` method, so an eventually-expiring but process-holding deadline cannot pass. The VM placement control suppresses a successful health observation and produces the named 180 s runner failure plus the same named late body failure, terminating in 180.40 s without a hook overrun. Overall: 62 independent controls reddened; 56 named late body failures and six immediate named assertion failures.

Local Bun 1.4.2 full JUnit: exit 0, 1121 pass / 11 existing environment skips / 0 fail, 1132 tests in 98 files, 4989 assertions, 82.89 s on the final snapshot. Source checker: 1115/1115 cells matched. VM Bun 1.3.14 unloaded: exit 0, 1122 pass / 10 existing environment skips / 0 fail, 1132 tests in 98 files, 4991 assertions, 75.93 s on the final snapshot; source checker 1115/1115. VM frozen install installed 754 packages; build checked 8 local manifests and 12 installed dependency ranges.

VM full suites through `scripts/load-probe.mjs`, 16 workers, Bun 1.3.14, one three-run invocation (no retries): run 1 exit 0, 1122 pass / 10 existing skips / 0 fail, 147135 ms; run 2 exit 0, same counts, 144574 ms; run 3 exit 0, same counts, 143900 ms. No untouched test failed, so no base-versus-branch failure comparison was needed. Existing OpenCode placement tests require their separate opt-in CLI environment; no new skip was introduced.

After adding direct RPC timer-reference observation, a second three-run snapshot also passed: exits 0/0/0, durations 144354 / 144926 / 148059 ms. Its enormous JSON output records were truncated by the loaded Bun stdout pipe; the printed probe summary still reported three passes and runner exit 0. After removing the remaining hook rejection latency verdict, the final three full runs passed: run 1 exit 0, 145698 ms; run 2 exit 0, 147551 ms; run 3 exit 0, 137802 ms. Each final run reports 1122 pass / 10 existing skips / 0 fail, 1132 tests, 4991 assertions, and 1115/1115 source cells. Thus all nine recorded loaded full runs passed, across the successive snapshots, without retrying a failing suite.

The final probe adapter is `research/load-probe/fixed-waits-suite-runner.sh`, selected with `TEST_BUN`, with `BUN_PROBE_RUNTIME` set to `~/rt/bun-1.3.14/bun`. It captures full output and JUnit per runner PID, prints compact summaries to avoid loaded-pipe truncation, and returns the runner's exit code before invoking check-sources. The gate never depends on output matching. VM logs and JUnit for final loaded runs are `/tmp/fixed-waits-suite-{315799,318321,320777}.{log,xml}`. The original snapshot used the existing hook-overrun suite adapter.

The opt-in VM placement startup test also passed normally (1 pass, 14 assertions, Bun 1.3.14) before its readiness-suppression control. Mutation execution had two transient Git index-lock collisions: all live state was staged, the active mutation was restored with `git checkout` plus `touch` and an empty diff confirmed, and unfinished controls resumed. The control runner retries only Git index-lock collisions, never a failed test. Six synchronous controls fail immediately; the other 56 fail at existing runner deadlines and print the same named late body failure, without teardown hanging.
