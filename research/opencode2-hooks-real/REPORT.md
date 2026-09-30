# Real Codex backend: OpenCode 2 multi-account session hooks

**Verdict: hooks can carry multi-account OpenAI on OpenCode 2 without disabling prompt caching. A loopback transport is not needed for the cases measured here.** On `@opencode/cli` **2.0.20**, `gpt-5.6-luna`, low reasoning effort, the native WebSocket driver continued incrementally across tool calls and user turns. The one-account session reported **4,608 → 5,632 → 6,656 cached tokens** on successive turns. Switching accounts before turn 3 rotated the socket and sent **11 full-history input items, without `previous_response_id`**; the next user turn resumed incremental requests and reported **7,680 cached tokens**. Forced HTTP also switched accounts successfully and reached **7,680 cached tokens**. Quota readings followed the selected account on both transports.

This is a feasibility measurement, not a claim that cache hit rates equal OpenCode 1 in general. The switched request retained 4,608 cached tokens, rather than a complete miss; its history was uncached, and the next request still did not cache that history. The later turn did. One independent HTTP keep-warm replay succeeded, but its effect on cache lifetime is **not established**. Cancellation stopped observable output and disposed of the host's active connection; remote backend compute cannot be observed after disconnect.

## Setup, reproduction and evidence boundaries

Read `../opencode2-thin/REPORT.md` first. Its mock-backed recipe supplied the hook ordering, request attribution and retry policy; these runs exercised the real `https://chatgpt.com/backend-api/codex/responses` endpoint. Measurements ran on 2026-09-30, approximately 09:58–10:02 UTC.

```sh
node research/opencode2-hooks-real/run.mjs --self-test  # offline safety checks
node research/opencode2-hooks-real/run.mjs ws          # three turns + cancellation
node research/opencode2-hooks-real/run.mjs switch      # four turns, A A B B
node research/opencode2-hooks-real/run.mjs http        # A A B B, warm before turn 4
```

