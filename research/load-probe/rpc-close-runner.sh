#!/bin/sh
exec "$BUN_PROBE_RUNTIME" test test/fixtures/request-cancellation.test.ts test/fixtures/lifetime-isolation.test.ts test/rpc/request-errors.test.ts test/rpc/rpc-server.test.ts
