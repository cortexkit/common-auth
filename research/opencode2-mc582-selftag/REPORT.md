# Magic Context #582, self-tag instruction: OpenCode 2.0.20 + real Codex backend

Question: `../opencode2-mc582/REPORT.md` found that on OpenCode 2's built-in OpenAI driver (WebSocket), Magic Context's (MC) `§N§ ` tag on replayed assistant text breaks `previous_response_id` continuation, so the host resends the whole history. The only incremental turns there were ones where the model had written the tag itself, with the right number. This run measures whether MC's variant C system line, which asks the model to tag its own replies, makes the replayed text equal the model's raw output on `gpt-5.6-luna` against the real Codex backend, and whether the host then continues incrementally.

## Answer

**Yes. With the line (variant C), every one of the 15 replayed assistant texts was byte-identical to the model's raw output, and all 18 follow-up requests went out as `previous_response_id` + delta. Without it (variant A), 6 of 15 were identical, and 9 of 18 follow-up requests were full resends.** Every full resend's first differing item was an assistant text that MC had tagged and the model had not.

| variant | sessions | model calls | requests after the first in a session | sent as `previous_response_id` + delta | sent as full resend | assistant text items | raw text starting with a tag | stored == raw | replayed later | replayed == raw |
|---|---|---|---|---|---|---|---|---|---|---|
| A (MC, no line) | 3 | 24 | 18 | 9 | 9 | 18 | 7 | 18 | 15 | 6 |
| C (MC + line) | 3 | 24 | 18 | 18 | 0 | 18 | 18 | 18 | 15 | 15 |

"Replayed later" counts texts that a later request carried in its history; each session's last reply is never replayed. Per-request and per-text rows for all six sessions are in [Rows](#rows) below (the same content as `tables.md`).

What the rows show:

- **Mixed text + parallel tool calls.** Each session had two replies that combined a sentence with two parallel calls (turn 1: `shell` ×2; turn 2: `read` ×2). In C, all 6 were self-tagged with the number MC then assigned, for example `§2§ I’m about to run both echo commands in parallel.` followed by `shell({"command":"echo alpha"})` and `shell({"command":"echo beta"})` (`variant-C-1`). In A, none of the 6 were tagged by the model, and each one's replay was the first differing item of a full resend, for example `input[4]`: provider output `"I’m about to run both requested echo commands in parallel."` against the client's `"§2§ I’m about to run both requested echo commands in parallel."` (`variant-A-2`, request 2).
- **The tag number was always right in C.** The model counted user messages, its own texts and tool results: `§2§` (after the prompt `§1§`), `§5§` (after the outputs `§3§`, `§4§`), `§7§`, `§10§`, `§13§`, `§15§`. The sequence was the same in all three C sessions. MC strips a leading tag and prepends the tag it assigns (`tag-content-primitives.ts:135-138`), so a replay equal to the raw output means the model's number equalled MC's.
- **Variant A drifted into self-tagging by itself.** Without the line, the model started tagging from the fourth text reply in all three sessions (`§10§ fixture.txt lists 3 apples.`, `§13§ …`). From then on, A went incremental too (requests 5-7 in every A session). The first three texts (two mixed replies and one final answer) were never self-tagged in A, and they caused all 9 full resends. The last reply, "Thanks." → `You’re welcome!`, was untagged in 2 of 3 A sessions. It was never replayed, because the session ended.
- **Stored text.** In both variants the text OpenCode 2 stored (`messages.json`) equals the raw model text byte for byte, tag included, in 36 of 36 items. MC has no hook on OpenCode 2 that strips a tag before storage: the reply is stored verbatim, and MC adds its tag only on replay. So on OpenCode 2 the comparison that decides continuation is raw against *replayed*, and that is the column that differs between A and C.
- **Tokens.** Codex reported the full context as `input_tokens` on incremental requests too, so input counts are about the same in both variants. C is roughly 140 tokens higher per request, the size of the line: A runs from 8903 on request 1 to 9316-9349 on request 7, C from 9046 to 9503-9531. `cached_tokens` was 8704 on nearly every request after the first, whether it was a full resend or a delta. The exceptions were `cached_tokens=0` on one full resend (`variant-A-1` request 3), on two incremental requests (`variant-A-3` request 5, `variant-C-1` request 5), and on the first request of five sessions. So the uncached column moves with cache misses, not with the continuation mode. Summed per session: A uncached 20538 / 11975 / 20657, C 21743 / 9523 / 13119. What the line saves on Codex is input items sent on the wire: A sessions sent 40 / 43 / 43 input items over their 7 requests, C sessions 11 / 11 / 11. Billed or cached input tokens did not go down in these three sessions.

