// Runs each spike scenario against the locally installed @opencode/cli with a
// throwaway HOME and XDG roots, a local mock provider, and the probe plugin.
// Evidence (plugin hook log, mock request log, CLI stdout/stderr) is copied to
// evidence/<scenario>/ so it can be reviewed without re-running anything.
//
// Usage: node run.mjs [scenario-name ...]   (no names = every scenario of this
// spike; `--first-spike` also runs the earlier transport spike's scenarios for
// provider selection, AI SDK hooks, HTTP/WebSocket redirects and retries, from
// common-auth/research/opencode2-transport)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startMock } from "./mock-server.mjs";
import { seedCredential } from "./seed-credential.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "node_modules", ".bin", "opencode2");
const pluginDir = join(here, "plugin");
const sdkFactoryURL = pathToFileURL(join(pluginDir, "sdk-factory.mjs")).href;

const model = (name) => ({ models: { "mock-model": { name } } });

// Provider configurations under test. `openai` keeps the host's own package
// selection (from its bundled models.dev snapshot) so we see the default path.
const providers = (mockURL, which) => {
    const all = {
        openai: {
            settings: { baseURL: `${mockURL}/v1`, apiKey: "sk-mock-not-a-real-key" },
            ...model("Mock via openai"),
        },
        "openai-http": {
            name: "openai with transport=http",
            settings: { baseURL: `${mockURL}/v1`, apiKey: "sk-mock-not-a-real-key", transport: "http" },
            ...model("Mock via openai (http)"),
        },
        // No apiKey: the only credentials on the wire are the ones a plugin adds.
        "openai-nokey": {
            settings: { baseURL: `${mockURL}/v1` },
            ...model("Mock via openai, no configured key"),
        },
        "openai-http-nokey": {
            name: "openai with transport=http, no configured key",
            settings: { baseURL: `${mockURL}/v1`, transport: "http" },
            ...model("Mock via openai (http), no configured key"),
        },
        // With a ChatGPT credential stored, the host's openai plugin disables
        // models older than gpt-5.5, so this variant uses an allowed model ID.
        "openai-codexmodel": {
            settings: { baseURL: `${mockURL}/v1` },
            models: { "gpt-5.5": { name: "Mock gpt-5.5" } },
        },
        mockcompat: {
            name: "Generic OpenAI-compatible",
            package: "@ai-sdk/openai-compatible",
            settings: { baseURL: `${mockURL}/v1`, apiKey: "sk-mock-not-a-real-key" },
            ...model("Mock via openai-compatible"),
        },
        explicitaisdk: {
            name: "Explicit aisdk: prefix on @ai-sdk/openai",
            package: "aisdk:@ai-sdk/openai",
            settings: { baseURL: `${mockURL}/v1`, apiKey: "sk-mock-not-a-real-key" },
            ...model("Mock via aisdk:@ai-sdk/openai"),
        },
        unmappednpm: {
            name: "Unmapped aisdk: npm package",
            package: "aisdk:@cortexkit/spike-openai",
            settings: { baseURL: `${mockURL}/v1`, apiKey: "sk-mock-not-a-real-key" },
            ...model("Mock via unmapped npm package"),
        },
        customaisdk: {
            name: "aisdk: package that is a local file",
            package: `aisdk:${sdkFactoryURL}`,
            settings: { baseURL: `${mockURL}/v1`, apiKey: "sk-mock-not-a-real-key" },
            ...model("Mock via plugin-supplied SDK"),
        },
    };
    const picked = {};
    for (const id of which) {
        // Every "openai-*" entry is a variant of the openai provider itself.
        if (id.startsWith("openai-")) picked.openai = all[id];
        else picked[id] = all[id];
    }
    return picked;
};

// Two turns of one session, both handled by the same server process so the
// host's per-session WebSocket and the plugin's in-memory state survive
// between them.
const twoTurns = [{ message: "Say hello." }, { args: ["--continue"], message: "Say it again." }];
const host = { SPIKE_FORCE_BASEURL: "<mock>/v1" };

