import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

async function checkStop(
  binary: string,
  directory: 'src' | 'dist',
  version: string,
) {
  const modulePath = fileURLToPath(
    new URL(`../../${directory}/rpc/rpc-server.js`, import.meta.url),
  )
  const script = `
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRpcServer } from ${JSON.stringify(modulePath)};
const dir = await mkdtemp(join(tmpdir(), 'rpc-stop-'));
const server = await startRpcServer({ dir, isManagedDir: () => false, drain: () => [], apply: async () => ({ text: '', knobs: {} }) });
const socket = connect({ host: '127.0.0.1', port: server.port });
socket.on('error', () => {});
let timer;
try {
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.once('connect', () => socket.write('POST /rpc/pending-notifications HTTP/1.1\\r\\nHost: localhost\\r\\nAuthorization: Bearer ' + server.token + '\\r\\nContent-Length: 100\\r\\n\\r\\n{', resolve)); });
  // A health round trip gives the partial request time to reach the server.
  assert.equal((await fetch('http://127.0.0.1:' + server.port + '/health')).status, 200);
  const started = Date.now();
  await Promise.race([server.stop(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('stop waited for held connection')), 500); })]);
  console.log(JSON.stringify({ version: process.versions.bun ?? process.version, closeAllConnections: typeof createServer().closeAllConnections, elapsed: Date.now() - started }));
} finally {
  clearTimeout(timer);
  socket.destroy();
  await server.stop();
  await rm(dir, { recursive: true, force: true });
}
`
  const child = Bun.spawn([binary, '-e', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code, `${out}\n${err}`).toBe(0)
  const result = JSON.parse(out)
  expect(result.version.replace(/^v/, '')).toBe(version)
  expect(result.closeAllConnections).toBe('function')
  expect(result.elapsed).toBeLessThan(500)
  console.info(`RPC stop ${JSON.stringify(result)}`)
}

function miseBinary(tool: string, executable: string) {
  const result = Bun.spawnSync(['mise', 'where', tool])
  if (result.exitCode !== 0)
    throw new Error(`${tool} is required: ${result.stderr}`)
  return `${result.stdout.toString().trim()}/bin/${executable}`
}

test('RPC stop closes held partial requests under Bun 1.3.14', async () => {
  await checkStop(miseBinary('bun@1.3.14', 'bun'), 'src', '1.3.14')
})

test('RPC stop closes held partial requests under Bun 1.4.2', async () => {
  await checkStop(process.execPath, 'src', '1.4.2')
})

test('RPC stop closes held partial requests under Node 24.16.0', async () => {
  await checkStop(miseBinary('node@24.16.0', 'node'), 'dist', '24.16.0')
})
