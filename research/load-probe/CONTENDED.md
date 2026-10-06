# Real lock-refusal observations

## Design note for source review

- **Shape:** `LockEvent` adds `{type: 'contended', name: string, path: string}`. The name and target path are identical to the fields on `acquired` and `released`; they are not an owner identifier or an acquisition token.
- **Emission sites:** live-owner refusals call `contended()` at `src/fs/refresh-file-lock.ts:406` and `:424`. The primitive invokes its optional observer at `src/fs/refresh-file-lock.ts:394`; the store forwards that notification at `src/store/refresh-lock.ts:86` and delivers `onLockEvent` at `src/store/refresh-lock.ts:72`, before the existing store retry delay.
- **Delivery:** synchronous notification, never awaited. Synchronous observer throws are caught and cannot affect acquisition or release. Returned promises are not joined; consumers must handle their own asynchronous rejections.
- **Guarantee:** each acquisition attempt refused by a live owner emits a notification. Stale takeover and successful attempts never emit contention. A notification establishes that the contender actually attempted acquisition and found a live owner; it is not evidence inferred from elapsed time.
- **Limits:** it does not announce queue entry, identify the owner, guarantee continued exclusion after the notification, or predict the next attempt's outcome. Other unsuccessful paths, such as contention on an eviction marker without a confirmed live owner, do not emit this event. Polling, leases, jitter and lock ordering are unchanged.

## Change and scope

Source-only review commit: `bd9b7fa9a3ca6d611b3fdb9d6a4052255e2b9bfb`. Test conversions and adoption guidance are separate in `2fcc9eebef1904fd420afcc8e80d5e6123e24416`, based on `28e9d0ded7adb074a3d1a10a38c13fac66082ad4`. Verification originally ran against `b3c1b80763bb5a50a368df0486e86b5b4dadf951`; after separating commits, `git diff` against that snapshot is empty for `src/`, `test/` and the adoption/provenance documents. The following documentation commit adds this report, the inventory updates and compact VM records without changing the tested implementation. No tag or publication was made.

The file-lock primitive accepts an optional, non-awaited `onContended` observer. Both existing live-owner refusal branches call it immediately before returning `null`. Other unsuccessful acquisition paths (such as a fresh eviction marker) are not mislabeled as a live-owner refusal. Store acquisition forwards this as `onLockEvent({type: 'contended', name, path})`, before the existing timeout check and retry sleep. Polling, jitter, leases and acquisition/release ordering are unchanged. Synchronous observer exceptions are isolated. The old acquired/released delivery sites did not actually guard throws; the shared emitter now guards all three kinds as required. Returned promises are not awaited; consumers remain responsible for their asynchronous rejections.

The union widening can break a consumer's exhaustive TypeScript switch. A consumer treating any non-acquired event as a release must explicitly handle `released`. Adoption guidance describes both cases. Tests that assert only acquisition/release order now filter out contention events rather than asserting scheduler-dependent refusal counts.

## Converted inventory

Sixteen negative windows across fifteen named store tests are removed, including the child-process replace and pull capture paths. The two re-keying windows belong to one test; the row-transition test also exercises both operation orders. `settlesWithin` has no remaining callers and is removed. The scenario records actual refusals by exact lock name and path, so a fast notification is not lost before its wait is registered. Its returned observation is itself cancellation-aware: the scenario is a managed resource, and teardown must not retain an uncancellable raw waiter. `blocked` observes the refusal with `observed`, then checks the contender has not fulfilled or rejected. Existing and additional side-effect assertions run with the holder still parked, followed by release and completion checks.

Important target corrections: pull capture contends on config `save`, not a row lock; removal and row transition use `row-acct-a`, because their fixtures seed a known identity. The account-keyed schedule first observes `row-y`, then `row-acct-A` after the identity write. The default-provider non-overlap case now parks X before starting Z and observes Z's provider-wide refusal; positive account-keyed overlap still awaits both provider entries.

The vendored legacy writers already use this repository's file-lock primitive. Optional test-only observer plumbing through `mutateAccounts` and `saveAccountState` exposes their config/state `save` refusals without changing their polling or writes. The fixture was copied from openai-auth's account writer at commit 5809e38c335481199221b97c5af9a839693b274b; `docs/sources.md` records the added observer as an intentional deviation from that copy.

`FIXED-WAITS.md` marks each resolved row and the remaining boundaries. The Claustrum roster's separate acquisition does not deliver store events; its 30 ms window remains, requiring a separate refusal API outside the allowed source paths. Filesystem renewal/join, watcher quiet-window and dump-sweep cases are also outside this store exclusion change. Deliberate scenario timers remain. No test timeout was increased, no new skip was introduced, and no retry was added to a test.

## Mutation controls

`contended-controls.json` records 39 isolated test/control pairs, all **reddened**, with exact failing test names, exit codes and non-empty/empty source-diff evidence. Every invocation selected exactly one named test; other tests in its file were excluded, so no result is claimed for them.

- Bypass both live-owner checks: all fifteen converted tests and three event-contract tests fail by name (18/18).
- Remove the primitive contention emission: the same 18/18 fail by name. Every run reports `Expected observation was not received before test cancellation`; none hangs. The runner deadline fails the test, teardown cancels the `observed` helper's wait for the missing notification, and releases the operations or test-owned leases deliberately holding the contested locks.
- Emit contention on successful acquisition: `contended events distinguish live owners from stale takeovers and successful attempts` fails (1/1).
- Propagate a synchronous observer exception: `throwing lock event observers cannot affect contention acquisition or release` fails (1/1).
- Await observer promises: `lock event observer promises are not awaited` fails (1/1).

