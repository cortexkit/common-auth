# Architecture

common-auth is the library the CortexKit auth plugins share: openai-auth, anthropic-auth, antigravity-auth and claustrum-auth. It holds the parts every multi-account auth plugin needs and should not write four times: an account store, routing between accounts, limit tracking, Claustrum vault accounts, the OpenCode 2 hook installer, setup, the command menu, the quota sidebar, file locking and redaction.

It is published on npm as `@cortexkit/common-auth`. Each plugin takes it as a build-time devDependency and bundles it, so users never install it. Each feature is a separate subpath export (`./store`, `./claustrum`, `./opencode2`…), and a plugin adopts only the subpaths it uses. The library knows nothing about any one provider: the plugin supplies the provider's refresh and quota functions, its quota codec, its wording and its host wiring.

The optional peers load only when a plugin uses the subpath that needs them: `@cortexkit/claustrum-client` and `@cortexkit/subc-client` (vault), `@opencode/plugin` (OpenCode 2 types), and `@opentui/core`, `@opentui/solid` and `solid-js` (sidebar). On Windows, `@cortexkit/private-files` is loaded for owner-only files.

Paths below are relative to the repository root.

## Terms

- **Plugin, host:** a plugin is one auth plugin. A host is the program running it: OpenCode 1, OpenCode 2 or Pi.
- **Pool, row:** the account store. Each account is a row with a local id, a credential, the provider identity it signs in as (the wire identity) and a quota map.
- **Credential epoch:** a counter naming one credential lineage of a row. `add` or `replace` starts a new epoch; refreshes keep it. Work started for an older epoch is discarded.
- **Attribution:** what a pull or refresh captured about its row when it started (id, epoch, identity). Its result applies only while the row still matches.
- **Quota map, observation:** a row's quota readings keyed by (scope, label), for example (all models, `7d`). An observation is one new reading set plus the keys it speaks for.
- **Codec:** the plugin's functions that validate and merge its quota observations. The store stores quota maps without interpreting them.
- **Admission:** whether a row may serve a request now.
- **Pin:** in `sticky-balanced` routing, the row a session was placed on.
- **Limit mark:** a record that an account hit a limit, with its cause and reset. The **marks registry** holds them per store and shares them across processes.
- **Vault, enrollment, route, receipt:** the Claustrum vault holds credentials. An enrollment is a host's approved connection to it. A route is a vault account as a routing row; it holds no token. A receipt is what one send gets from the vault: a token and its record version.
- **Roster:** the vault accounts a host saw on its last list, with their quota, order and the user's declines. Stored in a roster file with no token.
- **Kept receipt:** the last receipt served for a vault account, held in memory to serve through a vault outage.
- **Hosted mode:** Thalamus started the host and provides the vault connection. Selected only by `CORTEXKIT_VAULT_HOST=thalamus`.
- **Placeholder:** a fixed non-secret value written into a host's own login slot so the host routes through the plugin. It's never a credential.
- **Owned request:** on OpenCode 2, a request whose active connection is the plugin's placeholder. Other requests pass through untouched.

## Code map

