// Runs each loopback-proxy scenario against the locally installed
// @opencode/cli (2.0.20) in server mode, with a throwaway HOME and XDG roots,
// the mock Codex backend (mock-server.mjs), the proxy plugin (plugin-proxy/)
// and an unrelated observer plugin (plugin-observer/). The harness drives the
// server over its HTTP API (create session, prompt, wait, interrupt, compact,
// generate), so it can abort a turn at a precise moment. Evidence goes to
// evidence/<scenario>/ so it can be reviewed without re-running anything.
//
// Usage: node run.mjs [scenario-name ...]   (no names = every scenario)
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { now, startMock } from "./mock-server.mjs";
import { seedCredential } from "./seed-credential.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "node_modules", ".bin", "opencode2");
const PASSWORD = "spike-loopback-only";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One agent-loop turn: prompt, then block until the session is idle again.
const turn = async (h, sid, text) => {
    await h.prompt(sid, text);
    await h.wait(sid);
};
const twoTurns = async (h) => {
    const sid = await h.session();
    await turn(h, sid, "Say hello.");
    await turn(h, sid, "Say it again.");
};
const oneTurn = async (h) => {
    const sid = await h.session();
    await turn(h, sid, "Say hello.");
};
// Two turns, then a compaction and a one-off generate call, to see which
// request kinds each pointing method catches.
const allKinds = async (h) => {
    const sid = await h.session();
    await turn(h, sid, "Say hello.");
    await turn(h, sid, "Say it again.");
    await h.compact(sid);
    await h.wait(sid);
    await h.generate(sid, "Generate one word.");
};
// `cycles` times: start a turn whose agent-loop reply is slow, and interrupt
// it `delay` ms after the mock reports the trigger event. A last, normal turn
// then shows how the session carries on after the aborts. Several cycles per
// scenario give several timing samples from one host process.
const ABORT_CYCLES = 5;
const abortAfter = (trigger, delay, cycles = ABORT_CYCLES) => async (h) => {
    const sid = await h.session();
    for (let cycle = 1; cycle <= cycles; cycle += 1) {
        const seen = h.waitForMock((event) => event.action === trigger);
        await h.prompt(sid, `Say hello slowly (${cycle}).`);
        await seen;
        await sleep(delay);
        await h.interrupt(sid);
        await h.wait(sid);
        await sleep(1000);
    }
    await turn(h, sid, "Say it again.");
};
const manyTurns = (count) => async (h) => {
    const sid = await h.session();
    for (let i = 0; i < count; i += 1) await turn(h, sid, `Turn ${i + 1}.`);
};

const quiet = { SPIKE_PROXY_QUIET: "1", SPIKE_OBSERVER_QUIET: "1" };
const slowReply = Array(ABORT_CYCLES).fill({ slow: 60, every: 100 });
const held = Array(ABORT_CYCLES).fill({ hold: 4000 });

