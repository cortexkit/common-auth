#!/usr/bin/env bash
# Usage: ARM=A|B harness/collect.sh <label> <dest dir>
# Copies one arm's evidence into the repo, scrubbed: request bodies and meta
# sidecars (the .request.json header sidecars are left out entirely), the
# openai-auth and Magic Context logs, OpenCode's stored messages, lsof snapshots
# and the analyzer output. Any JWT-looking string (base64 of '{"', i.e. "ey" + "J...")
# and the ChatGPT account id are replaced; the script fails if either survives.
# The prefix is assembled at runtime so this file itself never contains it.
JWT_PREFIX="ey""J"
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REAL_HOME="$HOME"
source "$HERE/env.sh"
LABEL="$1"; DEST="$2"
mkdir -p "$DEST/dumps"
ACCOUNT_ID="$(python3 - "$XDG_DATA_HOME/opencode/auth.json" <<'PY'
import base64, json, sys
payload = json.load(open(sys.argv[1]))["openai"]["access"].split(".")[1]
payload += "=" * (-len(payload) % 4)
claims = json.loads(base64.urlsafe_b64decode(payload))
print(claims["https://api.openai.com/auth"]["chatgpt_account_id"])
PY
)"
[ -n "$ACCOUNT_ID" ] && [ "$ACCOUNT_ID" != null ] || { echo "could not derive account id for scrubbing" >&2; exit 1; }
scrub() { # stdin -> stdout
  sed -E -e "s/${JWT_PREFIX}[A-Za-z0-9_=-]+(\.[A-Za-z0-9_=-]+)*/[REDACTED_JWT]/g" \
    -e "s/$ACCOUNT_ID/[REDACTED_ACCOUNT_ID]/g" \
    -e 's/("?[Aa]uthorization"?[:=] *"?)[^",}]+/\1[REDACTED]/g'
}
for f in "$ROOT"/dumps/*.body.json "$ROOT"/dumps/*.meta.json; do
  scrub <"$f" >"$DEST/dumps/$(basename "$f")"
done
scrub <"$OPENCODE_OPENAI_AUTH_LOG_FILE" >"$DEST/openai-auth.log"
[ -f "$MAGIC_CONTEXT_LOG_PATH" ] && scrub <"$MAGIC_CONTEXT_LOG_PATH" >"$DEST/magic-context.log"
RUN="$ROOT/runs/$LABEL"
for f in messages.json session_id turn1.jsonl turn2.jsonl lsof.turn1.txt lsof.turn2.txt errors; do
  [ -f "$RUN/$f" ] && scrub <"$RUN/$f" >"$DEST/$f"
done
python3 "$HERE/analyze.py" "$ROOT" | scrub >"$DEST/analysis.txt"
# Config snapshots (no secrets in them; auth.json is never copied).
mkdir -p "$DEST/config"
# openai-auth rewrites its own config at startup (it records mainAccountId),
# so it goes through the scrubber like everything else.
for f in "$OPENCODE_CONFIG_DIR/opencode.json" "$OPENCODE_OPENAI_AUTH_FILE" "$XDG_CONFIG_HOME/cortexkit/magic-context.jsonc"; do
  [ -f "$f" ] && scrub <"$f" >"$DEST/config/$(basename "$f")"
done
sed -i '' -e "s#$REAL_HOME#\$HOME#g" -e "s#${BASE_TMP%/}#\$TMPDIR#g" "$DEST/config/"* 
if grep -rl -e "$JWT_PREFIX" -e "$ACCOUNT_ID" "$DEST" >/dev/null; then
  echo "SCRUB FAILED in $DEST" >&2; exit 1
fi
echo "collected $DEST"
