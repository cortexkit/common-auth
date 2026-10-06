# Post-recreation marker-loss cleanup

## Design note for source review

- **Defect:** contender A exclusively recreates a stale lock, then stalls before Fence check 4. Its lease and eviction marker expire. B recovers the marker, replaces A's expired record, and verifies ownership. A resumes, detects marker loss, and the former unconditional removal deletes B's valid lock. ANTAUTH reported this on the acquisition-orderings base and 0.9.0 with real clocks and a 10 s lease.
- **Fix:** `src/fs/refresh-file-lock.ts:478` calls the existing `relinquishLockAfterMarkerLoss()` instead of unconditional `rm`. That helper at `:312` reads the record and removes it only if its ownerId is still A's. A still returns null. No lease, retry, renewal or release semantics change.
- **Barrier:** source-only commit `ad06622` adds awaited `stale-lock-recreated` at `src/fs/refresh-file-lock.ts:473`, after successful exclusive recreation and before Fence check 4; the union member is at `:70`. No existing awaited barrier could pause there. It is guarded by `if (options.onStep)` like the other control barriers; absent hooks add no awaited boundary. This is an awaited control barrier: its rejection propagates as the acquisition's rejection, and finally releases the marker. The recreated record is left in place, without renewal or a handle, until its lease expires; no immediate cleanup is promised. This is not an observational notification or lease extension. Exhaustive TypeScript switches fail typechecking until they handle the new union member, and observers must ignore steps they do not recognise.
- **Limit:** the helper's owner read and removal are not atomic. Between A's owner read and its rm, a successor's record written in that interval can still be deleted. The fix closes only the demonstrated case, where B is already installed before A starts relinquishing. The OS-managed kernel lock planned for 0.10 removes the window by holding exclusion until the process releases the lock or exits. No winner-count guarantee is claimed for that residual interval.
- **Review:** minimal fix source-only commit `cdb9831`; ANTAUTH and AGAUTH should review both source commits before merge. No publication or tag is made here. ANTAUTH's read-only real-clock evidence folders are `parent-post-acquire-fence-cry_596q` (successor removed) and `parent-post-acquire-fence-_kj4s5al` (cleanup-only control preserves it), under `/Users/ufukaltinok/Work/Projects/CortexKit/anthropic-auth/.cortexkit/alfonso/probes/`.

## Forced schedules

`test/fs/acquisition-orderings.test.ts` uses an injected mutable clock, explicit `renew: false`, awaited lifetime-managed barriers, and complete asserted step traces. No sleeps determine either schedule. Recovery renames and removes the expired eviction marker before retrying acquisition; its existing retry backoff affects duration, not the forced ordering.

1. `post-fence marker loss preserves the successor after stale lock recreation`: park A at `stale-lock-recreated`, read its owner, advance the clock by 60,001 ms past its 60,000 ms lease and 5,000 ms marker lifetime, run B to completion, verify B's distinct owner and `assertOwned()`, then resume A. A returns null; B's complete record remains identical and its ownership assertion passes again. A's trace is `stale-lock-observed`, `eviction-marker-acquired`, `stale-lock-confirmed`, `stale-lock-removed`, `stale-lock-recreated`, `relinquish-read`. B's trace is `stale-lock-observed`, `stale-marker-stat`, `stale-marker-claimed`, followed by the same stale takeover sequence through `stale-lock-recreated`.
2. `post-fence marker loss removes its own recreated record without an orphan`: park A at recreation, confirm its new record, remove only its marker, then resume. A returns null, its owned record is absent (`ENOENT`), and its trace ends with `relinquish-read`.

The four existing ordering tests still check fresh-marker refusal, liveness rechecking under the marker, failed recreation when a challenger wins the deletion gap, and live-owner refusal on retry. Successful takeover traces now include the new barrier; ordering 3's failed recreation still excludes it. The shared fixture clock is mutable only for the new successor schedule; other tests do not advance it.

## Red-first and isolated controls

Before the fix, the preservation test failed by name with `ENOENT` reading B's lock: 0 pass / 1 fail, 6 assertions. This ran on `ad06622`, which is base `b8aab02` plus only the necessary pause barrier; acquisition cleanup still had the base's unconditional removal. Uninstrumented base cannot execute the new pause schedule because the barrier does not exist there.

Both isolated controls staged the live source/tests/docs first and confirmed empty unstaged `git diff --stat`. Each deliberate defect was marked `NON-VACUITY BREAK` to distinguish temporary control code from the implementation, applied alone, and restored with `git checkout -- src/fs/refresh-file-lock.ts && touch src/fs/refresh-file-lock.ts`. Each mutated stat was `1 file changed, 2 insertions(+), 1 deletion(-)`; each restored stat was empty. No mutant was committed.

