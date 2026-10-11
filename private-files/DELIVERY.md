# Private-files slice 1 delivery and SUBC handoff

## Delivered primitive

`@cortexkit/private-files` version **0.1.0**, tag prefix **`private-files-v`**, is self-contained in `private-files/`. common-auth's `./private-files` is a thin re-export; no persistence call site has been adopted. No release, main push, or committed binary was performed. The repository maintainer pushed the implementation commits only to the CI branch `windows-private-files-slice1`.

Public API: `createOwnerOnly(path, {kind: 'file' | 'dir'})`, typed `verifyOwnerOnly(path)`, and `readOwnerOnly(path)` (verify/read the same opened handle). Additional explicit creation/write, kind-specific verification, and current-user-owned permission-replacement helpers are documented in [README.md](README.md). Refusal string constants cover wrong-owner, extra-ace, not-protected, null-dacl, empty-dacl, reparse-point, unsupported-filesystem, and POSIX mode; owner/ACE refusals carry SID/mask details.

The C N-API v8 backend performs blocking token/filesystem/security calls in async work. Creation supplies owner = token user SID and a protected DACL containing one ACCESS_ALLOWED ACE with FILE_ALL_ACCESS (`0x1f01ff`), flags `0` for files and OI|CI (`3`) for directories. No extra SYSTEM/Administrators ACE is added. Reads accept owner = token user or TokenOwner, and a single inherited file ACE (`16`) only beneath a pinned canonical protected private directory. Rust writers use the same single-user full-control ACE shape but can leave ownership at the process token's default and child files inherited; the reader accepts those specific differences; real fixtures use crates.io **cortexkit-lease =0.1.3** and **subc-os =0.1.14** with a committed Cargo.lock. Both protected and inherited Rust-written files passed. Native creation explicitly sets owner even for elevated administrators.

An exact-rights `NtCreateFile` metadata path permits owner-implicit READ_CONTROL/WRITE_DAC on empty DACLs, never reading secret bytes through classification fallback. Normal reads retain same-handle validation/IO. Metadata checks retain reparse/kind validation, and uncertain ancestry/filesystem inspection refuses. Native operations never request SACL/ACCESS_SYSTEM_SECURITY. Windows imports use a C host-executable delay hook and `/DELAYLOAD:node.exe`, allowing the same architecture binary to run in Node and Bun. POSIX remains pure JS with ordinary 0600/0700 operations and no install-time compiler.

## Final real Windows qualification

Code commit that passed the qualification below: `f3e619023794473134a95e327d7a0ac16eda1729`.

