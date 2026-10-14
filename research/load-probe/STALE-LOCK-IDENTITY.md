# Missing leases and identity-bound stale eviction

## Captured failure

The anthropic-auth investigation into the pool-config lease ownership failure was read from:

- `/Users/ufukaltinok/Work/Projects/CortexKit/anthropic-auth/.cortexkit/internal-docs/investigations/pool-config-lease-takeover-2026-10-14/report.txt`
- The adjacent `failure-timeline.jsonl`.

The relevant report text is copied here so the evidence does not depend on access to that checkout:

> The successor did not read the new holder's expiresAt at all. Both its initial liveness check and its check under the eviction marker returned ENOENT from readFile and stat. It then confirmed the absent lock as stale. A publishLocal writer exclusively created a fresh lock after that confirmation but before the successor's removal completed. The successor removed the fresh lock and recreated it with its own owner ID.

The report places the previous owner's release at monotonic 542.630505 ms. These fields are copied from the raw event records (all in run 53, PID 498). `seq` is the process-wide event sequence; `monoMs` is the process's `performance.now()` clock, not a duration since acquisition. `refresh` is the stale-evicting contender S; `publishLocal` is the fresh holder H:

| seq | monoMs | operation | event / step | lease details |
| --- | --- | --- | --- | --- |
| 1278 | 542.737244 | refresh | lock-is-live-read-error | ENOENT |
| 1279 | 542.760278 | refresh | lock-is-live-stat-error | ENOENT |
| 1280 | 542.797187 | refresh | stale-lock-confirmed | no owner record |
| 1283 | 542.891533 | publishLocal | acquired | owner `51b225ba-e443-4246-8782-a67a5eedb515`, expiresAt 1791949901665, ttlMs 10000 |
| 1285 | 542.953078 | refresh | stale-lock-removed | fresh holder's pathname removed |
| 1287 | 543.005527 | refresh | stale-lock-recreated | successor installed |
| 1298 | 543.952329 | publishLocal | assert-owned-failed | expected `51b225ba-e443-4246-8782-a67a5eedb515`, observed `b0a877b6-013d-44e8-92aa-d3f2ae8e2117` |

The investigation used common-auth 0.14.2 and Bun 1.3.14. It explicitly reports that the instrumented upstream suite still passed despite the captured ownership assertion failure; this was evidence of the race, not a red upstream Bun test.

## Implementation and deterministic coverage

`readLockState` distinguishes missing, live, and existing expired leases. Missing leases return to exclusive creation without entering stale eviction. Expired records with an owner ID and finite expiry retain those two fields as identity. Records without an owner ID, and records that cannot be parsed, instead retain device, inode, mtime and their expiry basis. Acquisition compares that observation under the eviction marker and again immediately before removal, using platform-aware `readOwner` for every owner-record read. No awaited observer barrier is inserted between the final marker check and final existing-record read/removal.

The final read and pathname removal remain non-atomic. An existing stale file excludes ordinary `wx` creators, while the owned eviction marker serializes cooperating eviction, release, and renewal. POSIX renewal now revalidates ownership, expiry, and marker before publishing its staged record, matching the existing Windows publication fence. These remain cooperative leases, not a kernel-lock guarantee against arbitrary writers or processes suspended across filesystem operations/marker expiry.

`test/fs/stale-lock-identity.test.ts` covers missing-file observations both before and under the marker, fresh exclusive acquisition in the missing-file gap, fresh/expired/different-expiry/legacy replacements after stale confirmation, missing-at-removal retry, genuine stale eviction, and expiry after the last awaited renewal barrier. Fresh-holder checks compare complete bytes and call `assertOwned`. For expired replacements, the test throws a recognised `retry observed` exception at the next `lock-read-ready` callback, after the failed exclusive retry. The final identity read does not call that hook. This lets the first removal decision run, but stops a legitimate subsequent eviction attempt from replacing the expired test record and masking its preservation. The legacy-stat case also replaces an expired record with another still-expired record, so liveness alone cannot satisfy that test.

The initial red run, before the stale-eviction implementation changed, had 1 pass and 6 failures across 7 tests: the missing-lock test, all four owner/replacement cases, and the legacy-stat replacement case failed; genuine stale eviction passed. The additional missing-under-marker and missing-at-removal cases are included in the final suite.

Two existing post-write relinquishment tests now pause at `renewal-write-finished`, after publication, rather than `renewal-write-ready`, before publication. Otherwise their old schedule required renewal to overwrite a successor after expiry, the unsafe behavior now refused by the publication fence. The own-record cleanup test removes the renewal holder's marker, then checks that the holder removes its own lease after detecting marker loss. The paired test installs a successor and still checks that relinquishment preserves that successor's lease.

