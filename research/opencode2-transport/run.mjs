// Runs each spike scenario against the locally installed @opencode/cli with a
// throwaway HOME and XDG roots, a local mock provider, and the probe plugin.
// Evidence (plugin hook log, mock request log, CLI stdout/stderr) is copied to
// evidence/<scenario>/ so it can be reviewed without re-running anything.
//
// Usage: node run.mjs [scenario-name ...]   (no names = every scenario)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startMock } from "./mock-server.mjs";

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
        // "openai-http" is the openai provider with transport forced to http.
        if (id === "openai-http") picked.openai = all["openai-http"];
        else picked[id] = all[id];
    }
    return picked;
};

const scenarios = [
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
        ...extra,
    };
    for (const key of ["home", "xdg-config", "xdg-data", "xdg-state", "xdg-cache", "tmp"]) mkdirSync(join(root, key), { recursive: true });
    return env;
}

async function runScenario(scenario) {
    // Outside the repository so the host cannot pick up any ancestor config.
    const root = join(tmpdir(), "oc2-transport-spike", scenario.name);
    rmSync(root, { recursive: true, force: true });
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: project });
    const mockLog = join(root, "mock.jsonl");
    const pluginLog = join(root, "plugin.jsonl");
    writeFileSync(mockLog, "");
    writeFileSync(pluginLog, "");
    const mock = await startMock({ log: mockLog, failures: scenario.failures ?? 0, failMode: scenario.failMode });
    // A second mock stands in for an endpoint the plugin would own; the
    // redirect scenarios point the host's HTTP request or WebSocket at it.
    const redirectLog = join(root, "redirect-target.jsonl");
    const redirect = scenario.redirect ? await startMock({ log: redirectLog }) : undefined;

    const env = isolatedEnv(root, {
        SPIKE_PLUGIN_LOG: pluginLog,
        SPIKE_MODE: scenario.mode,
        ...(redirect ? { SPIKE_REDIRECT_URL: redirect.url } : {}),
        ...scenario.env,
    });
    const config = {
        $schema: "https://opencode.ai/config.json",
        plugins: [pluginDir],
        providers: providers(mock.url, scenario.providers),
    };
    mkdirSync(join(env.XDG_CONFIG_HOME, "opencode"), { recursive: true });
    writeFileSync(join(env.XDG_CONFIG_HOME, "opencode", "opencode.json"), JSON.stringify(config, null, 2));

    const invoke = (extra, message) =>
        new Promise((resolve) => {
            const args = ["run", "--standalone", "--print-logs", "--log-level", "info", "--format", "json", "--model", scenario.model, ...extra, message];
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
    let result = await invoke([], "Say hello.");
    if (scenario.followUp) {
        const second = await invoke(["--continue"], "Say it again.");
        result = {
            code: second.code,
            signal: second.signal,
            stdout: `${result.stdout}${second.stdout}`,
            stderr: `${result.stderr}\n----- second turn -----\n${second.stderr}`,
        };
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
        signal: result.signal,
        ms: Date.now() - started,
        mockRequests: readFileSync(mockLog, "utf8").split("\n").filter(Boolean).length,
        pluginEvents: readFileSync(pluginLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).event),
    };
    writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary));
}

const wanted = new Set(process.argv.slice(2));
for (const scenario of scenarios) {
    if (wanted.size > 0 && !wanted.has(scenario.name)) continue;
    await runScenario(scenario);
}
