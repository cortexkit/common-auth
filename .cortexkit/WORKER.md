# Standing rules for workers

Standing rules for workers. Anything not listed here comes to the supervising engineering agent (the head) as a question.

## Build and test
- Run only the tests for the files and behaviour you changed, by file or by name (`bun test <file> -t <name>`), plus `scripts/gate.sh --fast`, which runs the seconds-long checks locally; run it before every commit. For a bug fix, show one test failing without the fix. Run those filtered tests on the build server with the AFT bash tool's `runon` option (`"linux,4c"`), or on the Mac when they need macOS or something the build server can't install (an unpublished candidate tarball). Windows-only behaviour is checked by the head on GitHub's Windows runners.
- Remote Linux jobs cannot change files git tracks (writes, deletes, `sed -i`, formatter rewrites all fail with "Operation not permitted"). Show a fix failing without it locally, or in a scratch copy under `$TMPDIR`, never by reverting a tracked file inside a job. Regenerate tracked fixtures locally, or name them in `runon` `return_paths`.
- Never run the whole suite or the full gate (`scripts/gate.sh` without `--fast`); the head runs the full gate once over several merged deliveries. If a test outside your change looks broken, rerun only that test by name on the base commit, never the suite. A filtered run that takes more than about 15 minutes means the filter is too broad: narrow it rather than wait.
- For reference, the head's full gate (`linux,8c,net`) requires Node 24 and uses Bun 1.4.4 (the newest CI matrix entry). If Bun on PATH differs or is unavailable, the gate obtains the exact pin with npm under the ignored `target/scratch/gate-tools/` directory and prepends it to PATH; no hand-installed Bun is needed. The fast gate keeps the developer's local Bun and requires 1.4.4 without fetching it. Install dependencies with `bun install --frozen-lockfile`. `bun run build` checks local dependency paths and installed ranges, emits `dist` with TypeScript, then checks that private-files stays a lazy external import. `bun run typecheck` checks both the package and redaction type tests. The full gate also runs the Claustrum 0.6.2 and OpenTUI 0.5.11 compatibility recipes in temporary copies, the full suite, OpenCode 2 placement, and the Linux npm-host setup smoke test.
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
