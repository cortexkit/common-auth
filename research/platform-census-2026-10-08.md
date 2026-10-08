# common-auth platform census — 2026-10-08

## Headline

**21 findings: 17 OS/filesystem/terminal-dependent differences or conditional risks, plus 4 shared durability/runtime caveats.** Linux has **no unconditional OS blocker demonstrated** in the shared library; its first conditional setup blocker is Claustrum enrollment under a non-private, group-writable ancestor or an account configuration the local passwd/group proof cannot establish as private. Windows first loses the promised private-file security at `chmod(0600/0700)`; the first clear functional blocker is **Claustrum's POSIX-only enrollment permission contract** (token/state mode checks and the delegated token writer). A Node process without the OpenTUI host-module redirect also fails the TUI selector on Linux, Windows **and macOS**.

This is a census, not a compatibility implementation. Only this report was added. No source, test, manifest, lockfile or shim was changed.

## Scope, evidence and terminology

- Snapshot: `@cortexkit/common-auth` **0.11.5**, main-derived base **`0043a371c44076e4cb644c489950e75fb1604f37`**. Locations below refer to this snapshot, not an assumed newer lock implementation.
- All **17 package exports** in `package.json:14–82` were covered, counting `./rpc/client` separately. The plugins choose their directories and bundle these subpaths into OpenCode 1, OpenCode 2 and Pi; this library does not choose HOME/XDG/AppData paths.
- **CR** means code read, with Node's documented platform semantics where relevant. **LR** means an actual Linux execution through `functions.bash` with `runon: 'linux'`, not a macOS run with `process.platform` mocked. **All Windows conclusions are CR, not a Windows execution.** Bun-on-Windows behavior still needs a real qualification run; Node's Windows contract is not proof of Bun's exact errno mapping.
- Linux runner: `ck-motor`, `Linux 7.0.0-34-generic x86_64`; Bun **1.4.2**; installed `node` **v22.22.1**; TypeScript **7.0.2**. Bun reports its own Node-compatibility `process.version` differently; that is not the installed Node version.
- **works** means the inspected path has a compatible primitive, or the named Linux check passed. It is not a claim that every filesystem, runtime version and real host integration was tested. **degraded** means functionality/security is weaker or delayed. **no-op** means a protection or action silently does nothing. **refuses** means a rejected operation or fail-closed result. **crashes** below means a thrown/rejected bootstrap/build call that terminates an uncaught caller; not proof the library itself calls `process.exit`.
- Severity: **critical** = supported feature cannot complete or its credential boundary lacks the required security mechanism; **high** = credential persistence/security or supported bootstrap affected; **medium** = optional build/UI/discovery path fails or state can remain stale; **low** = bounded delay or environment-specific usability loss.
- Count: numbered findings **F01–F21**, not the number of API call sites. F03, F14, F17 and F20 also apply on macOS; they are separated to avoid inventing a macOS advantage. Several other findings are conditional filesystem/environment risks, explicitly labeled, rather than universal OS failures.
- The brief's `fs.watch` warning does not denote a missing source file. The actual implementation is the `watch` import at **`src/tui-prefs/watcher.ts:1–7`**, invoked on a directory at **`:131–151`**. `./sidebar-file` has no native watcher of its own. No file literally named `fs.watch` or compatibility shim was created.

### Real Linux verification and its limits

Commands below were all sent with `runon: 'linux'` and waited for completion.

```sh
uname -srm && bun --version && node --version && git rev-parse HEAD
bun --version && bunx --no-install tsc --version && bun run build && bun run typecheck && bun test test/fs test/rpc test/sidebar-file test/tui-prefs test/logger test/store test/claustrum test/dump test/cachekeep test/quota test/routing test/commands test/auth-menu test/tui-build test/tui test/opencode2
```

- Build **passed**: local-dependency guard checked **6 package manifests**; installed-range guard checked **12 dependencies**; `tsc -p tsconfig.build.json` exited 0. `tsc --noEmit` **passed**, TypeScript 7.0.2. Compiler success is silent; it does not produce a test count.
- The census suite ran **1,254 tests across 102 files**, **1,231 passed / 10 skipped / 13 failed**, **5,898 expectations**, in **73.11 s**. This is **not a fully green Linux suite**.
- **12 failures** are the tests' explicit prerequisite refusal, **“Node 24 is required”**: the proxy test; five port-staging tests; two RPC-stop tests; four strict observer-rejection tests. The runner has Node 22 and no `mise` executable, so these do not establish a production Linux incompatibility. CI asks for Node 24 (`.github/workflows/ci.yml:22–27`). No Node 24 install or test rewrite was made for this report.
- The remaining failure, **`packed tui selector probes the exact id and imports only the selected absolute entry`**, failed before loading the selector: `tar` returned **“Cannot open: Function not implemented”** extracting package files into the runner's worktree filesystem (`test/tui/load-tui.test.ts:32`). The other two selector tests passed. This is a runner/extraction limitation, not evidence that the selector works or fails in a real Linux host.
- **10 OpenCode 2 placement E2E tests were skipped** because `COMMON_AUTH_OPENCODE2_E2E=1` was not enabled. Fake-host/transport tests ran. Neither the three actual plugins nor actual Pi/OpenCode TTYs were certified by this census.
- Relevant passing tests included lock acquisition/renewal/stale-marker orderings, exclusive atomic staging and cleanup, RPC discovery/raw wire/proxy bypass under Bun, sidebar repair/fences, metadata watcher replacement, logger rotation, store process-crash recovery, enrollment/private-group/owner/nofollow checks, dump writes/sweeps, cache warming, command menus, quota and routing.
- A separate **Node v22.22.1 Linux inline probe completed 15 named assertion checks** against the built modules. It covered replacement while an old destination descriptor remains open; 0600 mode; exclusive/live/stale-marker leases; live/dead PID port discovery; raw HTTP apply; directory-watch replacement; host enrollment paths; regular token read and symlink refusal; writable-ancestor refusal; and the two expected TUI failures in F14/F17. It created and removed only temporary probe files under `test/.scratch/`.

Selected probe output, copied here so it survives tool-output retention:

```text
PASS atomic replacement while old destination open
PASS stale marker directory rename and reclaim
PASS raw loopback HTTP apply
PASS directory watch observes atomic preferences replacement
PASS nofollow token reader refuses symlink
OBSERVED runner test directory {"mode":"775","uid":1000,"gid":1000,"euid":999,"egid":986}
PASS writable runner ancestor fails closed
OBSERVED Node selector rejection: ERR_UNSUPPORTED_ESM_URL_SCHEME: Only URLs with a scheme in: file, data, and node are supported by the default ESM loader. Received protocol 'opentui:'
OBSERVED Node build rejection: ReferenceError: Bun is not defined
{"platform":"linux","node":"v22.22.1","checks":15,"result":"passed","expectedRefusals":3}
```