// Scenario groups follow the numbered sections of REPORT.md.
const scenarios = [
    // Section 1 and "Pointing the host at the proxy": does each way of pointing
    // the host at the proxy catch every request kind?
    { name: "point-config-ws", point: "config", steps: allKinds },
    { name: "point-provider-transform-ws", point: "provider-transform", steps: allKinds, env: { SPIKE_KIND_HEADER: "1" } },
    { name: "point-provider-transform-ws-config-baseurl", point: "provider-transform", configBaseURL: "mock", steps: oneTurn },
    { name: "point-model-transform-ws", point: "model-transform", steps: allKinds },
    { name: "point-model-request-ws", point: "model-request", steps: allKinds },
    { name: "point-hooks-ws", point: "hooks", steps: allKinds },
    { name: "point-provider-transform-http", point: "provider-transform", transport: "http", steps: allKinds },
    { name: "point-none-ws", point: "none", steps: twoTurns },
    // Section 2: account per request, and switching account mid-session.
    { name: "switch-expand-ws", point: "provider-transform", steps: twoTurns, env: { SPIKE_PROXY_PLAN: "A,B", SPIKE_SWITCH_MODE: "expand", SPIKE_KIND_HEADER: "1" } },
    { name: "switch-passthrough-ws", point: "provider-transform", steps: twoTurns, env: { SPIKE_PROXY_PLAN: "A,B", SPIKE_SWITCH_MODE: "passthrough" } },
    { name: "switch-close-host-ws", point: "provider-transform", steps: twoTurns, env: { SPIKE_PROXY_PLAN: "A,B", SPIKE_SWITCH_MODE: "close-host" } },
    { name: "switch-http", point: "provider-transform", transport: "http", steps: twoTurns, env: { SPIKE_PROXY_PLAN: "A,B" } },
    // Section 3: user abort, through the proxy and (for comparison) direct.
    { name: "abort-midstream-ws", point: "provider-transform", plan: slowReply, steps: abortAfter("first-delta-sent", 300) },
    { name: "abort-midstream-http", point: "provider-transform", transport: "http", plan: slowReply, steps: abortAfter("first-delta-sent", 300) },
    { name: "abort-before-first-frame-ws", point: "provider-transform", plan: held, steps: abortAfter("plan", 500) },
    { name: "abort-before-headers-http", point: "provider-transform", transport: "http", plan: held, steps: abortAfter("plan", 500) },
    { name: "abort-midstream-ws-hooks", point: "hooks", plan: slowReply, steps: abortAfter("first-delta-sent", 300) },
    { name: "abort-midstream-ws-direct", point: "none", plan: slowReply, steps: abortAfter("first-delta-sent", 300) },
    { name: "abort-midstream-http-direct", point: "none", transport: "http", plan: slowReply, steps: abortAfter("first-delta-sent", 300) },
    { name: "abort-before-headers-http-direct", point: "none", transport: "http", plan: held, steps: abortAfter("plan", 500) },
    // Section 4: upstream HTTP errors relayed by the proxy, as other plugins see them.
    { name: "error-http-429", point: "provider-transform", transport: "http", plan: [{ status: 429 }], steps: oneTurn },
    { name: "error-http-400", point: "provider-transform", transport: "http", plan: [{ status: 400 }], steps: oneTurn },
    // Section 5: the host's own recovery paths (1009 close, connection limit,
    // socket dropped before or after output), with the proxy injecting the fault.
    { name: "fault-close-1009", point: "provider-transform", steps: twoTurns, env: { SPIKE_PROXY_FAULT: "close-1009" } },
    { name: "fault-close-1009-hooks", point: "hooks", steps: twoTurns, env: { SPIKE_PROXY_FAULT: "close-1009" } },
    { name: "fault-conn-limit", point: "provider-transform", steps: twoTurns, env: { SPIKE_PROXY_FAULT: "conn-limit" } },
    { name: "fault-close-before-output", point: "provider-transform", steps: twoTurns, env: { SPIKE_PROXY_FAULT: "close-before-output" } },
    { name: "fault-close-after-output", point: "provider-transform", steps: twoTurns, env: { SPIKE_PROXY_FAULT: "close-after-output" } },
    // Section 6: a stored ChatGPT login makes the built-in openai plugin move the base
    // URL to chatgpt.com; does the auth plugin's transform still win?
    { name: "host-credential-provider-transform", point: "provider-transform", model: "gpt-5.5", noKey: true, seedCredential: true, steps: twoTurns },
    { name: "host-credential-hooks", point: "hooks", model: "gpt-5.5", noKey: true, seedCredential: true, steps: twoTurns },
    // A user with HTTP(S)_PROXY set and no NO_PROXY entry for loopback: does
    // the host still reach a loopback base URL (the proxy, or the mock direct)?
    { name: "env-proxy-no-bypass-ws", point: "provider-transform", steps: twoTurns, env: { NO_PROXY: "", no_proxy: "" } },
    { name: "env-proxy-no-bypass-http", point: "provider-transform", transport: "http", steps: twoTurns, env: { NO_PROXY: "", no_proxy: "" } },
    { name: "env-proxy-no-bypass-direct-http", point: "none", transport: "http", steps: oneTurn, env: { NO_PROXY: "", no_proxy: "" } },
    // env-proxy-no-bypass-http again, with the plugin adding loopback to
    // NO_PROXY during setup.
    { name: "env-proxy-no-bypass-http-patched", point: "provider-transform", transport: "http", steps: twoTurns, env: { NO_PROXY: "", no_proxy: "", SPIKE_FIX_NO_PROXY: "1" } },
    // Section 7: latency, direct vs through the proxy, 200 small deltas per reply,
    // then throughput with 2000 deltas written back to back. Per-delta logging
    // is off in the proxy and the observer so log writes do not dominate.
    { name: "latency-direct-ws", point: "none", plan: Array(6).fill({ slow: 200, every: 0 }), steps: manyTurns(6), env: quiet },
    { name: "latency-proxy-ws", point: "provider-transform", plan: Array(6).fill({ slow: 200, every: 0 }), steps: manyTurns(6), env: quiet },
    { name: "latency-direct-http", point: "none", transport: "http", plan: Array(6).fill({ slow: 200, every: 0 }), steps: manyTurns(6), env: quiet },
    { name: "latency-proxy-http", point: "provider-transform", transport: "http", plan: Array(6).fill({ slow: 200, every: 0 }), steps: manyTurns(6), env: quiet },
    { name: "burst-direct-ws", point: "none", plan: Array(4).fill({ slow: 2000, every: -1 }), steps: manyTurns(4), env: quiet },
    { name: "burst-proxy-ws", point: "provider-transform", plan: Array(4).fill({ slow: 2000, every: -1 }), steps: manyTurns(4), env: quiet },
    { name: "burst-direct-http", point: "none", transport: "http", plan: Array(4).fill({ slow: 2000, every: -1 }), steps: manyTurns(4), env: quiet },
    { name: "burst-proxy-http", point: "provider-transform", transport: "http", plan: Array(4).fill({ slow: 2000, every: -1 }), steps: manyTurns(4), env: quiet },
];

