# Adoption inventory

This revision is publish-ready, not published, and does not adopt the library into any plugin. A later adoption into the openai-auth plugin must use a published npm range for `@cortexkit/common-auth` as a build-time devDependency, bundle/inline it, and verify its absence from the consumer's node_modules. No git, file or link dependency is permitted.

Only **moves** machinery and its covering tests are removed/replaced. A partial-file move does not authorize deleting policy in the same file. Origins in [sources.md](sources.md) are historical provenance labels, not required files or runtime imports; both inventories remain usable without the supplied reference tree.

## Moves and stays

Component legend: 1 rpc, 2 tui-build, 3 tui-preferences, 4 fs, 5 logger, 6 sidebar-file, plus tooling and shim. The commit identifies the plugin snapshot from which machinery was extracted, not a dependency pin. A shim is the plugin's entry wrapper. Test groups below identify subsets, not permission to remove an entire mixed-policy test file. The complete unchanged moved titles are recorded in sources.md.

| plugin | commit | component | role (moves/stays) | path | symbol or — | test path or — | test name or — |
| --- | --- | --- | --- | --- | --- | --- | --- |
| openai-auth | e6837be | 1 rpc | moves | packages/opencode/src/rpc/rpc-server.ts | startRpcServer, RpcServerHandle, RpcServerOptions | packages/opencode/src/tests/rpc-server.test.ts | Standalone server machinery titles in sources.md; integration tests stay |
| openai-auth | e6837be | 1 rpc | moves | packages/opencode/src/rpc/rpc-client.ts | createRpcClient, RpcClient, DEFAULT_RPC_TIMEOUT_MS | packages/opencode/src/tests/rpc-server.test.ts | RPC client preserves sessionId through the server apply callback; keeps the default call timeout at two seconds; apply honors a per-call timeout override |
| openai-auth | e6837be | 1 rpc | moves | packages/opencode/src/rpc/port-file.ts | PortFileEntry, isManagedRpcStateDir, isUsablePortFileEntry, writePortFile, sweepRpcState, discoverPortFile | packages/opencode/src/tests/rpc-port-file.test.ts | 18 port-file machinery titles in sources.md |
| openai-auth | e6837be | 1 rpc | moves | packages/opencode/src/rpc/notifications.ts | pushNotification, drainNotifications, isTuiConnected, resetNotificationsForTest | packages/opencode/src/tests/rpc-notifications.test.ts | Six wire-session notification titles in sources.md |
| openai-auth | e6837be | 1 rpc | moves | packages/opencode/src/index.ts | — | — | — |
| anthropic-auth | b504bc84 | 1 rpc | moves | packages/opencode/src/rpc/server-registry.ts | adoptRpcServer | packages/opencode/src/tests/rpc-server-registry.test.ts | serializes same-directory replacement and fences predecessor release; does not serialize different project directories |
| openai-auth | e6837be | 1 rpc | stays | packages/opencode/src/rpc/rpc-dir.ts | getRpcDir, resolveRpcDir | packages/opencode/src/tests/rpc-dir.test.ts | Host environment/path-resolution tests |
| openai-auth | e6837be | 1 rpc | stays | packages/opencode/src/rpc/protocol.ts | Plugin protocol types | — | — |
| openai-auth | e6837be | 1 rpc | stays | packages/opencode/src/tests/rpc-server.test.ts | Plugin integration fixtures | packages/opencode/src/tests/rpc-server.test.ts | Plugin integration tests |
| openai-auth | e6837be | 2 tui-build | moves | packages/opencode/scripts/build-tui.ts | resolveShippedSource, rewriteGeneratedImports, resolveSolidTransformPath; top-level build driver | packages/opencode/src/tests/tui-packaging.test.ts | Build/linking and emitted-set checks replaced by library linking and publish-list checks |
| openai-auth | e6837be | shim | stays | packages/opencode/src/tui/entry.mjs | default export wrapper | packages/opencode/src/tests/tui-packaging.test.ts | Packed wrapper and host-only entry checks |
| openai-auth | e6837be | 2 tui-build | stays | packages/opencode/src/tui/ | TUI source, request handlers and dialog contents | — | — |
| openai-auth | e6837be | 2 tui-build | stays | packages/opencode/package.json | Published files list | packages/opencode/src/tests/tui-packaging.test.ts | Plugin bundle/publish-list checks; update for emitted closure |
| openai-auth | e6837be | 3 tui-preferences | moves | packages/opencode/src/tui-preferences.ts | readTuiPreferencesFile, queueTuiPreferenceUpdate, watchTuiPreferences (generic machinery only) | packages/opencode/src/tests/tui-preferences.test.ts | Reader/writer/watcher machinery titles in sources.md |
| anthropic-auth | b504bc84 | 3 tui-preferences | moves | packages/opencode/src/tui-preferences.ts | readTuiPreferencesFile, queueTuiPreferenceUpdate, watchTuiPreferences | packages/opencode/src/tests/tui-preferences.test.ts | Reader/writer/watcher titles in sources.md; synchronous baseline and polling fallback borrowed |
| antigravity-auth | 44eb8fa | 3 tui-preferences | moves | packages/opencode/src/tui-preferences.ts | queueTuiPreferenceUpdate (cross-process lock and pre-rename ownership check) | — | — |
| openai-auth | e6837be | 3 tui-preferences | stays | packages/opencode/src/tui-preferences.ts | getTuiPreferencesFile, resolveOpenaiAuthPrefs; plugin key, schema, defaults and ordering policy | packages/opencode/src/tests/tui-preferences.test.ts | Host resolver, schema and ordering-policy tests |
| openai-auth | e6837be | 4 fs | moves | packages/core/src/refresh-file-lock.ts | acquireRefreshFileLock, isLostMarkerRaceError; acquisition options and handle | packages/opencode/src/tests/refresh-file-lock.test.ts | 12 acquireRefreshFileLock machinery titles in sources.md |
| antigravity-auth | 44eb8fa | 4 fs | moves | packages/core/src/file-lock.ts | assertOwned; temp+rename renewal mechanism | — | — |
| openai-auth | e6837be | 4 fs | moves | packages/core/src/atomic-write.ts | writeJsonAtomic | — | — |
| antigravity-auth | 44eb8fa | 4 fs | moves | packages/core/src/atomic-write.ts | writeJsonAtomic (staging cleanup) | — | — |
| openai-auth | e6837be | 5 logger | moves | packages/core/src/logger.ts | Level, InitLoggerOptions, initLogger, setLogLevel, redact, redactStrings, flushLogs, createLogger, flushForTest, resetLoggerForTest | packages/core/src/tests/logger.test.ts | logger levels, logger safety and logger redaction titles in sources.md |
| anthropic-auth | b504bc84 | 5 logger | moves | packages/core/src/logger.ts | In-memory capture sink machinery | — | — |
| openai-auth | e6837be | 5 logger | stays | packages/opencode/src/logger.ts | Host logger adapter, getLogFile, getEnvLogLevel, exit handler installation | — | — |
| antigravity-auth | 44eb8fa | 5 logger | stays | packages/core/src/logger.ts | Separate debug stream | — | — |
| openai-auth | e6837be | 6 sidebar-file | moves | packages/opencode/src/sidebar-state.ts | enqueueSidebarWrite, readSidebarState, writeMergedSidebarState, doWriteSidebarState (generic file machinery only) | packages/opencode/src/tests/sidebar-state.test.ts | Generic file/queue/merge tests replaced by sidebar-file tests in sources.md |
| openai-auth | e6837be | 6 sidebar-file | stays | packages/opencode/src/sidebar-state.ts | setSidebarState host API, getSidebarStateFile; schema and normalization policy | packages/opencode/src/tests/sidebar-state.test.ts | empty object {} returns well-formed default shape; getSidebarStateFile() returns the floor temp path, not the live default |
| openai-auth | e6837be | 6 sidebar-file | stays | packages/opencode/src/sidebar-state.ts | Quota, routing and sticky-pin policy | packages/opencode/src/tests/sidebar-state.test.ts | machine writes cannot clobber fresher main and fallback quota from disk; preserves valid active routing entries by session id; normalizes sticky assignments without retaining malformed siblings |
| openai-auth | a1edb00 | tooling | stays | scripts/check-installed-ranges.mjs | Installed dependency range check (adapted separately for the library) | — | — |
| openai-auth | a1edb00 | tooling | stays | package.json, biome.json, lefthook.yml, .github/workflows/ci.yml, .github/workflows/release.yaml | Plugin tooling and release configuration (library adapts copies separately) | — | — |

