// Measures, against the REAL ChatGPT Codex backend, whether a system line
// asking the model to start each text reply with its own "§N§ " tag makes the
// assistant text Magic Context replays equal the model's raw output, and so
// lets OpenCode 2 continue a WebSocket session incrementally
// (previous_response_id plus only the new input items) instead of resending
// the whole history.
//
// Same rig as ../opencode2-mc582/run.mjs: @opencode/cli 2.0.20 in server mode
// with a throwaway HOME, XDG roots, TMPDIR, OPENCODE_DB, OPENCODE_CONFIG_DIR
// and MAGIC_CONTEXT_STORAGE_DIR under $TMPDIR; only the live ChatGPT access
// token is seeded (see seed-credential.mjs); the host's built-in
// opencode.provider.openai plugin serves the login with its native driver
// over WebSocket. Magic Context is loaded in both variants.
//
//   node run.mjs A [prompt ...]   variant A: no extra system line
//   node run.mjs C [prompt ...]   variant C: the self-tag line appended
//   (RUN_NAME names the evidence directory; default variant-A / variant-C.
//    Without prompts the fixed four-turn fixture below is used.)
//
// Raw logs stay under the throwaway root. evidence/<name>/ gets scrubbed
// copies: no token, no account id, no JWT-shaped string, reasoning
// encrypted content replaced by its length and hash, home paths replaced.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VARIANT_C_LINE } from "./plugin-selftag/line.js";
import { readLiveAccess, seedCredential } from "./seed-credential.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// The previous run's throwaway install of @opencode/cli 2.0.20, reused as is.
// The host binary and both plugins run from under $TMPDIR, not from this
// checkout: the checkout lives under the real home's cortexkit directory
// (agent worktrees do), and the lsof isolation proof must show no open file
// anywhere under that directory.
const DEPS = join(tmpdir(), "oc2-mc582-deps");
const cli = join(DEPS, "node_modules", ".bin", "opencode2");
if (!existsSync(cli)) throw new Error(`no OpenCode 2 install at ${DEPS}; run ../opencode2-mc582/run.mjs once to create it`);
const cliVersion = JSON.parse(readFileSync(join(DEPS, "node_modules", "@opencode", "cli", "package.json"), "utf8")).version;
if (cliVersion !== "2.0.20") throw new Error(`expected @opencode/cli 2.0.20 at ${DEPS}, found ${cliVersion}`);
const REAL_HOME = homedir();
const MC_REPO = join(REAL_HOME, "Work/Projects/CortexKit/magic-context");
const MC_PLUGIN = join(MC_REPO, "packages/plugin");
const MODEL = process.env.SPIKE_MODEL ?? "gpt-5.6-luna";
const EFFORT = process.env.SPIKE_EFFORT ?? "low";
const PASSWORD = "spike-mc582-loopback-only";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The fixed fixture: tool loops in every turn but the last, and replies that
// mix a short sentence with parallel tool calls (turns 1 and 2).
const FIXTURE_PROMPTS = [
    "Write one short sentence saying what you are about to do, then in the same reply call the shell tool twice in parallel: `echo alpha` and `echo beta`. After both results arrive, reply with one short sentence.",
    "Now write one short sentence, then in the same reply read fixture.txt and notes.txt in parallel with the read tool. After both results arrive, tell me in one sentence how many apples fixture.txt lists.",
    "Run `echo gamma` with the shell tool, then reply with one short sentence.",
    "Thanks.",
];
const FIXTURE_FILES = { "fixture.txt": "apples: 3\npears: 5\n", "notes.txt": "These notes are only here to be read.\n" };

const [variant, ...givenPrompts] = process.argv.slice(2);
if (!["A", "C"].includes(variant)) {
    console.error('usage: node run.mjs A|C ["prompt" ...]');
    process.exit(2);
}
const prompts = givenPrompts.length ? givenPrompts : FIXTURE_PROMPTS;
const name = process.env.RUN_NAME ?? `variant-${variant}`;

