// Turns each scenario's raw logs into reviewable digests:
//   evidence/<scenario>/timeline.txt  every log line of the harness, the proxy
//       plugin's hooks, the observer plugin, the proxy and the mock upstream,
//       merged in time order, each naming its source file and line number.
//       Runs of consecutive streaming frames of one type are folded into one
//       line with a count.
//   evidence/<scenario>/metrics.json  abort and latency measurements.
//   evidence/overview.txt  one entry per scenario with the session outcome.
//
// Clocks: the harness and the mock share one Node process, the plugins and the
// proxy share the host (Bun) process. Every line carries `t`, a sub-millisecond
// clock that is only comparable within one process, and `wall` (Date.now(),
// 1 ms resolution), which is comparable across processes. The hi-res clocks of
// the two processes were seen to disagree by several milliseconds, so
// cross-process ordering and deltas use `wall`, and deltas within one process
// use `t`.
//
// Usage: node analyze.mjs [scenario-name ...]   (no names = every scenario)
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "evidence");
const wanted = new Set(process.argv.slice(2));

const SOURCES = ["harness", "plugin", "observer", "proxy", "mock"];
// Which process wrote each log, for deciding whether `t` values compare.
const PROCESS = { harness: "node", mock: "node", plugin: "host", observer: "host", proxy: "host" };
const DROP_KEYS = new Set(["t", "wall", "plugin", "hostHeaders", "headers", "hostHeaderNames"]);

function round(value) {
    return value === undefined ? undefined : Number(value.toFixed(1));
}
function stats(values) {
    const list = values.filter((value) => value !== undefined).sort((a, b) => a - b);
    if (list.length === 0) return undefined;
    return { n: list.length, min: round(list[0]), median: round(list[Math.floor(list.length / 2)]), max: round(list.at(-1)) };
}
// Milliseconds from event `a` to event `b`: hi-res when both come from one
// process, wall clock otherwise.
function delta(a, b) {
    if (!a || !b) return undefined;
    return PROCESS[a.source] === PROCESS[b.source] ? round(b.entry.t - a.entry.t) : b.entry.wall - a.entry.wall;
}

function describe(source, entry) {
    const parts = [];
    for (const [key, value] of Object.entries(entry)) {
        if (DROP_KEYS.has(key) || value === undefined || value === null) continue;
        if (key === "body" && source === "harness") continue;
        const text = typeof value === "string" ? value : JSON.stringify(value);
        parts.push(`${key}=${text.length > 160 ? `${text.slice(0, 160)}…` : text}`);
    }
    return parts.join(" ");
}

// A key that identifies "the same streaming frame again" for folding.
function foldKey(source, entry) {
    if (source === "observer" && entry.event === "ws.receive") return `${source}|ws.receive|${entry.type}`;
    if (source === "proxy" && entry.ev === "frame") return `${source}|${entry.side}|${entry.type}|${entry.conn}`;
    return undefined;
}

function load(dir) {
    const events = [];
    for (const source of SOURCES) {
        const file = join(dir, `${source}.jsonl`);
        if (!existsSync(file)) continue;
        readFileSync(file, "utf8")
            .split("\n")
            .forEach((line, index) => {
                if (!line) return;
                events.push({ source, line: index + 1, entry: JSON.parse(line) });
            });
    }
    // Wall clock first (the only cross-process clock), then a fixed source
    // order, then the in-process clock.
    events.sort((a, b) => a.entry.wall - b.entry.wall || SOURCES.indexOf(a.source) - SOURCES.indexOf(b.source) || a.entry.t - b.entry.t);
    return events;
}

function timeline(events) {
    const start = events[0].entry.wall;
    const out = [];
    let fold;
    const flush = () => {
        if (!fold) return;
        const { first, last, count } = fold;
        const range = count > 1 ? `${first.source}.jsonl:${first.line}-${last.line}` : `${first.source}.jsonl:${first.line}`;
        const suffix = count > 1 ? ` (x${count}, until +${last.entry.wall - start} ms)` : "";
        out.push(`+${String(first.entry.wall - start).padStart(6)} ms  ${range.padEnd(26)} ${describe(first.source, first.entry)}${suffix}`);
        fold = undefined;
    };
    for (const event of events) {
        const key = foldKey(event.source, event.entry);
        if (fold && key && fold.key === key) {
            fold.last = event;
            fold.count += 1;
            continue;
        }
        flush();
        fold = { key, first: event, last: event, count: 1 };
        if (!key) flush();
    }
    flush();
    return `${out.join("\n")}\n`;
}

