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

All seven subpaths are ESM, with `dist/<subpath>/index.js` and adjacent `index.d.ts` targets. Since 0.1.1, `/fs` also exports the try-once lock underneath `withLock`, `acquireRefreshFileLock({name, ttlMs, path, now?, renew?, renewIntervalMs?, onStep?})`, which returns a `{release, assertOwned}` handle or `null` when the lock is held, and `isLostMarkerRaceError`. It is for callers that hold a lock across several steps or poll rather than wait; openai-auth's refresh leases use it. The adopting plugin supplies its file paths, directory prefixes, registry key, preferences key, logger channels and schema/merge policy.

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

Runtime export: `createSidebarFile<T>({ path, defaultValue, normalize, timeoutMs?, secureDir?, logger? })` returns `read()`, `write(value, hooks?)`, `update(merge, hooks?)`. The caller owns schema, normalization, quota, routing and sticky pins; merge receives current state and may return undefined to skip writing. `secureDir` (default true, since 0.1.2) tightens an existing parent directory to 0o700 before each write; pass false for a directory the user chose, such as an override path. A parent the library has to create is always created 0o700 (since 0.1.3). Internal hooks `beforeRecheck?` and `beforeCommit?` are for tests, not plugin policy. Type exports: `SidebarFile`, `SidebarFileHooks`, `SidebarFileOptions`.

### ./tui-prefs

Runtime exports: `readTuiPreferencesFile(file)` for raw parsed object; `readTuiPreferences<T>({ file, pluginKey, defaults, schema })`, where schema receives `(entry: unknown, defaults: T)` and returns T; `createTuiPreferenceWriter({ file, pluginKey, timeoutMs?, beforeCommit? })` returning `queueTuiPreferenceUpdate(path, value)` (path is readonly string/number segments); `watchTuiPreferences(file, onChange, { watchDirectory? }?)` returning a disposer. Plugin schema/defaults/order stay in the host. BeforeCommit is an internal test seam. Type exports: `PreferenceValue`, `TuiPreferencesReaderOptions`, `TuiPreferenceWriter`, `TuiPreferenceWriterOptions`, `TuiPreferencesWatchOptions`.

### ./tui-build

Runtime exports: `buildTui(entryFile, variant, destinationDir, options?)`, `assertEmittedPublishList(packageRoot, destinationDir, emitted)`, `runtimeModules`, `runtimeModuleId(specifier)`, `loadSolidTransform()`. Variant is raw/runtime; options are `inline` (package names or `{ name, root }` pairs), `runtimeModules`, `loadSolidTransform`. Result `{ emitted, sources, selector, externals }` includes every emitted destination file and one absolute source per entry. Type exports: `BuildTuiOptions`, `TransformSolidSource`, `TuiBuildResult`. Transform takes `(code, { filename, moduleName, resolvePath })` and resolves to code. Build one destination per variant and compare the complete emitted set against the plugin publish list.

### ./tui

Runtime export: `loadTui({ rawEntry, runtimeEntry, importModule? })`; type export `LoadTuiOptions`. Entry values must be absolute paths or absolute file URLs. It probes exactly `opentui:runtime-module:%40opentui%2Fsolid`, selects raw only for a missing-registry error, otherwise runtime, and returns the selected module's default. Other probe errors propagate. Importing this subpath loads no OpenTUI.

### ./quota

Pure functions over plain JSON; no file I/O, locks or clock reads (every time is a parameter).

**Quota map** (`QuotaMap`): `{ limits: QuotaEntry[], budget? }`. Each limit is keyed by `(scope, label)`: `scope` is `all` (`ALL_SCOPE`) or a model family, `label` names the provider's window. An entry is a reading `{ kind: 'reading', checkedAt, usedPercent, resetsAt?, windowMinutes? }`, a retirement tombstone `{ kind: 'retired', retiredAt }` or an absence record `{ kind: 'absent', checkedAt }`. A missing key is unknown; a tombstone or absence record is evidence that the key is unlimited, and admission treats both alike. The budget is a tri-state: absent (never reported), `{ kind: 'reading', checkedAt, reached, remainingPercent?, usedPercent?, resetsAt?, limit?, used?, remaining?, unit? }`, or `{ kind: 'cleared', checkedAt }`. Merge writes limits sorted by scope then label, so identical content serialises identically.