The harness reuses the temporary `oc2-mc582-deps` dependency installation if it is exactly 2.0.20, otherwise installs pinned dependencies **under the OS temporary directory, never in this checkout**. No package manifest or lockfile in the repository changed. The measured runs used the existing temporary dependency installation. All sessions selected `openai/gpt-5.6-luna`; configuration set `reasoningEffort: "low"`. The HTTP arm set `providers.openai.settings.transport: "http"`; the other arms explicitly selected `"websocket"` (the built-in ChatGPT plugin's default).

Every turn used this prompt, substituting the turn number:

> Turn 1. Run the bash tool exactly once with command seq 1 400. After the tool result, reply only done. Do not read or edit any files.

The host used its `shell` tool. Stored messages confirm exactly one completed `seq 1 400` call per turn, **1,492 characters** of output, about **808 tokens** in usage attribution. There were three such turns in the control and four in each switching session. Each turn required two agent-loop model requests: one tool call and one answer after the tool result. A fourth turn in the control was interrupted instead of using a tool.

### Credentials and isolation

A is the live `openai` access credential from `~/.local/share/opencode/auth.json`; B is the fallback entry labelled `ufuk` from `~/.config/opencode/openai-auth-state.json`. Labels A/B below are not account IDs. The launcher reads these two files once per run with a captured `node -e` subprocess, selecting only access token, account ID and expiry. The descriptors close immediately. **No real refresh token is printed, passed to the host, written, or used.** The temporary database receives A only, with `refresh: "not-a-refresh-token"`. The expiry guard takes the earlier of stored expiry and JWT expiry and refuses anything within an hour. Both passed, and the account IDs were distinct.

Implementation detail: rather than opening the live files in the plugin process, the launcher passes the selected access-only records in the child environment at startup. The plugin copies them into memory and deletes that environment entry. B is never persisted in the credential store. This avoids reopening live files in the host and preserves the read-once boundary; it does mean the access records are present in the child's initial environment. This is a research harness, not a production credential-delivery design.

The measurement launcher, plugin and CLI run from temporary copies, with temporary `HOME`, all inherited XDG variables replaced/removed, `XDG_RUNTIME_DIR`, `OPENCODE_DB`, `OPENCODE_CONFIG_DIR`, and `TMPDIR`. Only PATH is inherited into the host. The isolated launcher redirects stdout/stderr to a temporary file, so it does not inherit an AFT output descriptor under the real CortexKit data directory. The outer invocation is not part of the isolated process tree; it only waits and relays the finished summary. There is no loopback proxy on model traffic and no live configuration write. The server API binds to `127.0.0.1` with a throwaway password.

`lsof -n -P -p <launcher,host,descendants>` snapshots during the first turn and after each successful session, **before stopping the host**, found zero open descriptors under the real OpenCode/CortexKit config, data, cache or state prefixes:

| Run | During: timestamp / descriptors listed / forbidden hits | After: timestamp / descriptors listed / forbidden hits |
|---|---|---|
| WS control | 1790762327766 / 60 / **0** | 1790762347229 / 55 / **0** |
| WS switch | 1790762364728 / 57 / **0** | 1790762381632 / 56 / **0** |
| HTTP switch + warm | 1790762411103 / 59 / **0** | 1790762555172 / 54 / **0** |

The counts are `lsof` output line counts, including its header. The two credential files were read only during startup and were closed before these snapshots. These are open-file snapshots, not proof of every possible transient access.

### Plugin and evidence layout

`run.mjs` contains both launcher and plugin, copied to a temporary plugin package for each run. All seven hooks are scoped `{providerID: "openai"}`: `model.request`, `http.request`, `http.response`, `experimental.ws.handshake`, `experimental.ws.send`, `experimental.ws.receive`, `retry`.

- `model.request` records the chosen account under `sessionID:kind` and sets the account header. Titles use A; agent-loop requests follow the turn control, not a request counter, so both tool steps stay on the intended account.
- `http.request` and `experimental.ws.handshake` apply the bearer after host credentials. The driver owns socket affinity and continuation; the plugin does not rewrite WS input or continuation IDs.
- HTTP quota headers and WS `codex.rate_limits` are attributed through that record. HTTP SSE is observed with a pass-through transform, not consumed twice. Every hook call and every frame is timestamped; frame logs include type, continuation ID, input count and usage where present. Content deltas are not logged.
- Retry policy rotates away from a quota refusal before output and vetoes retry after output. Other errors are not retried in this live spike, to bound cost. No retry was exercised in the successful runs.

The file fence permits only this report and `run.mjs`. Consequently **scrubbed evidence is embedded below**, not committed as additional evidence files. Temporary roots were `oc2-hooks-ws-z3J1GF`, `oc2-hooks-switch-Og5NpE`, and `oc2-hooks-http-XKjHwg`. Each contains `scrubbed-hooks.jsonl`, `scrubbed-harness.jsonl`, `scrubbed-server.log`, `scrubbed-messages.json`, `scrubbed-lsof-{during,after}.txt`, and `summary.json`. Line references below name those scrubbed logs in the corresponding run. Raw temporary logs and the access-only database are not delivery artifacts. All committed evidence omits bearer values, account IDs and encrypted reasoning/turn-state payloads.

**Call count:** the three successful runs made **27 Codex requests**: WS control 7 agent-loop + 1 title; WS switch 8 agent-loop + 1 title; HTTP 8 agent-loop + 1 title + 1 independent warm. Two setup failures added **8 observed WS sends**, plus up to two uninstrumented title requests: **35 observed requests, 37 including the two inferred title attempts**. Those failed runs were not measurements. The first failed isolation because the launcher's inherited stdout/stderr pointed into AFT's real CortexKit data directory. Both failed plugin import because Bun's embedded `process.argv[1]` was not an ordinary filesystem path; the final harness guards against that and checks plugin setup after the first prompt. The first failed run sent one WS request before stopping; the second sent seven before its cancellation observer timed out. There was also one initial temporary-copy invocation that did not execute the harness and made no requests. No deliberate live quota exhaustion or refresh was attempted.

## 1. Caching over WebSocket, one account

Here and below, `step 1` is the tool call and `step 2` the answer after its result. Input/cached usage is the real `response.completed` usage, **not** the number of tokens in the outgoing incremental frame. The first request was full; every later request sent one new input item and a continuation ID.

| Turn / step | Mode / items | Input | Cached | Uncached | Send / completed log lines |
|---|---|---:|---:|---:|---|
| 1 / 1 | full / 1 | 5,615 | 4,608 | 1,007 | 6 / 55 |
| 1 / 2 | incremental / 1 | 6,478 | 4,608 | 1,870 | 58 / 70 |
| 2 / 1 | incremental / 1 | 6,524 | 5,632 | 892 | 73 / 93 |
| 2 / 2 | incremental / 1 | 7,367 | 5,632 | 1,735 | 96 / 108 |
| 3 / 1 | incremental / 1 | 7,413 | 6,656 | 757 | 111 / 131 |
| 3 / 2 | incremental / 1 | 8,254 | 6,656 | 1,598 | 134 / 146 |

Representative wire-hook evidence from the WS control:

```json
{"wall":1790762331509,"event":"ws.send","account":"A","kind":"primary","turn":2,"type":"response.create","previous_response_id":"resp_0de2351ade9e7882016abcdd594ea487d288730eb81a447fcc","input_items":1}
```

Its completed frame (line 93) reports `input_tokens: 6524`, `input_tokens_details.cached_tokens: 5632`. Host logs agree:

> `09:58:51.507Z message="session websocket reused"`
> `09:58:51.509Z message="session websocket sending" ... mode=incremental`

At turn 3, per-item usage attribution counts **all 808 tokens of turn 1's tool result as cached**, and 99/808 of turn 2's tool result. Thus the cache reads history, not only the static instructions/tools. The turn-2 hit barely extends past the static prompt: its turn-1 tool output is still uncached. Cache growth is not guaranteed at every step.

**Comparison with OpenCode 1/openai-auth:** `../opencode1-mc582/REPORT.md` arm A (OpenCode 1 with openai-auth, without Magic Context), `seq 1 400`, reports tool-loop inputs 6,313–6,351 with 4,608 cached, then turn-2 inputs 6,330–6,368 with **5,632 cached in three runs and zero in one**. This run's turn-2 **6,524 / 5,632** is comparable at the aggregate level. The host's native continuation preserves caching, with no plugin prewarm and no full resend between these turns. It does not prove equal cache efficacy: instructions, prompt text and generated tool-call reasoning differ, and there is one sample here. OpenCode 1's stronger tool-history result (4,223/5,078 tool-output tokens cached) used `seq 1 2000`, not this 400-line output; this measurement cannot replicate that claim.

## 2. Mid-session switch over WebSocket

The plugin changed A to B before turn 3, in the same host process and session. The host rotated its own socket, discarded the old continuation checkpoint and sent full history. There was no fallback to HTTP or backend error.

| Turn / step | Account | Mode / items | Input | Cached | Send / completed lines |
|---|---|---|---:|---:|---|
| 1 / 1 | A | full / 1 | 5,612 | 0 | 6 / 44 |
| 1 / 2 | A | incremental / 1 | 6,474 | 0 | 47 / 59 |
| 2 / 1 | A | incremental / 1 | 6,520 | 5,632 | 62 / 82 |
| 2 / 2 | A | incremental / 1 | 7,362 | 4,608 | 85 / 97 |
| 3 / 1 | B | **full / 11** | 7,366 | 4,608 | 100 / 118 |
| 3 / 2 | B | incremental / 1 | 8,197 | 4,608 | 121 / 133 |
| 4 / 1 | B | incremental / 1 | 8,243 | **7,680** | 136 / 154 |
| 4 / 2 | B | incremental / 1 | 9,074 | **7,680** | 157 / 169 |

Quoted host evidence:

> `09:59:33.770Z message="session websocket rotating" ... reason=affinity`
> `09:59:34.307Z message="session websocket connected"`
> `09:59:34.308Z message="session websocket sending" ... mode=full`
> `09:59:36.241Z message="session websocket reused"`
> `09:59:36.244Z message="session websocket sending" ... mode=incremental`

```json
{"wall":1790762374308,"event":"ws.send","account":"B","kind":"primary","turn":3,"type":"response.create","previous_response_id":null,"input_items":11}
```

**The expected account-history miss happened, but not as a zero-token aggregate miss.** B's switched request and its immediate tool continuation both cached 4,608 static instructions/tools tokens and **zero history tokens**, according to usage attribution. The following user turn read 7,680 cached tokens, including history. We therefore did **not** confirm that the very next request after switching caches the newly introduced history; recovery was observed on the next user turn. B was an already-used live account, so static-prefix hits must not be interpreted as cross-account cache sharing.

**Quota attribution:** all eight WS requests received `codex.rate_limits`: four A readings at primary **40%**, four B readings at **100%**. B's frames nevertheless said `allowed:true, limit_reached:false`; reported 100% is not itself a refusal. Example lines 86 and 101:

```json
{"wall":1790762371081,"event":"ws.receive","account":"A","turn":2,"type":"codex.rate_limits","quota":{"allowed":true,"limit_reached":false,"primary":{"used_percent":40,"window_minutes":10080,"reset_after_seconds":503401,"reset_at":1791265771},"secondary":null}}
{"wall":1790762375190,"event":"ws.receive","account":"B","turn":3,"type":"codex.rate_limits","quota":{"allowed":true,"limit_reached":false,"primary":{"used_percent":100,"window_minutes":10080,"reset_after_seconds":284316,"reset_at":1791046690},"secondary":null}}
```

The title's HTTP quota was A/40%. Each quota label came from the plugin's session/kind record, not a provider-supplied account identity. Distinct live quota/reset values corroborate the switch. Concurrent same-kind calls within one session were not tested.

## 3. Forced HTTP

All eight primary requests used HTTP. Every request was a full input without a continuation ID. The host's request still held its seeded A credential before the late hook; the plugin applied B for turns 3 and 4. There were no WS send frames in this arm.

| Turn / step | Account | Full input items | Input | Cached | Request / completed lines |
|---|---|---:|---:|---:|---|
| 1 / 1 | A | 1 | 5,612 | 0 | 4 / 46 |
| 1 / 2 | A | 4 | 6,471 | 4,608 | 48 / 58 |
| 2 / 1 | A | 6 | 6,517 | 4,608 | 60 / 78 |
| 2 / 2 | A | 9 | 7,360 | 5,632 | 80 / 90 |
| 3 / 1 | B | 11 | 7,366 | 4,608 | 92 / 108 |
| 3 / 2 | B | 13 | 8,197 | 6,656 | 110 / 120 |
| 4 / 1, after warm | B | 15 | 8,243 | 7,680 | 124 / 140 |
| 4 / 2 | B | 17 | 9,074 | 7,680 | 142 / 152 |

Quoted evidence, HTTP lines 92–93:

```json
{"wall":1790762422865,"event":"http.request","account":"B","kind":"primary","turn":3,"url":"https://chatgpt.com/backend-api/codex/responses","previous_response_id":null,"input_items":11}
{"wall":1790762423773,"event":"http.response","account":"B","kind":"primary","turn":3,"status":200,"quota":{"x-codex-primary-used-percent":"100","x-codex-primary-window-minutes":"10080","x-codex-secondary-used-percent":"0","x-codex-secondary-window-minutes":"0"}}
```

The quota excerpt omits reset fields. All four A primary responses carried 40%, all four B responses 100%; every response status was 200. HTTP's immediate B tool continuation hit 6,656 cached tokens, unlike the WS switch's 4,608. With one sample and provider routing variation, this is not evidence that HTTP is inherently better.

## 4. Keep-warm beside the host transport

Feasible as a separate plugin fetch; cache-lifetime benefit **undetermined**. After HTTP turn 3 completed, the harness waited **120,000 ms**. Inside the plugin, a timer replayed the last captured agent-loop HTTP body (13 input items, B) to the real Codex HTTP endpoint. It removed `max_output_tokens`, used `store:false`, `stream:true`, and low reasoning effort; it did not create a host session turn or alter the host's history. The response was drained to completion. It generated five output tokens, so this is a paid replay, not a zero-generation prewarm.

Quoted plugin evidence, lines 121–122, with usage reduced to its token counters:

```json
{"wall":1790762547424,"event":"warm.start","account":"B","input_items":13,"previous_response_id":null,"store":false,"max_output_tokens":"absent"}
{"wall":1790762549378,"event":"warm.complete","account":"B","status":200,"usage":{"input_tokens":8197,"input_tokens_details":{"cached_tokens":0},"output_tokens":5}}
```

The next real request started at 1790762549480, 102 ms after the warm completed, and reported **8,243 input / 7,680 cached**. Its tool continuation also hit 7,680. The warm itself hit **zero** cached tokens. These observations demonstrate that a separate fetch can replay a host body successfully and coexist with the host; they do **not** demonstrate that it prolonged the cache. There was no unwarmed same-delay control, and two minutes may be shorter than the backend's cache lifetime. No inference about a WS incremental body's suitability for HTTP replay is made: only a captured full HTTP body was replayed. A WS keep-warm would need full-body reconstruction or a validated continuation contract.

## 5. Cancellation over WebSocket

After the three control turns, the same session received:

> Do not use tools. Output integers 1 through 10000, one per line, with no explanation.

The driver reused its socket and sent an incremental request. The harness waited for its first `response.output_text.delta`, then posted to `/api/session/:id/interrupt`, waited for idle, and observed another three seconds before taking the after-run snapshot and stopping the host.

```json
{"wall":1790762343991,"event":"interrupt.start","firstDeltaWall":1790762343971}
{"wall":1790762344042,"event":"api","method":"POST","path":"/api/session/<session>/interrupt","status":200}
{"wall":1790762344044,"event":"interrupt.return"}
{"wall":1790762344049,"event":"api","method":"POST","path":"/api/experimental/session/<session>/wait","status":204}
{"wall":1790762347050,"event":"interrupt.observation.end"}
```

The last observed output delta timestamp was **1790762343980**, before the interrupt began. There were **zero received frames after interrupt start**, and **no `response.completed`** for the interrupted request. The interrupt API returned in 51 ms. The host logged:

> `09:59:03.996Z message="session websocket poisoned" ... code=incomplete active=false`

During-run `lsof` showed two ChatGPT-edge TLS descriptors to `104.18.32.47:443`; both were absent in the after-interrupt snapshot. A separate TLS descriptor to `172.66.173.149:443` remained. Combined with socket poisoning and the frame cutoff, this supports disposal of the active host connection. We did not capture the encrypted WS close frame or inspect backend server logs. **No further backend output reached the host; actual cessation of remote compute cannot be proven from a closed client connection.** This was one cancellation, not a soak or a pre-first-byte interrupt test.

## 6. Retry on a live rate limit

**Skipped deliberately.** A genuine rate-limit refusal cannot be induced safely with these live accounts without exhausting quota. The plugin includes the thin report's before-output reroute / after-output veto and observed **zero retries or `response.failed` frames** in these three successful runs. B's quota said 100% but `allowed:true`; that is not a retry test. Mock results from the earlier thin report are not promoted to real-backend evidence here.

## Verification and what remains unknown

- `node --check research/opencode2-hooks-real/run.mjs`: syntax check passed.
- `node .../run.mjs --self-test`: offline isolation and redaction tests passed. Neutralizing each control separately made exactly its corresponding test fail; the other stayed green. Mutations were restored before delivery.
- The three live commands completed; stored messages confirmed the intended model and completed tool calls. All successful-run during/after isolation snapshots passed.
- The final files were scanned without printing secrets for the JWT prefix and both account IDs; no matches. Headers in committed excerpts contain no bearer or account header values.
- Scoped AFT inspection could not provide TypeScript diagnostics because this worktree's native TypeScript package has no tsserver. This is a standalone JavaScript research harness; Node syntax checks, offline tests and real execution are the verification gates. No application TypeScript files changed.

Not settled: statistically comparable cache hit rates to OpenCode 1; a guaranteed cold account or cross-account cache isolation; instant history caching on the request immediately after a WS switch (not seen here); long-idle keep-warm efficacy; replay of WS incremental bodies over HTTP; production environment-token delivery; concurrent same-kind quota attribution; refused handshakes and automatic HTTP fallback; real rate-limit retries; backend compute after disconnect; cancellation before any response byte; repeated cancellation stability. The experimental WS hooks remain an API compatibility risk. For the measured account switch and native continuation paths, however, the real backend accepted the hook-based design and retained usable caching.