| Control | Exact selected test | Result |
| --- | --- | --- |
| Restore unconditional removal at Fence check 4 | post-fence marker loss preserves the successor after stale lock recreation | exit 1, ENOENT reading successor; 0 pass / 5 filtered / 1 fail |
| Omit relinquishment at Fence check 4 | post-fence marker loss removes its own recreated record without an orphan | exit 1, received owned JSON instead of ENOENT; 0 pass / 5 filtered / 1 fail |

No other tests failed; the other five were filtered in each control.

## ANTAUTH driver compatibility

Read-only inspection of `native-acquisition-post-fence-parent-20261006.py` found its instrumentation requires the exact adjacent bytes `if (!acquired) return null` then `// Fence check 4:` (lines 28–30). The necessary new production barrier now separates those lines, so the unmodified driver would fail its assertion before running the race. It also creates output under the anthropic-auth checkout and archives from the hard-coded parent common-auth checkout. It was not run or edited; the deterministic test above reproduces the same schedule against the actual fixed source. The driver must be updated by ANTAUTH to use the new barrier rather than expecting those two source lines to be adjacent before it can run against this revision.

## VM loaded repetitions

Loaded repetitions ran on the dedicated test VM `tester@2.28.133.11`, in isolated directory `/home/tester/common-auth-post-fence-bg5cfcb`. Snapshot: `git archive HEAD` after both source commits, overlaid with the new test. Frozen install with Bun 1.3.14 installed 754 packages, no manifests/lockfiles changed. For each version in `1.4.2 1.3.14`, sequentially:

```sh
TEST_BUN=$HOME/rt/bun-$version/bun $HOME/rt/bun-$version/bun scripts/load-probe.mjs test/fs/acquisition-orderings.test.ts "post-fence marker loss" 20 16 > loaded.$version.jsonl
```

Both commands exited 0, each summary `passes: 20, failures: 0, runs: 20, workers: 16`. Each subprocess selected both new tests: 40 executions per test across the two runtimes, 80 named test executions total. Raw JSONL remains on the VM and in local `/tmp/post-fence-loaded-{1.4.2,1.3.14}.jsonl`. All 16 CPU-saturating workers ran on the VM, not the local Mac.

## Verification

The initial targeted Bun 1.4.2 suite passed all 6 ordering tests, 37 assertions. Build and typecheck passed for both source-only commits (TypeScript 7.0.2; 8 local manifests, 12 dependency ranges). Final exit-code gates ran on the local Mac (Bun 1.4.2, TypeScript 7.0.2, Biome 2.5.14):

| Command | Result |
| --- | --- |
| `bun run build` | exit 0; 8 manifests and 12 installed dependency ranges checked; TypeScript build passed |
| `bun run typecheck` | exit 0; `tsc --noEmit` silent success |
| `bun run lint` | exit 0; 233 files checked |
| `bun run format:check` | exit 0; 233 files checked |
| `bun test --reporter=junit --reporter-outfile=/tmp/post-fence-1.4.2.xml` | exit 0; 1141 pass / 11 existing skips / 0 fail; 1152 tests across 100 files, 5103 assertions |
| `bun scripts/check-sources.mjs docs/sources.md /tmp/post-fence-1.4.2.xml` | exit 0; 1135/1135 cells matched |
| `npx --yes bun@1.3.14 test --reporter=junit --reporter-outfile=/tmp/post-fence-1.3.14.xml` | exit 0; same test and assertion counts as 1.4.2 |
| `npx --yes bun@1.3.14 scripts/check-sources.mjs docs/sources.md /tmp/post-fence-1.3.14.xml` | exit 0; 1135/1135 cells matched |

The initial final-gate lint caught formatting of the new orphan assertion; that formatting alone was corrected and lint/format/suites passed afterward. Loaded VM repetitions preceded that whitespace-only correction. No manifest/lockfile changes or new skips. Scoped AFT TypeScript diagnostics reported zero errors/warnings in both changed code files; optional reachability/duplication metrics were unavailable. Comment review completed; genuine ambiguities in the report were clarified. The helper comment was corrected in source revision `223b3b6` to describe the non-atomic read/removal window precisely. The subsequent hook-rejection revision changes tests and documentation only; it preserves that source revision.

## Hook-rejection contract revision

