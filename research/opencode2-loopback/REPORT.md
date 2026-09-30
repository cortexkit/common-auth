# Spike: can an auth plugin own the OpenAI transport on OpenCode 2 through a loopback proxy?

Host under test: **`@opencode/cli` 2.0.20** (`opencode v2.0.20`, embedded runtime `bun 1.4.2`), with `@opencode/core`, `@opencode/ai` and `@opencode/plugin` 2.0.20, pinned exactly in `package.json`/`package-lock.json`.

## Verdict

**Yes: the loopback design works for `openai` over both transports, and cancellation and other plugins' hooks stay intact.** A plugin starts a proxy on `127.0.0.1` during `setup` and points the host's own native `openai` driver at it. Four pointing methods were tested (config base URL, `provider.transform`, `model.transform`, `model.request`), plus the `http.request` + `experimental.ws.handshake` redirect hooks. Each one sent every request kind through the proxy: the agent loop over WebSocket, and titles, compaction and `generate` over HTTP. The one exception is `provider.transform`, which a `baseURL` in the user's config overrides. The proxy chose the account for each request and rewrote `Authorization`/`chatgpt-account-id`, and the mock upstream saw only the proxy's identity. The host kept one socket per session through the proxy, and `previous_response_id` continuation worked end to end. A mid-session account switch was invisible to the host when the proxy rebuilt the full input itself.

When the user interrupted mid-stream, the upstream connection closed a median 12 ms (WebSocket) and 14 ms (HTTP) after the interrupt call; the proxy's own share of that was under 1 ms. A second plugin's `http.response`, `experimental.ws.*` and `retry` hooks saw all traffic, including a 429 and a 400 with their original status and body. The host's own recoveries (the HTTP fallback after a 1009 close, connection-limit rotation, reconnect after a mid-stream close) went through the proxy unchanged.

**Biggest risk (measured): the host's HTTP client applies the user's `HTTP_PROXY`/`HTTPS_PROXY` to loopback URLs; its WebSocket client does not.** A user with an outbound proxy and no loopback entry in `NO_PROXY` still gets a working agent loop, but every HTTP request to the plugin's proxy fails: titles, compaction, `generate`, `transport: "http"`, and the HTTP fallback after a 1009 close. In this harness the plugin fixed it by adding `127.0.0.1,localhost` to `NO_PROXY` from inside `setup`. This was measured against a mock only: the real Codex backend, TLS, and compression on the upstream leg were not tested (see "Not tested").

## How the evidence was produced

