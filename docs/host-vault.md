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

An explicit `connect` still wins. Plugins that supply their own native connection
must omit it under host authority to use the relay; keep supplying it outside
Thalamus. A missing plugin id makes the default connection unavailable.
The existing `tokenPath` remains the plugin's normal per-host path, but no token
file is read under host authority.

Direct `ClaustrumScopedCustody` callers may omit `client` and supply
`pluginId?: string` for the same host default. An explicit client still wins.
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
Receipts retain their serving client for 401 reports. An unreachable vault still
permits the last good receipt; a vault that answers with a refusal drops the
cached receipt. Expiry margins and identity assertions are unchanged.

## Plugin adoption checklist

Every plugin must switch its authority reads to `vaultAuthority`, accept `host`
in OpenCode 2 login activation. On Pi, use the locked Pi-slot helper to save the
native login in its stash and replace the provider's `auth.json` slot with the
vault placeholder, just as for enrolled vault mode. The placeholder is a
non-secret sentinel from `placeholderSecret(provider)`, not a usable credential.
Host setup still installs it in OpenCode 2's provider auth slot and runs the
plugin's vault login: without that slot, OpenCode 2 does not route requests
through the plugin. A hosted vault login succeeds when the accessor is
available, without starting an enrollment ceremony. Shared menus show
**Served by Thalamus** and offer neither Connect nor Disconnect; setup refuses a
new connection with the same text.

The `/claustrum` constants `VAULT_HOST_STATUS: 'Served by Thalamus'` and
`VAULT_HOST_CONNECT_REFUSAL: 'Served by Thalamus'` keep those words consistent.
The shared account menu suppresses local account actions while hosted but keeps
plugin extras unchanged. Each plugin owner must remove or disable its own
Connect/Disconnect extras under `host`, and show `VAULT_HOST_STATUS`. Hosted
setup refuses before detection, enrollment, registration or local sign-in.

- **openai-auth:** pass `pluginId: 'openai-auth'` to its consumer; preserve reply
  usage reports and insula through the host client.
- **anthropic-auth:** pass `pluginId: 'anthropic-auth'` to its direct custody (or
  use `connectVaultHost('anthropic-auth')` once per connection and share that
  wrapped client between custody and `acquireInsulaQuotaSource`); keep assertion
  checks and use that client's insula transport, not a separate native vault route.
- **antigravity-auth:** pass `pluginId: 'antigravity-auth'` to its consumer; use
  the host insula transport rather than opening a separate daemon connection.
- **claustrum-auth:** pass `pluginId: 'claustrum-auth'` to its discovery hub;
  retain its classifier and per-host integration checks.

Audit process-wide consumers keyed on the connection file: hosted processes no
longer receive a connection file, so they must still construct/reuse the correct
per-plugin host consumer rather than silently skipping vault initialization or
sharing a consumer across plugin identities. Keep each plugin's existing writable
vault state folder for roster, pins and quota; do not relocate it merely because
the connection and enrollment token are no longer used.

Each plugin should pin fail-closed behavior with a test: marker present and
accessor absent must not serve, refresh, warm or poll any local account. No plugin
repository is changed by common-auth's relay support.
