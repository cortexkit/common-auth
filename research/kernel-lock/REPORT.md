# Kernel file-lock feasibility spike

## Decision and scope

**Feasible on the measured macOS arm64 host:** use one plain-C Node-API v8 adapter, `flock(LOCK_EX | LOCK_NB)` on POSIX, and a separate `LockFileEx` implementation on Windows. Keep a stable, dedicated sidecar for each logical target; never unlink, rotate, or rename it. Hold the handle across read → merge → stage → atomic **data** rename. Close on unsuccessful acquire, unlock/close on success, and never steal from a paused owner. This is research, not a replacement of `src/fs` and not a distributable production binary.

**Measured guarantees below are local to this host/filesystem and these versions.** Linux, Windows, NFS/SMB, additional macOS versions, packaged OpenCode installation, worker-thread teardown, and production releases are not validated here. The observations prove cooperating processes exclude each other; they do not protect against writers that ignore the sidecar, hostile pathname replacement, power loss, or a filesystem that loses its locks.

Environment: Darwin 27.0.0 arm64, Apple clang 21.0.0, Node **v24.16.0**, Bun **1.3.14**, Bun **1.4.2**. `results/environment.json` has the full kernel string and executable paths; each probe records its loaded worker runtime. The orchestrator used Node v26.7.0, but every lock-holding/contending worker used a pinned runtime, not the orchestrator. Scratch files were on the host's local `/var/folders/...` volume (filesystem type was not independently measured).

## Primitive comparison: measurements, not assumptions

`primitives.c` independently opens a file twice, tries an exclusive nonblocking lock on both, spawns a child that opens it independently, then opens/closes a **third, unrelated descriptor for that same file** and repeats the child's attempt. The original descriptors stay open during that close. Raw: `results/primitives.jsonl`.

| Primitive | First open acquired | Second independent open in same process acquired | Child acquired before unrelated close | Child acquired after unrelated close |
|---|---|---|---|---|
| flock | yes | **no** | no | **no** |
| classic fcntl F_SETLK | yes | **yes** | no | **yes** |
| lockf F_TLOCK, one byte | yes | **yes** | no | **yes** |
| F_OFD_SETLK, one byte | yes | **no** | no | **no** |

All four were actually runnable here. **The premise that macOS has no OFD locks is false for this machine.** Apple's XNU header defines `F_OFD_SETLK=90`, `F_OFD_SETLKW=91`, `F_OFD_GETLK=92`, and its kernel handles them with `F_OFD_LOCK`. Definitions occur in public `xnu-3248.60.10` but not `xnu-2782.1.97`; this brackets source history, not an independently verified minimum supported macOS release. Linux uses its own constants; never hardcode Apple's value on Linux.

Choose **flock for both macOS and Linux**, rather than exposing multiple runtime-selectable primitive families that may not interact. OFD is viable on this host and Linux >=3.15 but adds a minimum-version/feature-test question without a benefit for whole-sidecar locks. Classic fcntl/lockf are rejected: they permit overlapping operations in one process and an unrelated close loses protection. An in-process queue cannot repair the latter if arbitrary code opens/closes the file. If forced to use process locks, every independent addon copy/instance must share a process-global keyed serializer (canonical realpath plus dev/ino), and all fd ownership must be controlled. Aliases, sidecar replacement, separate JS isolates, multiple addon copies and code outside that serializer remain hazards. No JS serializer is required for independent-open flock exclusion on this host; each operation must open independently, not `dup` a shared descriptor.

### Fork and network semantics (measurement versus documentation)

`fork.c` measures parent close while child retains an inherited descriptor: another open in the child remains busy; child `LOCK_UN` releases the inherited lock and another open then acquires. All three booleans in `results/fork.json` are true. **An inherited descriptor can keep a dead parent's lock alive.** `O_CLOEXEC` in the addon prevents exec inheritance; it does not prevent fork inheritance. Runtime spawned children in the JS probes did not intentionally inherit the addon fd. A process must not fork while holding a lock unless the child immediately closes its inherited descriptor without calling LOCK_UN (which would also release the parent's lock).

