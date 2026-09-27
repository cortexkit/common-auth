# Spike 2: can a multi-account auth plugin run on OpenCode 2's built-in OpenAI driver?

Host under test: **`@opencode/cli` 2.0.18** (`opencode v2.0.18`), with `@opencode/core`, `@opencode/ai` and `@opencode/plugin` 2.0.18, pinned in `package.json`/`package-lock.json`. The harness was copied from the first spike (`common-auth/research/opencode2-transport/`) and extended. The first spike's scenarios can still be run with `node run.mjs --first-spike`.

## Short answer

**Yes, with caveats.** Every requirement in the brief was met in a live run against the loopback mock, using only session hooks. The host kept the transport: its own HTTP client, its own WebSocket and its own `previous_response_id` chaining. The plugin never opened a connection. Where the credentials must be written depends on the setup:

- **`model.request` headers alone are not enough whenever the host has its own credential for `openai`**, either an `apiKey` in the config or a stored ChatGPT login. The host applies its credential *after* `model.request`, so its `Authorization` replaces the plugin's. `chatgpt-account-id` from `model.request` still gets through. Writing the credentials in **`http.request`** (HTTP) and **`experimental.ws.handshake`** (WebSocket) works in every configuration tested, because both hooks run after the host has applied its own credential.
- **A rate-limit refusal can be moved to another account within the same turn.** The `retry` hook can force a retry with `delay: 0`, even for errors the host classes as non-retryable (`usage_limit_reached`), and every retry runs `model.request` again. After text has already streamed, `{retry:false}` stops the retry, and the text is not repeated.
- **Quota is readable** from `http.response` headers and from `codex.rate_limits` frames in `experimental.ws.receive`. The plugin can attribute each reading to an account through `sessionID` + `kind` and its own record of which account it chose for that request.

Risks come later in this report; the main ones are the experimental WebSocket hooks, a permanent switch to HTTP if the WebSocket handshake itself fails, and a retry hook that carries little context.

## How the evidence was produced

| File | Role |
|---|---|
| `mock-server.mjs` | A loopback mock of the Responses API (HTTP SSE and WebSocket) with two fake accounts: `tok-A`/`acct-A` and `tok-B`/`acct-B`. `identify` (line 158) labels every HTTP request and every WebSocket connection `A`, `B` or `none`. `none` means the token and the `chatgpt-account-id` do not both belong to the same account. It sends `x-codex-*` quota headers (`quotaHeaders`, line 169) and a `codex.rate_limits` frame before each WebSocket response (`rateLimitsFrame`, line 184, sent at line 337). The two accounts report different numbers: A reports 11 %/21 %, B reports 55 %/65 %. The mock can also refuse an account's agent-loop request (`rejects`, handled at lines 280-298 for HTTP and 335-353 for WebSocket). It records `previousKnownOnConnection` (line 326) to show whether a `previous_response_id` was issued on the same socket. |
| `plugin/accounts.js` | The stand-in multi-account plugin, registered from `plugin/index.js` when `SPIKE_MODE` contains `accounts`. Its hooks are scoped to `{providerID: "openai"}` (lines 78-79). `model.request` picks the account (line 97). The credentials are written in whichever hooks `SPIKE_AUTH_VIA` names: `model.request` (line 116), `http.request` (line 136) or `experimental.ws.handshake` (line 199). Quota is logged from `http.response` (line 162) and `experimental.ws.receive` (line 241). The `retry` hook reroutes or vetoes (lines 261-271). |
| `seed-credential.mjs` | Writes a fake ChatGPT OAuth credential (`access: "tok-HOST"`, `accountID: "acct-HOST"`) into the host's `credential` table. It uses the row shape the host's `Credential.create` writes. |
| `run.mjs` | Runs each scenario (the list starts at line 95). Scenarios with two turns use **server mode**: one `opencode2 serve` process with two `opencode2 run --server …` clients (the second uses `--continue`, `twoTurns` at line 92). The host's per-session socket and the plugin's memory therefore persist between turns. |
| `analyze.mjs` | Writes `evidence/<scenario>/digest.txt`. Each line there is prefixed with the raw file and line it condenses (for example `mock.jsonl:5`). |
| `evidence/<scenario>/` | `mock.jsonl` (what reached the wire), `plugin.jsonl` (hook calls), `stdout.jsonl` (session events), `stderr.log` (host logs), `config.json`, `summary.json`, `digest.txt`. |

