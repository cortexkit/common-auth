# Magic Context's `§N§ ` tag vs openai-auth's WebSocket continuation on OpenCode 1

This measures magic-context issue 582 on the setup most MC users run: OpenCode 1 plus the openai-auth plugin, whose `ws-pool.ts` implements its own WebSocket continuation. Everything below comes from the WebSocket request bodies that openai-auth dumped (`evidence/*/dumps/*.body.json`, prewarms included). Usage comes from the `response.completed` usage that openai-auth logs (`evidence/*/openai-auth.log`, `main_completed` / `prewarm_completed`) and that OpenCode stores per step (`evidence/*/messages.json`).

## Direct answers

### 1. Continuation, A/B: MC changes nothing on the wire

Both arms send the same request shapes in every run (7 A/B pairs: 4 with `seq 1 400`, 3 with `seq 1 2000`; see the table in answer 4). Each run is five requests:

| # | request | `previous_response_id` | `input` (arm A) | `input` (arm B, MC) | assistant message in `input` |
|---|---|---|---|---|---|
| 1 | turn 1 prewarm (`generate:false`) | none | 0 items | 0 items | no |
| 2 | turn 1 main | prewarm #1's id | 1: user | 3: user, user, user (MC's `<session-history>`, `<session-history-since>`, then the prompt) | no |
| 3 | turn 1 tool continuation | #2's response id | 1: function_call_output | 1: function_call_output | no |
| 4 | turn 2 prewarm (`generate:false`) | none | 0 items | 0 items | no |
| 5 | turn 2 main | prewarm #4's id | 7: user, reasoning, assistant, function_call, function_call_output, assistant, user | 9: user×3, reasoning, assistant, function_call, function_call_output, assistant, user | **yes** (full history) |

Trimmed bodies, run 4 (`evidence/armA-run4/dumps`, `evidence/armB-run4/dumps`; text cut to 60–70 characters):

```text
=== arm A (openai-auth only)
#1 prewarm {"previous_response_id":null,"generate":false,"input":[]}
#2 main    {"previous_response_id":"resp_0765…c2","input":[{"type":"message","role":"user","text":"\"First write one short sentence, then run `seq 1 400` with the shell t"}]}
#3 main    {"previous_response_id":"resp_0765…dd","input":[{"type":"function_call_output","text":"1\n2\n3\n4\n5\n…"}]}
#4 prewarm {"previous_response_id":null,"generate":false,"input":[]}
#5 main    {"previous_response_id":"resp_0b0c…cc","input":[
             {"type":"message","role":"user","text":"\"First write one short sentence, then run `seq 1 400` with the shell t"},
             {"type":"reasoning"},
             {"type":"message","role":"assistant","text":"I will run the requested sequence command now."},
             {"type":"function_call","text":"bash({\"command\":\"seq 1 400\"})"},
             {"type":"function_call_output","text":"1\n2\n3\n…"},
             {"type":"message","role":"assistant","text":"The command completed successfully."},
             {"type":"message","role":"user","text":"Thanks."}]}
=== arm B (openai-auth + Magic Context)
#1 prewarm {"previous_response_id":null,"generate":false,"input":[]}
#2 main    {"previous_response_id":"resp_022d…4b","input":[
             {"type":"message","role":"user","text":"<session-history></session-history>"},
             {"type":"message","role":"user","text":"<session-history-since>(no new content since last materialization)</se"},
             {"type":"message","role":"user","text":"§1§ \"First write one short sentence, then run `seq 1 400` with the she"}]}
#3 main    {"previous_response_id":"resp_022d…70","input":[{"type":"function_call_output","text":"§3§ 1\n2\n3\n…"}]}
#4 prewarm {"previous_response_id":null,"generate":false,"input":[]}
#5 main    {"previous_response_id":"resp_09dd…9e","input":[
             …the three user items of #2, byte-identical…,
             {"type":"reasoning"},
             {"type":"message","role":"assistant","text":"§2§ I’ll run the requested sequence command now."},
             {"type":"function_call","text":"bash({\"command\":\"seq 1 400\",\"workdir\":\"…\"})"},
             {"type":"function_call_output","text":"§3§ 1\n2\n3\n…"},
             {"type":"message","role":"assistant","text":"§4§ Command completed successfully."},
             {"type":"message","role":"user","text":"§5§ Thanks."}]}
```