An earlier inline probe aborted at the delegated token writer's foreign/group-writable runner ancestor; the completed probe above separated token reading from that unsafe setup directory. The runner's `test` directory ownership mismatch is not a claim about an ordinary user's Linux home. Linux enrollment tests using private temporary directories passed, including the actual private-group token writer.

Documentation-delivery validation: Biome **2.5.14** (`bun run lint`) checked **243 files**, applied no fixes, and exited 0 with two existing `noDynamicNamespaceImportAccess` warnings in `test/dump/response-clocks.ts:85,110`. A later standalone `bun run typecheck` initially failed because built `dist` self-export declarations were absent; the repository's `lefthook.yml:5–8` explicitly requires build before typecheck. The authoritative build-plus-typecheck command is recorded separately from that prerequisite failure.

## Findings

### Shared filesystem plumbing, store, logger and dumps

#### F01 — 0600/0700 are not a Windows private ACL

- **Locations:** `src/fs/atomic-write.ts:17–30`; `src/fs/refresh-file-lock.ts:161–183,247–252`; `src/rpc/port-file.ts:131–146`; `src/sidebar-file/sidebar-file.ts:220–227`; `src/logger/engine.ts:94–99,195–200`; `src/dump/index.ts:342–345,599–601,654–655`; `src/claustrum/enrollment.ts:503–512,537–540`.
- **Linux:** **works** for owner-only regular files/directories on POSIX filesystems. File creation applies umask, and descriptor chmod restores 0600 in the atomic writers. Existing sidebar/dump/secure RPC directories are tightened. Logger chmod failure and sidebar directory-remediation failure are best effort, so a failed Linux chmod can already leave weaker protection.
- **Windows:** **degraded / security no-op**. Node chmod only changes the write attribute, not separate owner/group/other rights; directory `mode` does not establish an owner-only DACL. An operation can succeed while inherited ACLs still admit another user. A private profile directory may make the resulting file safe, but the library accepts arbitrary host paths and does not prove that assumption. Log redaction and dump redaction are not substitutes for access control; RPC files contain the bearer token and the store contains provider credentials.
- **How known:** CR plus Node file-mode documentation; LR verified an atomic target mode of 0600. No Windows ACL probe was run.
- **Severity:** **critical security portability gap** for secret-bearing files; **high** for diagnostic/state artifacts.
- **Fix shape:** one reviewed private-file/directory capability used by every writer: POSIX modes/ownership on Unix, explicit current-user Windows SID/DACL creation and validation on Windows, including existing directories and retained staging files. Do not silently ignore the private-file guarantee or just skip its tests. Distinguish user-owned override directories from library-managed directories, as `secureDir` already does.

#### F02 — Windows sharing violations change rename/delete from atomic success to rejection or silent loss

- **Locations:** `src/fs/atomic-write.ts:31–39`; `src/fs/refresh-file-lock.ts:170,283–289,390–399,468,538–543`; `src/logger/engine.ts:101–116,179–201`; `src/rpc/port-file.ts:149–164,217–219`; `src/rpc/rpc-server.ts:388–393`; `src/dump/index.ts:278–286,348–355,682–687,763–768`; inherited by `src/store/mutate.ts:345–359` and `src/sidebar-file/sidebar-file.ts:162–168`.
- **Linux:** **works** for same-filesystem replacement, including an open old destination (LR). An unlinked/renamed file can remain readable through its old descriptor. POSIX permission/mount failures still refuse; this is not a claim every Unix rename succeeds.
- **Windows:** **works normally on NTFS**, but **refuses / degraded** if another opener, editor, antivirus or filesystem denies delete sharing. Windows rename-over is not categorically unsupported: Node implements replacement. The problem is conditional `EPERM/EACCES/EBUSY`/sharing failure. Atomic write rejects and cleans its staging file; store wraps it as an operation failure. Lease renewal swallows/retries while the current lease remains verifiable, potentially expiring later; release/sweep deletion can silently leave old state. Logger catches rotation failures and keeps appending, so the size cap may cease to hold; append failures lose an already-cleared buffer. Dump failure warns and returns `undefined`; sweep deletion failure keeps the artifacts for another sweep.
- **How known:** CR of these different catch paths and native platform sharing semantics; LR replaced a file while an old Node descriptor was open. No Windows sharing-mode run was performed.
- **Severity:** **high** for store/lease persistence; **medium** for discovery/log/dump retention.
- **Fix shape:** preserve same-directory atomic replacement and exclusive staging; classify platform transient sharing failures and apply bounded retry/backoff under a still-live ownership fence. Do **not** implement unlink-then-rename as an “atomic” fallback. Report terminal persistence/rotation failures appropriately; test a Windows process holding a destination without delete sharing and directory-marker contention.

#### F03 — Atomic publication is not power-loss durability; the store inherits it

- **Locations:** `src/fs/atomic-write.ts:22–35`; `src/fs/refresh-file-lock.ts:161–171`; `src/store/mutate.ts:345–359`; `src/store/settings.ts:171–178`; `src/store/refresh.ts:313–320`; `src/claustrum/enrollment.ts:537–544`; `src/dump/index.ts:342–348`.
- **Linux:** **works for complete reader-visible replacement and tested process crashes; degraded for OS crash/power loss**. `writeJsonAtomic` never calls `sync/datasync`, nor syncs the parent directory. Ordered state/config writes and torn-row completion repair process-crash windows only after the required bytes/renames actually survive. A “durable successor” comment is stronger than the helper's flush contract.
- **Windows:** **the same durability gap**, plus F02 sharing behavior. Closing a file and succeeding at rename is not an explicit stable-storage barrier.
- **How known:** CR; LR store crash tests passed, but those are killed-process tests, **not power-cut tests**. Enrollment state and the peer token writer do call descriptor `sync()`; neither explicitly syncs parent-directory publication. This is **also a macOS caveat**, not evidence Linux alone loses data.
- **Severity:** **high** if the advertised crash-safe guarantee includes system failure; otherwise document its process-crash scope.
- **Fix shape:** define the guarantee first; for durable credential commits, flush staged content/metadata, atomically publish, then perform supported directory/publication durability steps. Map Unix file/directory fsync and Windows `FlushFileBuffers`/replacement semantics explicitly; test or document filesystem limits and two-file commit ordering. Best-effort dumps need not acquire the store's stronger durability contract.

#### F04 — Lease and retention age use filesystem mtime and wall-clock assumptions

