// Local stand-in for a model provider. It speaks just enough of the OpenAI
// Responses API (HTTP SSE and WebSocket) and the Chat Completions API (HTTP SSE)
// for an OpenCode 2 session to complete one turn, and records every request it
// receives so the report can show exactly what the host sent and over which
// transport. Nothing here talks to a real provider.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const REDACT = new Set(["authorization", "cookie"]);

function headerSubset(headers) {
    const out = {};
    for (const [key, value] of Object.entries(headers)) {
        out[key] = REDACT.has(key.toLowerCase()) ? `<redacted len=${String(value).length}>` : value;
    }
    return out;
}

function summarizeBody(text) {
    try {
        const json = JSON.parse(text);
        return {
            model: json.model,
            stream: json.stream,
            keys: Object.keys(json).sort(),
            previous_response_id: json.previous_response_id,
            input_items: Array.isArray(json.input) ? json.input.length : undefined,
            messages: Array.isArray(json.messages) ? json.messages.length : undefined,
            type: json.type,
        };
    } catch {
        return { raw: text.slice(0, 200) };
    }
}

// The Responses API event sequence for a single assistant text message.
export function responsesEvents(text, responseID = `resp_mock_${Date.now()}`) {
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
                ? {
                      input_tokens: 11,
                      input_tokens_details: { cached_tokens: 0 },
                      output_tokens: 3,
                      output_tokens_details: { reasoning_tokens: 0 },
                      total_tokens: 14,
                  }
                : null,
    });
    const doneItem = {
        id: itemID,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
    };
    return [
        { type: "response.created", sequence_number: 0, response: response("in_progress", []) },
        {
            type: "response.output_item.added",
            sequence_number: 1,
            output_index: 0,
            item: { id: itemID, type: "message", status: "in_progress", role: "assistant", content: [] },
        },
        {
            type: "response.content_part.added",
            sequence_number: 2,
            item_id: itemID,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
        },
        {
            type: "response.output_text.delta",
            sequence_number: 3,
            item_id: itemID,
            output_index: 0,
            content_index: 0,
            delta: text,
        },
        {
            type: "response.output_text.done",
            sequence_number: 4,
            item_id: itemID,
            output_index: 0,
            content_index: 0,
            text,
        },
        {
            type: "response.content_part.done",
            sequence_number: 5,
            item_id: itemID,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text, annotations: [] },
        },
        { type: "response.output_item.done", sequence_number: 6, output_index: 0, item: doneItem },
        { type: "response.completed", sequence_number: 7, response: response("completed", [doneItem]) },
    ];
}

export function responsesSSE(text, responseID) {
    return responsesEvents(text, responseID)
        .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        .join("");
}

