# Bounded unlocked schema reads

## Scope and result

Baseline: `5fd04fd7c10ad77db89cb89faf8cd61498d07021`. The test `store shapes > the unlocked legacy config read never observes a partial file during library writes` verifies that unlocked legacy reads see complete JSON while real library writes are in progress. Production, dependencies, deadlines, retries and skips are unchanged. The test still seeds one account, performs all twenty sequential adds, checks twenty individual pre-rename config temp counts equal one, parses every observed read, and checks the legacy reader finds 21 accounts.

The final test bounds reader I/O to **100 reads**, independent of elapsed time, and uses the supported `storeLocks: []` option. One sequential writer does not need config/state transaction locks to exclude another writer in this test. Its reader is deliberately unlocked, so those locks cannot protect or alter that reader's observations. Row and provider locks remain. Real state/config writes still use the production atomic-write path and its ownership checks on the remaining locks. Lock correctness is not the property under test.

Pacing alone was insufficient: the intermediate full natural suite, with normal store locks and the bounded reader, produced 1104 pass, 11 existing skips, **one schema timeout at 5639.33 ms**, in 278.85 s. The full suite was not rerun with that unchanged intermediate configuration. After removing the unnecessary store locks, the full natural suite passed: **1105 pass, 11 existing skips, 0 fail**, 1116 cases across 95 files, 4907 assertions, 109.13 s. After adding the independent reader control and reordering assertions to expose their independent results, the final full gate again passed with the same counts in **90.02 s**. No finite real-filesystem test can guarantee completion against an arbitrary host stall; the change removes elapsed-time-dependent reader work and unnecessary lock I/O, rather than claiming such a guarantee.

### Exact lock-option change and unchanged write/lock coverage

Before: the test omitted `storeLocks`, so `src/store/pool.ts:319–322` supplied `[{ name: 'save', path: configPath }, { name: 'save', path: statePath }]`. After: **`storeLocks: []`**, explicitly replacing just that store-lock list. The test comment states the exact default-to-empty change and explains that one sequential writer plus a deliberately unlocked reader makes these transaction locks irrelevant to this atomic-read observation.

`withTransaction`'s store-lock loop receives the empty list (`src/store/mutate.ts:425–428`). Config/state commits still call the same `this.write` → `writeJsonAtomic` path (`src/store/mutate.ts:324–359`). `src/fs/atomic-write.ts:17–34` still creates a UUID-named exclusive temp, writes pretty-printed `JSON.stringify` plus newline, closes the file, awaits `beforeRename`, and renames over the destination. Neither serialization nor rename was substituted in the delivered test. Row/provider acquisitions remain the ordinary production path.

The following other lock-coverage tests are unchanged from baseline and green in the final full suite (no skips):

- `test/store/refresh.test.ts`: **a refresh takes row, provider-wide and extra locks in order, never holds the store locks across the provider call, and releases in reverse after the hook** (lines 65–129), including both default save locks.
- `test/store/rows.test.ts`: **a failure hook that throws leaves the partial-commit failure intact and every lock released** (350–390), reacquiring config/state save locks and row/provider locks after failure.
- `test/store/rows.test.ts`: **a legacy save lock holder at the config path makes a library write wait and then succeed**, and **a legacy save lock holder at the state path makes a library write fail with lock contention after its timeout** (393–421).
- `test/store/row-extra-locks.test.ts`: **add, replace, rotate and recordIdentity take extra locks after the row and provider-wide locks and before the store locks** (26–100).
- `test/store/account-keyed-refresh.test.ts`: **refreshes of two accounts under the default provider lock never overlap** (455–472).
- `test/store/renewal.test.ts`: parameterized **the store-lock list across one read-modify-write** cases (114–160), checking renewal/expiry at both config and state save-lock paths.

`git diff --exit-code 5fd04fd7c10ad77db89cb89faf8cd61498d07021 -- src/ test/store/refresh.test.ts test/store/rows.test.ts test/store/renewal.test.ts test/store/row-extra-locks.test.ts test/store/account-keyed-refresh.test.ts` exited zero. The slow-release finding below remains a separate observed cost in the ordinary-lock traces; emptying this one test's list does **not** fix or explain slow production lock release.

## Where time goes

`schema-timing.mjs` runs the seed plus twenty adds against real fixture files, using existing `onLockEvent` and `onStep` seams. Modes `tight` and `none` retain ordinary locks; `paced` matches the final test's empty store-lock list. It clocks **each add** and every acquired/released lock event, every before/after state/config step, and reader iterations. Raw per-add traces are in `schema-read-data/`; all local runs are natural, with no generated workstation load. Local runtime was Bun **1.4.2 (744846f84)**.

