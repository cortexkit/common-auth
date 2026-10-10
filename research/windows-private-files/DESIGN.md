# Windows private files: design decision

Report only; no implementation or claim of Windows execution. Source snapshots: common-auth `ae42b292b87f662e95bf95c365d8b1139bbb69c8`, openai-auth `ea9e6f88ccafe42577ad6d10b86097d032be602f` (GitHub `main` fetched for this report). The openai-auth report belongs to **that repository**, not common-auth: [findings 1, 2, 4, 5 and 8][OA-census]. They cover ineffective Windows modes, enrollment refusal, replacement failures, lease error assumptions and shared/predictable temp paths. common-auth's [own census](../platform-census-2026-10-08.md) identifies the same shared primitives.

## 1. Backend and request-path cost

**Decision: an asynchronous Windows N-API private-files backend, separate from the file-lock API.** Keep POSIX behavior on Unix. Node [file modes][Node-modes]/[Stats][Node-stats] and Bun [open][Bun-open]/[stat][Bun-stat] expose no owner-SID/DACL capability: Windows mode bits chiefly manipulate writability, not owner/group/other access. All request-path operations return promises; no synchronous filesystem calls, `spawnSync`, `execSync`, native calls that wait on the JavaScript thread, or subprocess per write in the default backend. Missing/unsupported backend means an actionable security refusal, never a mode-only fallback.

| Option | Setting + verification; request-path cost and decision |
| --- | --- |
| `icacls.exe` | `/inheritancelevel:r` removes inherited ACEs; `/grant:r *<SID>:F` replaces grants **for that SID only**, leaving unrelated explicit ACEs. Directory inheritance uses `(OI)(CI)`. `/verify` checks ACL structure/canonicality, not this privacy policy; text output/account-name localization is not a reliable SID/ACE verifier. Setting plus independent descriptor verification costs multiple process launches per write. Reject as backend; useful for operator diagnostics only. [Microsoft][MS-icacls] |
| PowerShell/.NET, no addon | An async `spawn` of trusted Windows PowerShell with `-NoProfile -NonInteractive` can construct a fresh `FileSecurity`/`DirectorySecurity`, call `SetOwner(current SID)`, `SetAccessRuleProtection(true,false)`, add only the owner full-control rule (OI/CI for directory), then `Set-Acl -LiteralPath`. Re-fetch `Get-Acl`, parse `RawSecurityDescriptor`, return SID/control/ACE fields as JSON and validate section 2; a zero exit status or formatted `Access` string alone is not success. Never just modify one grant on an existing ACL. Use a fixed script, pass paths as data over stdin, no shell/string interpolation, bounded execution/output and no secret-bearing command line. One cold interpreter per transaction (possibly several if split) has startup/IPC costs and can be blocked by policy. Plain path-based cmdlets need a trusted, non-replaceable namespace; they do **not** supply the same-handle read/reparse guarantee. Reject as normal request backend; suitable for empty-object provisioning/explicit migration with those preconditions. A no-addon production backend would need a managed helper using Win32 handle APIs (e.g. PowerShell P/Invoke), performing the entire transaction, not just `Get-Acl` followed by Node read. [Get-Acl][MS-getacl], [Set-Acl][MS-setacl], [protection][MS-protection], [raw descriptor][MS-rawsd] |
| Tiny N-API addon | `CreateFileW`/`CreateDirectoryW` security attributes, `GetSecurityInfo`/`SetSecurityInfo`, token SID, handle-based reparse/identity checks and IO in `napi_create_async_work` execute callbacks; JS-thread completion resolves promises. One module load per process, **zero process launches per write**; syscall/worker-queue cost remains. More build/distribution surface, but no parsing of localized CLI output and explicit native errors. Chosen. Node's [async-work API][Node-async] and Bun's [Node-API support][Bun-napi] are feasibility evidence, not Windows qualification. |

