# Follow-up: own every account-keyed test body through teardown

This follow-up is based on commit `79318235daeeb8fbba0b58b05cb7976f42840777` in the worker checkout. The parent has already integrated that commit and relocated the first report; this commit changes only the follow-up files listed below, not the parent's restyled probe or relocated report.

## Trace

The supplied `/tmp/ca-mg-test.log` was read at lines 1190–1470. It records the unknown-identity add test timing out at **5210.39 ms** against the unchanged **5000 ms** runner budget. The next known-identity test fails after **22.41 ms**. There are two unhandled errors: refresh and add lose their leases before writing, with no committed writes.

The first repair tracked only the overlap test. The other account-keyed bodies still survived the runner timeout, while teardown released their provider barriers and immediately deleted the scenario (there was no body registered for teardown to await). A still-running refresh then asserts its leases against removed lock files. That failure path is reproduced by the new control, including the same `PoolOperationError: refresh lost a lease before writing` unhandled-error class and a failing successor.

The unknown-identity test also had `settlesWithin(addY, 3_000)`: its result was an elapsed-time judgment about whether the add could finish while the refresh was parked. The competing operation's completion is now awaited directly before opening the refresh barrier. This proves the ordering, without deciding correctness from a 3 s wall window. The two other positive `recordIdentity` checks in the unknown-identity suite, and the later-row `recordIdentity` check in the known-identity suite, had the same 3 s decision and now use the same observed completion ordering.

**Why the historical body took more than 5 s remains unexplained.** That log has no per-await tracing and cannot establish which await consumed the time, nor whether the internal 3 s race had fired before Bun timed out the body. The loaded Linux baseline again did not reproduce the failure. This is not presented as a demonstrated before/after failure-rate improvement or as a proven explanation of the historical runtime.

There was also a dangerous global reassignment in the add test's two-order loop: it deleted `s` and assigned a newly awaited scenario during the body. An abandoned loop could overwrite or clean the successor's global scenario. The two independent roster-order cases are now separately registered tests, so each owns exactly one scenario for its entire lifetime. Both order assertions are preserved and have provenance rows. Splitting eliminates mid-body global reassignment; no per-test timeout was raised.

## Implementation

- Every `it` in `test/store/account-keyed-refresh.test.ts` goes through the local registration wrapper and `TestLifetime.tracked`, including parameterized cases and the previously untracked default-lock case.
- `TestLifetime.manage` observes promises returned by store methods, including refresh/add/recordIdentity promises that an early assertion failure prevents the body from reaching. Draining only the body is insufficient for those detached calls.
- Teardown snapshots its scenario and lifetime before awaiting, opens all registered barriers, waits for complete bodies (including state reads), then waits for outstanding store calls before cleanup.
- A barrier registered after teardown begins is immediately opened. This covers a timed-out body that was still doing setup when teardown started.
- The global scenario is not replaced by `beforeEach` until teardown has drained the old body and its store work. No production file changed.

## Other store teardown inventory

Sidekick inventory and direct search covered `test/store` for `afterEach`, `unpark`, and fixed teardown sleeps. **No other store file has the same unpark-then-sleep teardown** in this checkout. Other files generally have direct `afterEach(() => s.cleanup())`; those are not converted indiscriminately in this task. There are 200 ms sleeps in pull/attribution test bodies, not release-then-sleep cleanup. `test/store/drain-bodies.ts` is extended to wait for separately tracked store operations after the body phase.

## Real runner-timeout proof

`test/store/timeout-isolation.test.ts` copies a non-discovered fixture to scratch and runs a real child `bun test` invocation. Before the intentional first test begins, setup has already parked a refresh inside its provider callback. That first test times out at a deliberately shortened **20 ms** budget while awaiting the refresh. Provider release deliberately keeps store work pending for another **100 ms**, beyond the previous teardown's **50 ms** sleep. This delay creates the fault; there is no elapsed-time correctness assertion and no timeout increase. The normal helper awaits completion rather than assuming that 100 ms is sufficient.

The parent regression requires:

1. exactly the intentional timeout failure;
2. a passing successor that sees its own credential, after the old body's final state read saw the rotated original credential;
3. no `Unhandled error` output.

**Active old-order control:** replace `TestLifetime.drain` with unpark, `await setTimeout(50)`, and cleanup without awaiting bodies or operations. This reproduces both the failing successor and the unhandled lease-loss error. The outer named regression alone goes red. Restore leaves `git diff --stat` empty.

Mutation safety: stage the live files, confirm empty working diff, apply `NON-VACUITY BREAK` to `test/store/test-lifetime.ts`, capture **1 file, +4/-1**, run the control, restore with checkout and touch, confirm empty working diff. No source mutation was needed.

## Measurements

All sustained load was on `tester@2.28.133.11`, Linux `openai-auth-test`, Bun **1.3.14**, eight online CPUs and **16 busy workers**. No busy load was injected on macOS. Raw logs remain in `/home/tester/common-auth-bg27/followup.*.jsonl`.

| Probe | Loaded passes/runs | Whole subprocess duration range |
| --- | --- | --- |
| Original unknown-identity add test, baseline | 20/20 (0 failures) | 251–663 ms |
| Both split roster-order cases, final | 20/20 invocations; 40/40 cases | 299–873 ms |
| Real timeout-isolation regression | 20/20 | 395–1081 ms |
| Entire account-keyed-refresh file | 20/20 invocations; 200/200 cases | 3356–6043 ms |

Natural runs are separate: macOS Bun **1.4.2**, without injected load, affected-file verification passed **12/12** tests across three files. The negative control on that runtime failed exactly the outer timeout-isolation regression; its child had the intentional timeout plus a failed successor and an unhandled lease-loss error.

## Gates and limitations

Final gates on macOS, Bun **1.4.2**, TypeScript **7.0.2**, Biome **2.5.14**:

- Build passed: installed ranges covered 12 dependencies; TypeScript build exited zero.
- Typecheck passed, exit zero.
- Lint and format checks passed: 215 files each, no fixes.
- AFT inspection: five affected TypeScript files, zero errors/warnings.
- Comment review: six blocks examined, none flagged.
- Required full JUnit suite was run once: **1097 pass, 11 skip, 1 fail**, 7109 assertions, 1109 tests across 93 files. Every changed/account-keyed test passed. The unrelated failure was `test/tui-prefs/watcher.test.ts`, **`debounces bursts into few callbacks`**, received **5** callbacks against **<5**, **909.93 ms**. No busy workers were injected on that Mac. The watcher was not changed or retried.
- Required sources command was run against that JUnit: **1092 cells parsed, 1091 matched**; the only missing passing cell was the failed `debounces bursts into few callbacks`. All follow-up provenance rows matched.

The unrelated full-gate failure is disclosed rather than retried into a green result. The JUnit artifact is removed before committing. The remaining negative wall-window assertions in the known-identity/default-lock tests were not silently weakened; this follow-up fixes their lifecycle ownership, not an untraced contention-attempt seam.