Quotes below are from the raw evidence files, some trimmed with `…`. `file:line` refers to the scenario directory named in each section.

**Isolation.** This is unchanged from the first spike (`run.mjs` `isolatedEnv`, line 168). Each run gets a throwaway `HOME` and `XDG_*` directories under the OS temp directory. Only `PATH` is inherited. All outbound HTTP(S) goes to the dead proxy `http://127.0.0.1:9` (line 181), with `NO_PROXY` set for loopback. The proxy demonstrably blocked the host's own outbound calls: `message="Failed to fetch models.dev" … (GET https://models.opencode.ai/api.json) (cause: TypeError: Unable to connect…` (`q6-hook-scoping/stderr.log:77`). The only credentials are fake (`tok-A`, `tok-B`, `tok-HOST`, `sk-mock-not-a-real-key`). The real `~/.config/opencode`, `~/.local/share/opencode` and credential files were never read or written. Server mode uses the fixed loopback-only password `spike-loopback-only` (line 188). The first spike's `OPENCODE_DISABLE_DEFAULT_PLUGINS=true` is still set, but it has **no effect**: the built-in plugins were active (`acct.plugins … "count":89,"openai":[{"id":"opencode.provider.openai","status":"active"}…`, `q5-host-credential-model-request/plugin.jsonl:5`).

To reproduce: `cd spikes/opencode2-thin && npm ci && node run.mjs [scenario…] && node analyze.mjs`.

Host source locations are given as `core:<chunk>:<line>` (`node_modules/@opencode/core/dist/chunks/`) and `ai:<path>:<line>` (`node_modules/@opencode/ai/dist/`).

---

## 1. Per-request account choice

**Verdict: works with a caveat.** The pass condition holds when the credentials are written in `http.request` and `experimental.ws.handshake`, or in `model.request` when the host has no credential of its own. It fails when they are written only in `model.request` and the host has its own credential.

The plan was `A,B`: the first agent-loop request uses A, the second uses B. The title request uses A. Every scenario had two turns in one server process.

| Scenario | Where the credentials were written | Host credential | What the mock saw |
|---|---|---|---|
| `q1-http-model-request-nokey` | `model.request` | none | title A, turn 1 A, turn 2 B ✅ |
| `q1-http-model-request-apikey` | `model.request` | `apiKey` in config | all `none`: `token=sk-mock-not-a-real-key` with `chatgpt-account-id=acct-A`/`acct-B` ❌ |
| `q1-http-http-request-apikey` | `http.request` | `apiKey` in config | title A, turn 1 A, turn 2 B ✅ |
| `q1-ws-model-request-nokey` | `model.request` | none | title A, socket 1 A, socket 2 B ✅ |
| `q1-ws-model-request-apikey` | `model.request` | `apiKey` in config | both sockets `none` (`sk-mock…` + our account id) ❌ |
| `q1-ws-handshake-apikey` | `ws.handshake` (+ `http.request` for the title) | `apiKey` in config | title A, socket 1 A, socket 2 B ✅ |
| `q5-host-credential-all-hooks` | all three | stored ChatGPT login | title A, socket 1 A, socket 2 B ✅ (see §5) |

**HTTP.** When the host has no key, `model.request` headers reach the wire. `q1-http-model-request-nokey/mock.jsonl:3`: `"kind":"primary","identity":{"account":"B","token":"tok-B","accountHeader":"acct-B"}`. This follows `acct.model.request … "primaryCall":2,"account":"B"` (`plugin.jsonl:12`, from `accounts.js:118`). The answer came from B: `"text":"MOCK-HTTP-REPLY-3-acct-B"` (`stdout.jsonl:4`).

