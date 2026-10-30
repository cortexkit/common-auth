# Frozen shared quota sidebar frames

These captures intentionally freeze the shared `SidebarFrame` presentation,
not byte-for-byte parity with OpenAI 1.8.4. The original independent OpenAI
captures remain in git at the baseline commit recorded in `provenance.json`.
The provenance retains their source hashes and records the shared capture's
source hashes, runtime, and the presentation decisions that authorize each
changed frame, numbered below to match `changedFramesByRuling`.

There are 32 frames: four inputs in `../cases.ts`, expanded and collapsed, at
allocated widths 16, 36, 37 and 42 (including the frame's one-cell side padding).
The clock is fixed at `2026-06-01T12:00:00Z`; height is 64. Inputs cover long
account/stat values, a blocked account, reserve/deficit pace and overlays, stale
and reset readings, empty/missing quota, a credit budget and prepaid metadata,
low percentages, multiple accounts, version shown/hidden, and an empty roster.

Each `.txt` is the **unaltered UTF-8 buffer** from `captureCharFrame()`, including
trailing spaces, blank rows and its final newline. Each `.spans` is the
unaltered `JSON.stringify(captureSpans())` plus a final newline. The comparison
serializes actual spans in exactly the same way; it does not strip colors,
attributes, blank cells, RGBA buffers, cursor or dimensions. No trimming or
whitespace normalization is permitted. The raw span files use a `.spans`
extension so formatters do not rewrite their serialized bytes.

## Review method

The revised capture renders `../parity-frame.tsx` through the public shared
frame with fixed inputs, Linux, Bun 1.4.4, Solid 1.9.12 and OpenTUI 0.5.12,
using `@opentui/solid/preload` and three layout passes. The adapter still owns
OpenAI-specific status, pacing, credits and routing, not the shared frame.

The expected character edits were specified by hand from the original frames,
then compared with all 32 candidate buffers before updating any golden.
Thirteen frames change under the approved reset, collapsed-row and account-name
rules; nineteen remain byte-identical, including spans. Unchanged rows retain
all per-cell styles, even when preceding wrapped rows disappear. Edited rows
were checked for normal/bold account names and statuses, muted reset text,
and independent trailing indicator colors. `provenance.json` lists every changed
frame and its decision numbers; compare against its baseline git commit for
the exact old/new lines.

## Shared presentation decisions

1. Filled bar cells mean used quota; figures still say how much is left.
2. Shrink bars to four cells before dropping resets; share columns per account.
3. After a reset, replace the old bar/figure with dim `reset since last check`.
4. Keep checked age on its own line below the account's windows.
5. Use normal text color for group titles.
6. End every collapsed row with its indicator, even without a reading.
7. Ellipsize the collapsed label first; if the whole quota still cannot fit,
   show only the fitted label and trailing indicator.
8. Reserve a name gutter only when a window in that account has a name.
9. Accept sparse or unset themes, inheriting normal text or terminal defaults.
10. Ellipsize expanded account names to keep a space before their status.
11. Never replace a supplied header version with account status.

Do not regenerate goldens merely because the renderer changed. A future change
needs an explicit presentation decision, independently specified expected edits,
and a line-by-line review of character and style differences. Normal tests
never regenerate the goldens or read sibling repositories/operator config.
Focused tests cover the reset-preserving four-cell boundary, shared columns,
reset-since-reading replacement, collapsed fitting/dots, unnamed gutters,
sparse/unset themes and account-name separation beyond these frozen inputs.
