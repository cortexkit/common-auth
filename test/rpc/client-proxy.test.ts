import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'

function findNode(): string | null {
  try {
    const res = Bun.spawnSync(['mise', 'where', 'node@24'])
    if (res.exitCode === 0) {
      const candidate = `${res.stdout.toString().trim()}/bin/node`
      if (existsSync(candidate)) return candidate
    }
  } catch {}
  try {
    const res = Bun.spawnSync(['node', '--version'])
    if (res.exitCode === 0 && res.stdout.toString().startsWith('v24.')) {
      return 'node'
    }
  } catch {}
  return null
}

async function checkRuntime(binary: string, directory: 'src' | 'dist') {
  const modulePath = (file: string) =>
    fileURLToPath(new URL(`../../${directory}/rpc/${file}.js`, import.meta.url))
  const childScript = `
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { pushNotification, drainNotifications } from ${JSON.stringify(modulePath('index'))};
import { startRpcServer } from ${JSON.stringify(modulePath('rpc-server'))};
import { createRpcClient } from ${JSON.stringify(modulePath('rpc-client'))};
import { writePortFile } from ${JSON.stringify(modulePath('port-file'))};

const scope = { rpcRoot: '/fixture', directoryPrefix: 'fixture-', registrationSessionId: 'reg-proxy' };
const dir = await mkdtemp(join(tmpdir(), 'fixture-rpc-proxy-'));
const server = await startRpcServer({
  dir,
  drain: (id, sess) => drainNotifications(scope, id, sess),
  apply: async (req) => {
    if (req.command === 'slow') await new Promise(resolve => setTimeout(resolve, 100));
    if (req.command === 'error') throw new Error('private');
    return { text: 'ok: ' + req.command, knobs: { echo: req.arguments } };
  },
});
try {
  // Probe the actual server's framing independently of the client's parser.
  const wire = await new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: server.port });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('HTTP/1.0 did not close')); }, 1000);
    let response = '';
    socket.on('connect', () => socket.write('POST /rpc/pending-notifications HTTP/1.0\\r\\nHost: 127.0.0.1\\r\\nAuthorization: Bearer ' + server.token + '\\r\\nContent-Length: 2\\r\\n\\r\\n{}'));
    socket.on('data', chunk => { response += chunk.toString(); });
    socket.on('error', reject);
    socket.on('end', () => { clearTimeout(timer); resolve(response); });
  });
  const separator = wire.indexOf('\\r\\n\\r\\n');
  assert.ok(separator > 0);
  const headers = wire.slice(0, separator);
  assert.ok(headers.startsWith('HTTP/1.0 200 ') || headers.startsWith('HTTP/1.1 200 '));
  assert.doesNotMatch(headers, /transfer-encoding:/i);
  assert.deepEqual(JSON.parse(wire.slice(separator + 4)), { messages: [] });

  pushNotification(scope, { command: 'proxy-check', text: 'notice', knobs: { k: 'v' } }, 'sess-proxy');
  let selections = 0;
  const client = createRpcClient(dir, process.pid, () => { selections++; });
  const pending = await client.pending(0, 'sess-proxy');
  const applyRes = await client.apply({ command: 'proxy-apply', arguments: 'payload ☃', sessionId: 'sess-proxy' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].payload.command, 'proxy-check');
  assert.deepEqual(applyRes, { text: 'ok: proxy-apply', knobs: { echo: 'payload ☃' } });
  assert.equal(selections, 1);
  assert.deepEqual(await client.apply({ command: 'slow', arguments: '' }, 10), { text: 'apply failed', knobs: {} });
  assert.deepEqual(await client.apply({ command: 'error', arguments: '' }), { text: 'apply failed', knobs: {} });
  assert.deepEqual(await createRpcClient(dir, 2147483647, undefined, { exactPid: true }).pending(0), []);
  assert.equal((await createRpcClient(dir, 2147483647).apply({ command: 'fallback', arguments: '' })).text, 'ok: fallback');
  await writePortFile(dir, { port: server.port, token: 'wrong', pid: process.pid });
  assert.deepEqual(await client.pending(0), []);
  console.log(JSON.stringify({ runtime: process.version, pending, applyRes, headers }));
} finally {
  await server.stop();
  await rm(dir, { recursive: true, force: true });
}
`
  let connections = 0
  const recorder = createServer((socket) => {
    connections++
    socket.destroy()
  })
  await new Promise<void>((resolve) => recorder.listen(0, '127.0.0.1', resolve))
  const address = recorder.address()
  if (!address || typeof address === 'string') throw new Error('no proxy port')
  try {
    // The dead endpoint checks failure behavior; the recorder detects even a
    // proxy attempt that a runtime silently retries as a direct connection.
    for (const port of [9, address.port]) {
      const env = { ...process.env }
      delete env.NO_PROXY
      delete env.no_proxy
      env.NODE_USE_ENV_PROXY = '1'
      for (const key of [
        'HTTP_PROXY',
        'http_proxy',
        'HTTPS_PROXY',
        'https_proxy',
      ]) {
        env[key] = `http://127.0.0.1:${port}`
      }
      const proc = Bun.spawn([binary, '-e', childScript], {
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [out, err, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      expect(exitCode, `stderr: ${err} stdout: ${out}`).toBe(0)
      const result = JSON.parse(out)
      expect(result.applyRes.text).toBe('ok: proxy-apply')
      console.info(
        `HTTP/1.0 wire (${binary}, ${result.runtime}): ${JSON.stringify(result.headers)}; EOF body {"messages":[]}`,
      )
    }
    expect(connections).toBe(0)
  } finally {
    await new Promise<void>((resolve, reject) =>
      recorder.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

test('loopback RPC client bypasses HTTP_PROXY, http_proxy and HTTPS_PROXY', async () => {
  await checkRuntime(process.execPath, 'src')
})

test('loopback RPC client under Node with NODE_USE_ENV_PROXY bypasses HTTP_PROXY', async () => {
  const node = findNode()
  if (!node)
    throw new Error('Node 24 is required for the proxy regression test')
  const dist = fileURLToPath(
    new URL('../../dist/rpc/index.js', import.meta.url),
  )
  if (!existsSync(dist)) {
    expect(Bun.spawnSync(['bun', 'run', 'build']).exitCode).toBe(0)
  }
  await checkRuntime(node, 'dist')
})