// The self-tag instruction this run appends must be exactly the one Magic
// Context's own trial used (its plan file and its OpenCode 1 wrapper), so the
// results here are comparable with that trial.
const planLine = readFileSync(join(MC_REPO, ".cortexkit/alfonso/plans/issue-582-variant-c.md"), "utf8")
    .split("\n")
    .find((line) => line.startsWith("> Every user message"))
    ?.slice(2);
const wrapperLine = /const instructionC =\s*'([^']*)';/.exec(readFileSync(join(MC_PLUGIN, "scripts/self-tag-trial/host-plugin.mjs"), "utf8"))?.[1];
if (planLine !== VARIANT_C_LINE || wrapperLine !== VARIANT_C_LINE) throw new Error("plugin-selftag/line.js differs from the variant C line in the plan or in host-plugin.mjs");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const git = (...args) => spawnSync("git", ["-C", MC_REPO, ...args], { encoding: "utf8" }).stdout.trim();
const magicContext = {
    branch: git("branch", "--show-current"),
    commit: git("rev-parse", "HEAD"),
    dirty: git("status", "--short", "--", "packages/plugin") !== "",
    version: JSON.parse(readFileSync(join(MC_PLUGIN, "package.json"), "utf8")).version,
    distMtime: statSync(join(MC_PLUGIN, "dist/index.js")).mtime.toISOString(),
    lastSrcCommit: git("log", "-1", "--format=%cI", "--", "packages/plugin/src"),
};
if (magicContext.branch !== "master") throw new Error(`magic-context checkout is on ${magicContext.branch}, not master`);

const live = readLiveAccess(join(REAL_HOME, ".local/share/opencode/auth.json"));
if (live.expires < Date.now() + 3_600_000) throw new Error("live access token expires within the hour; refusing to run (the host would try to refresh)");

const root = join(tmpdir(), "oc2-mc582-selftag", name);
rmSync(root, { recursive: true, force: true });
const dirs = Object.fromEntries(["home", "xdg-config", "xdg-data", "xdg-state", "xdg-cache", "xdg-runtime", "tmp", "mc-store", "project", "raw"].map((key) => [key, join(root, key)]));
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
for (const [file, text] of Object.entries(FIXTURE_FILES)) writeFileSync(join(dirs.project, file), text);
const dbPath = join(dirs["xdg-data"], "opencode", "opencode.db");
mkdirSync(dirname(dbPath), { recursive: true });
const logs = { observer: join(dirs.raw, "observer.jsonl"), harness: join(dirs.raw, "harness.jsonl"), capture: join(dirs.raw, "capture.jsonl") };
const harness = (event, data = {}) => writeFileSync(logs.harness, `${JSON.stringify({ wall: Date.now(), event, ...data })}\n`, { flag: "a" });

// Only PATH is inherited. No outbound proxy: this run talks to the real
// backend on purpose.
const env = {
    PATH: process.env.PATH,
    HOME: dirs.home,
    XDG_CONFIG_HOME: dirs["xdg-config"],
    XDG_DATA_HOME: dirs["xdg-data"],
    XDG_STATE_HOME: dirs["xdg-state"],
    XDG_CACHE_HOME: dirs["xdg-cache"],
    XDG_RUNTIME_DIR: dirs["xdg-runtime"],
    TMPDIR: dirs.tmp,
    OPENCODE_DB: dbPath,
    OPENCODE_CONFIG_DIR: join(dirs["xdg-config"], "opencode"),
    MAGIC_CONTEXT_STORAGE_DIR: dirs["mc-store"],
    MAGIC_CONTEXT_LOG_PATH: join(dirs.raw, "magic-context.log"),
    OPENCODE_SERVER_PASSWORD: PASSWORD,
    SPIKE_OBSERVER_LOG: logs.observer,
    SELF_TAG_VARIANT: variant,
    SELF_TAG_CAPTURE: logs.capture,
};

