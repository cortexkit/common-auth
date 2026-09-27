// A minimal stand-in for a multi-account ChatGPT auth plugin that leaves the
// transport to the host. For each model request it picks one of two fake
// accounts, puts that account's token and account id on the request through
// whichever hooks SPIKE_AUTH_VIA names, reads the quota the provider reports,
// and on a rate-limit refusal tells the host to retry the same turn so the
// next attempt can go out under the other account.
//
// Environment:
//   SPIKE_ACCOUNT_PLAN  "auto" (default): account A until it is rate limited,
//                       then B. Or a comma list such as "A,B": the Nth agent-loop
//                       request uses the Nth entry (wrapping).
//   SPIKE_TITLE_ACCOUNT Account for title requests (default: same rule as above).
//   SPIKE_AUTH_VIA      Comma list of hooks that write the credentials:
//                       model-request (default), http-request, ws-handshake.
//   SPIKE_FORCE_BASEURL If set, model.request points every request here. Used
//                       when the host's own openai plugin has moved the base URL
//                       to the real Codex endpoint.
//   SPIKE_HOOK_SCOPE    providerID the hooks are registered for (default
//                       "openai"); "none" registers them unscoped.
import { log } from "./index.js";

const ACCOUNTS = {
    A: { token: "tok-A", id: "acct-A" },
    B: { token: "tok-B", id: "acct-B" },
};
const KNOWN_FAKE_TOKENS = new Set(["tok-A", "tok-B", "tok-HOST", "sk-mock-not-a-real-key"]);

// Prints which fake token a header carries without printing anything else.
function tokenLabel(value) {
    if (typeof value !== "string") return null;
    const token = /^Bearer (.+)$/i.exec(value)?.[1];
    if (token === undefined) return `<not bearer len=${value.length}>`;
    return KNOWN_FAKE_TOKENS.has(token) ? token : `<other len=${token.length}>`;
}

// Header values that are safe to log: everything except credentials.
function visibleHeaders(headers) {
    const out = {};
    for (const [key, value] of Object.entries(headers)) {
        out[key] = key.toLowerCase() === "authorization" ? tokenLabel(value) : value;
    }
    return out;
}

function setCredentials(target, account) {
    // Drop any existing spelling first so exactly one Authorization remains.
    for (const key of Object.keys(target)) {
        if (key.toLowerCase() === "authorization" || key.toLowerCase() === "chatgpt-account-id") delete target[key];
    }
    target.authorization = `Bearer ${ACCOUNTS[account].token}`;
    target["chatgpt-account-id"] = ACCOUNTS[account].id;
}

const QUOTA_HEADERS = [
    "x-codex-primary-used-percent",
    "x-codex-primary-window-minutes",
    "x-codex-primary-reset-at",
    "x-codex-secondary-used-percent",
    "x-codex-secondary-window-minutes",
    "x-codex-secondary-reset-at",
    "retry-after",
];

function isRateLimitFrame(event) {
    if (!event || typeof event !== "object") return false;
    const error = event.error ?? event.response?.error;
    const code = `${error?.code ?? ""} ${error?.type ?? ""}`;
    if (event.type === "response.failed") return /rate_limit|usage_limit/.test(code);
    if (event.type === "error") return event.status === 429 || /rate_limit|usage_limit/.test(code);
    return false;
}

