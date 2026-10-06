# Declared-size RPC refusal: bounded half-close

The unmodified server baseline is commit `3c93e401da3ff1692a3f831ecdc4ba5527315a7d`. Measured 2026-10-06 on macOS and the dedicated Linux VM. This implements a declared-length-only close policy; streamed overflow keeps the existing read-and-discard path.

## Decision and limits

Use **half-close at response finish, keep discarding, then destroy on request-body end or a fixed 2,000 ms bound**. An already-complete request can be destroyed immediately after half-close. The bound matches the default receipt budget, but is a fixed linger limit, not a new public option or a change to configured receipt/inactivity timeouts. Clear the timer when the socket closes, and unref it so it cannot keep the process alive.

The original scratch experiment in `RPC-413-FOLLOWUP.md` established declared-length fetch success with immediate destroy, but not slow declared-length uploader safety. Declared length is not evidence that an upload has finished. All three alternatives below delivered the complete 413 JSON in the controlled samples and stopped Bun 1.3.14 fetch reuse. Half-close avoids deliberately destroying a socket with an unfinished upload at response finish; the additional bound is necessary because end-only left Bun 1.3.14 server compatibility sockets open throughout the observation window. These samples do not establish packet-level FIN/RST behavior or guarantee that arbitrary slow clients cannot see write errors.

Apply the new policy **only to declared oversize**. The streamed path has no added end/destroy listener: the previous immediate-destroy experiment recorded an EPIPE on Bun 1.4.2, and there is no demonstrated need to impose a new close policy on that path. The controlled raw-socket test verifies it is not destroyed before the uploader is permitted to send its final chunk.

Bun 1.4.2's `node:http` writer can reject post-response writes with `ERR_STREAM_DESTROYED`, including under the discard-only baseline. Complete response delivery does not promise that a caller may continue writing after an early rejection. The regression test consumes and checks the complete JSON, even when later write callbacks are rejected. No EPIPE, ECONNRESET, truncated JSON, or fetch failure was observed in the alternative samples, but this is not a proof they are impossible.

## Controlled alternatives (macOS)

`close-alternatives.ts` supplies the close listener before dispatch. The production declared-close block was temporarily neutralized while measuring, then restored from Git's index, where the intended bounded declared-only half-close implementation had been saved. Thus each alternative, rather than two overlapping policies, controlled both oversized paths. The read/discard behavior was unchanged. To replay, run this research script against the base server or explicitly neutralize only the production declared-close block; running it against the fixed server without that preparation would overlap listeners.

For each Bun version, each variant ran once with each of three client types (18 alternative samples total):

- fetch posts 1,310,720 bytes, consumes the entire response, then uses ordinary fetch again on the same origin with `{}`; no agent replacement, cache bypass, or connection header workaround;
- slow declared `node:http.request` writes an initial 256 KiB chunk, then writes the remaining four chunks on 30 ms intervals, with content-length 1,310,720. Response headers arrived with only **one of five** writes issued;
- chunked `node:http.request` uses the same paused writer without content-length. Response headers arrived with **four of five** writes issued.

The probe records request errors, response errors and every write-callback error. It waits 2,100 ms after the follow-up to capture the server socket lifecycle. Client-request close and upload-end events are retained. Error-free Bun 1.3.14 write callbacks do not prove transport bytes were sent: the earlier raw-data/counter controls failed to observe HTTP bytes on these compatibility sockets. The stronger streamed lifetime regression therefore uses a raw half-open client, which can send its last chunk after consuming the response instead of relying on Bun's node:http writer continuing.

