#!/bin/sh
# scripts/load-probe.mjs supplies `bun test FILE --test-name-pattern NAME`.
# Add the observer preload without changing test selection or timeout budgets.
exec "$BUN_PROBE_RUNTIME" "$@" --preload ./research/load-probe/rpc-413-trace.mjs