// For every interrupt the harness sent: how long the interrupt API call took,
// how long until the host dropped its connection to the proxy (wall clock,
// 1 ms), how long until the mock upstream saw its connection close (same
// process as the harness, hi-res), and inside the proxy how long from the
// host's close to the proxy closing (or destroying) its upstream connection and
// to that connection being reported closed (hi-res).
function abortMetrics(events) {
    const samples = [];
    for (const [index, event] of events.entries()) {
        if (event.source !== "harness" || event.entry.event !== "interrupt-sent") continue;
        const later = events.slice(index + 1);
        const first = (source, test, from = later) => from.find((candidate) => candidate.source === source && test(candidate.entry));
        const api = first("harness", (entry) => entry.event === "api" && entry.path.endsWith("/interrupt"));
        const hostClose = first("proxy", (entry) => entry.ev === "host-closed" || entry.ev === "host-aborted");
        const afterHostClose = hostClose ? events.slice(events.indexOf(hostClose) + 1) : [];
        const proxyUpstreamClosed = hostClose ? first("proxy", (entry) => entry.ev === "upstream-closed", afterHostClose) : undefined;
        const proxyCloseCalled = hostClose ? first("proxy", (entry) => entry.ev === "upstream-close-called" || entry.ev === "upstream-destroy-called", afterHostClose) : undefined;
        const upstreamSeen = first("mock", (entry) => entry.action === "closed" || entry.action === "client-closed-early");
        samples.push({
            interruptSent: `harness.jsonl:${event.line}`,
            interruptApiMs: api ? round(api.entry.ms) : undefined,
            hostClosedProxySideMs: delta(event, hostClose),
            hostCloseVia: hostClose?.entry.via ?? hostClose?.entry.ev,
            upstreamSawCloseMs: delta(event, upstreamSeen),
            upstreamSawClose: upstreamSeen ? `mock.jsonl:${upstreamSeen.line}` : undefined,
            proxyHostCloseToCloseCalledMs: delta(hostClose, proxyCloseCalled),
            proxyHostCloseToUpstreamClosedMs: delta(hostClose, proxyUpstreamClosed),
        });
    }
    const pick = (key) => stats(samples.map((sample) => sample[key]));
    return {
        samples,
        summary: samples.length
            ? {
                  interruptApiMs: pick("interruptApiMs"),
                  hostClosedProxySideMs: pick("hostClosedProxySideMs"),
                  upstreamSawCloseMs: pick("upstreamSawCloseMs"),
                  proxyHostCloseToCloseCalledMs: pick("proxyHostCloseToCloseCalledMs"),
                  proxyHostCloseToUpstreamClosedMs: pick("proxyHostCloseToUpstreamClosedMs"),
              }
            : undefined,
    };
}

