// Turns each run's evidence into per-request and per-text rows, and writes
// them to tables.md (all runs named on the command line) and to
// evidence/<run>/analysis.md.
//
//   node analyze.mjs variant-A-1 variant-A-2 ... variant-C-3
//
// Sources, all in evidence/<run>/:
//   observer.jsonl  every WebSocket frame the host sent, and every frame it
//                   received except deltas: previous_response_id, the input
//                   items, the model's raw output items, token usage
//   capture.jsonl   per request, the message history as it left Magic
//                   Context's transform (plugin-selftag), i.e. the assistant
//                   text the client replays, even on incremental requests
//   messages.json   the session as the host stored it (GET /api/.../message)
//   server.log      the host's own "session websocket sending … mode=" line
//   harness.jsonl   turn boundaries
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Same rules as the host's incremental() in
// node_modules/@opencode/ai/dist/protocols/open-responses-continuation.js,
// re-run offline over the logged frames so each full resend can be
// attributed to the first field or input item that differed (copied from
// ../opencode2-mc582/analyze.mjs).
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const canonical = (value) => {
    if (value === undefined) return "undefined";
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (!isRecord(value)) return JSON.stringify(value);
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
};
const parseJson = (value) => {
    if (typeof value !== "string") return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
};
const comparable = (value) => {
    if (!isRecord(value)) return value;
    if (value.type === "message" && value.role === "assistant")
        return {
            role: "assistant",
            content: Array.isArray(value.content) ? value.content.map((part) => (isRecord(part) && part.type === "output_text" ? { type: part.type, text: part.text } : part)) : value.content,
            ...(value.phase === undefined ? {} : { phase: value.phase }),
        };
    if (value.type === "function_call") return { type: value.type, call_id: value.call_id, name: value.name, arguments: parseJson(value.arguments) };
    if (value.type === "reasoning") return { type: value.type, summary: value.summary, encrypted_content: value.encrypted_content };
    return value;
};
const invariant = ({ type: _t, input: _i, previous_response_id: _p, ...rest }) => rest;
const firstDifference = (request, checkpoint) => {
    const a = invariant(request);
    const b = invariant(checkpoint.request);
    const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => canonical(a[key]) !== canonical(b[key]));
    if (fields.length) return `request field(s) ${fields.join(", ")}`;
    const baseline = [...checkpoint.request.input, ...checkpoint.output];
    const index = baseline.findIndex((item, i) => canonical(comparable(item)) !== canonical(comparable(request.input[i])));
    if (index === -1) return request.input.length > baseline.length ? "none (a delta was possible)" : "none, but no new items";
    const show = (item) => (item?.type === "message" ? JSON.stringify(item.content?.map((p) => p.text).join("")) : canonical(comparable(item)).slice(0, 120));
    return `input[${index}] ${baseline[index]?.type ?? baseline[index]?.role}${baseline[index]?.role ? ` ${baseline[index].role}` : ""}: provider output ${show(baseline[index])} vs client ${show(request.input[index])}`;
};

const textOf = (item) => (Array.isArray(item?.content) ? item.content.map((part) => part.text ?? "").join("") : "");
// Finds the text part carrying a given provider item id anywhere in a stored
// or captured message tree (the host keeps it under state.itemId in storage
// and under providerMetadata.openai.itemId in the context-hook messages).
const findTextPart = (tree, itemID) => {
    let found;
    const walk = (node) => {
        if (found !== undefined || !isRecord(node) && !Array.isArray(node)) return;
        if (Array.isArray(node)) return node.forEach(walk);
        if (node.type === "text" && typeof node.text === "string" && (node.state?.itemId === itemID || node.providerMetadata?.openai?.itemId === itemID)) {
            found = node.text;
            return;
        }
        Object.values(node).forEach(walk);
    };
    walk(tree);
    return found;
};
const tagOf = (text) => /^§(\d+)§ /.exec(text ?? "")?.[1];
const cell = (text) => (text === undefined ? "—" : `\`${JSON.stringify(text).slice(1, -1).replaceAll("`", "\\`").replaceAll("|", "\\|")}\``);
const short = (id) => (id ? `…${id.slice(-6)}` : "");