function isolatedEnv(root, extra) {
    const env = {
        PATH: process.env.PATH,
        HOME: join(root, "home"),
        XDG_CONFIG_HOME: join(root, "xdg-config"),
        XDG_DATA_HOME: join(root, "xdg-data"),
        XDG_STATE_HOME: join(root, "xdg-state"),
        XDG_CACHE_HOME: join(root, "xdg-cache"),
        TMPDIR: join(root, "tmp"),
        // Any outbound request that is not to loopback goes to a dead proxy
        // port, so a misrouted request fails instead of reaching the internet.
        HTTP_PROXY: "http://127.0.0.1:9",
        HTTPS_PROXY: "http://127.0.0.1:9",
        http_proxy: "http://127.0.0.1:9",
        https_proxy: "http://127.0.0.1:9",
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
        OPENCODE_SERVER_PASSWORD: PASSWORD,
        ...extra,
    };
    for (const key of ["home", "xdg-config", "xdg-data", "xdg-state", "xdg-cache", "tmp"]) mkdirSync(join(root, key), { recursive: true });
    return env;
}

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

async function runScenario(scenario) {
    // Outside the repository so the host cannot pick up any ancestor config.
    const root = join(tmpdir(), "oc2-loopback-spike", scenario.name);
    rmSync(root, { recursive: true, force: true });
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: project });
    const logs = Object.fromEntries(["mock", "proxy", "plugin", "observer", "harness"].map((name) => [name, join(root, `${name}.jsonl`)]));
    for (const file of Object.values(logs)) writeFileSync(file, "");
    const harness = (event, data = {}) => appendFileSync(logs.harness, `${JSON.stringify({ t: now(), wall: Date.now(), event, ...data })}\n`);

    const mockWaiters = [];
    const mock = await startMock({
        log: logs.mock,
        plan: scenario.plan ?? [],
        onEvent: (event) => {
            for (const waiter of [...mockWaiters]) {
                if (waiter.predicate(event)) {
                    mockWaiters.splice(mockWaiters.indexOf(waiter), 1);
                    waiter.resolve(event);
                }
            }
        },
    });
    const proxyPort = scenario.point === "config" ? await freePort() : undefined;
    const env = isolatedEnv(root, {
        SPIKE_UPSTREAM: mock.url,
        SPIKE_PROXY_LOG: logs.proxy,
        SPIKE_PLUGIN_LOG: logs.plugin,
        SPIKE_OBSERVER_LOG: logs.observer,
        SPIKE_POINT: scenario.point,
        ...(proxyPort ? { SPIKE_PROXY_PORT: String(proxyPort) } : {}),
        ...(scenario.env ?? {}),
    });
    const modelID = scenario.model ?? "mock-model";
    // Where the config points openai. "mock" is the safety net for methods
    // that redirect per request: anything they miss reaches the mock without
    // the proxy's marker header and shows up in mock.jsonl. provider.transform
    // runs with no configured base URL by default, because a configured one
    // overrides the transform's value (the scenario
    // point-provider-transform-ws-config-baseurl shows the proxy being bypassed); anything
    // it misses then goes to api.openai.com through the dead outbound proxy.
    const configBaseURL = scenario.configBaseURL ?? (proxyPort ? "proxy" : scenario.point === "provider-transform" ? "none" : "mock");
    const baseURL = { proxy: `http://127.0.0.1:${proxyPort}/v1`, mock: `${mock.url}/v1`, none: undefined }[configBaseURL];
    const config = {
        $schema: "https://opencode.ai/config.json",
        plugins: [join(here, "plugin-proxy"), join(here, "plugin-observer")],
        providers: {
            openai: {
                settings: {
                    ...(baseURL ? { baseURL } : {}),
                    ...(scenario.noKey ? {} : { apiKey: "sk-mock-not-a-real-key" }),
                    ...(scenario.transport ? { transport: scenario.transport } : {}),
                },
                models: { [modelID]: { name: `Mock ${modelID}` } },
            },
        },
    };
    mkdirSync(join(env.XDG_CONFIG_HOME, "opencode"), { recursive: true });
    writeFileSync(join(env.XDG_CONFIG_HOME, "opencode", "opencode.json"), JSON.stringify(config, null, 2));

    let server;
    let serverLog = "";
    let serverURL;
    const startServer = async () => {
        const port = await freePort();
        serverURL = `http://127.0.0.1:${port}`;
        server = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", scenario.logLevel ?? "debug"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
        server.stdout.on("data", (d) => (serverLog += d));
        server.stderr.on("data", (d) => (serverLog += d));
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
            if (server.exitCode !== null) throw new Error(`server exited early with ${server.exitCode}`);
            try {
                await fetch(serverURL, { signal: AbortSignal.timeout(1000) });
                return;
            } catch {
                await sleep(250);
            }
        }
        throw new Error("server did not start");
    };
    const stopServer = async () => {
        const closed = new Promise((resolve) => server.on("close", resolve));
        server.kill("SIGTERM");
        const timer = setTimeout(() => server.kill("SIGKILL"), 10_000);
        await closed;
        clearTimeout(timer);
    };
    await startServer();
    if (scenario.seedCredential) {
        // The first start created the host database. Store the fake ChatGPT
        // credential while the host is down, then start it again so the
        // built-in openai plugin reads it during setup. The proxy log is
        // cleared so it only holds the second process's proxy.
        await stopServer();
        const rows = seedCredential(join(env.XDG_DATA_HOME, "opencode", "opencode.db"));
        serverLog += `\n----- spike: seeded credential rows ${JSON.stringify(rows)}; restarting server -----\n`;
        for (const name of ["proxy", "plugin"]) writeFileSync(logs[name], "");
        await startServer();
    }

    const auth = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`;
    const sessions = [];
    const call = async (method, path, body, timeoutMs = 90_000) => {
        const started = now();
        const response = await fetch(`${serverURL}${path}`, {
            method,
            headers: { authorization: auth, "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await response.text();
        harness("api", { method, path, status: response.status, started, ms: Number((now() - started).toFixed(1)), body: text.slice(0, 300) });
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    };
    const h = {
        session: async () => {
            // The server answers 503 service_starting for a moment after it
            // starts listening; wait that out.
            let created = await call("POST", "/api/session", { model: { providerID: "openai", id: modelID } });
            for (let attempt = 0; attempt < 50 && created?.code === "service_starting"; attempt += 1) {
                await sleep(200);
                created = await call("POST", "/api/session", { model: { providerID: "openai", id: modelID } });
            }
            sessions.push(created.data.id);
            return created.data.id;
        },
        prompt: (sid, text) => call("POST", `/api/session/${sid}/prompt`, { text }),
        wait: (sid) => call("POST", `/api/experimental/session/${sid}/wait`),
        interrupt: async (sid) => {
            harness("interrupt-sent", { sid });
            return call("POST", `/api/session/${sid}/interrupt`);
        },
        compact: (sid) => call("POST", `/api/session/${sid}/compact`, {}),
        generate: (sid, prompt) => call("POST", `/api/session/${sid}/generate`, { prompt }),
        waitForMock: (predicate, timeoutMs = 30_000) =>
            new Promise((resolve, reject) => {
                const waiter = { predicate, resolve };
                mockWaiters.push(waiter);
                setTimeout(() => reject(new Error("timed out waiting for a mock event")), timeoutMs).unref();
            }),
    };

    const started = Date.now();
    let error;
    try {
        await scenario.steps(h);
    } catch (caught) {
        error = String(caught?.stack ?? caught);
        harness("steps-failed", { error });
    }
    await sleep(500);
    const messages = {};
    for (const sid of sessions) {
        try {
            messages[sid] = (await call("GET", `/api/session/${sid}/message?limit=50&order=asc`)).data;
        } catch (caught) {
            messages[sid] = String(caught);
        }
    }
    await stopServer();
    await mock.close();

    const out = join(here, "evidence", scenario.name);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    // Paths under the throwaway root are replaced so evidence is stable and
    // does not leak the machine layout. macOS reports the temp root both with
    // and without its /private prefix.
    const scrub = (text) =>
        text
            .replaceAll(realpathSync(root), "<run>")
            .replaceAll(root, "<run>")
            .replaceAll(here, "<spike>")
            .replaceAll(realpathSync(tmpdir()), "<tmp>")
            .replaceAll(tmpdir(), "<tmp>");
    for (const [name, file] of Object.entries(logs)) if (existsSync(file)) writeFileSync(join(out, `${name}.jsonl`), scrub(readFileSync(file, "utf8")));
    writeFileSync(join(out, "config.json"), scrub(JSON.stringify(config, null, 2)));
    writeFileSync(join(out, "messages.json"), scrub(JSON.stringify(messages, null, 2)));
    writeFileSync(join(out, "server.log"), scrub(serverLog).slice(-400_000));
    const count = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).length;
    const summary = { scenario: scenario.name, point: scenario.point, transport: scenario.transport ?? "websocket (host default)", ms: Date.now() - started, error, sessions: sessions.length, lines: Object.fromEntries(Object.entries(logs).map(([name, file]) => [name, count(file)])) };
    writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary));
}

const wanted = new Set(process.argv.slice(2));
for (const scenario of scenarios) {
    if (wanted.size > 0 && !wanted.has(scenario.name)) continue;
    await runScenario(scenario);
}
