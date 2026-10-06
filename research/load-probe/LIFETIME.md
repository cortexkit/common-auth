# Test bodies own their resources through teardown

## Replay identity and scope

The exact test-only implementation commit is **`d94b99375ac589d6e1eca7c67ace8383a851039c`**, based on `1db4c824f650b8863bfa4c81356ed06d72b76813`. This report is a subsequent documentation-only commit. Check out the implementation commit above to reproduce the tested code and run the commands in Measurements and gates.

**Production is unchanged.** `git diff 1db4c824f650b8863bfa4c81356ed06d72b76813 --exit-code -- src/ package.json` exited zero before committing. No production code, dependency manifest, lockfile, timeout budget, retry policy, or test skip for load-related conditions was changed.

A Bun test timeout fails the test but does not cancel its JavaScript body. The exposed pattern is therefore broader than release-then-sleep teardown: an ordinary awaited file operation can still resume after an `afterEach` deletes its files, closes its consumer, or the next `beforeEach` replaces its module-level scenario. All cleanup/setup-bearing files are protected, not only files with a previously observed collision.

## Implementation and boundaries

- `test/fixtures/test-lifetime.ts` owns complete bodies, separately started operations, parked-operation releases, and resource finalizers. `test/fixtures/drain-bodies.ts` opens registered barriers, awaits bodies, awaits operations, then awaits cleanup. Cleanup is asynchronous when needed.
- The original `test/store/test-lifetime.ts` and `test/store/drain-bodies.ts` import paths remain working through re-exports of those explicitly shared helpers. The already-protected account-keyed tests need no second wrapper.
- `test/fixtures/lifetime-hooks.ts` creates one owner per test within each adopting file. Its registration wrapper preserves `it`/`test`, parameterized registration, conditional registration, callback bodies, and registration options. Its cleanup hooks drain before invoking resource cleanup. Its setup hook drains the preceding owner before replacing shared state, including files with setup but no cleanup; its final hook drains the last owner.
- Store scenarios and stores are managed through proxies. Promise-returning calls are observed immediately, including calls an assertion failure prevents the body from awaiting. Managed stores also register their explicit `pullsSettled()` join: `load()` alone is not a join of background pulls. Private-field methods and getters use the original object as receiver.
- Consumer and enrollment methods are managed as operations. Deferred connector replies, enrollment proposal gates, and store/provider release gates are registered with the owner. A release registered after teardown begins is invoked immediately.
- The lock tests own acquisition promises and join lock release before deleting their directory. They do **not** join `whenLost()`: normal release intentionally leaves that subscription pending, and joining it would hang teardown. Release itself joins outstanding renewal work. Renewal/removal release gates are registered independently.
- The schema observation loop now stops and is joined in `finally`, including when a write fails. Its partial-file, temp-file, and final 21-account assertions are unchanged.

The intentionally pending pull tests retain their names and assertions. Their callbacks remain pending throughout the entire test body; only teardown releases a stop gate and makes them **reject without returning an observation to persist**. This replaces uncollectable forever-pending callbacks without allowing a reading to complete during the property being tested. The attribution helper's later calls use the same teardown-only rejection, so only the first paused reading can be recorded. The commit message explicitly records this lifetime change. Existing bounded contention assertions and existing body sleeps were not weakened or replaced by retries.

Draining requires operations to terminate once their test-owned barriers are released. It is not cancellation, a timeout increase, or a guarantee against an indefinitely hung external operation. Bun's existing hook deadlines still apply. Concurrent test registration would require an owner per invocation rather than this file-scoped sequential owner; no converted file uses concurrent registration. A future test must explicitly own work detached from its body, rather than assuming every arbitrary promise can be discovered.

## Historical replay: collisions and timeout causes are separate

The raw macOS test-run output used for the historical findings below was read at:

`/Users/ufukaltinok/.local/share/cortexkit/aft/pi/bash-tasks/5af2ae11a659f3b7/bash-6c033fa1f082d7cb/io/stderr`

That output records a test run from source commit `5babf7a`. The following findings do not infer an await from an elapsed value.

