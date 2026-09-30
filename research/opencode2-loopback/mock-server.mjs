// Loopback stand-in for the ChatGPT Codex backend
// (chatgpt.com/backend-api/codex). It answers `POST .../responses` with an
// HTTP SSE stream and accepts WebSocket connections on the same port that
// stream `response.*` frames, honours `previous_response_id` only on the
// connection that issued it (as the real backend does), and sends a
// `codex.rate_limits` frame before every WebSocket response. Every request,
// frame, close and abort it sees is written as one JSON line with a
// millisecond timestamp, so the report can line up what the host did, what
// the proxy did and what reached this "upstream". Nothing here talks to a real
// provider.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

// Two fake ChatGPT accounts. A request belongs to an account only when both
// its bearer token and its chatgpt-account-id header match; anything else is
// "none", so a request sent under the wrong or a mixed identity stands out.
const ACCOUNTS = {
    A: { token: "tok-A", id: "acct-A" },
    B: { token: "tok-B", id: "acct-B" },
};
const KNOWN_FAKE_TOKENS = new Set(["tok-A", "tok-B", "tok-HOST", "sk-mock-not-a-real-key"]);
const QUOTA = { A: { primary: 11, secondary: 21 }, B: { primary: 55, secondary: 65 } };

export const now = () => Number((performance.timeOrigin + performance.now()).toFixed(3));

export function identify(headers) {
    const auth = headers.authorization;
    const token = typeof auth === "string" ? /^Bearer (.+)$/i.exec(auth)?.[1] : undefined;
    const accountHeader = headers["chatgpt-account-id"];
    const tokenLabel = token === undefined ? null : KNOWN_FAKE_TOKENS.has(token) ? token : `<other len=${token.length}>`;
    for (const [name, account] of Object.entries(ACCOUNTS)) {
        if (token === account.token && accountHeader === account.id) return { account: name, token: tokenLabel, accountHeader };
    }
    return { account: "none", token: tokenLabel, accountHeader: accountHeader ?? null };
}

function visibleHeaders(headers) {
    const out = {};
    for (const [key, value] of Object.entries(headers)) {
        out[key] = key === "authorization" ? `<${identify({ authorization: value }).token}>` : value;
    }
    return out;
}

// What kind of request this is, judged only from the body the host built: the
// agent loop sends tools, a title request asks for a title, a compaction
// request carries the host's summary prompt. Used for logging and for
// targeting injected behaviour at agent-loop requests.
function classify(json) {
    if (!json || typeof json !== "object") return "unknown";
    const instructions = String(json.instructions ?? "");
    if (/title generator/i.test(instructions)) return "title";
    if (Array.isArray(json.input) && json.input.some((item) => item?.type === "compaction_trigger")) return "compaction";
    if (Array.isArray(json.tools) && json.tools.length > 0) return "primary";
    if (/summar|compact/i.test(instructions + JSON.stringify(json.input ?? "").slice(-4000))) return "compaction?";
    return "other";
}

function summarize(json) {
    if (!json || typeof json !== "object") return undefined;
    return {
        type: json.type,
        model: json.model,
        keys: Object.keys(json).sort(),
        previous_response_id: json.previous_response_id,
        input_items: Array.isArray(json.input) ? json.input.length : undefined,
        prompt_cache_key: json.prompt_cache_key,
        tools: Array.isArray(json.tools) ? json.tools.length : undefined,
        instructionsHead: typeof json.instructions === "string" ? json.instructions.slice(0, 80) : undefined,
        lastInput: Array.isArray(json.input) ? JSON.stringify(json.input.at(-1)).slice(0, 160) : undefined,
    };
}