Documented, not measured on Linux: flock is open-file-description owned; duplicates/fork share ownership, last close releases, independent opens compete. Linux local flock and classic fcntl do not interact. OFD ownership also avoids the any-close hazard and supports independent-open exclusion. Classic fcntl locks are process owned and not inherited as locks through fork.

**No network-filesystem safety promise.** On Linux NFS, flock can be emulated as whole-file fcntl locking (exclusive locks require a writable fd); `nolock`/`local_lock` mount options can make exclusion client-local. Server restarts/partitions can lose locks. SMB behavior and advisory/mandatory effects differ by kernel/server. Before accepting cross-host stores, measure the actual OS, filesystem, mount options and server recovery behavior. Prefer explicitly supported local filesystems; reject or clearly declare unsupported network storage rather than advertise the local results as distributed fencing.

## Adapter and reproduction

Sources: `addon.c`, `worker.mjs` (bounded polling with AbortSignal), `run.mjs`, `primitives.c`, `fork.c`, `bundle-probe.mjs`, `triple-probe.mjs`, `build.sh`. The small `lock.node` is the **experimental macOS arm64 build** and must not be copied into production. `runtimes.json` contains local executable paths, not a portable install configuration.

Plain C with `node_api.h` was chosen over node-addon-api/napi-rs to need no additional package dependency, C++ wrapper or Rust toolchain for this small experiment. Build uses `NAPI_VERSION=8`; runtime loading worked across all three pinned runtimes with the same bytes. No runtime-specific recompilation. Headers came from the installed Homebrew Node, not Node 24 headers; a production build should pin the Node-API headers/toolchain and test against the minimum runtime.

```sh
sh research/kernel-lock/build.sh /opt/homebrew/include/node
# Set the three executable paths in research/kernel-lock/runtimes.json first.
node research/kernel-lock/run.mjs
node research/kernel-lock/bundle-probe.mjs
node research/kernel-lock/triple-probe.mjs
```

`tryLock(path)` opens `O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW`, mode 0600, and returns an opaque external handle or null for EAGAIN/EWOULDBLOCK. Busy opens are immediately closed. `unlock(handle)` explicitly unlocks/closes and is idempotent. A finalizer closes an abandoned fd, but **GC is not a release strategy**: callers must use finally. Polling calls are short synchronous syscalls; no blocking kernel wait on the event loop. The JS wrapper checks deadline and signal and uses a 5 ms retry timer. The timer removes its abort listener on completion or abort. Production needs stronger argument/type validation (external handle branding), regular-file validation, secure parent ownership/path handling, cleanup hooks for isolate teardown, precise error kinds, and race semantics for abort arriving at acquisition. An arbitrary foreign N-API external must not be accepted as a lock handle in the final API. Windows is not implemented in this C file.

Runtime discovery: the repo's RPC regression test tries `mise where node@24`, then a version-checked PATH Node. Here PATH was Node 26; Node 24.16 was provisioned with `npx --yes --package=node@24.16.0 node --version` and the resulting cached executable was explicitly version-checked. Bun 1.3.14 was already in the npm cache; Bun 1.4.2 was installed on PATH. No manifests, dependencies, lockfile or CI were modified.

## Probe results (final run)

Every directed pair of distinct pinned runtimes was run, including both Bun versions against each other. An additional `triple-probe.mjs` run placed all three runtimes on the same sidecar: each took a turn as holder while both other runtimes attempted concurrently (both busy); after release, both raced and exactly one acquired. Three holder rotations and nine assertions passed; raw `results/triple-exclusion.json`. `results/pair-*.json` records ready messages, the initial busy result, each timestamped paused attempt, resume-before-release busy, abort attempts/fd counts, post-release success and post-kill success. SIGSTOP lasted at least 600 ms; the harness sampled repeatedly every approximately 20 ms. This measures sampled exclusion throughout the pause, not a continuous syscall trace.