**Unresolved inline registry:** the openai-auth index.ts copy was not supplied. The adoption task must locate the inline registry symbol inside its own openai-auth checkout, replace it with `adoptRpcServer`, then delete only that registry machinery. The symbol remains `—`; no guessed identifier authorizes deletion. The borrowed anthropic registry is not assumed equivalent to an unread inline implementation. Rows for other plugins document borrowed machinery, not adoption or deletion in those plugins.

## Adoption inputs: public exports and parameters

All seven subpaths are ESM, with `dist/<subpath>/index.js` and adjacent `index.d.ts` targets. No extra package subpath exposes the unwrapped lock or test clock. The adopting plugin supplies its file paths, directory prefixes, registry key, preferences key, logger channels and schema/merge policy.

### ./rpc

Runtime exports:
- `pushNotification(scope, payload, sessionId?)`, `drainNotifications(scope, lastReceivedId?, sessionId?)`, `isTuiConnected(scope, sessionId)`, `resetNotificationsForTest(scope)`. Scope is `{ rpcRoot, directoryPrefix, registrationSessionId }`; payload is `{ command, text, knobs }`; wire sessionId remains optional.
- `createManagedRpcStateDirPredicate(directoryPrefix)`, `isManagedRpcStateDir(name, directoryPrefix)`, `getRpcDir(rpcRoot, directoryPrefix, projectDirectory)` (pure layout helper, not the host resolver).
- `writePortFile(dir, { port, token, pid }, { secureDir?, beforeWrite? }?)`, `sweepRpcState(root, activeDir, isManagedDir, log?)`, `discoverPortFile(dir, expectedPid?)`.
- `DEFAULT_RPC_TIMEOUT_MS`, `createRpcClient(dir, expectedPid?, onSelected?)`; client methods `pending(lastReceivedId, sessionId?)`, `apply(request, timeoutMs?)`.
- `startRpcServer({ dir, isManagedDir, drain, apply, log?, secureDir?, sweepRoot?, timeoutMs?, receiptTimeoutMs? })`; handle `{ port, token, stop() }`. Injected apply receives opaque command/arguments/sessionId; the plugin keeps its command handlers.
- `adoptRpcServer(registryKey, rpcDir, create)` returns `{ server, release() }`. Registry key is required, with no plugin default.