- **Locations:** `src/fs/refresh-file-lock.ts:215–226,278`; `src/dump/index.ts:266–268,294,303–315`.
- **Linux:** **works** on the tested filesystem; **degraded conditionally** on coarse/stale network metadata or clock discontinuity. The normal lease is JSON `expiresAt`; mtime is the fallback for unreadable/partial/legacy owner data. A stale eviction directory is eligible after **5 seconds** of mtime age.
- **Windows:** **works on ordinary NTFS**, but **degraded conditionally** on coarse timestamps (for example FAT-family volumes), remote filesystems or clock changes. Early/late stale detection changes contention/reclamation timing; dump age ordering/retention changes too. This is filesystem-dependent, not an assertion NTFS has unusable mtimes.
- **How known:** CR, Node documents timestamp precision as platform-specific; LR stale-marker recovery passed. No clock-jump, FAT or SMB test.
- **Severity:** **medium** for leases, **low** for dump age ordering.
- **Fix shape:** specify supported shared-state filesystem/clock assumptions; prefer validated owner-record timing, bound timestamp uncertainty, preserve fail-closed ownership fences, and test coarse/stale metadata. Do not replace a cross-process persisted expiry with a process-local monotonic timestamp without a protocol design.

### RPC and watcher identity

#### F05 — Directory watching survives file replacement, but not all native-watch failures

- **Locations:** `src/tui-prefs/watcher.ts:90–108,122–160`.
- **Linux:** **works** through inotify; **degraded to polling** on watch-limit exhaustion, unavailable network/virtual mounts, errors, or a deleted/recreated parent directory. Watching the parent rather than the file is the correct fix for atomic **file** replacement, but a replaced **directory** can leave the native watch attached to the old inode.
- **Windows:** **works** through `ReadDirectoryChangesW`; **degraded to polling** when the watched directory moves/renames (no native events) or is deleted (`EPERM`). Construction/error failure closes or omits the watcher, with no reattachment attempt.
- **How known:** CR and Node watch caveats; LR the directory watch observed an atomic file replacement and the watcher suite passed.
- **Severity:** **low** normally: a **1,000 ms metadata probe** plus serialized reads recovers changed metadata. It is not a universal no-op or crash. F06 is the remaining undetectable-change case.
- **Fix shape:** retain the directory watch and polling fallback; optionally reattach a failed/replaced parent watch with bounded backoff, expose degradation to diagnostics, and run inotify-limit and Windows moved/deleted-directory cases. A null filename is already handled as “recheck”; no shim is needed for that case.

#### F06 — Metadata identity is not universally a collision-free replacement detector

- **Locations:** `src/tui-prefs/watcher.ts:12,40–41,94–109`; `src/rpc/port-file.ts:233–245`; `src/rpc/rpc-client.ts:50–68,82–84`; test claim at `test/tui-prefs/watcher.test.ts:389–400`.
- **Linux:** **works** with changing inode/dev identity; LR the same-size/same-mtime replacement test passed. **Degraded conditionally** when a filesystem reuses identity, reports weak identity, or a same-size in-place edit preserves mtime and no native event arrives.
- **Windows:** **works where Node/Bun supplies useful stable volume/file identity**, as NTFS implementations can. Do **not** assume every Windows `ino` is zero. **Degraded / silent stale state conditionally** if `ino/dev` are zero, reused, or rounded through JavaScript Number and both mtime and size are unchanged. The polling path returns before reading contents; RPC can keep a stale port/token selection. It will rediscover on suitable connect/auth failures, but not necessarily within one successful cached call.
- **How known:** CR of the equality/early-return predicates. Windows weak-identity behavior is a **conditional risk requiring measurement**, not a recorded zero-ino run. `boundIdentity` correctly binds initial identity to bytes from one descriptor; that does not eliminate later metadata collisions.
- **Severity:** **medium** for lost preference updates/stale RPC selection.
- **Fix shape:** qualify actual identity support per runtime/filesystem; use bigint stat values where useful and add a bounded periodic content/version check when metadata/native notifications are insufficient. Add a same-size/same-mtime/constant-ino no-native-event test. Merely comparing the same metadata tuple again cannot prove freshness.

#### F07 — RPC rendezvous hashes the supplied project spelling, not filesystem identity

- **Location:** `src/rpc/port-file.ts:60–69`; cache path keys at `src/rpc/rpc-client.ts:242–246`.
- **Linux:** **works** if server/client supply the same project string. Distinct case normally means a distinct path; symlink/relative spelling can still split identity on all OSes.
- **Windows:** **degraded / RPC no-op conditionally**: the same directory may be spelled with different drive-letter case, separators, case-insensitive components or junction aliases. Hashing those strings produces different state directories; discovery yields null, `pending()` yields `[]`, and `apply()` yields the generic failure (`src/rpc/rpc-client.ts:249,317,331`). Default case-insensitive macOS filesystems have a subset of this risk too.
- **How known:** CR. No real Windows path-alias run.
- **Severity:** **medium**; caller coordination, not a native TCP failure.
- **Fix shape:** agree on one host-resolved canonical project identity before both server and client compute rendezvous paths. Preserve existing naming/migration compatibility; avoid indiscriminate lowercasing that would collapse distinct directories on case-sensitive volumes.

### Claustrum setup and secret files

The main code requires `connectionFile` explicitly (`src/claustrum/index.ts:104–112`, `src/claustrum/enrollment.ts:111–119`) and builds token/state paths with `node:path` (`enrollment.ts:178–213`). It does **not** hardcode `/tmp`, a macOS Application Support directory or a Linux-only daemon socket. The optional peer actually carries the connection reader and token writer, so those shipped dependency paths matter to this census.

Dependency locations below are package-relative, independent of Bun's install-store path: `@cortexkit/claustrum-client` **0.6.2**, and its locked `@cortexkit/subc-client` **0.16.1**. The peer floor does not certify every possible future peer version.

#### F08 — Token/state readers reject synthetic Windows POSIX modes

- **Locations:** `src/claustrum/enrollment.ts:325–349,363–388,552–561,588–601,699–714`; Windows-skipped secrecy tests at `test/claustrum/enrollment.test.ts:708–709,876`.
- **Linux:** **works / correctly refuses** non-regular, foreign-owned or group/other-accessible files; LR readers, mode tests and enrollment tests passed.
- **Windows:** **refuses** ordinary Node regular files because the unconditional `(metadata.mode & 0o077) !== 0` check treats synthetic group/other bits (normally 0666 for writable files, 0444 for read-only files) as a real permissions leak. `chmod(0600)` cannot make those into Unix owner-only bits. Even a file secured by a real private DACL has no accepted Windows validation path. This can reject an existing token immediately or reject a ceremony's own state on its next tick.
- **How known:** CR plus Node Windows mode semantics. Bun's exact stat emulation was not executed on Windows; either synthetic permissive bits trigger this refusal or an emulated 0600 still does not prove a private DACL (F01).
- **Severity:** **critical functional blocker** for Node/Windows enrollment and custody reads.
- **Fix shape:** validate real current-user ownership and effective private access via a Windows security capability; keep regular-file and size/schema checks. Replace the mode test with an equally strong platform-specific check, not a win32 bypass granting access to arbitrary files.

