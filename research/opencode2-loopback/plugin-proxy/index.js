// Stand-in for an auth plugin that owns the OpenAI transport on OpenCode 2 by
// running a loopback proxy: `setup` starts the proxy, then points the host's
// native openai driver at it using the method SPIKE_POINT names. The host keeps
// sending (so other plugins' hooks still run); the proxy owns accounts and the
// upstream connection.
//
// Environment:
//   SPIKE_UPSTREAM      the mock Codex backend's origin (the proxy's upstream)
//   SPIKE_PROXY_LOG     JSON-lines log for the proxy
//   SPIKE_PLUGIN_LOG    JSON-lines log for this plugin's hooks
//   SPIKE_POINT         how the host is pointed at the proxy:
//                         config             the harness wrote the proxy URL into
//                                            the config (proxy on SPIKE_PROXY_PORT)
//                         provider-transform provider.transform sets settings.baseURL
//                         model-transform    model.transform sets each model's baseURL
//                         model-request      session model.request sets draft.baseURL
//                         hooks              http.request + experimental.ws.handshake
//                                            rewrite the URL of each request/socket
//                         none               start the proxy but do not point at it
//   SPIKE_KIND_HEADER   "1": model.request adds x-cortexkit-kind / -session headers
//   SPIKE_PROXY_PLAN, SPIKE_SWITCH_MODE, SPIKE_PROXY_FAULT: see proxy.mjs
//   SPIKE_PROXY_QUIET   "1": the proxy does not log individual text deltas
//   SPIKE_FIX_NO_PROXY  "1": add loopback to NO_PROXY in the host process
import { appendFileSync } from "node:fs";
import { startProxy } from "./proxy.mjs";

const LOG = process.env.SPIKE_PLUGIN_LOG;
const log = (event, data = {}) => {
    if (LOG) appendFileSync(LOG, `${JSON.stringify({ t: Date.now(), wall: Date.now(), plugin: "proxy", event, ...data })}\n`);
};

export default {
    id: "cortexkit.spike.loopback-proxy",
    async setup(context) {
        const point = process.env.SPIKE_POINT ?? "provider-transform";
        if (process.env.SPIKE_FIX_NO_PROXY === "1") {
            // A user's HTTP(S)_PROXY also catches requests to the loopback proxy
            // unless NO_PROXY lists loopback. Try adding it from inside the host
            // process, to see whether the host's HTTP client reads it late enough.
            for (const key of ["NO_PROXY", "no_proxy"]) process.env[key] = [process.env[key], "127.0.0.1", "localhost"].filter(Boolean).join(",");
            log("no-proxy-patched", { NO_PROXY: process.env.NO_PROXY });
        }
        const proxy = await startProxy({
            upstream: process.env.SPIKE_UPSTREAM,
            log: process.env.SPIKE_PROXY_LOG,
            port: point === "config" ? Number(process.env.SPIKE_PROXY_PORT) : 0,
            plan: (process.env.SPIKE_PROXY_PLAN ?? "A").split(",").filter(Boolean),
            switchMode: process.env.SPIKE_SWITCH_MODE ?? "expand",
            fault: process.env.SPIKE_PROXY_FAULT ?? "",
            quiet: process.env.SPIKE_PROXY_QUIET === "1",
        });
        const baseURL = `${proxy.url}/v1`;
        log("setup", { point, proxy: proxy.url });

        if (point === "provider-transform") {
            await context.provider.transform((providers) => {
                const item = providers.get("openai");
                const before = item?.provider?.settings?.baseURL;
                if (!item) return log("provider.transform", { found: false });
                providers.update("openai", (provider) => {
                    provider.settings = { ...(provider.settings ?? {}), baseURL };
                });
                const after = providers.get("openai")?.provider?.settings;
                log("provider.transform", { found: true, before, after: after?.baseURL, transport: after?.transport, package: providers.get("openai")?.provider?.package });
            });
        }
        if (point === "model-transform") {
            await context.model.transform((models) => {
                for (const model of models.list("openai")) {
                    const before = model.settings?.baseURL;
                    models.update(model.providerID, model.id, (draft) => {
                        draft.settings = { ...(draft.settings ?? {}), baseURL };
                    });
                    log("model.transform", { modelID: model.id, before, after: models.get(model.providerID, model.id)?.settings?.baseURL });
                }
            });
        }

        const scope = { providerID: "openai" };
        await context.session.hook(
            "model.request",
            (draft) => {
                const before = draft.baseURL;
                if (point === "model-request") draft.baseURL = baseURL;
                if (process.env.SPIKE_KIND_HEADER === "1") {
                    draft.headers["x-cortexkit-kind"] = draft.kind;
                    draft.headers["x-cortexkit-session"] = draft.sessionID;
                }
                log("model.request", { sessionID: draft.sessionID, kind: draft.kind, modelID: draft.model?.id, baseURLBefore: before, baseURLAfter: draft.baseURL });
            },
            scope,
        );
        if (point === "hooks") {
            await context.session.hook(
                "http.request",
                (draft) => {
                    const before = draft.request.url;
                    const target = new URL(before);
                    const proxyURL = new URL(proxy.url);
                    target.protocol = proxyURL.protocol;
                    target.host = proxyURL.host;
                    draft.request = new Request(target.href, draft.request);
                    log("http.request.redirect", { sessionID: draft.sessionID, kind: draft.kind, before, after: draft.request.url });
                },
                scope,
            );
            await context.session.hook(
                "experimental.ws.handshake",
                (draft) => {
                    const before = draft.url;
                    const target = new URL(before);
                    target.protocol = "ws:";
                    target.host = new URL(proxy.url).host;
                    draft.url = target.href;
                    log("ws.handshake.redirect", { sessionID: draft.sessionID, kind: draft.kind, before, after: draft.url });
                },
                scope,
            );
        }
    },
};