Type exports: `RpcLogChannel`, `ApplyRequest`, `ApplyResult`, `OpenDialogPayload`, `RpcNotification`, `NotificationScope`, `PortFileEntry`, `RpcClient`, `RpcServerHandle`, `RpcServerOptions`, `RpcServerAdoption`. Logging is optional channel-bound `{ warn, debug }`; directory hardening and sweep are host-selected, never inferred from environment.

### ./fs

Runtime exports: `writeJsonAtomic(path, value, { serialize?, beforeRename? }?)`; `lockPathFor(target, name)`; `withLock(target, { name, ttlMs, timeoutMs, renew? }, fn)`; `LockContentionError`, `LockOwnershipError`, `WRITER_LOCK_CONSTANTS`. `fn` gets `{ assertOwned(): Promise<void> }`. `renew` defaults false; timeoutMs is mandatory for direct withLock calls. Atomic default bytes are two-space JSON plus newline, mode 0600; sidebar explicitly uses compact JSON without newline.

Type exports: `AtomicWriteOptions`, `LockOptions`. Frozen sidebar defaults: name sidebar-write, ttlMs 10000, timeoutMs 15000, renew true; preferences: name preferences, ttlMs 10000, timeoutMs 2000, renew true. Writers only permit timeoutMs override. Contention details identify target/name/timeoutMs; ownership details identify target/name.