| Test | Observable replay finding | Original timeout's pending await |
| --- | --- | --- |
| `a peer replacing an account cannot leave its old route authorized` | Lines 680–696: timeout at 9998.97 ms against 5000 ms; subsequent error between tests is `ClaustrumConsumerError: Claustrum consumer is closed`, created by `consumer.close()` in teardown. This establishes a shutdown collision, not a slow-close diagnosis. | **Untraced.** No phase marker or suspended-body stack identifies which await was pending at timeout. |
| `blocks a retryable poll refusal whose code is protocol-terminal and stops re-polling` | Lines 728–729: timeout at 5770.37 ms against 5000 ms. The replay supplies no enrollment late-error stack. Directory-deletion exposure is established by source and the new control, not asserted as an observed collision in this historical log. | **Untraced.** Neither the code iteration nor its pending await is logged. |
| `the unlocked legacy config read never observes a partial file during library writes` | Lines 982–999: timeout at 5373.95 ms against 5000 ms; body subsequently reaches the final legacy-read assertion at historical line 317, expecting 21 accounts and observing 0. Teardown has deleted/replaced the scenario used by the continuing body. This is not evidence that an atomic write exposed partial JSON. | **Untraced.** The later assertion shows continuation, not where the body was suspended when Bun timed it out. |

The test code bounds the operations that could have been in progress:

- Consumer body: fixture setup, first consumer refresh, peer refresh, and final authorization. `ClaustrumConsumer.refresh()` (`src/claustrum/consumer.ts:180–214`) awaits activation, custody connection, and roster refresh before its final open check. The close error is consistent with aborting an outstanding waiter but does not distinguish these awaits or authorization. The fixture's client methods return immediately; filesystem/token/roster work remains asynchronous.
- Enrollment body: for each of six protocol-terminal codes, create paths, seed pending metadata, reconcile, read blocked metadata, reconcile again. `reconcile()` (`src/claustrum/enrollment.ts:699–880`) awaits directory hardening, ceremony lock acquisition, token/state reads, terminal-state persistence, and lock release. The mock `enrollPoll` throws immediately; there is no real producer RPC in this test. This rules out diagnosing a slow network poll from the title, but does not identify which filesystem await or iteration was pending.
- Schema body: seed add, twenty sequential adds while a local reader loops over config reads and `setImmediate`, stop/join reader, then legacy load and final count. Store writes and reads are asynchronous. There is no phase evidence choosing among these awaits in the historical replay.

The new controls deliberately create timeout conditions. They do not explain the original timeout causes or measure an improvement in historical failure rate.

## Real-runner controls and captured red output

`test/fixtures/lifetime-isolation.test.ts` copies each **actual affected test file** to small repository scratch, resolves its relative imports to the original modules, selects the affected body plus a successor, and inserts a delay into that body after resource setup. It uses a shortened 100 ms child-test budget and a 200 ms injected delay; no existing test budget is raised. All original resource-test assertions remain. The terminal marker is added only after those assertions. A child passes the parent check only with exactly the intentional timeout, a passing successor, the final marker, and no unhandled error. Slow setup can itself exceed the shortened child budget before reaching the injected delay; either way the test body must remain owned until its real assertions finish.

Exact test names in the parent harness file, which runs the child timeout tests:

1. **`consumer real runner timeout keeps resources alive through the original body and final assertions`**
2. **`enrollment real runner timeout keeps resources alive through the original body and final assertions`**
3. **`schema real runner timeout keeps resources alive through the original body and final assertions`**

The child successor is exactly **`lifetime successor waits for original final assertions`**. The child timeout cases retain their original affected test names listed above.

Here, **reddened** means the intentional mutation makes exactly the named parent test fail, while the other two pass. **Undefended** means the mutation ran but all parent tests still passed. The marker `NON-VACUITY BREAK` identifies an intentional temporary mutation, not an implementation change.

