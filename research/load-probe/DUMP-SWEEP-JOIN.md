# Join the first automatic dump sweep

The interval test now seeds a separate old artifact before the first dump and awaits the existing logger's `removed old dump files` message. `sweepDumpDirectory` emits that message after all filesystem work, immediately before returning (`src/dump/index.ts:318-321`). Seeding an eligible artifact guarantees a removal and therefore the message. The callback is synchronous and there is no subsequent await in the sweep, so the waiting test resumes only after the sweep returns. No production API or implementation changed.

Only after that barrier does the test insert the synthetic artifact whose survival checks interval throttling. It also spies on directory `lstat`: an automatic sweep invokes that call before its first await, so the count after the second dump resolves directly proves that no second sweep started. The first count is one and the second count must remain one. The existing artifact-survival and explicit `sweep()` eviction assertions remain. The old artifact-count polling and 100 ms sleep have been removed from this test, with no timeout changes, retries or new skips.

## Controls

`dump-sweep-overlap.mjs` now copies the fixed test and parks its first actual directory lstat. While parked, the seeded artifact still exists and the later synthetic artifact is absent. The driver releases the parked call before awaiting the test's first-sweep barrier; both the barrier and synthetic-artifact insertion verify release has occurred. The old ordering (insert the synthetic artifact before the first sweep's directory read) cannot pass the test's first-sweep completion barrier. This is a controlled ordering demonstration, not a natural isolation pass used to deny an overlap. The original failing reproducer remains available in Git at `7d8303f:research/load-probe/dump-sweep-overlap.mjs`.

Local `bun research/load-probe/dump-sweep-overlap.mjs`, Bun 1.4.2, passed its sole copied test with 12 assertions. The same driver passed on the VM with Bun 1.3.14, also 12 assertions.

For the negative control, staged the live test and driver, confirmed an empty unstaged diff, then temporarily added `sweepIntervalMs: 0` to this test's dumper options, marked `NON-VACUITY BREAK`. Setting `sweepIntervalMs: 0` uses the existing configuration to allow the second dump to schedule a sweep without changing production code. `git diff --stat` recorded `test/dump/dump.test.ts | 1 +` and `1 file changed, 1 insertion(+)`. Running `bun test test/dump/dump.test.ts` failed only `the automatic sweep runs at most once per interval while sweep runs now`: the second directory-lstat count expected 1 and received 2. All other 42 tests in the file passed. Restored with `git checkout -- test/dump/dump.test.ts && touch test/dump/dump.test.ts`; the unstaged stat was empty. No mutation was committed.

## Verification

Local natural run: Bun 1.4.2 (`744846f84`), TypeScript 7.0.2, Biome 2.5.14.

- `bun run build`: passed; 8 local package manifests and 12 installed dependency ranges checked, followed by the silent-success compiler gate.
- `bun run typecheck`: passed (`tsc --noEmit`).
- `bun run lint`: passed, 226 files checked.
- `bun run format:check`: passed, 226 files checked.
- `bun test --reporter=junit --reporter-outfile=test-results.xml`: 1119 passed, 11 existing environment/opt-in skips, zero failures; 1130 cases / 98 files, 4989 assertions, 173.66 seconds.
- `bun scripts/check-sources.mjs docs/sources.md test-results.xml`: 1113/1113 cells matched. No source row change is needed because the test title and provenance are unchanged.
- Scoped AFT inspection: zero errors/warnings, two unchanged TypeScript hints. Comment review: three changed comment blocks examined; clarified the overlap driver's comment and two report passages after follow-up review.

Loaded runs were performed only on `tester@2.28.133.11`, snapshot `/home/tester/dump-sweep-bg75`. Bun 1.3.14 installed the frozen lockfile (754 packages), and build passed (6 package manifests in the isolated VM archive, 12 installed dependency ranges). One loaded invocation:

```sh
TEST_BUN="$HOME/rt/bun-1.3.14/bun" bun scripts/load-probe.mjs test/dump/dump.test.ts '.*' 1 16
```

Result: 43/43 tests passed, 147 assertions, 16 busy workers; the interval test passed at 7.69 ms. Raw probe output is `/home/tester/dump-sweep-bg75/loaded-dump-1.3.14.jsonl`. This is one full dump-file loaded run, not a loaded full-suite claim. The full JUnit gate above ran locally in natural order.
