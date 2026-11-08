# Vault access inside Thalamus

Thalamus starts a host with `CORTEXKIT_VAULT_HOST=thalamus`. Only that exact
value selects host authority. Use the `/claustrum` export
`vaultAuthority(paths: ClaustrumEnrollmentPaths, proposedName: string):
Promise<'host' | 'vault' | 'local' | 'unreadable'>` instead of
`enrollmentAuthority`. The latter is unchanged for compatibility. Read authority
per operation, including the final check before using a credential. Anything but
`local` is exclusive vault mode: local accounts must stay dormant even when the
host's vault is unavailable.

The host installs `globalThis[Symbol.for('cortexkit.vault')]`, a synchronous
function `(pluginId: string) => ClaustrumScopedClient`. Common-auth looks it up
at each connection, not at import, so a bridge that loads later can recover.
An accessor without the marker is ignored. With the marker, a missing or
throwing accessor means vault unavailable, never local mode.

## Connection options

`ClaustrumConsumerOptions` and `ClaustrumDiscoveryHubOptions` accept
`pluginId?: string` and `connect?: () => Promise<ClaustrumScopedClient>`.
For the default host connection supply the enrollment-name prefix:

- `openai-auth`
- `anthropic-auth`
- `antigravity-auth`
- `claustrum-auth`

Under host authority the relay is the only vault transport, even when the plugin
supplies an explicit `connect`. Plugins may leave their native `connect` in place:
it is ignored while hosted and used normally outside Thalamus. A missing plugin
id makes the hosted connection unavailable; it never falls back to native `connect`.
The existing `tokenPath` remains the plugin's normal per-host path, but no token
file is read under host authority.

Direct `ClaustrumScopedCustody` callers may omit `client` and supply
`pluginId?: string` for the same host default. Under host authority an explicit
client is accepted only if `connectVaultHost` returned it; a native client is
refused with `ClaustrumUnreachableError`, without opening another connection.
Outside host authority explicit clients work as before.
For callers that also need the client's insula transport, `/claustrum` exports
`connectVaultHost(pluginId?: string): ClaustrumScopedClient`. Call it once per
connection with the plugin id, then pass that same wrapped client to custody and
its `insula` to `acquireInsulaQuotaSource`. This is the normalized host connector;
plugins should not read the global directly. With no marker or plugin id it
throws `ClaustrumUnreachableError` without reading the global.
Custody's `tokenPath`/`readToken` is ignored while hosted. The empty enrollment argument
is only an interface placeholder; the host ignores it and it is never a vault
token. Do not synthesize a token or borrow another plugin's enrollment.

The host client has the existing `ClaustrumScopedClient` shape. Optional
`watchScoped`, `reportUsageScoped` and `insula` are used when supplied, with the
same polling/no-report fallback when absent. Host error shapes are normalized
only at this boundary: structured vault refusals become this package's
`ClaustrumCredentialError` without the host message, and relay loss becomes
`ClaustrumUnreachableError`. Native clients retain strict error identity.

`ClaustrumUnreachableError` has an optional, non-secret `reason`:
`host-accessor-missing` when the host accessor is not a function, or
`host-accessor-failed` when reading or calling
the accessor or wrapping its client throws. Other unreachable failures,
including a connection without the host marker or plugin id, have no reason.
The public message stays `Claustrum scoped operation unavailable`, the kind
stays `unavailable`, and `classifyVaultFailure` still returns `unreachable`.
A missing accessor at startup is expected to recover once the host bridge
installs; it still refuses requests until then and never permits local mode.
Plugins should log the reason alongside the fixed message to distinguish a
bridge that has not installed yet from a failed host connection.

Receipts retain their send-time enrollment argument for 401 reports. An
unreachable vault still permits the last good receipt; a vault that answers with a
refusal drops the cached receipt. Hosted receipts get the same expiry margins and
identity checks as receipts served over a direct vault connection.

After a relay outage, direct-custody callers can obtain a new wrapped client with
`connectVaultHost(pluginId)`, confirm it can read the vault's roster, then call
`custody.replaceClient(next)` on the existing custody before closing the old
client themselves. Replace only the connection to the same vault: receipts and
kept last-good receipts survive, and a 401 on an earlier fresh receipt goes through
the new client with its original credential id, record version and enrollment
argument (empty while hosted). Open roster watches automatically restart on
`next`, keeping their existing handles; the first notice asks for discovery to
cover the unwatched gap. Usage reports also follow the new client.
`replaceClient` closes neither client; `close()`/`dispose()` still closes the
client custody currently holds. Passing that same client is a no-op, and a
disposed custody refuses replacement.

## Plugin adoption checklist

Every plugin must switch its authority reads to `vaultAuthority`, and accept
`host` in OpenCode 2 login activation. On Pi, use `openPiSlot` from
`@cortexkit/common-auth/pi-slot` (it holds Pi's `auth.json` lock while it
writes) to save the native login in its stash and replace the provider's
`auth.json` slot with the vault placeholder, just as for enrolled vault mode. The placeholder is a
non-secret sentinel from `placeholderSecret(provider)`, not a usable credential.
Host setup still installs it in OpenCode 2's provider auth slot and runs the
plugin's vault login: without that slot, OpenCode 2 does not route requests
through the plugin. A hosted vault login succeeds when the accessor is
available, without starting an enrollment ceremony. Shared menus show
**Served by Thalamus** and offer neither Connect nor Disconnect. Setup refuses a
new connection with: “This host gets its vault accounts from Thalamus, so it can't
connect to the vault itself.”

The `/claustrum` constants `VAULT_HOST_STATUS: 'Served by Thalamus'` and
`VAULT_HOST_CONNECT_REFUSAL` (the full refusal sentence above) keep those words
consistent.
The shared account menu suppresses local account actions while hosted but keeps
plugin extras unchanged. Each plugin owner must remove or disable its own
Connect/Disconnect extras under `host`, and show `VAULT_HOST_STATUS`. Hosted
setup refuses before detection, enrollment, registration or local sign-in.

- **openai-auth:** pass `pluginId: 'openai-auth'` to its consumer; preserve reply
  usage reports and insula through the host client. Its native `connect` may stay.
- **anthropic-auth:** while hosted, use `connectVaultHost('anthropic-auth')` once
  per connection and share that wrapped client between direct custody and
  `acquireInsulaQuotaSource`. Do not pass its native client to hosted custody.
  Keep assertion checks and use that client's insula transport, not a separate
  native vault route. A direct-custody adopter that does not need the client for
  anything else may instead omit `client` and supply its `pluginId`.
- **antigravity-auth:** pass `pluginId: 'antigravity-auth'` to its consumer; use
  the host insula transport rather than opening a separate daemon connection.
  Its native `connect` may stay.
- **claustrum-auth:** pass `pluginId: 'claustrum-auth'` to its discovery hub;
  retain its classifier and per-host integration checks. Its native `connect`
  may stay.

Audit process-wide consumers keyed on the connection file: hosted processes no
longer receive a connection file, so they must still construct/reuse the correct
per-plugin host consumer rather than silently skipping vault initialization or
sharing a consumer across plugin identities. Keep each plugin's existing writable
vault state folder for roster, pins and quota; do not relocate it merely because
the connection and enrollment token are no longer used.

Each plugin should pin fail-closed behavior with a test: marker present and
accessor absent must not serve, refresh, warm or poll any local account. No plugin
repository is changed by common-auth's relay support.