// Per agent-loop request, using only same-process deltas:
//   turnMs            harness: prompt call started -> wait call returned
//   upstreamStreamMs  mock: first text delta written -> response completed
//   hostStreamMs      observer hooks: first text delta received -> completed
//   hostToProxyMs     host process: observer send hook -> proxy got the request
//   requestToUpstreamWallMs  observer send hook -> mock got it (wall, 1 ms)
function latencyMetrics(events) {
    const requests = [];
    const prompts = events.filter((event) => event.source === "harness" && event.entry.event === "api" && event.entry.path.endsWith("/prompt"));
    const waits = events.filter((event) => event.source === "harness" && event.entry.event === "api" && event.entry.path.endsWith("/wait"));
    const arrivals = events.filter((event) => event.source === "mock" && (event.entry.action === "frame-in" || (event.entry.action === "request" && event.entry.kind === "primary")));
    for (const [index, arrival] of arrivals.entries()) {
        const ws = arrival.entry.transport === "ws";
        const request = arrival.entry.request;
        const after = events.slice(events.indexOf(arrival) + 1);
        const firstDelta = after.find((event) => event.source === "mock" && event.entry.action === "first-delta-sent" && event.entry.request === request);
        const done = after.find((event) => event.source === "mock" && event.entry.action === "completed" && event.entry.request === request);
        if (!firstDelta || !done) continue;
        // Match host-side events to this request by position: the Nth agent-loop
        // request the mock received belongs to the Nth send, first-delta and
        // completed event the observer logged. That holds only in scenarios with
        // one agent-loop request per turn and quiet observer logging (the
        // latency-* and burst-* runs), so only those get latency metrics.
        const hostSends = events.filter((event) => event.source === "observer" && (ws ? event.entry.event === "ws.send" : event.entry.event === "http.request" && event.entry.kind === "primary"));
        const hostFirsts = events.filter((event) => event.source === "observer" && event.entry.kind === "primary" && (ws ? event.entry.event === "ws.receive" && event.entry.type === "response.output_text.delta" : event.entry.event === "http.body.first-chunk"));
        const hostLasts = events.filter((event) => event.source === "observer" && event.entry.kind === "primary" && (ws ? event.entry.event === "ws.receive" && event.entry.type === "response.completed" : event.entry.event === "http.body.completed-seen"));
        const proxyReceipts = events.filter((event) => event.source === "proxy" && (ws ? event.entry.ev === "response.create" : event.entry.ev === "request" && event.entry.kindFromBody === "primary"));
        const send = hostSends[index];
        const turnPrompt = prompts[index];
        const turnWait = waits[index];
        requests.push({
            transport: arrival.entry.transport,
            mock: `mock.jsonl:${arrival.line}`,
            turnMs: turnPrompt && turnWait ? round(turnWait.entry.t - turnPrompt.entry.started) : undefined,
            upstreamStreamMs: delta(firstDelta, done),
            hostStreamMs: delta(hostFirsts[index], hostLasts[index]),
            hostToProxyMs: proxyReceipts.length ? delta(send, proxyReceipts[index]) : undefined,
            requestToUpstreamWallMs: delta(send, arrival),
        });
    }
    return {
        requests,
        summary: requests.length ? Object.fromEntries(["turnMs", "upstreamStreamMs", "hostStreamMs", "hostToProxyMs", "requestToUpstreamWallMs"].map((key) => [key, stats(requests.map((request) => request[key]))])) : undefined,
    };
}

// How far apart the two processes' hi-res clocks are: median of (t - wall)
// per process. Recorded so the clock caveat above is backed by numbers.
function clockOffsets(events) {
    const offsets = {};
    for (const event of events) (offsets[PROCESS[event.source]] ??= []).push(event.entry.t - event.entry.wall);
    return Object.fromEntries(Object.entries(offsets).map(([name, values]) => [name, stats(values)]));
}

const overview = [];
for (const name of readdirSync(root).sort()) {
    const dir = join(root, name);
    if (!existsSync(join(dir, "summary.json"))) continue;
    if (wanted.size === 0 || wanted.has(name)) {
        const events = load(dir);
        if (events.length > 0) {
            writeFileSync(join(dir, "timeline.txt"), timeline(events));
            const timed = name.startsWith("latency-") || name.startsWith("burst-");
            const metrics = { clockOffsetsMs: clockOffsets(events), aborts: abortMetrics(events), latency: timed ? latencyMetrics(events) : undefined };
            writeFileSync(join(dir, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
        }
    }
    const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
    const outcomes = [];
    for (const messages of Object.values(JSON.parse(readFileSync(join(dir, "messages.json"), "utf8")))) {
        if (!Array.isArray(messages)) continue;
        for (const message of messages) {
            if (message.type === "assistant") {
                const text = (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text.replace(/^\.+/, (dots) => `<${dots.length} dots>`)).join("|");
                outcomes.push(`assistant:${JSON.stringify(text)}${message.error ? ` error=${message.error.type}` : ""}`);
            } else if (message.type === "idle") outcomes.push(`idle:${message.outcome}`);
            else if (message.type !== "user") outcomes.push(message.type);
        }
    }
    overview.push(`${name}\n    ${summary.point} / ${summary.transport}, ${summary.ms} ms${summary.error ? `, HARNESS ERROR ${summary.error.split("\n")[0]}` : ""}\n    ${outcomes.join("  ")}`);
}
writeFileSync(join(root, "overview.txt"), `${overview.join("\n")}\n`);