`withLock` forwards optional lock-step and renewal-timer observers. `openPoolStore` retains its existing `onLockStep` forwarding and forwards the additive `onRenewalTimer(lock, event)` through `acquirePoolLock`. A runtime-store test and a generic-wrapper test exercise the public forwarding. The consumer-named `createNativePoolStore` wrapper is not a symbol in this repository. Consumers wrapping `openPoolStore` or `withLock` still need to pass the optional callbacks into those APIs.

## Verification

All release gates ran on the offline Linux runner, serially. Tool versions: Bun 1.3.14 (`0d9b296a`), Bun 1.4.2 (`744846f84`), TypeScript 7.0.2, Biome 2.5.14, ckdev-mutate 0.12.0.

| Gate | Bun 1.3.14 | Bun 1.4.2 |
| --- | --- | --- |
| `bun run build` | passed | passed |
| `bun run types` | passed | passed |
| `bun run lint` | passed, 278 files | passed, 278 files |
| `ckdev-mutate check` | passed | passed |
| `bun test` | 1544 pass, 13 skip, 0 fail | 1544 pass, 13 skip, 0 fail |

Both full suites ran 1557 tests across 126 files with 7403 expectations, including the existing 512-round contention stress and every stale-ordering test. Build checks covered 6 manifests, 15 installed dependency ranges, and 94 emitted files / 1 private-files bare import. The catalogue contains 324 controls. Lint retained two existing warnings in `test/dump/response-clocks.ts` about dynamic namespace access. The 13 skipped tests belong to the existing OpenCode 2 placement contract. Windows-native qualification was not run; the Windows branches and platform-aware owner reads remain, and the full Linux suite includes the Windows source/anchor checks.

An intermediate test-only remote job lacked the preceding job's generated `dist/` and failed the two tests that inspect published output (`built common-auth keeps the native dependency external` and `pi slot published import graph permits only node builtins, common auth files and external Windows private-files`). The final verification rebuilt and ran both full suites within one remote job; both passed. No production change was needed for that setup failure.

An auxiliary attempt to count catalogue rows using Bun 1.3.14's TOML parser rejected an existing multiline quoted string; Python 3.14.4's `tomllib` counted the rows instead. `ckdev-mutate check` itself passed on both runtimes. Mutation prebuilds used frozen install: 452 installs across 521 packages, no manifest or lockfile changes.

## Mutation proofs

Each row was replayed separately with `ckdev-mutate run --only <id>` under each pinned Bun runtime:

| Control | Bun 1.3.14 | Bun 1.4.2 |
| --- | --- | --- |
| `fs-lock-missing-is-not-stale` | CAUGHT | CAUGHT |
| `fs-lock-stale-removal-binds-identity` | CAUGHT | CAUGHT |
| `fs-lock-renewal-rechecks-expiry-before-publish` | CAUGHT | CAUGHT |
| `fs-lock-stale-reclaim-rechecks-liveness-under-marker` | CAUGHT | CAUGHT |
| `fs-lock-live-holder-excludes-second-acquirer` | CAUGHT | CAUGHT |

The last two are existing controls re-anchored to the new state reader. The under-marker control substitutes the initial observation for the marker-protected observation; the ordering test detects an incorrectly emitted stale confirmation even though the final identity fence still preserves the successor. The runner evaluated each of the five controls' named tests separately, not every mutation in the catalogue or all tests against every mutant.

The three new controls were also applied manually to the staged live source; each deliberate guard break was labelled `NON-VACUITY BREAK` so it could not be mistaken for production code. Before each break, `git diff --stat` was empty; while applied it showed `src/fs/refresh-file-lock.ts | 2 +-`, one insertion and one deletion; after `git checkout -- src/fs/refresh-file-lock.ts && touch src/fs/refresh-file-lock.ts`, it was empty again. Each named test was run alongside `stale lock identity evicts a genuinely expired lock`, which stayed green on both versions. Each two-test run had exactly one pass and one failure, with 8 other tests filtered out:

- Missing-state control: `stale lock identity missing lock retries exclusive create without an eviction marker` failed with `Expected to not contain: "stale-lock-observed"`; received steps contained `lock-missing`, `stale-lock-observed`, and `eviction-marker-acquired`.
- Identity-fence control: `stale lock identity preserves expired replacement after stale confirmation` failed at `expect(await contender).toBeNull()`; it received a lock handle instead.
- Renewal-expiry control: `stale lock identity renewal refuses expiry after its last awaited write barrier` failed at `expect(await readFile(lockPath())).toEqual(bytes)`; the lease bytes had been renewed after expiry.

No mutant remains in the production source. The fixed full suites and the runner's restoration builds passed.
