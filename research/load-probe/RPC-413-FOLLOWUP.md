# RPC 413 follow-up trace

Base: `e6abddafcc6de0d12a23c166c5e64ea6c8b35a4e` (main). Measurements: 2026-10-06. No source/library changes, fresh-connection workaround, retries of failed tests, skips, or timeout increases.

## Result and limit

The timeout reproduced naturally on macOS with Bun 1.3.14 in repetition 9 of the **entire four-file impacted set**. The oversized fetch and JSON finished normally. The follow-up fetch started, but **no follow-up HTTP request event reached the server**, no client headers arrived, and the lifetime aborted that fetch at runner timeout. This identifies the pending operation but does not identify the failed fetch's actual transport connection.

A separate, important runtime difference is established by socket object identity, not inferred from port proximity: **all 58 successful observed follow-ups on Bun 1.3.14 reused the socket that had just returned `connection: close`**. All 100 observed follow-ups on Bun 1.4.2 used a different socket. Thus reuse despite the close header is real on 1.3.14; it is not yet proven to be the cause of the one stalled follow-up. In the failed run, reuse must be recorded as **unknown**, not false: there is no second `IncomingMessage` from which to read its socket. Server-request clocks alone cannot attribute a fetch that never reaches that event.

Do **not** change the test to demand a fresh connection: that would bypass the observed 1.3.14 pooling behavior and weaken the server-usability assertion. The initial trace alone did not establish a fix. The scratch experiment below now measures a library-level prompt stop/close after sending the 413 with `connection: close`; it preserves fetch responses but exposes a streaming-client caveat. This worker did not edit production `src`.

## Instrumentation

`test/rpc/request-errors.test.ts` now passes its failure-only clock into both POSTs and labels client events `oversized` / `follow-up`. Both record fetch start, fetch resolved/rejected, client response headers, and JSON resolved/rejected. `request-phase-clock.ts` observes requests on the oversized request's server port; response header writes and response finish carry a stable server-side socket ID, remote port, request label, and `reused413Connection`. Socket end/destroy/close and body end/abort remain observed without changing server request listeners. Body-byte totals in this clock describe the oversized body only; they are not TCP upload counters. Success still emits no in-suite clock output.

The research-only preload additionally traces successful POSTs when `RPC_413_TRACE_ALL=1`, including socket identities and URLs. `rpc-413-followup-runner.sh` preserves the exact four-file set rather than filtering to the one RPC test. `rpc-413-followup-batch.mjs` invokes `scripts/load-probe.mjs` for each repetition and stops only on the targeted oversized-request test failure (or a spawn error), or at the repetition limit. Unrelated failures are counted, not hidden or rerun. Each repetition is a fresh test process, just as in the existing load probe; pooling within that process is preserved.

## Reproduction clocks

Natural macOS Bun 1.3.14, run 9; milliseconds relative to clock construction:

| Event | ms | Detail |
| --- | ---: | --- |
| oversized fetch start | 7.732 | body 1,048,588 bytes |
| server oversized request | 8.442 | socket 1, remote port 57467 |
| server writes 413 headers | 8.718 | |
| server response finish | 8.806 | |
| oversized fetch settled | 8.880 | resolved |
| oversized client headers | 8.885 | 413, `connection: close` |
| oversized JSON settled | 8.900 | resolved |
| follow-up fetch start | 8.913 | body `{}` |
| follow-up fetch settled | 5001.703 | rejected, lifetime `AbortError` |
| teardown stop | 5001.737 | |
| refused socket local destroy | 5001.811 | socket 1 |
| refused socket close | 5001.884 | socket 1 |
| trace finish | 5002.517 | |

There was no follow-up server request, response write/finish, client headers, or JSON settlement. The original socket stayed open until teardown, with zero observed body bytes and no body-end event. The suite reported **37 pass, 1 fail, 127 assertions, 38 tests across 4 files**, with no extra error. The sole failure was `a request body over the 1 MiB cap answers 413` (5002.74 ms; runner timeout 5000 ms).

The supplied ANTAUTH baseline log was read in full: its 413 JSON settled at 35.818 ms, followed by teardown at 5000.303 ms, and it also reported 37 pass / 1 fail with no extra error. Its missing follow-up clocks are the gap addressed here. That baseline supports the same pending-await diagnosis but cannot establish connection identity.

