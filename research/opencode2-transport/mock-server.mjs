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

/**
 * Starts the mock on an ephemeral loopback port.
 * `failures` is how many leading model requests fail, and `failMode` how:
 * "500" answers HTTP 500 with a retryable-looking body, "stream-cut" sends
 * the first event and then destroys the socket mid-stream.
 */
export async function startMock({ log, failures = 0, failMode = "500" }) {
    let modelRequests = 0;
    let primaryRequests = 0;
    const record = (entry) => appendFileSync(log, `${JSON.stringify({ t: Date.now(), ...entry })}\n`);

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
            record({
                transport: "http",
                method: req.method,
                url: req.url,
                modelRequest: index,
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
            const text = `MOCK-HTTP-REPLY-${index}`;
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.end(req.url.endsWith("/chat/completions") ? chatSSE(text) : responsesSSE(text));
        });
    });

    const wss = new WebSocketServer({ server });
    wss.on("connection", (socket, req) => {
        record({ transport: "ws", action: "handshake", url: req.url, headers: headerSubset(req.headers) });
        socket.on("message", (data) => {
            const text = data.toString("utf8");
            const index = ++modelRequests;
            primaryRequests += 1;
            record({ transport: "ws", action: "frame-in", modelRequest: index, body: summarizeBody(text) });
            if (primaryRequests <= failures) {
                record({ transport: "ws", action: "injected-close", modelRequest: index });
                socket.terminate();
                return;
            }
            for (const event of responsesEvents(`MOCK-WS-REPLY-${index}`)) socket.send(JSON.stringify(event));
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
