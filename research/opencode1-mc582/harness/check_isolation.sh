#!/usr/bin/env bash
# Usage: harness/check_isolation.sh <evidence dir>
# Scans every lsof snapshot of the `opencode serve` process for open files under
# the operator's real OpenCode, openai-auth, Magic Context and CortexKit
# locations, and prints each hit with its file descriptor so inherited
# descriptors can be told apart from files the process opened itself.
set -uo pipefail
REAL_HOME="${REAL_HOME:-$HOME}"
REAL_TMP="${REAL_TMP:-${TMPDIR:-/tmp}}"
REAL_TMP="${REAL_TMP%/}"
PATTERN="$REAL_HOME/\.config/opencode|$REAL_HOME/\.local/share/opencode|$REAL_HOME/\.local/state/opencode|$REAL_HOME/\.cache/opencode|$REAL_HOME/\.config/cortexkit|$REAL_HOME/\.local/share/cortexkit|$REAL_HOME/\.local/state/cortexkit|$REAL_TMP/+opencode-openai-auth|$REAL_TMP/+opencode/magic-context"
for f in "$1"/*/lsof.turn*.txt; do
  total=$(($(wc -l <"$f") - 1))
  hits=$(grep -E "$PATTERN" "$f" | awk '{print "    fd " $4 " " $NF}')
  echo "$f: $total open files, $(printf '%s' "$hits" | grep -c . ) under real locations"
  [ -n "$hits" ] && printf '%s\n' "$hits"
done