#### F09 — Owner and ancestor protections silently disappear without geteuid/getegid

- **Locations:** `src/claustrum/enrollment.ts:342–348,453–459,503–512`.
- **Linux:** **works** with effective UID/GID; writable nonsticky ancestors are inspected and unsafe ones **refuse**. LR a runner ancestor with mode 0775 owned by UID/GID 1000 while the probe ran as 999/986 was rejected, as intended.
- **Windows:** **security no-op**: `refuseWritableAncestor` returns immediately when `geteuid` is absent, and file/directory owner comparisons are skipped. Mode chmod is still attempted, but supplies no SID ownership or protection against ancestor replacement. This no-op is distinct from F08's later file-read refusal and F12's dependency refusal.
- **How known:** CR; Node documents these identity APIs as POSIX-only. No Windows security-descriptor test.
- **Severity:** **high security gap**; private bytes can be staged below a directory another account controls.
- **Fix shape:** Windows SID/owner/effective-access and canonical ancestor/reparse-point validation. Maintain explicit safe exceptions equivalent to sticky/private directory rules rather than interpreting missing POSIX APIs as safety.

#### F10 — O_NOFOLLOW does not exist in Node's Windows open flags

- **Location:** `src/claustrum/enrollment.ts:363–376`.
- **Linux:** **works / refuses symlinks** with `O_RDONLY | O_NOFOLLOW`, then checks the opened descriptor's regular-file type, mode, owner and size. LR symlink-token rejection passed under Node and the Bun suite.
- **Windows:** **security no-op at the open flag** in the documented Node API. An unavailable `O_NOFOLLOW` in a bitwise OR contributes zero, leaving an ordinary read open. The later mode check commonly refuses (F08), but that is not reparse-point protection, and relaxing it alone would expose symlink/junction redirection. A Bun implementation rejecting an unsupported numeric flag would instead refuse; it was not measured.
- **How known:** CR; Node lists Windows-supported open flags and excludes `O_NOFOLLOW`. No Windows reparse-point run.
- **Severity:** **high**, especially a prerequisite to any F08 fix.
- **Fix shape:** use an appropriate Windows no-follow/reparse-point-aware open and inspect the resulting handle and ancestry. Preserve race resistance; a standalone lstat-before-open check is not equivalent.

#### F11 — The private-group proof is a local passwd/group proof, not NSS/directory-service membership

- **Locations:** `src/claustrum/enrollment.ts:397–447,475–487`; peer `@cortexkit/claustrum-client/dist/ancestor-permissions.js:22–42`.
- **Linux:** **works** for a conventional locally recorded user-private group (LR includes real approved token persistence under such an ancestor); **refuses** an otherwise private group-writable home when account/group records are missing, malformed, NSS-only, or do not match the effective primary GID. Setgid/shared-group homes with another GID also refuse. Conversely, local files alone cannot prove the absence of additional NSS-only users/members sharing that GID; a successful local-file proof is not a complete directory-service security proof.
- **Windows:** the common helper's group proof is **not reached / no-op** through F09, since effective UID/GID is absent. The peer token writer has the different F12 behavior. There is no `/etc/passwd`/`/etc/group` equivalent interpreted here.
- **How known:** CR of every predicate; LR private-group and refusal tests passed. The real runner's foreign writable ancestor refusal was observed. No LDAP/SSSD membership setup was run. macOS directory-service identities are also not fully represented by local account files, so the completeness caveat is not uniquely Linux.
- **Severity:** **medium availability**, **high security** if local records are taken as authoritative despite additional identity sources.
- **Fix shape:** keep fail-closed semantics; use a trustworthy platform identity/group source with explicit completeness rules, or require group-write removal when exclusivity cannot be proved. Do not treat a partial NSS enumeration as proof of absence. Explain the setup remediation without requiring chmod as the Windows remedy.

#### F12 — The delegated enrollment-token writer has a second, incompatible Windows ancestor gate

- **Locations:** `src/claustrum/enrollment.ts:841–849`; peer `@cortexkit/claustrum-client/dist/enrollment.js:13–34,43–61` and `dist/ancestor-permissions.js:22–28`.
- **Linux:** **works** under safe ancestors / **refuses** unsafe ones. Writes use exclusive staging, file sync, chmod and rename. LR the actual peer writer/private-group approval test passed; an initial inline probe correctly refused the runner's foreign group-writable `test` directory.
- **Windows:** **refuses on ordinary synthetic writable directory modes**: the dependency traverses ancestors even without `geteuid`, and `acceptsAncestor` returns false when world-write bits are set or effective identities are absent. This differs from the common helper's early no-op. Therefore skipping just common-auth's mode/ancestor checks cannot make the real Connect flow complete safely.
- **How known:** CR of the **installed floor peer**, not an assumed implementation; no Windows run. It is a coupled contract with F08/F09, not an extra operating-system transport requirement.
- **Severity:** **critical functional blocker** for publishing an approved consumer token.
- **Fix shape:** coordinate the permission capability and policy in both repositories; consume a compatible peer release and qualify the stated minimum peer. Preserve token-before-approved-state ordering and single-delivery token protection.

#### F13 — The connection reader skips Windows permissions, assuming a private profile location

- **Locations:** `src/claustrum/index.ts:109–112`, `src/claustrum/enrollment.ts:116–119`; peer `@cortexkit/subc-client/dist/connection-file.js:38–56`. Peer defaults: `@cortexkit/claustrum-client/dist/detect.js:12–66`.
- **Linux:** **works / refuses** connection files with group/other mode bits. The main library passes an explicit host-chosen file, so Linux XDG runtime or private state directories can work. The peer's standalone discovery supports `SUBC_CONNECTION_FILE`, XDG runtime, HOME `.local/share/cortexkit/run`, UID temp names and an unambiguous temp search.
- **Windows:** file permission validation is an **explicit security no-op**; it assumes inherited private-profile ACLs. That assumption is not guaranteed for a caller-supplied connection path. Its shared transport key can come from an insecure override. Main wrappers do not invoke automatic discovery when they pass a nonempty explicit path; therefore missing `HOME` is **not** an unconditional common-auth Windows blocker. Peer fallback uses username/environment tokens when UID is unavailable and does not choose an AppData path.
- **How known:** CR of main wrappers and locked peer. Linux Claustrum mock-daemon connection/authorization tests passed; no production daemon path search or Windows run.
- **Severity:** **high security**, conditional on connection-file ACL/location.
- **Fix shape:** validate the supplied connection file's Windows DACL/owner as well as Unix mode; make each plugin resolve the actual daemon-advertised path consistently with the daemon. Coordinate with subc/Claustrum, not a macOS/Linux path constant embedded in common-auth. The transport is TCP host/port (`@cortexkit/subc-client/dist/socket.js:80–95`), not a Unix-domain socket that needs a named-pipe substitute.