For normal OAuth adds, `src/store/rows.ts:506–510,637–649` acquires row/provider locks and commits state before config. `src/store/mutate.ts:417–441` acquires and releases the transaction store locks. `src/store/mutate.ts:345–359` calls the before-write seam **inside the atomic writer's beforeRename callback**, after the temp file has been written; the after-write seam follows atomic replacement. Consequently, these are wall-clock phase envelopes, **not syscall-only timings**:

- Lock envelope: add start to the last acquired lock event; includes validation and acquisition/ownership work.
- State envelope: last acquired lock to after-state-write; includes transaction reads, state preparation, temp write, hook and rename/ownership work.
- Config envelope: after-state-write to after-config-write; includes config preparation, temp write, directory inspection, hook and rename/ownership work.
- Release envelope: after-config-write to add resolution; includes the sequential lock releases and small remaining operation bookkeeping.

The before/after-write timestamps alone exclude temp creation and cannot honestly be called the whole write duration. Each raw add has both timestamps so that distinction can be checked.

Aggregates across the twenty adds (ms; rounding may affect totals):

| Mode/run | Total | Reader iterations | Lock envelope | State envelope | Config envelope | Release envelope |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| tight/1 | 195.3 | 2422 | 37.7 | 60.4 | 18.7 | 78.4 |
| tight/2 | 311.9 | 1858 | 37.4 | 41.5 | 21.6 | 211.3 |
| tight/3 | 136.2 | 1845 | 25.3 | 35.5 | 18.5 | 56.8 |
| tight/4 | 189.7 | 1599 | 33.8 | 41.7 | 23.7 | 90.4 |
| tight/5 | 193.6 | 2659 | 28.0 | 47.3 | 28.3 | 89.8 |
| none/1 | 259.0 | 0 | 50.2 | 45.2 | 28.6 | 134.9 |
| none/2 | 138.4 | 0 | 29.8 | 37.1 | 18.3 | 53.2 |
| none/3 | 131.9 | 0 | 20.5 | 34.3 | 18.3 | 58.7 |
| none/4 | 133.6 | 0 | 24.3 | 34.7 | 20.6 | 53.9 |
| none/5 | 182.6 | 0 | 26.1 | 37.8 | 22.4 | 96.2 |

**Finding:** some adds/runs were dominated by post-config lock release, not lock polling. For example, tight/2 spent 211.3/311.9 ms in that envelope. The reader does not acquire locks. Store acquisition sleeps for `retryMs` only if low-level acquisition returns null (`src/store/refresh-lock.ts:89–127`); uncontended acquisitions return immediately. Normal release does marker acquisition, ownership reads, removal and marker cleanup (`src/fs/refresh-file-lock.ts:219–239,266–279,477–493`). Those are real asynchronous file operations. No phase evidence identifies a particular syscall as the historical delay.

**Hypothesis disposition:** the tight loop unquestionably generates unbounded extra I/O (1599–2659 iterations in these five traces), and pacing removes that feedback. These small, non-interleaved natural samples do **not** establish that reader starvation caused the historical 7.4 s outlier. Tight and no-reader timings overlap; no >5 s isolated baseline was reproduced. The polling explanation is unsupported on the normal uncontended path. The intermediate bounded-reader full-suite timeout also refutes an explanation attributing every slow run solely to the tight reader. Host scheduling/filesystem stalls remain possible, not diagnosed.

## Exact read placement and non-vacuity

After the seed, each add has five reads:

1. A read starts alongside `store.add` in `Promise.all`, between write steps, while the add begins its acquisition work. It is not claimed to overlap a particular rename.
2. `before-state-write`: state temp exists, before state rename; reads the config without a lock.
3. `after-state-write`: state rename completed, before config write work begins.
4. **`before-config-write`: config temp exists and directory enumeration has found it, before config rename. The read is awaited by the hook, so it completes strictly inside this config write's temp-exists/pre-rename window.**
5. `after-config-write`: config replacement has completed, before lock release/add completion.

All four hooks await their read. An I/O rejection fails the test instead of being silently discarded; all 100 successful reads must parse. The reader is concurrent with the in-progress writer, including the awaited before-config hook; no reader needs a free-running polling task or timer. This is deterministic seam synchronization, not a statistical chance of sampling the window.

`schema-paced-windows.jsonl` contains five natural final-configuration phase traces, each with 100 reads. For **each** run, the per-add config-window read counts (r0 through r19) are:

```text
r0 r1 r2 r3 r4 r5 r6 r7 r8 r9 r10 r11 r12 r13 r14 r15 r16 r17 r18 r19
 1  1  1  1  1  1  1  1  1  1   1   1   1   1   1   1   1   1   1   1
```

