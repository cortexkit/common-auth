# Behaviour provenance

This table records the behaviour preserved when extracting shared machinery from the openai-auth, anthropic-auth and antigravity-auth plugins. A reference/ origin identifies a historical file in a supplied plugin snapshot, not a runtime dependency. new (neither copy) identifies library-specific behaviour rather than copied machinery. Test cells are unchanged bun:test titles; multiple behaviours may share a test. The common redaction set covers credentials independently of plugin identity; moved identity-redaction tests explicitly pass extraSecretKeys for chatgptaccountid, email, orgname and organizationname. Their failures do not imply those identity keys belong in the common set.

The quota and routing rows carry openai-auth titles from packages/opencode/src/tests/sticky-routing.test.ts, sidebar-state.test.ts and integration.test.ts at openai-auth 5809e38, rewritten as library-level tests over the quota projection (the integration titles went through the plugin request path; their equivalents call admission directly). Titles not carried, and carried titles whose assertions changed with the keyed quota model, are listed under the ./quota and ./routing adoption inputs in adoption-inventory.md.

The store rows (the `/store` account pool) are written fresh: no plugin had a shared account pool, so there are no plugin test titles to carry and their titles are new and their origin names the reference source a behaviour comes from, or new (neither copy). Their downgrade, mixed-version, lock and stamp rows run through a vendored copy of openai-auth's legacy store, `test/fixtures/legacy-openai-auth/accounts.ts`, taken from openai-auth `main` at commit 5809e38c335481199221b97c5af9a839693b274b (`packages/core/src/accounts.ts`; its last change to that file is 76c91238). Its entry points are `saveAccounts`, `mutateAccounts`, `withAccountStoreTransaction`, `saveAccountState`, `loadAccounts`, `migrateIfNeeded` and `isAccountStore`. Every private helper they reach (the storage, config and state normalisers and mergers, the account and quota normalisers, the roster-preservation and runtime-state helpers, `applyNewerTokenState`, `trustedRefreshStamp`, the save lock and its jitter, the JSON reader) is copied verbatim as contiguous line ranges of that file, each marked with its source range, so the copy is checkable as a diff against the commit. Only the import block is rewritten: the lock and atomic-write primitives come from this repository's `src/fs`, and `test/fixtures/legacy-openai-auth/stubs.ts` stands in for the custody symbols (`ClaustrumMode`, `CustodyTransitionState`, `custodyTombstoneKey`, `CUSTODY_OWNING_PROVIDER`, copied), the paths and provider types (copied), the logger (`createLogger`, stubbed silent) and the OAuth claim reader (`extractAccountId`, stubbed to return nothing). The one addition is a trailing `export { isAccountStore }`, which exposes the private discriminator without editing it.