### TUI build and host-module redirect

#### F14 — TS TUI build uses Bun even if its caller is Node

- **Locations:** `src/tui-build/build-tui.ts:270–273`; tooling entrypoints at `package.json:88,95`.
- **Linux:** **works under Bun; crashes under Node** when visiting a `.ts/.mts/.cts` source (`ReferenceError: Bun is not defined`). LR reproduced the rejection with Node 22 and a one-line TS entry; Bun build/link/reproducibility tests passed.
- **Windows:** **works in principle under a qualified Bun build; crashes under Node** by the same global dependency. Actual Windows Bun build was not run.
- **How known:** CR + LR Node rejection. **Also true on macOS**; this is a build-runtime requirement, not a Linux-only incompatibility. Consumers running already-built auth code on Node need not call this helper.
- **Severity:** **medium** if explicitly Bun-only build tooling, **high** if Node build support is promised.
- **Fix shape:** clearly declare/enforce the build runtime, or use an injectable/shared transpilation capability with Node support. Keep runtime artifacts free of build-only Bun assumptions. Do not infer a Node runtime failure in quota/routing from this build-only call.

#### F15 — Windows cross-volume dependency paths bypass the “outside entry directory” test

- **Locations:** `src/tui-build/build-tui.ts:184–200,203–212,274–276`.
- **Linux:** **works** with POSIX relative paths; files outside the entry tree begin `../` and are assigned portable shared names.
- **Windows:** **refuses / build failure conditionally** when an entry's junction/symlink dependency resolves onto a different drive or UNC share. `path.relative(entryDirectory, source)` then returns an absolute path, not `..\\...`; `visit` only tests the latter, while `sharedKey` already uses `isAbsolute`. A nonshared absolute-relative result can turn into an invalid emitted path containing a drive colon or an unusable import, rather than a shared file name.
- **How known:** CR of predicates plus `node:path` cross-drive semantics; no real Windows junction/multi-volume run. Ordinary same-drive slash conversion is already handled (`:168,195`).
- **Severity:** **medium**, conditional build portability.
- **Fix shape:** decide shared/outside status using both parent traversal and absolute-relative results, with a final destination-containment check; test linked dependencies across drives/UNC roots and preserve stable package-relative shared keys.

#### F16 — Publish-list validation launches npm as a Unix executable

- **Location:** `src/tui-build/publish-list.ts:11–15`.
- **Linux:** **works** with `npm` on PATH; LR publish-list tests passed using npm **9.2.0**.
- **Windows:** **refuses / build check failure** under Node with a normal `npm.cmd` installation: `execFile('npm', ...)` without a shell does not launch a `.cmd` shim. Bun may provide different spawning behavior; no Windows run established it.
- **How known:** CR + Node documented `.cmd` process-creation semantics. This is a packaging helper, not a provider request path.
- **Severity:** **medium**.
- **Fix shape:** a platform-safe package-manager invocation (for example invoke the resolved npm CLI JS with the intended Node executable, or a carefully bounded/quoted Windows command interpreter invocation). Do not blindly enable a shell for arbitrary user-controlled paths/arguments. Test native Windows package lists, including spaces.

#### F17 — Node's unsupported-scheme error is not recognized as “host redirect absent”

- **Location:** `src/tui/index.ts:24–40`.
- **Linux:** **works under the tested Bun fallback**, or with a host resolving `opentui:runtime-module:%40opentui%2Fsolid`; **crashes/refuses under stock Node without that resolver**. Node throws `ERR_UNSUPPORTED_ESM_URL_SCHEME`, not one of the message fragments accepted at `:32–35`, so the raw entry is never tried.
- **Windows:** **the same Node refusal** without a host redirect; no OS-specific loader adaptation exists. Host resolver support remains a host contract, not an OpenCode/Pi capability proven here.
- **How known:** CR + LR exact Node error quoted above; Bun default-importer fallback test passed. **Also fails on stock macOS Node**, so this is not a Windows/macOS difference.
- **Severity:** **high** for a supported Node TUI bootstrap that expects fallback.
- **Fix shape:** identify only the exact absent host-module case using supported structured error codes/host capability information, while retaining rethrow of real initialization/dependency failures. Add a real Node selector test, not only a fake importer whose error text is manufactured to match the guard.

#### F18 — An accepted Windows absolute path is not necessarily an ESM import specifier

- **Location:** `src/tui/index.ts:12,14–22,40`.
- **Linux:** **works** for absolute `/...` paths and file URLs when the selected module is otherwise loadable.
- **Windows:** **refuses under Node conditionally**: `isAbsolute` accepts `C:\\...` and UNC paths, but the default dynamic importer forwards those strings unchanged. Node can interpret a drive path as a `c:` URL scheme instead of a file module; UNC paths also need proper file-URL handling. This becomes observable after the host probe succeeds or F17 is addressed. A caller already passing `pathToFileURL(...).href` avoids it.
- **How known:** CR of validation/import mismatch and Node ESM URL semantics. No Windows path-import execution. Do not apply Node's exact failure to Bun without testing it.
- **Severity:** **high** for callers using the helper's documented accepted absolute paths.
- **Fix shape:** normalize absolute filesystem entries to `pathToFileURL(entry).href` for the default importer, preserving genuine file URLs and the injected-importer contract; exercise spaces, drive roots and UNC paths on Windows.

### Commands and interactive auth menu

#### F19 — The auth menu requires a real raw TTY and VT-capable output; Windows signals differ

- **Locations:** `src/auth-menu/terminal.ts:43–56`; `src/auth-menu/menu.ts:68–88,98–122`; `src/auth-menu/select.ts:39–40,139–150,191–203`; `src/auth-menu/ansi.ts:2–14`; `src/commands/pi.ts:152–163,195–242`.
- **Linux:** **works** with an interactive PTY and ANSI/VT output; **action no-op** without input TTY (plain action list, `not-interactive`), **refuses** direct non-TTY `select`, or cancels when raw mode cannot be set. A dumb terminal or redirected output is **degraded**, because only input TTY is checked and ANSI is still emitted. LR scripted terminal/menu tests passed; the runner did not exercise a real terminal.
- **Windows:** **works in principle** with a supported Node/Bun console/ConPTY and Windows Terminal/VT; **degraded/no-op/refuses** under non-TTY pipes, unsupported raw-mode consoles, legacy VT-incompatible output or unsupported terminals. SIGTERM is not a graceful Windows signal; only SIGINT/SIGTERM listeners are registered, not Windows SIGBREAK or console-close handling. Forced termination cannot promise raw-mode cleanup. Ctrl-C bytes in raw input are explicitly handled on all OSes.
- **How known:** CR + Node signal documentation. No actual Windows terminal or actual Pi menu run. `./commands` itself does not put stdin in raw mode: Pi UI is injected and handles its own terminal. OpenCode 2 transport hooks also do not use raw TTY input.
- **Severity:** **medium UI compatibility**, **low** for the deliberate piped-menu no-op.
- **Fix shape:** qualify supported terminal capabilities, handle relevant Windows console cancellation, provide a plain/noninteractive command path for headless use, and test real PTYs/ConPTY. Preserve the rule that absence of interaction must not silently run destructive actions. Do not call every Windows menu broken just because Windows lacks POSIX signals.