With a configured key, the plugin set `tok-A` in `model.request` (`q1-http-model-request-apikey/plugin.jsonl:6`), but `http.request` already shows the host's key: `"authorization":"sk-mock-not-a-real-key","chatgptAccountID":"acct-A"` (`plugin.jsonl:9`, from `accounts.js:140`). The mock recorded the same (`mock.jsonl:2`: `"identity":{"account":"none","token":"sk-mock-not-a-real-key","accountHeader":"acct-A"}`). Setting the header in `http.request` instead fixes it (`q1-http-http-request-apikey/mock.jsonl:2-3`: `"account":"A"`, then `"account":"B"`).

Why, from host source: `model.request` headers become `request.http.headers` (`core:config-f390r7qs.js:206-218`). The request's headers are then passed *into* the route's auth step, which overwrites `authorization` with the configured bearer (`ai:route/transport/http.js:28-37`, `ai:route/auth.js:17` `Headers.setAll(… {authorization: \`Bearer …\`})`). When there is no key and no stored credential, the host swaps in `Auth.none` (`core:config-n48ygd7x.js:280`), and the plugin's header passes through. A stored OAuth credential becomes the bearer (`nativeCredentialSettings`, `core:config-n48ygd7x.js:226-236`).

**WebSocket.** Headers from `model.request` go to the **handshake only**. The host builds the socket's connect headers from the same prepared (post-auth) HTTP headers (`ai:protocols/open-responses-channel.js:82-90`). Frames carry no credentials: `acct.ws.send … "authorizationInFrame":false` (`q1-ws-model-request-nokey/plugin.jsonl:10`, from `accounts.js:222`).

**Switching accounts opens a new socket and closes the old one.** Nothing reuses the old socket with the old identity, and nothing fails. From `q1-ws-model-request-nokey/mock.jsonl`:

> 2: `"action":"handshake","connection":1,…"identity":{"account":"A","token":"tok-A","accountHeader":"acct-A"}`
> 4: `"action":"closed","connection":1,"code":1000`
> 5: `"action":"handshake","connection":2,…"identity":{"account":"B","token":"tok-B","accountHeader":"acct-B"}`
> 6: `"action":"frame-in","connection":2,…"identity":{"account":"B",…},…"input_items":3`

The host logs it as `message="session websocket rotating" … reason=affinity` (`stderr.log:79`). The socket key is `url + sha256(sorted connect headers)` (`core:config-t8025hmx.js:53`). A different key closes the socket and opens a new one (`core:config-t8025hmx.js:190-206`). `experimental.ws.handshake` runs once per model call *before* the socket is chosen, so it can change the identity even for a request that would otherwise reuse the socket. It fired on the reused turn in `q4-ws-two-turns-control/plugin.jsonl:14`. With a configured key, the handshake hook overrode `Authorization`: `acct.ws.handshake kind=primary account=A before={"authorization":"sk-mock-not-a-real-key"} after={"authorization":"tok-A","chatgpt-account-id":"acct-A"}` (`q1-ws-handshake-apikey/digest.txt`, raw `plugin.jsonl:9`, from `accounts.js:200`).

Consequence (measured): after an account switch, the turn is sent in full, not incrementally, because the continuation checkpoint belongs to the old socket. Compare `input_items=3` with no `previous_response_id` on socket 2 (`q1-ws-model-request-nokey/mock.jsonl:6`) against the same-account continuation in §4. This is the correct behaviour, since a `previous_response_id` from account A means nothing to account B.

## 2. Quota capture

**Verdict: works.** Both sources are readable, and each reading can be attributed to an account and a session.

