#!/usr/bin/env bash
# Run sequentially on the dedicated Linux host. The probe starts CPU-saturating
# busy-loop processes; do not run this script on a workstation.
set -u
phase=${1:?baseline or final}
for version in 1.3.14 1.4.2; do
  bun="$HOME/rt/bun-$version/bun"
  for workers in 0 16; do
    runs=5
    if [ "$workers" = 16 ]; then runs=10; fi
    while IFS='|' read -r key file name; do
      TEST_BUN="$bun" "$bun" scripts/load-probe.mjs "$file" "$name" "$runs" "$workers" > "$phase.$version.$workers.$key.jsonl" 2>&1
    done <<'CASES'
rpc|test/rpc/client-transport.test.ts|raw RPC transport bounds headers and response bodies before EOF
watcher|test/tui-prefs/watcher.test.ts|debounces bursts into few callbacks
stale|test/fs/refresh-file-lock.test.ts|elects one owner across 512 plain stale-lock contentions
commands|test/commands/sections.test.ts|accounts lists the roster in order with enabled state, identity and quota summary
provider|test/store/refresh.test.ts|two rows with different known identities never overlap their provider calls
legacy|test/store/rows.test.ts|a legacy state writer waits for the library store locks and neither write is lost
logger|test/logger/engine.test.ts|rotates at 5 MiB keeping three private generations
CASES
  done
done