export async function registerAccounts(context, modes) {
    const plan = (process.env.SPIKE_ACCOUNT_PLAN ?? "auto").split(",").filter(Boolean);
    const titleAccount = process.env.SPIKE_TITLE_ACCOUNT;
    const via = new Set((process.env.SPIKE_AUTH_VIA ?? "model-request").split(",").filter(Boolean));
    const scopeID = process.env.SPIKE_HOOK_SCOPE ?? "openai";
    const options = scopeID === "none" ? undefined : { providerID: scopeID };
    const hook = (name, callback) => context.session.hook(name, callback, options);

    // Accounts that refused with a rate limit; "auto" routing skips them.
    const limited = new Set();
    // The account and per-attempt state of the request currently in flight,
    // per session and request kind (title and agent-loop requests overlap).
    const current = new Map();
    const key = (draft) => `${draft.sessionID}:${draft.kind}`;
    let primaryCalls = 0;

    const choose = (kind) => {
        if (kind !== "primary" && titleAccount) return titleAccount;
        if (plan[0] === "auto") return limited.has("A") ? "B" : "A";
        if (kind !== "primary") return plan[0];
        return plan[(primaryCalls - 1) % plan.length];
    };

    let pluginsLogged = false;
    await hook("model.request", async (draft) => {
        if (!pluginsLogged) {
            // Which plugins are active by the time requests flow, to show whether
            // the host's own openai plugin is loaded or was removed by config.
            pluginsLogged = true;
            try {
                const listed = await context.plugin.list();
                const plugins = Array.isArray(listed?.data) ? listed.data : [];
                const openai = plugins.filter((plugin) => String(plugin.id).includes("openai")).map((plugin) => ({ id: plugin.id, status: plugin.state?.status }));
                log("acct.plugins", { count: plugins.length, openai });
            } catch (error) {
                log("acct.plugins", { error: String(error) });
            }
        }
        if (draft.kind === "primary") primaryCalls += 1;
        const account = choose(draft.kind);
        const before = visibleHeaders(draft.headers);
        const baseURLBefore = draft.baseURL;
        if (process.env.SPIKE_FORCE_BASEURL) draft.baseURL = process.env.SPIKE_FORCE_BASEURL;
        if (via.has("model-request")) setCredentials(draft.headers, account);
        current.set(key(draft), { account, outputSeen: false, refused: false, call: primaryCalls });
        log("acct.model.request", {
            sessionID: draft.sessionID,
            providerID: draft.model?.providerID,
            kind: draft.kind,
            primaryCall: draft.kind === "primary" ? primaryCalls : undefined,
            account,
            limited: [...limited],
            headersBefore: before,
            headersAfter: visibleHeaders(draft.headers),
            baseURLBefore,
            baseURLAfter: draft.baseURL,
        });
    });

    await hook("http.request", (draft) => {
        const state = current.get(key(draft));
        if (via.has("http-request") && state) {
            const headers = new Headers(draft.request.headers);
            headers.set("authorization", `Bearer ${ACCOUNTS[state.account].token}`);
            headers.set("chatgpt-account-id", ACCOUNTS[state.account].id);
            draft.request = new Request(draft.request, { headers });
        }
        log("acct.http.request", {
            sessionID: draft.sessionID,
            kind: draft.kind,
            account: state?.account,
            url: draft.request.url,
            authorization: tokenLabel(draft.request.headers.get("authorization")),
            chatgptAccountID: draft.request.headers.get("chatgpt-account-id"),
            originator: draft.request.headers.get("originator"),
        });
    });

    await hook("http.response", (draft) => {
        const state = current.get(key(draft));
        const quota = {};
        for (const name of QUOTA_HEADERS) {
            const value = draft.response.headers.get(name);
            if (value !== null) quota[name] = value;
        }
        if (draft.response.status === 429 && state) {
            state.refused = true;
            limited.add(state.account);
        }
        log("acct.http.response", {
            sessionID: draft.sessionID,
            kind: draft.kind,
            account: state?.account,
            status: draft.response.status,
            quota,
        });
        // Watch the SSE body for the first text delta without consuming it, so
        // the retry hook knows whether the user has already seen output.
        if (state && draft.response.body && draft.response.ok) {
            const decoder = new TextDecoder();
            const watch = new TransformStream({
                transform(chunk, controller) {
                    const text = decoder.decode(chunk, { stream: true });
                    if (!state.outputSeen && text.includes("response.output_text.delta")) {
                        state.outputSeen = true;
                        log("acct.output-seen", { sessionID: draft.sessionID, kind: draft.kind, account: state.account, via: "http" });
                    }
                    if (/"type":"response\.failed"/.test(text) && /rate_limit|usage_limit/.test(text)) {
                        state.refused = true;
                        limited.add(state.account);
                        log("acct.refusal-seen", { sessionID: draft.sessionID, account: state.account, via: "http-sse" });
                    }
                    controller.enqueue(chunk);
                },
            });
            draft.response = new Response(draft.response.body.pipeThrough(watch), {
                status: draft.response.status,
                statusText: draft.response.statusText,
                headers: draft.response.headers,
            });
        }
    });

    await hook("experimental.ws.handshake", (draft) => {
        const state = current.get(key(draft));
        const before = visibleHeaders(draft.headers);
        if (via.has("ws-handshake") && state) setCredentials(draft.headers, state.account);
        log("acct.ws.handshake", {
            sessionID: draft.sessionID,
            kind: draft.kind,
            account: state?.account,
            url: draft.url,
            headersBefore: before,
            headersAfter: visibleHeaders(draft.headers),
        });
    });

    await hook("experimental.ws.send", (draft) => {
        const state = current.get(key(draft));
        let frame;
        try {
            frame = JSON.parse(draft.frame);
        } catch {}
        if (modes.has("ws-send-mark") && frame) {
            // One harmless extra field, to see whether rewriting the frame
            // disturbs the host's previous_response_id chaining.
            frame.spike_marker = `added-by-ws-send-${state?.account ?? "unknown"}`;
            draft.frame = JSON.stringify(frame);
        }
        log("acct.ws.send", {
            sessionID: draft.sessionID,
            kind: draft.kind,
            account: state?.account,
            type: frame?.type,
            previous_response_id: frame?.previous_response_id,
            input_items: Array.isArray(frame?.input) ? frame.input.length : undefined,
            keys: frame ? Object.keys(frame).sort() : undefined,
            authorizationInFrame: frame ? JSON.stringify(frame).includes("tok-") : undefined,
        });
    });

    await hook("experimental.ws.receive", (draft) => {
        const state = current.get(key(draft));
        let event;
        try {
            event = JSON.parse(draft.frame);
        } catch {}
        if (event?.type === "codex.rate_limits") {
            log("acct.ws.quota", {
                sessionID: draft.sessionID,
                kind: draft.kind,
                account: state?.account,
                primary: event.rate_limits?.primary?.used_percent,
                secondary: event.rate_limits?.secondary?.used_percent,
            });
        }
        if (state && event?.type === "response.output_text.delta" && !state.outputSeen) {
            state.outputSeen = true;
            log("acct.output-seen", { sessionID: draft.sessionID, kind: draft.kind, account: state.account, via: "ws" });
        }
        if (state && isRateLimitFrame(event)) {
            state.refused = true;
            limited.add(state.account);
            log("acct.refusal-seen", { sessionID: draft.sessionID, account: state.account, via: "ws", type: event.type, outputSeen: state.outputSeen });
        }
        if (modes.has("ws-receive-log")) log("acct.ws.receive", { sessionID: draft.sessionID, kind: draft.kind, account: state?.account, type: event?.type });
    });

    await hook("retry", (draft) => {
        const state = current.get(`${draft.sessionID}:primary`);
        const decisionBefore = draft.decision;
        let reason = "observe";
        if (modes.has("reroute") && state) {
            if (state.outputSeen) {
                // Text already reached the user; a retry would repeat it.
                draft.decision = { retry: false };
                reason = "output-already-seen";
            } else if (state.refused) {
                draft.decision = { retry: true, delay: 0 };
                reason = `reroute-away-from-${state.account}`;
            }
        }
        log("acct.retry", {
            sessionID: draft.sessionID,
            providerID: draft.model?.providerID,
            attempt: draft.attempt,
            account: state?.account,
            outputSeen: state?.outputSeen,
            refused: state?.refused,
            error: JSON.stringify(draft.error).slice(0, 400),
            decisionBefore,
            decisionAfter: draft.decision,
            reason,
        });
    });

    log("acct.registered", { plan, titleAccount, via: [...via], scope: options ?? "unscoped" });
}

// Unscoped observers, so a run can show which hooks fired for which provider
// next to the scoped ones above.
export async function registerUnscopedProbe(context) {
    for (const name of ["model.request", "http.request", "http.response", "experimental.ws.handshake", "retry"]) {
        await context.session.hook(name, (draft) => {
            log("probe.unscoped", { hook: name, sessionID: draft.sessionID, providerID: draft.model?.providerID, kind: draft.kind });
        });
    }
}
