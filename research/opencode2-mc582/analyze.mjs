// Summarizes evidence/<name>/observer.jsonl: for every response.create the
// host sent, whether previous_response_id is present and how many input items
// it carried (with a one-line digest of each item); for every response, the
// order output items were streamed (output_item.added / .done) and the order
// of response.completed.response.output. Writes evidence/<name>/analysis.txt.
//
//   node analyze.mjs arm-A arm-B ...
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const digest = (item) => {
    const kind = item.type ?? `role:${item.role}`;
    const id = item.id ? ` id=${item.id}` : "";
    const call = item.call_id ? ` call_id=${item.call_id}` : "";
    let text = "";
    if (Array.isArray(item.content)) {
        const parts = item.content.map((part) => part.text ?? part.type).join(" | ");
        text = ` ${item.role ?? ""} ${JSON.stringify(parts.length > 140 ? `${parts.slice(0, 140)}…(${parts.length})` : parts)}`;
    } else if (typeof item.content === "string") {
        text = ` ${item.role ?? ""} ${JSON.stringify(item.content.length > 140 ? `${item.content.slice(0, 140)}…(${item.content.length})` : item.content)}`;
    }
    if (item.type === "function_call") text = ` ${item.name}(${item.arguments})`;
    if (item.type === "function_call_output") text = ` ${JSON.stringify(String(item.output).slice(0, 80))}`;
    return `${kind}${id}${call}${text}`;
};

// Same rules as the host's incremental() in
// node_modules/@opencode/ai/dist/protocols/open-responses-continuation.js
// (lines 23-85), re-run offline over the logged frames so each full resend can
// be attributed to the first field or input item that differed.
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
// Removes a leading Magic Context tag from assistant text, for the
// counterfactual "would this request have gone out incremental without it".
const stripAssistantTags = (items) =>
    items.map((item) =>
        item?.type === "message" && item.role === "assistant" && Array.isArray(item.content)
            ? { ...item, content: item.content.map((part) => (typeof part.text === "string" ? { ...part, text: part.text.replace(/^§\d+§ /, "") } : part)) }
            : item,
    );
const diagnose = (request, checkpoint) => {
    const lines = [];
    const a = invariant(request);
    const b = invariant(checkpoint.request);
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => canonical(a[key]) !== canonical(b[key]));
    lines.push(`invariant fields equal: ${keys.length === 0}${keys.length ? ` (differ: ${keys.join(", ")})` : ""}`);
    const baseline = [...checkpoint.request.input, ...checkpoint.output];
    lines.push(`baseline = previous input ${checkpoint.request.input.length} + previous output ${checkpoint.output.length} = ${baseline.length}; new input ${request.input.length}`);
    const firstMismatch = baseline.findIndex((item, index) => canonical(comparable(item)) !== canonical(comparable(request.input[index])));
    if (firstMismatch === -1) lines.push("every baseline item matches the new input by index");
    else {
        lines.push(`first mismatch at index ${firstMismatch}:`);
        lines.push(`    checkpoint: ${canonical(comparable(baseline[firstMismatch])).slice(0, 300)}`);
        lines.push(`    new input : ${canonical(comparable(request.input[firstMismatch])).slice(0, 300)}`);
    }
    // Counterfactual: the same two requests if assistant text had never been
    // tagged (tags removed on both sides; tags on user and tool items stay).
    const stripped = stripAssistantTags(request.input);
    const strippedBaseline = [...stripAssistantTags(checkpoint.request.input), ...checkpoint.output];
    const strippedOk = keys.length === 0 && stripped.length > strippedBaseline.length && strippedBaseline.every((item, index) => canonical(comparable(item)) === canonical(comparable(stripped[index])));
    lines.push(`counterfactual, leading §N§ removed from assistant text in both requests: incremental possible = ${strippedOk}`);
    return lines;
};