- **HTTP headers, via `http.response`**: `"kind":"primary","account":"A","status":200,"quota":{"x-codex-primary-used-percent":"11",…,"x-codex-secondary-used-percent":"21",…}` then `"account":"B",…"x-codex-primary-used-percent":"55",…"x-codex-secondary-used-percent":"65"` (`q1-http-model-request-nokey/plugin.jsonl:10,14`, from `accounts.js:162`). The header also arrives on a 429: `"status":429,"quota":{"x-codex-primary-used-percent":"100",…,"retry-after":"30"}` (`q3-http-ratelimit-reroute/plugin.jsonl:10`). Title requests carry quota too (`plugin.jsonl:7` in the same scenario).
- **The in-band WebSocket frame, via `experimental.ws.receive`**: `acct.ws.quota {"kind":"primary","account":"A","primary":11,"secondary":21}` and `{"kind":"primary","account":"B","primary":55,"secondary":65}` (`q1-ws-model-request-nokey/plugin.jsonl:11,16`, from `accounts.js:241`). The host handles the `codex.rate_limits` frame without error: every turn completed. The host's WebSocket driver passes any frame whose type does not start with `response.` through as a no-op (`ai:protocols/open-responses-channel.js:58-60`).
- **Attribution.** Neither the headers nor the frame name the account. Every hook payload carries `sessionID` and `kind`, and the plugin keeps "which account did I choose for `sessionID:kind`" from its own `model.request` (`accounts.js:85`, `117`). The numbers show that the attribution was right: A's 11/21 was filed under A, and B's 55/65 under B. On WebSocket this is unambiguous, because the host runs one exchange at a time per session socket (a per-session lock, `core:config-t8025hmx.js:345`). HTTP requests of the same kind running concurrently in one session were not exercised.

## 3. Rate-limit reroute within the same turn

**Verdict: works.** A refusal before any output becomes one turn with one answer, and that answer comes from B. After output has streamed, `{retry:false}` prevents a repeat.

Plan `auto`: A until A refuses. The mock refuses A's first agent-loop request once.

| Scenario | Refusal | Host's own decision | Plugin's decision | Result |
|---|---|---|---|---|
| `q3-http-ratelimit-reroute` | HTTP 429, `Retry-After: 30`, `rate_limit_exceeded` | `{"retry":true,"delay":30000}` | `{"retry":true,"delay":0}` | one answer, `MOCK-HTTP-REPLY-3-acct-B` |
| `q3-ws-ratelimit-reroute` | `response.failed` with `rate_limit_exceeded`, before output | `{"retry":true,"delay":2254}` | `{"retry":true,"delay":0}` | one answer, `MOCK-WS-REPLY-3-acct-B` |
| `q3-ws-ratelimit-no-retry-override` | same | `{"retry":true,"delay":1819}` | unchanged | one answer from B, after the host's own ~1.8 s backoff |
| `q3-http-usage-limit-reroute` | HTTP 429, `usage_limit_reached` | `{"retry":false}` | `{"retry":true,"delay":0}` | one answer, `MOCK-HTTP-REPLY-3-acct-B` |
| `q3-ws-usage-limit-reroute` | `error` frame, `status:429`, `usage_limit_reached` | `{"retry":false}` | `{"retry":true,"delay":0}` | one answer, `MOCK-WS-REPLY-3-acct-B` |
| `q3-ws-usage-limit-no-retry-override` | same | `{"retry":false}` | unchanged | turn fails: `"type":"provider.quota","message":"The usage limit has been reached"` |

The quotes are from each scenario's `plugin.jsonl` `acct.retry` line (from `accounts.js:275`) and `stdout.jsonl`. `q3-ws-ratelimit-reroute` end to end:

