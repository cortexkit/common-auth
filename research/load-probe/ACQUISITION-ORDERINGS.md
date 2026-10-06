# Deterministic stale acquisition orderings

## Design note for source review

- Shape: add `stale-lock-observed` and `stale-lock-removed` to the existing `onStep` union in `src/fs/refresh-file-lock.ts:67–69`.
- Emission sites: `src/fs/refresh-file-lock.ts:441`, after the first liveness check observes staleness and before marker mkdir; `src/fs/refresh-file-lock.ts:469`, after stale-file removal and the post-removal marker-ownership check, immediately before exclusive recreation.
- Delivery: awaited, like the existing control barriers. Callback failure propagates through the acquisition's marker-release finally block. No hook means no extra scheduling boundary.
- Semantics: removal has completed and marker ownership was checked; the pathname is not reserved. A competing exclusive create can win while the callback is parked. The holder must still respect recreation failure.
- Limits: the callback does not reserve the empty pathname or guarantee continued marker ownership. This is a control barrier, not a fire-and-forget observer.
- Source changes are two union values and two awaited emissions, in separate source-only commits. Existing barriers cannot park a plain stale contender before marker mkdir, or park the holder in the deletion gap. Pausing after the first stale observation lets the test exercise the second liveness check without another contender changing marker ownership first; pausing after removal lets it exercise failure of exclusive recreation.

## Forced schedules

`test/fs/acquisition-orderings.test.ts` records each contender's entire step trace before cleanup, plus live-owner refusals from `onContended`. Leases use a fixed injected clock, renewal is disabled, and every paused callback is registered to resume during test cleanup. No sleeps choose the schedule; internal retry backoff affects duration only.

1. Both contenders park at `stale-lock-observed`, proving they observed the original stale file before marker mkdir. Holder resumes first and parks at `stale-lock-confirmed` while the original file remains present. Challenger resumes, sees the fresh occupied marker, and returns null without a live-owner refusal. Holder then finishes. Challenger's trace contains only its stale observation; holder's contains stale observation, marker acquired, stale confirmed and stale removed.
2. First contender parks at `stale-lock-observed`, before marker mkdir. Another contender acquires the marker, installs a live successor and releases the marker. Resuming the first acquires the free marker, then records `live-owner-refused` without reaching `stale-lock-confirmed`. The persisted successor and its ownership assertion remain intact. Removing the second check now actually deletes the live successor, rather than being masked by a marker-ownership refusal.
3. Challenger parks at `stale-marker-claimed` with the expired marker renamed away from the active marker pathname. Holder acquires the now-free marker and parks at the new removal barrier. Challenger resumes from that callback, removes the renamed expired marker, and its top-of-loop exclusive create wins the empty pathname. Holder resumes and exclusive recreation fails. Exactly one non-null result, with unchanged successor bytes.
4. Delayed contender parks at `stale-marker-stat`. Another contender recovers the old marker, installs a successor, and releases the marker. Delayed rename sees a missing marker and retries; top-of-loop liveness refuses the successor. Its trace has the earlier stale observation and live refusal, but no marker-acquired or deletion step.

The 512-round test is unchanged. These deterministic guards make it a candidate for a smaller smoke count, not a decision to reduce it: random coverage still samples additional schedules, and the deletion-gap and delayed-retry cases deliberately seed an expired eviction marker so `stale-marker-claimed` can park cleanup before the retry's exclusive create and `stale-marker-stat` can park recovery before observing the successor.

## Verification

Local gates on Bun 1.4.2 passed: `bun run build`, `bun run typecheck`, `bun run lint`, `bun run format:check`. TypeScript 7.0.2; Biome 2.5.14 checked/formatted 233 files; build checked 8 manifests and 12 installed dependency ranges. The first typecheck before building reported missing self-package declarations; build produced the required declarations and all subsequent typechecks passed.

Both full JUnit suites passed: Bun 1.4.2 and Bun 1.3.14 each reported 1139 pass, 11 existing skips, 0 fail, 1150 tests across 100 files, 5090 assertions. `scripts/check-sources.mjs docs/sources.md` against each JUnit artifact matched all 1133 cells. Artifacts are `/tmp/common-auth-bg6be958-{1.4.2,1.3.14}.xml` in the worker's local temporary directory, not included in the repository.

### Isolated mutation controls (Bun 1.4.2)

Each source mutation was applied alone with the live files staged first, a nonempty `git diff --stat` captured, the named test run using `-t 'ordering N'`, then restored using `git checkout -- src/fs/refresh-file-lock.ts && touch src/fs/refresh-file-lock.ts`. Each mutant was marked `NON-VACUITY BREAK`. Each diff showed `1 file changed, 2 insertions(+), 1 deletion(-)` during mutation and an empty unstaged diff after restoration. Each selected test failed by name, with the other three filtered out and no other failures.

| Control | Red test | Observed failure |
| --- | --- | --- |
| Remove a fresh occupied marker instead of returning null | ordering 1 refuses a fresh occupied eviction marker after observing the original stale lock | Challenger unexpectedly returned a lock; `toBeNull` failed |
| Skip the second liveness check under the marker | ordering 2 rechecks liveness under the marker and preserves the replacement owner | Delayed contender removed/replaced the live successor and unexpectedly returned a lock; `toBeNull` failed |
| Claim acquisition even after exclusive recreation failed | ordering 3 gives the top-of-loop exclusive create the deletion gap and refuses the holder recreate | Holder unexpectedly returned a second lock; `toBeNull` failed |
| Skip top-of-loop liveness refusal | ordering 4 refuses the newly live lock on retry after its earlier stale observation | Trace gained `stale-lock-observed` and `eviction-marker-acquired`; exact trace assertion failed. The second liveness check still preserved the successor, so this control proves the top guard's schedule, not standalone data loss |

An earlier exploratory second-check test let another contender take the paused contender's marker. Skipping the liveness check then failed only the refusal-trace assertion: the marker-ownership check still prevented removal. It was replaced with the first-observation barrier so the final ordering-2 control demonstrates actual successor replacement.

### VM loaded repetitions

Host: `tester@2.28.133.11`; isolated directory `/home/tester/common-auth-acquisition-bg6be958`. Installed with `$HOME/rt/bun-1.3.14/bun install --frozen-lockfile` (754 packages); no manifests or lockfiles changed. Runtime/case groups ran sequentially. For each version in `1.4.2 1.3.14` and ordering in `1 2 3 4`:

```sh
TEST_BUN=$HOME/rt/bun-$version/bun $HOME/rt/bun-$version/bun scripts/load-probe.mjs test/fs/acquisition-orderings.test.ts "ordering $ordering" 20 16 > loaded.$version.ordering$ordering.jsonl
```

All eight commands exited 0. Each raw JSONL summary reports `passes: 20, failures: 0, runs: 20, workers: 16`: 160 selected-test executions total. Raw artifacts remain only in the isolated VM directory above, not in the repository. No load workers ran on the Mac.
