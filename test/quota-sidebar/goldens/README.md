# Frozen OpenAI 1.8.4 frames

These are independent captures of the released OpenAI renderer, not snapshots
created by `SidebarFrame`. Never update them to accept a shared-frame change.
`provenance.json` records the source-file SHA-256 hashes and the acquisition seam.

There are 32 frames: four inputs in `../cases.ts`, expanded and collapsed, at
allocated widths 16, 36, 37 and 42 (including the frame's one-cell side padding).
The clock is fixed at `2026-06-01T12:00:00Z`; height is 64. Inputs cover long
account/stat values, a blocked account, reserve/deficit pace and overlays, stale
and reset readings, empty/missing quota, a credit budget and prepaid metadata,
low percentages, multiple accounts, version shown/hidden, and an empty roster.

Each `.txt` is the **unaltered UTF-8 buffer** from `captureCharFrame()`, including
trailing spaces, blank rows and its final newline. Each `.spans` is the
unaltered `JSON.stringify(captureSpans())` plus a final newline. The comparison
serializes the actual spans in exactly the same way; it does not strip colors,
attributes, blank cells, RGBA buffers, cursor or dimensions. No trimming or
whitespace normalization is permitted. The raw span files use a `.spans`
extension so formatters do not rewrite their serialized bytes.

## Capture method

The capture used the `cortexkit/openai-auth` repository's
`packages/opencode` source whose
package version is 1.8.4. The renderer's presentation functions (including
`QuotaSidebar`'s returned JSX), quota/state helpers and three routing helpers
were copied verbatim into an isolated test module. Only state/prefs acquisition
and polling were replaced with fixed fixture inputs. No shared-frame code was
imported by that capture. Capture ran on Linux with Bun 1.4.4, Node 24.22.2,
Solid 1.9.12 and OpenTUI 0.5.12, with `@opentui/solid/preload`, and three layout
passes per frame, following the reference's deterministic fixture harness.

The one-off preparation/capture scripts are retained in the delivery's
`.cortexkit/scripts/freeze-quota-sidebar.ts` and
`.cortexkit/scripts/capture-quota-sidebar.tsx`; they are not published product
code or a second maintained renderer. They read copies of the three files
listed in `provenance.json` under `target/scratch/reference/packages/`. A fresh
capture must verify those source hashes first. The normal tests never regenerate
the goldens and need no sibling repository or operator configuration.

The one-cell separator and the narrow-width wrapping/clipping are intentional
reference behavior. In particular width 16 cannot hold some complete suffixes;
those bytes must not be silently replaced with a more attractive layout.