// Plugin order matters: the self-tag plugin's "context" callback must run
// after Magic Context's, and the host runs callbacks in registration order.
// capture.jsonl records, per request, whether Magic Context's guidance was
// already in the system text when the self-tag callback ran.
const config = {
    $schema: "https://opencode.ai/config.json",
    plugins: [join(root, "plugin-observer"), MC_PLUGIN, join(root, "plugin-selftag")],
    providers: {
        openai: {
            models: { [MODEL]: { name: MODEL, settings: { reasoningEffort: EFFORT } } },
        },
    },
};
for (const plugin of ["plugin-observer", "plugin-selftag"]) cpSync(join(here, plugin), join(root, plugin), { recursive: true });
mkdirSync(env.OPENCODE_CONFIG_DIR, { recursive: true });
writeFileSync(join(env.OPENCODE_CONFIG_DIR, "opencode.json"), JSON.stringify(config, null, 2));
// Magic Context's own config, as in the previous run. Tagging stays at its
// defaults (on whenever compaction is enabled, TypeScript transform). The
// historian and dreamer are turned off because they make background model
// calls, local embeddings because they download a model, and update checks
// because they reach the network, so the only model requests are the
// session's own.
const mcConfig = { historian: { disable: true }, dreamer: { disable: true }, embedding: { provider: "off" }, auto_update: false };
mkdirSync(join(dirs["xdg-config"], "cortexkit"), { recursive: true });
writeFileSync(join(dirs["xdg-config"], "cortexkit", "magic-context.jsonc"), JSON.stringify(mcConfig, null, 2));

const freePort = () =>
    new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });

let server;
let serverLog = "";
let serverURL;
const startServer = async () => {
    const port = await freePort();
    serverURL = `http://127.0.0.1:${port}`;
    server = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "debug"], { cwd: dirs.project, env, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", (d) => (serverLog += d));
    server.stderr.on("data", (d) => (serverLog += d));
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        if (server.exitCode !== null) throw new Error(`server exited early with ${server.exitCode}\n${serverLog.slice(-3000)}`);
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

// The host process plus all its descendants (the npm bin may be a wrapper).
const processTree = (pid) => {
    const out = [pid];
    const children = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).map(Number);
    for (const child of children) out.push(...processTree(child));
    return out;
};
// Isolation proof: lists every open file of the host process tree and counts
// those under the real home's opencode / cortexkit directories, where the
// operator's live OpenCode data and Magic Context stores live. The count must
// be zero.
const lsofSnapshot = (label) => {
    const pids = processTree(server.pid);
    const full = spawnSync("lsof", ["-n", "-P", "-p", pids.join(",")], { encoding: "utf8" }).stdout;
    const forbidden = [".config/opencode", ".local/share/opencode", ".config/cortexkit", ".local/share/cortexkit", ".cache/opencode", ".local/state/opencode"].map((p) => join(REAL_HOME, p));
    const hits = full.split("\n").filter((line) => forbidden.some((p) => line.includes(p)));
    harness("lsof", { label, pids, lines: full.split("\n").length, forbiddenHits: hits.length });
    writeFileSync(join(dirs.raw, `lsof-${label}.txt`), `# pids ${pids.join(",")}\n# forbidden prefixes: ${forbidden.join(" ")}\n# forbidden hits: ${hits.length}\n${hits.join("\n")}\n# ---- full lsof ----\n${full}`);
};

await startServer();
// The first start created the database; seed the credential while the host
// is down, then start again so the built-in openai plugin reads it in setup.
await stopServer();
harness("seeded", { rows: await seedCredential(DEPS, dbPath, live) });
await startServer();