For each control testing the previous cleanup order, stage the live implementation, confirm an empty working diff, replace that file's wrapped `afterEach` with raw Bun `afterEach`, and mark the edit `NON-VACUITY BREAK`. Capture the non-empty diff, run `bun test test/fixtures/lifetime-isolation.test.ts`, then restore with `git checkout -- <path> && touch <path>` and confirm the working diff is empty. Each final mutation was **1 file changed, 3 insertions(+), 1 deletion(-)**; each restore left an **empty** diff. No mutation was committed.

### Consumer: reddened

Mutation: `test/claustrum/consumer.test.ts`, raw cleanup closes consumers before the copied body finishes.

Captured parent output:

```text
(fail) consumer real runner timeout keeps resources alive through the original body and final assertions [237.72ms]
(pass) enrollment real runner timeout keeps resources alive through the original body and final assertions [1709.62ms]
(pass) schema real runner timeout keeps resources alive through the original body and final assertions [3195.38ms]
2 pass
1 fail
```

Captured child output includes:

```text
(fail) a peer replacing an account cannot leave its old route authorized [151.47ms]
^ this test timed out after 100ms.
# Unhandled error between tests
ClaustrumConsumerError: Claustrum consumer is closed
kind: "closed"
(fail) lifetime successor waits for original final assertions [5.59ms]
0 pass
2 fail
1 error
```

### Enrollment: reddened, with an initially undefended placement disclosed

Mutation: `test/claustrum/enrollment.test.ts`, raw cleanup deletes enrollment metadata before the copied persisted-state assertion. The final delay is after the first `reconcile()` and before the original read of blocked metadata.

Captured parent output:

```text
(pass) consumer real runner timeout keeps resources alive through the original body and final assertions [355.27ms]
(fail) enrollment real runner timeout keeps resources alive through the original body and final assertions [295.75ms]
(pass) schema real runner timeout keeps resources alive through the original body and final assertions [2661.17ms]
2 pass
1 fail
```

Captured child output includes:

```text
(fail) ClaustrumEnrollmentManager > blocks a retryable poll refusal whose code is protocol-terminal and stops re-polling [106.63ms]
^ this test timed out after 100ms.
# Unhandled error between tests
ENOENT: no such file or directory, open '.../opencode-enrollment-state.json'
(fail) lifetime successor waits for original final assertions [142.01ms]
0 pass
2 fail
1 error
```

An initial control parked after seeding pending metadata, **before** reconcile. With old cleanup it produced `3 pass, 0 fail`: reconcile recreated the deleted directory/state, so that placement was **undefended**, not credited as proof. Its mutation and restore had the same non-empty/empty diff pair. Moving the delay to the subsequent original persisted-state read exposed deletion without changing any original assertion. The later failing control uses the same enrollment test file and child test target.

### Schema: reddened

Mutation: `test/store/schema.test.ts`, raw cleanup deletes the scenario while the copied body is still doing real store work.

Captured parent output:

```text
(pass) consumer real runner timeout keeps resources alive through the original body and final assertions [373.33ms]
(pass) enrollment real runner timeout keeps resources alive through the original body and final assertions [1821.92ms]
(fail) schema real runner timeout keeps resources alive through the original body and final assertions [323.06ms]
2 pass
1 fail
```

Captured child output includes:

```text
(fail) store shapes > the unlocked legacy config read never observes a partial file during library writes [112.39ms]
^ this test timed out after 100ms.
# Unhandled error between tests
PoolOperationError: add lost a lease after its first write; the intermediate stays on disk
operation: "add", rowId: "seed", kind: "lock-ownership"
(fail) lifetime successor waits for original final assertions [130.74ms]
0 pass
2 fail
1 error
```

An earlier schema negative run instead reached the original final count and observed **20 rather than 21**, with the other two parent controls passing. Different asynchronous phases expose different manifestations of the same premature deletion; neither run diagnoses the historical pending await.

## Suite-wide enforcement: what Bun hooks can and cannot do

Bun documents global preload lifecycle hooks, asynchronous cleanup hooks, and `onTestFinished`. They surround a test but do not provide its raw body callback or the promise the runner abandoned at timeout. `onTestFinished` also is not supported for concurrent tests. A preload-only `afterEach` cannot discover pending bodies or distinguish an expected handled rejection from an unowned operation. Mocking `bun:test` to intercept registrations would replace a native runner API and its conditional/parameterized registration behavior; that is not a clean hook implementation.

