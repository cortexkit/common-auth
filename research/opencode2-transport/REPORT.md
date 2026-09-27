# Spike: can an OpenCode 2 plugin own the transport for a provider?

Host under test: **`@opencode/cli` 2.0.18** (`opencode2 --version` → `opencode v2.0.18`), the latest 2.0.x on npm when this ran. The plugin types are from `@opencode/plugin` 2.0.18, and the host source was read from `@opencode/core` 2.0.18 and `@opencode/ai` 2.0.18. All versions are pinned exactly in `package.json`/`package-lock.json`.

## Short answer

- For `openai`, the host uses its **native driver** (`@opencode/ai/providers/openai`), and it defaults to **WebSocket** for the agent loop. The `aisdk` `sdk` and `language` hooks **never fire** on that path.
- The `aisdk` hooks only run when a model's package is an `aisdk:` specifier that the host has **no native mapping for**. A plugin can force a provider onto that path: it rewrites the provider's and models' `package` to `aisdk:file://<plugin>/sdk-factory.mjs` using `provider.transform` and `model.transform`. After that, a fetch the plugin owns sees every model request (agent loop and title). It can answer each one with its own streaming `Response`, and the mock provider is never contacted. **This is the only seam where the plugin owns the transport.**
- The `session` hooks (`model.request`, `http.request`, `http.response`, `experimental.ws.*`, `retry`) fire on the native path, and each one does what its type says. But they only **rewrite** a transport the host owns: the host always makes the network call itself. A plugin can only redirect that call to a loopback endpoint it runs.

## How the evidence was produced

