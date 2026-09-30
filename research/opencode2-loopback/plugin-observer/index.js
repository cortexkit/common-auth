// A second, unrelated plugin that only watches the host's model traffic. It
// stands for any other plugin a user might run next to the auth plugin: if
// the proxy design is transparent, this plugin keeps seeing every request,
// response and WebSocket frame, error statuses and bodies included, and the
// retry decisions the host makes.
import { appendFileSync } from "node:fs";

const LOG = process.env.SPIKE_OBSERVER_LOG;
const now = () => Number((performance.timeOrigin + performance.now()).toFixed(3));
const log = (event, data = {}) => {
    if (LOG) appendFileSync(LOG, `${JSON.stringify({ t: now(), wall: Date.now(), plugin: "observer", event, ...data })}\n`);
};

export default {
    id: "cortexkit.spike.observer",
    async setup(context) {
        const hook = (name, callback) => context.session.hook(name, callback);
        await hook("http.request", (draft) => {
            log("http.request", { sessionID: draft.sessionID, kind: draft.kind, url: draft.request.url });
        });
        await hook("http.response", async (draft) => {
            const entry = { sessionID: draft.sessionID, kind: draft.kind, url: draft.request.url, status: draft.response.status };
            if (!draft.response.ok) {
                // Read a copy so the host still gets the original body.
                entry.body = (await draft.response.clone().text()).slice(0, 400);
                entry.contentType = draft.response.headers.get("content-type");
                entry.retryAfter = draft.response.headers.get("retry-after");
            } else if (draft.response.body) {
                // Timestamps of the first body chunk and of the chunk carrying
                // response.completed, for latency. (The host stops reading at
                // the terminal event, so a stream-end callback never runs.)
                const decoder = new TextDecoder();
                let chunks = 0;
                const watch = new TransformStream({
                    transform(chunk, controller) {
                        chunks += 1;
                        if (chunks === 1) log("http.body.first-chunk", { sessionID: draft.sessionID, kind: draft.kind });
                        if (decoder.decode(chunk, { stream: true }).includes("response.completed")) log("http.body.completed-seen", { sessionID: draft.sessionID, kind: draft.kind, chunks });
                        controller.enqueue(chunk);
                    },
                });
                draft.response = new Response(draft.response.body.pipeThrough(watch), { status: draft.response.status, statusText: draft.response.statusText, headers: draft.response.headers });
            }
            log("http.response", entry);
        });
        await hook("experimental.ws.handshake", (draft) => {
            log("ws.handshake", { sessionID: draft.sessionID, kind: draft.kind, url: draft.url });
        });
        await hook("experimental.ws.send", (draft) => {
            let frame;
            try {
                frame = JSON.parse(draft.frame);
            } catch {}
            log("ws.send", { sessionID: draft.sessionID, kind: draft.kind, type: frame?.type, previous_response_id: frame?.previous_response_id, input_items: Array.isArray(frame?.input) ? frame.input.length : undefined });
        });
        // With SPIKE_OBSERVER_QUIET=1 only the first text delta of each
        // response is logged, so long streams do not flood the log (and the
        // log writes do not dominate the timings being measured).
        const quiet = process.env.SPIKE_OBSERVER_QUIET === "1";
        let deltaLogged = false;
        await hook("experimental.ws.receive", (draft) => {
            let frame;
            try {
                frame = JSON.parse(draft.frame);
            } catch {}
            if (frame?.type === "response.created") deltaLogged = false;
            if (quiet && frame?.type === "response.output_text.delta") {
                if (deltaLogged) return;
                deltaLogged = true;
            }
            log("ws.receive", { sessionID: draft.sessionID, kind: draft.kind, type: frame?.type, error: frame?.error?.code });
        });
        await hook("retry", (draft) => {
            log("retry", { sessionID: draft.sessionID, attempt: draft.attempt, error: JSON.stringify(draft.error).slice(0, 400), decision: draft.decision });
        });
    },
};