There are **no measured Windows startup or per-write latency numbers** in either census or the [kernel-lock spike](../kernel-lock/REPORT.md#packaging-recommendation-unmeasured-release-design-measured-loader-experiment). Benchmark cold/warm module load, cold PowerShell provision/verify, and p50/p95/p99 secure write plus event-loop delay on the Windows job; don't invent a millisecond comparison. Async subprocesses avoid blocking the JS thread but still delay requests; async addon work avoids interpreter startup, not IO latency. Cache module/token initialization, never cache ACL verification as a security proof.

Available file-lock packaging infrastructure can inform distribution, not security semantics. At this base it is not a dependency, and its [public repository][File-lock-repo]/[registry endpoint][File-lock-registry] were unavailable; only the N-API v8 macOS/Linux spike is inspectable. The primitive implementation phase in section 8 must confirm the actual package pipeline/prebuild conventions with its owner. No Windows binary or lifecycle qualification is inferred from that spike.

The policy is current-user-only discretionary access, not protection against that same user's processes, administrators exercising privileges, backup privileges or offline disk access. Filesystems that cannot persist and return a security descriptor are unsupported for secrets; local NTFS is the first supported Windows target. SYSTEM/Administrators are **not** extra allowed trustees on private objects merely for convenience.

## 2. Read contract

**Decision: validate the object actually opened, before consuming bytes.** Windows replaces the enrollment reader's synthetic mode test, not its fail-closed intent. The process user SID is obtained from its access token (`OpenProcessToken`/`GetTokenInformation(TokenUser)`; [Microsoft][MS-token]), not a username, environment variable or localized account name. Impersonation is unsupported in the first version.

For a private file or private root directory, require all of the following:

- Owner SID equals the process user SID; regular disk file or directory of the expected kind.
- DACL is present, non-null, protected from inheritance and matches a strict template: exactly one ordinary explicit allow ACE for that SID, granting full control. File ACE is non-inheriting; directory ACE has object/container inheritance so children receive owner-only access. Reject foreign allow ACEs (including SYSTEM, Administrators, Everyone, groups and inherit-only entries), deny/conditional/object-specific ACEs and unknown ACE types. This structural rule deliberately rejects some effectively safe but noncanonical ACLs rather than attempting a full Windows access-check evaluator. Null DACL grants everybody access; empty DACL is not a usable successful creation ([Microsoft][MS-null], [DACL access rules][MS-dacl]).
- No reparse point on the file, private root or walked ancestors: junctions, symlinks and other reparse tags all refuse. `lstat().isSymbolicLink()` and `O_NOFOLLOW` are not sufficient Windows proofs. Open using `FILE_FLAG_OPEN_REPARSE_POINT` (plus `FILE_FLAG_BACKUP_SEMANTICS` for directories), inspect handle attributes, and obtain owner/DACL via `GetSecurityInfo` on the **same handle** used for IO. Keep the private-root/ancestor handles open without delete sharing for the transaction; validate trusted ancestry so another user cannot replace a path component. Do not accept a shared writable parent merely because its leaf has a good ACL. [CreateFile flags][MS-create], [reparse guidance][MS-reparse], [handle security][MS-getsecurity].

Read-only/trusted OS ancestors need not satisfy the private-object template; no untrusted principal may replace/delete the **traversed component**, rewrite its DACL/owner, or pre-create a component we are about to use. Creating unrelated sibling names alone is not grounds to reject a stable OS ancestor. SYSTEM/administrative control of OS ancestors is outside the ordinary-other-user threat boundary, not permission to add those trustees to secrets. Reject UNC/network and unqualified custom shared roots initially. Handle identity checks are needed at publication boundaries as well as read boundaries; pathname check-then-open is rejected.

Newly created child files may initially inherit the private directory's owner-only ACE. While still empty, replace their DACL with the protected file template and verify it before writing. Never relax the read policy to accommodate inheritance; migration produces the canonical template.

## 3. Creation and publication

**Decision: secure creation before secret bytes, then same-directory replacement.** Do not create a populated file and fix its ACL afterward. Do not rely on a random name, default profile ACLs, or recursive `mkdir` applying a policy to existing directories.

1. Validate the local trusted parent chain. Create each missing private directory with `CreateDirectoryW` and a security descriptor supplied through `SECURITY_ATTRIBUTES` (owner SID plus protected inheritable owner-only DACL). If it exists, inspect it rather than assuming creation changed its ACL. Refuse foreign ownership/reparse points or unsafe ancestry.
2. In the verified destination directory, choose an unpredictable unique temp name and use `CreateFileW(CREATE_NEW)` with the protected owner-only descriptor **at creation**. Open with the required no-reparse flags; check its identity, owner and DACL while empty. An alternative empty-temp/set-ACL/verify sequence is permitted only inside an already verified private directory; never write bytes before verification succeeds.
3. Write complete bytes on that handle; optionally flush for durable writes; close it before replacement. Preserve a pre-rename ownership/fencing callback for lease users. Replace only in the same directory/volume. Verify the published object's descriptor/identity as part of the backend transaction; no weaker target ACL may survive publication unnoticed.
4. Clean up only the temp object this operation created; never a colliding name or the target. If cleanup fails, report an orphan identifier without secret contents and leave it private. Retain a separate published-versus-durable outcome (section 5).

For caller-supplied shared directories, require a private child directory or an explicit migration to a private root; fail with remediation rather than silently tightening someone else's shared directory. The addon must encapsulate these steps, not export `setAcl(path)` followed by a JS reopen that loses the handle guarantees. Creation-time descriptors and existing-object handling follow [CreateFileW][MS-create], [CreateDirectoryW][MS-createdir], [new-object descriptors][MS-newobjects] and [SetSecurityInfo][MS-setsecurity]. The primitive implementation must prove intermediate-ancestor pinning and identity on Windows; the final-component reparse flag alone does not provide that guarantee.

## 4. Adoption inventory

The inventory below distinguishes direct mode sites from consumers of the shared writer. Exhaustive literal searches of common-auth `src/` and openai-auth `packages/` for `0o600|0o700|0o077|0600|0700|chmod` produced 41 and 91 matches respectively (including imports, comments and tests). Tests/research fixtures are not product adoption sites. Source links below are pinned to the snapshots above; census dependency `CA:dist/...` locations describe an older installed version, not this common-auth base.

| common-auth direct sites | Adoption |
| --- | --- |
| [`src/fs/atomic-write.ts:45,53`][CA-atomic] | All private JSON staging files; `writeJsonAtomic` and tracked variant. |
| [`src/fs/refresh-file-lock.ts:161,167,183,196,252`][CA-lease] | Renewal temp, initial lease, missing-parent retry, eviction-marker owner file. Secure lock/marker parents as well as files; metadata integrity matters even without secret bytes. |
| [`src/rpc/port-file.ts:133,135,143,146`][CA-rpc] | `secureDir` directory creation/tightening and bearer-token staging file. Token files require a private staging boundary even when `secureDir` was not requested; do not privatize an arbitrary shared parent silently. |
| [`src/sidebar-file/sidebar-file.ts:220,222`][CA-sidebar] | Private parent and optional existing-parent tightening; JSON files inherit shared-writer protection. |
| [`src/logger/engine.ts:96,108,113,197,198`][CA-logger] | Existing/rotated log chmod and append creation. Replace synchronous request-path sink work with an ordered async queue; secure before append, not afterward. |
| [`src/dump/index.ts:342,345,599,601,655`][CA-dump] | Staged baseline replacement, private dump directory and exclusive artifacts; prompts may be sensitive. |
| [`src/claustrum/enrollment.ts:336,503,512,537,540`][CA-enrollment] | Secret read mask, enrollment directory creation/remediation and pending-state temp file. Replace ancestor checks at 472–487 with Windows namespace validation; Unix remediation text is not a Windows fix. |
| [`src/pi-slot/slot.ts:172,368,446,448`][CA-pi] | Exact-0600 auth-file read, auth/stash private-parent creation and exact-0700 stash-directory check. Windows uses the same descriptor policy, not exact synthetic modes. |

Common-auth's shared writer additionally covers [`store/mutate.ts:467,518`][CA-mutate], [`store/settings.ts:171`][CA-settings], [`tui-prefs/tui-preferences.ts:102`][CA-tui], [`sidebar-file/sidebar-file.ts:162`][CA-sidebar], [`pi-slot/slot.ts:276`][CA-pi], and [`claustrum/roster.ts:519`][CA-roster]. Their lock users adopt the secured lease primitive without an API bypass.

| openai-auth direct sites / delegated users | Adoption |
| --- | --- |
| [`packages/opencode/src/core/process-heartbeat.ts:62,64,71`][OA-heartbeat] | Private heartbeat directory and staged presence file. Preserve fencing-visible publication failures. |
| [`packages/opencode/src/v2/host-slot.ts:125,128`][OA-host-slot] | Host credential replacement currently preserves an existing mode or falls back to 0600. Windows must not preserve an insecure inherited ACL. |
| [`packages/opencode/src/sidebar-state.ts:341`][OA-sidebar] | Legacy import parent; `copyFileSync` at 342 supplies no private destination policy. Import through a verified private staging file instead. |
| [`packages/core/src/vault.ts:89–96`][OA-vault] | The 0700 occurrence documents delegated enrollment-directory protection; it is not a second direct writer. |
| [`packages/core/src/accounts.ts:1346–1347,1613–1614,1743,2040–2041`][OA-accounts]; [`packages/opencode/src/core/pool-migration.ts:627`][OA-migration] | Config/state/account-token writes adopt common-auth's writer. Non-secret config remains private for policy consistency. |
| Census [findings 1, 4, 8][OA-census] | Delegated RPC bearer publication, lease files, sidebar persistence, logger, dumps and preferences use the common-auth sites above. Fixed log/dump temp names must move into a verified per-user private root, not merely receive a late chmod. |

There is no direct production `0o077` read check in openai-auth's own source; its incompatible enrollment check is delegated to common-auth. **Enrollment publisher coordination:** claustrum-client's maintainer (CKCRED) must make its enrollment token writer/ancestor checks adopt this exact owner/DACL/reparse contract before common-auth accepts Windows enrollment. The census identifies `CC:dist/enrollment.js:23–28,43–61` and `CC:dist/ancestor-permissions.js:22–28`; these are evidence of the installed dependency, not an independently inspected claustrum-client source snapshot.

## 5. Windows atomic replacement

**Decision: preserve replace-in-place semantics with bounded asynchronous sharing retries; never unlink the destination first.** Permission repair is not a retry strategy. Node/libuv's Windows rename uses `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)` ([source][UV-fs], [Microsoft][MS-move]); replacing an existing file is supported. Keep the same-volume staging descriptor; do not use cross-volume copy/delete or `ReplaceFileW` ACL merging. Replacement must leave the owner-only policy intact.

[libuv's translator][UV-errors] maps `ERROR_SHARING_VIOLATION` and `ERROR_LOCK_VIOLATION` to `EBUSY`, `ERROR_ACCESS_DENIED` to `EPERM`, and e.g. `ERROR_ELEVATION_REQUIRED`/`ERROR_CANT_ACCESS_FILE` to `EACCES`. Node exposes normalized [system errors][Node-errors]. Thus **EPERM/EACCES are not proof of sharing violations**; even EBUSY does not identify the specific lock holder. Bun must be qualified independently, not assumed to use the same libuv path.

- Backend retains native Win32 error and retries only actual sharing/lock violations. At a Node-compatible adapter seam, `EBUSY`, `EPERM`, `EACCES` are bounded retry *candidates* on Windows rename only, after verified private ancestry/objects; retain the original error and never report them as permission success or lease contention. Known ACL/read-only failures are terminal. Do not apply this rule to arbitrary open/chmod/unlink failures or Unix.
- Proposed budget: immediate attempt, then delays **10, 20, 40, 80, 100 ms** (six attempts maximum, 250 ms scheduled backoff), capped by a **500 ms monotonic elapsed deadline** including calls. Stop before a new attempt when expired; timers yield rather than busy-wait. An in-flight Windows IO call cannot honestly be promised a hard deadline; report overruns and never race a late rename against a retry. Lease operations additionally respect section 6's lifetime/fencing cap.
- Close our temp/write handles before replace. Independent readers should allow `FILE_SHARE_DELETE` if they wish not to block publication; incompatible readers/scanners remain possible ([CreateFile sharing][MS-create]). Re-run fencing callbacks on retries, not just before the first attempt.
- Outcome records stage, attempt count, elapsed time, normalized/native code and `published`/`durabilityConfirmed` without bytes. Before publication failure: keep the complete old target, clean only our private temp, and reject. After successful rename: fire the tracked publication callback exactly once. Verification or durability failure **after publication** must say `published=true`, not invite blind replay. Do not claim durable directory metadata on Windows until the chosen mechanism is demonstrated; unsupported directory sync is not silently treated as durable. The [current tracked writer][CA-atomic] already distinguishes the rename callback from later directory-sync failure.

Comparable JS evidence is a useful warning, not an ACL solution: [graceful-fs][JS-graceful] retries Windows `EACCES/EPERM/EBUSY` up to 60 seconds and only when the destination is absent—too long and insufficient for our replace-existing path. [write-file-atomic][JS-atomic] stages, fsyncs and renames using bare `fs`, but adds no Windows retry/DACL policy. [proper-lockfile][JS-lock] uses mkdir/mtime and `EEXIST` staleness logic, not owner-only security. Reject importing those behaviors wholesale; retain their staging/error discipline where applicable.

## 6. Lease-lock error classification

**Decision: normalize only operation-specific, demonstrated lost races.** Sharing/access failures are not evidence that another lease owner won. Keep ownership assertions, nonce checks, renewal deadlines and TTL recovery; never proceed with a refresh without the lock.

| Operation | Classification |
| --- | --- |
| Exclusive lease create or eviction-marker `mkdir` returns `EEXIST` | Contention only for that exclusive operation; read/validate the existing owner record. |
| Existing legacy lock directory / `EISDIR` | Contention only after verifying the expected existing directory shape; not a global errno alias. |
| Initial create returns `ENOENT` | Missing-parent setup, then one exclusive retry; not successful acquisition. |
| Marker-owner write/claim encounters a disappeared marker (`ENOENT`) | Lost race only at the already-claimed marker boundary, with marker/nonce checks; retry within the existing steal limit. |
| Renewal, marker rename/removal or release returns `EBUSY`, `EPERM`, `EACCES` | Keep as IO/security failure. A bounded sharing retry may be attempted while the original owner/expiry still verifies; no conversion to `EEXIST`, `ENOENT`, or acquired/released. |

The [current lease implementation][CA-lease] uses `wx`, JSON owner/expiry records and `.evicting` directories, not hardlinks. Renewal catches errors and rechecks ownership; release can leave a lease to expire. Any new Windows normalization needs a real NTFS reproducer at the precise operation, native error code and a test showing one owner survives the race. Until then, preserve the error and fail closed; do not enlarge catch sets based on a POSIX-sounding error message. The sharing retry deadline is additionally capped by remaining lease lifetime and reruns ownership assertions before each attempt.

## 7. Verification and minimal Windows CI

**Decision: pure tests on macOS/Linux are useful but cannot certify Windows ACLs or sharing behavior.** A mocked `chmod`, successful subprocess exit, synthetic `stat.mode`, or injected `rename` error does not prove the operating-system security property.

On macOS/Linux, test the normalized descriptor predicate (wrong owner, foreign/inherited/unknown ACEs, null/empty DACL, reparse flag), exact subprocess argument/data separation, write-before-verify prohibition, temp ownership/cleanup, retry attempt/deadline/fencing logic with fake clocks, outcome classification and caller propagation. Keep real POSIX mode/atomic/lock regression tests. These prove **logic and argument shapes only**; descriptor mocks do not prove SID acquisition, Win32 traversal, permissions, runtime errno mapping or actual replace behavior.

Minimal future CI: **one `windows-latest` job**, timeout 10 minutes, `contents: read`, reviewed SHA-pinned checkout/setup-node/setup-bun actions and exact project-supported Node/Bun versions. After frozen install, build the Windows x64 addon with the MSVC developer environment (or consume the exact release prebuild and assert load), run the package build before typecheck as required by its declaration-importing fixtures, then run the same isolated `windows-private-files` harness once with `node` and once with `bun`. Record OS/filesystem, runtime versions, native error codes, descriptor JSON, test counts and timing distributions as artifacts. [Hosted runners][GH-runners], [setup-node][GH-node], [setup-bun][GH-bun]. No workflow is created in this report.

Required real-host assertions:

- File/directory owner and every ACE read by an **independent** PowerShell/.NET inspector match the template; the addon must not self-certify its own output. Wrong owner, explicit Everyone/other-user grant, inherited grant, null DACL, empty DACL, junction/final reparse point and ancestor junction all refuse. Verify file and directory creation and post-rename ACLs, and fail before a secret-writing hook on an insecure fixture.
- Hosted Windows runs as administrator. Provision an ephemeral **standard non-admin second user** ([New-LocalUser][MS-newuser]) and launch a readable probe outside the private root using [`Start-Process -Credential`][MS-startprocess]. First prove it starts and can read an intentionally public control file; then verify access-denied for the private file and directory (including a known-name direct file read). An unrelated launch/path error is not a denial pass. Use the same checks after migration/replacement, tear down the account in `finally`, and do not log its random credential.
- A Win32/.NET helper opens the existing destination without `FILE_SHARE_DELETE`: release it within the budget and see successful complete replacement; hold it through the budget and see explicit failure with old bytes intact. Assert no unlink-target gap. Record real Node/Bun codes; measure request event-loop responsiveness while ACL/write/rename work runs.
- Real lease acquire/contention/stale-marker/renewal/release races, no multiple owners; inherited-ACL migration and recovery when the vault returns an approved enrollment token only once but local secure publication fails. Include a disabled-verifier/foreign-grant negative control so ACL assertions cannot pass merely because the second-user probe never ran.

This job qualifies its tested local-NTFS/runtime combination, not all users/groups, Windows ARM64, cloud/network filesystems or privileged attackers. If second-user launch or a fixture cannot be exercised, fail that required test or mark the capability unsupported; do not turn it into a green skip. No Windows tests have been run for this document.

## 8. Migration and implementation slices

**Decision: explicit, fail-closed, current-owner migration before normal reads/writes.** Removing inherited access cannot undo previous exposure. The enrollment token may have been returned only once; do not delete it as an incidental cleanup action.

Under the relevant lock and with reparse/ancestor checks, inspect existing roots and files before parsing secrets. A current-user-owned ordinary object in safe ancestry may be secured in place by replacing its DACL with the protected template, then verified by handle. Automatic permission-only remediation is limited to application-dedicated private roots; for a shared/custom parent require an explicit operator migration into a new private root. Never take ownership of a foreign-owned object, follow a reparse point, or recursively rewrite an arbitrary config/home tree. Unknown ACE forms, unsafe ancestry, unavailable ACL support or failed verification refuse with a path/stage/remediation diagnostic, without token contents.

Copy/move into a new root uses secure staging and explicit success checks; retain the old object until the new copy is verified and published, then remove only the known old object. State/config remain coherent under existing transaction locks. Do not treat an unsecured legacy file as an accepted normal read simply because migration was offered. Record policy version only after descriptor verification; that marker is an optimization, never proof for subsequent reads. Report possible historical exposure and recommend credential rotation/re-enrollment; coordinate token rotation with claustrum-client's maintainer so a once-only approved token is not lost or silently invalidated.

Ordered slices (each independently reviewed; no implementation in this report):

1. **Primitive + Windows proof:** establish the shared SID/DACL contract, async addon, secure create/read/directory operations, canonical policy tests and real NTFS CI. Reuse N-API distribution conventions; prove Node/Bun Windows loading and record startup/write latency before enabling the request-path backend.
2. **Shared IO and persistence:** route atomic JSON, RPC, lease artifacts, sidebar, dumps, Pi auth/stash and the async log sink through the primitive. Add replacement outcome/retry tests and explicit failure propagation. Preserve Unix behavior and lease fencing; replacing the lease algorithm with OS kernel locks is a separate concurrency-contract change and must not be bundled with file-access protection.
3. **Enrollment, consumers and migration:** ship common-auth reader/pending-state writer and claustrum-client's token publisher together; update openai-auth's direct heartbeat/host-slot/import writers and fixed-temp-root users. Gate migration before normal secret use, exercise once-only approval/publication recovery, and release only after Windows CI plus cross-runtime integration passes.

## Sources

[OA-census]: https://github.com/cortexkit/openai-auth/blob/ea9e6f88ccafe42577ad6d10b86097d032be602f/docs/reports/platform-census-2026-10-08.md#runtime-findings

Reference labels use `CA` for common-auth and `OA` for openai-auth; `OA-census` is the openai-auth census discussed at the start of this report. Adoption references support the private-files rollout inventory in section 4 and are pinned so later source changes do not move the evidence.

Microsoft / runtime references (API contracts, not measurements):

[Node-modes]: https://nodejs.org/api/fs.html#file-modes
[Node-stats]: https://nodejs.org/api/fs.html#class-fsstats
[Node-errors]: https://nodejs.org/api/errors.html#system-errors
[Node-async]: https://nodejs.org/api/n-api.html#asynchronous-work
[Bun-open]: https://bun.com/reference/node/fs/open
[Bun-stat]: https://bun.com/reference/node/fs/stat
[Bun-napi]: https://bun.com/docs/runtime/node-api
[MS-icacls]: https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls
[MS-getacl]: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/get-acl
[MS-setacl]: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/set-acl
[MS-protection]: https://learn.microsoft.com/en-us/dotnet/api/system.security.accesscontrol.objectsecurity.setaccessruleprotection
[MS-rawsd]: https://learn.microsoft.com/en-us/dotnet/api/system.security.accesscontrol.rawsecuritydescriptor
[MS-token]: https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-gettokeninformation
[MS-null]: https://learn.microsoft.com/en-us/windows/win32/secauthz/null-dacls-and-empty-dacls
[MS-dacl]: https://learn.microsoft.com/en-us/windows/win32/secauthz/how-dacls-control-access-to-an-object
[MS-create]: https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew
[MS-createdir]: https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createdirectoryw
[MS-newobjects]: https://learn.microsoft.com/en-us/windows/win32/secauthz/security-descriptors-for-new-objects
[MS-getsecurity]: https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo
[MS-setsecurity]: https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo
[MS-reparse]: https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-points-and-file-operations
[MS-move]: https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw
[MS-newuser]: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.localaccounts/new-localuser
[MS-startprocess]: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/start-process#-credential
[UV-fs]: https://github.com/libuv/libuv/blob/4080d7d965fdf291f37ec72677fc5a2ace8fa361/src/win/fs.c#L2340-L2347
[UV-errors]: https://github.com/libuv/libuv/blob/4080d7d965fdf291f37ec72677fc5a2ace8fa361/src/win/error.c#L66-L159
[JS-graceful]: https://github.com/isaacs/node-graceful-fs/blob/f7a43701434b3e8f1c3c9fe9df972330de8b7ecb/polyfills.js#L87-L124
[JS-atomic]: https://github.com/npm/write-file-atomic/blob/23e111d95367e1d987c1b4d7823791eaaf6b21df/lib/index.js#L80-L161
[JS-lock]: https://github.com/moxystudio/node-proper-lockfile/blob/9f8c303c91998e8404a911dc11c54029812bca69/lib/lockfile.js#L25-L82
[GH-runners]: https://docs.github.com/en/actions/reference/runners/github-hosted-runners
[GH-node]: https://github.com/actions/setup-node#usage
[GH-bun]: https://github.com/oven-sh/setup-bun#usage
[File-lock-repo]: https://github.com/cortexkit/file-lock
[File-lock-registry]: https://registry.npmjs.org/@cortexkit/file-lock

Pinned source references used by the section 4 tables (line numbers appear in the tables):

[CA-atomic]: https://github.com/cortexkit/common-auth/blob/ae42b292b87f662e95bf95c365d8b1139bbb69c8/src/fs/atomic-write.ts
[CA-lease]: https://github.com/cortexkit/common-auth/blob/ae42b292b87f662e95bf95c365d8b1139bbb69c8/src/fs/refresh-file-lock.ts
[CA-rpc]: https://github.com/cortexkit/common-auth/blob/ae42b292b87f662e95bf95c365d8b1139bbb69c8/src/rpc/port-file.ts
[CA-sidebar]: https://github.com/cortexkit/common-auth/blob/ae42b292b87f662e95bf95c365d8b1139bbb69c8/src/sidebar-file/sidebar-file.ts
[CA-logger]: https://github.com/cortexkit/common-auth/blob/ae42b292b87f662e95bf95c365d8b1139bbb69c8/src/logger/engine.ts
[CA-dump]: https://github.com/cortexkit/common-auth/blob/ae42b292b87f662e95bf95c365d8b1139bbb69c8/src/dump/index.ts
[CA-enrollment]: https://github.com/cortexkit/common-auth/blob/ae42b292b87f662e95bf95c365d8b1139bbb69c8/src/claustrum/enrollment.ts
[CA-pi]: https://github.com/cortexkit/common-auth/blob/ae42b292b87f662e95bf95c365d8b1139bbb69c8/src/pi-slot/slot.ts
[CA-mutate]: https://github.com/cortexkit/common-auth/blob/ae42b292b87f662e95bf95c365d8b1139bbb69c8/src/store/mutate.ts
[CA-settings]: https://github.com/cortexkit/common-auth/blob/ae42b292b87f662e95bf95c365d8b1139bbb69c8/src/store/settings.ts
[CA-tui]: https://github.com/cortexkit/common-auth/blob/ae42b292b87f662e95bf95c365d8b1139bbb69c8/src/tui-prefs/tui-preferences.ts
[CA-roster]: https://github.com/cortexkit/common-auth/blob/ae42b292b87f662e95bf95c365d8b1139bbb69c8/src/claustrum/roster.ts
[OA-heartbeat]: https://github.com/cortexkit/openai-auth/blob/ea9e6f88ccafe42577ad6d10b86097d032be602f/packages/opencode/src/core/process-heartbeat.ts
[OA-host-slot]: https://github.com/cortexkit/openai-auth/blob/ea9e6f88ccafe42577ad6d10b86097d032be602f/packages/opencode/src/v2/host-slot.ts
[OA-sidebar]: https://github.com/cortexkit/openai-auth/blob/ea9e6f88ccafe42577ad6d10b86097d032be602f/packages/opencode/src/sidebar-state.ts
[OA-vault]: https://github.com/cortexkit/openai-auth/blob/ea9e6f88ccafe42577ad6d10b86097d032be602f/packages/core/src/vault.ts
[OA-accounts]: https://github.com/cortexkit/openai-auth/blob/ea9e6f88ccafe42577ad6d10b86097d032be602f/packages/core/src/accounts.ts
[OA-migration]: https://github.com/cortexkit/openai-auth/blob/ea9e6f88ccafe42577ad6d10b86097d032be602f/packages/opencode/src/core/pool-migration.ts