**Observation** (`QuotaObservation`): `{ checkedAt, readings?: [{ scope?, label, usedPercent, resetsAt?, windowMinutes? }], coverage?: [{ scope?, label }], budget?: { kind: 'reading', ... } | { kind: 'cleared' } }`; `scope` defaults to `all`. Coverage lists the pairs the observation speaks for with authority; every reading is implicitly covered. A header-shaped push covers only what it carries; a full poll covers every pair the source reports on. An absent `budget` says nothing about the budget.

**Merge rules** (`mergeQuotaObservation`). One freshness rule: an observation applies to a key when `checkedAt` is not older than the key's reading, retirement or absence time (equal applies, the observation applied last wins). A covered pair without a reading turns an existing reading or tombstone into a tombstone at `checkedAt`, and an empty or absent-recorded key into an absence record at `checkedAt`. Pairs outside the coverage are never touched. The budget follows the same rule against the stored budget's `checkedAt`. Unrecognised top-level keys of a stored map are carried over.

| export | parameters | returns | errors |
| --- | --- | --- | --- |
| `quotaCodec` | — | frozen `{ validate: isQuotaMap, merge: mergeQuotaObservation }`, the codec `/store` is opened with | — |
| `isQuotaMap(value)` | `unknown` | `true` for a well-formed map; unknown top-level keys tolerated; a malformed entry or budget, or a duplicated `(scope, label)`, makes the whole map invalid (the store treats that row as row-level malformed) | — |
| `isQuotaObservation(value)` | `unknown` | `true` for a well-formed observation; the same pair read twice is malformed | — |
| `mergeQuotaObservation(stored, observation)` | `stored`: a map or `undefined`; `observation` | a new `QuotaMap`; neither argument is modified | `QuotaCodecError` (a `TypeError`) when either argument is malformed, so the store refuses the write |
| `projectQuota(map, scope = 'all')` | a map or `undefined`, the request scope | `ProjectedQuota { scope, limits, checkedAt?, budget? }` | — |
| `budgetExhaustedResetAt(projection, now)` | projection, `now` ms | `{ resetsAt, resetAtMs }` when the budget is `reached` with a parsable reset after `now`, else `undefined` | — |
| `readsExhausted(limit)`, `futureResetAt(limit, now)` | a projected limit | reading at or above 100% used; the reset in ms when it parses and lies after `now` | — |
| `emptyQuotaMap()` | — | `{ limits: [] }` | — |

**Projection.** A family request sees only its family's keys and the `all` keys, one entry per label. A family *reading* shadows the `all` entry for its label; a family tombstone or absence record says only that no family-specific limit exists, so it does not hide an `all` entry for the same label and reaches the primitives only when there is none (library decision, pinned by `a family tombstone or absence record does not hide an all-models entry`). Limits are ordered longest stored `windowMinutes` first, unknown lengths last, then by label. Each limit carries its stored length as `windowMinutes`; an unknown stored length stays `undefined` and is never filled in by slot the way openai-auth's `getPresentQuotaWindows` fills `LEGACY_WINDOW_MINUTES` (declared divergence: a pre-dynamic-window snapshot migrated without a length sorts last and shows no length). `checkedAt` is the minimum reading time (the minimum evidence time when there is no reading), so a projection is only as fresh as its stalest reading; both the selection primitives and pending-bytes attribution see that minimum. A cleared budget projects no budget.

**Provider → (scope, window) mapping.** The library infers no labels; a plugin maps its provider's windows when it builds observations and passes the required labels per admission call. openai-auth: the wham/header primary window → `(all, primary)`, secondary → `(all, secondary)`, spend control → the budget, and a full poll covers both pairs; required labels `['primary']` (the default). anthropic-auth: `five_hour` and `seven_day` → `(all, five_hour)` and `(all, seven_day)`, a model-scoped week such as `seven_day_opus` → `(opus, seven_day)`, extra usage → the budget; it must pass its own required labels. antigravity-auth: each per-model quota → `(<model family>, <its window label>)`.

### ./routing

Pure functions; every input is per call and nothing is persisted. Rate-limit marks, refresh backoff, killswitch verdicts, reserve percent, pending bytes, pins, identities and `formerMainId` are all caller-held.