| File | Role |
|---|---|
| `mock-server.mjs` | A loopback mock of the OpenAI Responses API (HTTP SSE and WebSocket) and of Chat Completions (HTTP SSE). It logs every request to `mock.jsonl` and can inject failures (`startMock`, lines 145-224). |
| `plugin/index.js` | The probe plugin, default export `{ id, setup }`. `SPIKE_MODE` selects which hooks it registers. Every hook call is written as a JSON line to `plugin.jsonl`. |
| `plugin/sdk-factory.mjs` | A local "AI SDK provider package": `createSpikeOpenAI(options)` returns `createOpenAI({...options, fetch: <plugin-owned fetch>})`. |
| `run.mjs` | The harness. It runs each scenario (list at lines 68-104) as `opencode2 run --standalone --format json --model <m> "Say hello."`. |
| `evidence/<scenario>/` | Committed output of each scenario: `plugin.jsonl`, `mock.jsonl`, `stdout.jsonl` (the session's JSON events), `stderr.log` (host logs), `config.json` and `summary.json`. |

Isolation (`run.mjs` `isolatedEnv`, lines 106-128): every run has a throwaway `HOME` plus `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` and `XDG_CACHE_HOME` under the OS temp directory. The environment is built from scratch: only `PATH` is inherited, and no `OPENAI_API_KEY` is set. The only credential is the fake `sk-mock-not-a-real-key` in the config. All outbound HTTP(S) goes to a dead proxy (`HTTPS_PROXY=http://127.0.0.1:9`), with `NO_PROXY` set for loopback. The proxy demonstrably blocks outbound traffic: the host's models.dev refresh failed with `Failed to fetch models.dev … Unable to connect` (every `stderr.log`), and an npm install attempt failed with `ECONNREFUSED 127.0.0.1:9` (see 4a). The real `~/.config/opencode` and `~/.local/share/opencode` were never read or written.

To reproduce: `cd spikes/opencode2-transport && npm ci && node run.mjs [scenario…]`.

---

## 1. Install

**Works.** `npm install` in the spike directory installed `@opencode/cli@2.0.18`, which brings in the `@opencode/cli-darwin-arm64` binary. The binary reports `opencode v2.0.18`.

## 2. Loading a minimal v2 plugin

**Works.** The config is `{"plugins": ["<spike>/plugin"], "providers": {...}}` in `$XDG_CONFIG_HOME/opencode/opencode.json` (`run.mjs` lines 153-159). The host resolved the directory to `<dir>/index`:

> `msg="loading plugin" id=<spike>/plugin entrypoint=file://<spike>/plugin/index.js` (any `evidence/*/stderr.log`)

`setup` ran with the full v2 context (`plugin/index.js:183`):

> `{"event":"setup",…,"contextKeys":["agent","aisdk","app","command","event","experimental","generate","integration","location","mcp","model","options","permission","plugin","provider","reference","rpc","session","shell","skill","storage","tool","vcs","websearch","worktree"]…}` (`evidence/openai-default-observe/plugin.jsonl:1`)

## 3. Providers pointed at the local mock

**Works for both providers.** The configs are in `run.mjs` lines 23-66.

- `openai` (only `settings.baseURL` and `settings.apiKey` are set, so the host picks the package). The title request goes over HTTP and the agent-loop request over WebSocket to the mock. The session text is the mock's reply: `"text":"MOCK-WS-REPLY-2"` (`evidence/openai-default-observe/stdout.jsonl`). Mock log: `{"transport":"ws","action":"frame-in","modelRequest":2,"body":{"model":"mock-model",…,"type":"response.create"}}` (`evidence/openai-default-observe/mock.jsonl:3`).
- `mockcompat`, a generic provider with `package: "@ai-sdk/openai-compatible"`. Its requests go to `POST /v1/chat/completions` on the mock (`evidence/compat-observe/mock.jsonl:1`, `plugin.jsonl:8`).

## 4. Hook by hook

### 4a. `aisdk` `sdk` hook: plugin-supplied SDK instance with a custom fetch

**Verdict: works with a large caveat.** The hook never fires for `openai` or for a generic OpenAI-compatible provider in their default configuration, because both use native drivers (see 4e). Scenarios `openai-default-observe`, `openai-http-observe`, `compat-observe` and `explicit-aisdk-prefix` all registered `sdk` and `language` hooks, and none of them logged an `aisdk.*` event (`summary.json` → `pluginEvents`).

It does fire when the model's package is an `aisdk:` specifier with no native mapping. In that case the host honours the instance, and the custom fetch sees every request:

- **Host load order.** Before any external plugin's hook, a built-in hook (`opencode.provider.dynamic`, `@opencode/core` `dist/chunks/config-vzcthcp8.js:13-18`) tries to load the package. For an npm name it runs `npm install`. For `file://…` it imports the module and calls its first `create*` export with the host-prepared options (`config-hjbc5kem.js:4-11`). So with an unresolvable npm name the plugin's hook never gets a chance to run: `"error":{"type":"provider.no-route","message":"Cannot initialize unmappednpm/mock-model: request to https://registry.npmjs.org/@cortexkit%2fspike-openai failed, reason: connect ECONNREFUSED 127.0.0.1:9"}` (`evidence/unmapped-npm-sdk-hook/stdout.jsonl`). The plugin log has only `setup`.
- **The `file://` factory works, and it receives the host's own fetch.** `{"event":"sdk-factory.create","optionKeys":["apiKey","baseURL","body","fetch","headers","name"],"baseURL":"http://127.0.0.1:55385/v1","hostFetchType":"function"}` (`evidence/file-factory-forward/plugin.jsonl:2`, produced by `plugin/sdk-factory.mjs:10`).
- **The plugin fetch sees both title and agent-loop requests.** `owned-fetch.call … "bodyKeys":["input","model","stream"]` (title) and `… "bodyKeys":["input","model","stream","tools"]` (agent loop) (`evidence/file-factory-forward/plugin.jsonl:8,11`, from `plugin/index.js:136`).
- **The fetch can answer by itself with a streaming body, and the mock is never contacted.** In `file-factory-synth` the fetch returns a `ReadableStream` of SSE events, one per pull (`plugin/index.js:145-151`, stream built at lines 34-106). Result: `"text":"PLUGIN-FETCH-SYNTH-1"` in `evidence/file-factory-synth/stdout.jsonl`, and `evidence/file-factory-synth/mock.jsonl` is empty (0 bytes).
- **The plugin's `sdk` hook can replace the SDK the host already built.** `{"event":"aisdk.sdk","providerID":"customaisdk",…,"package":"file://<spike>/plugin/sdk-factory.mjs",…,"sdkAlreadySet":true}` (`evidence/file-factory-sdk-hook-override/plugin.jsonl:3`, `plugin/index.js:221`). After the hook assigns `event.sdk` (`plugin/index.js:231`), requests arrive with `"label":"sdk-hook"`, not `"sdk-factory"` (`plugin.jsonl:12,13`).
- **The plugin can move `openai` itself onto this path.** `provider.transform` and `model.transform` set `package` to `aisdk:file://…/sdk-factory.mjs` (`plugin/index.js:185-217`): `{"event":"provider.transform","target":"openai","found":true,"packageBefore":"@opencode/ai/providers/openai","transportBefore":"websocket"}` → `"packageAfter":"aisdk:file://<spike>/plugin/sdk-factory.mjs"` (`evidence/openai-forced-aisdk-synth/plugin.jsonl:2-3`). The session then completed from the plugin's fetch (`"text":"PLUGIN-FETCH-SYNTH-1"`) with zero mock requests. Both the `mock-model` agent-loop request and the `gpt-6-luna` title request went through it (`plugin.jsonl:80,82`).

What this path loses (measured):

- **The session `http.request`/`http.response` hooks fire only if the owned fetch forwards to the host's `options.fetch`.** When the plugin answers by itself, they do not fire (`file-factory-synth` has no `session.http.*` events; `file-factory-forward` has them). The host wires those hooks inside the fetch it passes in (`config-ppzgkaaq.js:103-128`).
- **The host's WebSocket transport is gone.** `openai` was configured with `transport: "websocket"`, yet `openai-forced-aisdk-synth` logged 0 `ws.*` events.
- **`model.request` sees a placeholder base URL**: `"baseURL":"https://ai-sdk.local"` (`evidence/openai-forced-aisdk-synth/plugin.jsonl:73`, route defined at `config-ppzgkaaq.js:268`). A base-URL rewrite by another plugin therefore has nothing to act on. Whether headers set there reach the AI SDK call was **not tested**.
- **The wire body comes from `@ai-sdk/openai`, not the host's native builder.** Keys differ: native `["include","input","instructions","model","prompt_cache_key","store","tools","type"]` vs. AI SDK `["input","model","stream","tools"]`.

### 4b. `aisdk` `language` hook: wrapping `LanguageModelV3`

**Verdict: works, only on the AI SDK path described in 4a.** The hook fires after the `sdk` hook, and the host calls the wrapper's `doStream` for both the title and the agent-loop request:

> `{"event":"aisdk.language","providerID":"customaisdk","modelID":"mock-model","sdkType":"function","languageAlreadySet":false}` (`evidence/file-factory-language/plugin.jsonl:5`, `plugin/index.js:243`)
> `{"event":"language.doStream","modelId":"mock-model","prompt":2,"tools":0,…}` and `{"event":"language.doStream","modelId":"mock-model","prompt":2,"tools":12,…}` (`plugin.jsonl:13,16`, from the wrapper at `plugin/index.js:169`)

On `openai` forced onto the AI SDK path, it fired for the title model too: `{"event":"language.doStream","modelId":"gpt-6-luna",…}` (`evidence/openai-forced-aisdk-synth/plugin.jsonl:80`). On native providers it never fires (4a). Host code: `result.language ?? sdk.languageModel(...)` (`config-ppzgkaaq.js:245-246`).

### 4c. `session` `http.request` / `http.response`

**Verdict: both fire on native HTTP requests, including `kind:"title"`. `http.response` can replace the body stream. Neither can stop the host from sending.**

- **Both fire on native HTTP.** `{"event":"session.http.request",…,"providerID":"openai","modelID":"mock-model","kind":"primary","url":"http://127.0.0.1:55257/v1/responses",…}` (`evidence/openai-http-observe/plugin.jsonl:8`). The same holds for the generic provider (`evidence/compat-observe/plugin.jsonl:8`) and for `kind:"title"` (`evidence/openai-default-observe/plugin.jsonl:6`).
- **Body replacement works.** `http.response` swaps in a plugin-built SSE body (`plugin/index.js:324-333`). The session text becomes `"text":"HTTP-RESPONSE-HOOK-REPLACED"` for the native openai HTTP driver (`evidence/openai-http-replace/stdout.jsonl`) and for the openai-compatible driver (`evidence/compat-http-replace/stdout.jsonl`).
- **Redirecting to a plugin-controlled endpoint works.** `http.request` rewrote the URL to a second loopback server (`plugin/index.js:308-314`): `"url":"http://127.0.0.1:55478/v1/responses","rewrittenTo":"http://127.0.0.1:55479/v1/responses"` (`evidence/openai-http-redirect/plugin.jsonl:8`). The original mock got 0 requests and `redirect-target.jsonl` got both.
- **Caveat: the host always sends.** It runs `http.request`, performs the request itself, then runs `http.response` on the result (`config-f390r7qs.js:223-238`). A plugin cannot answer in `http.request` without the network; it can only redirect.
- **Caveat: these hooks do not see WebSocket traffic.** With openai's default WebSocket transport, `http.response` replaced only the title reply. The agent-loop turn still returned `"text":"MOCK-WS-REPLY-2"` (`evidence/openai-ws-http-replace/stdout.jsonl`).

`experimental.ws.handshake` can redirect the host-owned socket in the same way. `"url":"ws://127.0.0.1:55498/v1/responses","rewrittenTo":"ws://127.0.0.1:55499/v1/responses"` (`evidence/openai-ws-handshake-redirect/plugin.jsonl:8`, `plugin/index.js:270-285`). The redirect target received the handshake and the `response.create` frame. `ws.send` and `ws.receive` fired once per frame (`evidence/openai-default-observe/plugin.jsonl:9-17`). Rewriting frame contents was **not tested**.

### 4d. `retry`

**Verdict: works. `{retry:false}` stops a retry the host would otherwise make.** Tested on native HTTP, native WebSocket and the AI SDK path, with the failure injected into the first agent-loop request only (`mock-server.mjs` `primary` check, lines 157-161):

| Scenario | Host's own decision (from the hook) | Outcome |
|---|---|---|
| `openai-http-retry-observe` (stream cut mid-SSE) | `"attempt":2,"errorTag":"provider.transport",…"decisionBefore":{"retry":true,"delay":1931}` | retried; `"text":"MOCK-HTTP-REPLY-3"`; 3 model requests |
| `openai-http-retry-false` | same, then set to `{retry:false}` (`plugin/index.js:347`) | no retry; `"type":"error"…"provider.transport","message":"Decode error (200 POST …)"`; exit 1; 2 model requests |
| `compat-retry-500-observe` (HTTP 500) | `"errorTag":"provider.internal",…"decisionBefore":{"retry":true,…}` | retried, succeeded |
| `compat-retry-500-false` | same | no retry; error `provider.internal`; exit 1 |
| `openai-ws-retry-observe` (socket terminated) | `"errorTag":"provider.transport","error":"…WebSocket closed with code 1006…","decisionBefore":{"retry":true,…}` | retried on a new socket; `"text":"MOCK-WS-REPLY-3"` |
| `openai-ws-retry-false` | same | no retry; error `WebSocket closed with code 1006`; exit 1 |
| `file-factory-retry-false` (AI SDK path, HTTP 500) | `"errorTag":"provider.internal",…"retry":true` | no retry; exit 1 |

The quotes are line 10 (line 14 for `file-factory-retry-false`) of each `evidence/<scenario>/plugin.jsonl`, plus that scenario's `stdout.jsonl`.

Two caveats from the host source, not exercised live:

- **The hook also runs when the host would *not* retry**, with `decision:{retry:false}`. A plugin can therefore turn a non-retryable error into a retry (`config-y3bfqnys.js:83-91`).
- **Some WebSocket recoveries bypass the hook.** A failure the transport classifies as `retry-full` returns `RecoverFull` before the retry hook runs, and so does a `previous_response_not_found` rejection (`config-q3yb1nc4.js:124-126`, `@opencode/ai/dist/protocols/open-responses-continuation.js:124-139`).

### 4e. Native driver vs AI SDK for `openai`

**Verdict: native by default. No setting selects AI SDK over native; the package string decides.**

- **`openai` resolves to the native package with WebSocket transport.** `"packageBefore":"@opencode/ai/providers/openai","transportBefore":"websocket"` (`evidence/openai-forced-aisdk-synth/plugin.jsonl:2`, read inside `provider.transform` before the spike changed anything).
- **Every known AI SDK package is rewritten to a native driver**, including `@ai-sdk/openai` → `@opencode/ai/providers/openai` and `@ai-sdk/openai-compatible` → `@opencode/ai/providers/openai-compatible`. This happens **even with an explicit `aisdk:` prefix**: `resolve()` sends any `aisdk:` specifier through the same map (`config-zrq68ahz.js:411-429` table, `474-498` `native2`/`resolve`). Live: provider `explicitaisdk` with `package: "aisdk:@ai-sdk/openai"` behaved exactly like native. It sent requests to `/v1/responses` through `session.http.*` and fired no `aisdk.*` events (`evidence/explicit-aisdk-prefix/plugin.jsonl`).
- **Only an unmapped `aisdk:` package** (an npm name or a `file://` module) reaches `AISDK.language` (`config-ppzgkaaq.js:223-246`, resolver branch `config-n48ygd7x.js:148-157`).
- **`settings.transport` (`"http" | "websocket"`, `@opencode/schema` `Provider.Transport`) selects the transport inside the native driver.** The host's built-in `opencode.provider.openai` plugin defaults it to `"websocket"` (`config-fyxb352w.js:185-189`); xAI does the same. With `transport:"http"` the agent loop used HTTP (`evidence/openai-http-observe`).
- **WebSocket applies only to agent-loop requests.** Title requests always went over HTTP (`webSocket: "session"` is passed only by the agent-loop runner, `config-qs9wxzz9.js:279`; gate at `config-f390r7qs.js:240`).

## 5. Seams that are unusable, or usable only partly

- **The `sdk` hook on its own is unusable.** It never fires for `openai` or any mapped package. For an unmapped npm name, the host's dynamic loader runs first and fails (tries `npm install`) before the plugin's hook is reached. It is usable only together with a package rewrite to an `aisdk:file://` factory. Note that factory alone is enough; the hook is optional.
- **`http.request`/`http.response` cannot own a transport.** The host always sends first, and the hooks cover nothing that goes over the WebSocket.
- **Title requests are covered.** Every hook that fired for `kind:"primary"` also fired for `kind:"title"` on the same transport path (4a–4c).
- **Compaction was not exercised live.** In the host source, `compaction`, `title` and `generate` requests go through the same `prepare()` as the agent loop, so they get the same `model.request`, `http.*` and `ws.*` wiring (`config-f390r7qs.js`, the `Service35.of({ primary, compaction, generate, title })` block right after line 254). On the AI SDK path they would go through the same resolved model. **Neither claim was confirmed by a live compaction.**
- **Hook scoping by `providerID` was not tested.** Every hook in the spike was registered unscoped.

## Recommendation

To **own** the transport the way OpenCode 1's `auth.fetch` does, an auth plugin should use this pattern:

1. Ship a `create*` factory module and point the provider at it. In `setup`, use `provider.transform` and `model.transform`, scoped to the plugin's provider, to set `package` to `aisdk:file://<plugin>/…factory.mjs` (compute the URL from `import.meta.url`). This must cover every model of the provider, because title requests use a different model (`gpt-6-luna` here).
2. The factory returns an `@ai-sdk/*` v3 instance (`LanguageModelV3`; the host bundles `@ai-sdk/provider` 3.0.x) built with the plugin's own `fetch`. That fetch receives every request as a standard `fetch` call, and it can return its own streaming `Response`. That is the same contract as `auth.fetch`, so the existing HTTP/WebSocket-pool/prewarm/continuation logic can live behind it unchanged.
3. For the non-owned leg, forward through the host-provided `options.fetch`, so other plugins' `session.http.*` hooks keep working.
4. Use the `session` `retry` hook to veto host retries that would duplicate the plugin's own retries or fallback.

Compared with OpenCode 1's `auth.fetch`, the plugin would lose the following:

- **The request body is built by `@ai-sdk/openai`**, from the AI SDK prompt the host translates. It is not the host's native Responses builder. The host's `instructions`, `prompt_cache_key`, `include` and `store` shaping disappears (keys compared in 4a). The plugin still rewrites to its native wire shape, as it does today.
- **Every `experimental.ws.*` hook is lost, and so is the host's native WebSocket stack for this provider.** Per the `@opencode/ai` source, that stack already implements a pooled per-session socket, `previous_response_id` continuation, and HTTP fallback on connect failure, on a `1009` too-large close, and after 5 stream failures (`core` `config-t8025hmx.js:108-116,215-226,318-327`; `ai` `open-responses-continuation.js:104-121`, `open-responses-channel.js:116-139`). None of that was exercised live, beyond one socket per process and a full resend across processes in `evidence/openai-ws-two-turns`.
- **Other plugins' `model.request` base-URL rewrites stop working** (the base URL is the placeholder `https://ai-sdk.local`).
- **Other plugins' `session.http.*` hooks see nothing** unless the plugin forwards through the host fetch.
- **The dependency on the host's `aisdk:file://` loading path** (`opencode.provider.dynamic`, first `create*` export) is undocumented.

Worth deciding before designing the host layer: OpenCode 2 already ships a first-party `opencode.provider.openai` plugin. It handles ChatGPT browser and headless OAuth, points the base URL at `https://chatgpt.com/backend-api/codex`, adds the `originator`/`chatgpt-account-id` headers through `model.request`, and defaults `openai` to WebSocket (`config-fyxb352w.js:162-228`). A thinner design is possible: keep the native driver and use `model.request` (base URL and headers), `http.request` (body rewrite), `experimental.ws.handshake`/`send` (socket and frame rewrite) and `retry`. It is supported by the hooks verified above, but it never owns the socket, and the WebSocket hooks are marked experimental. Two things were not determined here: how the owned-transport rewrite interacts with that built-in plugin once a real ChatGPT credential exists (no credential was used), and whether the thinner design can express every rewrite this repo needs.
