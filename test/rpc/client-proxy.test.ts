import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const rpcIndexPath = fileURLToPath(
  new URL('../../src/rpc/index.js', import.meta.url),
)
const rpcServerPath = fileURLToPath(
  new URL('../../src/rpc/rpc-server.js', import.meta.url),
)
const rpcClientPath = fileURLToPath(
  new URL('../../src/rpc/rpc-client.js', import.meta.url),
)

function findNode(): string | null {
  try {
    const res = Bun.spawnSync(['mise', 'where', 'node@24'])
    if (res.exitCode === 0) {
      const prefix = res.stdout.toString().trim()
      const candidate = `${prefix}/bin/node`
      if (existsSync(candidate)) return candidate
    }
  } catch {}

  try {
    const res = Bun.spawnSync(['node', '--version'])
    if (res.exitCode === 0) {
      return 'node'
    }
  } catch {}

  return null
}

test('loopback RPC client bypasses HTTP_PROXY, http_proxy and HTTPS_PROXY', async () => {
  const childScript = `
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pushNotification, drainNotifications } from ${JSON.stringify(rpcIndexPath)};
import { startRpcServer } from ${JSON.stringify(rpcServerPath)};
import { createRpcClient } from ${JSON.stringify(rpcClientPath)};

const scope = {
  rpcRoot: '/fixture',
  directoryPrefix: 'fixture-',
  registrationSessionId: 'reg-proxy',
};

const dir = await mkdtemp(join(tmpdir(), 'fixture-rpc-proxy-'));
const server = await startRpcServer({
  dir,
  drain: (id, sess) => drainNotifications(scope, id, sess),
  apply: async (req) => ({
    text: 'ok: ' + req.command,
    knobs: { echo: req.arguments },
  }),
});

pushNotification(
  scope,
  { command: 'proxy-check', text: 'notice', knobs: { k: 'v' } },
  'sess-proxy',
);

const client = createRpcClient(dir, process.pid);
const pending = await client.pending(0, 'sess-proxy');
const applyRes = await client.apply({
  command: 'proxy-apply',
  arguments: 'payload',
  sessionId: 'sess-proxy',
});

await server.stop();
await rm(dir, { recursive: true, force: true });

if (pending.length !== 1 || pending[0].payload.command !== 'proxy-check') {
  console.error('Pending failed:', JSON.stringify(pending));
  process.exit(1);
}

if (applyRes.text !== 'ok: proxy-apply' || applyRes.knobs?.echo !== 'payload') {
  console.error('Apply failed:', JSON.stringify(applyRes));
  process.exit(2);
}

console.log(JSON.stringify({ pending, applyRes }));
`

  const env = { ...process.env }
  delete env.NO_PROXY
  delete env.no_proxy
  env.HTTP_PROXY = 'http://127.0.0.1:9'
  env.http_proxy = 'http://127.0.0.1:9'
  env.HTTPS_PROXY = 'http://127.0.0.1:9'
  env.https_proxy = 'http://127.0.0.1:9'

  const proc = Bun.spawn([process.execPath, '-e', childScript], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [out, err, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  if (exitCode !== 0) {
    throw new Error(
      `Child exited with code ${exitCode}. stderr: ${err.trim()} stdout: ${out.trim()}`,
    )
  }

  const result = JSON.parse(out)
  expect(result.pending).toHaveLength(1)
  expect(result.pending[0].payload.command).toBe('proxy-check')
  expect(result.applyRes).toEqual({
    text: 'ok: proxy-apply',
    knobs: { echo: 'payload' },
  })
})

test('loopback RPC client under Node with NODE_USE_ENV_PROXY bypasses HTTP_PROXY', async () => {
  const nodeBin = findNode()
  if (!nodeBin) return

  const distIndex = fileURLToPath(
    new URL('../../dist/rpc/index.js', import.meta.url),
  )
  if (!existsSync(distIndex)) {
    Bun.spawnSync(['bun', 'run', 'build'])
  }
  const distServer = fileURLToPath(
    new URL('../../dist/rpc/rpc-server.js', import.meta.url),
  )
  const distClient = fileURLToPath(
    new URL('../../dist/rpc/rpc-client.js', import.meta.url),
  )

  const childScript = `
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pushNotification, drainNotifications } from ${JSON.stringify(distIndex)};
import { startRpcServer } from ${JSON.stringify(distServer)};
import { createRpcClient } from ${JSON.stringify(distClient)};

const scope = {
  rpcRoot: '/fixture',
  directoryPrefix: 'fixture-',
  registrationSessionId: 'reg-node-proxy',
};

const dir = await mkdtemp(join(tmpdir(), 'fixture-rpc-node-proxy-'));
const server = await startRpcServer({
  dir,
  drain: (id, sess) => drainNotifications(scope, id, sess),
  apply: async (req) => ({
    text: 'ok: ' + req.command,
    knobs: { echo: req.arguments },
  }),
});

pushNotification(
  scope,
  { command: 'node-proxy-check', text: 'notice', knobs: { k: 'v' } },
  'sess-node-proxy',
);

const client = createRpcClient(dir, process.pid);
const pending = await client.pending(0, 'sess-node-proxy');
const applyRes = await client.apply({
  command: 'node-proxy-apply',
  arguments: 'payload',
  sessionId: 'sess-node-proxy',
});

await server.stop();
await rm(dir, { recursive: true, force: true });

if (pending.length !== 1 || pending[0].payload?.command !== 'node-proxy-check') {
  console.error('Pending failed:', JSON.stringify(pending));
  process.exit(1);
}

if (applyRes.text !== 'ok: node-proxy-apply' || applyRes.knobs?.echo !== 'payload') {
  console.error('Apply failed:', JSON.stringify(applyRes));
  process.exit(2);
}

console.log(JSON.stringify({ pending, applyRes }));
`

  const env = { ...process.env }
  delete env.NO_PROXY
  delete env.no_proxy
  env.NODE_USE_ENV_PROXY = '1'
  env.HTTP_PROXY = 'http://127.0.0.1:9'
  env.http_proxy = 'http://127.0.0.1:9'
  env.HTTPS_PROXY = 'http://127.0.0.1:9'
  env.https_proxy = 'http://127.0.0.1:9'

  const proc = Bun.spawn([nodeBin, '-e', childScript], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [out, err, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  if (exitCode !== 0) {
    throw new Error(
      `Child exited with code ${exitCode}. stderr: ${err.trim()} stdout: ${out.trim()}`,
    )
  }

  const result = JSON.parse(out)
  expect(result.pending).toHaveLength(1)
  expect(result.pending[0].payload.command).toBe('node-proxy-check')
  expect(result.applyRes).toEqual({
    text: 'ok: node-proxy-apply',
    knobs: { echo: 'payload' },
  })
})