## The line

Variant C appended this line, byte for byte (sha256 `60c82bb35f419594b5da7076db21ecf3d361ada9071f66e71186fb4c029b44ac`). The text is in `plugin-selftag/line.js`. Before every run, `run.mjs` checks it against the blockquote under "Variant C system line" in `magic-context/.cortexkit/alfonso/plans/issue-582-variant-c.md` and against `instructionC` in `magic-context/packages/plugin/scripts/self-tag-trial/host-plugin.mjs`, and refuses to start if either differs:

> Every user message, every text you write and every tool result in this conversation carries a tag such as §12§, numbered in the order they arrive. Start the text of each reply with exactly §N§ and one space, where N is one more than the highest tag number you can see, tool results included. That applies to every reply that has text, including a short sentence written alongside tool calls, for example `§12§ Reading both files in parallel.` followed by the calls. A reply that is only tool calls gets no tag. IMPORTANT: NEVER write tag notation anywhere else: not mid-text and not in tool arguments. To refer to an item in your prose, write "tag 12".

**MC's wrapper was not used, because it cannot load on OpenCode 2.** `host-plugin.mjs` is an OpenCode 1 plugin. It exports only `server`, wraps MC's OpenCode 1 hooks (`experimental.chat.system.transform` and others), and imports `@opencode-ai/plugin`. OpenCode 2 calls a plugin's `setup(context)`. MC's own OpenCode 2 entry registers a `"context"` session hook and writes its guidance into `draft.system` there (`magic-context/packages/plugin/src/v2/hooks/context.ts:441-467, 1217`). So `plugin-selftag/index.js` is a small OpenCode 2 plugin, listed after MC in `plugins`. It registers its own `"context"` hook and, with `SELF_TAG_VARIANT=C`, pushes `{type:"text", text: <line>}` as a separate, last system entry. With `SELF_TAG_VARIANT=A` it adds nothing. It is loaded in both variants, so the line is the only difference. Evidence for the placement:

- The host runs session-hook callbacks one after another over the same draft, in registration order (`@opencode/core/dist/chunks/credential-pnaxc6j9.js:47-55`). `capture.jsonl` records, for every one of the 42 requests, that `draft.system[0]` already held MC's guidance (`mentionsMagicContext: true`) when the self-tag callback ran. `analyze.mjs` would list any request where it did not; none was listed.
- On the wire, C's `instructions` equal A's byte for byte (18459 characters in every session), followed by `\n` and the line (19112 in total). Within a session, `instructions` and `tools` were the same on every request, in both variants.

## Setup

- **Host:** `@opencode/cli` 2.0.20 in server mode, the same throwaway install as the previous run (`$TMPDIR/oc2-mc582-deps`, reused as is; `run.mjs` checks the version and never installs under this checkout). OpenAI was served by the host's built-in `opencode.provider.openai` plugin with a ChatGPT login against `wss://chatgpt.com/backend-api/codex/responses`. There was one WebSocket per session: `session websocket connected` once, then `reused` for every later request (`server.log`). openai-auth was not loaded.
- **Model:** `gpt-5.6-luna`, reasoning effort `low` (sent as `"reasoning":{"effort":"low","summary":"auto"}`). `parallel_tool_calls` was not set, and the backend's default produced parallel calls.
- **Magic Context:** the local checkout on `master`, commit `d8a6963308f750f3c0959bacfd995d2fa0a81eb7`, package version 0.44.4, `packages/plugin` clean. `dist/index.js` was built at 21:46:45 +02:00, after the last `src` commit (21:45:52). It was loaded as the package directory (`dist/index.js`, OpenCode 2 `setup`) in both variants. MC config as before: `{"historian":{"disable":true},"dreamer":{"disable":true},"embedding":{"provider":"off"},"auto_update":false}`. Tags were on MC's defaults (on with compaction, TypeScript transform).
- **Plugins, in order:** `<run>/plugin-observer` (logs every `experimental.ws.send` frame and every received frame except deltas; HTTP by URL only), MC, `<run>/plugin-selftag`. The observer is the previous run's, unchanged.
- **Fixture:** four prompts per session, the same in every session (`FIXTURE_PROMPTS` in `run.mjs`). The project directory held `fixture.txt` (`apples: 3\npears: 5\n`) and `notes.txt`.
  1. "Write one short sentence saying what you are about to do, then in the same reply call the shell tool twice in parallel: `echo alpha` and `echo beta`. After both results arrive, reply with one short sentence."
  2. "Now write one short sentence, then in the same reply read fixture.txt and notes.txt in parallel with the read tool. After both results arrive, tell me in one sentence how many apples fixture.txt lists."
  3. "Run `echo gamma` with the shell tool, then reply with one short sentence."
  4. "Thanks."
  
  Every session produced the same response shape: turn 1 = text + `shell`×2, then text; turn 2 = text + `read`×2, then text; turn 3 = `shell` alone (a tool-call-only reply; it was untagged in all 6 sessions, as the line asks), then text; turn 4 = text. That is 7 WebSocket requests per session.