The counter increments only after the read completes at `before-config-write`, and that hook does not return until then. Total twenty-add durations were 82.00, 88.71, 83.81, 73.86, 77.35 ms. The counters locate one awaited config read inside every real pre-rename window. The two independent controls below must not be conflated: the non-atomic control fails the temp-file staging assertion even if the reader never reads. It proves staging coverage only. The separate destination-corruption control preserves all temp counts and the final 21-account result, but fails the JSON-parse assertion on the in-window read; that control proves the reader can detect invalid destination bytes.

## Non-atomic negative control

The temporary source edits used only to validate these assertions are restored; no source edit is delivered. In `src/store/mutate.ts:351`, config alone bypassed `writeJsonAtomic` and instead invoked `before-config-write`, then `Bun.write(path, JSON.stringify(value, null, 2) + '\n')`. State retained the normal atomic writer. The edit was marked **NON-VACUITY BREAK**, identifying a deliberate temporary removal of the behavior being tested. It removed the temp file and rename without neutralizing the observation hook or the rest of the test.

For each structural control: stage the current schema test and research files, confirm empty `git diff --stat`, apply the config-only bypass of atomic replacement, capture **1 file changed, 5 insertions(+), 1 deletion(-)**, run only the named schema test, restore with `git checkout -- src/store/mutate.ts && touch src/store/mutate.ts`, then capture empty `git diff --stat` and successful `git diff --exit-code -- src/`.

The intermediate ordinary-lock version failed the named schema test at 154.22 ms, 0 pass / 1 fail / 12 filtered. The **final empty-store-lock configuration** failed the named schema test at 742.58 ms:

```text
expect(configTemps).toEqual(Array(20).fill(1))
Expected: twenty 1 values
Received: twenty 0 values
(fail) store shapes > the unlocked legacy config read never observes a partial file during library writes [742.58ms]
0 pass
12 filtered out
1 fail
102 expect() calls
```

No other test ran or failed. In those first two controls, parse assertions preceded the structural assertion and had passed. The final test now checks temp counts and the legacy 21-account result before parsing observations, so the independent reader control can demonstrate both structural assertions passed before the parse assertion fails. This is assertion reordering only: no assertion was removed or inverted. A third structural reproof against that final ordering failed at 97.01 ms on twenty zeros versus twenty ones, 0 pass / 1 fail / 12 filtered, 2 assertions. Full output is `schema-read-data/schema-structural-control.out`.

Every structural mutation used the same source bytes (the latest reproof hashes them):

- Mutated `src/store/mutate.ts` SHA-256: `5f1e9ce4e468071ab7b10c5fd35841a1871c4c83f488ce508be60663beaac504`.
- Restored SHA-256: `5da934ff8e3cb972b6bc5e6f1ae2a6b8fcbd9b4fc7ae6da22feca07f6ed10e6b`.
- Mutation position: common transaction writer at baseline `src/store/mutate.ts:351`, config branch only. Read position: final `schema.test.ts:298–313` before-config hook, before the direct destination write in this mutant. Write position: direct `Bun.write(path, serializedConfig)` immediately after that hook; no config temp or rename. Thus this mutant does **not** test partial-file reader sensitivity.
- Each application had 1 file changed / 5 insertions / 1 deletion; each restoration had empty working diff and empty source diff.

### Independent reader control: destination corruption with intact staging

A separate mutation at `src/store/mutate.ts:352–353`, inside the actual atomic writer's `beforeRename` callback, did this before invoking the normal before-config hook:

```ts
// NON-VACUITY BREAK: expose invalid destination bytes while keeping
// the completed temp file and normal final atomic replacement.
if (file === 'config' && this.info.rowId !== 'seed')
  await Bun.write(path, '{')
await this.ctx.onStep?.(`before-${file}-write`, this.info)
```

The seed is unchanged. For every later config write, its fully serialized temp file already exists. The mutation truncates the **real destination** to `{`, then invokes the awaited real pre-rename hook. That hook enumerates the intact temp and reads the invalid destination. Only after the read completes and the hook returns can the writer perform its ordinary ownership assertion and rename the valid temp over the destination. There is no timer, race, or test budget change. The final roster is still valid and has 21 accounts.

The final test order directly establishes independence: count 100 passed, twenty temp counts of one passed, final legacy count 21 passed, then JSON parsing failed on the fourth observed string (the first before-config read). The three earlier strings, read alongside add/at state steps, parsed. There were 7 assertions total: 3 structural/final assertions, 3 successful parses, 1 failing parse. Output in `schema-read-data/schema-reader-control.out`:

```text
expect(configTemps).toEqual(Array(20).fill(1))
expect(legacy?.accounts.length).toBe(21)
for (const text of observed) expect(() => JSON.parse(text)).not.toThrow()
error: expect(received).not.toThrow()
Error name: "SyntaxError"
Error message: "JSON Parse error: Expected '}'"
(fail) store shapes > the unlocked legacy config read never observes a partial file during library writes [106.38ms]
0 pass; 12 filtered out; 1 fail; 7 expect() calls
```

Only this named test ran; no other failure. The mutation changed 1 file / 4 insertions. Mutated `src/store/mutate.ts` SHA-256: `cf8aecb48383f990dd0aebbafcdc3f3a2f0e0f7a845b417cdb81290bcf1dc444`. Restored SHA-256: `5da934ff8e3cb972b6bc5e6f1ae2a6b8fcbd9b4fc7ae6da22feca07f6ed10e6b`. The final schema test was not mutated by either latest control; its SHA-256 in both runs: `276a322b15a5197f47cb5b0b851035ddd19e9b43a9592b52793f905a83bcc706`.

Write position: immediately after temp serialization/close, in `beforeRename`, before `onStep`. Read position: awaited config read in `schema.test.ts:298–313`, reached via `before-config-write`; parse position: `schema.test.ts:330`. Structural count is at line 327 and final 21-account assertion at line 329, both reached and passed before parsing. The `{` bytes remain until that read has observed them; the rename happens only afterward. Stage-before-mutate, non-empty diff capture, `git checkout -- src/store/mutate.ts && touch src/store/mutate.ts`, empty `git diff --stat`, and successful `git diff --exit-code -- src/` were repeated for this isolated control. No deliberate break remains.

## Natural and loaded counts

Only the dedicated VM accessed by SSH as `tester@2.28.133.11` received generated load: `scripts/load-probe.mjs`, ten runs per runtime, **16 busy-loop workers**, sequential batches. Dedicated VM checkout: `/home/tester/common-auth-schema-read`, installed with `~/rt/bun-1.3.14/bun install --frozen-lockfile` (754 packages). Bun **1.3.14 (0d9b296a)** and **1.4.2 (744846f84)** are separate runtime batches. Before is the baseline source; after is the final paced/empty-store-lock test. Body times below are runner-reported, not process startup times.

| Target | Before pass/fail | Before body range (ms) | Final pass/fail | Final body range (ms) |
| --- | --- | ---: | --- | ---: |
| Natural macOS, Bun 1.4.2, five isolated runs | 5/0 | 149.60–206.58 | 5/0 | 281.28–586.64 |
| Loaded VM, Bun 1.3.14, ten isolated runs | 10/0 | 414.13–1301.37 | 10/0 | 185.71–1484.72 |
| Loaded VM, Bun 1.4.2, ten isolated runs | 10/0 | 275.25–408.98 | 10/0 | 166.22–612.02 |

These are small sequential samples under varying natural load, **not a demonstrated failure-rate or speedup comparison**. Raw before/after JSONL includes every exit status and output. Before reader counts can be recovered from expect calls minus three: each observed string contributes one parse assertion. Final runner output has exactly 103 assertions = 100 parses + count + temp counts + final roster count.

Additional paced-with-default-locks data is deliberately retained under `paced-default-locks*`: five natural isolated passes (152.93–380.39 ms), ten loaded 1.3.14 passes (280.29–830.68 ms), ten loaded 1.4.2 passes (246.55–452.36 ms). The paced configuration with default store locks later timed out in the full natural suite; it is not the final configuration.

Replay commands (no local generated load):

```sh
bun research/load-probe/schema-timing.mjs tight 5
bun research/load-probe/schema-timing.mjs none 5
bun research/load-probe/schema-timing.mjs paced 5
bun scripts/load-probe.mjs test/store/schema.test.ts \
  'the unlocked legacy config read never observes a partial file during library writes' 5 0
# On the dedicated VM only, for each version 1.3.14 and 1.4.2:
TEST_BUN="$HOME/rt/bun-$version/bun" "$HOME/rt/bun-$version/bun" \
  scripts/load-probe.mjs test/store/schema.test.ts \
  'the unlocked legacy config read never observes a partial file during library writes' 10 16
```

## Hook clocks and historical limit of evidence

`schema-hook-replay.mjs` copies the **original baseline test**, resolves imports to this worktree, wraps its owner drain to log entry, body-join completion, readiness after joins/finalizers, cleanup entry/exit, and drain return, and logs body completion in `finally`. It leaves the reader, assertions and real 5 s body / 10 s hook deadlines unchanged. It runs naturally up to ten times, stopping at the first timeout. Temporary replay source is removed in its own finally. No generated load was used.