#### F20 — Key parsing does not retain incomplete escape sequences across reads

- **Locations:** `src/auth-menu/ansi.ts:27–62`; `src/auth-menu/select.ts:158–184`; existing claim `test/auth-menu/menu.test.ts` (`an incomplete escape prefix at a chunk boundary is ignored`).
- **Linux:** **degraded conditionally** with split terminal/SSH/PTY reads. `ESC [` at one chunk's end is discarded; `B` in the next chunk becomes `char`, not Down. A lone ESC starts a 50 ms timeout, but `[`/`B` continuation is not assembled into an arrow. Complete CSI/SS3 arrows, Enter CR/LF and Ctrl-C work.
- **Windows:** **the same conditional degradation** with split ConPTY/TTY reads or extended key sequences; classic console encodings not translated to these sequences cannot navigate. **Also affects macOS**: chunks are not keys on any OS.
- **How known:** CR; LR current complete-key/scripted fragmentation contract tests passed. That green test intentionally accepting ignored prefixes is not proof of lossless arrow parsing.
- **Severity:** **medium usability** (lost navigation or unintended Escape cancellation), not a provider/store failure.
- **Fix shape:** a stateful incremental key decoder with bounded pending-prefix storage and a true lone-Escape timeout; add split-at-every-byte CSI/SS3 cases. Changing the existing “ignored prefix” expectation would be a documented behavior-contract change, not merely a test cleanup.

#### F21 — Browser launching depends on platform desktop helpers; Windows takes a command-interpreter path

- **Locations:** `src/auth-menu/login.ts:45–66,91–114`.
- **Linux:** **works** with a functioning `xdg-open` desktop setup; **degraded** on headless/minimal installations or timeout/nonzero exit. The function returns false, aborts the browser flow and switches to provider-supplied device authorization, printing the URL. A zero exit is not proof a browser actually appeared; it can remain waiting for sign-in.
- **Windows:** **works in the normal cmd/start case**, but **degraded or unsafe conditionally** for URLs containing command-interpreter metacharacters/expansions. Passing an argument array to `execFileSync` does not make an explicit `cmd /c start` invocation shell-free. In particular percent-encoded URLs and `&` query separators need correct handling; no URL-scheme validation or dedicated cmd escaping is shown here. Opener failure falls back to device flow just as on Linux.
- **How known:** CR, including the existing Windows branch; LR menu device-fallback tests passed using injected openers, **not** a real xdg-open/browser/cmd launch. Actual Windows parsing/security impact remains untested; this is not a claim a particular provider currently supplies an exploit URL.
- **Severity:** **low Linux headless usability**; **medium Windows usability / high if untrusted URLs can reach cmd**.
- **Fix shape:** validate allowed URL schemes and use a proven platform browser-open capability without command injection/expansion; preserve printed URLs, abort/fallback and timeouts. Qualify real desktop and headless Linux, and Windows URLs with spaces, `&`, `%`, quotes and non-ASCII characters.

## Coverage matrix: every exported subpath

Shared risks above are cross-referenced rather than counted again. “No additional defect” means no extra OS-specific branch/primitive was found in this snapshot, not certification of every plugin/host.