> `mock.jsonl:3` `"action":"frame-in","connection":1,…"identity":{"account":"A","token":"tok-A","accountHeader":"acct-A"}`
> `mock.jsonl:4` `"action":"injected-response.failed-ratelimit","connection":1,…"account":"A"`
> `plugin.jsonl:12` `acct.refusal-seen {"account":"A","via":"ws","type":"response.failed","outputSeen":false}` (from `accounts.js:256`)
> `plugin.jsonl:13` `acct.retry … "error":"{\"type\":\"provider.rate-limit\",…}","decisionBefore":{"retry":true,"delay":2254},"decisionAfter":{"retry":true,"delay":0},"reason":"reroute-away-from-A"`
> `plugin.jsonl:14` `acct.model.request … "kind":"primary","primaryCall":2,"account":"B"` ← **the retry ran `model.request` again**
> `mock.jsonl:6-7` a new socket, `connection":2`, `"identity":{"account":"B",…}`
> `stdout.jsonl:1-3` two `step_start` events with the **same** `messageID`, then a single `"text":"MOCK-WS-REPLY-3-acct-B"`

From host source: a `Retry` outcome loops back to `context.request.primary(...)`, which is `prepare()`, which runs the `model.request` hook again (`core:config-qs9wxzz9.js:247-305`). The hook sees the host's proposed decision even when the host would not retry, and whatever the hook returns is used, including a `delay` of 0 (`core:config-y3bfqnys.js:66-90`, hook call at line 85). A refusal classed `QuotaExceeded` (a 429 whose text contains "usage limit", `ai:provider-error.js:85,121-124`) is non-retryable by default, which the no-override run confirms.

**Refusal after output (`q3-ws-after-output-veto`, `q3-http-after-output-veto`).** The mock streams `PARTIAL-FROM-A ` and then fails with a rate limit. The plugin saw the delta in `ws.receive` / the wrapped `http.response` body (`acct.output-seen`, `accounts.js:250` / `177`) and vetoed the retry:

> `acct.retry … "outputSeen":true,"refused":true,…"decisionBefore":{"retry":true,"delay":1641},"decisionAfter":{"retry":false},"reason":"output-already-seen"` (`q3-ws-after-output-veto/plugin.jsonl:14`, from `accounts.js:268`)
> `stdout.jsonl:2` `"text":"PARTIAL-FROM-A "`, `stdout.jsonl:3` `"type":"error"…"provider.rate-limit"`. There was no second request (`mock.jsonl` has one frame), and the text was not repeated.

The HTTP variant behaves the same (`q3-http-after-output-veto/plugin.jsonl:13`, `stdout.jsonl:2-3`).

For comparison, **without the veto** (`q3-ws-after-output-no-retry-override`) the host does not repeat the text either. Once output has started, a retry becomes a `Continue` (`core:config-q3yb1nc4.js:170-171`, `core:config-qs9wxzz9.js:306-314`). The failed message keeps its partial text and an error. The host then sends the partial output plus a synthetic "continue" prompt as a **new** assistant message, and that message went out under B because `model.request` ran again: `mock.jsonl:7` `"connection":2,…"account":"B",…"input_items":3`, then `stdout.jsonl:4-5` a new `step_start` and `"text":"MOCK-WS-REPLY-3-acct-B"`. So after output, the plugin can choose between refusing and letting the host continue on the other account.

Caveats, from host source unless marked:

- **The `retry` hook carries little context**: `sessionID`, `agent`, `model`, `error`, `attempt` and `decision` (`@opencode/plugin` `promise/session.d.ts:121-128`). It has no `kind`, no response headers and no "output already started" flag. The plugin had to track refusal and output itself from `http.response`/`ws.receive`. That worked live, but it depends on those hooks, and the WebSocket ones are experimental.
- **The number of retries is capped.** The host's schedule allows 10 retries (`core:config-y3bfqnys.js:58-61`). After that it returns `{retry:false}` *without calling the hook* (lines 72-73, before the hook call at line 85), so a plugin cannot keep rerouting past 10 attempts in one step. Not exercised.
- **Some WebSocket recoveries bypass the hook.** A `previous_response_not_found` or `websocket_connection_limit_reached` rejection goes to `RecoverFull` before the retry hook runs (`core:config-q3yb1nc4.js:124-125`, `ai:protocols/open-responses-continuation.js:128-132`). Not exercised.
- **A failed WebSocket *connect* switches the whole session to HTTP for good.** If opening the socket fails (for example an account refused at the upgrade), the host sets `httpFallback = true` on the session and stays on HTTP (`core:config-t8025hmx.js:214-224`). The refusals tested here all came after the handshake. A refusal at the handshake itself was **not** tested.
- The title request's retry path was not exercised.