const analyzeRun = (name) => {
    const dir = join(here, "evidence", name);
    const jsonl = (file) => readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean).map(JSON.parse);
    const observer = jsonl("observer.jsonl");
    const captures = jsonl("capture.jsonl");
    const turnStarts = jsonl("harness.jsonl").filter((e) => e.event === "turn-start");
    const stored = JSON.parse(readFileSync(join(dir, "messages.json"), "utf8"));
    const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
    const hostModes = [...readFileSync(join(dir, "server.log"), "utf8").matchAll(/message="session websocket sending".*? mode=(\w+)/g)].map((m) => m[1]);
    const lsof = ["lsof-during-turn-1.txt", "lsof-end.txt"].map((file) => `${file}: ${/# forbidden hits: (\d+)/.exec(readFileSync(join(dir, file), "utf8"))?.[1]}`);
    const turnAt = (wall) => turnStarts.filter((t) => t.wall <= wall).length;

    const requests = [];
    let current;
    let checkpoint;
    const httpModelCalls = observer.filter((e) => e.event === "http.request" && /\/responses$/.test(e.url)).map((e) => e.kind);
    for (const [line, entry] of observer.entries()) {
        if (entry.event === "ws.send") {
            const frame = entry.frame;
            const full = frame.previous_response_id && checkpoint ? { ...frame, input: [...checkpoint.request.input, ...checkpoint.output, ...frame.input] } : frame;
            current = { n: requests.length + 1, line: line + 1, turn: turnAt(entry.wall), frame, full: { ...full, previous_response_id: undefined }, output: [], usage: undefined };
            current.firstDifference = requests.length && !frame.previous_response_id && checkpoint ? firstDifference(current.full, checkpoint) : undefined;
            requests.push(current);
        }
        if (entry.event === "ws.receive" && current) {
            if (entry.frame.type === "response.output_item.done") current.output.push(entry.frame.item);
            if (entry.frame.type === "response.completed") {
                current.usage = entry.frame.response?.usage;
                current.status = "completed";
                checkpoint = { request: current.full, output: entry.frame.response?.output?.length ? entry.frame.response.output : current.output.slice() };
            }
            if (["response.failed", "error"].includes(entry.frame.type)) current.status = entry.frame.type;
        }
    }
    const problems = [];
    if (captures.length !== requests.length) problems.push(`capture.jsonl has ${captures.length} records for ${requests.length} requests`);
    if (hostModes.length !== requests.length) problems.push(`server.log has ${hostModes.length} sending lines for ${requests.length} requests`);
    if (summary.error) problems.push(`run error: ${summary.error.split("\n")[0]}`);
    if (captures.some((c) => !c.systemBefore?.[0]?.mentionsMagicContext)) problems.push("some request's system text lacked Magic Context guidance when the self-tag callback ran");

    const requestRows = requests.map((r, i) => {
        const outputs = r.output.map((item) => (item.type === "function_call" ? item.name : item.type === "message" ? "text" : item.type));
        const counts = outputs.reduce((acc, kind) => ({ ...acc, [kind]: (acc[kind] ?? 0) + 1 }), {});
        const input = r.usage?.input_tokens;
        const cached = r.usage?.input_tokens_details?.cached_tokens;
        return {
            ...r,
            sentAs: r.frame.previous_response_id ? `previous_response_id + ${r.frame.input.length}-item delta` : `full, ${r.frame.input.length} items`,
            hostMode: hostModes[i],
            outputs: Object.entries(counts).map(([kind, n]) => (n > 1 ? `${kind}×${n}` : kind)).join(", "),
            input,
            cached,
            uncached: input !== undefined && cached !== undefined ? input - cached : undefined,
            outputTokens: r.usage?.output_tokens,
        };
    });

    const textRows = [];
    for (const [i, r] of requests.entries()) {
        for (const item of r.output.filter((o) => o.type === "message")) {
            const raw = textOf(item);
            const storedText = findTextPart(stored, item.id);
            // The next request's history, as Magic Context handed it on. Absent
            // after the session's last response.
            const replayed = captures[i + 1] ? findTextPart(captures[i + 1].messages, item.id) : undefined;
            const next = requests[i + 1];
            const wireItem = next && !next.frame.previous_response_id ? next.frame.input.find((x) => x.id === item.id) : undefined;
            textRows.push({
                turn: r.turn,
                request: r.n,
                id: item.id,
                phase: item.phase,
                withCalls: r.output.filter((o) => o.type === "function_call").length,
                raw,
                storedText,
                storedEqual: storedText === raw,
                replayed,
                replayedEqual: replayed === undefined ? undefined : replayed === raw,
                wire: wireItem ? textOf(wireItem) : undefined,
                rawTag: tagOf(raw),
                mcTag: tagOf(replayed),
            });
        }
    }
    // On full resends the replayed text is also on the wire; it must match what
    // capture.jsonl recorded, or the capture is not a faithful view of the input.
    const wireChecked = textRows.filter((t) => t.wire !== undefined);
    const wireMismatch = wireChecked.filter((t) => t.wire !== t.replayed);
    if (wireMismatch.length) problems.push(`${wireMismatch.length} replayed texts differ between capture.jsonl and the wire`);
    return { name, summary, requests: requestRows, texts: textRows, httpModelCalls, lsof, problems, wireChecked: wireChecked.length };
};

