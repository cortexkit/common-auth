# Codebase Structure

One TypeScript package, published as `@cortexkit/common-auth`. This file is a map; `ARCHITECTURE.md` explains how the parts work. To find a symbol, search the code rather than this document.

## Layout

```text
src/<subpath>/   one folder per export in package.json; index.ts is the export's public surface
test/<subpath>/  tests for that folder; test/setup-env.ts is the test preload
test/windows/    scripts the Windows CI jobs run against real owner-only files and a vault fixture
test/tooling/    tests of the scripts in scripts/
scripts/         gate.sh, build-time dependency checks, the source-evidence check
docs/            adoption-inventory.md, sources.md, host-vault.md, session-cache-policy.md
research/        spike reports behind the OpenCode 2 design
```

`bun run build` checks installed dependency ranges, compiles `src/` to `dist/` with `tsc -p tsconfig.build.json`, and checks that `@cortexkit/private-files` stayed external. `tsc` never deletes outputs of removed sources, so pack release candidates from a clean checkout.

## `src/`

- `store/`: `pool.ts` opens the store; `rows.ts`, `mutate.ts`, `publication.ts` write rows; `refresh.ts`, `refresh-lock.ts` refresh credentials under locks; `pull.ts`, `quota-writer.ts` fetch and commit quota; `torn.ts`, `identity.ts`, `attribution.ts` keep writes crash-safe and fenced; `settings.ts` holds the settings kept in the store's config file; `schema.ts` names the stored keys; `limits-namespace.ts` stores limit marks with the pool.
- `settings/`: declarations (`define.ts`, `descriptors.ts`), file locations (`paths.ts`), reading (`parse.ts`, `snapshot.ts`, `resolve.ts`, `handle.ts` with `openSettings`), edits (`edit.ts`, `update.ts`, `write.ts`, `lock-errors.ts`), the one-time move (`move.ts`), `schema.ts`, `refusal.ts`, and `fs.ts`, the file seam tests replace.
- `quota/`: `merge.ts`, `projection.ts`, `map.ts`, `codec.ts`, `pending.ts`, `commit-interval.ts`, and `format.ts`, the one quota wording.
- `routing/`: `admission.ts`, `ordered.ts`, `sticky.ts`, `pins.ts`.
- `limits/`: signals (`signal.ts`, `header-classifier.ts`, `families.ts`, `reset.ts`), the registry (`registry.ts`, `persistence.ts`, `pool-adapter.ts`, `vault-adapter.ts`, `envelope*.ts`, `merge-laws.ts`), decisions (`decide.ts`, `presets.ts`, `axes.ts`, `hold.ts`, `routing-hold.ts`), host helpers (`pi-wait.ts`, `terminal.ts`), and `wording.ts`.
- `claustrum/`: `enrollment.ts`, `consumer.ts`, `custody.ts`, `hub.ts`, `roster.ts`, `interlock.ts`, `insula.ts`, `usage.ts`, `watch.ts`, `availability.ts`, `host.ts` (hosted mode), `host-slot.ts`, `shutdown.ts`, `errors.ts`.
- `opencode2/`: `install.ts` (the hook installer), `types.ts` (the adapter contract), `integration.ts`, `sse.ts`, `errors.ts`.
- `setup/`: `command.ts` (`runSetup`), `flags.ts` (the one flag table help and parsing share), `detect.ts`, `register.ts`, `config-write.ts`, `enroll.ts`, `process-fence.ts`, `prompts.ts`, `types.ts` (`SetupPlugin`).
- `commands/`: `menu.ts` (the menu model), `seam.ts` (payload projection and redaction), `builtins.ts` (Accounts, Quota, Routing, Limits), `pi.ts` (Pi renderer), `model.ts`.
- `auth-menu/`: the terminal account menu (`menu.ts`, `accounts.ts`, `login.ts`, `doctor.ts`, `opencode-v1.ts`, terminal helpers).
- `quota-sidebar/index.tsx`: the quota adapter over `@cortexkit/opencode-sidebar`, shipped as source.
- `tui/`, `tui-build/`, `tui-prefs/`, `sidebar-file/`: TUI loading, build, preferences and the sidebar state file.
- `routing-accessor/`: `index.ts` (routing advice, reports, turn notes), `cache-policy.ts`, `handle.ts` (dependency-free accessor lookup).
- `cachekeep/`: `manager.ts` (`CacheKeepManager`), `decision.ts` (`decideCacheKeep`), `window.ts`, `failure.ts`.
- `fs/`: `atomic-write.ts`, `with-lock.ts`, `refresh-file-lock.ts`, `private-files.ts`, `file-read-cache.ts`, `lock-constants.ts`.
- `logger/`, `redaction/`, `dump/`, `rpc/`, `pi-slot/`, `util/`.

## Where to add new code

- **A new export:** a folder under `src/` with an `index.ts`, an entry in `package.json` `exports`, and its section in `docs/adoption-inventory.md`. Keep heavy dependencies out of light subpaths: a plugin importing `./routing-accessor` must not pull in the limits code.
- **A store operation:** `src/store/`, taking locks in the fixed order (row, provider, extra, store) and fencing late results on epoch and identity.
- **A refusal or status text:** `src/limits/wording.ts` or the module's own constants, digit-free and with no labels.
- **A vault behaviour:** `src/claustrum/`. Classify any new client error code in `availability.ts`; unclassified codes fail closed.
- **A file write:** through `src/fs/` (`writeJsonAtomic`, `withLock`, leases), never a bare `writeFile`, so Windows owner-only handling applies.
- **A setup flag:** `src/setup/flags.ts`, so help and parsing can't disagree.
- **A plugin setting:** declared in the plugin's own `defineSettings` call. common-auth changes only for a new value type (`src/settings/descriptors.ts`, with its schema in `schema.ts`).
- **A test:** `test/<subpath>/*.test.ts`. A test that spawns a child passes `env` explicitly, since a child spawned without it gets the environment the test process started with.

## Conventions

- Files are kebab-case; Biome formats and lints; `tsc` typechecks.
- Changes to stored files are additive: older readers must still read them, and unknown keys are kept on write.
- New behaviour a plugin hasn't adopted stays off unless the plugin opts in.