**[Run 38161673910](https://github.com/cortexkit/common-auth/actions/runs/38161673910): overall success.** Dedicated x64 and ARM64 prebuild jobs succeeded. All three `acl` jobs succeeded, each enforcing **11 tests / 11 passes / 0 failures / 0 skips** under Node 24.21.0, Bun 1.3.14, and Bun 1.4.2. Both Bun steps that require the addon in a separate process before executing any tests succeeded everywhere. The ARM runner additionally passed all 11 tests under emulated x64 Node with the x64 prebuild. Native policy units passed five checks. Rust fixture builds and independent PowerShell/.NET descriptor and non-admin public-control/private-denial proofs passed.

Tested local filesystems were NTFS:

| Runner | Actual OS build | Windows PowerShell |
| --- | --- | --- |
| windows-latest | Server 2025 Datacenter, 10.0.26100 / 26100 | 5.1.26100.33438 |
| windows-2022 | Server 2022 Datacenter, 10.0.20348 / 20348 | 5.1.20348.5622 |
| windows-11-arm | Windows 11 Enterprise, 10.0.26200 / 26200 | 5.1.26100.9457 |

This qualifies the tested Windows/runtime/NTFS combinations, including actual native ARM64 Bun. The implementation refuses network shares, unsafe ancestry and reparse paths. Administrators exercising privileges and offline attackers are outside the discretionary-access threat model.

### Event-loop evidence

Numbers below come from uploaded `acl-*.json`, not estimates. Each measurement used a 10 ms fixed timer, at least 1000 ms of repeated 32-file native-write batches, and a 250 ms max-delay bound. `interleaved` counts callbacks only while native writes were pending, not during readback/removal. Writes are 1 MiB each. Latency includes worker queueing; it is not an isolated syscall benchmark. All measurements passed. The Server 2022/Bun 1.4.2 result had only one credited interleave, which should remain visible rather than be overstated.

| Runner | Runtime / process arch | Writes | Rounds | Timer ticks | Interleaved | Max delay ms | Write p50 / p95 / p99 ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| latest | Node 24.21.0 / x64 | 288 | 9 | 76 | 62 | 11.705 | 9.311 / 750.424 / 755.629 |
| latest | Bun 1.3.14 / x64 | 672 | 21 | 86 | 63 | 16.220 | 7.690 / 24.780 / 394.590 |
| latest | Bun 1.4.2 / x64 | 1056 | 33 | 94 | 56 | 5.288 | 7.301 / 19.593 / 38.775 |
| 2022 | Node 24.21.0 / x64 | 1120 | 35 | 88 | 45 | 14.091 | 5.206 / 8.638 / 171.529 |
| 2022 | Bun 1.3.14 / x64 | 608 | 19 | 53 | 31 | 23.620 | 9.965 / 16.498 / 477.534 |
| 2022 | Bun 1.4.2 / x64 | 1056 | 33 | 60 | 1 | 27.404 | 9.498 / 15.750 / 16.699 |
| ARM | Node 24.21.0 / arm64 | 1024 | 32 | 86 | 34 | 15.814 | 7.492 / 12.853 / 14.868 |
| ARM | Bun 1.3.14 / arm64 | 1056 | 33 | 121 | 82 | 16.932 | 6.988 / 13.711 / 17.590 |
| ARM | Bun 1.4.2 / arm64 | 736 | 23 | 61 | 26 | 50.272 | 11.176 / 22.796 / 27.574 |
| ARM | Node 24.21.0 / x64 emulated | 704 | 22 | 72 | 25 | 27.585 | 10.827 / 18.472 / 30.214 |

Bun reports Node compatibility versions 24.3.0 (Bun 1.3.14) and 26.3.0 (Bun 1.4.2); the actual Bun versions were separately printed and strictly checked. During native filesystem writes, timers ran while write promises remained pending and all measured maximum delays stayed below 250 ms; the final measurements did not show filesystem IO monopolizing JavaScript execution.

## CI iterations and what each resolved

Each URL is the actual qualification run, not a local/mock result.

| Run / code commit | Finding and following correction |
| --- | --- |
| [38140525246](https://github.com/cortexkit/common-auth/actions/runs/38140525246) / 9896c60 | Both prebuilds succeeded; inspector failed loading Windows PowerShell Security under inherited pwsh module paths. Replaced ACL cmdlets with .NET, supplied/reset a system-only module path, preserved single-ACE arrays, and added inherited-vs-clean module diagnostics. The first ARM delay occurred before the second-user probe. |
| [38141186420](https://github.com/cortexkit/common-auth/actions/runs/38141186420) / fad30c7 | Inspector worked; junction fixture inspected its not-yet-created path, inherited fixture retained an explicit ACE, empty-DACL deletion failed, and credential-child status/output was hidden. Fixed fixture ordering/rules, repaired empty fixtures before deletion, cached process handles/exit codes and captured stdout/stderr/profile/public-control diagnostics. |
| [38142209530](https://github.com/cortexkit/common-auth/actions/runs/38142209530) / 2818d7e | Standard-user launch/denial and migration passed; empty-DACL verification returned io-error and repair was access-denied. Added exact owner-implicit metadata handles, descriptor-only classification, metadata kind/reparse checks, same-handle read preservation, and shared native access-policy unit checks. |
| [38148082663](https://github.com/cortexkit/common-auth/actions/runs/38148082663) / eecb9bc | Empty-DACL backend fix held; standard-user fixture hit `SeSecurityPrivilege` in .NET SetAccessControl. The default SetSecurityDescriptorSddlForm overload marked Audit modified despite Owner|Access-only reading. Restricted the setter to Access only and added live native no-SACL/no-ACCESS_SYSTEM_SECURITY assertions. |
| [38149337043](https://github.com/cortexkit/common-auth/actions/runs/38149337043) / bb2157d | Node passed 11/11 everywhere. Plain `bun <file>` rejected node:test before hooks outside the runner. Switched to `bun test`, required exact real pass counts, and moved negative controls before Bun. Earlier verifier steps had been skipped; no proof was claimed for them. |
| [38150800769](https://github.com/cortexkit/common-auth/actions/runs/38150800769) / 45f2073 | Node and both negative controls passed. Bun crashed loading the addon. Actual x64/ARM64 PE files imported node.exe normally with zero delay-import directory. Added host-bound delay loading, PE inspection/distribution guard, isolated loads, and always-run runtime steps. |
| [38152960174](https://github.com/cortexkit/common-auth/actions/runs/38152960174) / f0a6a30 | Both Bun versions loaded on all architectures; 5 s runner timeouts killed ~20 s credential probes and leaked their asynchronous rejection into following tests. Added explicit 120 s Node/Bun budgets and strict runtime version fencing. ARM setup-bun 1.4.2 also crashed with `Internal CLR error. (0x80131506)` / pwsh exit `3221225477`; the older runtime's result was not accepted as 1.4.2 qualification. |
| [38155290056](https://github.com/cortexkit/common-auth/actions/runs/38155290056) / 337154b | ARM Bun 1.3.14 passed 11/11; version fences proved correct versions. x64 standard user could not execute `C:\Users\runneradmin\.bun\bin\bun.exe` (CommandNotFoundException). Copied/hash-checked the same runtime into the public probe directory. ARM Bun 1.4.2's 57 ms sample produced zero timer ticks; replaced sensitivity-prone sampling with the sustained, native-pending-only measurement above. |
| [38161673910](https://github.com/cortexkit/common-auth/actions/runs/38161673910) / f3e6190 | All required jobs/runtimes/controls passed; measurements and artifacts downloaded for this report. |

The exact credential-child errors were surfaced, never treated as denial success: initially `Second-user probe did not launch successfully` hid a successful child's uncached exit status; later `.NET SetAccessControl ... SeSecurityPrivilege` and inaccessible profile-installed Bun were captured explicitly. Every denial requires the standard-user process first to read an intentionally public control file successfully; an inaccessible executable or nonexistent path is never credited as private-file protection.

### Actual mutation evidence in the final run

Step on **each** `acl` job: **Disabled-verifier, real-test-count and runtime-version negative controls, restore and rebuild**. The step disables the native ACL verifier and requires the foreign-grant test to fail, skips every real test and requires the count fence to refuse, then supplies a wrong expected Bun version and requires version refusal. It restores source, confirms an empty working diff, and rebuilds the normal addon; only these demonstrated failures permit the step to succeed.

Line references are to the complete job logs downloaded via `gh run view --log --job` into the evidence directory. Artifact files `negative-test.txt`, `count-negative-test.txt`, `version-negative-test.txt`, the corresponding `*-during.txt` files record the source change present during each deliberate break and `*-after.txt` files confirm the working diff became empty after restoration.

| Job | Disabled verifier: exact red name / missing rejection / fail count | Refusal of skipped test suite | Refusal of incorrect Bun version |
| --- | --- | --- | --- |
| latest, job 114535893000 | lines 711 / 717 / 730: `not ok 1 - foreign-grant fixture refuses before reading bytes`; `Missing expected rejection.`; `# fail 1` | line 1020 | line 1025 |
| 2022, job 114535892944 | lines 714 / 720 / 733, same sole failing name/message/count | line 1028 | line 1033 |
| ARM, job 114535892966 | lines 729 / 735 / 748, same sole failing name/message/count | line 1034 | line 1039 |

Skipping all eleven test bodies must not qualify an empty run: `required_real_acl_test_count: expected 11 executed non-skipped tests; got tests=11 pass=0 fail=0 skip=11`. Version control: `required_bun_version: expected '0.0.0', got '1.3.14'; setup must succeed before qualification`. Verifier mutation is `private-files/native/addon.c`, 1 insertion/1 deletion. Count mutation is `private-files/test/windows/windows-acl.mjs`, 13 insertions/11 deletions. Version mutation is `private-files/test/windows/run-acl.ps1`, 1 insertion. Each restored diff is empty.

Portable proofs separately reddened only their named predicate, inherited-parent, arch-selection, unsupported-arch, and missing-addon tests. C policy mutations reddened only `classification_open_has_no_data_rights` and `standard_user_security_paths_never_request_sacl`; their other policy checks remained green. These check normalized descriptor decisions, binary selection and the exact access/security flag values supplied by native code; they do not exercise a Windows filesystem or certify its ACL enforcement.

## Local gates and research correction

Linux build server: TypeScript 7.0.2 build/types passed; Biome 2.5.14 checked 267 files and passed with two pre-existing dynamic namespace warnings in test/dump/response-clocks.ts; full Bun 1.3.14 and 1.4.2 suites each passed **1502**, skipped **13** existing host-gated tests, failed **0**, across 118 files. Seven targeted portable tests passed. GCC 15.2.0 C policy unit passed five checks. `ckdev-mutate 0.9.8 check` verified all 309 mutations.toml source replacements and exact guarded test names, including five private-files controls. Frozen Bun installs passed after workspace/lockfile updates. No Windows-required test was converted to a skip.

An early web research answer from the sidekick tool was stale: request `sk_worker_00000000-0000-4313-98dc-6862fcb14bb0` said, **“The crates.io version history lists 0.1.0 and 0.1.1, not 0.1.14.”** The repository maintainer checked the crates.io API and corrected the version-history claim. Actual `cargo update --manifest-path private-files/test/fixtures/rust/Cargo.toml -p subc-os` output: `Updating crates.io index`, `Adding subc-os v0.1.14`, and `Removing subc-os v0.1.14 (https://github.com/cortexkit/subconscious?rev=59e411a1d81c8dd348172f87404cf63fafb3e364#59e411a1)`. The temporary git-dependency draft was never delivered: final manifest/lock use crates.io only.

## SUBC handoff

Move **the complete `private-files/` directory** to `clients/private-files`; src, native C/header/build, package/tsconfig, tests, Rust Cargo fixture/lock, scripts, LICENSE and documentation have no common-auth imports or workspace-relative source paths. common-auth must retain its separate re-export and depend on the independently published package after the directory moves. Install this package's dev dependencies/build it from its folder; POSIX installation/runtime requires no native compiler.

The separately named workflow job is **`private-files-prebuilds`**, displayed **Native N-API v8 prebuild (x64/arm64)**. To fold it into the new repository's release workflow:

1. Retain SHA-pinned actions, contents:read, 15-minute timeout and native Windows x64/ARM64 MSVC runners; update workflow working-directory/path prefixes to `clients/private-files`, not package-internal paths.
2. Build with `native/build.ps1`, including `delay-load-hook.c`, `/DELAYLOAD:node.exe`, delayimp.lib/ntdll.lib, SDK mask equivalence, and native unit checks. Keep PE import inspection artifacts. Do not commit binaries.
3. Download/merge artifacts **private-files-prebuild-x64** and **private-files-prebuild-arm64** into package `prebuilds/`. The packaging guard checks both machine types and delayed host imports. No runtime-specific binary matrix is needed: use the same N-API v8 binary per process architecture.
4. Preserve the three-runner qualification matrix, exact Node/Bun version/count guards, independent inspector, real standard-user/public control, Rust interop, all negative controls and emulated x64 Node. Runtime steps must continue reporting even after another fails, without making the overall job green.
5. Only after qualification, package both binaries with dist/native rebuild support and the included native unit source. Future releases use `private-files-v<version>`; this task published nothing. Maintain the process.arch rule (x64 Node on ARM Windows still loads x64).
6. Keep descriptor/OS/runtime/timing/control evidence outside target/dist/cache directories. This worktree retains downloaded artifacts under ignored `private-files/private-files-evidence/ci-38161673910/`; the durable CI URL/artifacts and this report remain the handoff references.

Routing existing writers/readers through this package, implementing atomic publication/retries/outcomes, and coordinating enrollment-token migration with consumers remain future work, not part of the delivered primitive. Directory permission replacement is explicit and limited to dedicated roots; Windows can propagate inheritable ACEs to existing unprotected children. Prior exposure or already-open foreign handles cannot be undone by tightening a DACL; credential rotation/migration policy belongs to the adoption work.
