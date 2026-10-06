import { expect } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { observed } from '../fixtures/observed.js'

const hooks = lifetimeHooks()
const { test } = hooks

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
try {
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.once('connect', () => socket.write('POST /rpc/pending-notifications HTTP/1.1\\r\\nHost: localhost\\r\\nAuthorization: Bearer ' + server.token + '\\r\\nContent-Length: 100\\r\\n\\r\\n{', resolve)); });
  // A health round trip gives the partial request time to reach the server.
  assert.equal((await fetch('http://127.0.0.1:' + server.port + '/health')).status, 200);
  const started = Date.now();
  await server.stop();
  console.log(JSON.stringify({ version: process.versions.bun ?? process.version, closeAllConnections: typeof createServer().closeAllConnections, elapsed: Date.now() - started }));
} finally {
  socket.destroy();
  await server.stop();
  await rm(dir, { recursive: true, force: true });
}
`
  const child = Bun.spawn([binary, '-e', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  hooks.lifetime.unpark(() => child.kill())
  const [out, err, code] = await observed(
    hooks.lifetime,
    Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]),
  )
  expect(code, `${out}\n${err}`).toBe(0)
  const result = JSON.parse(out)
  expect(result.version.replace(/^v/, '')).toBe(version)
  expect(result.closeAllConnections).toBe('function')
  console.info(`RPC stop ${JSON.stringify(result)}`)
}

// A process whose server was stopped while an `apply` was still pending must be
// free to exit: the apply deadline timer only bounds the reply, and once the
// server is gone nothing waits for it. Wait for process exit itself; the
// runner deadline and lifetime cancellation handle a child that cannot exit.
async function checkExitAfterStop(
  binary: string,
  directory: 'src' | 'dist',
  version: string,
) {
  const modulePath = fileURLToPath(
    new URL(`../../${directory}/rpc/rpc-server.js`, import.meta.url),
  )
  const script = `
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRpcServer } from ${JSON.stringify(modulePath)};
const dir = await mkdtemp(join(tmpdir(), 'rpc-exit-'));
const realSetTimeout = globalThis.setTimeout;
let applyTimer;
globalThis.setTimeout = (...args) => {
  const timer = realSetTimeout(...args);
  if (args[1] === 3000) applyTimer = timer;
  return timer;
};
let entered;
const enteredApply = new Promise((resolve) => { entered = resolve; });
const server = await startRpcServer({ dir, isManagedDir: () => false, drain: () => [], applyDeadlineMs: 3000, apply: () => { entered(); return new Promise(() => {}); } });
const socket = connect({ host: '127.0.0.1', port: server.port });
socket.on('error', () => {});
await new Promise((resolve) => socket.once('connect', resolve));
socket.write('POST /rpc/apply HTTP/1.1\\r\\nHost: localhost\\r\\nAuthorization: Bearer ' + server.token + '\\r\\nContent-Type: application/json\\r\\nContent-Length: 2\\r\\n\\r\\n{}');
await enteredApply;
// Observe the actual deadline timer: eventual exit alone could wait for it to fire.
assert.ok(applyTimer, 'apply deadline timer was installed');
assert.equal(applyTimer.hasRef(), false, 'pending apply deadline must not hold process exit');
socket.destroy();
await server.stop();
await rm(dir, { recursive: true, force: true });
const stoppedAt = Date.now();
process.on('exit', () => { process.stdout.write(JSON.stringify({ version: process.versions.bun ?? process.version, exitAfterStopMs: Date.now() - stoppedAt })); });
`
  const child = Bun.spawn([binary, '-e', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  hooks.lifetime.unpark(() => child.kill())
  const [out, err, code] = await observed(
    hooks.lifetime,
    Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]),
  )
  expect(code, `${out}\n${err}`).toBe(0)
  const result = JSON.parse(out)
  expect(result.version.replace(/^v/, '')).toBe(version)
  console.info(`RPC exit after stop ${JSON.stringify(result)}`)
}

// Node 24 from mise when present (local machines), else `node` on PATH (CI
// installs Node 24 with setup-node). Either way it must report a v24.
function findNode24(): { binary: string; version: string } {
  for (const candidate of [
    () => {
      const res = Bun.spawnSync(['mise', 'where', 'node@24'])
      return res.exitCode === 0
        ? `${res.stdout.toString().trim()}/bin/node`
        : null
    },
    () => 'node',
  ]) {
    let binary: string | null = null
    try {
      binary = candidate()
    } catch {}
    if (!binary) continue
    const res = Bun.spawnSync([binary, '--version'])
    const version = res.stdout.toString().trim().replace(/^v/, '')
    if (res.exitCode === 0 && version.startsWith('24.'))
      return { binary, version }
  }
  throw new Error('Node 24 is required for the RPC stop test')
}

// The Bun test runner itself is the Bun under test: 1.3.14 in CI (the pinned
// floor) and 1.4.2 locally, so between them both pinned Bun versions run it.
test('RPC stop closes held partial requests under the running Bun', async () => {
  await checkStop(process.execPath, 'src', Bun.version)
})

test('RPC stop closes held partial requests under Node 24', async () => {
  const node = findNode24()
  await checkStop(node.binary, 'dist', node.version)
})

test('a pending apply does not keep the process alive after stop under the running Bun', async () => {
  await checkExitAfterStop(process.execPath, 'src', Bun.version)
}, 15_000)

test('a pending apply does not keep the process alive after stop under Node 24', async () => {
  const node = findNode24()
  await checkExitAfterStop(node.binary, 'dist', node.version)
}, 15_000)
