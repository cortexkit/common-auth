// Probe plugin for the OpenCode 2 transport spike. It is loaded by the host as
// a directory target (the host resolves `<dir>/index`), and uses the promise
// plugin shape `{ id, setup }` from @opencode/plugin.
//
// Which hooks it registers is chosen per run through SPIKE_MODE (a comma list),
// so the harness can test one seam at a time. Every hook invocation is written
// as one JSON line to SPIKE_PLUGIN_LOG; those lines are the evidence the report
// quotes.
import { appendFileSync } from "node:fs";
import { createOpenAI } from "@ai-sdk/openai";

const LOG = process.env.SPIKE_PLUGIN_LOG;
const MODES = new Set((process.env.SPIKE_MODE ?? "").split(",").filter(Boolean));
// The provider package that the `sdk` hook should answer for. The host only
// consults AI SDK hooks for packages it did not map to a native driver.
const SDK_PACKAGE = process.env.SPIKE_SDK_PACKAGE ?? new URL("./sdk-factory.mjs", import.meta.url).href;

export function log(event, data = {}) {
    if (!LOG) return;
    appendFileSync(LOG, `${JSON.stringify({ t: Date.now(), event, ...data })}\n`);
}

function scope(draft) {
    return {
        sessionID: draft.sessionID,
        providerID: draft.model?.providerID,
        modelID: draft.model?.id,
        kind: draft.kind,
    };
}

// A Responses API SSE body produced entirely inside the plugin, so the
// provider endpoint is never contacted when a hook returns it.
function synthesizedResponsesStream(text) {
    const id = `resp_plugin_${Date.now()}`;
    const itemID = `msg_${id}`;
    const done = {
        id: itemID,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
    };
    const base = (status, output) => ({
        id,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status,
        model: "mock-model",
        output,
        usage:
            status === "completed"
                ? {
                      input_tokens: 5,
                      input_tokens_details: { cached_tokens: 0 },
                      output_tokens: 2,
                      output_tokens_details: { reasoning_tokens: 0 },
                      total_tokens: 7,
                  }
                : null,
    });
    const events = [
        { type: "response.created", sequence_number: 0, response: base("in_progress", []) },
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
        { type: "response.output_text.delta", sequence_number: 3, item_id: itemID, output_index: 0, content_index: 0, delta: text },
        { type: "response.output_text.done", sequence_number: 4, item_id: itemID, output_index: 0, content_index: 0, text },
        {
            type: "response.content_part.done",
            sequence_number: 5,
            item_id: itemID,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text, annotations: [] },
        },
        { type: "response.output_item.done", sequence_number: 6, output_index: 0, item: done },
        { type: "response.completed", sequence_number: 7, response: base("completed", [done]) },
    ];
    const encoder = new TextEncoder();
    let i = 0;
    // Emit one event per pull with a small delay so the body is a real,
    // incrementally delivered stream rather than one buffered chunk.
    return new ReadableStream({
        async pull(controller) {
            if (i >= events.length) {
                controller.close();
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
            const event = events[i++];
            controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        },
    });
}

function chatStream(text) {
    const chunk = (delta, finish) => ({
        id: "chatcmpl_plugin",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "mock-model",
        choices: [{ index: 0, delta, finish_reason: finish }],
    });
    const body =
        [chunk({ role: "assistant", content: "" }, null), chunk({ content: text }, null), chunk({}, "stop")]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join("") + "data: [DONE]\n\n";
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

// The fetch an auth plugin would own. It records every call and either answers
// by itself (SPIKE_SYNTH=1, never touching the network) or forwards to the
// fetch it was handed.
export function makeOwnedFetch(label, forward) {
    let calls = 0;
    return async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const body = typeof init?.body === "string" ? init.body : undefined;
        let parsed;
        try {
            parsed = body ? JSON.parse(body) : undefined;
        } catch {}
        calls += 1;
        log("owned-fetch.call", {
            label,
            call: calls,
            url,
            method: init?.method,
            stream: parsed?.stream,
            bodyKeys: parsed ? Object.keys(parsed).sort() : undefined,
            synthesized: process.env.SPIKE_SYNTH === "1",
        });
        if (process.env.SPIKE_SYNTH === "1") {
            if (url.endsWith("/chat/completions")) return chatStream(`PLUGIN-FETCH-SYNTH-${calls}`);
            return new Response(synthesizedResponsesStream(`PLUGIN-FETCH-SYNTH-${calls}`), {
                status: 200,
                headers: { "content-type": "text/event-stream" },
            });
        }
        return forward(input, init);
    };
}