for (const name of process.argv.slice(2)) {
    const lines = readFileSync(join(here, "evidence", name, "observer.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
    const out = [];
    let request = 0;
    let streamed = [];
    let checkpoint;
    let lastFull;
    let doneItems = [];
    for (const [index, entry] of lines.entries()) {
        const at = `observer.jsonl:${index + 1}`;
        if (entry.event === "http.request") out.push(`${at} http.request kind=${entry.kind} ${entry.method} ${entry.url}`);
        if (entry.event === "ws.handshake") out.push(`${at} ws.handshake kind=${entry.kind} ${entry.url}`);
        if (entry.event === "ws.send") {
            const frame = entry.frame;
            request += 1;
            // The host's full request for this step: sent as is (mode=full), or
            // rebuilt as baseline + delta (mode=incremental).
            const full = frame.previous_response_id && checkpoint ? { ...frame, input: [...checkpoint.request.input, ...checkpoint.output, ...frame.input] } : frame;
            out.push(`${at} ws.send #${request} type=${frame.type} model=${frame.model} reasoning=${JSON.stringify(frame.reasoning)} previous_response_id=${frame.previous_response_id ?? "(absent)"} input_items=${frame.input?.length}`);
            if (checkpoint) for (const line of diagnose({ ...full, previous_response_id: undefined }, checkpoint)) out.push(`    [continuation check vs previous checkpoint] ${line}`);
            lastFull = { ...full, previous_response_id: undefined };
            for (const [i, item] of (frame.input ?? []).entries()) out.push(`    input[${i}] ${digest(item)}`);
        }
        if (entry.event === "ws.receive") {
            const frame = entry.frame;
            if (frame.type === "response.created") {
                streamed = [];
                doneItems = [];
                out.push(`${at} ws.receive response.created id=${frame.response?.id}`);
            }
            if (frame.type === "response.output_item.added" || frame.type === "response.output_item.done") {
                if (frame.type === "response.output_item.done") doneItems.push(frame.item);
                streamed.push(`${frame.type.replace("response.output_item.", "")}:${frame.item.type}:${frame.item.id}`);
                out.push(`${at} ws.receive ${frame.type} output_index=${frame.output_index} ${digest(frame.item)}`);
            }
            if (frame.type === "response.completed" || frame.type === "response.done" || frame.type === "response.failed" || frame.type === "error") {
                const usage = frame.response?.usage;
                out.push(`${at} ws.receive ${frame.type} id=${frame.response?.id} status=${frame.response?.status} store=${frame.response?.store} input_tokens=${usage?.input_tokens} cached_tokens=${usage?.input_tokens_details?.cached_tokens}${frame.error ? ` error=${JSON.stringify(frame.error)}` : ""}`);
                for (const [i, item] of (frame.response?.output ?? []).entries()) out.push(`    completed.output[${i}] ${digest(item)}`);
                const doneOrder = streamed.filter((s) => s.startsWith("done:")).map((s) => s.slice(5));
                const envelopeOrder = (frame.response?.output ?? []).map((item) => `${item.type}:${item.id}`);
                out.push(`    streamed done order : ${doneOrder.join(", ")}`);
                out.push(`    envelope order      : ${envelopeOrder.join(", ")}`);
                out.push(`    orders match        : ${JSON.stringify(doneOrder) === JSON.stringify(envelopeOrder)}${envelopeOrder.length === 0 ? " (envelope output is empty, so the host checkpoints the output_item.done items in stream order)" : ""}`);
                // Host rule (continuation.js:159-163): the envelope output when
                // non-empty, else the output_item.done items in stream order.
                if (frame.type === "response.completed" && lastFull) checkpoint = { request: lastFull, output: frame.response?.output?.length ? frame.response.output : doneItems.slice() };
            }
        }
        if (entry.event === "retry") out.push(`${at} retry ${entry.error}`);
    }
    out.unshift(`# ${name}: ${request} response.create frames`);
    writeFileSync(join(here, "evidence", name, "analysis.txt"), `${out.join("\n")}\n`);
    console.log(out.join("\n"));
}
