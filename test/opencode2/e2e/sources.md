# OpenCode 2 placement contract provenance

Rows for the gated tests in `placement.e2e.test.ts`. They run only with `COMMON_AUTH_OPENCODE2_E2E=1`, in the `opencode2-placement` CI job, which checks this table against its own JUnit artifact with `scripts/check-sources.mjs`. Every test also asserts that the plugin set up once, that every account was chosen in `model.request`, that no installer warning was logged, and that no request reached the mock provider with the host's placeholder credential or without an account.

| component | behaviour | origin | test |
| --- | --- | --- | --- |
| opencode2 placement | HTTP carries the chosen account per request and switches mid-session; quota lands on the right account | new (neither copy) | http carries the chosen account per request and switches mid-session |
| opencode2 placement | WebSocket carries the chosen account per socket and switches mid-session; quota frames land on the right account | new (neither copy) | websocket carries the chosen account per socket and switches mid-session |
| opencode2 placement | A WebSocket rate limit before output moves the turn to the next account | new (neither copy) | websocket refusal before output moves the turn to the next account |
| opencode2 placement | An HTTP usage limit the host would not retry moves the turn to the next account | new (neither copy) | http usage-limit refusal the host would not retry moves to the next account |
| opencode2 placement | A WebSocket refusal after output is not retried | new (neither copy) | websocket refusal after output is not retried |
| opencode2 placement | An HTTP refusal after output is not retried | new (neither copy) | http refusal after output is not retried |