- **Sessions:** 3 per variant, run in the order A1, C1, A2, C2, A3, C3.
- **Model calls: 56 in total.** The committed runs made 48: 8 per session, that is 7 `response.create` frames plus 1 title request over HTTP (`POST https://chatgpt.com/backend-api/codex/responses`, kind `title`). 8 more came from one C trial session before the committed runs. It went incremental on all 6 follow-up requests, like the committed C sessions, and its evidence was discarded because the first scrubber missed the stored reasoning blobs. The host also fetched the ChatGPT model list at each start; that is not a model request. No retries fired (`retry` events: 0), and no `server.log` line mentions a refresh.
- **Credential:** `seed-credential.mjs` reads the live ChatGPT access token, its expiry and the account id (from the token's claims) from `~/.local/share/opencode/auth.json`, read-only, once per run. It stores them in the throwaway host database as a `chatgpt-browser` credential with `refresh: "not-a-refresh-token"`, and it loads the host's credential schema from the throwaway install. `run.mjs` refuses to run if the token expires within the hour. At start the token had about 37 hours left.

## Isolation

Each run used `$TMPDIR/oc2-mc582-selftag/<run>/` for `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `XDG_RUNTIME_DIR`, `TMPDIR`, `OPENCODE_DB`, `OPENCODE_CONFIG_DIR`, `MAGIC_CONTEXT_STORAGE_DIR` and `MAGIC_CONTEXT_LOG_PATH`. Only `PATH` was inherited. The host binary ran from the throwaway install, and both local plugins ran from copies in the run root. This worktree is under the real `~/.local/share/cortexkit`, so nothing was executed from it.

`lsof -n -P -p <host pids>` was taken 1.5 s into turn 1 and again at the end of every run (`evidence/*/lsof-during-turn-1.txt`, `lsof-end.txt`). It flags any open file under `<home>/.config/opencode`, `<home>/.local/share/opencode`, `<home>/.config/cortexkit`, `<home>/.local/share/cortexkit`, `<home>/.cache/opencode` and `<home>/.local/state/opencode`. **All 12 snapshots report `# forbidden hits: 0`.** The files open during `variant-C-1`'s turn 1 (pid 82344):

```
<deps>/node_modules/@opencode/cli/bin/opencode.exe
<run>/xdg-data/opencode/opencode.db  (+ -wal, -shm)
<run>/xdg-data/opencode/log/opencode.log
<run>/mc-store/context.db            (+ -wal, -shm)   ← MC's store, inside the throwaway root
<run>/project                        (cwd)
<run>/tmp/.bun-*
/usr/lib/dyld, /usr/share/icu/…, /private/var/db/… (system files), /dev/null, sockets
```

## Files

| File | Role |
|---|---|
| `run.mjs` | `node run.mjs A\|C` (with `RUN_NAME` optional). Checks the line against MC's two sources, builds the isolated environment, seeds the credential, starts `opencode2 serve`, drives one four-turn session, takes the lsof snapshots, and writes scrubbed evidence. |
| `seed-credential.mjs` | Reads the live access token, expiry and account id. Stores only the access token, with an invalid refresh token. |
| `plugin-selftag/` | The OpenCode 2 plugin that appends the line (variant C) and records each request's system entries and MC-transformed history to `capture.jsonl` (both variants). |
| `plugin-observer/index.js` | The frame logger from `../opencode2-mc582`. |
| `analyze.mjs` | Writes `tables.md` and `evidence/<run>/analysis.md`. For each request: how it was sent (the frame's `previous_response_id` and item count, plus the host's `mode=` log line), the first differing item for a full resend (an offline re-run of the host's continuation check, as in the previous run), the response's items, and the tokens. For each assistant text item: the raw output (`output_item.done`), the stored text (`messages.json`), and the text the client replayed (the next request's MC-transformed history from `capture.jsonl`). Where the request after a reply was a full resend, the capture was also checked against that reply's text on the wire: 9 of 9 were equal. |
| `evidence/<run>/` | `observer.jsonl`, `capture.jsonl`, `messages.json`, `server.log`, `harness.jsonl`, `config.json` (host config, MC commit and version, the line's hash), `summary.json`, `lsof-*.txt`, `analysis.md`. |

**Scrubbing:** the access token and account id were replaced by `<redacted-secret>`, and any JWT-shaped string was redacted. Opaque server blobs were replaced by their length and a sha256 prefix: reasoning `encrypted_content` / `reasoningEncryptedContent` and the backend's `x-codex-turn-state` header. `run.mjs` redacts all three. The committed evidence had `x-codex-turn-state` redacted afterwards with the same rule. Paths were replaced by `<run>`, `<deps>`, `<spike>` and `<home>`. Before committing, all committed files were searched for the JWT prefix, the account id, two slices of the access token, the real home path and the Fernet-style prefix the reasoning and turn-state blobs start with, with no matches.

Reproduce: `for s in 1 2 3; do for v in A C; do RUN_NAME=variant-$v-$s node run.mjs $v; done; done`, then `node analyze.mjs variant-A-1 variant-A-2 variant-A-3 variant-C-1 variant-C-2 variant-C-3`.

## Not determined

- **Longer sessions and compaction.** Four turns and seven requests per session, at about 9k tokens, never reached MC's compaction or `ctx_reduce` drops. Whether the model's count stays right after MC renumbers or drops items was not tested.
- **Whether the line would reduce cost on Codex.** In these sessions it cut the input items sent but not the input or cached tokens the backend reported (see Tokens).
- **Other models and effort levels.** Only `gpt-5.6-luna` at `low` was run.
- **Rust transform mode** (`transform_mode: "rust"`) was not run.

## Rows

Generated by `node analyze.mjs …`; identical to `tables.md` below its "Per session" heading. How to read the columns:

- **sent as**: `previous_response_id + k-item delta` means the host sent only the k new input items and pointed at the previous response. `full, n items` means it resent the whole history. **host log** is the host's own `mode=` for the same request.
- **first differing item**: for a full resend, the host's continuation check re-run offline. The previous request's input plus the provider's output items ("provider output") is compared, index by index, with the new full input the client built ("client"), and the first difference is shown.
- **input / cached / uncached**: `usage.input_tokens`, `usage.input_tokens_details.cached_tokens`, and their difference, from `response.completed`.
- **raw model text**: the text of the `output_item.done` message item. **stored**: the same item's text in the host's session store. **replayed**: the same item's text in the next request's history after Magic Context tagged it (`capture.jsonl`), which is what the continuation check compares against the raw output.

### variant-A-1 (variant A, session `ses_f0c09b40cffeqZbkt0EBvUNRUq`)

Model calls: 7 `response.create` frames on the WebSocket + 1 HTTP (title) = 8. Open files under the real opencode/cortexkit directories (lsof): lsof-during-turn-1.txt: 0, lsof-end.txt: 0. Replayed texts that also went on the wire (because the next request was a full resend) and equal the text in capture.jsonl: 3.

Model requests (WebSocket `response.create` frames):

| req | turn | sent as | host log | first differing item (full resends after request 1) | response items | input | cached | uncached | output |
|---|---|---|---|---|---|---|---|---|---|
| 1 (`observer.jsonl:3`) | 1 | full, 3 items | full | (first request) | text, shell×2 | 8903 | 0 | 8903 | 68 |
| 2 (`observer.jsonl:23`) | 1 | full, 8 items | full | input[3] message assistant: provider output "I’m about to run the two requested echo commands in parallel." vs client "§2§ I’m about to run the two requested echo commands in parallel." | text | 9002 | 8704 | 298 | 9 |
| 3 (`observer.jsonl:36`) | 2 | full, 10 items | full | input[8] message assistant: provider output "Both commands completed successfully." vs client "§5§ Both commands completed successfully." | reasoning, text, read×2 | 9064 | 0 | 9064 | 83 |
| 4 (`observer.jsonl:60`) | 2 | full, 16 items | full | input[11] message assistant: provider output "I’m about to read both requested files in parallel." vs client "§7§ I’m about to read both requested files in parallel." | text | 9220 | 8704 | 516 | 14 |
| 5 (`observer.jsonl:73`) | 3 | previous_response_id + 1-item delta | incremental | — | shell | 9260 | 8704 | 556 | 18 |
| 6 (`observer.jsonl:84`) | 3 | previous_response_id + 1-item delta | incremental | — | text | 9293 | 8704 | 589 | 12 |
| 7 (`observer.jsonl:97`) | 4 | previous_response_id + 1-item delta | incremental | — | text | 9316 | 8704 | 612 | 11 |

Assistant text items: raw model output, the host's stored copy, and the copy the client replayed in the next request:

| turn | req | item | phase | calls in same reply | raw model text | stored == raw | replayed by the client (after Magic Context) | replayed == raw |
|---|---|---|---|---|---|---|---|---|
| 1 | 1 | …3641b8 | commentary | 2 | `I’m about to run the two requested echo commands in parallel.` | yes | `§2§ I’m about to run the two requested echo commands in parallel.` | **no** |
| 1 | 2 | …6e0719 | final_answer | 0 | `Both commands completed successfully.` | yes | `§5§ Both commands completed successfully.` | **no** |
| 2 | 3 | …1ab7e5 | commentary | 2 | `I’m about to read both requested files in parallel.` | yes | `§7§ I’m about to read both requested files in parallel.` | **no** |
| 2 | 4 | …48ae12 | final_answer | 0 | `§10§ fixture.txt lists 3 apples.` | yes | same bytes | yes |
| 3 | 6 | …841513 | final_answer | 0 | `§13§ The command completed successfully.` | yes | same bytes | yes |
| 4 | 7 | …fdb481 | final_answer | 0 | `§15§ You’re welcome.` | yes | — (last reply, never replayed) | — |

### variant-A-2 (variant A, session `ses_f0c08e763ffeYa1gyOhXgJvp20`)

Model calls: 7 `response.create` frames on the WebSocket + 1 HTTP (title) = 8. Open files under the real opencode/cortexkit directories (lsof): lsof-during-turn-1.txt: 0, lsof-end.txt: 0. Replayed texts that also went on the wire (because the next request was a full resend) and equal the text in capture.jsonl: 3.

Model requests (WebSocket `response.create` frames):

| req | turn | sent as | host log | first differing item (full resends after request 1) | response items | input | cached | uncached | output |
|---|---|---|---|---|---|---|---|---|---|
| 1 (`observer.jsonl:3`) | 1 | full, 3 items | full | (first request) | reasoning, text, shell×2 | 8903 | 0 | 8903 | 84 |
| 2 (`observer.jsonl:28`) | 1 | full, 9 items | full | input[4] message assistant: provider output "I’m about to run both requested echo commands in parallel." vs client "§2§ I’m about to run both requested echo commands in parallel." | text | 9018 | 8704 | 314 | 15 |
| 3 (`observer.jsonl:41`) | 2 | full, 11 items | full | input[9] message assistant: provider output "Both commands completed: `alpha` and `beta`." vs client "§5§ Both commands completed: `alpha` and `beta`." | reasoning, text, read×2 | 9086 | 8704 | 382 | 79 |
| 4 (`observer.jsonl:65`) | 2 | full, 17 items | full | input[12] message assistant: provider output "I’m about to read both requested files in parallel." vs client "§7§ I’m about to read both requested files in parallel." | text | 9238 | 8704 | 534 | 16 |
| 5 (`observer.jsonl:78`) | 3 | previous_response_id + 1-item delta | incremental | — | reasoning, shell | 9280 | 8704 | 576 | 30 |
| 6 (`observer.jsonl:91`) | 3 | previous_response_id + 1-item delta | incremental | — | text | 9325 | 8704 | 621 | 13 |
| 7 (`observer.jsonl:104`) | 4 | previous_response_id + 1-item delta | incremental | — | text | 9349 | 8704 | 645 | 8 |

Assistant text items: raw model output, the host's stored copy, and the copy the client replayed in the next request:

| turn | req | item | phase | calls in same reply | raw model text | stored == raw | replayed by the client (after Magic Context) | replayed == raw |
|---|---|---|---|---|---|---|---|---|
| 1 | 1 | …2f3796 | commentary | 2 | `I’m about to run both requested echo commands in parallel.` | yes | `§2§ I’m about to run both requested echo commands in parallel.` | **no** |
| 1 | 2 | …e8abe7 | final_answer | 0 | `Both commands completed: \`alpha\` and \`beta\`.` | yes | `§5§ Both commands completed: \`alpha\` and \`beta\`.` | **no** |
| 2 | 3 | …206e1b | commentary | 2 | `I’m about to read both requested files in parallel.` | yes | `§7§ I’m about to read both requested files in parallel.` | **no** |
| 2 | 4 | …71b4eb | final_answer | 0 | `§10§ \`fixture.txt\` lists 3 apples.` | yes | same bytes | yes |
| 3 | 6 | …52d919 | final_answer | 0 | `§13§ The command returned \`gamma\`.` | yes | same bytes | yes |
| 4 | 7 | …1738d4 | final_answer | 0 | `You’re welcome!` | yes | — (last reply, never replayed) | — |

### variant-A-3 (variant A, session `ses_f0c08116bffek3EIqOSNUqJE2l`)

Model calls: 7 `response.create` frames on the WebSocket + 1 HTTP (title) = 8. Open files under the real opencode/cortexkit directories (lsof): lsof-during-turn-1.txt: 0, lsof-end.txt: 0. Replayed texts that also went on the wire (because the next request was a full resend) and equal the text in capture.jsonl: 3.

Model requests (WebSocket `response.create` frames):

| req | turn | sent as | host log | first differing item (full resends after request 1) | response items | input | cached | uncached | output |
|---|---|---|---|---|---|---|---|---|---|
| 1 (`observer.jsonl:3`) | 1 | full, 3 items | full | (first request) | reasoning, text, shell×2 | 8903 | 0 | 8903 | 85 |
| 2 (`observer.jsonl:25`) | 1 | full, 9 items | full | input[4] message assistant: provider output "I’m about to run the two requested echo commands in parallel." vs client "§2§ I’m about to run the two requested echo commands in parallel." | text | 9019 | 8704 | 315 | 16 |
| 3 (`observer.jsonl:38`) | 2 | full, 11 items | full | input[9] message assistant: provider output "Both commands completed successfully: `alpha` and `beta`." vs client "§5§ Both commands completed successfully: `alpha` and `beta`." | reasoning, text, read×2 | 9088 | 8704 | 384 | 78 |
| 4 (`observer.jsonl:59`) | 2 | full, 17 items | full | input[12] message assistant: provider output "I’m about to read both requested files in parallel." vs client "§7§ I’m about to read both requested files in parallel." | text | 9239 | 8704 | 535 | 14 |
| 5 (`observer.jsonl:72`) | 3 | previous_response_id + 1-item delta | incremental | — | shell | 9279 | 0 | 9279 | 18 |
| 6 (`observer.jsonl:83`) | 3 | previous_response_id + 1-item delta | incremental | — | text | 9312 | 8704 | 608 | 14 |
| 7 (`observer.jsonl:96`) | 4 | previous_response_id + 1-item delta | incremental | — | text | 9337 | 8704 | 633 | 8 |

Assistant text items: raw model output, the host's stored copy, and the copy the client replayed in the next request:

| turn | req | item | phase | calls in same reply | raw model text | stored == raw | replayed by the client (after Magic Context) | replayed == raw |
|---|---|---|---|---|---|---|---|---|
| 1 | 1 | …309119 | commentary | 2 | `I’m about to run the two requested echo commands in parallel.` | yes | `§2§ I’m about to run the two requested echo commands in parallel.` | **no** |
| 1 | 2 | …cedfc5 | final_answer | 0 | `Both commands completed successfully: \`alpha\` and \`beta\`.` | yes | `§5§ Both commands completed successfully: \`alpha\` and \`beta\`.` | **no** |
| 2 | 3 | …7b8bd7 | commentary | 2 | `I’m about to read both requested files in parallel.` | yes | `§7§ I’m about to read both requested files in parallel.` | **no** |
| 2 | 4 | …20271a | final_answer | 0 | `§10§ fixture.txt lists 3 apples.` | yes | same bytes | yes |
| 3 | 6 | …b6fbf6 | final_answer | 0 | `§13§ \`echo gamma\` completed successfully.` | yes | same bytes | yes |
| 4 | 7 | …4a1a64 | final_answer | 0 | `You’re welcome!` | yes | — (last reply, never replayed) | — |

### variant-C-1 (variant C, session `ses_f0c0942dfffeEawNdfmeZ3IUMx`)

Model calls: 7 `response.create` frames on the WebSocket + 1 HTTP (title) = 8. Open files under the real opencode/cortexkit directories (lsof): lsof-during-turn-1.txt: 0, lsof-end.txt: 0. Replayed texts that also went on the wire (because the next request was a full resend) and equal the text in capture.jsonl: 0.

Model requests (WebSocket `response.create` frames):

| req | turn | sent as | host log | first differing item (full resends after request 1) | response items | input | cached | uncached | output |
|---|---|---|---|---|---|---|---|---|---|
| 1 (`observer.jsonl:3`) | 1 | full, 3 items | full | (first request) | reasoning, text, shell×2 | 9046 | 0 | 9046 | 91 |
| 2 (`observer.jsonl:28`) | 1 | previous_response_id + 2-item delta | incremental | — | reasoning, text | 9165 | 8704 | 461 | 24 |
| 3 (`observer.jsonl:46`) | 2 | previous_response_id + 1-item delta | incremental | — | reasoning, text, read×2 | 9239 | 8704 | 535 | 86 |
| 4 (`observer.jsonl:70`) | 2 | previous_response_id + 2-item delta | incremental | — | text | 9395 | 8704 | 691 | 14 |
| 5 (`observer.jsonl:83`) | 3 | previous_response_id + 1-item delta | incremental | — | reasoning, shell | 9435 | 0 | 9435 | 30 |
| 6 (`observer.jsonl:96`) | 3 | previous_response_id + 1-item delta | incremental | — | text | 9480 | 8704 | 776 | 12 |
| 7 (`observer.jsonl:109`) | 4 | previous_response_id + 1-item delta | incremental | — | text | 9503 | 8704 | 799 | 11 |

Assistant text items: raw model output, the host's stored copy, and the copy the client replayed in the next request:

| turn | req | item | phase | calls in same reply | raw model text | stored == raw | replayed by the client (after Magic Context) | replayed == raw |
|---|---|---|---|---|---|---|---|---|
| 1 | 1 | …cc07b1 | commentary | 2 | `§2§ I’m about to run both requested echo commands in parallel.` | yes | same bytes | yes |
| 1 | 2 | …4d96cf | final_answer | 0 | `§5§ Both commands completed successfully.` | yes | same bytes | yes |
| 2 | 3 | …a2031b | commentary | 2 | `§7§ I’m about to read both files in parallel.` | yes | same bytes | yes |
| 2 | 4 | …0fff66 | final_answer | 0 | `§10§ fixture.txt lists 3 apples.` | yes | same bytes | yes |
| 3 | 6 | …05216e | final_answer | 0 | `§13§ The command printed gamma.` | yes | same bytes | yes |
| 4 | 7 | …91e734 | final_answer | 0 | `§15§ You’re welcome!` | yes | — (last reply, never replayed) | — |

### variant-C-2 (variant C, session `ses_f0c0879b6ffepyJ1qTqXr3PJ0a`)

Model calls: 7 `response.create` frames on the WebSocket + 1 HTTP (title) = 8. Open files under the real opencode/cortexkit directories (lsof): lsof-during-turn-1.txt: 0, lsof-end.txt: 0. Replayed texts that also went on the wire (because the next request was a full resend) and equal the text in capture.jsonl: 0.

Model requests (WebSocket `response.create` frames):

| req | turn | sent as | host log | first differing item (full resends after request 1) | response items | input | cached | uncached | output |
|---|---|---|---|---|---|---|---|---|---|
| 1 (`observer.jsonl:3`) | 1 | full, 3 items | full | (first request) | reasoning, text, shell×2 | 9046 | 3584 | 5462 | 101 |
| 2 (`observer.jsonl:25`) | 1 | previous_response_id + 2-item delta | incremental | — | reasoning, text | 9175 | 8704 | 471 | 28 |
| 3 (`observer.jsonl:40`) | 2 | previous_response_id + 1-item delta | incremental | — | reasoning, text, read×2 | 9253 | 8704 | 549 | 83 |
| 4 (`observer.jsonl:64`) | 2 | previous_response_id + 2-item delta | incremental | — | text | 9406 | 8704 | 702 | 14 |
| 5 (`observer.jsonl:77`) | 3 | previous_response_id + 1-item delta | incremental | — | reasoning, shell | 9446 | 8704 | 742 | 30 |
| 6 (`observer.jsonl:90`) | 3 | previous_response_id + 1-item delta | incremental | — | text | 9491 | 8704 | 787 | 12 |
| 7 (`observer.jsonl:103`) | 4 | previous_response_id + 1-item delta | incremental | — | text | 9514 | 8704 | 810 | 11 |

Assistant text items: raw model output, the host's stored copy, and the copy the client replayed in the next request:

| turn | req | item | phase | calls in same reply | raw model text | stored == raw | replayed by the client (after Magic Context) | replayed == raw |
|---|---|---|---|---|---|---|---|---|
| 1 | 1 | …49d663 | commentary | 2 | `§2§ I’m about to run both echo commands in parallel.` | yes | same bytes | yes |
| 1 | 2 | …a83a41 | final_answer | 0 | `§5§ Both commands completed successfully.` | yes | same bytes | yes |
| 2 | 3 | …c390bd | commentary | 2 | `§7§ I’m about to read both files in parallel.` | yes | same bytes | yes |
| 2 | 4 | …b10b6e | final_answer | 0 | `§10§ fixture.txt lists 3 apples.` | yes | same bytes | yes |
| 3 | 6 | …a03a35 | final_answer | 0 | `§13§ The command completed successfully.` | yes | same bytes | yes |
| 4 | 7 | …e6adb5 | final_answer | 0 | `§15§ You’re welcome!` | yes | — (last reply, never replayed) | — |

### variant-C-3 (variant C, session `ses_f0c07a796ffejR2vX4LM12zUFI`)

Model calls: 7 `response.create` frames on the WebSocket + 1 HTTP (title) = 8. Open files under the real opencode/cortexkit directories (lsof): lsof-during-turn-1.txt: 0, lsof-end.txt: 0. Replayed texts that also went on the wire (because the next request was a full resend) and equal the text in capture.jsonl: 0.

Model requests (WebSocket `response.create` frames):

| req | turn | sent as | host log | first differing item (full resends after request 1) | response items | input | cached | uncached | output |
|---|---|---|---|---|---|---|---|---|---|
| 1 (`observer.jsonl:3`) | 1 | full, 3 items | full | (first request) | reasoning, text, shell×2 | 9046 | 0 | 9046 | 91 |
| 2 (`observer.jsonl:28`) | 1 | previous_response_id + 2-item delta | incremental | — | reasoning, text | 9165 | 8704 | 461 | 24 |
| 3 (`observer.jsonl:46`) | 2 | previous_response_id + 1-item delta | incremental | — | reasoning, text, read×2 | 9239 | 8704 | 535 | 90 |
| 4 (`observer.jsonl:70`) | 2 | previous_response_id + 2-item delta | incremental | — | reasoning, text | 9399 | 8704 | 695 | 30 |
| 5 (`observer.jsonl:85`) | 3 | previous_response_id + 1-item delta | incremental | — | reasoning, shell | 9455 | 8704 | 751 | 38 |
| 6 (`observer.jsonl:98`) | 3 | previous_response_id + 1-item delta | incremental | — | text | 9508 | 8704 | 804 | 12 |
| 7 (`observer.jsonl:111`) | 4 | previous_response_id + 1-item delta | incremental | — | text | 9531 | 8704 | 827 | 11 |

Assistant text items: raw model output, the host's stored copy, and the copy the client replayed in the next request:

| turn | req | item | phase | calls in same reply | raw model text | stored == raw | replayed by the client (after Magic Context) | replayed == raw |
|---|---|---|---|---|---|---|---|---|
| 1 | 1 | …056b91 | commentary | 2 | `§2§ I’m about to run both echo commands in parallel.` | yes | same bytes | yes |
| 1 | 2 | …ac44dd | final_answer | 0 | `§5§ Both commands completed successfully.` | yes | same bytes | yes |
| 2 | 3 | …fb22d3 | commentary | 2 | `§7§ I’m about to read both files in parallel.` | yes | same bytes | yes |
| 2 | 4 | …906cf2 | final_answer | 0 | `§10§ fixture.txt lists 3 apples.` | yes | same bytes | yes |
| 3 | 6 | …a35ae8 | final_answer | 0 | `§13§ The command printed gamma.` | yes | same bytes | yes |
| 4 | 7 | …4e3fbb | final_answer | 0 | `§15§ You’re welcome!` | yes | — (last reply, never replayed) | — |