| Alternative | Bun | Complete 413 JSON: fetch / slow declared / chunked | EPIPE / reset | Other write-callback errors: fetch / slow declared / chunked | Follow-up status, all three | Refused fetch socket reused | Server socket close observed, all three |
| --- | --- | --- | --- | --- | --- | --- | --- |
| destroy at finish | 1.3.14 | yes / yes / yes | none | 0 / 0 / 0 | 200 | no | yes |
| destroy at finish | 1.4.2 | yes / yes / yes | none | 0 / 4 / 1 ERR_STREAM_DESTROYED | 200 | no | yes |
| end at finish, discard | 1.3.14 | yes / yes / yes | none | 0 / 0 / 0 | 200 | no | no |
| end at finish, discard | 1.4.2 | yes / yes / yes | none | 0 / 4 / 1 ERR_STREAM_DESTROYED | 200 | no | yes |
| end at finish, discard, destroy on body end or 2 s | 1.3.14 | yes / yes / yes | none | 0 / 0 / 0 | 200 | no | yes |
| end at finish, discard, destroy on body end or 2 s | 1.4.2 | yes / yes / yes | none | 0 / 3 / 1 ERR_STREAM_DESTROYED | 200 | no | yes |

Exact records are in `close-alternatives-data/{destroy,end,bounded}-{1.3.14,1.4.2}.jsonl`; all six probe processes exited 0 with empty stderr. The alternatives are small controlled delivery/lifecycle measurements, **not fifty-run estimates** like the separate repeated-suite samples below. `discard-*.jsonl` adds two baseline processes with the same paused writers: Bun 1.4.2 already reported four slow-declared and one chunked ERR_STREAM_DESTROYED callbacks, with complete JSON. Bun 1.3.14 reused the refused fetch socket under discard-only; the subsequent slow-declared follow-up timed out and the chunked follow-up returned 400. Those latter baseline requests did not expose a parsed follow-up socket identity and do not support packet attribution. They are retained, not rerun or counted as alternative successes.

## Deterministic tests and negative controls

The existing `a request body over the 1 MiB cap answers 413` now asserts server-side end, performs the ordinary follow-up immediately, verifies a different server-side socket, and awaits the refused socket's actual close event before teardown. It still checks 413 JSON and follow-up 200. It is not a probabilistic timeout reproduction or a test-client fresh-connection workaround. Bun 1.3.14 normally reaches the fixed two-second linger bound; Bun 1.4.2 closes sooner.

The original chunked test still sends five chunks with node:http and checks 413, now also complete JSON. `streamed overflow keeps the socket open until the client finishes sending` sends four chunk frames on a raw half-open socket, consumes the complete 413, asserts the server socket exists and is not destroyed and no server destroy was recorded, then releases the final chunk and terminator. `a slow declared oversized upload receives complete 413 JSON` covers the paused node:http writer and follow-up.

The controls prove that removing the declared-close behavior or adding premature streamed destruction makes the corresponding assertion fail. They saved the intended implementation in Git's index, verified empty `git diff --stat`, inserted temporary comments marked `NON-VACUITY BREAK` alongside each intentional defect, captured non-empty diff stats, ran tests, and restored with `git checkout -- src/rpc/rpc-server.ts && touch src/rpc/rpc-server.ts`, verifying an empty diff stat afterward:

1. Disable the declared-close block (`if (false && error.declaredOversize)`), Bun 1.3.14: **only** `a request body over the 1 MiB cap answers 413` failed, at the server-local-end assertion (expected true, received false). The original chunked and controlled streamed lifetime tests passed. Diff during mutation: one file, two insertions / one deletion; empty after restore. An earlier broader diagnostic run also included the slow-declared test, which timed out under this removed policy; the isolated three-test control above is the single-failure proof.
2. Add immediate destroy-on-finish to streamed overflow: **only** `streamed overflow keeps the socket open until the client finishes sending` failed on each runtime, at `refusedSocket.destroyed` (expected false, received true). Both original cap tests passed on each runtime. Diff during mutation: one file, two insertions; empty after restore.

## Fifty repetitions per runtime and environment

Each sample runs the **entire four-file impacted set**, including the two new RPC tests: `test/fixtures/request-cancellation.test.ts`, `test/fixtures/lifetime-isolation.test.ts`, `test/rpc/request-errors.test.ts`, `test/rpc/rpc-server.test.ts`. There is no preload, test-name filter, retry, skip, timeout increase, or stop-on-failure. Each repetition is a fresh test process; ordinary in-process fetch pooling remains intact. `scripts/load-probe.mjs` normally selects one file and a test-name pattern; the new runner overrides that selection to execute all four files without filtering.

