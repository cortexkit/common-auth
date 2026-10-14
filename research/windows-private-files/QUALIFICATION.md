# Common-auth Windows private-files qualification

## Qualified implementation and evidence

[Windows private-files run 38483433873](https://github.com/cortexkit/common-auth/actions/runs/38483433873)
succeeded on implementation commit `8747613155dd833542c593a44b6572e92eea9723`.
That run qualified the initial private-file adoption. The subsequent logger-cost
revision retains a verified append handle instead of rewriting the whole log;
its new Windows run is recorded below when available. Documentation, comment
clarification and retargeted legacy mutation anchors also follow that initial
implementation.
The regular CI run on the same implementation commit also succeeded, as relayed
by the operator who pushed the verification branch. No push was made from the
editing worktree.

The qualification uses the published `@cortexkit/private-files@0.1.0` runtime
package and its prebuild loader, not an inlined or locally rebuilt native module.

| Runner | Architecture | Filesystem / reported Windows version | Node 24.21.0 | Bun 1.3.14 | Bun 1.4.2 |
| --- | --- | --- | --- | --- | --- |
| windows-latest | x64 | NTFS / 10.0.26100.0 | 7 pass, 0 fail, 0 skip | 7 pass, 0 fail | 7 pass, 0 fail |
| windows-2022 | x64 | NTFS / 10.0.20348.0 | 7 pass, 0 fail, 0 skip | 7 pass, 0 fail | 7 pass, 0 fail |
| windows-11-arm | arm64 | NTFS / 10.0.26200.0 | 7 pass, 0 fail, 0 skip | 7 pass, 0 fail | 7 pass, 0 fail |

Each Bun suite executed seven tests across one file, with no skipped real
assertions. The wrapper rejects any other pass/fail/skip count. Disabling all
seven assertions made the wrapper refuse on both Bun versions on every runner.

Artifacts uploaded by that run are named
`windows-private-files-{windows-latest,windows-2022,windows-11-arm}`. A copy is
retained in the delivery worktree's ignored
`windows-private-files-evidence/run-38483433873/`, outside `dist/` and all other
regenerable build directories. Each artifact contains:

- `suite-node-v24.21.0-real.log` and `suite-bun-{1.3.14,1.4.2}-real.log`;
- `node-<runtime>-<architecture>/writers.json`, `lease-marker.json`,
  `second-user.json`, `sharing-refusal.json`, `sharing-replaced.json`,
  `migration.json` and `migration-second-user.json` (the directory prefix is
  `node` for both engines; the runtime version distinguishes Node from Bun);
- `mutations-{1.3.14,1.4.2}.json`, every mutation's baseline/red logs, and the
  separate all-skipped count-control logs and JSON.

## What the real Windows tests establish

The seven tests in `test/windows/common-auth.mjs` exercise:

1. **Real writers and independent access inspection.** Atomic JSON, RPC token,
   sidebar, ordered log flush, dump baseline/body/metadata/response, Pi auth and
   stash, and refresh lease acquire/contention/renewal/release run through the
   built common-auth entry points. PowerShell/.NET, independently of the addon,
   inspects owners and every ACE on 18 file/directory objects, plus the transient
   eviction-marker directory and its owner file. Each object's DACL grants only
   the process user with the expected file/directory inheritance flags.
2. **Standard-user denial with a positive control.** An ephemeral non-admin user
   must launch successfully, report its own non-admin identity and read the
   deliberately public control. It is then denied directory enumeration and
   direct reads of 11 known-name private files. A launch failure or unreadable
   public control is not a denial pass. Migration receives a separate denial
   probe after permission repair.
3. **Within-budget sharing recovery.** A helper holds the destination without
   `FILE_SHARE_DELETE`; releasing it within the retry budget permits complete
   replacement, with independent post-replace ACL inspection. The destination
   remains present while held; there is no unlink-first publication gap.
4. **Beyond-budget sharing refusal.** Holding the same incompatible handle past
   the budget rejects at rename after six attempts, with `code: EPERM` and
   `published: false` in all nine runtime records. The test verifies that the
   complete old bytes remain and the caller's stage is cleaned. Normalized
   Node/Bun rename errors do not carry a native Win32 code; the adapter preserves
   the original error rather than claiming that EPERM proves sharing failure.
5. **Unsafe parent refusal before secret creation.** A foreign grant on a parent
   causes a typed security refusal without a secret stage being written.
6. **Read refusal propagation.** A foreign grant on an RPC token refuses with
   path/stage information rather than becoming discovery's tolerant fallback.
7. **Dedicated-root migration and precise IO classification.** Owned sidebar
   roots/files are repaired without touching an unrelated sibling; shared
   parents still refuse. Real missing files and exclusive collisions retain
   precise adapter codes instead of generic success or contention.

The workflow also runs native-load smoke tests, build and typecheck. Every
runtime step is required; a missing capability or timeout fails rather than
skips. Tests stream pending operation labels and own/terminate their helper
processes on watchdog expiry. Native IO itself is not cancellable.

## Guard mutation evidence

Each runner reports **13/13 CAUGHT on Bun 1.3.14 and 13/13 CAUGHT on Bun 1.4.2**:
CAUGHT means deliberately disabling a guard made its named test fail, after that
test passed with the guard intact. There were 78 guard replays in total, plus six
all-skipped count controls. The new guards
cover refusal predicates, migration owner/reparse exclusions, elapsed deadlines,
native error retry filtering, per-attempt ownership fences, publication outcome
honesty, stage ownership cleanup, lease acquisition/release classification,
external packaging, RPC refusal propagation, same-directory staging and watchdog
cancellation.

Every replay first passes its sole named test, stages the live source and checks
an empty unstaged diff, removes or neutralizes a guard (marked
`NON-VACUITY BREAK`) with a non-empty diff, and
requires that same test alone to fail. Restoration uses the staged source,
touches the restored file and requires an empty diff. The JSON records each
applied/restored stat pair; red logs name exactly one failed test, with no
collateral failure. `windows-private-files-evidence/evidence-review.json.log`
records a read-only audit of all nine suite records, nine second-user records,
78 red logs/stat pairs and six count controls.

## Portable regression verification

Linux full suites on both Bun versions passed: **1523 pass, 13 skip, 0 fail**,
1536 tests across 122 files and 7303 assertions per run. The 13 skips belong to
the opt-in real OpenCode 2 placement suite, not Windows private-file assertions.
Build, TypeScript 7.0.2 typecheck, and Biome 2.5.14 lint also passed. Lint reported
two existing dynamic-namespace-import warnings in `test/dump/response-clocks.ts`.
The source-provenance gate matched all 1436 cells against the Bun 1.3.14 JUnit
report. Full stdout/stderr records are retained under
`windows-private-files-evidence/portable-linux-bun-<version>.*.log`.
The Bun 1.4.2 test run passed but could not write its optional JUnit output because
the ignored evidence directory was not present on that remote job; the retained
console records contain its complete pass/skip/fail summary. Seven pre-existing
mutation anchors were retargeted or narrowed after helper factoring and the new
Windows branches, without changing their tests or contract: held leases must
still refuse acquisition, release must preserve a successor's lease, expired
legacy leases must still be reclaimed, atomic/RPC staging names must remain
unpredictable, failed POSIX watcher seeds must be retried, and stable POSIX RPC
calls must reuse validated discovery. Each retargeted control's sole named test
was observed red on Bun 1.4.2, then its source was restored with an empty diff.
The catalogue passed `ckdev-mutate check` (runner 0.12.0, Bun 1.3.14): all 320
controls' anchors and exact test names verified. The new deadline/release-error
catalogue anchors were also made context-specific; each was observed red alone
on Bun 1.4.2 and restored. Neither the production guards nor their tests changed.

## Logger append-cost revision

Automatic Windows flushes now retain one verified append handle, check only its
size metadata for rotation, and append new bytes. Explicit `flushLogs()` drains
and closes it; a changed configured/provider path, rotation or IO error discards
the handle, and the next open verifies the protected parent and private file.
The design supersession explains why this write-only pathname open is safe
against other ordinary users without weakening handle-based secret reads.

The isolated fake-backend regression ran 50 automatic flushes (2500 lines),
including a same-path reconfiguration: zero additional backend reads, private
stage creations or replacements after the first flush, one open, and one close
at explicit shutdown flushing. Three further tests cover rotation, refusal
before open, and path/error recovery without leaked handles. Reintroducing
whole-file rewriting made only the named cost regression fail on Bun 1.3.14 and
1.4.2: 49 unexpected backend reads after the first flush. These counters prove
portable sink behavior, not Windows ACL enforcement.

The full Linux suites passed with 1527 pass, 13 opt-in placement skips and zero
failures (1540 tests, 123 files, 7315 assertions); the provenance check matched
all 1440 cells. After removing two new non-null assertions, the final build,
TypeScript 7.0.2 typecheck and Biome 2.5.14 lint passed with only the two original
warnings, and all 48 logger tests passed on Bun 1.4.2. Revision evidence is kept
in `windows-private-files-evidence/logger-append/`.

The Windows writer assertion now also appends 2500 lines, explicitly drains and
closes, rotates a private log over 5 MiB, and independently inspects/denial-probes
both active and rotated files. [Run 38492178391](https://github.com/cortexkit/common-auth/actions/runs/38492178391)
on append implementation `f6e765678e3b742f0ef61a6cd2cd0296ea950e7b` passed all
seven real tests under Node 24 and both Bun versions on all three Windows
runners, including active/rotated-log ACL inspection and second-user denial;
regular CI also passed, as relayed by the operator. Its mutation phase stopped
at the logger's multiline LF anchor in a CRLF checkout, after earlier controls
had replayed. That is a harness failure, not a skipped or failed product
assertion, and the full workflow must be rerun successfully before delivery.

The harness now uses the same line-ending-normalized, unique-anchor replacement
helper as `bun scripts/check-windows-mutation-anchors.mjs`. That local check
validates all fourteen registered anchors against committed source as-is and
CRLF-converted source, using the original LF anchors in both cases (28 checks).
Three duplicate multi-replacement rows now use unique contexts without changing
their test contracts. The runner captures and restores the original byte arrays
in `finally`, checks byte equality independently of Git's EOL normalization, and
still stages live sources and checks non-empty applied/empty restored diffs.
The checker passed on Bun 1.3.14 and 1.4.2; corrupting the logger anchor or disabling
CRLF normalization each failed only its named checker test on both runtimes.
Evidence is retained in `windows-private-files-evidence/harness-eol/`.

## Limits and remaining adoption

- These results qualify the listed local-NTFS/OS/runtime combinations. They do
  not establish FAT/exFAT, network/UNC paths, arbitrary ACL layouts, every group
  configuration, impersonation, privileged attackers, or every future runtime.
  The backend refuses unsupported namespaces/filesystems, without mode fallback.
- Portable descriptor and fake-clock tests prove logic, not SID acquisition,
  native ACL enforcement or real Windows IO. The primitive's broader forbidden
  ACL/reparse and Rust-interoperability qualification belongs to its own suite;
  it is not duplicated in these seven common-auth tests.
- Windows file bytes are flushed before rename, but directory-metadata durability
  is not demonstrated. `durable: true` reports a post-publication failure;
  `file-only-on-windows` explicitly accepts the weaker guarantee. Pi stash
  publication therefore carries the documented crash/directory-metadata risk.
- The refresh lease and Pi lock protocols retain their existing check/operation
  race windows; ACL protection is not an OS-kernel lock or a new fencing protocol.
- Permission tightening cannot revoke already-open foreign handles or undo
  historical exposure. Migration warnings recommend credential rotation, and
  foreign ownership/reparse points/shared parents are not implicitly repaired.
- Enrollment token publication by claustrum-client and openai-auth's direct
  heartbeat/host-slot/import writers remain separate adoptions. This run does
  not qualify a plugin merely because it imports common-auth. Bundlers must keep
  `@cortexkit/private-files` external and ship the runtime dependency; hosts must
  use dedicated private roots and await the Windows logger flush before shutdown.
