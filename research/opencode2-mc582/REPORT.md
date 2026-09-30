# Magic Context #582 on the real ChatGPT Codex backend (OpenCode 2.0.20, WebSocket)

Question: Magic Context prefixes every item it replays to the model, including the model's own earlier text, with a `§N§ ` handle. Issue #582 reports that on OpenCode 2's WebSocket transport this makes the client history differ from what the provider returned, so OpenCode resends the whole history instead of a delta.

Host: `@opencode/cli` 2.0.20 in server mode. OpenAI was served by the host's built-in `opencode.provider.openai` plugin and its native driver, using a ChatGPT login against `wss://chatgpt.com/backend-api/codex/responses`. openai-auth was not loaded. Magic Context (MC) came from the local checkout (`packages/plugin`, package version 0.44.3, commit `f07da4b872`, `dist/` built 10:09 on 2026-09-30, after the last `src` commit at 09:21).

## Direct answers

### 1. Does MC's assistant-text tag make OpenCode resend the whole history? **Yes, on every request that follows a response containing text. Nothing else in the request caused it.**

Same prompts, a fresh session in each arm (`evidence/arm-A`, `evidence/arm-B`, file `observer.jsonl`, summarized in `analysis.txt`):

| Request | Arm A (no MC) | Arm B (MC loaded) |
|---|---|---|
| turn 1, first request | `previous_response_id` absent, 1 input item | absent, 3 input items (MC adds `<session-history>` and `<session-history-since>` user items, and the prompt goes out as `§1§ First write…`) |
| turn 1, tool-result continuation | **`previous_response_id=resp_063f77abe2da9661016abcc7a5b5b487d298e86a2739925013`, 1 item** (`function_call_output "hi\n"`) (`arm-A/observer.jsonl:20`) | **absent, 7 items** (`arm-B/observer.jsonl:22`) |
| turn 2 ("Thanks."), first request | **`previous_response_id=resp_063f77abe2da9661016abcc7a89fb087d290b544c09a0dfcb6`, 1 item**: `message user "Thanks."` (`arm-A/observer.jsonl:33`) | **absent, 9 items** (`arm-B/observer.jsonl:35`) |
| socket | 1 socket for the session: `session websocket connected`, then `reused` ×2; `mode=full, incremental, incremental` (`arm-A/server.log:52-58`) | 1 socket: `connected`, then `reused` ×2; `mode=full, full, full` (`arm-B/server.log:138-144`) |

Turn 2 had only one request in each arm. The full `input` of arm B's first turn-2 request (`arm-B/observer.jsonl:35`):

```
input[0] message user "<session-history></session-history>"
input[1] message user "<session-history-since>(no new content since last materialization)</session-history-since>"
input[2] message user "§1§ First write one short sentence, then run `echo hi` with the shell tool."
input[3] reasoning id=rs_0f59c92a64f7abaa016abcc7b0c43887d2a892545a2b9ff3b0
input[4] message id=msg_0f59c92a64f7abaa016abcc7b1152087d2bd21d5c41ba59026 assistant "§2§ I’ll run the requested command now."
input[5] function_call id=fc_0f59c92a64f7abaa016abcc7b164f487d2a0760bb092a38705 call_id=call_ZGkIuNETwiyy2hiwKYsXIhno shell({"command":"echo hi"})
input[6] function_call_output call_id=call_ZGkIuNETwiyy2hiwKYsXIhno "§3§ hi\n"
input[7] message id=msg_0f59c92a64f7abaa016abcc7b401f887d28e971f83091c3322 assistant "§4§ Done."
input[8] message user "§5§ Thanks."
```

Arm A's first turn-2 request has only the delta, `input[0] message user "Thanks."`, with `previous_response_id` set.

**The tag is the only reason.** `analyze.mjs` re-runs the host's own `incremental()` rules (`node_modules/@opencode/ai/dist/protocols/open-responses-continuation.js:23-85`) on each pair of logged frames. For both arm B continuations it reports: `invariant fields equal: true` (instructions, tools, model, reasoning and every other non-input field were identical), and then the first differing item:

```
ws.send #2 (turn-1 continuation) first mismatch at index 4:
    checkpoint: {"content":[{"text":"I’ll run the requested command now.","type":"output_text"}],"phase":"commentary","role":"assistant"}
    new input : {"content":[{"text":"§2§ I’ll run the requested command now.","type":"output_text"}],"phase":"commentary","role":"assistant"}
ws.send #3 (turn 2) first mismatch at index 7:
    checkpoint: {"content":[{"text":"Done.","type":"output_text"}],"phase":"final_answer","role":"assistant"}
    new input : {"content":[{"text":"§4§ Done.","type":"output_text"}],"phase":"final_answer","role":"assistant"}
```