const scenarios = [
    // Q1: per-request account choice. Plan "A,B": turn 1 uses A, turn 2 uses B.
    { name: "q1-http-model-request-apikey", providers: ["openai-http"], model: "openai/mock-model", mode: "accounts", server: true, turns: twoTurns, env: { SPIKE_ACCOUNT_PLAN: "A,B", SPIKE_TITLE_ACCOUNT: "A", SPIKE_AUTH_VIA: "model-request" } },
    { name: "q1-http-model-request-nokey", providers: ["openai-http-nokey"], model: "openai/mock-model", mode: "accounts", server: true, turns: twoTurns, env: { SPIKE_ACCOUNT_PLAN: "A,B", SPIKE_TITLE_ACCOUNT: "A", SPIKE_AUTH_VIA: "model-request" } },
    { name: "q1-http-http-request-apikey", providers: ["openai-http"], model: "openai/mock-model", mode: "accounts", server: true, turns: twoTurns, env: { SPIKE_ACCOUNT_PLAN: "A,B", SPIKE_TITLE_ACCOUNT: "A", SPIKE_AUTH_VIA: "http-request" } },
    { name: "q1-ws-model-request-nokey", logLevel: "debug", providers: ["openai-nokey"], model: "openai/mock-model", mode: "accounts", server: true, turns: twoTurns, env: { SPIKE_ACCOUNT_PLAN: "A,B", SPIKE_TITLE_ACCOUNT: "A", SPIKE_AUTH_VIA: "model-request" } },
    { name: "q1-ws-model-request-apikey", providers: ["openai"], model: "openai/mock-model", mode: "accounts", server: true, turns: twoTurns, env: { SPIKE_ACCOUNT_PLAN: "A,B", SPIKE_TITLE_ACCOUNT: "A", SPIKE_AUTH_VIA: "model-request" } },
    { name: "q1-ws-handshake-apikey", providers: ["openai"], model: "openai/mock-model", mode: "accounts", server: true, turns: twoTurns, env: { SPIKE_ACCOUNT_PLAN: "A,B", SPIKE_TITLE_ACCOUNT: "A", SPIKE_AUTH_VIA: "ws-handshake,http-request" } },
    // Q3: account A refuses the first agent-loop request of the turn.
    { name: "q3-http-ratelimit-reroute", providers: ["openai-http-nokey"], model: "openai/mock-model", mode: "accounts,reroute", rejects: [{ account: "A", mode: "ratelimit" }], env: { SPIKE_TITLE_ACCOUNT: "A" } },
    { name: "q3-ws-ratelimit-reroute", logLevel: "debug", server: true, providers: ["openai-nokey"], model: "openai/mock-model", mode: "accounts,reroute", rejects: [{ account: "A", mode: "ratelimit" }], env: { SPIKE_TITLE_ACCOUNT: "A" } },
    // Same refusal with no retry hook decision: what the host does on its own.
    { name: "q3-ws-ratelimit-no-retry-override", providers: ["openai-nokey"], model: "openai/mock-model", mode: "accounts", rejects: [{ account: "A", mode: "ratelimit" }], env: { SPIKE_TITLE_ACCOUNT: "A" } },
    { name: "q3-http-usage-limit-reroute", providers: ["openai-http-nokey"], model: "openai/mock-model", mode: "accounts,reroute", rejects: [{ account: "A", mode: "usage-limit" }], env: { SPIKE_TITLE_ACCOUNT: "A" } },
    { name: "q3-ws-usage-limit-reroute", providers: ["openai-nokey"], model: "openai/mock-model", mode: "accounts,reroute", rejects: [{ account: "A", mode: "usage-limit" }], env: { SPIKE_TITLE_ACCOUNT: "A" } },
    { name: "q3-ws-usage-limit-no-retry-override", providers: ["openai-nokey"], model: "openai/mock-model", mode: "accounts", rejects: [{ account: "A", mode: "usage-limit" }], env: { SPIKE_TITLE_ACCOUNT: "A" } },
    // Refusal after some text was already streamed on A.
    { name: "q3-ws-after-output-veto", providers: ["openai-nokey"], model: "openai/mock-model", mode: "accounts,reroute", rejects: [{ account: "A", mode: "after-output" }], env: { SPIKE_TITLE_ACCOUNT: "A" } },
    { name: "q3-http-after-output-veto", providers: ["openai-http-nokey"], model: "openai/mock-model", mode: "accounts,reroute", rejects: [{ account: "A", mode: "after-output" }], env: { SPIKE_TITLE_ACCOUNT: "A" } },
    { name: "q3-ws-after-output-no-retry-override", providers: ["openai-nokey"], model: "openai/mock-model", mode: "accounts", rejects: [{ account: "A", mode: "after-output" }], env: { SPIKE_TITLE_ACCOUNT: "A" } },
    // Q4: a frame rewrite in experimental.ws.send across two turns on one socket.
    { name: "q4-ws-two-turns-control", providers: ["openai-nokey"], model: "openai/mock-model", mode: "accounts", server: true, turns: twoTurns, env: { SPIKE_ACCOUNT_PLAN: "A" } },
    { name: "q4-ws-send-mark-two-turns", logLevel: "debug", providers: ["openai-nokey"], model: "openai/mock-model", mode: "accounts,ws-send-mark", server: true, turns: twoTurns, env: { SPIKE_ACCOUNT_PLAN: "A" } },
    // Q5: the host's own openai plugin with a fake ChatGPT credential stored.
    { name: "q5-host-credential-model-request", logLevel: "debug", providers: ["openai-codexmodel"], model: "openai/gpt-5.5", mode: "accounts", server: true, turns: twoTurns, seedCredential: true, env: { ...host, SPIKE_ACCOUNT_PLAN: "A,B", SPIKE_TITLE_ACCOUNT: "A", SPIKE_AUTH_VIA: "model-request" } },
    { name: "q5-host-credential-all-hooks", providers: ["openai-codexmodel"], model: "openai/gpt-5.5", mode: "accounts", server: true, turns: twoTurns, seedCredential: true, env: { ...host, SPIKE_ACCOUNT_PLAN: "A,B", SPIKE_TITLE_ACCOUNT: "A", SPIKE_AUTH_VIA: "model-request,ws-handshake,http-request" } },
    { name: "q5-builtin-removed", providers: ["openai-codexmodel"], model: "openai/gpt-5.5", mode: "accounts", server: true, turns: twoTurns, seedCredential: true, pluginOps: ["-opencode.provider.openai"], env: { ...host, SPIKE_ACCOUNT_PLAN: "A,B", SPIKE_TITLE_ACCOUNT: "A", SPIKE_AUTH_VIA: "model-request" } },
    // Q6: hooks scoped to openai must stay silent for another provider. The
    // second provider's first agent-loop request is refused once (it carries no
    // account, so the mock files it under "none") to make the retry hook fire.
    { name: "q6-hook-scoping", providers: ["openai-nokey", "mockcompat"], model: "openai/mock-model", mode: "accounts,probe", server: true, rejects: [{ account: "none", mode: "ratelimit" }], turns: [{ message: "Say hello." }, { model: "mockcompat/mock-model", message: "Say hello from the other provider." }], env: { SPIKE_ACCOUNT_PLAN: "A" } },
];