The first two source mutants each remain applied while the eighteen separately filtered invocations run; they are then restored before applying another mutant. The remaining three are applied/restored separately. Before each variant the live source is in the Git index and the working diff is empty; every mutant is marked `NON-VACUITY BREAK`, a non-empty `git diff --stat` is captured, and `git checkout -- <path>` plus `touch <path>` restores an empty working diff. The report is staged separately from source restoration. The reusable `contended-controls.py` reproduces the two eighteen-test matrices; the three delivery/filtering controls were executed separately and recorded in the same JSON artifact. These controls show that every selected test detects each broken source variant. They do not separately exercise every loop iteration or suppress just the second re-keying observation (`row-acct-A`) while preserving the first (`row-y`).

The new live/stale/success test verifies real live-owner refusals carry the exact name and path, successful acquisition/release ends with those events, and takeover of an explicitly expired owner produces only acquired/released. Separate tests cover throwing callbacks across contention, acquisition and release, and unresolved returned promises.

## Local gates

Mac, Bun **1.4.2** (build `744846f84`), TypeScript **7.0.2**, Biome **2.5.14**, Node **24.16.0**:

- `bun run build`: exit 0; local-dependency validation scanned 8 package manifests; installed-range validation checked 12 dependencies; TypeScript build succeeds.
- `bun run typecheck`: exit 0 (`tsc --noEmit`, silent success).
- `bun run lint`: exit 0; 228 files checked.
- `bun run format:check`: exit 0; 228 files checked.
- `bun test --reporter=junit --reporter-outfile=test-results.xml`: exit 0; **1126 pass / 11 existing environment skips / 0 fail**, 1137 tests in 99 files, 5025 assertions, 115.39 s.
- `bun scripts/check-sources.mjs docs/sources.md test-results.xml`: exit 0; **1120/1120 cells matched**.

Mac, explicit Bun **1.3.14** (build `0d9b296a`):

- `npx --yes bun@1.3.14 test --reporter=junit --reporter-outfile=test-results-1.3.14.xml`: exit 0; **1126 pass / 11 existing environment skips / 0 fail**, 1137 tests in 99 files, 5025 assertions, 112.40 s.
- `npx --yes bun@1.3.14 scripts/check-sources.mjs docs/sources.md test-results-1.3.14.xml`: exit 0; **1120/1120 cells matched**.

The worktree arrived frozen-installed. No manifest or lockfile changed. An initial exploratory typecheck ran before build and failed self-package imports; building resolved them. The initial targeted test run also exposed two wrongly chosen identity lock names and an unfiltered event-order log; those were corrected before controls and final gates. Its timeout failures are not presented as a successful gate. The editor tooling's scoped TypeScript/Biome diagnostics reported zero errors/warnings; its broader reachability and duplication analysis was unavailable in the worktree. The command-line gates above are the verification authority. Comment review was performed and genuinely unclear new comments were rewritten.

## VM-loaded full suites

Host `tester@2.28.133.11`; isolated source snapshot `/home/tester/common-auth-contended-bg052d`, transferred using `git archive HEAD | ssh ... tar -x`. Frozen install with Bun 1.3.14: 754 packages. VM build/typecheck/lint/format all exit 0; build checks 6 tracked local manifests and 12 installed dependency ranges, Biome checks 228 files. Local build's two extra manifests come from local test-generated fixture directories. TypeScript is 7.0.2 and Biome is 2.5.14.

The first three-run probe was configured with system Node **22.23.3** instead of the required Node 24. All three runner exits were 1: 1119 pass / 10 skips / 8 failures, all eight being RPC tests explicitly requiring Node 24. They are retained in `contended-vm-setup.jsonl`, not silently discarded. No source correction was needed: the required preinstalled Node **24.16.0** was prepended to PATH. This is an environment correction, not a retry strategy for flaky tests.

Corrected invocation (one three-run probe, sequential full suites, 16 CPU workers, no load on the Mac):

```sh
cd /home/tester/common-auth-contended-bg052d
export PATH="$HOME/rt/bun-1.3.14:$HOME/rt/node-v24.16.0-linux-x64/bin:$PATH"
TEST_BUN="$PWD/research/load-probe/fixed-waits-suite-runner.sh" \
BUN_PROBE_RUNTIME="$HOME/rt/bun-1.3.14/bun" \
FIXED_WAITS_LOG_DIR="$PWD/research/load-probe/contended-vm-logs" \
bun scripts/load-probe.mjs test/store/refresh.test.ts full-suite 3 16
```

`scripts/load-probe.mjs` normally passes a test file and title to its selected runner. Here the selected runner is the existing full-suite adapter: it intentionally ignores those selection arguments to run the complete JUnit suite, returns the suite's exit code on failure, then checks sources on success. The enclosing SSH command returns the probe's exit code. Output text is only evidence, never the success predicate.

| Run | Runner exit | Probe duration | Tests | Assertions | Source cells |
| --- | --- | --- | --- | --- | --- |
| 1 | 0 | 144459 ms | 1127 pass / 10 skips / 0 fail | 5027 | 1120/1120 |
| 2 | 0 | 149318 ms | 1127 pass / 10 skips / 0 fail | 5027 | 1120/1120 |
| 3 | 0 | 142087 ms | 1127 pass / 10 skips / 0 fail | 5027 | 1120/1120 |

Probe exits 0 with **3 passes / 0 failures**. Compact evidence is `contended-vm.jsonl`. Raw logs and JUnit remain on the VM at `research/load-probe/contended-vm-logs/fixed-waits-suite-{334095,336585,338983}.{log,xml}` under the snapshot directory. The VM can exercise the private-group permissions test that is skipped on the Mac; the ten remaining skips are the existing opt-in OpenCode placement environment, not introduced by this change.