With the leading `§N§ ` removed from assistant text in both requests (tags on user and tool items kept), both checks pass (`counterfactual … incremental possible = true`). MC's other additions (the history items, tags on user messages and on tool output) are stable across requests and did not break continuation. Every later full resend in the two quote sessions (`arm-B-quote`, `arm-B-quote-2`) has the same cause, with the first mismatch at a tagged assistant message.

### 2. Does the Codex backend reorder output items? **No. The completed envelope is empty, so OpenCode checkpoints the streamed order, and it replays the same order.**

Turn 1 of arm B produced reasoning, text and a function call in one response (`resp_0f59c92a64f7abaa016abcc7afd62887d2b4e83e8da99f5418`). The prompt needed no changes. As streamed (`arm-B/observer.jsonl:9-18`):

```
:9  output_item.added output_index=0 reasoning     rs_0f59c92a64f7abaa016abcc7b0c43887d2a892545a2b9ff3b0
:10 output_item.done  output_index=0 reasoning     rs_0f59c92a64f7abaa016abcc7b0c43887d2a892545a2b9ff3b0
:11 output_item.added output_index=1 message       msg_0f59c92a64f7abaa016abcc7b1152087d2bd21d5c41ba59026
:15 output_item.done  output_index=1 message       msg_0f59…ba59026 "I’ll run the requested command now."
:16 output_item.added output_index=2 function_call fc_0f59c92a64f7abaa016abcc7b164f487d2a0760bb092a38705
:18 output_item.done  output_index=2 function_call fc_0f59…2a38705 shell({"command":"echo hi"})
```

Arm A's turn 1 (no reasoning item) streamed `message msg_063f…4341d1` (`:9`, `:13`) and then `function_call fc_063f…19a4da` (`:14`, `:16`).

`response.completed.response.output` was **`[]`** in every one of the 16 responses across the four sessions, with `"store":false` (for example `arm-A/observer.jsonl:18`, `arm-B/observer.jsonl:20`). So there is no envelope order to compare with. The host code handles this case: when the envelope output is empty, the checkpoint is the `output_item.done` items in the order they were received (`open-responses-continuation.js:125-126,159-163`).

The host replays in that same order. In arm B's full continuation (`arm-B/observer.jsonl:22`), `input[3..5]` is `reasoning rs_0f59…9ff3b0`, `message msg_0f59…ba59026`, `function_call fc_0f59…2a38705`: the same ids in stream order. In arm A the replay is not on the wire, because the requests were incremental. But the host accepts a delta only when every item of `[previous input, checkpoint output]` equals, by index, the full input it built. So the arm A requests at `:20` and `:33` show that its replay order matched the streamed order there too.

The reordering described in the issue's comments (stream `reasoning → message → function_call`, envelope `reasoning → function_call → message`) belongs to that commenter's endpoint. It did not occur on the Codex backend. Caveat: only single-call responses with one text item were observed here, not responses with several calls, or text after the call.

### 3. What does the model see? **On full resends, MC's tag. The one kind of incremental turn that happened was when the model had written the tag itself, so it was already part of the model's raw output.**

- **No incremental turn ever carried a tag that MC added.** It cannot happen: OpenCode sends a delta only when the client history equals the checkpointed raw output byte for byte (question 1). So MC's reasoning that the provider rebuilds earlier turns from its raw output is correct. But under OpenCode's check, a turn in which the model continues from raw output while the client holds tagged text never exists.
- **The model learns the tag format and writes it itself.** In all three committed arm B sessions, the reply to "Thanks." came from the backend already tagged, with the number MC was about to assign: `output_item.done … assistant "§6§ You’re welcome!"` (`arm-B/observer.jsonl:44`, `arm-B-quote/observer.jsonl:44`, `arm-B-quote-2/observer.jsonl:44`). MC's `prependTag` strips an existing leading tag and adds `§6§ ` again (`magic-context/packages/plugin/src/hooks/magic-context/tag-content-primitives.ts:135-138`). The replayed bytes therefore equalled the raw output, and **the next turn went out incremental**: `previous_response_id=resp_0dd98e28c797345f016abcc7eccce887d29a481c04570b87c6, input_items=1` (`arm-B-quote-2/observer.jsonl:48`; also `arm-B-quote/observer.jsonl:48`; `mode=incremental` in both `server.log:146`). Later replies were also self-tagged (`"§10§ ````text…"`, `arm-B-quote-2/observer.jsonl:80`).
- **Quote answers** (prompt: "Quote your previous assistant message verbatim, character for character, including any symbols at its start. Put the quote alone inside a fenced code block."):