(The leading `\"` on the user prompt is how `opencode run` delivered the argument, in both arms.)

So on OpenCode 1 + openai-auth:

- **The tool continuation stays incremental with MC loaded.** #3 carries only the `function_call_output` and chains to #2. The tagged assistant text is never sent there. MC did tag it in the body OpenCode built for #3: MC's log for that request reads `transform completed … (4 messages, 3 targets …)`, and the three targets are the user text (§1§), the assistant text (§2§) and the tool output (§3§). `continuationInput` then drops the assistant message from the suffix, so the tag never reaches the wire and never takes part in the prefix check.
- **Every new user turn sends a prewarm followed by the full `input`, in both arms.** This is not caused by the tag. `shouldPrewarm` returns true whenever the new suffix contains a user message, and the prewarm resets the chain. So openai-auth never sends a user turn incrementally, with or without MC, and the OpenCode 2 symptom in issue 582 (a turn that would otherwise be incremental falling back to a full resend) does not exist on this stack. The tag costs no bandwidth here. What it costs is prompt cache (answer 4).
- MC's prefixing is confirmed in the dumps: user text (`§1§`, `§5§`), tool output (`§3§`), and assistant text when it is replayed as history (`§2§`, `§4§` in #5). The two MC `<session-history…>` items and the `<ctx-search-hint>` inside the user message were byte-identical between #2 and #5 in every B run (`evidence/*/turn2-vs-provider.txt`, items 0–2).

### 2. What it compares: the previous request's `input`, not the response output

This was read at openai-auth `824f0335193852c1946d70e7a2301fb417f2a7c1`, `packages/opencode/src/ws-pool.ts`.

The continuation state is written from the request that was sent. The response contributes only its id and the ids of the calls it finalized:

```ts
// ws-pool.ts:855-891  updateContinuation(entry, fullBody, event, finalizedCallIds, chainedToPrior)
  const response = event.response
  const responseID = isRecord(response) && typeof response.id === 'string' ? response.id : undefined
  ...
  entry.continuation = {
    responseID,
    input: fullBody.input,            // 888: the REQUEST's full input
    signature: bodySignature(fullBody),
    finalizedCallIds: chainFinalized,
  }
```

It is called from the main request's completion with `sourceBody`, which is OpenCode's full body before trimming (`ws-pool.ts:362-368`, `updateContinuation(entry, sourceBody, event, finalizedCallIds, mainChainedToPrior)`). After a prewarm it is called with the prewarm body, whose `input` is `[]` (`ws-pool.ts:705` and `prewarmBody`, `ws-pool.ts:753-760`, which sets `generate: false, input: []`).

The check:

```ts
// ws-pool.ts:994-1022
function withContinuation(entry, body) {
  ...
  if (entry.continuation.signature !== bodySignature(body)) { entry.continuation = undefined; return body }
  if (!hasInputPrefix(entry.continuation.input, input)) { entry.continuation = undefined; return body }
  if (entry.continuation.input.length === 0) {
    return { ...body, previous_response_id: entry.continuation.responseID }   // 1005-1009: after a prewarm, full input chained to the prewarm
  }
  const suffix = input.slice(entry.continuation.input.length)
  const nextInput = continuationInput(suffix, entry.continuation.finalizedCallIds)
  if (nextInput.length === 0) return body
  return { ...body, previous_response_id: entry.continuation.responseID, input: nextInput }
}
// ws-pool.ts:1099-1106
function hasInputPrefix(prefix, input) {
  if (prefix.length >= input.length) return false
  for (let index = 0; index < prefix.length; index++) {
    if (stableStringify(prefix[index]) !== stableStringify(input[index])) return false
  }
  return true
}
// ws-pool.ts:1024-1031
function shouldPrewarm(entry, body) {
  ...
  if (!entry.continuation) return true
  if (!input) return false
  if (!hasInputPrefix(entry.continuation.input, input)) return true
  const suffix = input.slice(entry.continuation.input.length)
  return suffix.some(isUserTurnMessage)          // any user/developer message => prewarm
}
// ws-pool.ts:1039-1068  continuationInput: keeps *_output items; keeps function_call only if not finalized;
//   1064: if (item.type === 'message') return item.role !== 'assistant'
// ws-pool.ts:1070-1085  bodySignature excludes input, stream, background, previous_response_id, generate
//   (1087-1096 also excludes client_metadata x-codex-turn-metadata / x-codex-ws-stream-request-start-ms)
```