| Subpath | Where | Role |
|---|---|---|
| `./store` | `src/store/` | The account pool: rows, credentials, settings, refresh, quota writes, crash recovery. |
| `./quota` | `src/quota/` | Quota maps: merge, projection onto a request, codecs, the shared wording. |
| `./routing` | `src/routing/` | Pure admission, ordered routing, sticky-balanced placement and pin breaks. |
| `./limits`, `./limits/vault` | `src/limits/` | Limit signals, the marks registry, wait-or-switch decisions, fixed refusal wording. |
| `./claustrum` | `src/claustrum/` | Vault enrollment, discovery, per-send authorization, the roster, insula quota, hosted mode. |
| `./opencode2` | `src/opencode2/` | Installs the OpenCode 2 hooks that let a plugin choose accounts and decide retries. |
| `./pi-slot` | `src/pi-slot/` | Moves Pi's own login aside while the vault serves, and restores it. |
| `./setup` | `src/setup/` | The shared `setup` command: host detection, registration, vault enrollment. |
| `./commands`, `./auth-menu` | `src/commands/`, `src/auth-menu/` | The one slash-command menu model and its renderers; the terminal account menu. |
| `./quota-sidebar`, `./tui`, `./tui-build`, `./tui-prefs`, `./sidebar-file` | same names | The shared sidebar frame, TUI loading and build, TUI preferences, the sidebar state file. |
| `./routing-accessor` | `src/routing-accessor/` | Optional Thalamus routing advice, cache policy and turn notes. |
| `./cachekeep` | `src/cachekeep/` | The keep-warm scheduler and the cache-policy decision. |
| `./fs` | `src/fs/` | Atomic writes, file locks and leases, Windows owner-only files, a read cache. |
| `./logger`, `./redaction`, `./dump`, `./rpc` | same names | Logging, credential redaction, request dumps, the loopback RPC. |

`docs/adoption-inventory.md` lists every export and its parameters for adopting plugins; `docs/host-vault.md` and `docs/session-cache-policy.md` describe two opt-in contracts. `STRUCTURE.md` has the file map.

## The account store

`openPoolStore` (`src/store/pool.ts`) opens a pool over two files the plugin names: a **config file** with settings and the roster, and a **state file** with credentials. The pool lives under one top-level config key, `commonAuthPool` (rows, retired epochs); the state file stamps each credential with its row, epoch and identity under the same key. Every other top-level config key is a plugin setting. `updateSettings` edits settings under the store locks and refuses to change pool-owned keys (`version`, `accounts`, `commonAuthPool`), so rows change only through row operations. Keys the library doesn't know are kept on write, so older and newer readers of one file coexist.