All **ten** replays passed on Bun 1.4.2. `hook-replay.jsonl` retains absolute monotonic timestamps. Below are the first afterEach drain's clocks, in ms relative to body start (the later afterAll drain is also logged but is not the cleanup measurement):

| Run | Body finished | Drain entered | Body joined | Joins/finalizers done | Cleanup started | Cleanup ended | Drain returned |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 458.808 | 458.879 | 458.918 | 459.045 | 459.048 | 459.471 | 459.479 |
| 2 | 193.545 | 193.604 | 193.632 | 193.731 | 193.734 | 194.029 | 194.032 |
| 3 | 209.459 | 209.537 | 209.574 | 209.697 | 209.701 | 210.129 | 210.137 |
| 4 | 179.159 | 179.247 | 179.297 | 179.430 | 179.436 | 179.828 | 179.838 |
| 5 | 151.466 | 151.532 | 151.564 | 151.719 | 151.722 | 152.048 | 152.054 |
| 6 | 154.089 | 154.153 | 154.184 | 156.742 | 156.751 | 157.952 | 157.963 |
| 7 | 161.573 | 161.638 | 161.666 | 161.758 | 161.761 | 162.268 | 162.278 |
| 8 | 146.901 | 146.959 | 146.984 | 147.070 | 147.074 | 147.363 | 147.369 |
| 9 | 144.806 | 144.881 | 144.911 | 145.018 | 145.022 | 145.373 | 145.383 |
| 10 | 198.728 | 198.787 | 198.818 | 198.911 | 198.914 | 199.204 | 199.209 |

The additional `operation-join-complete` marker observes the operations present at drain entry; it is not used to claim termination of operations registered later. `joins-and-finalizers-complete` is the actual cleanup callback boundary after the owner's joins/finalizers. Drain as a whole returns only after cleanup; there is no claim that it returned before cleanup.

**The historical ANTAUTH 10 s hook phase remains unmeasured.** Its log has no phase clocks; none of these ten natural replays reproduced a timeout. It would be unjustified to name that historical interval as measured body-wait rather than operation/finalizer wait or cleanup. The intermediate full-suite failure also had no hook clocks. Ten natural instrumented replays were requested, stopping at the first timeout; all ten completed without one.

Source establishes a narrower statement: `lifetime-hooks.ts:63–67` invokes owner drain before cleanup; `drain-bodies.ts:1–12` releases barriers, awaits bodies, then operations, then cleanup; `test-lifetime.ts:64–88` joins finalizers before scenario cleanup. Thus **if** afterEach is still awaiting the overrun body, that is the intended drain preventing deletion under it, not cleanup racing the body. The original schema reader sets `stop = true` and awaits `reader` in `finally` once adds finish or fail (baseline schema lines 311–318). There is no circular dependency between body and teardown in that code: finite file operations let the adds end, then the reader ends, then drain can finish. Source cannot guarantee an external file operation terminates under arbitrary stalls. All ten clocked bodies did finish, with cleanup strictly afterward. The final test has no detached loop at all; its reads are awaited in the body/hook, and managed add operations remain owned on an assertion/I/O failure.

## Gates and review

Final implementation gates on Bun 1.4.2:

- `bun run build`: passed; 8 local manifests, 12 dependency ranges; TypeScript 7.0.2 build exited zero.
- `bun run typecheck`: passed; `tsc --noEmit`, TypeScript 7.0.2.
- `bun run lint`: passed; Biome 2.5.14, 220 files, no fixes.
- `bun run format:check`: passed; Biome 2.5.14, 220 files, no fixes.
- `bun test --reporter=junit --reporter-outfile=test-results.xml`: 1105 pass, 11 existing skips, 0 fail; 1116 cases / 95 files / 4907 assertions / 90.02 s.
- `bun scripts/check-sources.mjs docs/sources.md test-results.xml`: 1099 cells parsed and matched. The test name/source row is unchanged; no new test registration was added.
- Scoped AFT diagnostics for schema: zero errors/warnings (Tier-2 reachability unavailable).
- Production diff: empty. JUnit scratch removed after source check; frozen local install was already prepared. No manifests or lockfiles changed.

The final full gate ran after the assertion-order and explanatory-comment edits and both independent mutation controls; subsequent changes only update this report. Comment review checked that code comments explain the reason for bounded reads and lock isolation without relying on task history. The VM checkout and JSONL measurements remain available for audit; injected workers are stopped by load-probe's finally.
