#!/usr/bin/env bash
# Usage: ARM=A|B harness/run.sh <label> <prompt 1> [<prompt 2> ...]
# Starts one `opencode serve` for the arm (so the openai-auth WebSocket pool and
# its continuation state live in a single process across turns), sends each
# prompt as the next turn of ONE session, snapshots `lsof` of the server while
# it is alive, and stops the server.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/env.sh"
LABEL="$1"; shift
OUT="$ROOT/runs/$LABEL"; mkdir -p "$OUT"
PORT="${PORT:-$((4600 + RANDOM % 300))}"
cd "$PROJECT"
opencode serve --port "$PORT" --hostname 127.0.0.1 >"$OUT/serve.log" 2>&1 &
SERVE_PID=$!
trap 'kill $SERVE_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/config" >/dev/null 2>&1 && break; sleep 1; done
SID=""
n=0
for prompt in "$@"; do
  n=$((n + 1))
  date +%s%3N >"$OUT/turn$n.start"
  args=(run --attach "http://127.0.0.1:$PORT" --dir "$PROJECT" --format json \
    --model openai/gpt-5.6-luna --variant low)
  if [ -n "$SID" ]; then args+=(--session "$SID"); else args+=(--title "mc582-$LABEL"); fi
  opencode "${args[@]}" "$prompt" >"$OUT/turn$n.jsonl" 2>"$OUT/turn$n.stderr" || echo "turn $n exited $?" >>"$OUT/errors"
  date +%s%3N >"$OUT/turn$n.end"
  if [ -z "$SID" ]; then
    SID="$(jq -r 'select(.sessionID != null) | .sessionID' "$OUT/turn$n.jsonl" | head -1)"
    echo "$SID" >"$OUT/session_id"
  fi
  # The server and its direct children, so a child process spawned for a plugin is covered too.
  PIDS="$SERVE_PID $(pgrep -P "$SERVE_PID" | tr '\n' ' ' || true)"
  for p in $PIDS; do lsof -p "$p" 2>/dev/null; done >"$OUT/lsof.turn$n.txt" || true
done
curl -sf "http://127.0.0.1:$PORT/session/$SID/message" >"$OUT/messages.json" || true
# openai-auth buffers its log and a SIGTERM does not run its exit flush; give the
# buffer time to drain so the last request's usage diagnostic reaches the file.
sleep 6
kill "$SERVE_PID" 2>/dev/null || true
wait "$SERVE_PID" 2>/dev/null || true
echo "session $SID done: $OUT"