## 4. Frame rewriting and the host's continuation logic

**Verdict: works.** `q4-ws-send-mark-two-turns` adds one field, `spike_marker`, to every outgoing frame in `experimental.ws.send` (`accounts.js:219`). The run has two turns on account A in one server process. The rewrite reached the wire, and the second turn still chained:

> `mock.jsonl:3` `"frame-in","connection":1,…"keys":[…,"spike_marker",…]`, no `previous_response_id`
> `mock.jsonl:4` `"frame-in","connection":1,…"previousKnownOnConnection":true,"body":{…"previous_response_id":"resp_ws_c1_2",…"input_items":1…}`
> `stderr.log:79-80` `message="session websocket reused"`, then `message="session websocket sending" … mode=incremental`
> `stdout.jsonl:2,4` `MOCK-WS-REPLY-2-acct-A`, `MOCK-WS-REPLY-3-acct-A`

The control run without the rewrite (`q4-ws-two-turns-control/mock.jsonl:3-4`) is identical except for the added key.

From host source: the continuation baseline is the driver's own request as it was **before** the send hook ran (`ai:protocols/open-responses-continuation.js:104-121`). The hook replaces only the text that goes out (`core:config-t8025hmx.js:234`). A rewrite applied the same way to every frame therefore stays in step. A rewrite that touches `input` or `previous_response_id`, or that is applied to some frames but not others, would leave the server's view out of step with the host's diff; the host's own type docs say this is the plugin's responsibility (`@opencode/plugin` `promise/session.d.ts:93-96`). Not exercised.

## 5. Coexisting with the host's own `opencode.provider.openai`

**Verdict: works with a caveat.** The plugin's `model.request` runs after the built-in one and wins for every header except `Authorization`. `Authorization` has to be overridden in `http.request`/`experimental.ws.handshake`, just as with a configured key (§1).

A fake ChatGPT login (`access: "tok-HOST"`, `accountID: "acct-HOST"`, method `chatgpt-browser`) was stored with `seed-credential.mjs`. The run started the server once to create the database, stopped it, inserted the row, and started it again (`run.mjs:256-280`). The row: `seeded credential rows [{"integration_id":"openai","label":"spike fake ChatGPT login","active":1}]` (`q5-host-credential-model-request/stderr.log:6`). The model is `gpt-5.5`, because with a ChatGPT login the built-in plugin disables older models (`core:config-fyxb352w.js:199-219`, source only).

**What the built-in plugin sets, and in which order (live):**