### ./logger

Runtime exports: `initLogger({ file, level?, captureSink?, extraSecretKeys?, extraValuePatterns? })`, `createLogger(channel)`, `setLogLevel(levelOrUndefined)`, `flushLogs()`, `flushForTest()`, `resetLoggerForTest()`, `createCaptureSink()`, `createRedactor(options?)`, `redact(value)`, `redactStrings(value)`. File and level accept host providers; the host installs exit flushing. Capture returns records/sink/clear. A logger exposes error/warn/info/debug/trace methods taking message and optional data.

Type exports: `CaptureSink`, `LogTestRecord`, `InitLoggerOptions`, `Level`, `RedactionOptions`, `Redactor`. ExtraSecretKeys receives the normalized key only; openai adoption supplies chatgptaccountid/email/orgname/organizationname extras and any value patterns. These are not common-set literals.

### ./sidebar-file

Runtime export: `createSidebarFile<T>({ path, defaultValue, normalize, timeoutMs?, logger? })` returns `read()`, `write(value, hooks?)`, `update(merge, hooks?)`. The caller owns schema, normalization, quota, routing and sticky pins; merge receives current state and may return undefined to skip writing. Internal hooks `beforeRecheck?` and `beforeCommit?` are for tests, not plugin policy. Type exports: `SidebarFile`, `SidebarFileHooks`, `SidebarFileOptions`.

### ./tui-prefs

Runtime exports: `readTuiPreferencesFile(file)` for raw parsed object; `readTuiPreferences<T>({ file, pluginKey, defaults, schema })`, where schema receives `(entry: unknown, defaults: T)` and returns T; `createTuiPreferenceWriter({ file, pluginKey, timeoutMs?, beforeCommit? })` returning `queueTuiPreferenceUpdate(path, value)` (path is readonly string/number segments); `watchTuiPreferences(file, onChange, { watchDirectory? }?)` returning a disposer. Plugin schema/defaults/order stay in the host. BeforeCommit is an internal test seam. Type exports: `PreferenceValue`, `TuiPreferencesReaderOptions`, `TuiPreferenceWriter`, `TuiPreferenceWriterOptions`, `TuiPreferencesWatchOptions`.

### ./tui-build

Runtime exports: `buildTui(entryFile, variant, destinationDir, options?)`, `assertEmittedPublishList(packageRoot, destinationDir, emitted)`, `runtimeModules`, `runtimeModuleId(specifier)`, `loadSolidTransform()`. Variant is raw/runtime; options are `inline` (package names or `{ name, root }` pairs), `runtimeModules`, `loadSolidTransform`. Result `{ emitted, sources, selector, externals }` includes every emitted destination file and one absolute source per entry. Type exports: `BuildTuiOptions`, `TransformSolidSource`, `TuiBuildResult`. Transform takes `(code, { filename, moduleName, resolvePath })` and resolves to code. Build one destination per variant and compare the complete emitted set against the plugin publish list.

### ./tui

Runtime export: `loadTui({ rawEntry, runtimeEntry, importModule? })`; type export `LoadTuiOptions`. Entry values must be absolute paths or absolute file URLs. It probes exactly `opentui:runtime-module:%40opentui%2Fsolid`, selects raw only for a missing-registry error, otherwise runtime, and returns the selected module's default. Other probe errors propagate. Importing this subpath loads no OpenTUI.