| component | behaviour | origin | test |
| --- | --- | --- | --- |
| tooling | Source checker excludes skipped, failed and errored synthetic cases | new (neither copy) | source checker excludes skipped, failed and errored synthetic cases |
| tooling | Source checker decodes XML titles and strips describe prefixes | new (neither copy) | source checker decodes XML titles and strips describe prefixes |
| tooling | Source checker rejects empty tables and unmatched cells | new (neither copy) | source checker rejects empty tables and unmatched cells |
| tooling | Source checker matches exactly two cells from the real four-test JUnit fixture | new (neither copy) | source checker matches exactly two cells from the real four-test JUnit fixture |
| tooling | Installed range checker enumerates root and workspace globs and rejects drift | reference/openai-auth/scripts/check-installed-ranges.mjs | installed range checker enumerates root and workspace globs and rejects drift |
| fs | Classifies ENOENT EINVAL and ENOTDIR as lost marker races | reference/openai-auth/packages/core/src/refresh-file-lock.ts | classifies ENOENT EINVAL and ENOTDIR as lost marker races |
| fs | Acquisition writes private newline-terminated owner bytes | reference/openai-auth/packages/core/src/refresh-file-lock.ts | acquisition writes private newline-terminated owner bytes |
| fs | Eviction marker has a private distinct evicter identity | reference/openai-auth/packages/core/src/refresh-file-lock.ts | eviction marker has a private distinct evicter identity |
| fs | Reads expired legacy owner.json despite a fresh directory mtime | reference/openai-auth/packages/core/src/refresh-file-lock.ts | reads expired legacy owner.json despite a fresh directory mtime |
| fs | Creates a missing parent directory before acquiring the lock | reference/openai-auth/packages/core/src/refresh-file-lock.ts | creates a missing parent directory before acquiring the lock |
| fs | Allows only one contender when the parent directory is missing | reference/openai-auth/packages/core/src/refresh-file-lock.ts | allows only one contender when the parent directory is missing |
| fs | Does not let a stalled renewal overwrite a successor that stole its marker | reference/openai-auth/packages/core/src/refresh-file-lock.ts | does not let a stalled renewal overwrite a successor that stole its marker |
| fs | Does not let a stalled release remove a successor that stole its marker | reference/openai-auth/packages/core/src/refresh-file-lock.ts | does not let a stalled release remove a successor that stole its marker |
| fs | Waits for an in-flight renewal before release can remove the lock | reference/openai-auth/packages/core/src/refresh-file-lock.ts | waits for an in-flight renewal before release can remove the lock |
| fs | Rechecks ownership after the injected pre-write test hook before renewal writes | reference/openai-auth/packages/core/src/refresh-file-lock.ts | re-checks ownership after the renewal write seam before writing |
| fs | Relinquishes the lock when its marker is stolen after the final renewal check | reference/openai-auth/packages/core/src/refresh-file-lock.ts | relinquishes the lock when its marker is stolen after the final renewal check |
| fs | Preserves a successor record during post-write relinquish | reference/openai-auth/packages/core/src/refresh-file-lock.ts | preserves a successor record during post-write relinquish |
| fs | Reschedules after marker contention and advances the lease | reference/openai-auth/packages/core/src/refresh-file-lock.ts | reschedules after marker contention and advances the lease |
| fs | Reschedules after a renewal marker failure throws | reference/openai-auth/packages/core/src/refresh-file-lock.ts | reschedules after a renewal marker failure throws |
| fs | Retries release after recovering a stale marker | reference/openai-auth/packages/core/src/refresh-file-lock.ts | retries release after recovering a stale marker |
| fs | Elects one owner across 512 plain stale-lock contentions | reference/openai-auth/packages/core/src/refresh-file-lock.ts | elects one owner across 512 plain stale-lock contentions |
| fs | Lock paths and frozen writer constants preserve writer defaults | new (neither copy) | lock paths and frozen writer constants preserve writer defaults |
| fs | Contention waits and reports lock identity | new (neither copy) | contention waits and reports lock identity |
| fs | Newline-free live payload beats backdated mtime | new (neither copy) | newline-free live payload beats backdated mtime |
| fs | WithLock releases and stops renewal after fulfilment | new (neither copy) | withLock releases and stops renewal after fulfilment |
| fs | WithLock releases and stops renewal after rejection | new (neither copy) | withLock releases and stops renewal after rejection |
| fs | WithLock defaults to no renewal | new (neither copy) | withLock defaults to no renewal |
| fs | AssertOwned rejects foreign ownership | new (neither copy) | assertOwned rejects foreign ownership |
| fs | AssertOwned rejects expired ownership | new (neither copy) | assertOwned rejects expired ownership |
| fs | AssertOwned rejects unreadable ownership | new (neither copy) | assertOwned rejects unreadable ownership |
| fs | Atomic writer supports compact serialization | new (neither copy) | atomic writer supports compact serialization |
| fs | BeforeRename runs after staging and before commit | new (neither copy) | beforeRename runs after staging and before commit |
| fs | Renewal stages private owner bytes and atomically renames while assertOwned remains valid | reference/antigravity-auth/packages/core/src/file-lock.ts | renewal stages private owner bytes and atomically renames while assertOwned remains valid |
| fs | Atomic writer defaults to pretty JSON with newline and private mode | reference/openai-auth/packages/core/src/atomic-write.ts | atomic writer defaults to pretty JSON with newline and private mode |
| fs | Atomic writer cleans staging after write failure | reference/antigravity-auth/packages/core/src/atomic-write.ts | atomic writer cleans staging after write failure |
| fs | Atomic writer cleans staging after rename failure | reference/antigravity-auth/packages/core/src/atomic-write.ts | atomic writer cleans staging after rename failure |
| logger | Scrubs embedded eyJabc in place, preserving surrounding message text | reference/openai-auth/packages/core/src/logger.ts | scrubs embedded eyJabc in place while preserving surrounding message text |
| logger | Case-insensitive full-key redaction plus normalized apikey substring and secret/password/token suffix rules, preserving token counts | reference/openai-auth/packages/core/src/logger.ts | redacts the full case-insensitive key set and normalized secret key families |
| logger | Base leaves plugin identity keys visible; extraSecretKeys receives normalized keys and opts in to redaction | new (neither copy) | base redaction leaves plugin identity keys visible and extras receive normalized keys |
| logger | Tool schemas receive string scrubbing only, preserving secret-shaped property names | reference/openai-auth/packages/core/src/logger.ts | tool schemas scrub strings without redacting schema property names |
| logger | extraValuePatterns scrub matches in place without sharing caller regexp state | new (neither copy) | extra value patterns scrub every match in place without mutable regexp state |
| logger | Capture receives already-scrubbed message and payload | reference/anthropic-auth/packages/core/src/logger.ts | capture sink receives only scrubbed messages and payloads |
| logger | Rotates at 5 MiB, retains three generations and applies 0o600 to active and rotated files | reference/openai-auth/packages/core/src/logger.ts | rotates at 5 MiB keeping three private generations |
| logger | Flushes after fifty lines or the 500 ms deadline | reference/openai-auth/packages/core/src/logger.ts | buffers until fifty lines or the 500 ms flush deadline |
| logger | Resolves path and level providers dynamically, respecting the operator override | reference/openai-auth/packages/core/src/logger.ts | resolves host path and level providers at runtime with operator override |
| logger | Host-installed exit handler drains buffered lines synchronously | reference/openai-auth/packages/opencode/src/logger.ts | host-installed exit handler synchronously flushes buffered logs |
| logger | Redacts stable-ID variants while preserving internal accountId; the test passes extraSecretKeys covering chatgptaccountid, email, orgname, organizationname; not a common-set failure | reference/openai-auth/packages/core/src/logger.ts | redacts only the ChatGPT stable id, not the internal accountId key |
| logger | Redacts served identity; the test passes extraSecretKeys covering chatgptaccountid, email, orgname, organizationname; not a common-set failure | reference/openai-auth/packages/core/src/logger.ts | redacts served identity email and organization values from emitted log lines |
| logger | Redacts every credential shape while preserving internal accountId; the test passes extraSecretKeys covering chatgptaccountid, email, orgname, organizationname; not a common-set failure | reference/openai-auth/packages/core/src/logger.ts | writes no credential value when a command logs every secret shape at once |
| sidebar-file | Tolerant reads hand parsed JSON to the supplied normalizer | reference/openai-auth/packages/opencode/src/sidebar-state.ts | tolerant reads hand parsed JSON to the supplied normalizer |
| sidebar-file | Writes state atomically and cleans up temp files | reference/openai-auth/packages/opencode/src/sidebar-state.ts | writes state atomically and cleans up temp files |
| sidebar-file | Five concurrent writes are serialized; the final queued state wins | reference/openai-auth/packages/opencode/src/sidebar-state.ts | 5 concurrent writes with different lastUpdated values — last-chained state wins |
| sidebar-file | Rejects the failed operation but keeps the write queue usable | reference/openai-auth/packages/opencode/src/sidebar-state.ts | rejects the failed operation but keeps the write queue usable |
| sidebar-file | Merge rechecks new bytes and never writes the first result | reference/openai-auth/packages/opencode/src/sidebar-state.ts | merge rechecks new bytes and never writes the first result |
| sidebar-file | Merge retries three times then performs one final merge and write | reference/openai-auth/packages/opencode/src/sidebar-state.ts | merge retries three times then performs one final merge and write |
| sidebar-file | Supplied parent is hardened from 0755 to 0700 | new (neither copy) | supplied parent is hardened from 0755 to 0700 |
| sidebar-file | EPERM chmod warns once and still resolves the queued write | new (neither copy) | EPERM chmod warns once and still resolves the queued write |
| sidebar-file | Lost ownership before commit rejects the queue and leaves target and staging unchanged | new (neither copy) | lost ownership before commit rejects the queue and leaves target and staging unchanged |
| sidebar-file | Sidebar lock TTL is observed before commit | new (neither copy) | sidebar lock TTL is observed before commit |
| sidebar-file | Sidebar lock renews with unchanged owner and private mode | new (neither copy) | sidebar lock renews with unchanged owner and private mode |
| sidebar-file | Sidebar contention override rejects and queue recovers | new (neither copy) | sidebar contention override rejects and queue recovers |
| sidebar-file | Sidebar default contention waits 15000 ms | new (neither copy) | sidebar default contention waits 15000 ms |
| tui-prefs | Missing file returns empty object | reference/anthropic-auth/packages/opencode/src/tui-preferences.ts | missing file returns empty object |
| tui-prefs | Parses JSONC with comments and trailing commas | reference/anthropic-auth/packages/opencode/src/tui-preferences.ts | parses JSONC with comments and trailing commas |
| tui-prefs | Malformed file returns empty object | reference/anthropic-auth/packages/opencode/src/tui-preferences.ts | malformed file returns empty object |
| tui-prefs | Unterminated object returns empty object | reference/anthropic-auth/packages/opencode/src/tui-preferences.ts | unterminated object returns empty object |
| tui-prefs | Trailing garbage after object returns empty object | reference/anthropic-auth/packages/opencode/src/tui-preferences.ts | trailing garbage after object returns empty object |
| tui-prefs | Non-object root returns empty object | reference/anthropic-auth/packages/opencode/src/tui-preferences.ts | non-object root returns empty object |
| tui-prefs | Creates file with template on first write | reference/anthropic-auth/packages/opencode/src/tui-preferences.ts | creates file with template on first write |
| tui-prefs | Preserves comments and unrelated keys on update | reference/anthropic-auth/packages/opencode/src/tui-preferences.ts | preserves comments and unrelated keys on update |
| tui-prefs | Writes nested paths | reference/anthropic-auth/packages/opencode/src/tui-preferences.ts | writes nested paths |
| tui-prefs | Rapid sequential updates land the final value | reference/anthropic-auth/packages/opencode/src/tui-preferences.ts | rapid sequential updates land the final value |
| tui-prefs | No temp files are left behind | reference/anthropic-auth/packages/opencode/src/tui-preferences.ts | no temp files are left behind |
| tui-prefs | Fires after the file changes | reference/anthropic-auth/packages/opencode/src/tui-preferences.ts | fires after the file changes |
| tui-prefs | Observes a change after watcher return; test waits 25 ms, and the slice reported that an immediate asynchronous baseline regression was not caught | reference/anthropic-auth/packages/opencode/src/tui-preferences.ts | observes a change made immediately after the watcher returns |
| tui-prefs | Polls when directory watcher construction fails | reference/anthropic-auth/packages/opencode/src/tui-preferences.ts | polls when directory watcher construction fails |
| tui-prefs | Debounces bursts into few callbacks | reference/anthropic-auth/packages/opencode/src/tui-preferences.ts | debounces bursts into few callbacks |
| tui-prefs | Missing directory returns a no-op disposer | reference/anthropic-auth/packages/opencode/src/tui-preferences.ts | missing directory returns a no-op disposer |
| tui-prefs | Dispose stops callbacks | reference/anthropic-auth/packages/opencode/src/tui-preferences.ts | dispose stops callbacks |
| tui-prefs | Ignores sibling files that share the preferences name as a prefix | reference/anthropic-auth/packages/opencode/src/tui-preferences.ts | ignores sibling files that share the preferences name as a prefix |
| tui-prefs | Does not fire when the file is rewritten with identical content | reference/anthropic-auth/packages/opencode/src/tui-preferences.ts | does not fire when the file is rewritten with identical content |
| tui-prefs | Reader delegates plugin schema and defaults to the caller | new (neither copy) | reader delegates plugin schema and defaults to the caller |
| tui-prefs | Independent writers preserve both plugin updates under the shared lock | new (neither copy) | independent writers preserve both plugin updates under the shared lock |
| tui-prefs | Creates a caller supplied missing parent directory | new (neither copy) | creates a caller supplied missing parent directory |
| tui-prefs | Preferences contention waits 2000 ms, rejects, and the same queue recovers | new (neither copy) | preferences contention waits 2000 ms, rejects, and the same queue recovers |
| tui-prefs | Preferences TTL is 10000 ms in the staged write lease | new (neither copy) | preferences TTL is 10000 ms in the staged write lease |
| tui-prefs | Preferences renews its lease while a staged write is held | new (neither copy) | preferences renews its lease while a staged write is held |
| tui-prefs | Preferences ownership loss after staging rejects without committing or leaking a temp file | new (neither copy) | preferences ownership loss after staging rejects without committing or leaking a temp file |
| tui-build | Walk static imports, re-exports and literal dynamic imports without treating comments or ordinary strings as edges | new (neither copy) | walker parses static, re-export and literal dynamic imports while ignoring comments |
| tui-build | Ignore regex bodies and walk imports inside template expressions | new (neither copy) | walker distinguishes regex bodies and traverses template expressions |
| tui-build | Reject non-literal dynamic imports with file and specifier context | new (neither copy) | walker rejects non-literal dynamic imports and missing inline export targets with context |
| tui-build | Reject missing or unmapped inline export targets with subpath and resolved-target context | new (neither copy) | walker rejects non-literal dynamic imports and missing inline export targets with context |
| tui-build | Emit exactly the reachable closure, shared copies and selector; map every emitted file to an existing absolute source; preserve the earlier variant destination | new (neither copy) | linking emits the exact closure and compiles runtime JSX through the encoded Solid runtime |
| tui-build | Resolve inline subpaths directly through package exports and preserve named and default exports | new (neither copy) | linking emits the exact closure and compiles runtime JSX through the encoded Solid runtime |
| tui-build | Copy shared fs sources once and preserve LockContentionError identity across entry and sidebar consumers | new (neither copy) | inlined fs and sidebar consumers share one LockContentionError identity |
| tui-build | Never invoke the injected Solid-transform loader during a raw build | new (neither copy) | linking emits the exact closure and compiles runtime JSX through the encoded Solid runtime |
| tui-build | Compile runtime JSX through the encoded OpenTUI Solid runtime and load its transform once | reference/openai-auth/packages/opencode/scripts/build-tui.ts | linking emits the exact closure and compiles runtime JSX through the encoded Solid runtime |
| tui-build | Rewrite runtime-set imports in entry-closure and shared .ts files while retaining raw solid-js/store imports | new (neither copy) | linking emits the exact closure and compiles runtime JSX through the encoded Solid runtime |
| tui-build | Report the literal surviving external sets, excluding node: and encoded runtime ids | new (neither copy) | linking emits the exact closure and compiles runtime JSX through the encoded Solid runtime |
| tui-build | Resolve jsonc-parser from repo-scratch destinations and import an emitted non-TSX entry-reachable module and copied selector under bare Bun | new (neither copy) | linking emits the exact closure and compiles runtime JSX through the encoded Solid runtime |
| tui-build | Compare all emitted destination files with npm's actual publish list, respecting package.json files restrictions | new (neither copy) | publish-list compares the entire emitted destination including shared copies and selector |
| tui-build | Packed selector probes the exact encoded id, selects raw only for missing-registry errors, rethrows other errors without importing either entry, and returns default | reference/openai-auth/packages/opencode/src/tui/entry.mjs | packed tui selector probes the exact id and imports only the selected absolute entry |
| tui-build | Default selector importer loads caller-supplied absolute file URLs outside the library directory | new (neither copy) | default importer loads caller file URLs outside the library directory |
| tui-build | Reject relative entries before importing and name the offending option | new (neither copy) | selector rejects relative entries naming the offending option before importing |
| logger | Configured level and private log permissions | reference/openai-auth/packages/core/src/logger.ts | suppresses debug when level=info, includes warn |
| logger | Cycles preserve other fields | reference/openai-auth/packages/core/src/logger.ts | circular payload preserves non-circular fields and marks [Circular] |
| logger | Shared references are not cycles | reference/openai-auth/packages/core/src/logger.ts | diamond shared ref (no cycle) serializes fully without [Circular] |
| logger | Serialization failure does not throw | reference/openai-auth/packages/core/src/logger.ts | degrade-catch net still catches non-cycle throws (BigInt) and emits [unserializable] |
| logger | Compound credential keys are redacted | reference/openai-auth/packages/core/src/logger.ts | redacts compound secret keys (accessToken, apiKey, clientSecret, bearerToken, refreshToken) |
| logger | Safe camel-case fields remain visible | reference/openai-auth/packages/core/src/logger.ts | keeps non-secret camelCase keys (sessionKey, cacheKey, lastAccessAt) |
| logger | Token counts remain visible | reference/openai-auth/packages/core/src/logger.ts | keeps token COUNT keys (input_tokens, cached_tokens, output_tokens) unredacted |
| logger | No output before host initialization | reference/openai-auth/packages/core/src/logger.ts | writes nothing at all before a host calls initLogger |
| logger | Common credential fields are redacted | reference/openai-auth/packages/core/src/logger.ts | redacts simple secret keys (authorization, x-api-key, cookie, refresh, token) |
| logger | Scrubs structured tokens and keys | reference/openai-auth/packages/core/src/logger.ts | masks token-shaped values and secret keys in structured data |
| logger | Long manifest handles are scrubbed, short diagnostics preserved | reference/openai-auth/packages/core/src/logger.ts | redacts manifest handles embedded in messages without masking short ckh tokens |
| rpc | Writes and discovers live entry | reference/openai-auth/packages/opencode/src/rpc/port-file.ts | writePortFile then discover returns the entry for a live pid |
| rpc | Ignores dead processes | reference/openai-auth/packages/opencode/src/rpc/port-file.ts | discover ignores dead pids |
| rpc | Newest startedAt wins | reference/openai-auth/packages/opencode/src/rpc/port-file.ts | discover picks the newest startedAt among live entries |
| rpc | Expected live PID wins over newer entry | reference/openai-auth/packages/opencode/src/rpc/port-file.ts | discover returns live entry matching the expected pid instead of newer live entry |
| rpc | Missing expected PID falls back to newest | reference/openai-auth/packages/opencode/src/rpc/port-file.ts | discover falls back to newest live entry when expected pid matches none |
| rpc | No expected PID selects newest | reference/openai-auth/packages/opencode/src/rpc/port-file.ts | discover still picks newest live entry when expected pid is undefined |
| rpc | Dead expected PID is never selected | reference/openai-auth/packages/opencode/src/rpc/port-file.ts | discover never returns a dead pid even when it matches expected pid |
| rpc | Preserves PID for discovery matching | reference/openai-auth/packages/opencode/src/rpc/port-file.ts | writePortFile keeps the liveness pid available for matching |
| rpc | Sweep preserves usable live entries | reference/openai-auth/packages/opencode/src/rpc/port-file.ts | sweepRpcState removes a dead port file but leaves a live one untouched |
| rpc | Sweep removes unusable entries even with live PID | reference/openai-auth/packages/opencode/src/rpc/port-file.ts | sweepRpcState removes a port file that has a pid but no port |
| rpc | Sweep removes empty directories except active directory | reference/openai-auth/packages/opencode/src/rpc/port-file.ts | sweepRpcState removes an emptied project dir but never its active dir |
| rpc | Sweep supports legacy directory names | reference/openai-auth/packages/opencode/src/rpc/port-file.ts | sweepRpcState collects dead legacy state but preserves live legacy state |
| rpc | Sweep removes corrupt port records | reference/openai-auth/packages/opencode/src/rpc/port-file.ts | sweepRpcState removes a corrupt port file |
| rpc | Corrupt sibling does not endanger live record | reference/openai-auth/packages/opencode/src/rpc/port-file.ts | sweepRpcState leaves a valid live port file in a directory with a corrupt file |
| rpc | Corrupt-record unlink failure is tolerated | reference/openai-auth/packages/opencode/src/rpc/port-file.ts | sweepRpcState ignores an unlink failure for a corrupt port file |
| rpc | One ENOENT retry recovers concurrent directory removal | reference/openai-auth/packages/opencode/src/rpc/port-file.ts | writePortFile recovers when the directory is removed between mkdir and write |
| rpc | Persistent ENOENT stops after one retry | reference/openai-auth/packages/opencode/src/rpc/port-file.ts | writePortFile does not retry forever on a persistent ENOENT |
| rpc | Sweep continues through siblings | reference/openai-auth/packages/opencode/src/rpc/port-file.ts | sweepRpcState removes unusable entries and continues through sibling directories |
| rpc | Numeric startedAt is written and used; non-numeric values sort last rather than being rejected | new (neither copy) | numeric startedAt is written; non-numeric startedAt sorts last without rejection |
| rpc | Discovery unlinks dead usable records only | reference/openai-auth/packages/opencode/src/rpc/port-file.ts | discovery unlinks usable dead entries, ignores missing finite ports and preserves usable live entries |
| rpc | Directory prefix is escaped and legacy unprefixed names match | new (neither copy) | managed directory predicate treats prefixes literally and preserves unprefixed legacy names |
| rpc | Session reaches apply unchanged; health open and RPC authenticated | reference/openai-auth/packages/opencode/src/rpc/rpc-server.ts | apply callback receives sessionId unchanged; health is open and pending-notifications drains |
| rpc | Sessionless drain returns every notice without pruning | reference/openai-auth/packages/opencode/src/rpc/notifications.ts | a session-less notification drain delivers every notice but cannot prune another session |
| rpc | Stale server stop preserves successor; own matching record is removed | reference/openai-auth/packages/opencode/src/rpc/rpc-server.ts | stopping a stale server leaves its successor port file and health endpoint live |
| rpc | Body limit is one MiB | reference/openai-auth/packages/opencode/src/rpc/rpc-server.ts | rejects body exceeding 1 MB byte limit |
| rpc | Body limit counts bytes | reference/openai-auth/packages/opencode/src/rpc/rpc-server.ts | rejects multibyte body where byte length exceeds limit but string length does not |
| rpc | Stalled socket is reclaimed | reference/openai-auth/packages/opencode/src/rpc/rpc-server.ts | destroys a socket that stalls part-way through sending a request |
| rpc | Failed sweep does not block startup | reference/openai-auth/packages/opencode/src/rpc/rpc-server.ts | starts when the state sweep fails |
| rpc | Startup sweeps stale project state | reference/openai-auth/packages/opencode/src/rpc/rpc-server.ts | startup sweeps stale project state outside the active directory |
| rpc | secureDir true hardens RPC directory to 0700 | reference/openai-auth/packages/opencode/src/rpc/rpc-server.ts | creates a managed RPC directory with 0700 permissions |
| rpc | secureDir false preserves existing override permissions | reference/openai-auth/packages/opencode/src/rpc/rpc-server.ts | does not chmod a foreign RPC override directory |
| rpc | Slow apply survives the default inactivity period | reference/openai-auth/packages/opencode/src/rpc/rpc-server.ts | default timeout lets a slow apply handler respond before the socket is destroyed |
| rpc | Sessionless HTTP delivers both scopes, filters acknowledged IDs and prunes nothing | new (neither copy) | sessionless HTTP oracle retains every notice, filters acknowledged IDs and warns once |
| rpc | Two sessionless HTTP calls warn exactly once through logger capture | new (neither copy) | sessionless HTTP oracle retains every notice, filters acknowledged IDs and warns once |
| rpc | Stop independently checks token identity | new (neither copy) | stop port-file identity fence: different token |
| rpc | Stop independently checks port identity | new (neither copy) | stop port-file identity fence: different port |
| rpc | Registered servers isolate queue scope | new (neither copy) | two servers isolate notification queue scope |
| rpc | Client preserves wire session | reference/openai-auth/packages/opencode/src/rpc/rpc-client.ts | RPC client preserves sessionId through the server apply callback |
| rpc | Default client timeout is two seconds | reference/openai-auth/packages/opencode/src/rpc/rpc-client.ts | keeps the default call timeout at two seconds |
| rpc | Per-call timeout overrides default | reference/openai-auth/packages/opencode/src/rpc/rpc-client.ts | apply honors a per-call timeout override |
| rpc | Socket inactivity 90 s and request receipt 2 s are independent | reference/openai-auth/packages/opencode/src/rpc/rpc-server.ts | server wires 90 second inactivity and separate 2 second receipt defaults |
| rpc | Ordered one-time wire delivery | reference/openai-auth/packages/opencode/src/rpc/notifications.ts | push then drain returns the item once, ordered |
| rpc | Wire session receives own and global notices | reference/openai-auth/packages/opencode/src/rpc/notifications.ts | session scoping: a session only drains its own + global |
| rpc | Recent scoped drain indicates connection | reference/openai-auth/packages/opencode/src/rpc/notifications.ts | isTuiConnected reflects a recent drain within the window |
| rpc | Scoped drain does not connect an unscoped probe | reference/openai-auth/packages/opencode/src/rpc/notifications.ts | a drain for one session does not make an unscoped probe connected |
| rpc | Queue cap evicts oldest beyond 100 | reference/openai-auth/packages/opencode/src/rpc/notifications.ts | queue cap evicts oldest beyond 100 |
| rpc | Global notices survive one session acknowledgement | reference/openai-auth/packages/opencode/src/rpc/notifications.ts | a global notification reaches every session and is not pruned by one ack |
| rpc | Same-directory replacement serialized | reference/anthropic-auth/packages/opencode/src/rpc/server-registry.ts | serializes same-directory replacement and fences predecessor release |
| rpc | Stale registry release is identity-fenced | reference/anthropic-auth/packages/opencode/src/rpc/server-registry.ts | serializes same-directory replacement and fences predecessor release |
| rpc | Different directories are independent | reference/anthropic-auth/packages/opencode/src/rpc/server-registry.ts | does not serialize different project directories |
| rpc | Stop removes its own matching port and token record | new (neither copy) | stop port-file identity fence: matching identity |
| rpc | Root, prefix and registration each isolate queue scope | new (neither copy) | queue scope includes root, prefix and registration independently |
| quota | An older covering observation keeps a reading and an equal one tombstones it | new (neither copy) | an older covering observation keeps a reading and an equal one tombstones it |
| quota | A newer covering observation moves the tombstone and only a reading not older replaces it | new (neither copy) | a newer covering observation moves the tombstone and only a reading not older replaces it |
| quota | Coverage of one pair never touches another pair | new (neither copy) | coverage of one pair never touches another pair |
| quota | An omission older than a reading never deletes it | new (neither copy) | an omission older than a reading never deletes it |
| quota | A header-shaped partial observation leaves the family limit and the budget intact | reference/openai-auth/packages/opencode/src/sidebar-state.ts | a header-shaped partial observation leaves the family limit and the budget intact |
| quota | An older budget clear does not erase a newer budget reading | reference/openai-auth/packages/opencode/src/sidebar-state.ts | an older budget clear does not erase a newer budget reading |
| quota | An older budget reading does not undo a newer clear | reference/openai-auth/packages/opencode/src/sidebar-state.ts | an older budget reading does not undo a newer clear |
| quota | An equal-time budget observation applies | reference/openai-auth/packages/opencode/src/sidebar-state.ts | an equal-time budget observation applies |
| quota | A cleared budget clears only the budget | reference/openai-auth/packages/opencode/src/sidebar-state.ts | a cleared budget clears only the budget |
| quota | Covered absence records an unlimited key until a reading not older replaces it | new (neither copy) | covered absence records an unlimited key until a reading not older replaces it |
| quota | On equal checkedAt the observation applied last wins | reference/openai-auth/packages/opencode/src/sidebar-state.ts | on equal checkedAt the observation applied last wins |
| quota | Merge keeps reading metadata and preserves unknown top-level map keys | new (neither copy) | merge keeps reading metadata and preserves unknown top-level map keys |
| quota | Merge refuses a malformed stored map or observation without modifying its input | new (neither copy) | merge refuses a malformed stored map or observation without modifying its input |
| quota | Observation validation accepts the documented shape and rejects malformed parts | new (neither copy) | observation validation accepts the documented shape and rejects malformed parts |
| quota | A family request sees only its own family and all-models keys | new (neither copy) | a family request sees only its own family and all-models keys |
| quota | A family reading shadows the all-models entry per label, one entry per label | new (neither copy) | a family reading shadows the all-models entry per label, one entry per label |
| quota | A family tombstone or absence record does not hide an all-models entry | new (neither copy) | a family tombstone or absence record does not hide an all-models entry |
| quota | Limits are ordered longest stored length first with unknown lengths last | new (neither copy) | limits are ordered longest stored length first with unknown lengths last |
| quota | Each limit carries its stored length and an unknown length stays unknown | new (neither copy) | each limit carries its stored length and an unknown length stays unknown |
| quota | Mixed checkedAt projects the minimum reading time | new (neither copy) | mixed checkedAt projects the minimum reading time |
| quota | A reading projects its remaining percent; evidence carries no figures | new (neither copy) | a reading projects its remaining percent; evidence carries no figures |
| quota | A cleared budget projects no budget and a budget reading projects its signal | reference/openai-auth/packages/opencode/src/sidebar-state.ts | a cleared budget projects no budget and a budget reading projects its signal |
| quota | A quota map with every entry kind and a budget validates after a reload | new (neither copy) | a quota map with every entry kind and a budget validates after a reload |
| quota | Validation rejects a duplicated key, a malformed entry and a malformed budget | new (neither copy) | validation rejects a duplicated key, a malformed entry and a malformed budget |
| quota | The quota codec exposes validation and merge for the store | new (neither copy) | the quota codec exposes validation and merge for the store |
| routing | Admission quota skips a fallback whose credit budget is spent | reference/openai-auth/packages/opencode/src/sidebar-state.ts | admission quota skips a fallback whose credit budget is spent |
| routing | Admission quota preserves the last fallback when every credit budget is spent | reference/openai-auth/packages/opencode/src/index.ts | admission quota preserves the last fallback when every credit budget is spent |
| routing | Admission quota retains an exhausted-looking fallback after its reset passes | reference/openai-auth/packages/opencode/src/sidebar-state.ts | admission quota retains an exhausted-looking fallback after its reset passes |
| routing | A reached credit budget with a future reset exhausts the account | reference/openai-auth/packages/opencode/src/sidebar-state.ts | a reached credit budget with a future reset exhausts the account |
| routing | A healthy credit budget does not exhaust the account | reference/openai-auth/packages/opencode/src/sidebar-state.ts | a healthy credit budget does not exhaust the account |
| routing | Fails open on a reached credit budget with missing reset | reference/openai-auth/packages/opencode/src/sidebar-state.ts | fails open on a reached credit budget with missing reset |
| routing | Fails open on a reached credit budget with malformed reset | reference/openai-auth/packages/opencode/src/sidebar-state.ts | fails open on a reached credit budget with malformed reset |
| routing | Fails open on a reached credit budget with reset already past | reference/openai-auth/packages/opencode/src/sidebar-state.ts | fails open on a reached credit budget with reset already past |
| routing | A spent budget plus a live exhausted limit stays refused as the last one standing | new (neither copy) | a spent budget plus a live exhausted limit stays refused as the last one standing |
| routing | A spent budget whose only alternative has unknown quota is admitted as the last path | new (neither copy) | a spent budget whose only alternative has unknown quota is admitted as the last path |
| routing | An api-key row is a surviving path, so a spent budget beside it is refused | new (neither copy) | an api-key row is a surviving path, so a spent budget beside it is refused |
| routing | Gate 1: an api-key row is admitted without quota | new (neither copy) | gate 1: an api-key row is admitted without quota |
| routing | Gate 2: an OAuth row with no evidence for the scope needs a first reading and requests a pull | new (neither copy) | gate 2: an OAuth row with no evidence for the scope needs a first reading and requests a pull |
| routing | Gate 2: a no-reading sole OAuth candidate stays refused with its pull requested | new (neither copy) | gate 2: a no-reading sole OAuth candidate stays refused with its pull requested |
| routing | Gate 2: a family-only map refuses an all-scope request as needing a first reading | new (neither copy) | gate 2: a family-only map refuses an all-scope request as needing a first reading |
| routing | Gate 3: a missing required label is unknown for that window and the required-label input decides it | new (neither copy) | gate 3: a missing required label is unknown for that window and the required-label input decides it |
| routing | An all-models primary reading admits a family request | new (neither copy) | an all-models primary reading admits a family request |
| routing | Gate 4: an exhausted reading with a passed reset is refused unknown with a pull | new (neither copy) | gate 4: an exhausted reading with a passed reset is refused unknown with a pull |
| routing | Gate 4: an exhausted reading with a missing reset is refused unknown with a pull | new (neither copy) | gate 4: an exhausted reading with a missing reset is refused unknown with a pull |
| routing | Gate 4: an exhausted reading with an unparsable reset is refused unknown with a pull | new (neither copy) | gate 4: an exhausted reading with an unparsable reset is refused unknown with a pull |
| routing | Gate 4 leaves a reading below 100% admitted whatever its reset says | new (neither copy) | gate 4 leaves a reading below 100% admitted whatever its reset says |
| routing | Gate 5: an exhausted reading with a future reset is refused exhausted without a pull | new (neither copy) | gate 5: an exhausted reading with a future reset is refused exhausted without a pull |
| routing | A third window reaches admission and alone drives a refusal | new (neither copy) | a third window reaches admission and alone drives a refusal |
| routing | A reading older than the staleness threshold is admitted | new (neither copy) | a reading older than the staleness threshold is admitted |
| routing | A map holding only a tombstone or absence record for the requested pairs is admitted | new (neither copy) | a map holding only a tombstone or absence record for the requested pairs is admitted |
| routing | Covered absence admits as known-unlimited | new (neither copy) | covered absence admits as known-unlimited |
| routing | Gates apply in precedence order | new (neither copy) | gates apply in precedence order |
| routing | A rate-limit mark or refresh backoff excludes the row before the gates until it expires | new (neither copy) | a rate-limit mark or refresh backoff excludes the row before the gates until it expires |
| routing | The pull request is synchronous and never awaited | new (neither copy) | the pull request is synchronous and never awaited |
| routing | Fallback-first places the former main row last | reference/anthropic-auth/packages/core/src/routing.ts | fallback-first places the former main row last |
| routing | Main-first places the former main row first | reference/anthropic-auth/packages/core/src/routing.ts | main-first places the former main row first |
| routing | FormerMainId names the row the aliases move | new (neither copy) | formerMainId names the row the aliases move |
| routing | An absent or unrecognised mode resolves to ordered in roster order | new (neither copy) | an absent or unrecognised mode resolves to ordered in roster order |
| routing | Resolving a persisted routing mode leaves the persisted value unchanged | new (neither copy) | resolving a persisted routing mode leaves the persisted value unchanged |
| routing | Ordered honours roster order with reactive retry on the configured statuses | new (neither copy) | ordered honours roster order with reactive retry on the configured statuses |
| routing | Ordered stops on a status outside the configured retry set | new (neither copy) | ordered stops on a status outside the configured retry set |
| routing | Ordered applies the placement to admitted rows | new (neither copy) | ordered applies the placement to admitted rows |
| routing | Ordered refuses an exhausted row | new (neither copy) | ordered refuses an exhausted row |
| routing | Ordered dispatches the api-key row in a mixed pool | new (neither copy) | ordered dispatches the api-key row in a mixed pool |
| routing | A fresh healthy reading is dispatched end-to-end in ordered mode | new (neither copy) | a fresh healthy reading is dispatched end-to-end in ordered mode |
| routing | Ordered excludes a rate-limited row until its mark expires, then readmits it in its roster position | new (neither copy) | ordered excludes a rate-limited row until its mark expires, then readmits it in its roster position |
| routing | Ordered excludes a backed-off row until its retry time | new (neither copy) | ordered excludes a backed-off row until its retry time |
| routing | Ordered drops a killswitch-killed row | new (neither copy) | ordered drops a killswitch-killed row |
| routing | Keeps spendable capacity when the reset is unknown | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | keeps spendable capacity when the reset is unknown |
| routing | Uses the minimum reset duration for near resets | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | uses the minimum reset duration for near resets |
| routing | Keeps spendable capacity when the reset timestamp is past | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | keeps spendable capacity when the reset timestamp is past |
| routing | Keeps spendable capacity when the reset timestamp is invalid | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | keeps spendable capacity when the reset timestamp is invalid |
| routing | Returns zero at the reserve threshold | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | returns zero at the reserve threshold |
| routing | Prefers the projection time, then the cache entry timestamp | new (neither copy) | prefers the projection time, then the cache entry timestamp |
| routing | Migrates permanent authorization failures before quota ignorance | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | migrates permanent authorization failures before quota ignorance |
| routing | Migrates forbidden responses permanently | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | migrates forbidden responses permanently |
| routing | Retains an account with no quota snapshot | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | retains an account with no quota snapshot |
| routing | Retains an account with a stale snapshot | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | retains an account with a stale snapshot |
| routing | Retains an account with a malformed snapshot timestamp | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | retains an account with a malformed snapshot timestamp |
| routing | Migrates an exhausted fresh window with diagnostic reset metadata | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | migrates an exhausted fresh window with diagnostic reset metadata |
| routing | Treats a rate limit with healthy quota as transient | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | treats a rate limit with healthy quota as transient |
| routing | Treats a rate limit with no present fresh quota windows as transient | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | treats a rate limit with no present fresh quota windows as transient |
| routing | Treats server failures as transient | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | treats server failures as transient |
| routing | Treats indeterminate transport failures as transient | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | treats indeterminate transport failures as transient |
| routing | Retains a healthy account for non-routing client failures | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | retains a healthy account for non-routing client failures |
| routing | Does not migrate malformed exhausted-looking percentages | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | does not migrate malformed exhausted-looking percentages |
| routing | Does not migrate non-finite exhausted-looking percentages | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | does not migrate non-finite exhausted-looking percentages |
| routing | Skips healthy windows when a longer window is exhausted | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | skips healthy windows when a longer window is exhausted |
| routing | Reports the longest exhausted window when every window is exhausted | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | reports the longest exhausted window when every window is exhausted |
| routing | Names the exhausted limit by its label rather than the slot it occupies | new (neither copy) | names the exhausted limit by its label rather than the slot it occupies |
| routing | Omits non-string reset metadata from exhausted decisions | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | omits non-string reset metadata from exhausted decisions |
| routing | Never returns a hold action | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | never returns a hold action |
| routing | Migrates a fresh below-floor account when killswitchPasses is false | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | migrates a fresh below-floor account when killswitchPasses is false |
| routing | Keeps a stale snapshot when killswitchPasses is false (stale wins) | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | keeps a stale snapshot when killswitchPasses is false (stale wins) |
| routing | Keeps a no-quota account when killswitchPasses is false (unknown wins) | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | keeps a no-quota account when killswitchPasses is false (unknown wins) |
| routing | Migrates before exhaustion when the killswitch and exhaustion both apply | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | migrates before exhaustion when the killswitch and exhaustion both apply |
| routing | KillswitchPasses true is a no-op on the healthy path | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | killswitchPasses true is a no-op on the healthy path |
| routing | KillswitchPasses undefined is a no-op (killswitch disabled / not opted in) | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | killswitchPasses undefined is a no-op (killswitch disabled / not opted in) |
| routing | Tombstones and absence records never read exhausted | new (neither copy) | tombstones and absence records never read exhausted |
| routing | Migrates a pin on an account with a reached credit budget | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | migrates a pin on an account with a reached credit budget |
| routing | Retains a pin on a stale credit reading | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | retains a pin on a stale credit reading |
| routing | Retains a pin on a reached credit budget with a malformed reset | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | retains a pin on a reached credit budget with a malformed reset |
| routing | Retains a pin on a reached credit budget with a missing reset | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | retains a pin on a reached credit budget with a missing reset |
| routing | Retains a pin on a reached credit budget with a lapsed reset | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | retains a pin on a reached credit budget with a lapsed reset |
| routing | Decides a no-spend-control account exactly as today | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | decides a no-spend-control account exactly as today |
| routing | Trusts the reached boolean over a spent-looking percentage | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | trusts the reached boolean over a spent-looking percentage |
| routing | Admission and migration agree on a spent credit budget | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | admission and migration agree on a spent credit budget |
| routing | Excludes candidates with missing quota | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | excludes candidates with missing quota |
| routing | Excludes candidates with stale quota snapshots | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | excludes candidates with stale quota snapshots |
| routing | Uses the tightest present quota window as the account weight | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | uses the tightest present quota window as the account weight |
| routing | Selects the lower projected pressure | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | selects the lower projected pressure |
| routing | Changes the next pick when pending bytes change | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | changes the next pick when pending bytes change |
| routing | Resolves equal scores by configured order then account id | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | resolves equal scores by configured order then account id |
| routing | Never selects zero capacity over positive capacity | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | never selects zero capacity over positive capacity |
| routing | Falls back to configured order when every snapshot is stale | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | falls back to configured order when every snapshot is stale |
| routing | Notifies the caller when no weighted candidate survives | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | notifies the caller when no weighted candidate survives |
| routing | Prefers a positive optional reset-credit count in empty-set fallback | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | prefers a positive optional reset-credit count in empty-set fallback |
| routing | Rejects an empty input candidate list | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | rejects an empty input candidate list |
| routing | Excludes a killswitch-killed candidate from weighted placement | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | excludes a killswitch-killed candidate from weighted placement |
| routing | Excludes a killswitch-killed candidate from mode-fallback fail-open | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | excludes a killswitch-killed candidate from mode-fallback fail-open |
| routing | KillswitchPasses true is a no-op on placement | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | killswitchPasses true is a no-op on placement |
| routing | KillswitchPasses undefined is a no-op on placement (killswitch disabled) | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | killswitchPasses undefined is a no-op on placement (killswitch disabled) |
| routing | Tombstones and absence records add no weight | new (neither copy) | tombstones and absence records add no weight |
| routing | A third window adds no weight | new (neither copy) | a third window adds no weight |
| routing | Selection judges freshness by the minimum checkedAt of the projection | new (neither copy) | selection judges freshness by the minimum checkedAt of the projection |
| routing | Deprioritises a nearly-spent credit budget in cold placement | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | deprioritises a nearly-spent credit budget in cold placement |
| routing | Ignores a malformed credit reading instead of excluding the account | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | ignores a malformed credit reading instead of excluding the account |
| routing | Routes a candidate with no spend control by its rate-limit windows alone | reference/openai-auth/packages/opencode/src/core/sticky-routing.ts | routes a candidate with no spend control by its rate-limit windows alone |
| routing | Admission is not weighting: 95% used under a 10% reserve is admitted at zero weight via mode-fallback | new (neither copy) | admission is not weighting: 95% used under a 10% reserve is admitted at zero weight via mode-fallback |
| routing | 50% used is admitted and weighted ahead of a zero-weight row | new (neither copy) | 50% used is admitted and weighted ahead of a zero-weight row |
| routing | An all-unknown OAuth pool refuses every candidate while mode-fallback keeps returning one and ends as no admissible account | new (neither copy) | an all-unknown OAuth pool refuses every candidate while mode-fallback keeps returning one and ends as no admissible account |
| routing | A refusal re-runs selection with the id excluded and the pin retained | new (neither copy) | a refusal re-runs selection with the id excluded and the pin retained |
| routing | A pin whose quota turns unknown is refused but not deleted | new (neither copy) | a pin whose quota turns unknown is refused but not deleted |
| routing | A mixed pool dispatches the api-key row | new (neither copy) | a mixed pool dispatches the api-key row |
| routing | An exhausted row returned by mode-fallback is refused exhausted | new (neither copy) | an exhausted row returned by mode-fallback is refused exhausted |
| routing | A fresh healthy reading is dispatched end-to-end in sticky-balanced mode | new (neither copy) | a fresh healthy reading is dispatched end-to-end in sticky-balanced mode |
| routing | A supplied cross-process pending-bytes map changes the choice relative to the in-memory pins | new (neither copy) | a supplied cross-process pending-bytes map changes the choice relative to the in-memory pins |
| routing | Sticky-balanced excludes a rate-limited row entirely and readmits it after the mark expires | new (neither copy) | sticky-balanced excludes a rate-limited row entirely and readmits it after the mark expires |
| routing | Sticky-balanced excludes a backed-off row until its retry time | new (neither copy) | sticky-balanced excludes a backed-off row until its retry time |
| routing | Sticky-balanced leaves an unmarked row's order and weight unchanged by another row's mark | new (neither copy) | sticky-balanced leaves an unmarked row's order and weight unchanged by another row's mark |
| routing | A killed pinned row is routed around and its pin retained | new (neither copy) | a killed pinned row is routed around and its pin retained |
| routing | A pin on a valid row with an unknown identity survives | reference/openai-auth/packages/opencode/src/sidebar-state.ts | a pin on a valid row with an unknown identity survives |
| routing | A pin whose known identities differ is invalidated | reference/openai-auth/packages/opencode/src/sidebar-state.ts | a pin whose known identities differ is invalidated |
| routing | A pin whose row left the valid set is invalidated | reference/openai-auth/packages/opencode/src/sidebar-state.ts | a pin whose row left the valid set is invalidated |
| routing | An invalidated pin is replaced by a new assignment or cleared | new (neither copy) | an invalidated pin is replaced by a new assignment or cleared |
| routing | Pending bytes count only other sessions pinned on the current projection time | reference/openai-auth/packages/opencode/src/sidebar-state.ts | pending bytes count only other sessions pinned on the current projection time |
| store | A missing config loads as an empty pool | new (neither copy) | a missing config loads as an empty pool |
| store | A config without accounts is an empty roster and the first add writes the legacy shape beside the pool key | reference/openai-auth/packages/core/src/accounts.ts | a config without accounts is an empty roster and the first add writes the legacy shape beside the pool key |
| store | A legacy roster without the pool key is pending migration and every write refuses with both files unchanged | new (neither copy) | a legacy roster without the pool key is pending migration and every write refuses with both files unchanged |
| store | Malformed JSON, a non-object root and a newer schemaVersion in the config are load errors that refuse every write | new (neither copy) | malformed JSON, a non-object root and a newer schemaVersion in the config are load errors that refuse every write |
| store | A malformed or non-object state file beside a valid config is a load error that refuses every write | new (neither copy) | a malformed or non-object state file beside a valid config is a load error that refuses every write |
| store | A missing state file leaves a two-row roster loading without credentials and the first write creates it | new (neither copy) | a missing state file leaves a two-row roster loading without credentials and the first write creates it |
| store | A roster entry the legacy normaliser rejects survives a sibling write verbatim and is never a candidate | reference/openai-auth/packages/core/src/accounts.ts | a roster entry the legacy normaliser rejects survives a sibling write verbatim and is never a candidate |
| store | A malformed per-row entry survives a sibling write verbatim and is never a candidate | new (neither copy) | a malformed per-row entry survives a sibling write verbatim and is never a candidate |
| store | Load at the current schema version writes neither file | new (neither copy) | load at the current schema version writes neither file |
| store | Add, reload and a second add succeed with no host-slot or custody adapter | new (neither copy) | add, reload and a second add succeed with no host-slot or custody adapter |
| store | The unlocked legacy config read never observes a partial file during library writes | reference/openai-auth/packages/core/src/accounts.ts | the unlocked legacy config read never observes a partial file during library writes |
| store | Ids are kept verbatim and ids the legacy reader would rename are refused | reference/openai-auth/packages/core/src/accounts.ts | ids are kept verbatim and ids the legacy reader would rename are refused |
| store | Library writes preserve unknown pool keys and unknown per-row entry keys | new (neither copy) | library writes preserve unknown pool keys and unknown per-row entry keys |
| store | The row and provider-wide locks across a paused provider call renew while a contender fails | new (neither copy) | the row and provider-wide locks across a paused provider call renew while a contender fails |
| store | The store-lock list across one read-modify-write renews while a contender fails | new (neither copy) | the store-lock list across one read-modify-write renews while a contender fails |
| store | The row and provider-wide locks across a paused provider call expire so a contender acquires when renewal is off | new (neither copy) | the row and provider-wide locks across a paused provider call expire so a contender acquires when renewal is off |
| store | The store-lock list across one read-modify-write expires so a contender acquires when renewal is off | new (neither copy) | the store-lock list across one read-modify-write expires so a contender acquires when renewal is off |
| store | A refresh takes row, provider-wide and extra locks in order, never holds the store locks across the provider call, and releases in reverse after the hook | new (neither copy) | a refresh takes row, provider-wide and extra locks in order, never holds the store locks across the provider call, and releases in reverse after the hook |
| store | A row with no recorded identity takes its row lock under its local id | new (neither copy) | a row with no recorded identity takes its row lock under its local id |
| store | A provider failure reaches the failure hook before the outer locks release and fires no after-persist hook | new (neither copy) | a provider failure reaches the failure hook before the outer locks release and fires no after-persist hook |
| store | An extra lock held by a legacy holder makes the refresh wait and a rotation by that holder is the credential refreshed | reference/openai-auth/packages/core/src/accounts.ts | an extra lock held by a legacy holder makes the refresh wait and a rotation by that holder is the credential refreshed |
| store | An outer lease lost during a paused provider call fails the refresh without overwriting a successor rotation | new (neither copy) | an outer lease lost during a paused provider call fails the refresh without overwriting a successor rotation |
| store | An awaited refuse predicate refuses at each of its three sites and leaves the stored credential untouched | new (neither copy) | an awaited refuse predicate refuses at each of its three sites and leaves the stored credential untouched |
| store | The refuse predicate sees the stored refresh token | new (neither copy) | the refuse predicate sees the stored refresh token |
| store | A throwing after-persist hook returns the post-commit hook error with the committed credential and no failure hook | new (neither copy) | a throwing after-persist hook returns the post-commit hook error with the committed credential and no failure hook |
| store | Two rows with different known identities never overlap their provider calls | new (neither copy) | two rows with different known identities never overlap their provider calls |
| store | A row whose identity is recorded while it waits retries once under the identity key | new (neither copy) | a row whose identity is recorded while it waits retries once under the identity key |
| store | A row whose identity changes twice while its lock is taken aborts retryably | new (neither copy) | a row whose identity changes twice while its lock is taken aborts retryably |
| store | Adding an unknown-identity row waits for a running refresh while an api-key add does not | new (neither copy) | adding an unknown-identity row waits for a running refresh while an api-key add does not |
| store | A refresh records the identity it returns, the next refresh keys by it, and the quota recorded under the local id stays attached | new (neither copy) | a refresh records the identity it returns, the next refresh keys by it, and the quota recorded under the local id stays attached |
| store | Two unknown-identity rows with different fingerprints never merge or share a reading | new (neither copy) | two unknown-identity rows with different fingerprints never merge or share a reading |
| store | A refresh write-back revealing a duplicate disables the later row without deleting it | new (neither copy) | a refresh write-back revealing a duplicate disables the later row without deleting it |
| store | A replace started in another process waits for a paused refresh, which persists first | new (neither copy) | a replace started in another process waits for a paused refresh, which persists first |
| store | Add of an existing fingerprint rotates that row and returns its id without an epoch bump | new (neither copy) | add of an existing fingerprint rotates that row and returns its id without an epoch bump |
| store | Add with a different identity appends at the end | new (neither copy) | add with a different identity appends at the end |
| store | Add carrying an enabled row identity with a different fingerprint appends the row disabled with its credential on disk | new (neither copy) | add carrying an enabled row identity with a different fingerprint appends the row disabled with its credential on disk |
| store | Recording an identity another enabled row holds disables the later row in roster order without deleting it | new (neither copy) | recording an identity another enabled row holds disables the later row in roster order without deleting it |
| store | Replace does not dedupe, so two enabled rows may hold one credential until the next identity reading | new (neither copy) | replace does not dedupe, so two enabled rows may hold one credential until the next identity reading |
| store | Add refuses an id that already holds a credential | new (neither copy) | add refuses an id that already holds a credential |
| store | Replace bumps the epoch, records or clears identity and clears the quota map | new (neither copy) | replace bumps the epoch, records or clears identity and clears the quota map |
| store | An api-key row keeps its baseURL and header in the config and its key in the state | reference/openai-auth/packages/core/src/accounts.ts | an api-key row keeps its baseURL and header in the config and its key in the state |
| store | Ownership lost before the first write of add, replace and rotate refuses retryably with both files unchanged | new (neither copy) | ownership lost before the first write of add, replace and rotate refuses retryably with both files unchanged |
| store | Ownership lost before the second write of add is a partial commit that leaves the row without a credential | new (neither copy) | ownership lost before the second write of add is a partial commit that leaves the row without a credential |
| store | Ownership lost before the config write of rotate reports after-first-write with the rotated credential | new (neither copy) | ownership lost before the config write of rotate reports after-first-write with the rotated credential |
| store | Ownership lost before the state write of replace reports after-first-write with no committed credential | new (neither copy) | ownership lost before the state write of replace reports after-first-write with no committed credential |
| store | A failed disable and a failed record identity reach their failure hook before the first write | new (neither copy) | a failed disable and a failed record identity reach their failure hook before the first write |
| store | A failure hook that throws leaves the partial-commit failure intact and every lock released | new (neither copy) | a failure hook that throws leaves the partial-commit failure intact and every lock released |
| store | A legacy save lock holder at the config path makes a library write wait and then succeed | reference/openai-auth/packages/core/src/accounts.ts | a legacy save lock holder at the config path makes a library write wait and then succeed |
| store | A legacy save lock holder at the state path makes a library write fail with lock contention after its timeout | reference/openai-auth/packages/core/src/accounts.ts | a legacy save lock holder at the state path makes a library write fail with lock contention after its timeout |
| store | A legacy config writer waits for the library store locks and neither write is lost | reference/openai-auth/packages/core/src/accounts.ts | a legacy config writer waits for the library store locks and neither write is lost |
| store | A legacy state writer waits for the library store locks and neither write is lost | reference/openai-auth/packages/core/src/accounts.ts | a legacy state writer waits for the library store locks and neither write is lost |
| store | Two stores in one process adding concurrently lose no write | new (neither copy) | two stores in one process adding concurrently lose no write |
| store | A crash after the config write of add leaves a row without a credential that a re-run add completes at epoch 1 | new (neither copy) | a crash after the config write of add leaves a row without a credential that a re-run add completes at epoch 1 |
| store | A crash after the config write of replace leaves the bumped epoch with the prior credential and a survivor pull for the prior epoch fails attribution | new (neither copy) | a crash after the config write of replace leaves the bumped epoch with the prior credential and a survivor pull for the prior epoch fails attribution |
| store | A crash after the state write of rotate leaves the rotated credential and the next refresh completes the identity write-back | new (neither copy) | a crash after the state write of rotate leaves the rotated credential and the next refresh completes the identity write-back |
| store | A crash after the state write of a rotate with nothing to record is indistinguishable from completion | new (neither copy) | a crash after the state write of a rotate with nothing to record is indistinguishable from completion |
| store | A pull paused in a survivor still applies after another process rotated the row and crashed | new (neither copy) | a pull paused in a survivor still applies after another process rotated the row and crashed |
| store | A pull issued after a crash between replace writes captures the durable intermediate and applies until a re-run replace supersedes it | new (neither copy) | a pull issued after a crash between replace writes captures the durable intermediate and applies until a re-run replace supersedes it |
| store | A refresh paused in a survivor fails attribution when a replace intermediate lands during its provider call | new (neither copy) | a refresh paused in a survivor fails attribution when a replace intermediate lands during its provider call |
| store | Two processes adding rows concurrently lose no write | new (neither copy) | two processes adding rows concurrently lose no write |
| store | Every row operation and refresh called from an after-persist hook rejects immediately and the refresh still completes | new (neither copy) | every row operation and refresh called from an after-persist hook rejects immediately and the refresh still completes |
| store | Every row operation and refresh called from a refresh failure hook rejects immediately | new (neither copy) | every row operation and refresh called from a refresh failure hook rejects immediately |
| store | An after-persist hook rotating a row whose refresh waits for the provider-wide lock rejects at once and both refreshes finish | new (neither copy) | an after-persist hook rotating a row whose refresh waits for the provider-wide lock rejects at once and both refreshes finish |
| store | Reads and quota recording for any row complete normally from inside a hook | new (neither copy) | reads and quota recording for any row complete normally from inside a hook |
| store | A failed replace failure hook calling a same-row rotate and an other-row operation rejects both before any wait | new (neither copy) | a failed replace failure hook calling a same-row rotate and an other-row operation rejects both before any wait |
| store | Work a hook schedules on a timer or a detached promise is rejected while the caller continuation succeeds | new (neither copy) | work a hook schedules on a timer or a detached promise is rejected while the caller continuation succeeds |
| store | After the legacy saveAccounts every row keeps its credential and the pool key is unchanged | reference/openai-auth/packages/core/src/accounts.ts | after the legacy saveAccounts every row keeps its credential and the pool key is unchanged |
| store | After the legacy mutateAccounts every row keeps its credential and the pool key is unchanged | reference/openai-auth/packages/core/src/accounts.ts | after the legacy mutateAccounts every row keeps its credential and the pool key is unchanged |
| store | After the legacy withAccountStoreTransaction every row keeps its credential and the pool key is unchanged | reference/openai-auth/packages/core/src/accounts.ts | after the legacy withAccountStoreTransaction every row keeps its credential and the pool key is unchanged |
| store | After the legacy saveAccountState every row keeps its credential and the pool key is unchanged | reference/openai-auth/packages/core/src/accounts.ts | after the legacy saveAccountState every row keeps its credential and the pool key is unchanged |
| store | A config write omitting type or an api baseURL loses that row credential after one legacy mutateAccounts | reference/openai-auth/packages/core/src/accounts.ts | a config write omitting type or an api baseURL loses that row credential after one legacy mutateAccounts |
| store | A config write omitting addedAt loads the row without addedAt and keeps its credential | reference/openai-auth/packages/core/src/accounts.ts | a config write omitting addedAt loads the row without addedAt and keeps its credential |
| store | A config write omitting an x-api-key row authHeader loads it as authorization-bearer | reference/openai-auth/packages/core/src/accounts.ts | a config write omitting an x-api-key row authHeader loads it as authorization-bearer |
| store | An authHeader kept only in the state file is gone from the state after a legacy roster write | reference/openai-auth/packages/core/src/accounts.ts | an authHeader kept only in the state file is gone from the state after a legacy roster write |
| store | A row removed by the legacy writer loses its pool entry on the next library write and its id is refused for the rest of the process | reference/openai-auth/packages/core/src/accounts.ts | a row removed by the legacy writer loses its pool entry on the next library write and its id is refused for the rest of the process |
| store | A stale snapshot submitted after a rotation loses when the prior stamp is equal to the frozen clock and expiry is equal | reference/openai-auth/packages/core/src/accounts.ts | a stale snapshot submitted after a rotation loses when the prior stamp is equal to the frozen clock and expiry is equal |
| store | A stale snapshot submitted after a rotation loses when the prior stamp is slightly ahead of the clock and expiry is equal | reference/openai-auth/packages/core/src/accounts.ts | a stale snapshot submitted after a rotation loses when the prior stamp is slightly ahead of the clock and expiry is equal |
| store | An untrusted prior stamp is ignored, so the rotation is stamped within the trust bound and wins | reference/openai-auth/packages/core/src/accounts.ts | an untrusted prior stamp is ignored, so the rotation is stamped within the trust bound and wins |
| store | A trusted prior stamp at exactly the trust bound refuses the refresh retryably with no provider call and nothing written | reference/openai-auth/packages/core/src/accounts.ts | a trusted prior stamp at exactly the trust bound refuses the refresh retryably with no provider call and nothing written |
| store | The stamp refusal clears once the injected clock passes the prior stamp | reference/openai-auth/packages/core/src/accounts.ts | the stamp refusal clears once the injected clock passes the prior stamp |
| store | A longer and an equal-or-shorter provider expiry get the same pre-call verdict and are persisted verbatim | reference/openai-auth/packages/core/src/accounts.ts | a longer and an equal-or-shorter provider expiry get the same pre-call verdict and are persisted verbatim |
| store | Load and a reading request return while pulls that never resolve are pending | new (neither copy) | load and a reading request return while pulls that never resolve are pending |
| store | A rejecting pull reaches the store failure hook with phase pull and leaves needs-first-reading set | new (neither copy) | a rejecting pull reaches the store failure hook with phase pull and leaves needs-first-reading set |
| store | The pull hook fires on add of an enabled OAuth row and on replace, never for api-key or disabled rows | new (neither copy) | the pull hook fires on add of an enabled OAuth row and on replace, never for api-key or disabled rows |
| store | Load fires a pull once per process per row and a refresh re-read never fires one | new (neither copy) | load fires a pull once per process per row and a refresh re-read never fires one |
| store | A roster row appended by the legacy writer is a candidate and its first pull creates its entry at epoch 1 before issuing | new (neither copy) | a roster row appended by the legacy writer is a candidate and its first pull creates its entry at epoch 1 before issuing |
| store | A roster row whose entry was stripped is a candidate and its first pull creates its entry at epoch 1 before issuing | new (neither copy) | a roster row whose entry was stripped is a candidate and its first pull creates its entry at epoch 1 before issuing |
| store | A pull paused across a library replace is discarded when the identity is known | new (neither copy) | a pull paused across a library replace is discarded when the identity is known |
| store | A pull paused across a library replace is discarded when the identity is unknown | new (neither copy) | a pull paused across a library replace is discarded when the identity is unknown |
| store | A pull paused across a library rotation of the same account still applies | new (neither copy) | a pull paused across a library rotation of the same account still applies |
| store | A foreign writer removing and re-adding the id before the pull completes lets the pull apply | new (neither copy) | a foreign writer removing and re-adding the id before the pull completes lets the pull apply |
| store | A foreign writer replacing the credential in place leaves epoch and identity unchanged so the pull applies | new (neither copy) | a foreign writer replacing the credential in place leaves epoch and identity unchanged so the pull applies |
| store | A pull issued during a live replace captures the credential and its epoch in one locked read | new (neither copy) | a pull issued during a live replace captures the credential and its epoch in one locked read |
| store | Quota recording refuses a stale epoch with a retryable attribution failure | new (neither copy) | recordQuota refuses a stale epoch with a retryable attribution failure |
| store | The store persists observations through the quota codec and admission reads them back | new (neither copy) | the store persists observations through the quota codec and admission reads them back |