| Holder → contender | Busy samples while stopped | SIGKILL → acquire ms | Abort min–max ms (20 ms requested) | Numeric fd count before/after | 40 ms bounded wait observed ms |
|---|---:|---:|---:|---:|---:|
| Node 24.16 → Bun 1.3.14 | 27 | 3.523 | 20.14–25.60 | 7 / 7 | 43.08 |
| Node 24.16 → Bun 1.4.2 | 29 | 3.351 | 20.09–20.76 | 7 / 7 | 44.57 |
| Bun 1.3.14 → Node 24.16 | 29 | 2.662 | 19.13–25.46 | 18 / 18 | 41.49 |
| Bun 1.3.14 → Bun 1.4.2 | 29 | 2.754 | 20.11–20.54 | 7 / 7 | 45.13 |
| Bun 1.4.2 → Node 24.16 | 29 | 2.504 | 19.61–21.32 | 18 / 18 | 40.82 |
| Bun 1.4.2 → Bun 1.3.14 | 28 | 3.959 | 20.14–24.42 | 7 / 7 | 41.03 |

All initial contenders busy; all attempts after SIGCONT **before** release busy; all post-release acquisitions succeeded. All post-kill acquisitions succeeded, with approximately 2 ms retry resolution plus IPC overhead (latency is not a kernel-only measurement). Abort had 20/20 AbortErrors per pair, 120 total, no observed numeric-fd growth using `/usr/sbin/lsof` after warmup. Bounded wait ended with busy, not a fallback. This does not prove listener/heap cleanup over unlimited repetitions.

Each counter update reads one integer, increments it once, and atomically replaces the data file; the expected total is processes multiplied by rounds per process.

| Protocol counter group | Processes × rounds | Expected / actual | Elapsed ms |
|---|---:|---:|---:|
| Node 24.16 only | 4 × 150 | 600 / 600 | 2881.90 |
| Bun 1.3.14 only | 4 × 150 | 600 / 600 | 1676.59 |
| Bun 1.4.2 only | 4 × 150 | 600 / 600 | 1625.17 |
| **All three mixed on one path** | 6 × 150 (2 each) | **900 / 900** | 4014.14 |

Total 2700 full-protocol updates, with a deliberate 1 ms pause after reading to increase overlap. Read, increment, write unique temp and rename all happen while held. Sidecar inode before/after matched for every worker. Separate `same-*.json` runs in each runtime verified second independent handle busy, busy after unrelated same-file fd close, and busy even after data rename. No durability/fsync or transaction-crash recovery assertion is made.

Final lifecycle/counter harness: **50 assertions passed**, six pair runs and four counter runs; separate triple-runtime exclusion probe: **9 assertions passed**. Raw final files are at `results/`; `results/intermediate-run/` retains the complete preceding successful run recovered from staged observations, also summarized in `intermediate-run-summary.json`. `initial-run-failure.json` explains an earlier harness ENOENT and its correction (precreate sidecar before measuring its inode). Limitation: the initial failed run's individual pair files were overwritten before archival; only its failure summary remains. Final and intermediate successful observations and mutation observations are retained; use the complete final run for claims.

### Non-vacuity control

Disabled the addon's kernel acquire with `NON-VACUITY BREAK`, rebuilt the same binary and ran the harness with separate mutation output. **`same-process-exclusion-node24` failed**, with both independent handles acquired and a third attempt also acquired after an unrelated descriptor for the same file was closed. No other test failed; later assertions were not reached because the harness stops on its first failure. The staged source was restored; diff went from `addon.c | 2 +-; 1 insertion, 1 deletion` to empty. Rebuilt real addon; final 50 assertions passed. `results/mutation-output.txt` and `results/mutation/same-node24.json` retain the negative evidence. This single control shows the harness reaches the native acquire; it is not a separate mutation proof for every lifecycle behavior.

## Linux x64 rerun (ext4)