| Export | Relevant implementation / Linux behavior | Windows behavior and remaining boundary |
| --- | --- | --- |
| `./fs` | `refresh-file-lock.ts:178–207`: `wx` (`O_CREAT|O_EXCL`) acquisition works; `:155–176` rename renewal; `:246–290` directory eviction marker; `:215–228` fallback mtime. LR lock tests and Node probes passed. `atomic-write.ts:22–39` same-directory exclusive staging works. | `CREATE_NEW` is the native exclusive-create equivalent and normally works; not a POSIX-only operation. Rename/cleanup, privacy and age risks F01–F04. Legacy directory-owner read fallback is `:145–153` on `EISDIR`; it was not qualified against Windows Bun error mappings. No unsupported errno was assumed as a confirmed defect. |
| `./rpc` | `rpc-server.ts:338–346` binds ephemeral IPv4 loopback, publishes port/token/PID, and has bounded stop handling. `port-file.ts:29–41` excludes invalid/group PIDs and treats EPERM as alive. Bun wire/lifecycle tests and Node direct apply worked. | Node documents **signal 0 as a platform-independent liveness probe**; it does **not** terminate the Windows target. Do not replace it merely because normal POSIX signals are absent. Access-denied EPERM is already handled; other probe errors mean dead and may remove a live file, so actual Bun/Windows errno qualification is needed, not an invented blanket refusal. F01/F02/F06/F07. |
| `./rpc/client` | `rpc-client.ts:117–148` uses raw `node:net` HTTP/1.0, loopback only, CRLF, byte Content-Length and Bearer auth. It bypasses HTTP proxy environment variables; LR Bun proxy tests and Node direct request passed. | TCP/Winsock equivalent works in principle; no curl, Unix socket or shell. Response limits, EOF/Content-Length parsing and failures are runtime/wire concerns, not Windows-specific. Failure falls back to `[]` / generic apply failure rather than crashing the host. F01/F02/F06/F07; Node 24 proxy-specific regression was not run successfully. |
| `./sidebar-file` | `sidebar-file.ts:105–268` is persistence, not a watcher. It re-reads raw bytes, uses the lease and atomic helper, checks after publication, and optionally repairs a lost write. LR tests passed. | Same algorithm; F01/F02/F03 propagate. Read catches missing/error and returns defaults (`:128–133`), so ACL/read failure may appear as empty state; write rejects apart from best-effort parent chmod. No inode dependency here. |
| `./tui-prefs` | `tui-preferences.ts:87–108` JSONC edits with lease/atomic publication; `watcher.ts:131–160` directory watch plus 1 s stat probe. LR passed. | F01/F02/F03/F05/F06. Native watch absence is polling, not “does nothing”; a metadata collision can still make polling silently miss an update. Read errors return `{}` (`tui-preferences.ts:15–23`). |
| `./logger` | `engine.ts:101–116` rotates by rename at **5 MiB**, keeps **3** backups (`:19–20`), then chmods; `:179–201` appends. LR rotation tests passed. | Rename-over normally supported, with F02 sharing failures silently caught; privacy F01. No retained open handle inside the logger. Missing parent/unconfigured/sink-only semantics are identical across OSes, not Windows-only failures; caller configures the path. |
| `./store` | `mutate.ts:345–359` and `settings.ts:171` use the common atomic writer; store/row/refresh leases come through `refresh-lock.ts:59–141`. Torn stamps/order protect process-crash intermediates. LR store/crash tests passed. | F01/F02/F03/F04. POSIX mode isn't credential ACL security, and neither rename nor close implies fsync durability. No `fsync` hidden in a store-only persistence layer. AsyncLocalStorage reentry guard (`hooks.ts:9–20`) is available on qualified Node/Bun runtimes, not OS-specific. |
| `./claustrum` | Explicit connection path; host-relative token/state paths; owner/private ancestor/nofollow checks; real peer token writer. LR mock transport and enrollment tests passed. | F01–F03 and F08–F13. Enrollment is the clearest functional blocker; not an absent Unix socket. Roster writes (`roster.ts:510–524`) use the common lease/atomic helper. Pure custody/host-slot/interlock logic adds no extra OS primitive. |
| `./dump` | `index.ts:571–687` exclusive 0600 request artifact writes; `:332–358` staged response replacement; `:235–325` lstat/symlink-aware best-effort sweep. LR dump suite passed. Timestamp colons are removed (`:581`) and session/channel/phase segments sanitized (`:364–370`). | Filenames already avoid ordinary Windows invalid characters; no demonstrated default filename blocker. F01/F02/F03/F04. Failure returns undefined or retains files, not a host crash; sweep refuses a symlinked directory. Windows reparse/junction and sharing behavior needs qualification. |
| `./cachekeep` | `manager.ts:366–375` intervals/unref; `:572–575` AbortSignal timeout/any; injected send, body, usage and quota adapters. LR tests passed. | No filesystem/process/shell branch; same JS/Web API behavior at a qualified runtime level. `window.ts:34–44` uses **local hour**, so a UTC Linux server and a desktop Windows/macOS timezone can warm at different UTC times by configuration, not an OS bug. No fix unless the product wants an explicit timezone. |
| `./tui-build` | Portable slash rewriting/shared naming; Bun transpilation; Solid transform; npm publish list. LR build/reproducibility/linking/publish-list tests passed. | F14–F16; native dependencies/OpenTUI host availability were not certified. `loadSolidTransform` already uses `pathToFileURL` for its resolved fallback (`build-tui.ts:55–59`). |
| `./tui` | Host-module probe then raw/runtime selector; Bun fallback passed, direct Node rejected unsupported scheme. | F17/F18. No native OS-specific TUI implementation is shipped here; raw artifact JSX/OpenTUI execution belongs to the host/toolchain. |
| `./opencode2` | `install.ts:123–154` Web Streams; header edits, SSE/WS hooks and injected adapters; SDK imports are type-only. LR fake-host/transport tests passed. | No macOS syscall/TTY/path dependency in the hooks themselves; equivalent JS/Web APIs in Node/Bun. Real placement/redirect and native host packages remain unverified here. Store/Claustrum/TUI dependencies propagate their listed risks when used by the plugin. |
| `./commands` | Command registry/menu/model/seam and injected actions; Pi adapter delegates UI (`pi.ts:18–27,152–245`); LR command suite passed. | No shell/raw-stdin implementation here. Host UI and underlying store/RPC/Claustrum actions carry their own boundaries. No additional direct OS defect found. |
| `./auth-menu` | Injected terminal or process stdin/stdout; raw selector, ANSI, account actions and platform opener; LR scripted tests passed. | F19–F21. Existing `win32` browser branch is real support code, not absent support; actual terminals and opener must be qualified. |
| `./quota` | Codec/map/merge/projection are pure data/Date operations (`projection.ts:172,193` parse reset times); LR tests passed. | Works in principle with the same runtime; no filesystem/TTY/native OS branch. Providers must give unambiguous ISO timestamps including an offset; timezone-less dates could differ by host timezone on any OS. No additional OS blocker found. |
| `./routing` | Ordered/sticky/admission/pins are pure selection and supplied-clock data (`sticky.ts:177` reset parsing); LR tests passed. | Works in principle; no native path/process/TTY branch. No extra OS blocker. Claustrum roster ordering uses default `localeCompare` (`roster.ts:196,252,308,834`), so locale/ICU differences can change tie ordering across environments; that is not a routing module OS-specific syscall failure. |

### Requested lock details that are not defects at this base

- **`link`: not used by the shipped lease lock.** `src/fs/refresh-file-lock.ts:2–10` imports no link function, and acquisition `:178–207` writes the lease with `wx`. Old experiments under `research/kernel-lock/` are not exported runtime code. Linux hardlinks and Windows NTFS hardlinks are real equivalents, but neither is a runtime requirement of this lock at this base.
- **`O_EXCL`: present and portable on local supported filesystems.** Node translates exclusive create to `CreateFileW(... CREATE_NEW ...)` on Windows. Network-filesystem guarantees must be scoped, not inferred from a macOS-only test.
- **Rename-over: implemented, not universally broken on Windows.** Destination/source share permissions and actual filesystem determine F02. Keeping staging next to the destination avoids an ordinary cross-device atomic-write failure.
- **Eviction marker: a directory plus exclusive `owner.json`, not an advisory flock.** Directory creation owns the marker; stale recovery renames it to a UUID path. The explicit ENOENT/Linux versus EINVAL/ENOTDIR/APFS race classifier is already present at `refresh-file-lock.ts:17–24`; Linux race tests passed. It does not establish Windows Bun's complete error vocabulary.
- **mtime: fallback/marker aging, not the normal sole lease proof.** Owner UUID and `expiresAt` drive `assertOwned` (`:498–525`). Timing/metadata risks do not justify deleting those fences.
- **0600: real Unix secrecy, not a Windows ACL implementation.** This is F01, and relaxing F08 without resolving F01/F09/F10 is not support.

## Platform features and equivalents