Local runs use zero load workers. VM runs use 16 busy-loop workers on `tester@2.28.133.11`, held across the fifty repetitions by `scripts/load-probe.mjs`, not on the workstation. VM task copy: `/home/tester/rpc-close-bg-f2414d4d`, base git archive plus the exact source/test/runner edits. Its dependencies are a symlink to the previously frozen-installed `/home/tester/rpc-413-followup-ec4/node_modules`; no manifest/lockfile or dependencies changed.

| Environment | Bun | Whole-set pass / fail | Declared 413 + follow-up pass / fail | Original chunked pass / fail | Controlled streamed lifetime pass / fail | Slow declared complete JSON pass / fail |
| --- | --- | --- | --- | --- | --- | --- |
| natural macOS, 0 workers | 1.3.14 | 47 / 3 | 50 / 0 | 49 / 1 | 50 / 0 | 50 / 0 |
| natural macOS, 0 workers | 1.4.2 | 50 / 0 | 50 / 0 | 50 / 0 | 50 / 0 | 50 / 0 |
| loaded Linux VM, 16 workers | 1.3.14 | 27 / 23 | 50 / 0 | 50 / 0 | 50 / 0 | 50 / 0 |
| loaded Linux VM, 16 workers | 1.4.2 | 28 / 22 | 50 / 0 | 50 / 0 | 50 / 0 | 50 / 0 |

The original chunked test's natural Bun 1.3.14 run 6 failed with **beforeEach/afterEach hook timeout**, not EPIPE/reset. That path has no new close listener; the sample does not establish why the hook stalled, and it is not classified as a clean chunked pass or proven unrelated. Natural run 17 timed out in `rpc-server > starts when the state sweep fails`; run 18 timed out in `schema real runner timeout keeps resources alive through the original body and final assertions`. Loaded failures were exclusively the pre-existing `runner timeout cancels json in its own drain without a between-tests rejection` (23 / 22 runs), also recorded on the unmodified server in `RPC-413-FOLLOWUP.md` (38 and 39 loaded runs respectively). No failure was retried to replace it with green.

`close-verification-data/*.jsonl` retains all 200 per-run statuses, exact named target pass/fail lines, counts/runtime identities and **complete output for failing runs**. Duplicate failure lines in Bun's end-of-run summary do not count as extra test failures.

Replay locally (select the actual pinned executable):

```sh
BUN_PROBE_RUNTIME=/absolute/path/to/bun /absolute/path/to/bun research/load-probe/rpc-close-batch.mjs 0
```

On the VM use `/home/tester/rt/bun-1.3.14/bun` or `/home/tester/rt/bun-1.4.2/bun` and `16` instead of `0`.

## Gates

Both Bun **1.3.14 (0d9b296a)** and **1.4.2 (744846f84)** passed all required gates, with TypeScript **7.0.2** and Biome **2.5.14**:

- `bun run build`: dependency checks examined 8 package manifests and 12 installed ranges; build TypeScript exited 0.
- `bun run typecheck`: `tsc --noEmit` exited 0 (silent success).
- `bun run lint`: 223 files checked, no fixes.
- `bun run format:check`: 223 files checked, no fixes.
- `bun test --reporter=junit --reporter-outfile=test-results.xml`: **1112 pass / 11 existing skips / 0 fail**, 4951 assertions, 1123 tests across 96 files, on each runtime.
- `bun scripts/check-sources.mjs docs/sources.md test-results.xml`: **1106 cells parsed / 1106 matched**, on each runtime.

Bun 1.3.14 gates used `npx --yes bun@1.3.14` as the pinned command prefix; local repetitions used its resolved executable directly. Scoped AFT language-server diagnostics covered 17 files with 0 errors / 0 warnings and 14 pre-existing editor hints about unnecessary await expressions. Comment review prompted clearer measurement prerequisites and request-delivery timeout terminology. No package install, dependency/version change, tag, or publication was performed.