| Session / turn | Request | Previous assistant message: raw model output → what the client sent | Model's quote |
|---|---|---|---|
| `arm-B-quote-2` turn 3 | **incremental** (`:48`) | `§6§ You’re welcome!` → the same (self-tagged) | `§6§ You’re welcome!` (`:62`) |
| `arm-B-quote-2` turn 4 | **full**, 14 items (`:66`) | `` ```text\n§6§ You’re welcome!\n``` `` → `` §8§ ```text\n§6§ You’re welcome!\n``` `` (input[12]) | `` §8§ ```text\n§6§ You’re welcome!\n``` ``, inside a 4-backtick fence (`:80`) |
| `arm-B-quote` turn 3 | **incremental** (`:48`) | `§6§ You’re welcome!` → the same | `§6§ You’re welcome!` (`:62`) |
| `arm-B-quote` turn 4 | **full**, 14 items (`:66`) | same shape as above, MC tag `§8§` | `` ```text\n§6§ You’re welcome!\n``` `` (the `§8§` left out) (`:80`) |

  On the one full turn where the model quoted everything, it reproduced `§8§`, which exists only in MC's copy of the history (`arm-B-quote-2`). So the model does see MC's tag on a full resend. In `arm-B-quote` it left `§8§` out. MC's system prompt says tags are handles and not to reproduce MC's markings, so leaving it out does not show the model failed to see it. An earlier run of `arm-B-quote` (overwritten, not in the evidence) had an untagged raw "You’re welcome!" that MC replayed as `§6§ You’re welcome!` on a full turn, and the model quoted `§6§ You’re welcome!`. That run is mentioned for completeness only; the claims above rest on the committed runs.

**What this means for MC's decision.** The bandwidth cost in #582 is real on the Codex backend: every request after a response with text is a full resend. MC's reasoning that a continued turn would hide the tag from the model does not apply, because such a continued turn is never sent: every request that carries an MC-added tag is a full resend, and the model sees the tag. The only incremental turns in arm B happened because the model had copied the tag into its own output.

## Setup

- **Model:** `gpt-5.6-luna` at reasoning effort `low` (sent as `"reasoning":{"effort":"low","summary":"auto"}`; the backend echoed `"effort":"low"`). The host enables a model for a ChatGPT login when its id is `gpt-N.M` newer than 5.4 or on an allow-list ( `core/dist/chunks/credential-vzwn6bjz.js:211-218`).
- **Model requests: 34 in total.** The committed runs made 20: arm A 4, arm B 4, `arm-B-quote` 6, `arm-B-quote-2` 6. Each is 1 title request over HTTP (`kind=title POST https://chatgpt.com/backend-api/codex/responses`) plus 3 or 5 `response.create` frames on the WebSocket. 14 more came from a first pass of arm A, arm B and `arm-B-quote`, which were rerun because the host binary was then under the real `~/.local/share/cortexkit` (see isolation). The host also fetched the ChatGPT model list once per start (`GET …/codex/models`, not a model request). No retries fired. Nothing in `server.log` mentions a token refresh.
- **Transport:** WebSocket, the host default for `openai` (`provider.settings.transport ?? "websocket"`, `credential-vzwn6bjz.js:190`). One socket per session in every run.
- **MC load config** (`evidence/arm-B/config.json`). The OpenCode 2 config was `$XDG_CONFIG_HOME/opencode/opencode.json`:

  ```json
  { "plugins": ["<run>/plugin-observer", "<home>/Work/Projects/CortexKit/magic-context/packages/plugin"],
    "providers": { "openai": { "models": { "gpt-5.6-luna": { "name": "gpt-5.6-luna", "settings": { "reasoningEffort": "low" } } } } } }
  ```

  The plugin entry is the package directory. Its `package.json` `main`/`exports` point to `dist/index.js`, whose default export is `{ id, server, setup }`. OpenCode 2 calls `setup` (`src/v2/server.ts:36-58`), confirmed by `[magic-context] @cortexkit/opencode-magic-context v2 setup` in `arm-B/server.log`. MC's own config, `$XDG_CONFIG_HOME/cortexkit/magic-context.jsonc`: `{"historian":{"disable":true},"dreamer":{"disable":true},"embedding":{"provider":"off"},"auto_update":false}`. Tagging used MC's defaults: compaction on, and the TypeScript transform (`transform_mode` unset, not `"rust"`). The Rust transform was not tested. Arm A loaded only the observer plugin.
- **Credential:** `seed-credential.mjs` read the live ChatGPT access token and expiry from `~/.local/share/opencode/auth.json` (key `openai`), and the account id from the token's `https://api.openai.com/auth.chatgpt_account_id` claim. It stored them in the throwaway host database as a `chatgpt-browser` credential, with `refresh: "not-a-refresh-token"`. The real refresh token was never read into the credential or written anywhere. `run.mjs` refuses to run if the access token expires within the hour.

## Isolation