// The Responses event sequence for one assistant message, with the text split
// into `deltas` pieces so a stream can be made long enough to abort mid-way.
export function responsesEvents(text, responseID, deltas = 1) {
    const itemID = `msg_${responseID}`;
    const response = (status, output) => ({
        id: responseID,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status,
        model: "mock-model",
        output,
        usage:
            status === "completed"
                ? { input_tokens: 11, input_tokens_details: { cached_tokens: 0 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 14 }
                : null,
    });
    const doneItem = { id: itemID, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] };
    const pieces = [];
    for (let i = 0; i < deltas; i += 1) pieces.push(i === deltas - 1 ? text : `.`);
    const full = deltas === 1 ? text : `${".".repeat(deltas - 1)}${text}`;
    doneItem.content[0].text = full;
    let seq = 0;
    const events = [
        { type: "response.created", sequence_number: seq++, response: response("in_progress", []) },
        { type: "response.output_item.added", sequence_number: seq++, output_index: 0, item: { id: itemID, type: "message", status: "in_progress", role: "assistant", content: [] } },
        { type: "response.content_part.added", sequence_number: seq++, item_id: itemID, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    ];
    for (const delta of pieces) events.push({ type: "response.output_text.delta", sequence_number: seq++, item_id: itemID, output_index: 0, content_index: 0, delta });
    events.push(
        { type: "response.output_text.done", sequence_number: seq++, item_id: itemID, output_index: 0, content_index: 0, text: full },
        { type: "response.content_part.done", sequence_number: seq++, item_id: itemID, output_index: 0, content_index: 0, part: { type: "output_text", text: full, annotations: [] } },
        { type: "response.output_item.done", sequence_number: seq++, output_index: 0, item: doneItem },
        { type: "response.completed", sequence_number: seq++, response: response("completed", [doneItem]) },
    );
    return events;
}

const sse = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

function quotaHeaders(account) {
    const quota = QUOTA[account];
    if (!quota) return {};
    return { "x-codex-primary-used-percent": String(quota.primary), "x-codex-secondary-used-percent": String(quota.secondary) };
}

function rateLimitsFrame(account) {
    const quota = QUOTA[account] ?? { primary: 0, secondary: 0 };
    return { type: "codex.rate_limits", plan_type: "plus", rate_limits: { primary: { used_percent: quota.primary, window_minutes: 300 }, secondary: { used_percent: quota.secondary, window_minutes: 10080 } } };
}

/**
 * Starts the mock on an ephemeral loopback port.
 *
 * `plan` is consumed by agent-loop requests (HTTP or WebSocket), one entry per
 * request, oldest first; once it is empty every request gets "ok". Entries:
 *   "ok"                  a normal short reply
 *   { slow: n, every: ms } n text deltas, one every `ms` milliseconds
 *                         (a negative `ms` writes them back to back)
 *   { hold: ms }          wait `ms` before the response headers (HTTP) or the
 *                         first frame (WebSocket), then reply normally
 *   { status: 429|400 }   HTTP error with a JSON body (HTTP only)
 * `onEvent` is called with every log entry, so the harness can react to
 * upstream activity (for example abort a turn once output is flowing).
 */
export async function startMock({ log, plan = [], onEvent = () => {} }) {
    let requests = 0;
    let connections = 0;
    const pending = [...plan];
    const record = (entry) => {
        const line = { t: now(), wall: Date.now(), ...entry };
        appendFileSync(log, `${JSON.stringify(line)}\n`);
        onEvent(line);
    };
    const nextAction = () => pending.shift() ?? "ok";

    const server = createServer((req, res) => {
        const chunks = [];
        let finished = false;
        let index;
        req.on("data", (chunk) => chunks.push(chunk));
        // Fired when the client side goes away before the reply was completed:
        // this is what an upstream abort looks like from the backend.
        res.on("close", () => {
            if (!finished) record({ transport: "http", action: "client-closed-early", request: index, writableEnded: res.writableEnded });
        });
        req.on("end", async () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json;
            try {
                json = JSON.parse(text);
            } catch {}
            index = ++requests;
            const kind = classify(json);
            const identity = identify(req.headers);
            record({ transport: "http", action: "request", request: index, method: req.method, url: req.url, kind, identity, viaProxy: req.headers["x-spike-via-proxy"] ?? null, headers: visibleHeaders(req.headers), body: summarize(json) });
            if (!/\/responses$/.test(req.url ?? "")) {
                finished = true;
                res.writeHead(404, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: `mock: no route ${req.url}` } }));
                return;
            }
            const action = kind === "primary" ? nextAction() : "ok";
            if (action !== "ok") record({ transport: "http", action: "plan", request: index, plan: action });
            if (action.hold) await new Promise((resolve) => setTimeout(resolve, action.hold));
            if (res.destroyed || res.writableEnded || req.socket.destroyed) {
                record({ transport: "http", action: "gone-before-headers", request: index });
                return;
            }
            if (action.status) {
                finished = true;
                const body = action.status === 429
                    ? { error: { type: "usage_limit_reached", code: "rate_limit_exceeded", message: "mock: rate limited", resets_in_seconds: 30 } }
                    : { error: { type: "invalid_request_error", code: "mock_bad_request", message: "mock: bad request body", param: "input" } };
                res.writeHead(action.status, { "content-type": "application/json", ...(action.status === 429 ? { "retry-after": "1" } : {}), ...quotaHeaders(identity.account) });
                res.end(JSON.stringify(body));
                record({ transport: "http", action: `sent-${action.status}`, request: index });
                return;
            }
            const responseID = `resp_http_${index}`;
            const events = responsesEvents(`MOCK-HTTP-${index}-${kind}-acct-${identity.account}`, responseID, action.slow ?? 1);
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...quotaHeaders(identity.account) });
            record({ transport: "http", action: "headers-sent", request: index });
            let sent = 0;
            for (const event of events) {
                if (res.destroyed) {
                    record({ transport: "http", action: "stopped-streaming", request: index, sent, total: events.length });
                    return;
                }
                res.write(sse(event));
                sent += 1;
                if (action.slow && event.type === "response.output_text.delta") {
                    if (sent === 4) record({ transport: "http", action: "first-delta-sent", request: index });
                    if (action.every >= 0) await new Promise((resolve) => setTimeout(resolve, action.every));
                }
            }
            finished = true;
            res.end();
            record({ transport: "http", action: "completed", request: index, frames: sent });
        });
    });

    const wss = new WebSocketServer({ server });
    wss.on("connection", (socket, req) => {
        const connection = ++connections;
        const identity = identify(req.headers);
        // Response IDs this socket issued; the real backend only honours a
        // previous_response_id on the connection that produced it.
        const issued = new Set();
        let busy = false;
        record({ transport: "ws", action: "handshake", connection, url: req.url, identity, viaProxy: req.headers["x-spike-via-proxy"] ?? null, headers: visibleHeaders(req.headers) });
        socket.on("close", (code, reason) => record({ transport: "ws", action: "closed", connection, code, reason: reason.toString(), busy }));
        socket.on("message", async (data) => {
            const text = data.toString("utf8");
            let json;
            try {
                json = JSON.parse(text);
            } catch {}
            const index = ++requests;
            const kind = classify(json);
            const known = json?.previous_response_id ? issued.has(json.previous_response_id) : undefined;
            record({ transport: "ws", action: "frame-in", connection, request: index, kind, identity, previousKnownOnConnection: known, body: summarize(json) });
            const send = (event) => {
                if (socket.readyState !== socket.OPEN) return false;
                socket.send(JSON.stringify(event));
                return true;
            };
            if (known === false) {
                send({ type: "error", status: 400, error: { type: "invalid_request_error", code: "previous_response_not_found", message: `Previous response with id '${json.previous_response_id}' not found.`, param: "previous_response_id" } });
                record({ transport: "ws", action: "sent-previous_response_not_found", connection, request: index });
                return;
            }
            const action = kind === "primary" ? nextAction() : "ok";
            if (action !== "ok") record({ transport: "ws", action: "plan", connection, request: index, plan: action });
            busy = true;
            if (action.hold) await new Promise((resolve) => setTimeout(resolve, action.hold));
            const responseID = `resp_ws_c${connection}_${index}`;
            const events = responsesEvents(`MOCK-WS-${index}-${kind}-acct-${identity.account}`, responseID, action.slow ?? 1);
            if (!send(rateLimitsFrame(identity.account))) {
                record({ transport: "ws", action: "gone-before-first-frame", connection, request: index });
                busy = false;
                return;
            }
            let sent = 0;
            for (const event of events) {
                if (!send(event)) {
                    record({ transport: "ws", action: "stopped-streaming", connection, request: index, sent, total: events.length });
                    busy = false;
                    return;
                }
                sent += 1;
                if (action.slow && event.type === "response.output_text.delta") {
                    if (sent === 4) record({ transport: "ws", action: "first-delta-sent", connection, request: index });
                    if (action.every >= 0) await new Promise((resolve) => setTimeout(resolve, action.every));
                }
            }
            issued.add(responseID);
            busy = false;
            record({ transport: "ws", action: "completed", connection, request: index, frames: sent });
        });
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    return {
        url: `http://127.0.0.1:${port}`,
        close: () =>
            new Promise((resolve) => {
                for (const client of wss.clients) client.terminate();
                wss.close();
                server.closeAllConnections?.();
                server.close(() => resolve());
            }),
    };
}
