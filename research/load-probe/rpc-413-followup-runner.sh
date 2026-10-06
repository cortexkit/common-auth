#!/bin/sh
# Run the entire impacted set so prior tests retain their effect on fetch pooling.
exec "$BUN_PROBE_RUNTIME" test test/fixtures/request-cancellation.test.ts test/fixtures/lifetime-isolation.test.ts test/rpc/request-errors.test.ts test/rpc/rpc-server.test.ts --preload ./research/load-probe/rpc-413-trace.mjs