const auth = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`;
const call = async (method, path, body, timeoutMs = 300_000) => {
    const response = await fetch(`${serverURL}${path}`, {
        method,
        headers: { authorization: auth, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    harness("api", { method, path, status: response.status, body: text.slice(0, 400) });
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
};

let error;
let sid;
try {
    let created = await call("POST", "/api/session", { model: { providerID: "openai", id: MODEL } });
    for (let attempt = 0; attempt < 50 && created?.code === "service_starting"; attempt += 1) {
        await sleep(200);
        created = await call("POST", "/api/session", { model: { providerID: "openai", id: MODEL } });
    }
    sid = created.data.id;
    for (const [index, text] of prompts.entries()) {
        harness("turn-start", { turn: index + 1, text });
        await call("POST", `/api/session/${sid}/prompt`, { text });
        if (index === 0) {
            await sleep(1500);
            lsofSnapshot("during-turn-1");
        }
        await call("POST", `/api/experimental/session/${sid}/wait`);
        harness("turn-end", { turn: index + 1 });
    }
} catch (caught) {
    error = String(caught?.stack ?? caught);
    harness("steps-failed", { error });
}
await sleep(500);
let messages;
try {
    messages = sid ? (await call("GET", `/api/session/${sid}/message?limit=200&order=asc`)).data : undefined;
} catch (caught) {
    messages = String(caught);
}
lsofSnapshot("end");
await stopServer();
writeFileSync(join(dirs.raw, "messages.json"), JSON.stringify(messages, null, 2));
writeFileSync(join(dirs.raw, "server.log"), serverLog);

// ---- scrubbed evidence ----
const secrets = [live.access, live.accountID];
const redactBlob = (value) => `<redacted ${value.length} chars sha256:${sha256(value).slice(0, 16)}>`;
const scrub = (text) => {
    // Opaque server blobs: reasoning content, under both the wire key and the
    // host's stored key, and the backend's per-turn state header. Equal values
    // keep equal hashes, so the offline continuation check still works.
    let out = text.replace(/"(encrypted_content|reasoningEncryptedContent|x-codex-turn-state)":\s*"([^"]*)"/g, (_, key, value) => `"${key}":"${redactBlob(value)}"`);
    for (const secret of secrets) out = out.replaceAll(secret, "<redacted-secret>");
    // Any JWT-shaped run (base64url of '{"'). Built from pieces so this file
    // itself passes the repository's grep for that prefix.
    out = out.replace(new RegExp(`${"ey"}J[A-Za-z0-9_\\-.]*`, "g"), "<redacted-jwt>");
    out = out.replace(/("?(?:authorization|chatgpt-account-id)"?\s*[:=]\s*"?)[^",}\s]+/gi, "$1<redacted>");
    for (const path of [realpathSync(root), root]) out = out.replaceAll(path, "<run>");
    for (const path of [realpathSync(DEPS), DEPS]) out = out.replaceAll(path, "<deps>");
    out = out.replaceAll(here, "<spike>").replaceAll(REAL_HOME, "<home>");
    return out;
};
const out = join(here, "evidence", name);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const file of ["observer.jsonl", "capture.jsonl", "harness.jsonl", "messages.json", "server.log", "lsof-during-turn-1.txt", "lsof-end.txt"]) {
    const source = join(dirs.raw, file);
    if (existsSync(source)) writeFileSync(join(out, file), scrub(readFileSync(source, "utf8")));
}
writeFileSync(
    join(out, "config.json"),
    scrub(
        JSON.stringify(
            {
                opencode: config,
                opencodeCli: cliVersion,
                magicContext,
                magicContextConfig: mcConfig,
                variantCLine: variant === "C" ? { text: VARIANT_C_LINE, sha256: sha256(VARIANT_C_LINE), equalsPlan: true, equalsHostPluginInstructionC: true } : null,
                env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, k === "OPENCODE_SERVER_PASSWORD" ? "<local>" : v])),
            },
            null,
            2,
        ),
    ),
);
const summary = { name, variant, model: MODEL, effort: EFFORT, prompts, error, sessionID: sid };
writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary));
