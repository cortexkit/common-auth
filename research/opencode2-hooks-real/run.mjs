// Run from a temporary copy so the host and measurement process never keep
// files open inside the operator's CortexKit data directory. Raw evidence and
// access-only credentials stay in the temporary root; refresh tokens are never
// copied. The report embeds selected scrubbed evidence to respect its file fence.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const here = dirname(fileURLToPath(import.meta.url));
const parse = text => { try { return JSON.parse(text); } catch { return undefined; } };
const forbiddenPaths = home => ['.config/opencode', '.local/share/opencode', '.config/cortexkit', '.local/share/cortexkit', '.cache/opencode', '.local/state/opencode', '.cache/cortexkit', '.local/state/cortexkit'].map(p => join(home, p));
const isolationHits = (text, home) => text.split('\n').filter(x => forbiddenPaths(home).some(p => x.includes(p)));
const scrubSecrets = (text, secrets) => {
  for (const secret of secrets) text = text.replaceAll(secret, '<redacted>');
  text = text.replace(new RegExp('ey' + 'J[A-Za-z0-9_.-]*', 'g'), '<redacted-jwt>');
  text = text.replace(/("(?:encrypted_content|reasoningEncryptedContent)"\s*:\s*")[^"]*"/g, '$1<redacted>"');
  return text.replace(/("?(?:authorization|chatgpt-account-id)"?\s*[:=]\s*")[^"]*"/gi, '$1<redacted>"');
};
async function selfTest() {
  const { default: test } = await import('node:test');
  const { default: assert } = await import('node:assert/strict');
  await test('isolation fence detects real config/data descriptors', () => {
    const home = '/operator';
    for (const path of forbiddenPaths(home)) assert.equal(isolationHits(`node 12 cwd ${path}/file`, home).length, 1);
    assert.equal(isolationHits('node 12 cwd /tmp/isolated/project', home).length, 0);
  });
  await test('scrubber removes both account identities and bearer credentials', () => {
    const jwt = 'ey' + 'Jexample.payload.signature';
    const text = JSON.stringify({ authorization: 'Bearer secret-token', 'chatgpt-account-id': 'account-a', arbitrary: jwt, second: 'account-b' });
    const scrubbed = scrubSecrets(text, ['secret-token', 'account-a', 'account-b']);
    for (const secret of ['secret-token', 'account-a', 'account-b', jwt]) assert.ok(!scrubbed.includes(secret));
    assert.match(scrubbed, /redacted-jwt/);
  });
}

export default {
  id: 'cortexkit.spike.hooks-real',
  async setup(context) {
    // The launcher reads the live files once with node -e, closes them, and sends
    // only access credentials in the child's environment (never refresh tokens).
    const accounts = JSON.parse(process.env.HOOKS_ACCOUNTS);
    delete process.env.HOOKS_ACCOUNTS;
    const log = (event, data = {}) => appendFileSync(process.env.HOOKS_LOG, JSON.stringify({ wall: Date.now(), event, ...data }) + '\n');
    const current = new Map();
    const limited = new Set();
    const key = d => `${d.sessionID}:${d.kind}`;
    const control = () => parse(readFileSync(process.env.HOOKS_CONTROL, 'utf8'));
    const hook = (name, cb) => context.session.hook(name, cb, { providerID: 'openai' });
    let last;
    const headers = (h, account) => {
      for (const k of Object.keys(h)) if (['authorization', 'chatgpt-account-id'].includes(k.toLowerCase())) delete h[k];
      h.authorization = `Bearer ${accounts[account].access}`;
      h['chatgpt-account-id'] = accounts[account].accountID;
    };
    const frameLog = (event, d, frame, state) => {
      if (state && frame?.type === 'response.output_text.delta') state.outputSeen = true;
      const code = frame?.error?.code ?? frame?.response?.error?.code ?? '';
      if (state && (/rate_limit|usage_limit/.test(code) || frame?.status === 429)) { state.refused = true; limited.add(state.account); }
      log(event, { sessionID: d.sessionID, kind: d.kind, account: state?.account, turn: state?.turn,
        type: frame?.type, previous_response_id: frame?.previous_response_id ?? null,
        input_items: frame?.input?.length, usage: frame?.response?.usage,
        quota: frame?.type === 'codex.rate_limits' ? frame.rate_limits : undefined,
        error: frame?.error ?? frame?.response?.error });
    };
    await hook('model.request', d => {
      const c = control();
      const account = d.kind === 'primary' ? (limited.has(c.account) ? (c.account === 'A' ? 'B' : 'A') : c.account) : 'A';
      current.set(key(d), { account, turn: c.turn, outputSeen: false, refused: false });
      d.headers['chatgpt-account-id'] = accounts[account].accountID;
      log('model.request', { sessionID: d.sessionID, kind: d.kind, account, turn: c.turn, baseURL: d.baseURL });
    });
    await hook('http.request', async d => {
      const state = current.get(key(d));
      const h = new Headers(d.request.headers);
      h.set('authorization', `Bearer ${accounts[state.account].access}`);
      h.set('chatgpt-account-id', accounts[state.account].accountID);
      d.request = new Request(d.request, { headers: h });
      const body = parse(await d.request.clone().text());
      if (d.kind === 'primary') last = { body, account: state.account, url: d.request.url };
      log('http.request', { sessionID: d.sessionID, kind: d.kind, account: state.account, turn: state.turn,
        url: d.request.url, previous_response_id: body?.previous_response_id ?? null, input_items: body?.input?.length });
    });
    await hook('http.response', d => {
      const state = current.get(key(d));
      const quota = Object.fromEntries([...d.response.headers].filter(([k]) => /^x-codex-(primary|secondary)-(used-percent|window-minutes|reset-at|reset-after-seconds)$/.test(k) || k === 'retry-after'));
      if (d.response.status === 429) { state.refused = true; limited.add(state.account); }
      log('http.response', { sessionID: d.sessionID, kind: d.kind, account: state.account, turn: state.turn, status: d.response.status, quota });
      if (!d.response.body) return;
      let pending = '';
      const decoder = new TextDecoder();
      const stream = new TransformStream({ transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split('\n'); pending = lines.pop();
        for (const line of lines) if (line.startsWith('data:')) {
          const frame = parse(line.slice(5).trim());
          if (frame) frameLog('http.frame', d, frame, state);
        }
        controller.enqueue(chunk);
      } });
      d.response = new Response(d.response.body.pipeThrough(stream), { status: d.response.status, statusText: d.response.statusText, headers: d.response.headers });
    });
    await hook('experimental.ws.handshake', d => {
      const state = current.get(key(d)); headers(d.headers, state.account);
      log('ws.handshake', { sessionID: d.sessionID, kind: d.kind, account: state.account, turn: state.turn, url: d.url });
    });
    await hook('experimental.ws.send', d => {
      const state = current.get(key(d)); const frame = parse(d.frame);
      if (d.kind === 'primary') last = { body: frame, account: state.account, url: 'https://chatgpt.com/backend-api/codex/responses' };
      frameLog('ws.send', d, frame, state);
    });
    await hook('experimental.ws.receive', d => frameLog('ws.receive', d, parse(d.frame), current.get(key(d))));
    await hook('retry', d => {
      const state = current.get(`${d.sessionID}:primary`);
      const before = d.decision;
      if (state?.outputSeen) d.decision = { retry: false };
      else if (state?.refused) d.decision = { retry: true, delay: 0 };
      // Other live errors are not retried by the spike, limiting accidental cost.
      else d.decision = { retry: false };
      log('retry', { sessionID: d.sessionID, account: state?.account, attempt: d.attempt, error: d.error, before, after: d.decision });
    });
    let warmed = false;
    const timer = setInterval(async () => {
      if (!control().warm || warmed || !last) return;
      warmed = true;
      const body = structuredClone(last.body);
      delete body.type; delete body.max_output_tokens;
      body.store = false; body.stream = true; body.reasoning = { ...body.reasoning, effort: 'low' };
      log('warm.start', { account: last.account, input_items: body.input?.length, previous_response_id: body.previous_response_id ?? null, store: body.store, max_output_tokens: 'absent' });
      try {
        const response = await fetch(last.url, { method: 'POST', headers: {
          authorization: `Bearer ${accounts[last.account].access}`, 'chatgpt-account-id': accounts[last.account].accountID,
          'content-type': 'application/json', originator: 'opencode'
        }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
        const text = await response.text();
        const completed = text.split('\n').filter(x => x.startsWith('data:')).map(x => parse(x.slice(5))).find(x => x?.type === 'response.completed');
        log('warm.complete', { account: last.account, status: response.status, usage: completed?.response?.usage, error: response.ok ? undefined : text.slice(0, 500) });
      } catch (e) { log('warm.complete', { error: String(e) }); }
    }, 250);
    timer.unref();
    log('setup', { scoped: 'openai', accounts: ['A', 'B'] });
  }
};

async function main() {
  const mode = process.argv[2] ?? 'ws';
  if (!['ws', 'switch', 'http'].includes(mode)) throw new Error('usage: node run.mjs ws|switch|http');
  const realHome = homedir();
  const deps = process.env.HOOKS_DEPS ?? join(tmpdir(), 'oc2-mc582-deps');
  if (!existsSync(join(deps, 'node_modules/.bin/opencode2'))) {
    mkdirSync(deps, { recursive: true });
    writeFileSync(join(deps, 'package.json'), JSON.stringify({ private: true, dependencies: { '@opencode/cli': '2.0.20', '@opencode/core': '2.0.20', '@opencode/ai': '2.0.20', '@opencode/plugin': '2.0.20' } }));
    const install = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: deps, stdio: 'inherit' });
    if (install.status !== 0) throw new Error('temporary dependency install failed');
  }
  const version = JSON.parse(readFileSync(join(deps, 'node_modules/@opencode/cli/package.json'), 'utf8')).version;
  if (version !== '2.0.20') throw new Error('requires @opencode/cli 2.0.20');
  // Run the launcher from /tmp too, not just its child: lsof includes the
  // launcher's cwd, which can otherwise point into the real CortexKit tree.
  if (!process.env.HOOKS_TEMP_COPY) {
    const copy = mkdtempSync(join(tmpdir(), 'oc2-hooks-launch-'));
    cpSync(fileURLToPath(import.meta.url), join(copy, 'run.mjs'));
    const output = join(copy, 'launcher.log');
    const fd = openSync(output, 'w', 0o600);
    const child = spawn(process.execPath, [join(copy, 'run.mjs'), mode], { cwd: copy, env: { PATH: process.env.PATH, TMPDIR: tmpdir(), HOOKS_TEMP_COPY: '1', HOOKS_DEPS: deps }, stdio: ['ignore', fd, fd] });
    closeSync(fd);
    process.exitCode = await new Promise(r => child.on('exit', r));
    process.stdout.write(readFileSync(output, 'utf8')); return;
  }
  // node -e selects access fields only. Its captured stdout is never printed or
  // saved, so the fallback account's real refresh token cannot enter evidence.
  const reader = spawnSync(process.execPath, ['-e', `
    const fs=require('fs'),p=require('path'),os=require('os');
    const a=JSON.parse(fs.readFileSync(p.join(os.homedir(),'.local/share/opencode/auth.json'),'utf8')).openai;
    const b=JSON.parse(fs.readFileSync(p.join(os.homedir(),'.config/opencode/openai-auth-state.json'),'utf8')).accounts.ufuk;
    const select=x=>{const claims=JSON.parse(Buffer.from(x.access.split('.')[1],'base64url'));return {access:x.access,expires:Math.min(x.expires,claims.exp*1000),accountID:x.accountId??claims['https://api.openai.com/auth'].chatgpt_account_id}};
    process.stdout.write(JSON.stringify({A:select(a),B:select(b)}));
  `], { encoding: 'utf8' });
  if (reader.status !== 0) throw new Error('credential startup reader failed (details suppressed)');
  const accounts = JSON.parse(reader.stdout);
  for (const account of Object.values(accounts)) if (typeof account.accountID !== 'string' || typeof account.access !== 'string' || !Number.isFinite(account.expires) || account.expires < Date.now() + 3600000) throw new Error('missing credential or access expires within an hour; refusing to refresh');
  if (accounts.A.accountID === accounts.B.accountID) throw new Error('requires two distinct accounts');
  const root = mkdtempSync(join(tmpdir(), `oc2-hooks-${mode}-`));
  const dirs = Object.fromEntries(['home', 'config', 'data', 'state', 'cache', 'runtime', 'tmp', 'project', 'plugin'].map(k => [k, join(root, k)]));
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const controlPath = join(root, 'control.json');
  const logPath = join(root, 'hooks.jsonl');
  const hlog = join(root, 'harness.jsonl');
  const log = (event, data = {}) => appendFileSync(hlog, JSON.stringify({ wall: Date.now(), event, ...data }) + '\n');
  writeFileSync(controlPath, JSON.stringify({ account: 'A', turn: 0 }));
  cpSync(fileURLToPath(import.meta.url), join(dirs.plugin, 'index.mjs'));
  writeFileSync(join(dirs.plugin, 'package.json'), JSON.stringify({ name: 'hooks-real', type: 'module', main: 'index.mjs' }));
  const dbPath = join(dirs.data, 'opencode.db');
  const env = { PATH: process.env.PATH, HOME: dirs.home, XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data,
    XDG_STATE_HOME: dirs.state, XDG_CACHE_HOME: dirs.cache, XDG_RUNTIME_DIR: dirs.runtime, TMPDIR: dirs.tmp,
    OPENCODE_DB: dbPath, OPENCODE_CONFIG_DIR: join(dirs.config, 'opencode'), OPENCODE_SERVER_PASSWORD: 'hooks-loopback-only',
    HOOKS_LOG: logPath, HOOKS_CONTROL: controlPath, HOOKS_ACCOUNTS: JSON.stringify(accounts) };
  mkdirSync(env.OPENCODE_CONFIG_DIR, { recursive: true });
  const config = { plugins: [dirs.plugin], providers: { openai: { settings: { transport: mode === 'http' ? 'http' : 'websocket' },
    models: { 'gpt-5.6-luna': { name: 'gpt-5.6-luna', settings: { reasoningEffort: 'low' } } } } } };
  writeFileSync(join(env.OPENCODE_CONFIG_DIR, 'opencode.json'), JSON.stringify(config));
  let server, serverURL, serverText = '', sid;
  const start = async () => {
    const port = await new Promise(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => r(port)); }); });
    serverURL = `http://127.0.0.1:${port}`;
    server = spawn(join(deps, 'node_modules/.bin/opencode2'), ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--print-logs', '--log-level', 'debug'], { cwd: dirs.project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', d => { serverText += d; }); server.stderr.on('data', d => { serverText += d; });
    for (let n = 0; n < 240; n++) { if (server.exitCode !== null) throw new Error('host exited early'); try { await fetch(serverURL, { signal: AbortSignal.timeout(500) }); return; } catch { await sleep(250); } }
    throw new Error('host startup timed out');
  };
  const stop = async () => {
    if (!server || server.exitCode !== null) return;
    const done = new Promise(r => server.once('close', r)); server.kill('SIGTERM');
    const timer = setTimeout(() => server.kill('SIGKILL'), 10000); await done; clearTimeout(timer);
  };
  const api = async (method, path, body) => {
    const response = await fetch(serverURL + path, { method, headers: { authorization: 'Basic ' + Buffer.from('opencode:hooks-loopback-only').toString('base64'), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(180000) });
    const text = await response.text(); log('api', { method, path, status: response.status, error: response.ok ? undefined : text.slice(0, 300) });
    if (!response.ok) throw new Error(`API ${path}: ${response.status}`); return parse(text);
  };
  const tree = pid => { const kids = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean).map(Number); return [pid, ...kids.flatMap(tree)]; };
  const snapshot = label => {
    const pids = [process.pid, ...tree(server.pid)];
    const result = spawnSync('lsof', ['-n', '-P', '-p', pids.join(',')], { encoding: 'utf8' });
    if (!result.stdout) throw new Error('lsof produced no evidence');
    const hits = isolationHits(result.stdout, realHome);
    writeFileSync(join(root, `lsof-${label}.txt`), result.stdout);
    log('lsof', { label, pids, lines: result.stdout.split('\n').length, forbiddenHits: hits.length });
    if (hits.length) throw new Error('isolation lsof check failed');
  };
  const events = () => existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').map(parse).filter(Boolean) : [];
  const waitEvent = async (predicate, timeout = 30000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const found = events().find(predicate); if (found) return found; await sleep(50); }
    throw new Error('measurement event timed out');
  };
  let error;
  try {
    await start(); await stop();
    const db = new DatabaseSync(dbPath);
    const now = Date.now();
    db.prepare('INSERT INTO credential (id,integration_id,label,value,active,time_created,time_updated) VALUES (?,?,?,?,1,?,?)').run('cred_hooks_real', 'openai', 'hooks access-only A', JSON.stringify({ type: 'oauth', methodID: 'chatgpt-browser', access: accounts.A.access, refresh: 'not-a-refresh-token', expires: accounts.A.expires, metadata: { accountID: accounts.A.accountID } }), now, now);
    db.close();
    log('seeded', { account: 'A', refresh: 'invalid', version });
    await start();
    for (let n = 0; n < 50; n++) { const made = await api('POST', '/api/session', { model: { providerID: 'openai', id: 'gpt-5.6-luna' } }); if (made?.data?.id) { sid = made.data.id; break; } await sleep(200); }
    if (!sid) throw new Error('session not created');
    const turns = mode === 'ws' ? 3 : 4;
    for (let turn = 1; turn <= turns; turn++) {
      const account = mode !== 'ws' && turn >= 3 ? 'B' : 'A';
      if (mode === 'http' && turn === 4) {
        log('warm.delay', { ms: 120000 }); await sleep(120000);
        writeFileSync(controlPath, JSON.stringify({ account, turn: 3, warm: true }));
        await waitEvent(e => e.event === 'warm.complete', 150000);
      }
      writeFileSync(controlPath, JSON.stringify({ account, turn }));
      const text = `Turn ${turn}. Run the bash tool exactly once with command seq 1 400. After the tool result, reply only done. Do not read or edit any files.`;
      log('turn.start', { turn, account, text });
      await api('POST', `/api/session/${sid}/prompt`, { text });
      if (turn === 1) { await sleep(1500); snapshot('during'); if (!events().some(e => e.event === 'setup')) throw new Error('measurement plugin did not load'); }
      await api('POST', `/api/experimental/session/${sid}/wait`);
      log('turn.end', { turn });
    }
    if (mode === 'ws') {
      writeFileSync(controlPath, JSON.stringify({ account: 'A', turn: 4 }));
      await api('POST', `/api/session/${sid}/prompt`, { text: 'Do not use tools. Output integers 1 through 10000, one per line, with no explanation.' });
      const first = await waitEvent(e => e.event === 'ws.receive' && e.turn === 4 && e.type === 'response.output_text.delta', 60000);
      log('interrupt.start', { firstDeltaWall: first.wall });
      await api('POST', `/api/session/${sid}/interrupt`);
      log('interrupt.return'); await api('POST', `/api/experimental/session/${sid}/wait`);
      await sleep(3000); log('interrupt.observation.end');
    }
    snapshot('after');
    const messages = await api('GET', `/api/session/${sid}/message?limit=100&order=asc`);
    writeFileSync(join(root, 'messages.json'), JSON.stringify(messages));
  } catch (e) { error = String(e); log('error', { error }); }
  finally { await stop(); writeFileSync(join(root, 'server.log'), serverText); }
  const secrets = Object.values(accounts).flatMap(x => [x.access, x.accountID]);
  const scrub = text => {
    text = scrubSecrets(text, secrets);
    return text.replaceAll(realHome, '<home>').replaceAll(root, '<run>').replaceAll(deps, '<deps>');
  };
  for (const file of ['hooks.jsonl', 'harness.jsonl', 'server.log', 'messages.json', 'lsof-during.txt', 'lsof-after.txt']) if (existsSync(join(root, file))) writeFileSync(join(root, 'scrubbed-' + file), scrub(readFileSync(join(root, file), 'utf8')));
  const ev = events();
  const summary = { mode, root, error, requests: ev.filter(e => e.event === 'ws.send' || e.event === 'http.request').length + ev.filter(e => e.event === 'warm.start').length,
    usage: ev.filter(e => e.usage), sends: ev.filter(e => e.event === 'ws.send' || e.event === 'http.request'), isolation: readFileSync(hlog, 'utf8').split('\n').map(parse).filter(e => e?.event === 'lsof') };
  writeFileSync(join(root, 'summary.json'), scrub(JSON.stringify(summary, null, 2)));
  console.log(JSON.stringify({ mode, root, error, requests: summary.requests }));
  if (error) process.exitCode = 1;
}
if (!process.env.HOOKS_LOG && process.argv[1] && existsSync(process.argv[1]) && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  if (process.argv[2] === '--self-test') await selfTest();
  else await main();
}