| File | Role |
|---|---|
| `mock-server.mjs` | Loopback stand-in for `chatgpt.com/backend-api/codex`. `POST …/responses` answers with HTTP SSE. WebSocket on the same port streams `response.*` frames and sends a `codex.rate_limits` frame before each response. It honours `previous_response_id` only on the connection that issued it and otherwise sends `previous_response_not_found`, as the real backend does. A per-scenario `plan` applies to agent-loop requests: slow streams (`slow`/`every`), `hold` before headers or the first frame, and HTTP `status` 429/400 with a JSON body. Two fake accounts: `identify()` labels each request `A`, `B` or `none`. Every request, frame, close and early client disconnect is logged. |
| `plugin-proxy/proxy.mjs` | **The loopback proxy** (plain `node:http` + `ws`, so it runs in Bun and in Node). It chooses an account per agent-loop request from a plan, strips hop-by-hop headers and the host's credentials, sets `Authorization`/`chatgpt-account-id`, and opens its own upstream HTTP request or WebSocket. It relays upstream close codes, and closes or destroys the upstream the moment the host side goes away. It can inject faults: `close-1009`, `conn-limit`, `close-before-output`, `close-after-output`. It has three account-switch modes for WebSocket: `expand`, `passthrough` and `close-host` (§2). |
| `plugin-proxy/index.js` | The auth plugin stand-in. `setup` starts the proxy and points the host at it by the method in `SPIKE_POINT`. `model.request` can add `x-cortexkit-kind`/`x-cortexkit-session` headers (`SPIKE_KIND_HEADER=1`). |
| `plugin-observer/index.js` | A second, unrelated plugin (`cortexkit.spike.observer`). It logs `http.request`, `http.response` (for non-2xx it logs status, content type and body from a clone), `experimental.ws.handshake/send/receive` and `retry`. |
| `run.mjs` | Harness. For each scenario it starts `opencode2 serve` in an isolated environment and drives it over the server API: `POST /api/session`, `…/prompt`, `/api/experimental/session/:id/wait`, `…/interrupt`, `…/compact` and `…/generate`. |
| `analyze.mjs` | Writes `evidence/<scenario>/timeline.txt` (all logs merged in time order, each line naming its `file:line`), `metrics.json` (abort and latency numbers) and `evidence/overview.txt` (the session outcome of every scenario). |
| `seed-credential.mjs` | Stores a fake ChatGPT login (`tok-HOST`/`acct-HOST`) in the host's database, copied from `../opencode2-thin`. |
| `evidence/<scenario>/` | `mock.jsonl`, `proxy.jsonl`, `plugin.jsonl` (proxy plugin hooks), `observer.jsonl`, `harness.jsonl`, `messages.json` (the session's messages from the API), `server.log` (host log at debug level), `config.json`, `summary.json`, `timeline.txt`, `metrics.json`. |

**Isolation.** This is the same scheme as the earlier spikes (`run.mjs` `isolatedEnv`). Each run gets a throwaway `HOME` and `XDG_*` directories under the OS temp directory, and only `PATH` is inherited. All outbound HTTP(S) goes to the dead proxy `127.0.0.1:9`, with `NO_PROXY=127.0.0.1,localhost` (except in the `env-proxy-*` scenarios, which remove it on purpose). The only credentials are fake. Nothing reached the network, and the real `~/.config/opencode` was never touched.

**How a turn is aborted.** The earlier spikes never aborted a turn: they ran `opencode2 run` to completion. This harness uses the host's own user-abort path. It starts the turn with `POST /api/session/:id/prompt`, waits until the mock reports the trigger event (first text delta written, or the request/frame arrived when the reply is held), sleeps 300 or 500 ms, then calls `POST /api/session/:id/interrupt`. The session records `error: {type: "aborted", message: "Step interrupted"}` and `idle: interrupted` (`evidence/abort-*/messages.json`, `evidence/overview.txt`). Each abort scenario repeats this 5 times in one session and then runs a normal turn.

**Clocks and load.** The harness and the mock share one Node process; the plugins and the proxy run in the host (Bun) process. Deltas within one process use a sub-millisecond clock. Deltas across processes use `Date.now()` (1 ms resolution), because the two processes' high-resolution clocks disagreed by several ms in one run (`analyze.mjs` header; `metrics.json` `clockOffsetsMs`). The machine was shared with other workers: load averages of 5–19 were recorded during the runs. Absolute timings are therefore noisy. The comparisons below are always direct and proxied runs of the same shape.

To reproduce: `cd research/opencode2-loopback && npm ci && node run.mjs [scenario…] && node analyze.mjs`. The full run is 41 scenarios, about 8 minutes, most of it in the two `env-proxy-no-bypass-*http` scenarios, which wait out the host's 10 retries.

Host source is cited as `core:<chunk>:<line>` (`node_modules/@opencode/core/dist/chunks/`) and `ai:<path>:<line>` (`node_modules/@opencode/ai/dist/`).

---

## Pointing the host at the proxy

| Method (`SPIKE_POINT`) | Scenario | Agent loop (WS) | Title (HTTP) | Compaction (HTTP) | Generate (HTTP) |
|---|---|---|---|---|---|
| config `settings.baseURL` = proxy (fixed port) | `point-config-ws` | ✅ | ✅ | ✅ | ✅ |
| `provider.transform` sets `settings.baseURL` (no base URL in config) | `point-provider-transform-ws` | ✅ | ✅ | ✅ | ✅ |
| `provider.transform`, but config also sets `baseURL` | `point-provider-transform-ws-config-baseurl` | ❌ | ❌ | – | – |
| `model.transform` sets each model's `settings.baseURL` | `point-model-transform-ws` | ✅ | ✅ | ✅ | ✅ |
| `model.request` sets `draft.baseURL` | `point-model-request-ws` | ✅ | ✅ | ✅ | ✅ |
| `http.request` + `experimental.ws.handshake` rewrite the URL | `point-hooks-ws` | ✅ | ✅ | ✅ | ✅ |

✅ means the mock logged the request with the proxy's marker header `x-spike-via-proxy: 1` and account `A`. In every ✅ row, `mock.jsonl` lines 1, 4, 9, 12 and 15 are the title (HTTP), the socket handshake, and three HTTP requests (two compaction, one generate), all `viaProxy=1`, `account A`. Line 7 is the second turn's frame on the same connection.

- **`provider.transform` works only when the config sets no `baseURL`.** In `point-provider-transform-ws-config-baseurl`, the transform logged `after=http://127.0.0.1:49379/v1` (`plugin.jsonl:2`). Yet `model.request` still saw the configured mock URL, `baseURLBefore":"http://127.0.0.1:49369/v1"` (`plugin.jsonl:4`), and the mock received the host's own identity (`mock.jsonl:1,4`: `viaProxy=null`, `account none`). **Why a configured value wins was not determined.** It matches the earlier spike's observation that a configured `baseURL` survived the built-in plugin. `model.transform`, `model.request` and the hooks all win over a configured `baseURL`.
- **With no configured base URL and a stored ChatGPT login, `provider.transform` wins over the built-in `opencode.provider.openai`.** At our transform the base URL is already the Codex URL: `"before":"https://chatgpt.com/backend-api/codex","after":"http://127.0.0.1:51333/v1"` (`host-credential-provider-transform/plugin.jsonl:2`). External plugins' transforms run after the built-in one, which sets `baseURL: codexBaseURL` when a ChatGPT login is active (`core:credential-vzwn6bjz.js:183-192`).
- **The built-in plugin's own `model.request` hook leaves a loopback URL alone.** It rewrites the base URL only when the origin is `https://api.openai.com` (`core:credential-vzwn6bjz.js:227-228`).

All later scenarios use `provider.transform` (with no configured base URL) unless named `*-hooks`.

## 1. WebSocket agent loop, HTTP titles, one socket per session, continuation

**Verdict: yes on all four.**

- **Agent loop over WebSocket, titles over HTTP** (`point-provider-transform-ws/proxy.jsonl`): `:2` `transport:"http", ev:"request", kindFromHeader:"title"`; `:6` `transport:"ws", ev:"handshake", conn:1`; `:7` and `:19` `ev:"response.create", conn:1`. Compaction and `generate` also went over HTTP (`:29`, `:33`, `:37`). In every scenario only `primary` requests used the WebSocket.
- **One host socket per session, and one upstream socket behind it.** Over 6 turns in `latency-proxy-ws`, the proxy logged 1 host handshake, 1 upstream open and 6 `response.create` frames. The mock saw 6 frames on one connection, 5 of them `previousKnownOnConnection:true`. The host logs `session websocket reused` / `mode=incremental` in `server.log`.
- **`previous_response_id` works end to end.** `point-provider-transform-ws/mock.jsonl:7`: `frame-in connection 1 … previous_response_id resp_ws_c1_2, previousKnownOnConnection:true, input_items:1`. The proxy forwards frames verbatim on a stable upstream socket, so the upstream's response IDs stay valid for the host's next incremental frame.
- **The WebSocket hooks fire once per model call, not once per socket.** The observer logged `ws.handshake` before each turn even though the socket was reused (`point-provider-transform-ws/observer.jsonl`). This matches `core:credential-t590yz96.js:190`, where the interceptor's handshake runs before the socket is selected.

## 2. Account choice in the proxy

**Verdict: per request, yes. A mid-session switch can be completely invisible to the host if the proxy rebuilds the full input itself. The session id is on the wire already; the request kind is not, but a hook can add it.**

**Per request.** On HTTP every request is independent: `switch-http/mock.jsonl:1` title `A`, `:4` turn 1 `A`, `:7` turn 2 `B`. On WebSocket the account is chosen per `response.create` frame. A change of account means a new upstream socket, because the Codex backend binds identity at the handshake.

**Mid-session switch on WebSocket: three ways measured.** Each run has two turns; the proxy sends the first agent-loop request as account A and the second as account B (`SPIKE_PROXY_PLAN=A,B`). On the host's side turn 2 is incremental: only the new input items plus `previous_response_id`.

| Mode | What the host saw | What the upstream saw | Extra cost |
|---|---|---|---|
| `expand` (`switch-expand-ws`) | **nothing**: same socket (`proxy.jsonl:6` is the only host handshake), its incremental frame answered normally (`observer.jsonl:17` `previous_response_id:"resp_ws_c1_2", input_items:1`) | old socket closed 1000 (`mock.jsonl:7`), new socket as B (`:8`), **full** input: `input_items 3`, no `previous_response_id` (`:9`) | 0.8 ms from closing A to B receiving the frame |
| `passthrough` (`switch-passthrough-ws`) | a `previous_response_not_found` error. The host closed its socket (`proxy.jsonl:27`), re-ran `model.request` (`plugin.jsonl:7`), opened a new socket (`proxy.jsonl:29`) and **resent in full** (`observer.jsonl:20` `input_items:3`). **The `retry` hook did not fire.** | B's socket got the incremental frame with `previousKnownOnConnection:false` (`mock.jsonl:9`) and rejected it (`:10`), then a third connection got the full input (`:12-13`) | 40 ms |
| `close-host` (`switch-close-host-ws`) | its socket closed with 1012 mid-request. **`retry` fired** with the host's backoff: `"WebSocket closed with code 1012" … decision {"retry":true,"delay":2103}` (`observer.jsonl:18`), then a full resend on a new socket (`:20` `input_items:3`) | full input as B on a new socket (`mock.jsonl:9`) | 2177 ms (the backoff) |

In `expand` mode (`proxy.mjs`, `baseline`/`output` state), the proxy keeps the last full input sent on the host socket plus the `response.output_item.done` items that answered it. When an incremental frame has to go to a new upstream socket, it sends `[...baseline, ...output, ...delta]` without `previous_response_id` (`proxy.jsonl:23` `expanded-incremental deltaItems:1 fullItems:3`). This is the same baseline rule as the host's own diff (`ai:protocols/open-responses-continuation.js:72-85`). `passthrough` relies on the host's own recovery for `previous_response_not_found`, which the host classifies as `retry-full`: drop the socket's continuation state and resend the whole input (`open-responses-continuation.js:129-130`). That recovery bypasses the `retry` hook. `close-host` is the worst option.

**How the proxy learns the session id.** The host already sends it on every HTTP request and WebSocket handshake, as `x-opencode-session`, `x-session-id` and `x-session-affinity` (identical values). With the built-in plugin and a ChatGPT login it also sends `session-id` (`host-credential-provider-transform/proxy.jsonl:2,6`). `prompt_cache_key` in the body is the same session id (`point-provider-transform-ws/proxy.jsonl:7`).

**How the proxy learns the request kind.** Nothing on the wire names it. From the body alone, the proxy can tell a title (instructions start "You are a title generator") from a request with tools. It cannot tell `primary`, `compaction` and `generate` apart: all three carry tools (`point-provider-transform-ws/proxy.jsonl:29,33,37`: `kindFromBody:"primary"` for compaction and generate). **A hook can add it.** The proxy plugin's `model.request` sets `x-cortexkit-kind: <draft.kind>` and `x-cortexkit-session`, and both reached the proxy: `kindFromHeader:"title"/"primary"/"compaction"/"generate"` (same lines). The proxy strips them before going upstream. Caveat, from host source: on WebSocket, request headers are handshake headers, and the socket key is `url + sha256(headers)` (`core:credential-t590yz96.js:53,196`). A header whose value changes between requests of one session would therefore reopen the socket every time. The session id and the kind are stable here, because only `primary` used WebSocket.

## 3. Cancellation

**Verdict: holds on both transports, mid-stream and before the first byte. The proxy closes or destroys its upstream connection within 0.5 ms of seeing the host's side go away. Before the first byte, the host itself can take up to 1.8 s to drop its connection after an interrupt, with or without the proxy.**

Five aborts per scenario. Medians (min–max) from each scenario's `metrics.json`. "Upstream saw close" is measured in the harness process from sending the interrupt to the mock logging `closed` (WS) or `client-closed-early` (HTTP).

| Scenario | Interrupt API returned | Host dropped its side at the proxy | **Upstream saw close** | Inside proxy: host close → upstream close called / closed |
|---|---|---|---|---|
| `abort-midstream-ws` (proxy) | 8.9 ms (5.7–19.4) | 11 (9–22) | **11.9 (8.7–22.9)** | 0.0 / 0.7 ms |
| `abort-midstream-ws-hooks` (proxy via hooks) | 6.9 (4.5–105.7) | 8 (6–129) | **8.0 (6.1–128.8)** | 0.0 / 0.8 |
| `abort-midstream-ws-direct` (no proxy) | 5.3 (4.0–9.3) | – | **3.6 (2.7–7.0)** | – |
| `abort-midstream-http` (proxy) | 5.5 (3.0–103.3) | 14 (7–107) | **14.1 (7.9–107.4)** | 0.1 / 0.6 |
| `abort-midstream-http-direct` | 3.0 (1.8–8.7) | – | **3.7 (2.4–9.6)** | – |
| `abort-before-first-frame-ws` (proxy, reply held 4 s) | 533 (138–1773) | 535 (140–1776) | **535 (140–1776)** | 0.0 / 0.5 |
| `abort-before-headers-http` (proxy, headers held 4 s) | 113 (10–1022) | 115 (11–1030) | **116 (12–1030)** | 0.1 / 0.4 |
| `abort-before-headers-http-direct` | 451 (9–520) | – | **449 (8–521)** | – |

- **Mid-stream, the proxy adds about 5–10 ms.** Most of that is the time between the host closing its side and the proxy's event loop getting to the close; both run in the host process. The proxy's own reaction is synchronous: `proxyHostCloseToCloseCalledMs` is 0.0–0.5 ms in every sample.
- **How the host cancels.** On WebSocket the host closes its socket with 1000 (`proxy.jsonl` `host-closed … code:1000`, e.g. `abort-midstream-ws/proxy.jsonl`). Aborting a pooled exchange poisons and closes the socket; the host sends no `response.cancel` (`core:credential-t590yz96.js:287-317,89-106`; `ai:route/transport/websocket.js:233-237`). The next turn opens a new socket and sends the full input: 6 host handshakes for 6 turns in `abort-midstream-ws`, and the final `ws.send` has `input_items:11` with no `previous_response_id` (`observer.jsonl:51`). On HTTP the host aborts the fetch; under Bun the proxy saw `res.close` first (`hostCloseVia:"res.close"` in every sample).
- **The upstream stops streaming.** The mock noticed its socket was gone and stopped at frame 7 of 67 each time (`abort-midstream-ws/mock.jsonl:9,15,21,27,33` `stopped-streaming sent:7 total:67`). For held replies it logged `gone-before-headers` / `gone-before-first-frame` when the hold ended (e.g. `abort-before-headers-http/mock.jsonl:10`).
- **Before the first byte, the delay is the host's, not the proxy's.** In every before-first-byte sample, the host dropped its connection within 1–9 ms of *returning* from the interrupt call. But the interrupt call itself took 10 ms–1.8 s when no response bytes had arrived yet, against medians of 3–9 ms mid-stream (with single outliers near 100 ms). The direct baseline shows the same thing (8–521 ms). **Why the host's interrupt is slower before the first byte was not determined.** It is outside the proxy's control, and upstream spend in that window is zero (nothing has been generated yet, as far as the mock can tell).

## 4. Other plugins

**Verdict: unaffected.** The host still sends every request itself, so a second plugin's hooks fire as usual.

- **`http.response` sees the proxy-relayed error with its original status and body.** 429: `status:429, body:"{\"error\":{\"type\":\"usage_limit_reached\",\"code\":\"rate_limit_exceeded\",\"message\":\"mock: rate limited\",\"resets_in_seconds\":30}}", contentType: application/json, retryAfter: "1"` (`error-http-429/observer.jsonl:6`). 400: `status:400, body:"{\"error\":{\"type\":\"invalid_request_error\",\"code\":\"mock_bad_request\",…}}"` (`error-http-400/observer.jsonl:6`). The proxy passed the status through unchanged (`proxy.jsonl:7` `response-headers status 429`/`400`).
- **`retry` fires with the host's own classification.** 429 → `provider.rate-limit`, `{"retry":true,"delay":…}`, and the retry succeeded (`error-http-429/observer.jsonl:7`, then `messages.json` `MOCK-HTTP-3-primary-acct-A`). 400 → `provider.invalid-request`, `{"retry":false}` (`error-http-400/observer.jsonl:7`), and the turn failed.
- **`experimental.ws.receive` sees every frame, including the upstream's `codex.rate_limits` and error frames**: `ws.receive … type:"error", error:"websocket_connection_limit_reached"` (`fault-conn-limit/observer.jsonl:7`). `ws.handshake` sees the proxy URL (`point-provider-transform-ws/observer.jsonl`).
- **Hook redirects compose.** With the `hooks` method, the proxy plugin's `http.request`/`ws.handshake` rewrite ran before the observer, and the observer saw the rewritten proxy URL (`point-hooks-ws/observer.jsonl`). A third plugin that also rewrites URLs would conflict; that was not tested.

## 5. Host recoveries through the proxy

**Verdict: every recovery tested works through the proxy.**

| Scenario (fault injected by the proxy on the first agent-loop request) | Host behaviour | `retry` hook |
|---|---|---|
| `fault-close-1009`: proxy closes the host socket with 1009 before any frame | `session websocket request too large; using http` (`server.log:77`). The same request was resent **over HTTP to the proxy** (`proxy.jsonl:10`), and **turn 2 also went over HTTP** (`proxy.jsonl:14`): the fallback is permanent for the session (`core:credential-t590yz96.js:318-327`, `owner.httpFallback = true`) | not fired |
| `fault-close-1009-hooks`: same, pointed with hooks | the HTTP fallback was caught by the `http.request` redirect (`proxy.jsonl:10,14`) | not fired |
| `fault-conn-limit`: proxy sends an `error` frame with `websocket_connection_limit_reached` | host closed the socket (`proxy.jsonl:9`), opened a new one (`:10`), resent in full, and later turns continued incrementally on it (`observer.jsonl:20` `previous_response_id:"resp_ws_c1_2"`) | not fired (`rotate-and-retry-full`, `ai:…/open-responses-continuation.js:131-132`) |
| `fault-close-before-output`: proxy relays `response.created`, then drops the host socket (1006) | `session websocket poisoned code=1006` (`server.log:76`), retried on a new socket with the same input | fired: `WebSocket closed with code 1006 … {"retry":true,"delay":1906}` (`observer.jsonl:9`) |
| `fault-close-after-output`: proxy relays one text delta, then drops the host socket | the partial message was kept with an error, and the host continued with a synthetic continue prompt, sent in full (`observer.jsonl:14` `input_items:3`) | fired, `delay 1733` (`observer.jsonl:12`) |

Relaying upstream closes: the proxy closes the host socket with the upstream's code when that code can be sent, and drops the socket otherwise (1005/1006/1015) (`proxy.mjs` `sendable`). So a real upstream 1009 or 1011 reaches the host's recovery logic unchanged. This relay of upstream closes is implemented but was not exercised, because every fault here was injected by the proxy itself.

**Not exercised:** the permanent HTTP fallback after 5 failed WebSocket exchanges in one session (`core:credential-t590yz96.js:107-117`), a refused WebSocket *handshake* (which also switches the session to HTTP for good, `:214-224`), the 30-minute idle timeout, and the 55-minute socket rotation.

## 6. What the host adds, and what a loopback base URL breaks

**What the host sends** (`proxy.jsonl` `hostHeaderNames`; full WebSocket values in `host-credential-provider-transform/proxy.jsonl:6`):

- Always: `user-agent: opencode/latest/2.0.20/cli`, `x-opencode-client`, `x-opencode-project`, `x-opencode-session`, `x-session-affinity`, `x-session-id`, `authorization` (the host's own credential), `content-type`. On HTTP also `accept-encoding: gzip, deflate, br, zstd`, `traceparent`, `b3`. On WebSocket also `openai-beta: responses_websockets=2026-02-06` and a `permessage-deflate` offer.
- With the built-in plugin and a ChatGPT login: also `originator: opencode`, `session-id`, `x-codex-beta-features: remote_compaction_v2` and `chatgpt-account-id: acct-HOST`, with the stored token as the bearer.

**What the proxy must do:**

- **Replace `authorization` and `chatgpt-account-id`.** The host always sends its own credential; the mock saw `tok-A`/`acct-A` only because the proxy replaced them (`host-credential-provider-transform/mock.jsonl:1,4`).
- Strip hop-by-hop headers (`host`, `connection`, `content-length`, `transfer-encoding`, `upgrade`), and the `x-cortexkit-*` headers its own plugin added to tell the proxy the request kind and session.
- **Keep `openai-beta`** (it selects the Codex WebSocket protocol version), plus `originator`, `session-id` and `x-codex-beta-features`.
- **`accept-encoding`**: passing it through works only while the proxy does not read the HTTP body. The mock never compressed, so this is untested. A proxy that parses SSE (for quota or refusal detection) must drop `accept-encoding` or decompress.
- **`permessage-deflate`**: this proxy declined compression on both legs. Relaying compressed frames was not tested.

**Loopback-specific findings:**

- **`HTTP(S)_PROXY` catches loopback HTTP.** This is the biggest risk. With `NO_PROXY` empty, the WebSocket agent loop still reached the proxy (`env-proxy-no-bypass-ws/mock.jsonl` has the frames). The reason is that the host's WebSocket constructor hard-codes a bypass for `127.0.0.1`/`localhost`/`::1` (`core:credential-y8cydn3q.js:25-28`). But every HTTP request died at the dead outbound proxy with `ConnectionRefused` and never reached the loopback proxy:
  - `env-proxy-no-bypass-http/observer.jsonl:4-22`: `"ConnectionRefused: Unable to connect…" {"retry":true,…}` for attempts 2–11. Then the turn failed (`messages.json` `provider.transport`). `mock.jsonl` and the proxy request log are empty.
  - Titles in the WebSocket scenario failed silently the same way: `http.request` with no `http.response` (`env-proxy-no-bypass-ws/observer.jsonl:1-2,14-15`).
  - It is not specific to the proxy: a loopback base URL with no proxy at all fails identically (`env-proxy-no-bypass-direct-http`).
  - **Fix measured:** in `setup`, the plugin appended `127.0.0.1,localhost` to `process.env.NO_PROXY`/`no_proxy` (`env-proxy-no-bypass-http-patched/plugin.jsonl:1`), and both HTTP turns succeeded. The host's HTTP client evidently reads the variable at request time. The change applies to the whole host process, including other plugins' requests, but it only exempts loopback addresses from the outbound proxy.
- **No TLS assumption and no host or header allow-list were hit.** An `http://` base URL becomes `ws://` for the socket (`ai:route/transport/websocket.js:105-116`). Arbitrary extra headers (`x-cortexkit-*`) passed through to the proxy on both transports.
- **A configured `baseURL` beats `provider.transform`** (see "Pointing the host at the proxy"). A plugin that relies on `provider.transform` is silently bypassed by any user who sets `settings.baseURL`. `model.transform`, `model.request` and the hooks are not.
- The proxy runs inside the host's Bun process (`proxy.jsonl:1` `runtime:"bun 1.4.2"`). `node:http` and `ws` (server and client) worked there without changes.

## 7. Cost

Same scenario shape direct (`point: none`) and through the proxy. Six turns of 200 deltas each, paced by `setTimeout(0)` (`latency-*`), then four turns of 2000 deltas written back to back (`burst-*`). Per-delta logging was off in both plugins. Medians from `metrics.json`:

| (all values in ms) | WS direct | WS proxy | HTTP direct | HTTP proxy |
|---|---|---|---|---|
| Whole turn, prompt → idle (`latency-*`, `turnMs`) | 318.6 | 318.5 | 325.4 | 311.9 |
| Host send hook → proxy received it (`hostToProxyMs`) | – | 0.4 | – | 0.5 |
| Host send hook → upstream received it (wall clock, 1 ms resolution) | 1 | 1 | 1 | 1 |
| Stream stretch: upstream vs host duration for 200 paced deltas | 257.6 / 259.3 | 257.6 / 259.4 | 252.8 / 252.5 | 250.5 / 250.5 |
| Burst of 2000 deltas: upstream write time / host receive time | 11.9 / 38.2 | 13.0 / 50.0 | 2.0 / 801.8 | 1.6 / 745.3 |

- **Per request:** about 0.4–0.5 ms for the host → proxy hop. The proxy → upstream hop was below the 1 ms wall-clock resolution. On loopback this is invisible in whole-turn time.
- **Per frame:** the proxy's synchronous relay work is 5–10 µs per frame on average (`relayMicrosMean` 9.7 over 1248 frames in `latency-proxy-ws`, 5.4 over 8032 in `burst-proxy-ws`; maximum 0.1–0.2 ms). A paced stream is not stretched at all.
- **In a burst, WebSocket delivery took about 12 ms longer through the proxy** (50 vs 38 ms for 2000 frames): the frames cross the host's event loop twice. The HTTP burst is dominated by the host's own SSE consumption (0.75–0.8 s either way).
- A real upstream adds 10–100+ ms of network latency per request, so these costs are small in comparison. The host-to-proxy hop is plain loopback with no TLS; the proxy pays for its own upstream TLS, which was not measured.

## Not tested, or not determined

- **The real Codex backend.** It was not contacted: no TLS or WSS on the upstream leg, no real handshake refusals, no real `codex.rate_limits` or error shapes beyond the mock's, and no compression (`accept-encoding`, `permessage-deflate`) on either leg.
- **The proxy's own upstream through a corporate proxy.** `node:http`/`ws` do not read `HTTPS_PROXY`, so a real proxy would need its own proxy-agent support. Not exercised.
- **Why a configured `baseURL` beats `provider.transform`.** Not determined.
- **Why the host's interrupt takes 0.1–1.8 s before the first response byte.** Not determined; the same happens without the proxy.
- **Some host recoveries were not exercised:** the permanent HTTP fallback after 5 stream failures, a refused WebSocket handshake, the idle timeout, and 55-minute rotation. The `retry` hook's 10-retry cap was only seen incidentally (`env-proxy-no-bypass-http` stops at attempt 11).
- **Concurrency:** concurrent sessions through one proxy, child sessions (`x-parent-session-id`), and several plugins rewriting URLs at once.
- **A real multi-account policy:** the proxy's accounts are a fixed plan, with no quota-based switching. The `expand` mode (the proxy rebuilding the full input when an account switch moves it to a new upstream socket, §2) is proven only for plain text messages. Tool calls, reasoning items with `encrypted_content`, and compaction triggers were not exercised through it; the host's own diff treats those specially (`ai:protocols/open-responses-continuation.js:41-67,144-146`).
- **Pi and OpenCode 1** were not run against this proxy.