**Locks.** A write takes, in this order: the row lock (keyed by the row's wire identity when known, else its id), the provider-wide lock when an operation can change identity keying, the caller's extra locks, then the store locks. The order is fixed because callers that hold legacy locks around a row write and a refresh of that row must acquire in one order or deadlock. Store locks wait up to 15 s, retry every 50 ms with jitter, and hold a renewed 10 s lease (`src/store/refresh-lock.ts`). A callback inside `updateSettings` that calls back into the store is refused (`PoolReentryError`).

**Crash safety.** A credential replace writes the state file first, stamped with the epoch and binding the config is about to get, then the config (`src/store/torn.ts`). A crash between the two leaves a credential stamped ahead of the config, and every reader completes that torn row forward. A row added under an id that was dropped starts past the dropped row's last epoch, so an attribution taken for the old row can never match the new one.

**Refresh and identity.** A refresh runs the plugin's provider function under the row lock and records the new token in one state write. If the refreshed token signs in as a different account than the row expects, the store keeps the new token (refresh tokens are often single-use, so discarding it would lose the account) but disables the row with an identity-contradiction reason and keeps the original identity. A plain enable can't lift it; only a replace with a verified credential can.

**Quota.** Pulls never make a caller wait (`src/store/pull.ts`): a pull captures the credential and attribution in one locked read, asks the provider, and records the result only if attribution still holds. Observations go through a writer that holds them per row in memory, visible to reads at once, and commits them in batches through the codec's `merge` (`src/store/quota-writer.ts`). Commits happen at most once every 30 s per store handle (`QUOTA_COMMIT_INTERVAL_MS`). A queue reaching 128 readings for one row commits at once, and disposal drains the queue. This keeps a busy host from writing its store after every response.

## Quota maps and wording

A quota map holds readings keyed by (scope, label). Merging applies an observation to a key when it is not older than what the key holds (`src/quota/merge.ts`), and a key the observation speaks for but carries no reading for counts as absent. Projection resolves one entry per label for a request's scope and keeps each entry's (scope, label), so a routing decision names the limit it judged (`src/quota/projection.ts`). `src/quota/format.ts` is the one quota wording every surface shows: menus, the terminal account menu and every plugin's sidebar.

## Routing

`src/routing/` is pure: callers pass rows, quota maps, marks and backoff, and get a decision; nothing is read or written.

- **Admission** (`admission.ts`): a marked or backed-off row is out first. Then, in order: an API-key row is admitted without quota; an OAuth row with no reading for the scope needs a first reading (refused, pull requested); a required label with no entry is unknown (refused, pull requested); a reading at or beyond 100% whose reset is missing or past is unknown, not exhausted. Unknown quota is never treated as headroom.
- **Ordered** (`ordered.ts`): admitted rows in a fixed order, moving to the next only on the caller's retry statuses. `main-first` and `fallback-first` are aliases that move the former main row to the front or back.
- **Sticky-balanced** (`sticky.ts`, `pins.ts`): a new session is placed by quota pressure weighed against how fast each account's windows can sustain spending, counting the bytes of sessions placed just before it. A pin breaks only when its row is confirmed unable to serve. The library persists no pin; the caller keeps pins and passes them in.

## Limits

`src/limits/` records why an account can't serve and decides what a request does about it.

- **Signals** (`signal.ts`, `header-classifier.ts`, `families.ts`): turn a provider response into a limit signal with a cause and, when the provider stated one, a confirmed reset. A retry hint alone confirms no exhausted window.
- **Registry** (`registry.ts`, `persistence.ts`, `pool-adapter.ts`, `vault-adapter.ts`): one marks registry per store namespace, persisted with the pool or the vault roster so other processes see the marks. A clear is fenced per cause, so clearing one cause can't erase a mark another cause still holds. Loading is time-boxed. When the registry can't load or agree with the store, it gives up for that store and the plugin serves without tracking; a limits problem never refuses a request.
- **Decision** (`decide.ts`, `presets.ts`, `hold.ts`): after a limit, wait on the same account or switch. A wait needs a confirmed reset that comes before the session's prompt cache expires, capped by the plugin's `routing.maxSameAccountWait` setting. Presets bundle a plugin's choices as data.
- **Host helpers:** `pi-wait.ts` waits inside a Pi stream with cancellation; `routing-hold.ts` computes the hold cap a runner sends to routing.
- **Wording** (`wording.ts`): refusal texts are fixed and carry no digits, labels or provider text, because OpenCode 1 and Pi retry errors whose text matches their retry patterns and would retry a local refusal forever.
- **Paths** (`path.ts`): a store's namespace key comes from its canonical path, resolved through the nearest existing folder, so two aliases of one folder agree before and after it exists.

## Claustrum vault

`src/claustrum/` serves a plugin's accounts from the vault instead of local credentials.

- **Enrollment** (`enrollment.ts`): only setup surfaces enroll; the request path never does. Setup proposes `<plugin>-<host>`, an operator approves it with `ck auth enroll approve` (CortexKit's command line), and setup polls. The token is written owner-only in the plugin's vault folder. `vaultAuthority` answers `host`, `vault`, `local` or `unreadable` and is read per operation, never cached at load. Anything but `local` is exclusive vault mode.
- **Consumer** (`consumer.ts`): one host's view of one provider's vault accounts. It turns vault records into routes, asks the vault for a receipt on every send, and reports a 401 against the exact record version that send used. Metadata reads are shared and coalesced; credential reads never are.
- **Custody and kept receipts** (`custody.ts`, `availability.ts`): the custody holds the last receipt per account in memory only. When the vault is unreachable, sends reuse it while it has more than a minute left (`KEPT_RECEIPT_MARGIN_MS`); API keys without expiry stay usable. An explicit vault refusal, the account leaving the roster, a disconnect, or a 401 on the kept token drops it at once. Only demonstrated transport failures count as unreachable; unknown error codes fail closed.
- **Hub** (`hub.ts`): one vault connection, one watch and one list per process for every provider a plugin serves; each provider keeps its own consumer and roster file. Processes don't elect a leader. Each lists for itself and commits through the per-path discovery lease and roster write lock, and a commit never replaces a view another process committed after this hub listed.
- **Roster** (`roster.ts`, `interlock.ts`, `quota-writer.ts`): the roster file holds routes, quota, order and declines, no token. A decline follows the provider account, so relabelling or re-adding an account doesn't lift it. Quota readings for one roster file go into one per-process queue, and one writer commits them, so consumers of the same file don't compete for its lock.
- **Watches, insula and usage** (`watch.ts`, `insula.ts`, `usage.ts`): with a watch open, the host re-reads only on a change notice and polls slowly as a safety net; without one it polls as before. Insula readings are matched by vault account id, and a miss is classified (cold, stale, upstream failed, credential, unreachable, absent) so a plugin polls the provider itself only when insula can't help. Reply quota is reported back to the vault for insula.
- **Hosted mode** (`host.ts`): with exactly `CORTEXKIT_VAULT_HOST=thalamus`, the authority is `host`. The consumer connects only through the client Thalamus installs at `globalThis[Symbol.for('cortexkit.vault')]`, looked up per connection, and refuses a direct client. No enrollment token is read.
- **Host slot** (`host-slot.ts`): the placeholder a host's own login slot holds under custody.
- **Shutdown** (`shutdown.ts`): disposal waits at most 2 s for background work, so a stuck vault or disk can't hold a host's shutdown.

## OpenCode 2 installer

OpenCode 2 sends requests over its own drivers; a plugin can only edit them through hooks. `install` (`src/opencode2/install.ts`) installs those hooks for a plugin's adapter (`src/opencode2/types.ts`):

- **Attempts:** `model.request` asks the adapter's `chooseAccount` for an account and opens an attempt, tagged by a header that `http.request` and `experimental.ws.handshake` read and remove, so it never reaches the wire. Quota headers, stream events and retries don't name the account, so every reading is attributed through its attempt.
- **Ownership:** only owned requests are touched. A session that mixed owned and host-owned requests is tainted until dispose: the installer leaves its retries to the host.
- **Retries:** `chooseAccount` is called once per attempt; a retry reuses that choice, and `dropChoice` releases a choice that went unused. Before output, a refused attempt may move to another account. After output, only `retrySameAccount` can continue, for a reply cut mid-read on the same account. A hold delays the retry, capped at `MAX_RETRY_HOLD_MS` (one hour plus jitter).

## Setup and menus

`runSetup` (`src/setup/command.ts`) is the `setup` command every plugin ships. It detects OpenCode and Pi, registers the plugin in the host's config, signs in locally or enrolls with the vault, and runs the plugin's hooks (`SetupPlugin` in `src/setup/types.ts`). It refuses to change a host while that host is running (`process-fence.ts`), waits at most 5 minutes for vault approval, and never writes an OpenCode 2 credential record or OpenCode 1 `auth.json`. A locally registered plugin is left as it is.

The command menu (`src/commands/`) is one model per plugin, rendered as an OpenCode dialog or with Pi's UI. Every payload a renderer gets passes through `seam.ts`, which projects each field from its definition and redacts the result, so an action can't leak a credential into a dialog. The built-in sections (Accounts, Quota, Routing, Limits) write only through store operations. `src/auth-menu/` is the terminal menu `opencode auth login` opens: OpenCode 1 passes `inputs` to `authorize` only from the CLI, which lets the CLI open a menu while the TUI keeps signing in as before.

## Sidebar and TUI

`./quota-sidebar` adapts projected quota to the shared `@cortexkit/opencode-sidebar` frame (Solid on OpenTUI), preserving the auth plugins' account views and slots. The adapter and frame ship as source, because each plugin compiles both with its own TUI against the host's runtime. `./tui-build` resolves and inlines the frame peer when reached, even with a custom inline list, and binds Solid and OpenTUI to the host's module registry so the plugin shares the host's one runtime. UI consumers install the optional frame peer for that build; `./quota` remains renderer-free. `./tui` loads the compiled or raw entry. `./sidebar-file` writes a plugin's sidebar state file under a lock and merges with writers that took over a lost lease. `./tui-prefs` reads and edits the JSONC preferences file in place, keeping comments.

## Files and locks

`src/fs/` is what every other module writes through:

- **Atomic writes** (`atomic-write.ts`): write a temp file created with mode 0600, then rename, with optional file and folder sync.
- **`withLock`** (`with-lock.ts`): a bounded lock beside its target (`<target>.<name>.lock`). On Windows, transient sharing and delete-pending errors while reading a lock are retried within the deadline.
- **Leases** (`refresh-file-lock.ts`): a renewable cross-process lease with an owner record. The record is staged and linked into place, so a crash never leaves an ownerless lease; filesystems without hard links fall back to create-then-write. Stale leases are removed only after re-reading that the record is unchanged, through a short-lived eviction marker. Leases use wall time only.
- **Windows owner-only files** (`private-files.ts`): on Windows, files are created through `@cortexkit/private-files`. If its native addon can't load, every operation fails closed with `ERR_PRIVATE_FILES_UNAVAILABLE` and writes nothing; there is no fallback to POSIX permission bits.
- **Read cache** (`file-read-cache.ts`): reuses a parsed file while its stat identity is unchanged. The roster and enrollment readers use it only off Windows, because a stat identity doesn't show a changed Windows owner or ACL, and those checks must run on every read.

## Load-bearing invariants

1. **The request path never waits on bookkeeping.** Pulls, quota commits, usage reports and roster writes run in the background and their failures are logged, never thrown into a request.
2. **Vault mode is exclusive and read per operation.** While authority is not `local`, no local credential is used; authority is never frozen at load.
3. **Only an explicit vault answer drops a kept receipt.** A transport failure keeps serving it until expiry; an unknown error code fails closed.
4. **Fixed lock order:** row, provider, extra, store. Changing it can deadlock plugins that hold legacy locks.
5. **Epoch and identity fence every late result.** A pull, refresh or quota reading for a replaced credential is discarded.
6. **Unknown quota blocks admission.**
7. **No credential in any error, log, dump, payload or refusal text**, and refusal texts carry no digits or labels.
8. **Windows fails closed** when owner-only files can't be guaranteed.
9. **Files stay readable by older and newer versions.** Unknown keys are kept, and new fields are additive.

## Failure handling

- **Lock contention:** bounded waits; a write that can't get its lock refuses with `lock-contention`, a background write retries.
- **Vault unreachable:** kept receipts serve until expiry; then the plugin refuses locally.
- **Insula missing or stale:** the miss class decides whether the plugin polls the provider itself.
- **Limits registry can't load:** tracking stops for that store; requests are served.
- **Crash mid-write:** torn rows complete forward; staged lease records never publish half-written.
- **Disposal:** background work gets 2 s, then shutdown continues with a warning.

## Development

Tests are in `test/`, by subpath, run with `bun test` (`bunfig.toml` preloads `test/setup-env.ts`, which clears `CORTEXKIT_VAULT_HOST` so no test runs hosted by accident). `scripts/gate.sh --fast` runs the quick checks. CI (`.github/workflows/ci.yml`) runs build, typecheck, lint and tests on Bun 1.3.14, 1.4.2 and 1.4.4, the hub tests on macOS, and the real OpenCode 2 placement test on Linux, macOS and Windows. `windows-private-files.yml` runs the Windows owner-only file and vault checks. `scripts/check-sources.mjs` checks `docs/sources.md`, the provenance table of behaviour taken over from the plugins, against the test results. Releases are tag-driven (`release.yaml`) and reuse the main-push CI of the tagged commit.