The dumps agree. #2 is chained to the prewarm with the full `input` (the `length === 0` branch). #3 is chained to #2 with only the suffix left after filtering. In #3 the prefix that was checked is #2's request `input` (3 user items in B), which contains no assistant output at all; the model's output items sit in the suffix. That is why a tagged assistant item can never fail this check inside a tool loop. The comparison runs against the previous request, not against a response envelope as OpenCode 2 does. openai-auth writes no log line for its continuation decision; the evidence is the `previous_response_id` and `input` of each dump, plus `generate:false` on the prewarms.

### 3. What the model sees

Arm B only. Each quote request was designed to land on one path, and the dumps confirm which path it took:

- **Tool continuation (incremental), `evidence/armB-m3b`.** Turn 1: *"First write one short sentence. Then run `seq 1 400` … After the tool result arrives, look at your first sentence of this turn exactly as it appears in your context, list the Unicode code points (U+XXXX) of its first 8 characters, including any symbols, digits or spaces before the first word, then quote the whole sentence verbatim…"*. The answer was produced by request #3:
  `{"previous_response_id":"resp_06a1…6ec62","input":[{"type":"function_call_output","text":"§3§ 1\n2\n3\n…"}]}`, which contains no assistant text.
  The model answered: `U+0054 U+0068 U+0065 U+0020 U+0073 U+0065 U+0071 U+0075` and ```` ```text\nThe sequence is ready.\n``` ````, which matches the sentence it had generated (`The sequence is ready.`; in turn 2 of this session the replayed copy was `§2§ The sequence is ready.`). **No tag.** It sees the provider-side copy of its own raw output. A plain verbatim-quote run of the same design (`evidence/armB-m3`, turn 1) gave `I will run the requested command.`, also untagged.
- **Fresh user turn (full `input`), `evidence/armB-m3c`.** Turn 1 ended with the reply `done`, so the turn-2 question could not be answered by copying an earlier quote (my first attempt, `evidence/armB-m3b` turn 2, was contaminated that way: the model re-used the code points it had printed in turn 1). Turn 2: *"Look at the sentence you wrote just before the tool call in your previous turn, exactly as it appears in your context. List the Unicode code points…"*. The request was #5:
  `{"previous_response_id":"resp_0d6b…1896b","input":[…user×3…, reasoning, {"role":"assistant","text":"§2§ I will run the requested sequence command."}, function_call, {"type":"function_call_output","text":"§3§ 1\n…"}, {"role":"assistant","text":"§4§ done"}, {"role":"user","text":"§5§ \"Look at the sentence…"}]}`
  The model answered: `U+00A7 U+0032 U+00A7 U+0020 U+0049 U+0020 U+0077 U+0069`, i.e. **`§2§ I w`: it sees the tag.** Its verbatim quote of the same sentence was ```` ```text\n I will run the requested sequence command.\n``` ````. The tag was stripped but the space after it was kept, which fits MC's system prompt line *"Never reproduce any of these markings in a reply."* The same leading space appears in `evidence/armB-m3` turn 2. Treat a plain verbatim quote as unreliable evidence of what the model sees under MC; the code points are the reliable measure.

The prediction holds: inside a turn the model sees its untagged text, and on a fresh user turn it sees the tagged text.

### 4. Cache cost at the first tagged assistant message (the follow-up measurement)