const render = (run) => {
    const out = [];
    out.push(`### ${run.name} (variant ${run.summary.variant}, session \`${run.summary.sessionID}\`)`);
    out.push("");
    out.push(`Model calls: ${run.requests.length} \`response.create\` frames on the WebSocket + ${run.httpModelCalls.length} HTTP (${run.httpModelCalls.join(", ") || "none"}) = ${run.requests.length + run.httpModelCalls.length}. Open files under the real opencode/cortexkit directories (lsof): ${run.lsof.join(", ")}. Replayed texts that also went on the wire (because the next request was a full resend) and equal the text in capture.jsonl: ${run.wireChecked}.${run.problems.length ? ` **Problems:** ${run.problems.join("; ")}.` : ""}`);
    out.push("");
    out.push("Model requests (WebSocket `response.create` frames):");
    out.push("");
    out.push("| req | turn | sent as | host log | first differing item (full resends after request 1) | response items | input | cached | uncached | output |");
    out.push("|---|---|---|---|---|---|---|---|---|---|");
    for (const r of run.requests)
        out.push(`| ${r.n} (\`observer.jsonl:${r.line}\`) | ${r.turn} | ${r.sentAs} | ${r.hostMode ?? "?"} | ${r.firstDifference ? r.firstDifference.replaceAll("|", "\\|") : r.n === 1 ? "(first request)" : "—"} | ${r.outputs || "(none)"}${r.status === "completed" ? "" : ` [${r.status ?? "no completion"}]`} | ${r.input ?? "?"} | ${r.cached ?? "?"} | ${r.uncached ?? "?"} | ${r.outputTokens ?? "?"} |`);
    out.push("");
    out.push("Assistant text items: raw model output, the host's stored copy, and the copy the client replayed in the next request:");
    out.push("");
    out.push("| turn | req | item | phase | calls in same reply | raw model text | stored == raw | replayed by the client (after Magic Context) | replayed == raw |");
    out.push("|---|---|---|---|---|---|---|---|---|");
    for (const t of run.texts)
        out.push(
            `| ${t.turn} | ${t.request} | ${short(t.id)} | ${t.phase ?? ""} | ${t.withCalls} | ${cell(t.raw)} | ${t.storedEqual ? "yes" : `**no**: stored ${cell(t.storedText)}`} | ${t.replayed === undefined ? "— (last reply, never replayed)" : t.replayedEqual ? "same bytes" : cell(t.replayed)} | ${t.replayedEqual === undefined ? "—" : t.replayedEqual ? "yes" : "**no**"} |`,
        );
    out.push("");
    return out.join("\n");
};

const runs = process.argv.slice(2).map(analyzeRun);
const tally = {};
for (const run of runs) {
    const v = (tally[run.summary.variant] ??= { sessions: 0, calls: 0, requests: 0, later: 0, incremental: 0, full: 0, texts: 0, storedEqual: 0, replayed: 0, replayedEqual: 0, rawTagged: 0 });
    v.sessions += 1;
    v.calls += run.requests.length + run.httpModelCalls.length;
    v.requests += run.requests.length;
    for (const r of run.requests.slice(1)) {
        v.later += 1;
        if (r.frame.previous_response_id) v.incremental += 1;
        else v.full += 1;
    }
    for (const t of run.texts) {
        v.texts += 1;
        if (t.storedEqual) v.storedEqual += 1;
        if (t.rawTag) v.rawTagged += 1;
        if (t.replayed !== undefined) {
            v.replayed += 1;
            if (t.replayedEqual) v.replayedEqual += 1;
        }
    }
}
const head = [
    "| variant | sessions | model calls | requests after the first in a session | of which previous_response_id + delta | of which full resend | assistant text items | raw text starting with a tag | stored == raw | replayed later | replayed == raw |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...Object.entries(tally).map(([variant, v]) => `| ${variant} | ${v.sessions} | ${v.calls} | ${v.later} | ${v.incremental} | ${v.full} | ${v.texts} | ${v.rawTagged} | ${v.storedEqual} | ${v.replayed} | ${v.replayedEqual} |`),
    "",
].join("\n");
const body = runs.map(render).join("\n");
for (const run of runs) writeFileSync(join(here, "evidence", run.name, "analysis.md"), `${render(run)}\n`);
writeFileSync(join(here, "tables.md"), `<!-- generated by: node analyze.mjs ${process.argv.slice(2).join(" ")} -->\n\n## Totals\n\n${head}\n## Per session\n\n${body}`);
console.log(head);
for (const run of runs) if (run.problems.length) console.log(`${run.name}: ${run.problems.join("; ")}`);
