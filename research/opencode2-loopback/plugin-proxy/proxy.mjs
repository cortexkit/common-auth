// The loopback proxy an auth plugin would run inside the host process. The
// host's own OpenAI driver sends its HTTP requests and its session WebSocket
// here; the proxy picks one of two fake accounts, rewrites `Authorization` and
// `chatgpt-account-id`, and opens its own connection to the upstream (the mock
// Codex backend). Everything it sees is logged with a millisecond timestamp:
// requests, frames in both directions, closes and aborts on both sides.
//
// It is deliberately plain `node:http` + `ws`, so the same code could serve a
// Node host as well as the Bun runtime the OpenCode 2 binary embeds.
import { appendFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import WebSocket, { WebSocketServer } from "ws";

const ACCOUNTS = {
    A: { token: "tok-A", id: "acct-A" },
    B: { token: "tok-B", id: "acct-B" },
};

export const now = () => Number((performance.timeOrigin + performance.now()).toFixed(3));

// Headers never copied from the host's request to the upstream request:
// connection-level headers that describe the host-to-proxy hop, and the
// credentials the proxy replaces with the chosen account's.
const DROP_ALWAYS = new Set([
    "host",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "content-length",
    "upgrade",
    "proxy-connection",
    "authorization",
    "chatgpt-account-id",
]);
const DROP_WS = new Set(["sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol"]);
// Headers the auth plugin's model.request hook can add so the proxy learns the
// request kind and session id, which the host does not otherwise put on the
// wire in a form the proxy can rely on. Stripped before going upstream.
const SIDE_CHANNEL = ["x-cortexkit-kind", "x-cortexkit-session"];

// Close codes a server may send in a close frame; the others (1005, 1006,
// 1015) only describe what a peer observed, so they are relayed by dropping
// the connection instead.
const sendable = (code) => (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);

function sessionFrom(headers) {
    return {
        "x-opencode-session": headers["x-opencode-session"] ?? null,
        "x-session-id": headers["x-session-id"] ?? null,
        "x-session-affinity": headers["x-session-affinity"] ?? null,
        "session-id": headers["session-id"] ?? null,
        "x-cortexkit-session": headers["x-cortexkit-session"] ?? null,
    };
}

function kindFromBody(json) {
    if (!json || typeof json !== "object") return "unknown";
    if (/title generator/i.test(String(json.instructions ?? ""))) return "title";
    if (Array.isArray(json.tools) && json.tools.length > 0) return "primary";
    return "other";
}

function forwardHeaders(headers, account, extraDrop = new Set()) {
    const out = {};
    for (const [key, value] of Object.entries(headers)) {
        const lower = key.toLowerCase();
        if (DROP_ALWAYS.has(lower) || extraDrop.has(lower) || SIDE_CHANNEL.includes(lower)) continue;
        out[lower] = value;
    }
    out.authorization = `Bearer ${ACCOUNTS[account].token}`;
    out["chatgpt-account-id"] = ACCOUNTS[account].id;
    // Lets the mock tell proxied traffic from traffic that bypassed the proxy.
    out["x-spike-via-proxy"] = "1";
    return out;
}

function headerNames(headers) {
    return Object.keys(headers)
        .map((key) => key.toLowerCase())
        .sort();
}

/**
 * Starts the proxy on 127.0.0.1 (ephemeral port unless `port` is given).
 * `plan`: accounts handed to agent-loop requests in order ("A,B" = first A,
 *   then B, then B...). Other requests always use A.
 * `switchMode`: what the WebSocket side does with an incremental frame
 *   (one carrying previous_response_id) that has to go to a new upstream
 *   socket because the account changed:
 *     "expand"      rebuild the full input from what this socket already
 *                   carried and send it without previous_response_id
 *     "passthrough" forward it unchanged and let the upstream reject it
 *     "close-host"  close the host's socket before forwarding anything, so the
 *                   host reconnects and resends in full
 * `fault`: a failure the proxy injects on the first agent-loop WebSocket
 *   request: "close-1009", "conn-limit", "close-before-output",
 *   "close-after-output".
 * `quiet`: do not log individual text-delta frames (for throughput runs).
 */
export async function startProxy({ upstream, log, plan = ["A"], switchMode = "expand", fault = "", port = 0, quiet = false }) {
    const record = (entry) => appendFileSync(log, `${JSON.stringify({ t: now(), wall: Date.now(), ...entry })}\n`);
    const upstreamURL = new URL(upstream);
    let primaryCount = 0;
    let faultPending = fault;
    let httpCount = 0;
    let wsCount = 0;
    const accountFor = (kind) => {
        if (kind !== "primary") return "A";
        primaryCount += 1;
        return plan[Math.min(primaryCount - 1, plan.length - 1)];
    };

    const server = createServer((req, res) => {
        const id = ++httpCount;
        const chunks = [];
        let upstreamReq;
        let responseDone = false;
        let hostGone = false;
        const hostGoneOnce = (via) => {
            if (responseDone || hostGone) return;
            hostGone = true;
            // Take the timestamp first and destroy the upstream request before
            // writing any log line, so a slow (synchronous) log write cannot delay
            // cancelling the upstream request.
            const at = { t: now(), wall: Date.now() };
            const destroy = upstreamReq && !upstreamReq.destroyed;
            if (destroy) upstreamReq.destroy(new Error("host aborted"));
            const destroyed = { t: now(), wall: Date.now() };
            record({ ...at, side: "host", transport: "http", ev: "host-aborted", id, via, upstreamStarted: Boolean(upstreamReq) });
            if (destroy) record({ ...destroyed, side: "upstream", transport: "http", ev: "upstream-destroy-called", id });
        };
        // Every signal Node and Bun might give for a client that went away is
        // listened to, and the log names the one that fired first.
        req.on("aborted", () => hostGoneOnce("req.aborted"));
        req.on("close", () => {
            if (!req.complete) hostGoneOnce("req.close-incomplete");
        });
        res.on("close", () => hostGoneOnce("res.close"));
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
            if (hostGone) return;
            const body = Buffer.concat(chunks);
            let json;
            try {
                json = JSON.parse(body.toString("utf8"));
            } catch {}
            const headerKind = req.headers["x-cortexkit-kind"] ?? null;
            const bodyKind = kindFromBody(json);
            const account = accountFor(headerKind ?? bodyKind);
            record({
                side: "host",
                transport: "http",
                ev: "request",
                id,
                method: req.method,
                url: req.url,
                kindFromHeader: headerKind,
                kindFromBody: bodyKind,
                session: sessionFrom(req.headers),
                account,
                hostHeaderNames: headerNames(req.headers),
                bytes: body.length,
                previous_response_id: json?.previous_response_id,
                input_items: Array.isArray(json?.input) ? json.input.length : undefined,
            });
            const headers = forwardHeaders(req.headers, account);
            headers["content-length"] = String(body.length);
            upstreamReq = httpRequest({ hostname: upstreamURL.hostname, port: upstreamURL.port, path: req.url, method: req.method, headers });
            upstreamReq.on("response", (upstreamRes) => {
                record({ side: "upstream", transport: "http", ev: "response-headers", id, status: upstreamRes.statusCode });
                const out = {};
                for (const [key, value] of Object.entries(upstreamRes.headers)) if (!DROP_ALWAYS.has(key)) out[key] = value;
                res.writeHead(upstreamRes.statusCode, out);
                let chunkCount = 0;
                upstreamRes.on("data", (chunk) => {
                    chunkCount += 1;
                    if (!res.destroyed) res.write(chunk);
                });
                upstreamRes.on("end", () => {
                    responseDone = true;
                    res.end();
                    record({ side: "upstream", transport: "http", ev: "response-end", id, chunks: chunkCount });
                });
                upstreamRes.on("error", (error) => record({ side: "upstream", transport: "http", ev: "response-error", id, error: String(error) }));
            });
            upstreamReq.on("error", (error) => {
                record({ side: "upstream", transport: "http", ev: "request-error", id, error: String(error?.message ?? error) });
                if (!res.headersSent && !res.destroyed) {
                    res.writeHead(502, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: { message: "proxy: upstream failed" } }));
                } else res.destroy();
            });
            upstreamReq.on("close", () => record({ side: "upstream", transport: "http", ev: "upstream-closed", id }));
            upstreamReq.end(body);
        });
    });

    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    server.on("upgrade", (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, (host) => onHostSocket(host, req));
    });

    function onHostSocket(host, req) {
        const conn = ++wsCount;
        const state = {
            upstream: undefined,
            account: undefined,
            // The full `input` array of the last response.create sent upstream for
            // this host socket, and the output items that answered it. The host
            // sends later requests as increments (only the new input items plus
            // previous_response_id); with these two the proxy can rebuild the
            // whole input when it has to move to a new upstream socket, where
            // that previous_response_id would be unknown.
            baseline: undefined,
            output: [],
            relayMicros: [],
            closedByProxy: new WeakSet(),
            faultStage: undefined,
        };
        record({
            side: "host",
            transport: "ws",
            ev: "handshake",
            conn,
            url: req.url,
            session: sessionFrom(req.headers),
            kindFromHeader: req.headers["x-cortexkit-kind"] ?? null,
            hostHeaderNames: headerNames(req.headers),
            hostHeaders: Object.fromEntries(Object.entries(req.headers).filter(([key]) => !["authorization", "sec-websocket-key"].includes(key))),
        });

        const openUpstream = (account) => {
            const target = new URL(req.url, upstream);
            target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
            const socket = new WebSocket(target, { headers: forwardHeaders(req.headers, account, DROP_WS), perMessageDeflate: false });
            const upstreamID = `${conn}.${account}.${now().toFixed(0)}`;
            const queue = [];
            socket.spikeQueue = queue;
            record({ side: "upstream", transport: "ws", ev: "upstream-connecting", conn, upstreamID, account });
            socket.on("open", () => {
                record({ side: "upstream", transport: "ws", ev: "upstream-open", conn, upstreamID });
                for (const frame of queue.splice(0)) socket.send(frame);
            });
            socket.on("unexpected-response", (_request, response) => {
                record({ side: "upstream", transport: "ws", ev: "upstream-handshake-refused", conn, upstreamID, status: response.statusCode });
                if (host.readyState === WebSocket.OPEN) host.close(1011, "upstream refused");
            });
            socket.on("message", (data) => {
                const started = performance.now();
                const text = data.toString("utf8");
                let event;
                try {
                    event = JSON.parse(text);
                } catch {}
                if (event?.type === "response.output_item.done" && event.item) state.output.push(event.item);
                if (state.upstream !== socket) {
                    record({ side: "upstream", transport: "ws", ev: "stale-upstream-frame-dropped", conn, upstreamID, type: event?.type });
                    return;
                }
                if (faultPending === "close-before-output" && state.faultStage === "armed" && event?.type === "response.created") {
                    host.send(text);
                    faultPending = "";
                    record({ side: "host", transport: "ws", ev: "fault-terminate-host", conn, after: event.type });
                    host.terminate();
                    return;
                }
                if (faultPending === "close-after-output" && state.faultStage === "armed" && event?.type === "response.output_text.delta") {
                    host.send(text);
                    faultPending = "";
                    record({ side: "host", transport: "ws", ev: "fault-terminate-host", conn, after: event.type });
                    host.terminate();
                    return;
                }
                if (host.readyState !== WebSocket.OPEN) {
                    record({ side: "host", transport: "ws", ev: "frame-for-closed-host", conn, type: event?.type });
                    return;
                }
                host.send(text);
                state.relayMicros.push((performance.now() - started) * 1000);
                if (quiet && event?.type === "response.output_text.delta") return;
                record({ side: "u2h", transport: "ws", ev: "frame", conn, upstreamID, type: event?.type, response: event?.response?.id, error: event?.error?.code });
            });
            socket.on("close", (code, reason) => {
                record({ side: "upstream", transport: "ws", ev: "upstream-closed", conn, upstreamID, code, reason: reason.toString(), byProxy: state.closedByProxy.has(socket) });
                if (state.upstream !== socket || state.closedByProxy.has(socket)) return;
                state.upstream = undefined;
                if (host.readyState !== WebSocket.OPEN) return;
                // Relay the upstream's close to the host with the same code when
                // that code may appear in a close frame (see `sendable`), otherwise
                // drop the connection, so the host's own recovery logic sees the
                // real reason.
                if (sendable(code)) host.close(code, reason.toString());
                else host.terminate();
                record({ side: "host", transport: "ws", ev: "relayed-upstream-close", conn, code });
            });
            socket.on("error", (error) => record({ side: "upstream", transport: "ws", ev: "upstream-error", conn, upstreamID, error: String(error?.message ?? error) }));
            return socket;
        };

        const closeUpstream = (reason) => {
            const socket = state.upstream;
            if (!socket) return;
            state.closedByProxy.add(socket);
            state.upstream = undefined;
            const at = { t: now(), wall: Date.now() };
            const readyState = socket.readyState;
            if (readyState === WebSocket.CONNECTING) socket.terminate();
            else socket.close(1000, reason);
            record({ ...at, side: "upstream", transport: "ws", ev: "upstream-close-called", conn, reason, readyState });
        };

        host.on("message", (data) => {
            const text = data.toString("utf8");
            let frame;
            try {
                frame = JSON.parse(text);
            } catch {}
            const kind = req.headers["x-cortexkit-kind"] ?? kindFromBody(frame);
            if (frame?.type !== "response.create") {
                record({ side: "h2u", transport: "ws", ev: "frame", conn, type: frame?.type });
                state.upstream?.send(text);
                return;
            }
            const account = accountFor(kind);
            const incremental = typeof frame.previous_response_id === "string";
            record({
                side: "h2u",
                transport: "ws",
                ev: "response.create",
                conn,
                kind,
                account,
                previous_response_id: frame.previous_response_id,
                input_items: Array.isArray(frame.input) ? frame.input.length : undefined,
                prompt_cache_key: frame.prompt_cache_key,
            });
            if (faultPending === "close-1009") {
                faultPending = "";
                record({ side: "host", transport: "ws", ev: "fault-close-1009", conn });
                host.close(1009, "Message too big");
                return;
            }
            if (faultPending === "conn-limit") {
                faultPending = "";
                const error = { type: "error", status: 400, error: { type: "invalid_request_error", code: "websocket_connection_limit_reached", message: "Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue." } };
                host.send(JSON.stringify(error));
                record({ side: "host", transport: "ws", ev: "fault-conn-limit-error-sent", conn });
                return;
            }
            if (faultPending === "close-before-output" || faultPending === "close-after-output") state.faultStage = "armed";

            let outgoing = frame;
            if (state.account !== account) {
                const switching = state.account !== undefined;
                if (switching) {
                    record({ side: "proxy", transport: "ws", ev: "account-switch", conn, from: state.account, to: account, incremental, mode: switchMode });
                    if (switchMode === "close-host") {
                        closeUpstream("account switch");
                        state.account = undefined;
                        // Close the host's socket without answering; the host
                        // treats it like any other broken socket.
                        host.close(1012, "account switch");
                        record({ side: "host", transport: "ws", ev: "closed-host-for-switch", conn });
                        return;
                    }
                    closeUpstream("account switch");
                }
                state.account = account;
                state.upstream = openUpstream(account);
                if (switching && incremental && switchMode === "expand" && state.baseline) {
                    const { previous_response_id: _dropped, ...rest } = frame;
                    outgoing = { ...rest, input: [...state.baseline, ...state.output, ...frame.input] };
                    record({ side: "proxy", transport: "ws", ev: "expanded-incremental", conn, deltaItems: frame.input.length, fullItems: outgoing.input.length });
                }
            }
            state.baseline = incremental && outgoing === frame ? [...(state.baseline ?? []), ...state.output, ...frame.input] : outgoing.input;
            state.output = [];
            const message = outgoing === frame ? text : JSON.stringify(outgoing);
            const socket = state.upstream;
            if (socket.readyState === WebSocket.OPEN) socket.send(message);
            else socket.spikeQueue.push(message);
        });

        host.on("close", (code, reason) => {
            // Close the upstream before writing any log line, so a slow
            // (synchronous) log write cannot delay the cancel.
            const at = { t: now(), wall: Date.now() };
            closeUpstream(`host closed ${code}`);
            const relay = state.relayMicros;
            record({
                ...at,
                side: "host",
                transport: "ws",
                ev: "host-closed",
                conn,
                code,
                reason: reason.toString(),
                framesRelayed: relay.length,
                relayMicrosMean: relay.length ? Number((relay.reduce((a, b) => a + b, 0) / relay.length).toFixed(1)) : undefined,
                relayMicrosMax: relay.length ? Number(Math.max(...relay).toFixed(1)) : undefined,
            });
        });
        host.on("error", (error) => record({ side: "host", transport: "ws", ev: "host-error", conn, error: String(error?.message ?? error) }));
    }

    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}`;
    record({ side: "proxy", ev: "listening", url, runtime: typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.version}`, plan, switchMode, fault });
    return { url, server };
}