## Externals and staying entry wrapper

The verified fixture's surviving **npm package names** are `jsonc-parser` in both variants and `solid-js` in raw. The raw solid-js/store specifier belongs to the solid-js package; neither node built-ins nor encoded runtime IDs are installable dependencies. For a real plugin tree, convert every surviving bare subpath to its owning package and declare it explicitly. The default runtime set also uses `@opentui/core` and `@opentui/solid`; when those survive in raw, the plugin declares those packages, not their testing/components/jsx subpaths. Keep Solid pinned to 1.9.12 to match the host runtime. Library optional peers are not an assurance that npm supplies these to a bundled consumer.

When adopting into openai-auth, its package build invokes buildTui with `inline: ['@cortexkit/common-auth']` and builds raw/runtime separately. The staying `packages/opencode/src/tui/entry.mjs` imports loadTui **relatively from a returned selector copy**, not from a bare library specifier. It constructs caller-relative absolute file URLs for raw/runtime entries (for example new URL(relativeEntry, import.meta.url).href). Retain/publish that selector path and its closure; result.selector identifies its actual emitted filename. The host wrapper and emitted imports must resolve within the packed plugin with the library absent. Do not duplicate the selector or hard-code a hand-kept export list.

## Tests moving and adoption checks

The unchanged library titles and behaviour mappings live in sources.md. Openai moved groups are the 12 lock machinery tests, logger levels/safety/redaction, 18 port-file tests, 11 standalone-server tests, 3 client tests, six notification tests, and generic sidebar/preferences file machinery. Sidebar policy and host path tests, preferences schema/ordering policy, RPC integration and rpc-dir tests stay. Anthropic registry tests and baseline/polling watcher coverage are borrowed, not subtracted from openai counts; antigravity mechanisms are pinned by new library tests.

The adoption task records every openai test actually removed and every test added, preserves titles for moved tests, runs the plugin's full build/typecheck/lint/test gate and a one-time old-TUI/new-loader and new-TUI/old-loader compatibility check, and tests each packed consuming package in a clean project outside the repository. It verifies no installed common-auth remains, evaluates every non-host-only export, checks the host-only wrapper's relative specifiers, and drives the wrapper against harmless fixture entries. A workspace/file install failure is a stop, not an excuse to weaken the check. This campaign does not perform these adoption checks.

## D7 compatibility limits

1. **Unlocked old writers:** exclusion holds only among cooperating live-lease holders. In openai-auth baseline e6837be, setSidebarState directly queues doWriteSidebarState without a lock, while only its merged-write path takes sidebar-write. The moved merge-recheck loop is best-effort mitigation, not exclusion against that old path.
2. **Cross-plugin preferences protocol:** antigravity-auth baseline 44eb8fa uses the same preferences lock path, newline-free payload, and marker owner.json with ownerId/pid/createdAt. Live expiresAt detection interoperates, including newline-free payload with backdated mtime, but stale eviction protocols do not. Do not claim full stale-lock compatibility.
3. **Check-to-rename expiry:** assertOwned and rename are separate operations. A holder stalled after a passing check beyond lease expiry can overwrite a successor. Commit-time fencing would be required to close this window and is outside this campaign.

Observed check-to-rename expiry demonstration: the internal acquireRefreshFileLock uses clock 100, ttlMs 1000 and renew false. A stages its file, passes assertOwned in beforeRename, advances clock to 1101, lets B acquire/write/release, then resumes its own rename. The test is `a lease expiring after the pre-rename fence can overwrite a successor`.

```text
bytes after B's write: "{\n  \"writer\": \"B\"\n}\n"
bytes after A resumes: "{\n  \"writer\": \"A\"\n}\n"
```

The supplied reference copy can be deleted after this library extraction: no inventory requires it to exist. Keep these committed documents for provenance and adoption scope.