- In `model.request` it adds `originator: opencode` and `session-id`, and it runs **before** our hook. Our hook already sees them: `acct.model.request … before={"originator":"opencode","session-id":"<ses>"}` (`q5-host-credential-model-request/plugin.jsonl:6`). Source: `core:config-fyxb352w.js:221-228`, registered with `{providerID: "openai"}`.
- Through `provider.transform` it adds `originator`, `x-codex-beta-features: remote_compaction_v2` and `chatgpt-account-id: <stored account>` as provider headers, and sets `transport` to `websocket` unless one is configured (`core:config-fyxb352w.js:180-198`). At our handshake hook: `before={"originator":"opencode","x-codex-beta-features":"remote_compaction_v2","chatgpt-account-id":"acct-A","session-id":"<ses>","authorization":"tok-HOST"}` (`plugin.jsonl:9`). **Our `chatgpt-account-id` beat the provider-level `acct-HOST`**, because request headers are merged over provider defaults (`ai:route/client.js:77`). **The stored access token beat our `Authorization`.**
- On the wire with only `model.request`: `"token":"tok-HOST","accountHeader":"acct-A"` and `originator=opencode` (`q5-host-credential-model-request/mock.jsonl:1-3,5-6`), so the identity is `none`.
- With `http.request` + `ws.handshake` as well (`q5-host-credential-all-hooks`): `mock.jsonl:1` title `"account":"A"`, `mock.jsonl:2-3` socket 1 `"account":"A"`, `mock.jsonl:5-6` socket 2 `"account":"B"`. The answers came from A and then B (`stdout.jsonl:2,4`). The handshake hook shows the override: `before={…"authorization":"tok-HOST"} after={…"authorization":"tok-A","chatgpt-account-id":"acct-A"}` (`plugin.jsonl:9`).
- The configured mock `baseURL` was kept. `model.request` saw the mock URL, not `https://chatgpt.com/backend-api/codex` (`plugin.jsonl:6` `baseURL=http://127.0.0.1:…/v1`), even though the plugin's provider transform tries to set the Codex URL (`core:config-fyxb352w.js:186-189`). **Why the configured value won was not determined.** Whether the Codex URL applies when no `baseURL` is configured was not tested; it would have sent traffic to the dead proxy.

**Where it stores the credential** (source, confirmed by the live seed): the `credential` table of `$XDG_DATA_HOME/opencode/opencode.db`. The columns are `integration_id` (`"openai"`), `value` (JSON `{type:"oauth", methodID:"chatgpt-browser"|"chatgpt-headless", refresh, access, expires, metadata:{accountID}}`) and `active` (`core:config-pknna89w.js:7-16`, written by `core:config-rtyr3d5h.js:78-93`). The plugin reads the active connection for integration `openai` at setup and again whenever the credential is switched (`core:config-fyxb352w.js:168-179,229-230`). A legacy `auth.json` in the data directory is imported by a database migration (`core:config-a6k6eb26.js:32-40`). An earlier run in this spike wrote `auth.json` into a fresh data directory, and no credential row appeared: the fresh database is created by a "schema bootstrap". That run's output was not kept, so this finding is **unconfirmed**.

**Disabling or replacing it:**

- **Config can remove it**: `"plugins": ["-opencode.provider.openai", …]`. A leading `-` is a remove operation (`core:config-knjpra5n.js:86-95`), applied to built-in plugins other than the two guarded ones (`core:config-j7k7jnd5.js:66-70`, guard list `core:config-8t2s61hj.js:498`). Live in `q5-builtin-removed`: `acct.plugins {"count":88,"openai":[{"id":"opencode.prompt.openai","status":"active"}]}` (`plugin.jsonl:5`), compared with 89 including `opencode.provider.openai` when it is loaded. The effects: no `originator` header, and the agent loop went over **HTTP**, because nothing defaulted `transport` to `websocket` any more (`mock.jsonl:2-3` are `http primary`). **The stored credential was still used as the bearer** (`mock.jsonl:1-3` `"token":"tok-HOST"`), because the host's model resolver applies it, not the plugin (`core:config-n48ygd7x.js:163-170,226-236`). Removing the plugin does not remove the need to override `Authorization`.
- **A plugin cannot remove it from code.** Plugins only get `plugin.list` (`@opencode/plugin` `promise/plugin.d.ts:41`). Registering the same ID is rejected as `Duplicate plugin ID`, and the built-in, which is ordered first, keeps it (`core:config-j7k7jnd5.js:107-124`). What a plugin *can* do is override the built-in. Built-in plugins set up before external ones (`core:config-j7k7jnd5.js:107-111`), and hooks run in registration order (`core:config-5y480sgp.js:33,48-53`). The live `before=` values confirm that ordering for `model.request`. A third-party plugin therefore gets the last word on every header in `model.request`, and on `Authorization` in `http.request`/`ws.handshake`. Overriding the built-in's `provider.transform` settings (for example the transport) from a later transform was not tested.

