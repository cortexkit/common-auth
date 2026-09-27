// Condenses each evidence/<scenario>/ directory into digest.txt: one line per
// relevant record, prefixed with the file and line it came from, so the report
// can quote exact evidence without anyone re-running the host.
//
// Usage: node analyze.mjs [scenario-name ...]   (no names = every scenario)
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const evidence = join(here, "evidence");

function lines(file) {
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
        .split("\n")
        .map((text, index) => ({ text, line: index + 1 }))
        .filter((entry) => entry.text.trim().length > 0)
        .map((entry) => {
            try {
                return { ...entry, json: JSON.parse(entry.text) };
            } catch {
                return { ...entry, json: undefined };
            }
        });
}

const compact = (value) => JSON.stringify(value);

function mockLine({ json }) {
    const id = json.identity ? `account=${json.identity.account} token=${json.identity.token} chatgpt-account-id=${json.identity.accountHeader}` : "";
    if (json.transport === "http" && json.method) {
        return `http ${json.kind ?? "-"} #${json.modelRequest} ${id} previous_response_id=${json.body?.previous_response_id ?? "-"} originator=${json.headers?.originator ?? "-"}`;
    }
    if (json.action === "handshake") return `ws handshake conn=${json.connection} ${id} originator=${json.headers?.originator ?? "-"}`;
    if (json.action === "frame-in") {
        const marker = json.body?.keys?.includes("spike_marker") ? " spike_marker=present" : "";
        return `ws frame-in conn=${json.connection} #${json.modelRequest} ${id} previous_response_id=${json.body?.previous_response_id ?? "-"} previousKnownOnConnection=${json.previousKnownOnConnection ?? "-"} input_items=${json.body?.input_items}${marker}`;
    }
    return `${json.transport} ${json.action}${json.connection ? ` conn=${json.connection}` : ""}${json.account ? ` account=${json.account}` : ""}${json.code ? ` code=${json.code}` : ""}`;
}

function pluginLine({ json }) {
    const { t: _t, event, sessionID: _s, ...rest } = json;
    if (event === "setup") return `setup modes=${compact(json.modes)}`;
    if (event === "acct.model.request") {
        return `${event} provider=${json.providerID} kind=${json.kind} call=${json.primaryCall ?? "-"} account=${json.account} before=${compact(pick(json.headersBefore))} after=${compact(pick(json.headersAfter))} baseURL=${json.baseURLBefore}->${json.baseURLAfter}`;
    }
    if (event === "acct.ws.handshake") return `${event} kind=${json.kind} account=${json.account} before=${compact(pick(json.headersBefore))} after=${compact(pick(json.headersAfter))}`;
    return `${event} ${compact(rest)}`;
}

// Only the headers that decide identity or come from the host's openai plugin.
function pick(headers = {}) {
    const out = {};
    for (const [key, value] of Object.entries(headers)) {
        if (["authorization", "chatgpt-account-id", "originator", "session-id", "x-codex-beta-features"].includes(key.toLowerCase())) out[key] = value;
    }
    return out;
}

function stdoutLine({ json }) {
    if (json.type === "text") return `text ${compact(json.part?.text)} message=${json.part?.messageID}`;
    if (json.type === "error") return `error ${compact(json.error)}`;
    if (json.type === "step_start") return `step_start message=${json.part?.messageID}`;
    return json.type;
}

function interestingLog(text) {
    return /websocket|retry|Retry|rotat|fallback|plugin|error|ERROR|WARN/.test(text) && !/Sent HTTP response|database schema/.test(text);
}

const wanted = new Set(process.argv.slice(2));
for (const name of readdirSync(evidence).sort()) {
    if (wanted.size > 0 && !wanted.has(name)) continue;
    const dir = join(evidence, name);
    if (!existsSync(join(dir, "summary.json"))) continue;
    const out = [`# ${name}`, `summary: ${readFileSync(join(dir, "summary.json"), "utf8").replace(/\s+/g, " ").slice(0, 300)}`, "", "## mock.jsonl"];
    for (const entry of lines(join(dir, "mock.jsonl"))) out.push(`mock.jsonl:${entry.line} ${mockLine(entry)}`);
    out.push("", "## plugin.jsonl");
    for (const entry of lines(join(dir, "plugin.jsonl"))) {
        if (entry.json?.event === "acct.registered" || entry.json?.event === "setup") {
            out.push(`plugin.jsonl:${entry.line} ${pluginLine(entry)}`);
            continue;
        }
        out.push(`plugin.jsonl:${entry.line} ${pluginLine(entry)}`);
    }
    out.push("", "## stdout.jsonl");
    for (const entry of lines(join(dir, "stdout.jsonl"))) out.push(`stdout.jsonl:${entry.line} ${entry.json ? stdoutLine(entry) : entry.text.slice(0, 200)}`);
    out.push("", "## stderr.log (filtered)");
    for (const entry of lines(join(dir, "stderr.log"))) {
        if (interestingLog(entry.text)) out.push(`stderr.log:${entry.line} ${entry.text.slice(0, 400)}`);
    }
    writeFileSync(join(dir, "digest.txt"), `${out.join("\n")}\n`);
    console.log(`wrote ${join("evidence", name, "digest.txt")}`);
}
