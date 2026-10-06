#!/bin/sh
# Run the full suite for load-probe and return its exit code, with compact output.
# Keeping the full runner output in a file avoids overflowing Bun's stdout pipe
# with a single enormous JSON record when load-probe records a loaded run.
runtime="${BUN_PROBE_RUNTIME:?set BUN_PROBE_RUNTIME}"
output="${FIXED_WAITS_LOG_DIR:-/tmp}/fixed-waits-suite-$$.log"
junit="${FIXED_WAITS_LOG_DIR:-/tmp}/fixed-waits-suite-$$.xml"
"$runtime" --version
"$runtime" test --reporter=junit --reporter-outfile="$junit" > "$output" 2>&1
status=$?
tail -n 7 "$output"
printf 'runner exit code: %s; output: %s; JUnit: %s\n' "$status" "$output" "$junit"
if [ "$status" -ne 0 ]; then
  exit "$status"
fi
"$runtime" scripts/check-sources.mjs docs/sources.md "$junit"
