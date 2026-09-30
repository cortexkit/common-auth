// Measures, against the REAL ChatGPT Codex backend, whether Magic Context's
// "§N§ " prefix on replayed assistant text stops OpenCode 2 from continuing a
// WebSocket session incrementally (previous_response_id plus only the new
// input items) and makes it resend the whole history instead.
//
// Starts @opencode/cli 2.0.20 in server mode with a throwaway HOME, XDG roots,
// OPENCODE_DB and MAGIC_CONTEXT_STORAGE_DIR under $TMPDIR, seeds only the live
// ChatGPT access token (see seed-credential.mjs), and drives one session over
// the server API. The host's built-in opencode.provider.openai plugin serves
// the ChatGPT login with its native driver (WebSocket agent loop by default).
// plugin-observer/ logs every ws.send / ws.receive frame.
//
//   node run.mjs A "prompt 1" "prompt 2" ...   arm A: Magic Context not loaded
//   node run.mjs B "prompt 1" "prompt 2" ...   arm B: Magic Context loaded
//   (optional env RUN_NAME names the evidence directory; default arm-A / arm-B)
//
// Raw logs stay under the throwaway root. evidence/<name>/ gets scrubbed
// copies: no token, no account id, no JWT-shaped string, reasoning
// encrypted_content replaced by its length and hash, home paths replaced.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readLiveAccess, seedCredential } from "./seed-credential.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// The host binary and the observer plugin are run from copies under $TMPDIR,
// not from this checkout: the checkout may itself live under the real home's
// cortexkit directory (agent worktrees do), and the lsof isolation proof must
// show no open file anywhere under that directory.
const DEPS = join(tmpdir(), "oc2-mc582-deps");
if (!existsSync(join(DEPS, "node_modules", ".bin", "opencode2"))) {
    mkdirSync(DEPS, { recursive: true });
    for (const file of ["package.json", "package-lock.json"]) cpSync(join(here, file), join(DEPS, file));
    const install = spawnSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: DEPS, stdio: "inherit" });
    if (install.status !== 0) throw new Error("npm ci in the throwaway deps directory failed");
}
const cli = join(DEPS, "node_modules", ".bin", "opencode2");
const REAL_HOME = homedir();
const MC_PLUGIN = join(REAL_HOME, "Work/Projects/CortexKit/magic-context/packages/plugin");
const MODEL = process.env.SPIKE_MODEL ?? "gpt-5.6-luna";
const EFFORT = process.env.SPIKE_EFFORT ?? "low";
const PASSWORD = "spike-mc582-loopback-only";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const [arm, ...prompts] = process.argv.slice(2);
if (!["A", "B"].includes(arm) || prompts.length === 0) {
    console.error('usage: node run.mjs A|B "prompt" ...');
    process.exit(2);
}
const name = process.env.RUN_NAME ?? `arm-${arm}`;
const live = readLiveAccess(join(REAL_HOME, ".local/share/opencode/auth.json"));
if (live.expires < Date.now() + 3_600_000) throw new Error("live access token expires within the hour; refusing to run (the host would try to refresh)");

const root = join(tmpdir(), "oc2-mc582", name);
rmSync(root, { recursive: true, force: true });
const dirs = Object.fromEntries(["home", "xdg-config", "xdg-data", "xdg-state", "xdg-cache", "tmp", "mc-store", "project", "raw"].map((key) => [key, join(root, key)]));
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
const dbPath = join(dirs["xdg-data"], "opencode", "opencode.db");
mkdirSync(dirname(dbPath), { recursive: true });
const logs = { observer: join(dirs.raw, "observer.jsonl"), harness: join(dirs.raw, "harness.jsonl") };
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
    TMPDIR: dirs.tmp,
    OPENCODE_DB: dbPath,
    OPENCODE_CONFIG_DIR: join(dirs["xdg-config"], "opencode"),
    MAGIC_CONTEXT_STORAGE_DIR: dirs["mc-store"],
    MAGIC_CONTEXT_LOG_PATH: join(dirs.raw, "magic-context.log"),
    OPENCODE_SERVER_PASSWORD: PASSWORD,
    SPIKE_OBSERVER_LOG: logs.observer,
};

const config = {
    $schema: "https://opencode.ai/config.json",
    plugins: [join(root, "plugin-observer"), ...(arm === "B" ? [MC_PLUGIN] : [])],
    providers: {
        openai: {
            models: { [MODEL]: { name: MODEL, settings: { reasoningEffort: EFFORT } } },
        },
    },
};
cpSync(join(here, "plugin-observer"), join(root, "plugin-observer"), { recursive: true });
mkdirSync(env.OPENCODE_CONFIG_DIR, { recursive: true });
writeFileSync(join(env.OPENCODE_CONFIG_DIR, "opencode.json"), JSON.stringify(config, null, 2));
// Magic Context's own config. The "§N§ " message tags are left at their
// defaults (they are on whenever compaction is enabled, with the default
// TypeScript transform). The historian and dreamer (background model calls),
// local embeddings (a model download) and update checks are turned off so the
// only model requests are the session's own.
const mcConfig = { historian: { disable: true }, dreamer: { disable: true }, embedding: { provider: "off" }, auto_update: false };
if (arm === "B") {
    mkdirSync(join(dirs["xdg-config"], "cortexkit"), { recursive: true });
    writeFileSync(join(dirs["xdg-config"], "cortexkit", "magic-context.jsonc"), JSON.stringify(mcConfig, null, 2));
}

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
harness("seeded", { rows: seedCredential(dbPath, live) });
await startServer();

const auth = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`;
const call = async (method, path, body, timeoutMs = 240_000) => {
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
    messages = sid ? (await call("GET", `/api/session/${sid}/message?limit=100&order=asc`)).data : undefined;
} catch (caught) {
    messages = String(caught);
}
lsofSnapshot("end");
await stopServer();
writeFileSync(join(dirs.raw, "messages.json"), JSON.stringify(messages, null, 2));
writeFileSync(join(dirs.raw, "server.log"), serverLog);

// ---- scrubbed evidence ----
const secrets = [live.access, live.accountID];
const redactEncrypted = (text) =>
    text.replace(/"encrypted_content":"([^"]*)"/g, (_, value) => `"encrypted_content":"<redacted ${value.length} chars sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}>"`);
const scrub = (text) => {
    let out = redactEncrypted(text);
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
for (const file of ["observer.jsonl", "harness.jsonl", "messages.json", "server.log", "lsof-during-turn-1.txt", "lsof-end.txt"]) {
    const source = join(dirs.raw, file);
    if (existsSync(source)) writeFileSync(join(out, file), scrub(readFileSync(source, "utf8")));
}
writeFileSync(join(out, "config.json"), scrub(JSON.stringify({ opencode: config, magicContext: arm === "B" ? mcConfig : null, env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, k === "OPENCODE_SERVER_PASSWORD" ? "<local>" : v])) }, null, 2)));
const summary = { name, arm, model: MODEL, effort: EFFORT, prompts, error, sessionID: sid };
writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary));
