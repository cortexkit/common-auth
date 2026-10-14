# common-auth

Shared libraries for the CortexKit auth plugins for OpenCode and Pi: openai-auth, anthropic-auth and antigravity-auth. Published on npm as `@cortexkit/common-auth`; each plugin bundles it at build time, so users never install it directly.

`research/` holds the spike reports that inform the design:

- [OpenCode 2 transport spike](research/opencode2-transport/REPORT.md): can a plugin own the transport on OpenCode 2?
- [OpenCode 2 native-driver spike](research/opencode2-thin/REPORT.md): multi-account support through hooks on OpenCode 2's built-in OpenAI driver.

## Mutation catalogue

A passing safety test proves little until it has been seen to fail. [`mutations.toml`](mutations.toml) is the checked-in catalogue: each row deliberately breaks one guard in `src/` (or a CI scan script) and names the Bun test that must fail because of it, so a guard cannot silently stop guarding. A row earns its place by guarding a silent, costly failure: lock exclusion, crash safety, credential loss or leakage, a single-use token used twice, misattributed quota, a wire contract, data loss. Style and cosmetics do not.

The pinned [`ckdev-mutate`](https://github.com/cortexkit/commons/tree/9d6b663dac487bb982c7bfd18a96eee2292164ad/crates/cortexkit-mutate) runner replays it from a clean tree. It installs and builds first (fixtures import `dist/`), checks each named test passes, applies the break, rebuilds, requires the test to fail, and restores the source byte for byte:

```sh
cargo install --locked --git https://github.com/cortexkit/commons --rev 9d6b663dac487bb982c7bfd18a96eee2292164ad cortexkit-mutate
ckdev-mutate check --strict
ckdev-mutate run --all
ckdev-mutate run --diff origin/main
ckdev-mutate run --only fs-lock-try-once-refuses-held-lock
```

Every row must report CAUGHT. Replay with the Bun version CI pins (1.3.14): the row `rpc-declared-oversize-413-half-closes` guards the RPC server's workaround for Bun 1.3.14 reusing a connection the server refused with 413. Bun 1.4.2 never reuses it, so that row survives there. Rows are command rows: `{test}` is a Bun `-t` filter, a regular expression over the full test name (describe names and test name joined by spaces), so ids are anchored, escaped, and spell each space `\s`. The shared `scripts/list-bun-tests.mjs` asks Bun's JUnit reporter to list every discovered test as skipped with a never-matching selector, then reconstructs full names from nested describe suites and filters them with the row's JavaScript regular expression. It does not duplicate Bun's test-name formatting or run test bodies. `ckdev-mutate check --strict` verifies each active command row's `expect_red` selects a discovered test. CI replays the rows a pull request's diff selects, the full catalogue on every push to main, and the full catalogue with `--broad` nightly. Never `git checkout` a file while a replay runs: it removes the mutation and fakes a survivor.

Licensed under MIT; see [LICENSE](LICENSE).