// The earlier transport spike's scenarios (provider selection, AI SDK hooks,
// HTTP/WebSocket redirects, retries), kept runnable with --first-spike.
const firstSpikeScenarios = [
    // Q4e / baseline: which transport and hooks does the default openai path use?
    { name: "openai-default-observe", providers: ["openai"], model: "openai/mock-model", mode: "observe,sdk,language,retry-observe" },
    { name: "openai-http-observe", providers: ["openai-http"], model: "openai/mock-model", mode: "observe,sdk,language,retry-observe" },
    { name: "compat-observe", providers: ["mockcompat"], model: "mockcompat/mock-model", mode: "observe,sdk,language,retry-observe" },
    { name: "explicit-aisdk-prefix", providers: ["explicitaisdk"], model: "explicitaisdk/mock-model", mode: "observe,sdk,language" },
    // Q4a: plugin-supplied SDK with its own fetch (forwarding, then self-answering).
    // An aisdk: npm name the host cannot resolve locally: its built-in dynamic
    // sdk hook runs before any plugin's and tries to npm-install it.
    { name: "unmapped-npm-sdk-hook", providers: ["unmappednpm"], model: "unmappednpm/mock-model", mode: "observe,sdk", timeoutMs: 180_000 },
    // The file:// factory alone (no plugin sdk hook), forwarding to the host fetch.
    { name: "file-factory-forward", providers: ["customaisdk"], model: "customaisdk/mock-model", mode: "observe" },
    // The file:// factory answering from its own fetch; the mock must see nothing.
    { name: "file-factory-synth", providers: ["customaisdk"], model: "customaisdk/mock-model", mode: "observe", env: { SPIKE_SYNTH: "1" } },
    // The plugin's sdk hook replacing the SDK the factory already produced.
    { name: "file-factory-sdk-hook-override", providers: ["customaisdk"], model: "customaisdk/mock-model", mode: "observe,sdk", env: { SPIKE_SYNTH: "1" } },
    // Q4b: wrapping LanguageModelV3.
    { name: "file-factory-language", providers: ["customaisdk"], model: "customaisdk/mock-model", mode: "observe,sdk,language", env: { SPIKE_SYNTH: "1" } },
    // Q4a on the openai provider itself: can a plugin move openai onto its own SDK?
    { name: "openai-forced-aisdk-synth", providers: ["openai"], model: "openai/mock-model", mode: "observe,force-aisdk,sdk,language", env: { SPIKE_SYNTH: "1" } },
    // Q4c: http.response body replacement; http.request redirect.
    { name: "openai-http-replace", providers: ["openai-http"], model: "openai/mock-model", mode: "observe,http-replace" },
    { name: "compat-http-replace", providers: ["mockcompat"], model: "mockcompat/mock-model", mode: "observe,http-replace" },
    { name: "openai-ws-http-replace", providers: ["openai"], model: "openai/mock-model", mode: "observe,http-replace" },
    { name: "openai-http-redirect", providers: ["openai-http"], model: "openai/mock-model", mode: "observe,http-redirect", redirect: true },
    { name: "openai-ws-handshake-redirect", providers: ["openai"], model: "openai/mock-model", mode: "observe,ws-redirect", redirect: true },
    // Host-native WebSocket continuation across two turns of one session.
    { name: "openai-ws-two-turns", providers: ["openai"], model: "openai/mock-model", mode: "observe", followUp: true },
    // Q4d: retry decisions after a stream error.
    { name: "openai-http-retry-observe", providers: ["openai-http"], model: "openai/mock-model", mode: "observe,retry-observe", failures: 1, failMode: "stream-cut" },
    { name: "openai-http-retry-false", providers: ["openai-http"], model: "openai/mock-model", mode: "observe,retry-false", failures: 1, failMode: "stream-cut" },
    { name: "compat-retry-500-observe", providers: ["mockcompat"], model: "mockcompat/mock-model", mode: "observe,retry-observe", failures: 1, failMode: "500" },
    { name: "compat-retry-500-false", providers: ["mockcompat"], model: "mockcompat/mock-model", mode: "observe,retry-false", failures: 1, failMode: "500" },
    { name: "openai-ws-retry-observe", providers: ["openai"], model: "openai/mock-model", mode: "observe,retry-observe", failures: 1 },
    { name: "file-factory-retry-false", providers: ["customaisdk"], model: "customaisdk/mock-model", mode: "observe,retry-false", failures: 1, failMode: "500" },
    { name: "openai-ws-retry-false", providers: ["openai"], model: "openai/mock-model", mode: "observe,retry-false", failures: 1 },
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
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
        // Any outbound request that is not to the loopback mock goes to a dead
        // proxy port, so a misrouted request fails instead of reaching the internet.
        HTTP_PROXY: "http://127.0.0.1:9",
        HTTPS_PROXY: "http://127.0.0.1:9",
        http_proxy: "http://127.0.0.1:9",
        https_proxy: "http://127.0.0.1:9",
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
        // A fixed loopback-only password for server-mode scenarios: the server
        // reads the first, the `run --server` client sends the second.
        OPENCODE_SERVER_PASSWORD: "spike-loopback-only",
        OPENCODE_PASSWORD: "spike-loopback-only",
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

async function waitForServer(url, child, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`server exited early with ${child.exitCode}`);
        try {
            await fetch(url, { signal: AbortSignal.timeout(1000) });
            return;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }
    throw new Error(`server at ${url} did not start`);
}