## 6. Hook scoping

**Verdict: works.** All of the plugin's hooks are registered with `{providerID: "openai"}` (`accounts.js:78-79`). An unscoped probe logs the same hook names (`accounts.js:294`, `registerUnscopedProbe`). `q6-hook-scoping` runs one `openai` turn and then one turn on `mockcompat` (`@ai-sdk/openai-compatible`). The mock refuses `mockcompat`'s first request with a 429 so that the `retry` hook fires too.

- For `openai`, both fired: `acct.model.request …"providerID":"openai"` (`plugin.jsonl:6`), `acct.ws.handshake` (`:13`), and `probe.unscoped {"hook":"model.request","providerID":"openai",…}` (`:8`).
- For `mockcompat`, **only** the unscoped probe fired: `plugin.jsonl:18-27` are all `probe.unscoped`, including `{"hook":"retry","providerID":"mockcompat"}` at `:24`. No `acct.*` event appears after `:17`. The `mockcompat` requests reached the mock without our headers: `mock.jsonl:4-5,7` `"token":"sk-mock-not-a-real-key","accountHeader":null`.
- A side effect confirms the scoping. Because our scoped `retry` hook did not run for `mockcompat`, the host honoured `Retry-After: 30` itself, and the scenario took 30.7 s (`summary.json` `"ms":30689`).

Host code: `trigger` skips a callback whose `providerID` does not match `event.model.providerID`, and `has` (which decides whether the HTTP hook wrapper is installed at all) applies the same filter (`core:config-5y480sgp.js:47-56`).

---

## Recommendation

**A multi-account plugin can be built on the native `openai` driver plus session hooks, without running its own HTTP or WebSocket code.** Every requirement in the brief passed live against the mock: per-request account choice, quota capture with attribution, a same-turn reroute on a rate limit, a veto after output, frame rewriting with continuation intact, coexistence with the built-in plugin, and provider scoping. The design that passed:

1. Register every hook with `{providerID: "openai"}`.
2. In `model.request`, choose the account for this `sessionID:kind` and record the choice. Also set `chatgpt-account-id` there.
3. Write `Authorization` (and `chatgpt-account-id`) in **`http.request`** and **`experimental.ws.handshake`**. `model.request` alone loses to any host credential: a configured `apiKey` or a stored ChatGPT login, with or without the built-in plugin.
4. Read quota in `http.response` (headers) and `experimental.ws.receive` (`codex.rate_limits`). Detect refusals and "output already seen" in the same hooks.
5. In `retry`: before any output, return `{retry:true, delay:0}` after marking the account limited. `model.request` runs again and picks the next account. After output, return `{retry:false}`, or leave the host's decision alone so it continues in a new message on the new account.

What makes this weaker than owning the transport:

- **Everything on the WebSocket path depends on `experimental.*` hooks**: the handshake identity, the quota frames and output detection.
- **A refused WebSocket *handshake* switches the session to HTTP permanently** (source, not tested). The other WebSocket recoveries (`RecoverFull`) never reach the `retry` hook.
- **The `retry` hook has no `kind`, headers or output flag**, and it stops being called after 10 retries in a step. The plugin must track attempt state itself from the other hooks.
- **Every account switch on WebSocket costs a new socket and a full, non-incremental request** (measured).
- **The built-in plugin still adds `originator`, `session-id` and `x-codex-beta-features`**, and it sets the transport default. A user's stored ChatGPT login is still used as the bearer unless the plugin overrides it at the last hook.

No requirement failed. Not determined: behaviour against the real Codex backend, including whether it refuses at the WebSocket handshake; retries of title and compaction requests; concurrent same-kind requests within one session; the >10-retry case; and why an explicitly configured `baseURL` survived the built-in plugin's Codex URL.