## Repetition counts (separate environments and runtimes)

| Environment | Bun | Runs | Whole-set pass | Whole-set fail | Target 413 test pass / fail | Observed follow-up reused / fresh / unknown |
| --- | --- | ---: | ---: | ---: | --- | --- |
| natural macOS, 0 workers | 1.3.14 | 9 | 8 | 1 | 8 / 1 | 8 / 0 / 1 |
| natural macOS, 0 workers | 1.4.2 | 50 | 49 | 1 | 50 / 0 | 0 / 50 / 0 |
| loaded Linux VM, 16 workers | 1.3.14 | 50 | 12 | 38 | 50 / 0 | 50 / 0 / 0 |
| loaded Linux VM, 16 workers | 1.4.2 | 50 | 11 | 39 | 50 / 0 | 0 / 50 / 0 |

Bun versions were 1.3.14 (`0d9b296a`) and 1.4.2 (`744846f84`). Successful follow-up fetch-start to JSON-settlement ranges: natural 1.3.14 **0.622–2.801 ms**, natural 1.4.2 **0.576–4.342 ms**, loaded 1.3.14 **0.899–166.270 ms**, loaded 1.4.2 **1.259–30.808 ms**. These are diagnostic runs with the observer preload, not uninstrumented performance benchmarks.

Unrelated failures: natural 1.4.2 had one `schema real runner timeout keeps resources alive through the original body and final assertions` timeout. Loaded 1.3.14 had 38 `runner timeout cancels json in its own drain without a between-tests rejection` failures, five of those runs also failed the corresponding `fetch` test. Loaded 1.4.2 had 39 of the `json` cancellation-test failures. None of these is counted as a reproduction of the target 413 timeout. No tests were changed to accommodate them.

The initial batch driver stopped at any whole-set failure: natural 1.4.2 stopped after 19 runs and each loaded batch after one. Its stopping condition was corrected to stop on the target failure only, and the remaining 31 / 49 / 49 distinct repetitions were run. Totals above include both batches; these were continued measurements, not retries to turn failures green. Evidence retains the original and continuation counts separately.

## Replay and evidence

On the workstation, set `BUN_PROBE_RUNTIME` to the chosen pinned Bun executable and use:

```sh
BUN_PROBE_RUNTIME=/absolute/path/to/bun /absolute/path/to/bun research/load-probe/rpc-413-followup-batch.mjs 0
```

Loaded measurements used task-owned `/home/tester/rpc-413-followup-ec4` on `tester@2.28.133.11`: a git archive of the base plus the test/research changes, with the previous probe's frozen-install `node_modules` copied into this new scratch directory. Neither manifests nor lockfiles changed. Runtime paths were `/home/tester/rt/bun-1.3.14/bun` and `/home/tester/rt/bun-1.4.2/bun`. Run the same command there with `16` instead of `0`. **Do not run CPU saturation on a workstation.** The load workers restart between repetitions; each suite runs under 16 busy-loop workers. The runner's `process.version` is not Bun's version; the preload emits `Bun.version` and executable identity.

`followup-data/trace-evidence.json` retains 159 per-run records: exit status, suite counts, distinct failing test names, both request identities when observed, client settlement phases, oversized socket lifecycle phases, and the full target-failure clock/target-request preload events. Unrelated full stdout was excluded to keep evidence focused. Times in preload records share a process-relative origin; the in-suite failure clock uses its own origin.

The remaining discriminating measurement is client transport / packet evidence in a failing run: did it transmit the follow-up on the refused connection, queue it without writing, or open a new connection that never reached HTTP parsing? Neither local nor VM `sudo -n` allowed packet capture. Without that evidence, the successful reuse observations must not be presented as direct attribution of the failed request.

## Gates

On Bun 1.4.2, TypeScript 7.0.2, Biome 2.5.14:

- `bun run build`: passed; local dependency checker examined 8 manifests; installed-range checker examined 12 dependencies; build TypeScript exited 0.
- `bun run typecheck`: passed after build. The first pre-build attempt lacked generated self-package declarations in unrelated TUI fixture imports; build generated them, and the required typecheck passed without source changes.
- `bun run lint`: passed, 223 files.
- `bun run format:check`: passed, 223 files.
- `bun test --reporter=junit --reporter-outfile=test-results.xml`: passed, 1110 pass / 11 pre-existing skips / 0 fail, 4938 assertions, 1121 tests across 96 files. No new skip was added.
- `bun scripts/check-sources.mjs docs/sources.md test-results.xml`: passed, 1104 cells parsed / 1104 matched. No tests were added/renamed, so no source-table changes were necessary.
- Scoped AFT diagnostics: 0 errors / 0 warnings across 16 RPC test files (14 unrelated hints).

These gates do not erase the repeated Bun 1.3.14 reproduction or unrelated load failures. The change adds observational diagnostics, not a behavioral fix; no mutation-proof claim is made.

## Passive raw-socket controls and scratch close experiment

Follow-up measurements used the same four-file set, natural macOS, zero load workers, and the same pinned Bun binaries. No forwarding proxy was introduced: changing the endpoints could change fetch pooling. The research preload now attaches a `data` listener to **every accepted server socket** at its connection event, without calling `resume`, consuming data, or replacing HTTP listeners. Each actual data event would record timestamp, chunk and cumulative byte counts, identity, and matching apply-request header offsets. Connection, close, and teardown samples cover every accepted socket, not only sockets with parsed requests.

### Raw observation is unavailable, not evidence of client queueing

The listener-only Bun 1.3.14 batch reproduced the target timeout on run **6**: 5 whole-set passes / 1 target failure. All six oversized responses were received and decoded as 413. The five successful follow-ups parsed on the refused socket and decoded as 200. **None of those sockets emitted any raw `data` event**, including the passing requests; their listener byte totals remained zero. The observer did not prevent HTTP parsing in the passing runs or eliminate the reproduction, but failed its positive control as an observer of HTTP transport bytes.

Because the event listener did not expose parsed HTTP bytes, a second passive control sampled `socket.bytesRead` at acceptance, server request, response finish (including the 413 finish), teardown, and socket close. That batch reproduced on run **9**: 7 whole-set passes / 2 failures, comprising one schema-isolation runner timeout on run 7 and the target failure on run 9. Eight target follow-ups parsed on the refused socket and returned 200. **`bytesRead` stayed zero at every sample, including after the parsed two-byte follow-up and at teardown**. It cannot measure growth by the follow-up's wire size and therefore also fails its positive control. In the failed run it was zero at 413 finish and teardown, but that does **not** mean the follow-up was never sent.

Both mechanisms are negative controls on Bun's HTTP compatibility sockets. Discrimination among sent-but-unparsed, sent-on-a-new-socket, and client-queued remains unavailable through these APIs. The two failed positive controls are retained rather than adding a forwarding proxy that would change the client's pooled endpoint; no proxy or packet-capture claim is made. The reproduced listener-only failure had oversized JSON at 14.415 ms and follow-up start at 14.425 ms; follow-up fetch rejected on lifetime cancellation at 5001.477 ms, with no follow-up request event. Full target clocks and accepted-socket samples are retained in `raw-followup-data/observer-close-evidence.json`.

### Scratch-only candidate

A git archive of the committed worktree was unpacked into `research/load-probe/scratch-close`, with a symlink to the prepared `node_modules` and the updated research preload/runner. The **only semantic server delta** in that copy, in the `BodyTooLargeError` catch immediately before returning the 413 JSON, was:

```ts
res.once('finish', () => req.socket.destroy())
```

The scratch source was never staged or committed and was removed after preserving results. Production `src/rpc/rpc-server.ts` remains unchanged. Both candidate batches used `rpc-413-followup-batch.mjs 0 50 all`: the `all` selector runs all 50 distinct repetitions even when a suite fails; it does not retry a failed test. The research preload's HTTP-phase, raw-data, and `bytesRead` observers were active in both baseline and candidate runs. A whole-set pass means the child process running all four impacted files exited 0; a whole-set failure means it exited nonzero.