function wrapLanguageModel(inner) {
    return {
        specificationVersion: inner.specificationVersion,
        provider: inner.provider,
        modelId: inner.modelId,
        get supportedUrls() {
            return inner.supportedUrls;
        },
        async doGenerate(options) {
            log("language.doGenerate", { modelId: inner.modelId, prompt: options.prompt?.length });
            return inner.doGenerate(options);
        },
        async doStream(options) {
            log("language.doStream", {
                modelId: inner.modelId,
                prompt: options.prompt?.length,
                tools: options.tools?.length,
                providerOptionKeys: Object.keys(options.providerOptions ?? {}),
            });
            return inner.doStream(options);
        },
    };
}

export default {
    id: "cortexkit.spike.opencode2-transport",
    async setup(context) {
        log("setup", { modes: [...MODES], contextKeys: Object.keys(context).sort(), sdkPackage: SDK_PACKAGE });

        if (MODES.has("force-aisdk")) {
            // Point a provider at a package the host has no native driver for,
            // so the host has to build it through the AI SDK hooks.
            const target = process.env.SPIKE_FORCE_PROVIDER ?? "openai";
            await context.provider.transform((providers) => {
                const item = providers.get(target);
                log("provider.transform", {
                    target,
                    found: Boolean(item),
                    packageBefore: item?.provider?.package,
                    transportBefore: item?.provider?.settings?.transport,
                });
                if (!item) return;
                providers.update(target, (provider) => {
                    provider.package = `aisdk:${SDK_PACKAGE}`;
                });
                log("provider.transform.after", { target, packageAfter: providers.get(target)?.provider?.package });
            });
            await context.model.transform((models) => {
                for (const model of models.list(target)) {
                    const before = model.package;
                    models.update(model.providerID, model.id, (draft) => {
                        draft.package = `aisdk:${SDK_PACKAGE}`;
                    });
                    log("model.transform", {
                        providerID: model.providerID,
                        modelID: model.id,
                        packageBefore: before,
                        packageAfter: models.get(model.providerID, model.id)?.package,
                    });
                }
            });
        }

        if (MODES.has("sdk")) {
            await context.aisdk.hook("sdk", async (event) => {
                log("aisdk.sdk", {
                    providerID: event.model.providerID,
                    modelID: event.model.id,
                    package: event.package,
                    optionKeys: Object.keys(event.options ?? {}).sort(),
                    hostFetchType: typeof event.options?.fetch,
                    sdkAlreadySet: event.sdk !== undefined,
                });
                if (event.package !== SDK_PACKAGE) return;
                const hostFetch = event.options.fetch;
                event.sdk = createOpenAI({
                    ...event.options,
                    // Forwarding goes through the host's fetch, which is where
                    // the host applies its session http.request/http.response hooks.
                    fetch: makeOwnedFetch("sdk-hook", hostFetch),
                });
                log("aisdk.sdk.installed", { package: event.package });
            });
        }

        if (MODES.has("language")) {
            await context.aisdk.hook("language", async (event) => {
                log("aisdk.language", {
                    providerID: event.model.providerID,
                    modelID: event.model.id,
                    sdkType: typeof event.sdk,
                    languageAlreadySet: event.language !== undefined,
                });
                const inner = event.sdk.responses
                    ? event.sdk.responses(event.model.modelID ?? event.model.id)
                    : event.sdk.languageModel(event.model.modelID ?? event.model.id);
                event.language = wrapLanguageModel(inner);
            });
        }

        if (MODES.has("observe")) {
            for (const name of ["context", "compaction", "generate", "title"]) {
                await context.session.hook(name, (draft) => {
                    log(`session.${name}`, {
                        sessionID: draft.sessionID,
                        providerID: draft.model?.providerID,
                        modelID: draft.model?.id,
                        messages: draft.messages?.length,
                    });
                });
            }
            await context.session.hook("model.request", (draft) => {
                log("session.model.request", { ...scope(draft), baseURL: draft.baseURL, headerKeys: Object.keys(draft.headers).sort() });
            });
            await context.session.hook("experimental.ws.handshake", (draft) => {
                const before = draft.url;
                if (MODES.has("ws-redirect") && process.env.SPIKE_REDIRECT_URL) {
                    // Point the host-owned socket at an endpoint the plugin controls.
                    const target = new URL(process.env.SPIKE_REDIRECT_URL);
                    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
                    target.pathname = new URL(before).pathname;
                    draft.url = target.href;
                }
                log("session.ws.handshake", {
                    ...scope(draft),
                    url: before,
                    rewrittenTo: draft.url,
                    headerKeys: Object.keys(draft.headers).sort(),
                });
            });
            await context.session.hook("experimental.ws.send", (draft) => {
                let summary;
                try {
                    const frame = JSON.parse(draft.frame);
                    summary = { type: frame.type, previous_response_id: frame.previous_response_id, keys: Object.keys(frame).sort() };
                } catch {
                    summary = { raw: draft.frame.slice(0, 80) };
                }
                log("session.ws.send", { ...scope(draft), bytes: draft.frame.length, frame: summary });
            });
            await context.session.hook("experimental.ws.receive", (draft) => {
                let type;
                try {
                    type = JSON.parse(draft.frame).type;
                } catch {}
                log("session.ws.receive", { ...scope(draft), type });
            });
        }

        if (MODES.has("observe") || MODES.has("http-replace") || MODES.has("http-redirect")) {
            await context.session.hook("http.request", (draft) => {
                const before = draft.request.url;
                if (MODES.has("http-redirect") && process.env.SPIKE_REDIRECT_URL) {
                    // Send the host's request somewhere the plugin controls.
                    const target = new URL(process.env.SPIKE_REDIRECT_URL);
                    const original = new URL(before);
                    target.pathname = `${target.pathname.replace(/\/$/, "")}${original.pathname}`;
                    draft.request = new Request(target.href, draft.request);
                }
                log("session.http.request", { ...scope(draft), url: before, rewrittenTo: draft.request.url, method: draft.request.method });
            });
            await context.session.hook("http.response", (draft) => {
                log("session.http.response", {
                    ...scope(draft),
                    url: draft.request.url,
                    status: draft.response.status,
                    contentType: draft.response.headers.get("content-type"),
                });
                if (MODES.has("http-replace") && draft.response.ok) {
                    const chat = draft.request.url.endsWith("/chat/completions");
                    draft.response = chat
                        ? chatStream("HTTP-RESPONSE-HOOK-REPLACED")
                        : new Response(synthesizedResponsesStream("HTTP-RESPONSE-HOOK-REPLACED"), {
                              status: 200,
                              headers: { "content-type": "text/event-stream" },
                          });
                    log("session.http.response.replaced", scope(draft));
                }
            });
        }

        if (MODES.has("retry-observe") || MODES.has("retry-false")) {
            await context.session.hook("retry", (draft) => {
                log("session.retry", {
                    sessionID: draft.sessionID,
                    providerID: draft.model?.providerID,
                    attempt: draft.attempt,
                    errorTag: draft.error?._tag ?? draft.error?.type,
                    error: JSON.stringify(draft.error).slice(0, 300),
                    decisionBefore: draft.decision,
                });
                if (MODES.has("retry-false")) draft.decision = { retry: false };
            });
        }
    },
};