Each run used `$TMPDIR/oc2-mc582/<run>/` for `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `TMPDIR`, `OPENCODE_DB` (the host honours it: `path.resolve(dataDir, process.env.OPENCODE_DB)`), `OPENCODE_CONFIG_DIR`, `MAGIC_CONTEXT_STORAGE_DIR` and `MAGIC_CONTEXT_LOG_PATH`. Only `PATH` was inherited. The host binary ran from `$TMPDIR/oc2-mc582-deps` and the observer plugin from a copy in the run root. The first pass ran the binary from this worktree, which sits under the real `~/.local/share/cortexkit/alfonso/worktrees/…`, and lsof flagged the executable itself as the one hit. That pass was discarded and rerun.

`lsof -n -P -p <host pids>` was captured 1.5 s into turn 1 and again at the end of every run (`evidence/*/lsof-during-turn-1.txt`, `lsof-end.txt`). The check covers any open file under `<home>/.config/opencode`, `<home>/.local/share/opencode`, `<home>/.config/cortexkit`, `<home>/.local/share/cortexkit`, `<home>/.cache/opencode` and `<home>/.local/state/opencode`. All 8 snapshots report `# forbidden hits: 0`. The files the host had open during arm B's turn 1 (`arm-B/lsof-during-turn-1.txt`, pid 17172; `<run>` = the throwaway root, `<deps>` = the throwaway install):

```
<deps>/node_modules/@opencode/cli/bin/opencode.exe
<run>/xdg-data/opencode/opencode.db  (+ -wal, -shm)
<run>/xdg-data/opencode/log/opencode.log
<run>/mc-store/context.db            (+ -wal, -shm)   ← MC's store, inside the throwaway root
<run>/tmp/.bun-501-*.dylib / .node
/usr/lib/dyld, /usr/share/icu/…, /private/var/db/… (system files)
```

## Files

| File | Role |
|---|---|
| `run.mjs` | `node run.mjs A|B "prompt" …` (with `RUN_NAME` optional). Builds the isolated environment, seeds the credential, starts `opencode2 serve`, drives one session over the server API, takes the lsof snapshots, and writes scrubbed evidence. |
| `seed-credential.mjs` | Reads the live access token, expiry and account id. Stores only the access token, with an invalid refresh token. |
| `plugin-observer/index.js` | Logs every `experimental.ws.send` frame in full, and every `experimental.ws.receive` frame except deltas, which are counted. HTTP requests are logged by URL and kind only, never headers. |
| `analyze.mjs` | Writes `evidence/<run>/analysis.txt`: each request's `previous_response_id`, input count and item digests; the streamed order against the envelope order; token usage; and an offline re-run of the host's continuation check, with the first mismatch and the tag-stripped counterfactual. |
| `evidence/<run>/` | `observer.jsonl` (the raw frames), `server.log` (host debug log), `messages.json`, `harness.jsonl`, `config.json`, `summary.json`, `lsof-*.txt`, `analysis.txt`. |

**Scrubbing:** the access token and account id were replaced by `<redacted-secret>`. Any JWT-shaped string was redacted. Reasoning `encrypted_content` was replaced with its length and a sha256 prefix (equal values keep equal hashes, so the offline continuation check still works). Paths were replaced with `<run>`, `<deps>`, `<spike>` and `<home>`. Before committing, grepping all committed files for the JWT prefix, the account id and a slice of the access token returned no matches.

Reproduce: `npm ci` here (for `seed-credential.mjs`), then `node run.mjs A "<p1>" "Thanks."`, `node run.mjs B "<p1>" "Thanks."`, `RUN_NAME=arm-B-quote-2 node run.mjs B "<p1>" "Thanks." "<quote>" "<quote>"`, then `node analyze.mjs arm-A arm-B arm-B-quote arm-B-quote-2`.

## Not determined

- **Whether the model would see MC's tag on a continued turn if OpenCode sent one anyway.** OpenCode never sends such a turn, so this was not tested. Testing it would take a hand-built frame outside OpenCode (a delta whose client history differs from the raw output).
- **Prompt-cache effect.** On Codex, `cached_tokens` was 8704 of about 8.9k input tokens on arm B's full resends, but 0 on all three arm A requests, including its two incremental ones (`analysis.txt`, `response.completed … cached_tokens=`). Arm A's much smaller prompt (5.6k, with no MC guidance) and the cache state at the time may explain this. Three samples settle nothing about the cost of a full resend compared with an incremental turn, and it was not investigated.
- **Reordering on Codex** in responses with several calls, parallel calls, or text after a call. Only one text item followed by one call was observed.
- **Rust transform mode** (`transform_mode: "rust"`) was not run.
- **How often the model writes the tag itself.** It happened in 3 of 3 committed arm B sessions (4 of 5 including the discarded first pass), on the short "Thanks." reply and later ones. It is model behaviour, not something MC controls, and it may differ on longer or tool-heavy replies.