async function runScenario(scenario) {
    // Outside the repository so the host cannot pick up any ancestor config.
    const root = join(tmpdir(), "oc2-thin-spike", scenario.name);
    rmSync(root, { recursive: true, force: true });
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: project });
    const mockLog = join(root, "mock.jsonl");
    const pluginLog = join(root, "plugin.jsonl");
    writeFileSync(mockLog, "");
    writeFileSync(pluginLog, "");
    const mock = await startMock({ log: mockLog, failures: scenario.failures ?? 0, failMode: scenario.failMode, rejects: scenario.rejects });
    // A second mock stands in for an endpoint the plugin would own; the
    // redirect scenarios point the host's HTTP request or WebSocket at it.
    const redirectLog = join(root, "redirect-target.jsonl");
    const redirect = scenario.redirect ? await startMock({ log: redirectLog }) : undefined;

    const env = isolatedEnv(root, {
        SPIKE_PLUGIN_LOG: pluginLog,
        SPIKE_MODE: scenario.mode,
        ...(redirect ? { SPIKE_REDIRECT_URL: redirect.url } : {}),
        ...Object.fromEntries(Object.entries(scenario.env ?? {}).map(([key, value]) => [key, value.replace("<mock>", mock.url)])),
    });
    const config = {
        $schema: "https://opencode.ai/config.json",
        plugins: [...(scenario.pluginOps ?? []), pluginDir],
        providers: providers(mock.url, scenario.providers),
    };
    mkdirSync(join(env.XDG_CONFIG_HOME, "opencode"), { recursive: true });
    writeFileSync(join(env.XDG_CONFIG_HOME, "opencode", "opencode.json"), JSON.stringify(config, null, 2));

    // Server mode keeps one host process alive across every turn of the scenario.
    let server;
    let serverStderr = "";
    let serverURL;
    const startServer = async () => {
        const port = await freePort();
        serverURL = `http://127.0.0.1:${port}`;
        server = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", scenario.logLevel ?? "info"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
        server.stdout.on("data", (d) => (serverStderr += d));
        server.stderr.on("data", (d) => (serverStderr += d));
        await waitForServer(serverURL, server);
    };
    const stopServer = async () => {
        const closed = new Promise((resolve) => server.on("close", resolve));
        server.kill("SIGTERM");
        const timer = setTimeout(() => server.kill("SIGKILL"), 10_000);
        await closed;
        clearTimeout(timer);
    };
    if (scenario.server) await startServer();
    if (scenario.seedCredential) {
        // The first start created the host database. Store the fake ChatGPT
        // credential while the host is down, then start it again so the host's
        // openai plugin reads the credential during its setup.
        await stopServer();
        const rows = seedCredential(join(env.XDG_DATA_HOME, "opencode", "opencode.db"));
        serverStderr += `\n----- spike: seeded credential rows ${JSON.stringify(rows)}; restarting server -----\n`;
        await startServer();
    }

    const invoke = (extra, message, model = scenario.model) =>
        new Promise((resolve) => {
            const target = serverURL ? ["--server", serverURL] : ["--standalone", "--print-logs", "--log-level", scenario.logLevel ?? "info"];
            const args = ["run", ...target, "--format", "json", "--model", model, ...extra, message];
            const child = spawn(cli, args, { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (d) => (stdout += d));
            child.stderr.on("data", (d) => (stderr += d));
            const timer = setTimeout(() => child.kill("SIGKILL"), scenario.timeoutMs ?? 90_000);
            child.on("close", (code, signal) => {
                clearTimeout(timer);
                resolve({ code, signal, stdout, stderr });
            });
        });
    const started = Date.now();
    const turns = scenario.turns ?? [{ message: "Say hello." }, ...(scenario.followUp ? [{ args: ["--continue"], message: "Say it again." }] : [])];
    let result;
    const exits = [];
    for (const [index, turn] of turns.entries()) {
        const next = await invoke(turn.args ?? [], turn.message, turn.model);
        exits.push(next.code);
        result = result
            ? { code: next.code, signal: next.signal, stdout: `${result.stdout}${next.stdout}`, stderr: `${result.stderr}\n----- turn ${index + 1} -----\n${next.stderr}` }
            : next;
    }
    if (server) {
        await stopServer();
        result.stderr = `----- server -----\n${serverStderr}\n----- client -----\n${result.stderr}`;
    }
    await mock.close();
    await redirect?.close();

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
    writeFileSync(join(out, "mock.jsonl"), scrub(readFileSync(mockLog, "utf8")));
    writeFileSync(join(out, "plugin.jsonl"), scrub(readFileSync(pluginLog, "utf8")));
    if (existsSync(redirectLog)) writeFileSync(join(out, "redirect-target.jsonl"), scrub(readFileSync(redirectLog, "utf8")));
    writeFileSync(join(out, "config.json"), scrub(JSON.stringify(config, null, 2)));
    writeFileSync(join(out, "stdout.jsonl"), scrub(result.stdout));
    writeFileSync(join(out, "stderr.log"), scrub(result.stderr).slice(-300_000));
    const summary = {
        scenario: scenario.name,
        mode: scenario.mode,
        model: scenario.model,
        exit: result.code,
        turnExits: exits,
        signal: result.signal,
        ms: Date.now() - started,
        mockRequests: readFileSync(mockLog, "utf8").split("\n").filter(Boolean).length,
        pluginEvents: readFileSync(pluginLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).event),
    };
    writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary));
}

const argv = process.argv.slice(2);
const wanted = new Set(argv.filter((arg) => !arg.startsWith("--")));
const all = argv.includes("--first-spike") ? [...scenarios, ...firstSpikeScenarios] : scenarios;
for (const scenario of all) {
    if (wanted.size > 0 && !wanted.has(scenario.name)) continue;
    await runScenario(scenario);
}
