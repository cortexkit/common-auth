# Standing rules for workers

Standing rules for workers. Anything not listed here comes to the supervising engineering agent (the head) as a question.

## Build and test
- Run builds and test suites on the build server using the AFT bash tool's `runon` option (`"linux,16c,net"` for the gate and whole suites, `"linux,4c"` for this package's targeted checks). Run on the Mac only what needs macOS, the fast gate, or what the build server can't install (an unpublished candidate tarball). In that case run one suite at a time.
- Before delivering, run `scripts/gate.sh` remotely and report its final line. `scripts/gate.sh --fast` runs the seconds-long checks locally; run it before every commit.
- Use Bun 1.4.4 (the newest CI matrix entry) and Node 24 for the full gate. The fast gate needs Bun 1.4.4. Install dependencies with `bun install --frozen-lockfile`. `bun run build` checks local dependency paths and installed ranges, emits `dist` with TypeScript, then checks that private-files stays a lazy external import. `bun run typecheck` checks both the package and redaction type tests. The full gate also runs the Claustrum 0.6.2 and OpenTUI 0.5.11 compatibility recipes in temporary copies, the full suite, OpenCode 2 placement, and the Linux npm-host setup smoke test.
- This repository has one package. Its public surface is used by three plugins; name any change to an exported type or behaviour in the report.
- Show each fix's test failing without the fix (revert the fix, run the test, restore it), and quote the failure line in the report.
- Windows runs in CI only. If a change touches file permissions, locks, paths or process spawning, say so in the report, so the head runs the Windows workflow before merging.

## Report-only tasks
- A task that only writes a report under `.cortexkit/internal-docs/` changes no product code: skip the gate, commit nothing, and deliver with the existing HEAD. The report reaches the head when the task is settled.

## Pre-approved (do it, then report it)
- Regenerate `bun.lock` after a manifest change you were asked to make.
- Add test seams and test-only helpers, kept out of the published types.
- Format with Biome, and fix lint in files you touch.
- Update docs and comments that describe behaviour you changed.
- Fix a test whose expectation contradicts the brief, and say why in the report.
- Merge `main` into your branch when it moved, keeping both sides.

## Never
- Loosen an assertion, skip a test, or raise a timeout without timing evidence for each phase showing where the time goes.
- Commit a candidate tarball path, or force-add anything under `.cortexkit/` other than this file.
- Read or write the operator's real config, OpenCode or Pi folders, or vault. Tests use temporary homes.
- Push, tag, publish, or post on GitHub.
- Change these without asking: user-visible wording beyond the brief, config keys, stored formats or migrations, what reaches a provider or the vault, security boundaries.

## Comments
Explain the reason for a reader with no context. No task ids, internal planning labels or references to this conversation.