Source remains byte-identical to `223b3b6`, including the corrected relinquishment comment. This revision adds only tests and documentation. `stale-lock-recreated` is an awaited control barrier, not a best-effort observer: rejection propagates as the acquisition's rejection, with the exact thrown error. Finally releases the marker, but the recreated record stays in place, without renewal or a handle, until its lease expires. No immediate cleanup is promised.

The deterministic test `stale lock recreation hook rejection propagates and leaves one unrenewed lease until takeover` enables renewal for A, reads A's new ownerId inside the recreation hook, then throws a unique error. It asserts exact error identity, the retained owned record, and the missing marker. A's complete trace is the stale takeover sequence ending at `stale-lock-recreated`, with no renewal timer notifications. The pre-expiry contender returns null with exactly `live-owner-refused`, proving `onContended` fired, and leaves the record unchanged. After the injected clock advances by 60,001 ms past the 60,000 ms lease, the next attempt acquires through the normal stale takeover sequence, persists its distinct ownerId, and passes `assertOwned()`. No sleeps or timer expiry choose the schedule; 14 assertions cover the contract.

### Isolated rejection controls

The live source, test and docs were staged first; unstaged `git diff --stat` was empty. Each deliberate defect was labelled `NON-VACUITY BREAK` and applied alone. Both invocations selected only the named hook-rejection test, with six others filtered out and no other failures. Restoration used `git checkout -- src/fs/refresh-file-lock.ts && touch src/fs/refresh-file-lock.ts`; unstaged diff was empty after each restoration. No mutant was committed.

| Control | Named failure | Mutated/restored stat |
| --- | --- | --- |
| Catch the recreation hook error and return null | `stale lock recreation hook rejection propagates and leaves one unrenewed lease until takeover`: expected the exact Error, received undefined from the fulfilled-acquisition branch; exit 1, 0 pass / 6 filtered / 1 fail | source: 6 insertions, 1 deletion; empty after restore |
| Catch the error, remove the recreated record, then rethrow | Same named test: ENOENT reading the abandoned lease; exit 1, 0 pass / 6 filtered / 1 fail | source: 7 insertions, 1 deletion; empty after restore |

### Revision verification

Local exit-code gates: Bun 1.4.2, TypeScript 7.0.2, Biome 2.5.14. `bun run build` passed (8 manifests, 12 dependency ranges), `bun run typecheck` passed (`tsc --noEmit`), `bun run lint` and `bun run format:check` passed (233 files each). Initial scoped diagnostics caught a nullable expected ownerId in the new assertion; the assertion now uses the identity already checked as a string. Initial lint caught new assertion formatting, which was corrected before the passing gates.

Full JUnit commands, each exit 0:

```sh
bun test --reporter=junit --reporter-outfile=/tmp/post-fence-rejection-1.4.2.xml
bun scripts/check-sources.mjs docs/sources.md /tmp/post-fence-rejection-1.4.2.xml
npx --yes bun@1.3.14 test --reporter=junit --reporter-outfile=/tmp/post-fence-rejection-1.3.14.xml
npx --yes bun@1.3.14 scripts/check-sources.mjs docs/sources.md /tmp/post-fence-rejection-1.3.14.xml
```

Each suite: 1142 pass / 11 existing skips / 0 fail; 1153 tests across 100 files, 5117 assertions. Each source check: 1136/1136 cells matched. No new skips, manifest changes or lockfile changes.

Loaded repetitions ran on the dedicated VM `tester@2.28.133.11`, isolated directory `/home/tester/common-auth-post-fence-rejection-bg5cfcb`. Frozen Bun 1.3.14 installation installed 754 packages without manifest/lockfile changes. For each runtime, sequentially:

```sh
TEST_BUN=$HOME/rt/bun-$version/bun $HOME/rt/bun-$version/bun scripts/load-probe.mjs test/fs/acquisition-orderings.test.ts "stale lock recreation hook rejection" 20 16 > loaded.$version.jsonl
```

Bun 1.4.2 and 1.3.14 each exited 0 with `passes: 20, failures: 0, runs: 20, workers: 16`: 40 executions of the new named test total. No CPU-load workers ran on the local Mac. Raw JSONL remains on the VM and in `/tmp/post-fence-rejection-loaded-{1.4.2,1.3.14}.jsonl`. SHA-256 comparisons confirmed the exact local source/test files equal those run on the VM: source `180b05be3fef0ac771dc673987ba85aa9399ccb307410d27f545724312cf0cf3`, test `08fd626589a37bf831f1f2e48bd0005853f8ae598cb3b7797d01ba859a456850`.