| export | parameters | returns | errors |
| --- | --- | --- | --- |
| `admit(input)` | `{ rows: { id, kind: 'oauth' \| 'api-key', quota? }[], scope = 'all', requiredLabels = ['primary'], now, rateLimitMarks?: Map<id, expiresAtMs>, refreshBackoff?: Map<id, retryAtMs>, requestPull?: (id) => void }` | `{ admitted: { id, kind, projection?, lastPath? }[], refused: AdmissionRefusal[], excluded: { id, reason: 'rate-limited' \| 'refresh-backoff', until }[], pulls: id[] }` | — |
| `routeOrdered(input)` | `admit`'s input plus `placement = 'roster'`, `formerMainId = 'main'`, `killswitch?: Map<id, boolean>` | `{ order: id[], admission }` | — |
| `nextOrderedAttempt(order, attempts, retryStatuses)` | the order, `{ id, status? }[]` tried so far, the statuses that move on | next id, or `undefined` when the last status is not a retry status (a missing status never retries) or every row was tried | — |
| `resolveRoutingMode(value)` | the persisted `routing.mode` | `{ mode: 'ordered' \| 'sticky-balanced', placement: 'roster' \| 'main-first' \| 'fallback-first' }` | — |
| `orderForPlacement(ids, placement, formerMainId = 'main')` | roster ids | reordered copy | — |
| `routeSticky(input)` | `admit`'s input plus `requestBytes`, `pendingBytes?`, `killswitch?`, `reservePercent?: Record<label, percent>`, `resetCreditsApplicable?`, `pin?: StickyPin`, `identities?: Map<id, wireIdentity>`, `onEmptyWeightedSet?` | `{ outcome: 'dispatch', accountId, source: 'pin' \| 'weighted' \| 'mode-fallback', quotaCheckedAt?, pin: PinAction, refusedSelections, admission }` or `{ outcome: 'no-admissible-account', pin, refusedSelections, admission }` | — |
| `decideStickyBreak({ quota, quotaCheckedAt?, status?, now, killswitchPasses? })` | a projection | openai-auth's decision; an exhausted decision names `window: { scope, label }` | — |
| `selectStickyCandidate(input)` | openai-auth's input with `quota` a projection and `reservePercent` keyed by label | `{ accountId, quotaCheckedAt?, source }` or `undefined` | throws on an empty candidate list, as openai-auth does |
| `isPinValid(pin, validIds, currentIdentity)`, `pendingBytesForPins(pins, quotaCheckedAtById, excludedSessionKey?)` | pins as `[sessionKey, StickyPin]` pairs | validity; bytes per row | — |

**Admission.** A marked row is excluded while `now < expiresAt` and readmitted at its roster position from the expiry on; a backed-off row likewise until its retry time. Neither reorders or re-weights any other row. openai-auth's `selectStickyCandidate` has no such inputs (its request path filtered rate-limited fallbacks before calling it), so both inputs, and their exclusion semantics in both modes, are new. Stage-1 gates in precedence: (1) API-key rows are admitted without quota; (2) no projected entry for the scope → `needs-first-reading`; (3) a required label with no entry → `unknown-window`; (4) a reading at or above 100% whose reset is missing, unparsable or not after `now` → `unknown-reset`; (5) a reading at or above 100% with a future reset → `exhausted`. Gates 4 and 5 judge every projected limit, including a third window. Gate 4 judges only exhausted-looking readings (library decision: a reading below 100% is admitted whatever its reset says), and it deliberately diverges from openai-auth, whose admission failed open on a passed window reset: the library refuses and requests a reading. Gates 2 to 4 request a pull: `requestPull(id)` is called synchronously, never awaited, once per refusal, and the refusal is returned without waiting. Every call evaluates every candidate, so a caller that fires a real pull from this callback should dedupe pulls already in flight. Stage 2: a survivor whose budget is spent (`budgetExhaustedResetAt`) is refused as `budget-spent` unless every survivor is spent, in which case all are kept with `lastPath: true`. API-key rows are survivors, a stage-1 refusal never counts as a path, and there is no last-path exception at any stage-1 gate. The budget signal ignores staleness, as openai-auth's `isQuotaExhausted` does.

**Ordered.** `routing.mode` absent or unrecognised resolves to `ordered` in roster order, where legacy readers defaulted to `main-first`; the persisted value is never rewritten. `main-first` and `fallback-first` place the row named by `formerMainId` (default `main`) first or last when that row exists. The follow-up supplies the recorded former-main id; nothing here reads `commonAuthPool`. The retry statuses have no default and are always the caller's.

