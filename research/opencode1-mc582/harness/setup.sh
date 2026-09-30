#!/usr/bin/env bash
# Usage: ARM=A|B harness/setup.sh
# Creates a fresh throwaway root for one arm. Seeds OpenCode's auth.json with the
# live openai ACCESS token and expiry only; the refresh token is deliberately
# invalid so nothing can rotate the real login. Never prints the token.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REAL_HOME_FOR_SETUP="$HOME"
source "$HERE/env.sh"
OA_DIST="file://$REAL_HOME_FOR_SETUP/Work/Projects/CortexKit/openai-auth/packages/opencode/dist/index.js"
MC_DIST="file://$REAL_HOME_FOR_SETUP/Work/Projects/CortexKit/magic-context/packages/plugin/dist/index.js"
LIVE_AUTH="$REAL_HOME_FOR_SETUP/.local/share/opencode/auth.json"

rm -rf "$ROOT"
mkdir -p "$OPENCODE_CONFIG_DIR" "$XDG_DATA_HOME/opencode" "$XDG_STATE_HOME" "$XDG_CACHE_HOME" \
  "$TMPDIR" "$ROOT/logs" "$ROOT/dumps" "$ROOT/state" "$PROJECT" "$MAGIC_CONTEXT_STORAGE_DIR" \
  "$XDG_CONFIG_HOME/cortexkit"
chmod 700 "$ROOT"

if [ "$ARM" = B ]; then PLUGINS="[\"$OA_DIST\", \"$MC_DIST\"]"; else PLUGINS="[\"$OA_DIST\"]"; fi
cat >"$OPENCODE_CONFIG_DIR/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "plugin": $PLUGINS,
  "model": "openai/gpt-5.6-luna",
  "small_model": "openai/gpt-5.6-luna",
  "autoupdate": false,
  "share": "disabled",
  "permission": { "bash": "allow", "edit": "deny", "webfetch": "deny" }
}
EOF
cat >"$OPENCODE_OPENAI_AUTH_FILE" <<EOF
{
  "webSockets": true,
  "rawWebSocket": false,
  "dump": true,
  "dumpDir": "$ROOT/dumps"
}
EOF
if [ "$ARM" = B ]; then
  cat >"$XDG_CONFIG_HOME/cortexkit/magic-context.jsonc" <<EOF
{
  // Only the main model requests should reach the provider during the measurement.
  "historian": { "disable": true },
  "dreamer": { "disable": true },
  "embedding": { "provider": "off" }
}
EOF
fi
umask 077
jq '{openai: {type: "oauth", access: .openai.access, expires: .openai.expires, refresh: "not-a-refresh-token"}}' \
  "$LIVE_AUTH" >"$XDG_DATA_HOME/opencode/auth.json"
echo "arm $ARM ready at $ROOT"