| Required feature | macOS baseline | Linux equivalent | Windows equivalent / qualification |
| --- | --- | --- | --- |
| File/path/module APIs | Node/Bun ESM, `node:fs/path/url/module` | Same APIs; normally case-sensitive native filesystem paths | Same APIs; drive/UNC/case rules; filesystem paths must become file URLs for default ESM import |
| Exclusive create / directory marker | `O_CREAT|O_EXCL`, mkdir | Same POSIX calls; qualify network mounts | `CreateFileW` `CREATE_NEW`, `CreateDirectoryW`; preserve collision/ownership rules |
| Hard link | APFS/HFS link | link(2), same-volume filesystem support | NTFS hardlinks/CreateHardLink; **not currently used** by this library's lock |
| Atomic replace / delete | same-volume rename/unlink; old open inode survives | rename/unlink; old open inode survives | Node/libuv replace operation over Windows rename primitives; delete-sharing restrictions and bounded retry needed |
| Private file and directory | 0600/0700 with POSIX UID/GID semantics | 0600/0700, effective UID/GID, filesystem ACL considerations | Current-user SID, owner/security descriptor and DACL; chmod/mode is not equivalent |
| No-follow secure read | `O_NOFOLLOW` + descriptor stat | Same; available and LR exercised | Reparse-point-aware handle opening/verification; no `O_NOFOLLOW` in documented Node Windows flags |
| File and publication durability | file sync and appropriate directory/publication flush; device caveats | fsync/fdatasync + directory fsync where supported | FlushFileBuffers and replacement/publication durability semantics; portable directory fsync cannot be assumed |
| File metadata identity/time | dev/ino + platform-precision mtime | stat/fstat device/inode; precision/mount-dependent | Volume/file ID exposed through runtime stat where supported; numbers/coarse or weak metadata require qualification |
| Native directory notification | FSEvents/kqueue | inotify and its watch limits | ReadDirectoryChangesW; moved/deleted-directory semantics differ; existing polling fallback applies |
| Process existence check | `kill(pid, 0)`; EPERM means exists | Same, including zombie/PID-reuse caveats | Node's zero-signal emulation/process-handle query; **zero is documented safe and supported**, unlike graceful Unix signals |
| Graceful terminal cancellation | SIGINT/SIGTERM and raw Ctrl-C bytes | Same PTY/signal behavior | Console Ctrl-C/SIGINT, SIGBREAK/console events; termination is not graceful SIGTERM delivery |
| RPC / Claustrum socket transport | IPv4 loopback `node:http/net` | TCP loopback sockets | TCP/Winsock; no Unix-socket-to-named-pipe conversion needed for inspected transports |
| Secret connection-file discovery | Host chooses actual daemon path; peer HOME/temp support | Host XDG/private state or actual advertised path; UID temp fallback in peer | Host private profile/AppData/advertised path; peer username temp fallback; main library has no default AppData resolver |
| Private group/account identity | Effective UID/GID; local files may omit directory-service users | Local passwd/group and potentially NSS/SSSD/LDAP; local proof has limits | SID/token group and effective-access rules; no POSIX account-file substitute is implemented |
| ANSI/raw keyboard terminal | Unix TTY/PTY and VT | Unix TTY/PTY/SSH and VT | Qualified console/ConPTY/VT runtime, not all legacy terminals or pipes |
| URL opener | `open` | `xdg-open`, or provider device flow when absent | Safe browser association/open API; current code uses cmd/start with parsing caveats |
| Build transpilation / Solid transform | Bun.Transpiler, optional OpenTUI/Solid peer | Bun equivalent, LR tested | Qualified Windows Bun/OpenTUI peers; stock Node has no Bun.Transpiler |
| Host module redirect | Host recognizes `opentui:runtime-module:...` | Same host resolver contract | Same host resolver contract; not supplied by Windows or stock Node |
| Packaging process invocation | npm executable | npm executable, LR tested | npm.cmd or resolved npm JS CLI; Node execFile without shell cannot run the normal command shim |
| JS/Web APIs and scheduling | crypto, AsyncLocalStorage, timers/unref, Buffer, Headers/Response, streams, AbortSignal, Date | Same qualified Bun/Node APIs, LR exercises | Same APIs at qualified runtime versions; timezone/ICU differences are configuration/runtime data, not missing OS primitives |

## What blocks each OS first

### Linux

**No unconditional Linux runtime blocker was found or demonstrated for normal local auth.** The real Bun census ran 1,231 passing tests, and built Node modules performed real locks, atomic writes, watch updates, token reads and raw loopback RPC. The 13 suite failures must remain visible, but Node-24 prerequisites and runner tar limitations must not be mislabeled as a production Linux platform failure.

The **first conditional setup refusal** is Claustrum ancestor validation: a foreign/shared group-writable nonsticky ancestor, or a private group the local account proof cannot establish, prevents storing the pending secret/token. It was observed on the runner's foreign-owned 0775 `test` ancestor, while safe-directory/private-group enrollment passed. For a **stock Node TUI deployment without a host redirect**, the first actual bootstrap rejection is F17's unsupported `opentui:` scheme; F14 separately blocks Node callers doing TS TUI builds. Both are runtime/host-contract gaps shared with macOS, not Linux syscalls to emulate.

### Windows

**The first security blocker is the private-file promise:** mode 0600/0700 does not establish a private Windows DACL (F01). The clearest **first functional blocker is Claustrum enrollment/custody**: ordinary token/state files fail the unconditional owner-only POSIX mode test (F08), and the real peer token writer can refuse writable Windows directory modes because its ancestor check lacks effective Unix identity (F12). Either is enough to prevent a complete supported ceremony; bypassing one can expose the skipped owner/ancestor/nofollow protections (F09/F10/F13).

Resolve that shared-plus-peer permission contract before claiming Windows credential support. Next qualify rename/delete sharing, watcher/metadata identity, npm.cmd packaging, drive/UNC TUI imports and actual ConPTY/host redirect behavior. **`process.kill(pid, 0)`, exclusive `wx` creation and raw loopback TCP are not themselves blanket Windows blockers.** Windows still needs a real Node-and-Bun qualification run; this code-read census is not that certification.

## Platform documentation consulted

The Node 22 documentation was read during this census (the documentation endpoint identifies its current v22 revision, not necessarily the runner's exact patch):

- [fs file modes](https://nodejs.org/docs/latest-v22.x/api/fs.html#file-modes): Windows only write permission; owner/group/other distinction not implemented.
- [fs open constants](https://nodejs.org/docs/latest-v22.x/api/fs.html#file-open-constants) and [filesystem flags](https://nodejs.org/docs/latest-v22.x/api/fs.html#file-system-flags): Windows supported flags and `O_EXCL` → `CREATE_NEW`.
- [fs watch caveats](https://nodejs.org/docs/latest-v22.x/api/fs.html#caveats): native backend, moved/deleted Windows directory, Linux/macOS inode watches and null filename.
- [stat time values](https://nodejs.org/docs/latest-v22.x/api/fs.html#stat-time-values): platform-specific timestamp precision.
- [process signal events](https://nodejs.org/docs/latest-v22.x/api/process.html#signal-events), [kill](https://nodejs.org/docs/latest-v22.x/api/process.html#processkillpid-signal) and [geteuid](https://nodejs.org/docs/latest-v22.x/api/process.html#processgeteuid): signal 0 is platform-independent; effective UID API is POSIX-only.
- [Windows .cmd spawning](https://nodejs.org/docs/latest-v22.x/api/child_process.html#spawning-bat-and-cmd-files-on-windows): `.cmd` cannot be launched by Node execFile without the appropriate interpreter/CLI invocation.