For each run: (a) is the last chained step of turn 1's tool loop (#3), (b) is turn 2's prewarm (#4), and (c) is turn 2's main request (#5). Values are input / cached / uncached tokens. Runs 1 are missing (c) in the openai-auth log (the harness killed the server before the logger flushed, which the harness now waits for), so (c) there comes from OpenCode's stored step usage in `messages.json`, which records the same `response.completed` usage.

| tool output | arm · run | (a) tool-loop step | (b) turn-2 prewarm | (c) turn-2 main |
|---|---|---|---|---|
| `seq 1 400` (~810 tok) | A · 1 | 6313 / 4608 / 1705 | 5422 / 0 / 5422 | 6330 / 5632 / 698 ¹ |
| | A · 2 | 6351 / 4608 / 1743 | 5422 / 0 / 5422 | 6368 / **0** / 6368 ² |
| | A · 3 | 6318 / 4608 / 1710 | 5422 / 0 / 5422 | 6335 / 5632 / 703 |
| | A · 4 | 6313 / 4608 / 1705 | 5422 / 0 / 5422 | 6330 / 5632 / 698 |
| | B · 1 | 9670 / 8704 / 966 | 8668 / 0 / 8668 | 9700 / **0** / 9700 ¹ ² |
| | B · 2 | 9662 / 8704 / 958 | 8668 / 0 / 8668 | 9687 / 8704 / 983 |
| | B · 3 | 9672 / 8704 / 968 | 8668 / 0 / 8668 | 9698 / 8704 / 994 |
| | B · 4 | 9714 / 8704 / 1010 | 8668 / 0 / 8668 | 9739 / 8704 / 1035 |
| `seq 1 2000` (~5080 tok) | A · 1 | 10588 / 4608 / 5980 | 5422 / 0 / 5422 | 10615 / **0** / 10615 ² |
| | A · 2 | 10568 / 4608 / 5960 | 5422 / 0 / 5422 | 10584 / **9728** / 856 |
| | A · 3 | 10585 / 0 / 10585 | 5422 / 0 / 5422 | 10602 / **9728** / 874 |
| | B · 1 | 13940 / 8704 / 5236 | 8668 / 0 / 8668 | 13965 / **7680** / 6285 |
| | B · 2 | 13991 / 8704 / 5287 | 8668 / 0 / 8668 | 14017 / **7680** / 6337 |
| | B · 3 | 13983 / 7680 / 6303 | 8668 / 0 / 8668 | 14009 / **7680** / 6329 |

¹ From `messages.json`. ² A complete cache miss. These happened in both arms (3 of 14 turn-2 requests) and look like provider-side cache routing, not content.

What this shows:

- **(b) cannot show a divergence.** The prewarm's `input` is `[]`, so its usage covers only instructions plus tools (5422 in A, 8668 in B), and it reported `cached_tokens: 0` in all 14 runs, including runs where the next request read thousands of cached tokens. The prewarm never carries history.
- **(c): arm A reuses the tool loop's cache and arm B does not.** When arm A's turn 2 hits the cache it reads past everything the tool loop added. Per-item attribution in `evidence/armA-seq2000-run2/analysis.txt` and `…-run3` shows user 26/26, reasoning 18/18, assistant 16/16, function_call 25/25 and function_call_output **4223 of 5078** cached. Arm B's turn 2 never reads more than its tool loop did, and in all five B runs with attribution every item of turn 1 reads 0 cached (for example `evidence/armB-seq2000-run3/analysis.txt`: user items 11/0, 23/0, 96/0, reasoning 20/0, assistant 19/0, function_call 67/0, function_call_output 5082/0). With `seq 1 2000`, arm B leaves **~6.3k** tokens of turn 2 uncached against **~0.86k** in arm A. The extra ~5.4k is the tool loop's content, which the provider had cached untagged.
- **Where the divergence starts: item index 4 of arm B's turn-2 `input`, the first assistant message (`§2§ …`).** `harness/diff_turn2.py` compares turn 2's full `input` with what the provider holds for turn 1: #2's request `input`, #3's request `input`, and the model's own output as OpenCode stored it (`messages.json`). Output from `evidence/armB-seq2000-run3/turn2-vs-provider.txt`:

  ```text
  [0] message:user: identical to #2 input[0]
  [1] message:user: identical to #2 input[1]
  [2] message:user: identical to #2 input[2]
  [3] reasoning: replayed provider output item (not in dumps; compare against arm A's cache attribution)
  [4] message:assistant: DIFFERS from model output: sent '§2§ I’ll run the requested sequence command now.' vs generated 'I’ll run the requested sequence command now.'
  [5] function_call: replayed provider output item (not in dumps; compare against arm A's cache attribution)
  [6] function_call_output: identical to #3 input[0]
  [7] message:assistant: DIFFERS from model output: sent '§4§ The command completed successfully.' vs generated 'The command completed successfully.'
  [8] message:user: new in turn 2
  ```

  The same shape appears in every B run, and in every A run all items are identical. The non-input fields of #3 and #5 (instructions, tools, `prompt_cache_key`, reasoning settings) were identical, apart from the turn-metadata fields that openai-auth excludes from its own signature. The reasoning and function_call items are replayed identically in arm A, where the cache reads straight through them. That leaves the `§2§ ` prefix on item 4 as the first byte difference. So the prediction's "no cost" framing is wrong for the cache. Issue comment 4 says a full resend costs "no prompt-cache tokens, since the resent prefix still matches the provider's cache". On this stack that is not true: inside the tool loop the provider caches the untagged model output, so the tagged replay on the next user turn misses from the first tagged assistant message onward.

## Where the prediction was right, wrong, or untested

- Right: tool continuations inside a turn stay incremental with MC loaded and never resend assistant text; the model sees untagged text there. Each new user turn prewarms (`input: []`, `generate: false`) and then sends the full `input` chained to the prewarm's id; the model sees tagged text there.
- Missing from the prediction: the prewarm and full resend on a user turn are unconditional in openai-auth (`shouldPrewarm` → `suffix.some(isUserTurnMessage)`), so the tag changes nothing on the wire here. Its cost is prompt cache: on each user turn, the tool-loop content after the previous turn's first assistant text is re-read uncached (about 5.4k tokens in this test). Inference, not measured: the turn after that should cache normally, since turn 2's full tagged `input` becomes the new cached prompt.
- Untested: *"a tag that changes on an already-sent item (a drop rewriting it to `[dropped §N§]`) breaks the prefix and forces a prewarm and a full resend."* No drop happened in these short sessions (MC's log reads `verdict=hold reason=tail-below-minimum`). From the code, a rewrite of any item in the previous request's `input` fails `hasInputPrefix`, and `shouldPrewarm` then prewarms. That matters only mid-tool-loop, since user turns prewarm anyway. Not measured.

## What I could not determine

- The exact token where arm B's cache read stops. Every non-zero `cached_tokens` value observed is 512 + k·1024 (4608, 5632, 7680, 8704, 9728), so cache reads appear to move in ~1024-token steps. With `seq 1 400`, the step after 8704 (9728) already lies beyond the shared prefix, so those B runs cannot separate "diverged at item 4" from "no divergence". That is why the `seq 1 2000` runs exist. With `seq 1 2000`, arm B read 7680, one step *below* where item 4 starts (~8.8k), even though items 0–2 are byte-identical. I cannot explain that extra step. The attribution shows only that nothing from turn 1 was reused, not the exact token.
- The provider's response envelopes are not in the dumps, so the reasoning and function_call items are compared by their effect on arm A's cache, not byte for byte.
- Whether the prewarm's `cached_tokens: 0` means the prewarm really missed the cache or only that `generate:false` responses do not report cache reads.
- n is small: 4 `seq 1 400` pairs and 3 `seq 1 2000` pairs, with 3 total misses spread across both arms.

## Setup

- **OpenCode** 1.18.30 (`/Users/ufukaltinok/.opencode/bin/opencode`), driven by one `opencode serve` per session (so openai-auth's in-memory WebSocket pool survives across turns), plus `opencode run --attach … --format json --model openai/gpt-5.6-luna --variant low [--session <id>]` per turn (`harness/run.sh`).
- **Model** `gpt-5.6-luna`, reasoning effort `low` (dumps: `"reasoning":{"effort":"low","summary":"auto"}`), `store:false`, `text.verbosity: low`.
- **openai-auth** at commit `824f0335193852c1946d70e7a2301fb417f2a7c1`, package `@cortexkit/opencode-openai-auth` 0.11.0. Rebuilt with `bun run build` at the repo root before the runs, because `dist` predated HEAD. Loaded as `file://…/openai-auth/packages/opencode/dist/index.js`. Transport: native WebSocket (`webSockets: true`, `rawWebSocket: false`, the default non-raw client), with request dumps on.
- **Magic Context** at commit `f07da4b87224f68e30cb0eade2a536e1a8b4eef9` (`packages/plugin/package.json` version 0.44.3), prebuilt `dist` (built after that commit), loaded as `file://…/magic-context/packages/plugin/dist/index.js` in arm B only. Historian, dreamer and embeddings were disabled so that only main model requests reach the provider.
- **Model requests: 88 in total, 34 of them prewarms.** 17 recorded sessions × 5 requests (all in `evidence/`), plus 3 requests from a first arm-A attempt whose harness died after turn 1 (its dumps were wiped by the re-setup). No title or other side requests were made: every session has exactly 5 dumps and no `http` phase.
- Other non-model traffic: one quota check per server start (`[quota] quota refresh succeeded`, a usage read, not a token refresh).

### Exact configs (arm B; arm A is the same without the MC plugin entry and without `magic-context.jsonc`)

`$OPENCODE_CONFIG_DIR/opencode.json`:
```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file://$HOME/Work/Projects/CortexKit/openai-auth/packages/opencode/dist/index.js", "file://$HOME/Work/Projects/CortexKit/magic-context/packages/plugin/dist/index.js"],
  "model": "openai/gpt-5.6-luna",
  "small_model": "openai/gpt-5.6-luna",
  "autoupdate": false,
  "share": "disabled",
  "permission": { "bash": "allow", "edit": "deny", "webfetch": "deny" }
}
```
`$OPENCODE_CONFIG_DIR/openai-auth.json` as written by `harness/setup.sh`. At startup openai-auth adds `version`, `main`, `mainAccountId` (redacted in `evidence/*/config/`) and `accounts: []`; there are no fallback accounts:
```json
{ "webSockets": true, "rawWebSocket": false, "dump": true, "dumpDir": "$TMPDIR/oc1-mc582/armB/dumps" }
```
`$XDG_CONFIG_HOME/cortexkit/magic-context.jsonc`:
```jsonc
{ "historian": { "disable": true }, "dreamer": { "disable": true }, "embedding": { "provider": "off" } }
```
Environment (`harness/env.sh`): `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `XDG_RUNTIME_DIR` (from the last pair of runs on, see below), `TMPDIR`, `OPENCODE_CONFIG_DIR`, `OPENCODE_TUI_PREFERENCES_FILE`, `OPENCODE_OPENAI_AUTH_FILE`, `OPENCODE_OPENAI_AUTH_STATE_FILE`, `OPENCODE_OPENAI_AUTH_LOG_FILE` (level `debug`, so usage diagnostics are logged), `OPENCODE_OPENAI_AUTH_DUMP_DIR`, `OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE`, `OPENCODE_OPENAI_AUTH_RPC_DIR`, `OPENCODE_OPENAI_AUTH_MODELS_CACHE`, `CLAUSTRUM_OPENCODE_HANDLES`, `MAGIC_CONTEXT_STORAGE_DIR` and `MAGIC_CONTEXT_LOG_PATH` all point under `$TMPDIR/oc1-mc582/arm{A,B}/`. `CORTEXKIT_OPENAI_AUTH_WEBSOCKETS=1` and `CORTEXKIT_OPENAI_AUTH_DUMP=1` are set. `OPENCODE_DB`, `OPENCODE_CHANNEL`, `OPENCODE_MODELS_PATH`, `CLAUSTRUM_SUBC_CONNECTION` and the raw-WS / responses-lite / endpoint overrides are unset.

### Credential

`harness/setup.sh` writes the throwaway `$XDG_DATA_HOME/opencode/auth.json` as `{openai: {type: "oauth", access: <live access>, expires: <live expires>, refresh: "not-a-refresh-token"}}` with `jq`, under `umask 077`, and never prints the token. The live entry has no `accountId`; openai-auth derives it from the access token. After the runs, both throwaway files still held `refresh: "not-a-refresh-token"` and the unchanged access token. No token-refresh log line appeared. The live `~/.local/share/opencode/auth.json` was last modified 2026-09-26 20:07, and `~/.config/opencode/openai-auth.json` and `openai-auth-state.json` on 2026-09-22 and 2026-09-29, all before these runs (10:27–10:47 on 2026-09-30). The live dump directory `$TMPDIR/opencode-openai-auth-dumps` contains no file for any of the 17 session ids. Its newer files belong to the operator's own OpenCode process (pid 38258).

### Isolation proof (`lsof`)

`harness/run.sh` snapshots `lsof -p` for the `opencode serve` process (and any children) after each turn, while the server is live with both plugins loaded. `harness/check_isolation.sh evidence` scans all 34 snapshots for the real `~/.config/opencode`, `~/.local/share/opencode`, `~/.local/state/opencode`, `~/.cache/opencode`, `~/.config/cortexkit`, `~/.local/share/cortexkit`, `~/.local/state/cortexkit`, `$TMPDIR/opencode-openai-auth*` and `$TMPDIR/opencode/magic-context` (`evidence/isolation-check.txt`). Every snapshot has exactly two hits, the same two each time:

```text
evidence/armB-run4/lsof.turn2.txt: 72 open files, 2 under real locations
    fd 3u /Users/ufukaltinok/.local/share/cortexkit/aft/opencode/bash-tasks/a890a263f7a17fa7/bash-bc3a7333580e4e2d/io/exit
    fd 4u /Users/ufukaltinok/.local/share/cortexkit/aft/opencode/bash-tasks/a890a263f7a17fa7/bash-bc3a7333580e4e2d/io/sandbox-unavailable
```

These are descriptors 3 and 4 inherited from the agent's bash tool, which launched the harness (its task-status files). OpenCode did not open them, and they are not OpenCode, openai-auth or MC state. Every other open file is under the throwaway root, a system path, or the `opencode` binary. From the arm-B snapshot:

```text
$TMPDIR/oc1-mc582/armB/home/.local/share/cortexkit/magic-context/context.db{,-shm,-wal}
$TMPDIR/oc1-mc582/armB/home/.local/share/opencode/opencode.db{,-shm,-wal}
$TMPDIR/oc1-mc582/armB/home/.local/share/opencode/log/opencode.log
$TMPDIR/oc1-mc582/armB/project
$TMPDIR/oc1-mc582/armB/runs/m1/serve.log
$TMPDIR/oc1-mc582/armB/tmp/.bun-501-*.{node,dylib}
/Users/ufukaltinok/.opencode/bin/opencode
```

**One isolation gap, found and closed during the work.** In the first 15 sessions, `XDG_RUNTIME_DIR` was not redirected and still pointed at `/Users/ufukaltinok/.local/share/cortexkit/run`. openai-auth's custody detector (`claustrum/packages/client/src/detect.ts`) reads `<XDG_RUNTIME_DIR>/subc-connection.json` to decide whether a Claustrum connection exists. Those runs logged `custody connection available but mode is local; manifest read for the refresh gate, no client/timer`, which means the live descriptor was **read** (read-and-close, so `lsof` cannot show it), but no client was created and no connection was opened (`custody-runtime.ts:231-236`). The live file's mtime (2026-09-28 13:08) is unchanged. `env.sh` now redirects `XDG_RUNTIME_DIR` and unsets `CLAUSTRUM_SUBC_CONNECTION`. The last A/B pair (`*-seq2000-run3`) ran with that fix, logged `custody not configured; no client/timer created`, and reproduced the same cache result (A 9728 cached, B 7680).

## Layout

- `harness/env.sh`: throwaway environment (source with `ARM=A|B`).
- `harness/setup.sh`: fresh root, configs, seeded `auth.json`.
- `harness/run.sh <label> <prompt>…`: one `opencode serve`, one session, one turn per prompt, `lsof` after each turn, stored messages.
- `harness/collect.sh <label> <dest>`: copies bodies, meta, logs, messages, lsof and configs into `evidence/`. It replaces every JWT-shaped string (base64 of `{"`) and the account id, skips the `.request.json` header sidecars, and fails if either string survives.
- `harness/analyze.py <root|evidence dir>`: per-request kind, `previous_response_id`, `input` items, usage and per-item cache attribution (`evidence/*/analysis.txt`).
- `harness/diff_turn2.py <evidence dir>`: turn 2's `input` compared against the provider's turn-1 items (`evidence/*/turn2-vs-provider.txt`).
- `harness/check_isolation.sh <evidence dir>`: the `lsof` scan above.
- `evidence/arm{A,B}-run{1..4}`: `seq 1 400`, prompts *"First write one short sentence, then run `seq 1 400` with the shell tool."* then *"Thanks."*
- `evidence/arm{A,B}-seq2000-run{1..3}`: the same prompts with `seq 1 2000`.
- `evidence/armB-m3`, `armB-m3b`, `armB-m3c`: the what-the-model-sees prompts (answer 3).