| Scratch candidate, natural macOS | Runs | Whole-set pass / fail | Oversized fetch headers + JSON | Follow-up headers + JSON | Follow-up socket |
| --- | ---: | --- | --- | --- | --- |
| Bun 1.3.14 | 50 | 48 / 2 | 50 received 413 and decoded expected JSON | 50 received 200 and decoded JSON | 50 fresh / 0 reused |
| Bun 1.4.2 | 50 | 48 / 2 | 50 received 413 and decoded expected JSON | 50 received 200 and decoded JSON | 50 fresh / 0 reused |

Neither runtime's **declared-length fetch** saw a reset, failed JSON read, or hang. Bun 1.3.14 changed from reusing the refused socket to opening a fresh one in every candidate run. Follow-up fetch-start to JSON-settlement ranges were **0.464–3.539 ms** (1.3.14) and **0.486–3.351 ms** (1.4.2). The original oversized-plus-follow-up test passed 50/50 on each runtime; whole-set failures must not be mistaken for failures of that target.

However, the candidate is **not cost-free across all callers**. Bun 1.4.2 candidate run **43** failed `a chunked request body that grows past the cap answers 413` with **`EPIPE: broken pipe, write`**, after the server wrote 413 and destroyed the socket at response finish. That caller uses `node:http.request` while writing the remaining upload, not fetch. The failure clock showed the 413 header at preload time 2221.560 ms, response end at 2221.585, local end at 2221.630, and destroy at 2221.680; the pending upload then reported EPIPE. This is an observed candidate cost, not silently classified as unrelated. Before a general library change is accepted, decide whether an uploader must tolerate a write-side EPIPE while still receiving a 413, or whether the server must preserve the upload's write path long enough to avoid that error. The earlier original-server loaded/natural batches had no recorded failure of this chunked test, but these samples do not prove causation with certainty.

Other candidate whole-set failures were runner timeouts outside the target: Bun 1.3.14 run 13 (`sessionless HTTP oracle retains every notice, filters acknowledged IDs and warns once`) and run 34 (`schema real runner timeout keeps resources alive through the original body and final assertions`); Bun 1.4.2 run 48 (`server wires 90 second inactivity and separate 2 second receipt defaults`). Evidence preserves their exact names and excerpts separately from target outcomes.

**Decision supported by the experiment:** prompt close-on-finish is the correct *library-side direction* for the declared-length fetch reuse problem, not a fresh-connection test workaround: it preserved 413 delivery on both runtimes, stopped 1.3.14 reuse, and produced 100/100 successful target follow-ups. It is not yet a blanket recommendation to merge the exact listener for every 413, because the streaming upload EPIPE must be accounted for. Also, the original failed request's transport mechanism remains unproven; the scratch success is intervention evidence, not packet attribution.

### Production sidebar client scope

`src/rpc/rpc-client.ts:32–43` performs discovery separately inside each `call`; lines **60–63** call `connect({ host: '127.0.0.1', port: entry.port })` to allocate that invocation's raw socket. The request explicitly sends **`Connection: close` at lines 64–74**. The `done` path **at lines 51–58 destroys that socket** on settlement; response completion at lines 81–89 / 128–146 reaches it after the declared body length is received, without waiting for EOF. The exported `pending` and `apply` methods invoke `call` independently **at lines 181–204**. There is no shared socket pool. Therefore this reuse path affects **fetch-based callers**, not the plugin's own `createRpcClient` sidebar transport. That distinction does not remove the library's obligation to work for fetch callers.

### Additional verification

The extension adds research-only observation/measurement controls; it does not change the committed RPC tests or library. The evidence contains 115 new repetitions (6 listener-only, 9 counter-control, 50 + 50 candidate), separate from the initial 159 repetitions. Accepted sockets retain timestamps and raw/counter samples even when HTTP never parses a second request. Neither raw interface validated, so no zero-byte sample is used to infer transport absence. Build (8 manifests / 12 dependency ranges), TypeScript 7.0.2 typecheck, Biome 2.5.14 lint and format (223 files each), the full Bun 1.4.2 JUnit suite (1110 pass / 11 existing skips / 0 fail, 4938 assertions, 96 files), and the source-table check (1104 matched cells) all passed again on the unchanged-production-source worktree.
