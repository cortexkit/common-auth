# @cortexkit/private-files

Version 0.1.0; independent tag prefix **`private-files-v`**. This folder can be moved as a unit. The `@cortexkit/private-files` package has no dependency on common-auth. common-auth's `./private-files` entry only re-exports this package. No existing common-auth persistence call site uses it yet.

## API

```ts
import { createOwnerOnly, verifyOwnerOnly, readOwnerOnly, EXTRA_ACE } from '@cortexkit/private-files'
await createOwnerOnly(absolutePath, { kind: 'file' }) // exclusive, empty creation
const result = await verifyOwnerOnly(absolutePath)
if (!result.ok && result.refusal.reason === EXTRA_ACE) {
  console.error(result.refusal.sid, result.refusal.mask)
}
const bytes = await readOwnerOnly(absolutePath) // verify and read the same opened handle
```

`createOwnerOnly(path, {kind: 'dir'})` creates one directory, not a recursive tree. Creation does not repair an existing object. `createPrivateFile(path, bytes)` combines secure exclusive creation, same-handle verification, and writing; `createPrivateDirectory`, `verifyPrivatePath(path, kind)`, and `securePrivatePath(path, kind)` are also available. `securePrivatePath` explicitly replaces permissions on an existing object owned by the process user; it does not take foreign ownership. Use directory permission replacement only on a dedicated application root: Windows can propagate its inheritable ACE to existing unprotected children. Native errors include a path, `win32Code`, and `reason`, never secret bytes.

`verifyOwnerOnly` returns `{ok: true}` or `{ok: false, refusal: ...}`. Exported string constants are `WRONG_OWNER`, `EXTRA_ACE`, `NOT_PROTECTED`, `NULL_DACL`, `EMPTY_DACL`, `REPARSE_POINT`, `UNSUPPORTED_FILESYSTEM`, and `MODE_REFUSAL`. Wrong-owner includes `ownerSid`; extra-ACE includes `sid` and `mask`. Additional diagnostic refusals are `unsafe-ancestor`, `wrong-kind`, and `io-error`. Filesystem absence/errors are not reported as successful verification.

## Policy and boundaries

Windows creates objects with owner explicitly set to the **process token user SID**, a protected DACL, and exactly one explicit ACCESS_ALLOWED ACE granting that SID FILE_ALL_ACCESS (`0x1f01ff`). Directory ACE flags are OI|CI (`3`); file flags are `0`. No SYSTEM or Administrators ACE is added. Reads accept either the token user or **TokenOwner** as owner for interoperability with Rust writers that use the default owner. Reads also accept one inherited file ACE (`16`) with an unprotected DACL **only when the immediate pinned parent has the canonical protected directory template**. Directories must always be canonical. Null, empty, foreign, denied, conditional, object-specific, and unknown ACEs refuse.

All blocking Win32 calls run in N-API async work. Transactions pin all ancestors without delete sharing, inspect every component for reparse points, and refuse ancestry where ordinary other principals can delete/replace the traversed component or rewrite its owner/DACL. Creation additionally refuses parents where those principals can pre-create the new name. SYSTEM, Administrators, and TrustedInstaller control of OS ancestors is outside this discretionary threat boundary; they are not allowed ACEs on private objects. No ACL verification is cached. Impersonation is unsupported. Classification requests no data rights; if a Win32 open is access-denied, an exact-rights `NtCreateFile` security handle requests only owner-implicit READ_CONTROL. Repair uses READ_CONTROL|WRITE_DAC on that exact-rights path. Neither path requests synchronous native IO options, and classification handles never consume bytes. When a data open fails, the backend may open a separate metadata-only handle and use its descriptor to report a typed ACL refusal. The metadata handle is then closed without reading file bytes, and a failed data open never becomes a successful read.

Only absolute, unambiguous local drive paths on fixed ACL-persisting volumes are supported. UNC/network paths, FAT/exFAT, reparse points, dot/trailing-space components and streams refuse with remediation. Reads are bounded to 64 MiB. Administrators exercising privileges, the same user's other processes, backups and offline access are outside the policy. This primitive is not an atomic replacement/lease implementation; those are later adoption slices.

On POSIX, the package uses ordinary `0600`/`0700` creation and chmod, with normal umask behavior. It does not load native code or require a compiler. Exact-mode checks and existing POSIX call sites remain unchanged.

## Building, distribution, and real proof

Install dev dependencies and run `bun run build` in this folder. On Windows run `./native/build.ps1` with MSVC and the Windows SDK installed. It downloads checksum-verified Node headers/import library, compiles C with N-API v8, `/DELAYLOAD:node.exe` and a host-executable delay hook (the node-gyp convention), and emits `prebuilds/private-files-win32-{x64,arm64}.node`. The loader selects **process.arch**, so x64 Node emulated on ARM64 Windows uses the x64 binary. There is no install-time compilation and no mode fallback when a binary is missing.

The separately named `private-files-prebuilds` CI matrix produces both architectures as artifacts, never checked-in binaries. A distributor assembles both artifacts under `prebuilds/` before packaging; `prepublishOnly` checks their PE architecture and requires node.exe imports to be delayed, not bound to a separate Node image when Bun loads the addon. CI records `dumpbin /imports` and first runs each Bun's one-line addon load in a separate step, so a loader crash is distinguishable from a test failure. No release or publication is performed by the qualification workflow.

The Windows qualification matrix uses Server `windows-latest`, older Server `windows-2022`, and `windows-11-arm`, with Node 24 and Bun 1.3.14/1.4.2. Bun added native Windows ARM64 support in 1.3.10: [setup-bun's change](https://github.com/oven-sh/setup-bun/commit/0ff83bfc51e05dd2251088164ec6a5e8533b476b) and [1.3.14 release notes](https://bun.sh/blog/bun-v1.3.14). Older/unparseable native ARM64 Bun versions receive an explicit refusal. The ARM runner also loads the x64 binary using emulated x64 Node.

Run `./test/windows/run-acl.ps1 -Runtime node` or `./test/windows/run-acl.ps1 -Runtime bun -ExpectedVersion '1.4.2'` **from this folder**, after building TypeScript, the native addon and the Rust fixture. The harness uses independent PowerShell/.NET descriptors, a standard-user probe with a public read control, a standard-user native writer/reader, forbidden ACL/reparse fixtures, migration/rename checks, and disabled-verifier mutation evidence. Descriptor/OS/filesystem/runtime/timing records are written outside build directories to `private-files-evidence/`. Fixtures that cannot be exercised fail rather than skip. The suite gives every test an explicit 120-second timeout under both Node and Bun, covering standard-user profile provisioning rather than relying on Bun's 5-second default. Bun steps also require the exact expected runtime version, so failed setup cannot qualify the previous installation. The wrapper runs Bun through `bun test` and requires exactly 11 passes with no skips/failures for either runtime; the count guard is itself tested by skipping all real assertions and requiring refusal. The Rust fixture pins **crates.io subc-os 0.1.14 and cortexkit-lease 0.1.3**, with its own Cargo.lock, and exercises both protected and inherited Rust-written files. Any rejected Rust ACL is reported verbatim; the reader is not weakened to match it.

Portable tests and the root mutation catalogue establish normalized policy/loader behavior only. Real Windows CI qualifies the tested OS/filesystem/runtime combinations; it is not a claim that mocks prove Windows security or that arbitrary shares are supported.