Accordingly, **no bunfig preload was installed claiming automatic leak detection**. The implemented protection uses explicit registration and ownership in every inventory-exposed file. The timeout remains reported against the test whose body timed out, instead of letting teardown produce an error blamed on the next test. Finalizer failures are awaited and raised in the owning cleanup hook, after all finalizers settle, while cleanup still runs in `finally`.

Proposed suite-wide enforcement:

1. Make the shared registration wrapper mandatory for new tests with shared setup/cleanup. A CI source guard should reject direct native body/cleanup imports in such files, with explicit exemptions for the already-owned account-keyed wrapper and child fixtures.
2. Maintain ownership registries for detached operations and teardown release gates, not merely test bodies. Reject a new cleanup helper that removes resources without draining those registries.
3. If Bun adds a supported body-registration interceptor, preload it to assign a per-invocation owner/name (including concurrent cases), detect an owner still pending before resource cleanup, and report that owner as a named lifecycle failure. Keep draining/cancellation separate from reporting; a diagnostic alone does not stop the body.
4. Keep real-runner negative controls in CI. An import guard without a mutation that makes its exact named guard test fail is not evidence of enforcement.

These are proposals, not a claim that an automatic future-proof import fence or arbitrary-promise detector already exists.

Documentation consulted: [Bun lifecycle hooks](https://bun.sh/docs/test/lifecycle), [test preload configuration](https://bun.sh/docs/test/configuration#preload-scripts), and [test runtime behavior](https://bun.sh/docs/test/runtime-behavior). These are unversioned documentation; behavior here was verified with Bun 1.4.2.

## Measurements and gates

No sustained load was injected on macOS. **Natural** means an ordinary run without injected load; **loaded** means a run with sustained load deliberately injected on the VM. Those counts are reported separately.

| Measurement | Natural macOS Bun 1.4.2 | Loaded VM |
| --- | --- | --- |
| Final full JUnit suite | 1105 pass, 11 existing skips, 0 fail; 1116 cases across 95 files, 23741 assertions, 252.95 s | 0 runs; not measured |
| Final old-order controls | Three mutation runs: each has exactly its named parent failure and the other two controls passing | 0 runs; not measured |
| Initial enrollment placement | 3 pass, 0 fail under mutation; disclosed as undefended | 0 runs; not measured |

No failure-rate comparison is claimed. Future sustained replay must run only on `tester@2.28.133.11`, through `scripts/load-probe.mjs`, using the remote `~/rt/bun-1.3.14/bun` and `~/rt/bun-1.4.2/bun` runtimes. This task created no VM scratch. Child scratch directories are removed in the harness's `finally`; the JUnit artifact was checked and then removed before committing.

Final required gates, after the completed implementation:

- `bun run build`: passed; 8 local manifests and 12 installed dependency ranges checked; TypeScript build exited zero.
- `bun run typecheck`: passed, `tsc --noEmit`, TypeScript **7.0.2**.
- `bun run lint`: passed, Biome **2.5.14**, **220 files**, no fixes.
- `bun run format:check`: passed, Biome **2.5.14**, **220 files**, no fixes.
- `bun test --reporter=junit --reporter-outfile=test-results.xml`: passed with the natural counts above, Bun **1.4.2 (744846f84)**.
- `bun scripts/check-sources.mjs docs/sources.md test-results.xml`: **1099 cells parsed, 1099 matched**.
- Production-tree diff against base: empty. No package install or manifest/lockfile change was needed; the prepared worktree's frozen install was already complete.

An intermediate verification hung because a lock proxy incorrectly registered intentionally pending `whenLost()` subscriptions as operations. Its hook failures were not hidden or retried unchanged: lock ownership was corrected to join release rather than that subscription. The impacted five-file verification then passed **50 tests**, and the final full gate above passed. An outage of the shared agent-file-tools (AFT) service also interrupted work; the uncertain pull-test edit was checked on resume, found not written, and applied once before final verification. Neither incident is a historical source-timeout diagnosis.

## File and lifecycle inventory

The inventory covers the test tree's lifecycle hooks, shared fixture replacement, cleanup registries, and detached/barrier patterns. The following table lists every file exposed by shared setup/cleanup or identified detached registry work. “Wrapped” means body registration and cleanup use `lifetimeHooks`. A store scenario is the test's temporary account directory and its store factory; store rows also own the returned asynchronous store calls and await the stores' background-pull completion. “Existing owner” means the account-keyed tests already use `TestLifetime` and drain explicitly. Setup-only files drain before the next setup and at final suite teardown.

| File | Exposure and ownership |
| --- | --- |
| `test/auth-menu/accounts.test.ts` | Scenario reassigned in setup; account/store fixture cleanup after each body. Wrapped. |
| `test/auth-menu/doctor.test.ts` | Scenario reassigned in setup; store fixture cleanup after each body. Wrapped. |
| `test/cachekeep/track.test.ts` | Shared fake clock/request state reset before each test; manager work/disposal in bodies. Setup-only ownership. |
| `test/cachekeep/warm.test.ts` | Shared fake clock/request state reset before each test; overlapping warm promises and local manager disposal. Setup-only ownership. |
| `test/cachekeep/window.test.ts` | Shared fake clock/request state reset before each test. Setup-only ownership. |
| `test/claustrum/consumer.test.ts` | Shared consumer and directory registries; close/delete after each body; concurrent refresh/connect promises. Wrapped; managed consumers and connector/provider releases. |
| `test/claustrum/e2e.test.ts` | Shared clients/daemon-stop/directory registries; teardown closes/stops/deletes. Wrapped. |
| `test/claustrum/enrollment-ancestors.test.ts` | Shared directory registry and temporary process-identity spies; directory cleanup after each body. Wrapped; spy restoration remains in local finally. |
| `test/claustrum/enrollment.test.ts` | Shared directory registry; pending reconciliation and proposal gate can outlive body. Wrapped; managed managers and registered proposal release. |
| `test/claustrum/roster.test.ts` | Shared directory cleanup registry; persisted roster work. Wrapped. |
| `test/commands/command-session-isolation.test.ts` | Menu scenario reset before each test and deleted afterward; interleaved invocation promises. Wrapped. |
| `test/commands/confirm.test.ts` | Menu scenario reset/deleted around bodies. Wrapped. |
| `test/commands/failure-projection.test.ts` | Menu scenario reset/deleted; late login failure projection. Wrapped. |
| `test/commands/pi.test.ts` | Menu/store scenario reset/deleted. Wrapped. |
| `test/commands/seam.test.ts` | Menu/store scenario reset/deleted. Wrapped. |
| `test/commands/sections.test.ts` | Menu/store scenario reset/deleted around asynchronous actions. Wrapped. |
| `test/dump/dump.test.ts` | Shared directory reset/removal around asynchronous dump/response artifacts. Wrapped. |
| `test/fs/atomic-write.test.ts` | Shared directory reset/removal; write and lock operations. Wrapped; local lock finally blocks retained. |
| `test/fs/refresh-file-lock.test.ts` | Shared directory reset/removal; renewal timers, pending releases and injected renewal/removal gates. Wrapped; acquisition/release ownership and registered release gates; whenLost deliberately not joined. |
| `test/fs/with-lock.test.ts` | Shared directory/target reset/removal; lock/write work. Wrapped; body-local lock cleanup retained. |
| `test/logger/engine.test.ts` | Shared logger fixture and directory reset/cleanup; timers and file writes. Wrapped. |
| `test/logger/errors.test.ts` | Shared optional temporary-directory cleanup registry. Wrapped. |
| `test/logger/sink-only.test.ts` | Shared optional temporary-directory cleanup registry and spawned process checks. Wrapped. |
| `test/opencode2/e2e/placement.e2e.test.ts` | Suite scratch allocated before all tests and deleted after all; real host work. Wrapped afterAll; existing opt-in remains unchanged. |
| `test/rpc/discovery-strict.test.ts` | Shared server/directory/spy cleanup registries. Wrapped. |
| `test/rpc/notifications.test.ts` | Shared notification scopes reset before each test; additional scopes restored in local finally. Setup-only ownership. |
| `test/rpc/port-file.test.ts` | Shared directory/port fixture reset and teardown removal. Wrapped. |
| `test/rpc/request-errors.test.ts` | Shared RPC-server cleanup; deadline test waits for the still-running handler's finished signal before body completion. Wrapped. |
| `test/rpc/rpc-server.test.ts` | Shared server, socket and directory cleanup; in-flight requests and listeners. Wrapped; existing local finally joins retained. |
| `test/rpc/server-registry.test.ts` | Shared symbol-keyed registry and test-key set, with overlapping adoption promises. No destructive cleanup hook originally, but detached operations and gates warranted ownership. Wrapped bodies plus explicit per-test drain, tracked adoption promises and release gates. Unique per-test keys remain unchanged. |
| `test/rpc/sessionless-drain.test.ts` | Shared runtime/scope/spy cleanup and pending notifications. Wrapped. |
| `test/rpc/strict-sessions.test.ts` | Shared runtime/session cleanup around asynchronous requests. Wrapped. |
| `test/sidebar-file/lock-name.test.ts` | Shared directory/target reset/removal and write locks. Wrapped. |
| `test/sidebar-file/sidebar-file.test.ts` | Shared directory/target reset/removal; concurrent queued writes and injected write failures. Wrapped. |
| `test/store/account-keyed-refresh.test.ts` | Shared scenario reset/removal; explicitly owned bodies, store operations, and provider barriers. Existing owner retained; now imports the shared implementation through the original store path. |
| `test/store/attribution.test.ts` | Shared scenario reset/removal; detached finite pull write-back and intentionally pending later pulls. Wrapped/managed; release gates, teardown-only rejection and pullsSettled joins. |
| `test/store/child-lease.test.ts` | Shared scenario reset/removal; child work and lease checks. Wrapped/managed; body awaits child results. |
| `test/store/crash.test.ts` | Shared scenario reset/removal; crash children, survivor pulls and parked refreshes. Wrapped/managed; release gates. |
| `test/store/credential-stamps.test.ts` | Shared scenario reset/removal, including in-body scenario replacement. Wrapped/managed; body must finish before successor setup. |
| `test/store/descriptor-fence.test.ts` | Shared scenario reset/removal and persisted descriptor assertions. Wrapped/managed. |
| `test/store/downgrade.test.ts` | Shared scenario reset/removal and legacy writer calls. Wrapped/managed. |
| `test/store/epoch-range.test.ts` | Shared scenario reset/removal and write/read checks. Wrapped/managed. |
| `test/store/hooks.test.ts` | Shared scenario reset/removal; overlapping operations, parked provider and deferred detached-callback checks. Wrapped/managed; release gates. |
| `test/store/id-reuse.test.ts` | Shared scenario reset/removal and child/foreign writer work. Wrapped/managed. |
| `test/store/identity-fence.test.ts` | Shared scenario reset/removal and identity/write ordering. Wrapped/managed. |
| `test/store/initialize.test.ts` | Shared scenario reset/removal and migration writes. Wrapped/managed. |
| `test/store/provider-state.test.ts` | Shared scenario reset/removal, including in-body replacement; provider-state write/read operations. Wrapped/managed. |
| `test/store/pull.test.ts` | Shared scenario reset/removal; background pulls do not finish with load. Wrapped/managed; release gates, teardown-only rejection and explicit store joins. |
| `test/store/quota-codec.test.ts` | Shared scenario reset/removal and quota persistence. Wrapped/managed. |
| `test/store/refresh.test.ts` | Shared scenario reset/removal; overlapping refreshes, parked providers, held locks and child rotation. Wrapped/managed; release gates. |
| `test/store/remove-enable.test.ts` | Shared scenario reset/removal and paused refresh work. Wrapped/managed; release gates. |
| `test/store/renewal.test.ts` | Shared scenario reset/removal; provider/write gates and renewing leases. Wrapped/managed; release gates. |
| `test/store/reorder.test.ts` | Shared scenario reset/removal; held extra-lock gate and crash children. Wrapped/managed; release gates. |
| `test/store/row-extra-locks.test.ts` | Shared scenario reset/removal and extra-lock operations. Wrapped/managed. |
| `test/store/row-transition.test.ts` | Shared scenario reset/removal, including in-body replacements and concurrent writer gate. Wrapped/managed; release gate. |
| `test/store/rows.test.ts` | Shared scenario reset/removal and paused writer hooks. Wrapped/managed; release gates. |
| `test/store/schema.test.ts` | Shared scenario reset/removal and detached config observation loop during writes. Wrapped/managed; observer stopped/joined in finally. |
| `test/store/settings.test.ts` | Shared scenario reset/removal, including in-body replacements and settings persistence. Wrapped/managed. |
| `test/store/stamp-coverage.test.ts` | Shared scenario reset/removal and attributed read/write work, including replacement. Wrapped/managed. |
| `test/store/stamps.test.ts` | Shared scenario reset/removal and frozen-clock refresh/write checks. Wrapped/managed. |
| `test/store/strict-torn-dispatch.test.ts` | Shared scenario reset/removal, including in-body replacement; torn-row write/read checks. Wrapped/managed. |
| `test/store/torn.test.ts` | Shared scenario reset/removal, including in-body replacement; torn-row and background-pull checks. Wrapped/managed. |
| `test/tui-prefs/tui-preferences.test.ts` | Shared directory/target reset/removal; preferences write queue and lease hooks. Wrapped. |
| `test/tui-prefs/watcher.test.ts` | Shared directory/target reset/removal and disposer registry; callbacks and polling. Wrapped; existing disposer/spy finally cleanup retained. |

### Non-exposed/local-lifetime cases and intentional exclusions

The remaining tests have no cleanup/setup replacement of a shared resource comparable to the table above. In-memory tests use body-local fixtures; filesystem/process/socket tests in the following groups allocate unique resources within their body and clean them in that body's own finally, so a runner timeout does not independently delete them or replace a shared scenario:

- `test/tooling/check-sources.test.ts`, `test/tooling/check-local-deps.test.ts`: local scratch and child commands.
- `test/tui/load-tui.test.ts`, `test/tui-build/linking.test.ts`, `test/tui-build/publish-list.test.ts`, `test/tui-build/reproducible.test.ts`: local build/import scratch and finally cleanup.
- `test/rpc/client-proxy.test.ts`, `test/rpc/client-transport.test.ts`, `test/rpc/pending.test.ts`, `test/rpc/staging-security.test.ts`, `test/rpc/stop-runtime.test.ts`: body-local clients/listeners/scopes and finally cleanup.
- `test/claustrum/custody.test.ts`: body-local fake client/custody and local finally close; deferred operations use those local fixtures, not a shared teardown registry. `primary.test.ts` and `host-slot.test.ts` are in-memory cases.
- `test/store/drain-bodies.test.ts`: deliberately tests independent owner/body/cleanup ordering, with local cleanup; replacing it with its own subject wrapper would obscure the property. `test/store/timeout-isolation.test.ts` and the new `test/fixtures/lifetime-isolation.test.ts` own unique child scratch in their bodies, with local finally removal. Their non-discovered child fixtures deliberately exercise their own runner lifecycle.
- Routing, quota, auth-menu menu-model, opencode2 adapter/integration/SSE tests and logger redactor tests use body-local in-memory fixtures rather than a shared destructive teardown. Deferred in-memory request promises are not filesystem/resource-cleanup collisions.

These exclusions are not an assertion that raw body-local tests cannot time out. They distinguish continuing into one's own local finally from colliding with an independently executed destructive teardown. Lock-loss subscriptions are excluded from operation joins because a normal lock release deliberately leaves those subscriptions pending; joining them would hang cleanup and contradict the existing pending-subscription assertion. No exposed file was left unconverted on the basis that it happened to run quickly.