export function chatSSE(text) {
    const id = `chatcmpl_mock_${Date.now()}`;
    const chunk = (delta, finish) => ({
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "mock-model",
        choices: [{ index: 0, delta, finish_reason: finish }],
    });
    return (
        [
            chunk({ role: "assistant", content: "" }, null),
            chunk({ content: text }, null),
            {
                ...chunk({}, "stop"),
                usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
            },
        ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join("") + "data: [DONE]\n\n"
    );
}

// Two fake ChatGPT accounts. A request belongs to an account only when both
// its bearer token and its chatgpt-account-id header match that account;
// anything else is recorded as "none" so a request sent under the wrong or a
// mixed identity is visible in the log.
const ACCOUNTS = {
    A: { token: "tok-A", id: "acct-A" },
    B: { token: "tok-B", id: "acct-B" },
};
// Every credential used anywhere in the spike is fake; these are printed in
// clear so the log shows which one reached the wire. Anything else is redacted.
const KNOWN_FAKE_TOKENS = new Set(["tok-A", "tok-B", "tok-HOST", "sk-mock-not-a-real-key"]);

// Quota each account reports, deliberately different so a quota reading can
// be attributed to the account that produced it just from its numbers.
const QUOTA = {
    A: { primary: 11, secondary: 21 },
    B: { primary: 55, secondary: 65 },
};

export function identify(headers) {
    const auth = headers.authorization ?? headers.Authorization;
    const token = typeof auth === "string" ? /^Bearer (.+)$/i.exec(auth)?.[1] : undefined;
    const accountHeader = headers["chatgpt-account-id"];
    const tokenLabel = token === undefined ? null : KNOWN_FAKE_TOKENS.has(token) ? token : `<other len=${token.length}>`;
    for (const [name, account] of Object.entries(ACCOUNTS)) {
        if (token === account.token && accountHeader === account.id) return { account: name, token: tokenLabel, accountHeader };
    }
    return { account: "none", token: tokenLabel, accountHeader: accountHeader ?? null };
}

function quotaHeaders(account) {
    const quota = QUOTA[account];
    if (!quota) return {};
    const reset = Math.floor(Date.now() / 1000) + 3600;
    return {
        "x-codex-primary-used-percent": String(quota.primary),
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": String(reset),
        "x-codex-secondary-used-percent": String(quota.secondary),
        "x-codex-secondary-window-minutes": "10080",
        "x-codex-secondary-reset-at": String(reset + 86400),
    };
}

// The in-band quota frame the Codex backend sends over WebSocket.
function rateLimitsFrame(account, usedPrimary) {
    const quota = QUOTA[account] ?? { primary: 0, secondary: 0 };
    const reset = Math.floor(Date.now() / 1000) + 3600;
    return {
        type: "codex.rate_limits",
        plan_type: "plus",
        rate_limits: {
            primary: { used_percent: usedPrimary ?? quota.primary, window_minutes: 300, reset_at: reset },
            secondary: { used_percent: quota.secondary, window_minutes: 10080, reset_at: reset + 86400 },
        },
    };
}

const RATE_LIMIT_ERROR = { code: "rate_limit_exceeded", type: "rate_limit_exceeded", message: "Rate limit reached for this account. Please try again later." };
const USAGE_LIMIT_ERROR = { type: "usage_limit_reached", message: "The usage limit has been reached", resets_in_seconds: 1800 };

// The partial stream sent before a mid-response failure: the response is
// announced and one text delta reaches the client, then the failure follows.
function partialEvents(text, responseID) {
    return responsesEvents(text, responseID).slice(0, 4);
}

function failedEvent(responseID, error) {
    return {
        type: "response.failed",
        sequence_number: 9,
        response: { id: responseID, object: "response", status: "failed", model: "mock-model", output: [], error, usage: null },
    };
}

/**
 * Starts the mock on an ephemeral loopback port.
 * `failures` is how many leading model requests fail, and `failMode` how:
 * "500" answers HTTP 500 with a retryable-looking body, "stream-cut" sends
 * the first event and then destroys the socket mid-stream.
 * `rejects` is a list of `{ account, mode, count }` refusals applied to
 * agent-loop requests of that account, oldest first: "ratelimit" (HTTP 429 /
 * WebSocket `response.failed` before any output), "usage-limit" (the Codex
 * `usage_limit_reached` shape: HTTP 429 / WebSocket `error` frame with status
 * 429) and "after-output" (one text delta, then a rate-limit failure).
 */
export async function startMock({ log, failures = 0, failMode = "500", rejects = [] }) {
    let modelRequests = 0;
    let primaryRequests = 0;
    let connections = 0;
    const pendingRejects = rejects.map((item) => ({ count: 1, ...item }));
    const record = (entry) => appendFileSync(log, `${JSON.stringify({ t: Date.now(), ...entry })}\n`);
    const takeReject = (account) => {
        const item = pendingRejects.find((candidate) => candidate.account === account && candidate.count > 0);
        if (!item) return undefined;
        item.count -= 1;
        return item.mode;
    };

    const server = createServer((req, res) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const isModel = req.method === "POST" && /\/(responses|chat\/completions)$/.test(req.url ?? "");
            const index = isModel ? ++modelRequests : undefined;
            // Only agent-loop requests carry tool definitions; title requests do
            // not. Injected failures target the agent loop, so the session's
            // retry path is what gets exercised.
            const primary = isModel && /"tools"\s*:/.test(body);
            if (primary) primaryRequests += 1;
            const identity = identify(req.headers);
            record({
                transport: "http",
                method: req.method,
                url: req.url,
                modelRequest: index,
                kind: isModel ? (primary ? "primary" : "title") : undefined,
                identity,
                headers: headerSubset(req.headers),
                body: summarizeBody(body),
            });
            if (!isModel) {
                res.writeHead(404, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: `mock: no route ${req.url}` } }));
                return;
            }
            if (primary && primaryRequests <= failures) {
                if (failMode === "stream-cut") {
                    res.writeHead(200, { "content-type": "text/event-stream" });
                    const first = responsesSSE("PARTIAL").split("\n\n")[0];
                    res.write(`${first}\n\n`);
                    setTimeout(() => res.socket?.destroy(), 50);
                    record({ transport: "http", action: "stream-cut", modelRequest: index });
                    return;
                }
                res.writeHead(500, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: "mock: injected server error", type: "server_error" } }));
                record({ transport: "http", action: "injected-500", modelRequest: index });
                return;
            }
            const reject = primary ? takeReject(identity.account) : undefined;
            if (reject === "ratelimit" || reject === "usage-limit") {
                res.writeHead(429, {
                    "content-type": "application/json",
                    "retry-after": "30",
                    ...quotaHeaders(identity.account),
                    "x-codex-primary-used-percent": "100",
                });
                res.end(JSON.stringify({ error: reject === "ratelimit" ? RATE_LIMIT_ERROR : USAGE_LIMIT_ERROR }));
                record({ transport: "http", action: `injected-429-${reject}`, modelRequest: index, account: identity.account });
                return;
            }
            const responseID = `resp_http_${index}`;
            if (reject === "after-output") {
                res.writeHead(200, { "content-type": "text/event-stream", ...quotaHeaders(identity.account) });
                const events = [...partialEvents(`PARTIAL-FROM-${identity.account} `, responseID), failedEvent(responseID, RATE_LIMIT_ERROR)];
                res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
                record({ transport: "http", action: "injected-failure-after-output", modelRequest: index, account: identity.account });
                return;
            }
            const text = `MOCK-HTTP-REPLY-${index}-acct-${identity.account}`;
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...quotaHeaders(identity.account) });
            res.end(req.url.endsWith("/chat/completions") ? chatSSE(text) : responsesSSE(text, responseID));
        });
    });

    const wss = new WebSocketServer({ server });
    wss.on("connection", (socket, req) => {
        const connection = ++connections;
        const identity = identify(req.headers);
        // Response IDs this socket issued; the real backend only honours a
        // previous_response_id on the connection that produced it.
        const issued = new Set();
        record({ transport: "ws", action: "handshake", connection, url: req.url, identity, headers: headerSubset(req.headers) });
        socket.on("close", (code) => record({ transport: "ws", action: "closed", connection, code }));
        socket.on("message", (data) => {
            const text = data.toString("utf8");
            const index = ++modelRequests;
            primaryRequests += 1;
            const summary = summarizeBody(text);
            record({
                transport: "ws",
                action: "frame-in",
                connection,
                modelRequest: index,
                identity,
                previousKnownOnConnection: summary.previous_response_id ? issued.has(summary.previous_response_id) : undefined,
                body: summary,
            });
            if (primaryRequests <= failures) {
                record({ transport: "ws", action: "injected-close", modelRequest: index });
                socket.terminate();
                return;
            }
            const send = (event) => socket.send(JSON.stringify(event));
            const responseID = `resp_ws_c${connection}_${index}`;
            const reject = takeReject(identity.account);
            send(rateLimitsFrame(identity.account, reject === "ratelimit" || reject === "usage-limit" ? 100 : undefined));
            if (reject === "ratelimit") {
                send(responsesEvents("", responseID)[0]);
                send(failedEvent(responseID, RATE_LIMIT_ERROR));
                record({ transport: "ws", action: "injected-response.failed-ratelimit", connection, modelRequest: index, account: identity.account });
                return;
            }
            if (reject === "usage-limit") {
                send({ type: "error", status: 429, error: USAGE_LIMIT_ERROR, headers: { "x-codex-primary-used-percent": "100" } });
                record({ transport: "ws", action: "injected-error-usage-limit", connection, modelRequest: index, account: identity.account });
                return;
            }
            if (reject === "after-output") {
                for (const event of partialEvents(`PARTIAL-FROM-${identity.account} `, responseID)) send(event);
                send(failedEvent(responseID, RATE_LIMIT_ERROR));
                record({ transport: "ws", action: "injected-failure-after-output", connection, modelRequest: index, account: identity.account });
                return;
            }
            issued.add(responseID);
            for (const event of responsesEvents(`MOCK-WS-REPLY-${index}-acct-${identity.account}`, responseID)) send(event);
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