The same sources, unchanged apart from portable build flags and a `/proc/self/fd` descriptor count, were rerun on Ubuntu 24.04 (Linux 6.8.0, x86_64, glibc 2.39, gcc 13.3, ext4) with Node 24.16.0, Bun 1.3.14 and Bun 1.4.2 (official linux-x64 builds). Raw results: `results-linux-x64/` (`environment.txt` records the host).

- Primitive table: identical to macOS. flock and F_OFD_SETLK refuse a second independent open in one process and stay held after an unrelated descriptor is closed; classic fcntl and lockf fail both.
- Fork: identical (an inherited descriptor keeps the lock; its `LOCK_UN` releases it).
- Lifecycle harness: 50/50 assertions. All six directed runtime pairs: every sample busy while the holder was stopped (29-30 per pair); SIGKILL → acquire 2.4-5.4 ms; 20/20 aborts per pair at ~20 ms.
- Counters: Node 600/600, Bun 1.3.14 600/600, Bun 1.4.2 600/600, all three mixed 900/900.
- Triple-runtime probe 9/9; bundled-dist loader experiment 6/6.

Still unmeasured: linux arm64, musl, Windows, network filesystems, a real OpenCode install, published platform packages.

## Packaging recommendation (unmeasured release design, measured loader experiment)

**Recommend a separate `@cortexkit/file-lock` runtime dependency**, external to all plugin bundles, whose JS loader selects exactly one per-platform optional dependency with exactly the same version as the adapter package. common-auth's bundled JS imports that package; **each consuming plugin must list it as a direct runtime dependency**, not rely on common-auth's now-eliminated package dependency graph. Configure both Bun/esbuild bundling to leave the package external. The adapter package owns `createRequire(import.meta.url)`/its CJS loader, platform mapping and error reporting. Runtime binary resolution is anchored to the installed adapter package, not a bundled common-auth source path or cwd.

Evidence from real package implementations:

* [`@parcel/watcher` v2.6.0 loader](https://github.com/parcel-bundler/watcher/blob/v2.6.0/index.js) chooses platform/arch/libc optional packages. [Installation issue #151](https://github.com/parcel-bundler/watcher/issues/151) demonstrates missing binaries remain an operational failure to handle.
* [esbuild v0.25.0 package metadata](https://github.com/evanw/esbuild/blob/v0.25.0/npm/esbuild/package.json) and [platform loader](https://github.com/evanw/esbuild/blob/v0.25.0/lib/npm/node-platform.ts) use platform packages, explicit mapping, resolution and actionable diagnostics. esbuild ships an executable, not an N-API addon; its distribution structure, not its ABI, is the precedent.
* [napi-rs node-rs helper](https://github.com/napi-rs/node-rs/blob/main/packages/helper/src/loader.ts) resolves local binaries/platform candidates and reports resolution failures. Rust brings cross-compilation machinery but is unnecessary for this tiny C adapter.
* [`node-gyp-build`](https://github.com/prebuild/node-gyp-build/blob/master/README.md) + prebuildify use package-local `prebuilds` with runtime/ABI tags. Alternative: ship all prebuilds in one adapter package (simpler resolution, larger install); do not inline the loader into a plugin without also relocating its assets.

**Measured synthetic deployment experiment:** both Bun 1.3.14 and 1.4.2 built an ESM plugin entry with `--external=@cortexkit/file-lock`. A package-local CJS wrapper required the compiled `.node`; dist lived beside `node_modules`. All three pinned runtimes loaded each bundle and independently demonstrated exclusion: **6/6** checks in `results/bundle.json`. This validates ordinary installed-package resolution from bundled dist under these Bun versions, not a published platform package, optionalDependency pruning, an actual OpenCode install, esbuild bundling, npm provenance, or single-executable Bun embedding. Those need integration tests before 0.9.0.

Alternatives/costs:

1. All prebuilds inside the separate adapter via prebuildify/node-gyp-build: avoids optional-dependency omission and version skew, but every install downloads every platform and loader remains external.
2. Each plugin copies binary assets next to dist and preserves `import.meta.url` lookup: no runtime dependency, but all three publishers duplicate platform selection/artifact updates, larger tarballs, and bundling can change relative paths. Test npm-packed artifacts, not source layouts.
3. Source compilation at install time: compiler/SDK/Python/node-gyp requirements make this a poor default for authentication plugins; Bun may also block dependency install scripts unless explicitly trusted, leaving compilation unrun. Offer only an explicit maintainer path, not implicit recovery.

Minimum binary matrix: darwin arm64/x64; linux x64/arm64 **each glibc and musl**; win32 x64 (7 artifacts). Node-API stability removes per-Node-major recompilation, not OS/architecture/libc requirements. CI should build on macOS hosts for each architecture, Linux glibc/musl toolchains, and Windows MSVC; run pinned Node/Bun load and exclusion tests where runtime support exists. Linux musl compatibility and Bun's runtime platform coverage need dedicated jobs. Publish platform packages first at identical immutable versions, then publish loader; assert packed contents, sizes/checksums, optional dependency metadata, license/SBOM and release manifests. Use pinned actions/toolchains, npm trusted publishing/OIDC provenance for **each** artifact package, least-privilege release credentials, and a signed release manifest tying hashes to source commit/toolchain. Evaluate macOS code-signing/Windows Authenticode requirements on installed npm addons; no signing was measured. Never sign/publish this locally built research artifact as a release.

**Missing/unsupported binary: fail closed before entering the critical section**, with platform/arch/libc, attempted package, adapter version, loader error cause and remediation. Busy is distinct from unsupported/load failure. No silent lease fallback. An explicit escape hatch using the old TTL lease remains unsafe if it shares targets with kernel-lock clients, because the two modes do not exclude one another: require separate storage namespaces and disclose that stalled legacy owners can still overlap, or omit it. Recommended default: no fallback for shared auth/TUI state.

## Windows design — entirely unmeasured

Use `CreateFileW` on a stable sidecar with read/write access, `OPEN_ALWAYS`, no inherited handle; allow read/write sharing so contenders can open it, **deny delete sharing** to impede sidecar replacement. Reject directories/reparse points under a defined secure-path policy. Use `LockFileEx(LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY)` for byte range [0,1) with initialized `OVERLAPPED` offset zero. Map `ERROR_LOCK_VIOLATION` to busy; other errors fail closed. Decide synchronous versus overlapped handle mode explicitly and handle `ERROR_IO_PENDING` correctly if enabling overlapped I/O; do not block the JS event loop. Unlock the identical range via `UnlockFileEx`, then `CloseHandle`; deterministic cleanup on normal exit and environment teardown.

Microsoft documents exclusion even for a separately opened handle from the same process; inherited handles do not confer access to the locked bytes. Exclusive byte-range locks prevent ordinary reads/writes to those bytes (mandatory in that sense), not mapped-view access. The byte is on the sidecar, so data access is still cooperative/advisory with respect to the protocol. Closing/owner termination releases locks, but cleanup can be delayed: no fixed latency claim like the local SIGKILL numbers. No Windows binary, compilation, load, mandatory-lock, abort, inheritance or crash test was run.

## Migration: no safe transparent overlap with legacy lease owners

Old plugins do not inspect a new kernel sidecar. They can remain live and stall beyond TTL; a newer writer cannot infer death from expiry. The TUI-preferences target is shared across providers, so upgrading only one plugin is insufficient.

| Option | Failure left behind |
|---|---|
| New sidecar only | Old and new can both write simultaneously. Reject. |
| Check for a live legacy lease then acquire kernel lock | Check/create race; expired paused owner resumes. Reject as an exclusion guarantee. |
| Hold legacy lease **and** kernel lock during transition | Helps healthy old clients, but the new owner may stall past renewal and an old client steals; or an already-expired old holder resumes during a new transaction. Neither lock stops a paused old lease owner from resuming and writing during a new transaction. |
| Migration marker/new format in old lease path | Already-running legacy code does not honor the marker; old stale-record recovery may replace it. Only useful with a patched bridge version understood by all participants. |
| New data namespace/schema | Old writes do not race new data, but creates diverging user state and requires explicit import and downgrade rules. Viable only if divergence is accepted. |
| Coordinated cutover with all old writers stopped | Operational coordination cost; only safe same-data option without changing old clients. |

**Recommend coordinated cutover**: stop OpenCode/Pi and all three old plugin writers, verify/drain operationally (not by TTL), upgrade every participant, then create/use a distinct stable `*.kernel-lock` sidecar. Leave old lease records inert or archive only while quiescent; never use the old lease inode as the kernel sidecar since old clients may rename it. A durable migration/version marker should record the required kernel-lock protocol version and make *new* clients refuse any version they cannot implement and document that downgrade is prohibited while kernel writers are active. It cannot force old code to obey. A rolling upgrade needs a bridge release which every active writer first adopts and which uses the same stable kernel protocol; unpatched old owners still require draining. No PID/mtime scan is a proof that an arbitrary old process cannot later resume.

## Gates, limits, and questions for 0.9.0

* Clang 21, `-Wall -Wextra -Werror`: addon and two C probes compiled. Final native lifecycle/counter harness 50 assertions, triple-runtime exclusion 9 assertions, bundle experiment 6 checks. The failing output from disabling native acquisition is preserved.
* TypeScript 7.0.2: `bun run build` passed (12 range dependencies checked); `bun run typecheck` passed **after build**. Initial typecheck failed because self-package dist exports did not exist yet, unrelated to research files.
* Biome 2.5.14: lint and format checks passed, 209 files each. Research scripts are not included in that repository coverage; C compilation and direct JS execution are their gates.
* Bun 1.4.2 full repo tests: 1082 pass, 10 skip, one environment failure out of 1093 (Node 24 required but PATH had Node 26). With pinned Node24 prepended to PATH, affected `test/rpc/client-proxy.test.ts` rerun: 2 pass, 0 fail. Original JUnit and rerun are retained. Sources check on the original artifact: 1077 cells parsed / 1076 matched, failed for that same missing passing test. No docs/source rows were changed; spike scripts are outside `test/`.
* AFT inspect: first call interrupted; second completed partially, with no authoritative clangd diagnostics because no compilation database/workspace marker. Clang compilation is the native authority here.

Open spec questions: minimum supported OS/kernel/libc/runtime versions; supported local filesystems and policy for network mounts; secure parent/sidecar ownership and alias identity; exact sidecar naming and backward-compatibility marker; coordinated cutover/downgrade enforcement across all plugins; validation that opaque handles belong to this addon and cleanup when the JS environment is destroyed; raw fork policy; AbortSignal/deadline race semantics; fair polling/backoff and wait defaults; stale temp cleanup without touching sidecars; whether data durability requires fsync of file/directory; error taxonomy and observability; platform-package naming/ownership and libc detection; packed OpenCode/Pi integration tests; release signing/provenance and unsupported-platform experience.

### Semantics sources

* [Apple flock(2)](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/flock.2.html), [Apple fcntl(2)](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fcntl.2.html).
* [Apple current XNU fcntl header](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/fcntl.h), [kernel implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_descrip.c), [xnu-3248.60.10](https://github.com/apple-oss-distributions/xnu/blob/xnu-3248.60.10/bsd/sys/fcntl.h), [xnu-2782.1.97](https://github.com/apple-oss-distributions/xnu/blob/xnu-2782.1.97/bsd/sys/fcntl.h).
* [Linux flock(2)](https://man7.org/linux/man-pages/man2/flock.2.html), [fcntl locking](https://man7.org/linux/man-pages/man2/fcntl_locking.2.html), [NFS mount semantics](https://man7.org/linux/man-pages/man5/nfs.5.html).
* [Microsoft LockFileEx](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-lockfileex).
* [Bun bundler externals](https://bun.com/docs/bundler); [napi-rs bundler tracing issue](https://github.com/napi-rs/node-rs/issues/316).