**Sticky-balanced.** The primitives are openai-auth's, judged over the projection. Two limitations are declared. First, `STICKY_WINDOW_SLOTS` is 2: selection weight and the break decision use only the first two readings in projection order, so a third window per scope adds no weight and is judged by admission alone. Second, `decideStickyBreak` reports `window: { scope, label }` instead of openai-auth's `windowKey`. `routeSticky` dispatches a valid pin whose row is admitted and not killed. Otherwise it runs selection over the non-excluded rows, drops each selected row that admission refused, and re-runs until a row is admitted or none is left (`no-admissible-account`). A valid pin is always `retain`: a pin whose row is refused (quota turned unknown), excluded or killed is routed around, not deleted, and the caller's break decision governs clearing it. An invalid pin, meaning its row id is not among the rows passed in or both it and the row carry known identities that differ, is replaced (`assign`, carrying the row's current identity) or `clear`ed when nothing is admissible. An unknown identity on either side keeps the pin. Pins, pending bytes and assignment maps are never written to either store file by this subpath.

## Externals and staying entry wrapper

The verified fixture's surviving **npm package names** are `jsonc-parser` in both variants and `solid-js` in raw. The raw solid-js/store specifier belongs to the solid-js package; neither node built-ins nor encoded runtime IDs are installable dependencies. For a real plugin tree, convert every surviving bare subpath to its owning package and declare it explicitly. The default runtime set also uses `@opentui/core` and `@opentui/solid`; when those survive in raw, the plugin declares those packages, not their testing/components/jsx subpaths. Keep Solid pinned to 1.9.12 to match the host runtime. Library optional peers are not an assurance that npm supplies these to a bundled consumer.

When adopting into openai-auth, its package build invokes buildTui with `inline: ['@cortexkit/common-auth']` and builds raw/runtime separately. The staying `packages/opencode/src/tui/entry.mjs` imports loadTui **relatively from a returned selector copy**, not from a bare library specifier. It constructs caller-relative absolute file URLs for raw/runtime entries (for example new URL(relativeEntry, import.meta.url).href). Retain/publish that selector path and its closure; result.selector identifies its actual emitted filename. The host wrapper and emitted imports must resolve within the packed plugin with the library absent. Do not duplicate the selector or hard-code a hand-kept export list.

## Tests moving and adoption checks

The unchanged library titles and behaviour mappings live in sources.md. Openai moved groups are the 12 lock machinery tests, logger levels/safety/redaction, 18 port-file tests, 11 standalone-server tests, 3 client tests, six notification tests, and generic sidebar/preferences file machinery. Sidebar policy and host path tests, preferences schema/ordering policy, RPC integration and rpc-dir tests stay. Anthropic registry tests and baseline/polling watcher coverage are borrowed, not subtracted from openai counts; antigravity mechanisms are pinned by new library tests.

The adoption task records every openai test actually removed and every test added, preserves titles for moved tests, runs the plugin's full build/typecheck/lint/test gate and a one-time old-TUI/new-loader and new-TUI/old-loader compatibility check, and tests each packed consuming package in a clean project outside the repository. It verifies no installed common-auth remains, evaluates every non-host-only export, checks the host-only wrapper's relative specifiers, and drives the wrapper against harmless fixture entries. A workspace/file install failure is a stop, not an excuse to weaken the check. This campaign does not perform these adoption checks.

Quota and routing moved openai-auth titles (5809e38): every `sticky-routing.test.ts` title except one, two credit-budget titles from `sidebar-state.test.ts` plus its credit-budget fail-open `test.each` and three credit-budget admission titles from `integration.test.ts`, all as library-level tests in `test/routing/`. Not carried: `prefers the primary window, then snapshot, then cache entry timestamp` (the projection has no primary/snapshot split; replaced by `prefers the projection time, then the cache entry timestamp`) and `the credit reset competes with window resets for the earliest` (the library has no earliest-reset helper; each refusal carries its own gate's reset). Carried with changed assertions: exhausted `decideStickyBreak` decisions assert `window: { scope, label }` where openai-auth asserted `windowKey`, and `admission quota retains an exhausted-looking fallback after its reset passes` now asserts the credit-budget axis, because a window reading at 100% with a passed reset is refused at gate 4 in the library. The integration titles' request-path fixtures (sidebar file, fetch mocks) stay in openai-auth; the rest of `integration.test.ts` stays.

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

Quota and routing limits (declared, each pinned by a test named in sources.md):

- **routing.mode default:** an absent or unrecognised `routing.mode` routes `ordered` in roster order; legacy readers of the same config default to `main-first`. Mixed-version pools therefore route differently until the mode is set explicitly.
- **Unknown stored window length:** a limit stored without `windowMinutes` sorts last and carries no length; openai-auth assigned 300/10 080 minutes by slot.
- **Third window:** the sticky primitives weigh at most two readings per projection; further windows are judged by admission only.
