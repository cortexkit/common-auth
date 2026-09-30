// Logs the host's model traffic, to show whether each WebSocket request went
// out incremental (previous_response_id) or as a full resend. Every
// WebSocket frame the host sends (experimental.ws.send) is logged in full, and
// every frame it receives (experimental.ws.receive) is logged in full except
// text/reasoning deltas, which are only counted (the completed items carry the
// same text). HTTP requests are logged by URL and kind only, so request
// headers, which hold the bearer token and account id, never reach the log.
import { appendFileSync } from "node:fs";

const LOG = process.env.SPIKE_OBSERVER_LOG;
let seq = 0;
const log = (event, data = {}) => {
    seq += 1;
    if (LOG) appendFileSync(LOG, `${JSON.stringify({ seq, wall: Date.now(), event, ...data })}\n`);
};
const parse = (text) => {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
};

export default {
    id: "cortexkit.spike.mc582-observer",
    async setup(context) {
        const hook = (name, callback) => context.session.hook(name, callback);
        await hook("http.request", (draft) => {
            log("http.request", { sessionID: draft.sessionID, kind: draft.kind, method: draft.request.method, url: draft.request.url });
        });
        await hook("http.response", (draft) => {
            log("http.response", { sessionID: draft.sessionID, kind: draft.kind, url: draft.request.url, status: draft.response.status });
        });
        await hook("experimental.ws.handshake", (draft) => {
            log("ws.handshake", { sessionID: draft.sessionID, kind: draft.kind, url: draft.url });
        });
        await hook("experimental.ws.send", (draft) => {
            log("ws.send", { sessionID: draft.sessionID, kind: draft.kind, frame: parse(draft.frame) ?? draft.frame });
        });
        let deltas = 0;
        await hook("experimental.ws.receive", (draft) => {
            const frame = parse(draft.frame);
            if (typeof frame?.type === "string" && frame.type.endsWith(".delta")) {
                deltas += 1;
                return;
            }
            log("ws.receive", { sessionID: draft.sessionID, kind: draft.kind, deltasSinceLast: deltas, frame: frame ?? draft.frame });
            deltas = 0;
        });
        await hook("retry", (draft) => {
            log("retry", { sessionID: draft.sessionID, attempt: draft.attempt, error: JSON.stringify(draft.error).slice(0, 400), decision: draft.decision });
        });
    },
};
