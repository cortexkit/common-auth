// OpenCode 2 plugin for the self-tag measurement. Listed after Magic Context
// in the host's `plugins` array, it registers a "context" session hook, which
// the host runs once per model request, after the hooks registered before it
// (PluginHooks.trigger runs callbacks in registration order over one draft).
//
// SELF_TAG_VARIANT=C appends the variant C line as its own system entry, after
// Magic Context's guidance. SELF_TAG_VARIANT=A appends nothing.
//
// In both variants it records, per request, the system entries and the
// message history exactly as they leave Magic Context's transform. That
// history is what the host turns into the request input, so it shows the
// assistant text the client replays (with Magic Context's tag) even on
// incremental requests, where the full input never goes on the wire.
//
// Magic Context's own trial wrapper (scripts/self-tag-trial/host-plugin.mjs)
// is an OpenCode 1 plugin: it exports only `server`, wraps Magic Context's
// OpenCode 1 hooks, and imports @opencode-ai/plugin. OpenCode 2 calls
// `setup`, so this plugin does the same append on OpenCode 2's hook instead.
import { appendFileSync } from "node:fs";
import { VARIANT_C_LINE } from "./line.js";

const CAPTURE = process.env.SELF_TAG_CAPTURE;
const VARIANT = process.env.SELF_TAG_VARIANT;
let request = 0;

export default {
    id: "cortexkit.spike.mc582-selftag",
    async setup(context) {
        await context.session.hook("context", async (draft) => {
            request += 1;
            const before = draft.system.map((entry) => String(entry.text ?? ""));
            if (VARIANT === "C") draft.system.push({ type: "text", text: VARIANT_C_LINE });
            if (CAPTURE)
                appendFileSync(
                    CAPTURE,
                    `${JSON.stringify({
                        request,
                        wall: Date.now(),
                        sessionID: draft.sessionID,
                        variant: VARIANT,
                        // The system entries as this callback received them. If
                        // Magic Context's callback ran first, its guidance is
                        // already in entry 0, which proves the ordering.
                        systemBefore: before.map((text) => ({ length: text.length, mentionsMagicContext: text.includes("Magic Context"), tail: text.slice(-160) })),
                        systemAfter: draft.system.map((entry) => ({ length: String(entry.text ?? "").length, tail: String(entry.text ?? "").slice(-160) })),
                        messages: draft.messages,
                    })}\n`,
                );
        });
    },
};
