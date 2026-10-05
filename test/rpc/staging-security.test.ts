import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

function node24(): string {
  for (const candidate of [
    () => {
      const result = Bun.spawnSync(['mise', 'where', 'node@24'])
      return result.exitCode === 0
        ? `${result.stdout.toString().trim()}/bin/node`
        : null
    },
    () => 'node',
  ]) {
    try {
      const binary = candidate()
      if (
        binary &&
        Bun.spawnSync([binary, '--version'])
          .stdout.toString()
          .startsWith('v24.')
      )
        return binary
    } catch {}
  }
  throw new Error('Node 24 is required for staging security tests')
}

for (const runtime of ['Bun', 'Node 24'] as const) {
  for (const scenario of [
    'old file',
    'old symlink',
    'collision file',
    'collision symlink',
    'restrictive umask',
  ] as const) {
    test(`port staging protects ${scenario} under ${runtime}`, async () => {
      const binary = runtime === 'Bun' ? process.execPath : node24()
      const module = fileURLToPath(
        new URL(
          `../../${runtime === 'Bun' ? 'src' : 'dist'}/rpc/port-file.js`,
          import.meta.url,
        ),
      )
      const child = Bun.spawn(
        [
          binary,
          '-e',
          `
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, readFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePortFile } from ${JSON.stringify(module)};
const dir = await mkdtemp(join(tmpdir(), 'port-security-'));
try {
  const scenario = ${JSON.stringify(scenario)};
  const target = join(dir, 'port-123.json');
  const collision = scenario.startsWith('collision');
  const stage = target + '.' + (collision ? 'seeded' : process.pid) + '.tmp';
  const victim = join(dir, 'victim');
  await writeFile(victim, 'untouched');
  if (scenario.endsWith('symlink')) await symlink(victim, stage);
  else { await writeFile(stage, 'stale'); await chmod(stage, 0o644); }
  if (scenario === 'restrictive umask') process.umask(0o777);
  const operation = writePortFile(dir, { pid: 123, port: 456, token: 'secret' }, { secureDir: true, ...(collision ? { stageName: () => 'seeded' } : {}) });
  if (collision) {
    await assert.rejects(operation, { code: 'EEXIST' });
    await assert.rejects(lstat(target), { code: 'ENOENT' });
    assert.equal((await lstat(stage)).isSymbolicLink(), scenario.endsWith('symlink'));
    if (!scenario.endsWith('symlink')) assert.equal(await readFile(stage, 'utf8'), 'stale');
  } else {
    await operation;
    const info = await lstat(target);
    assert.equal(info.isFile(), true);
    assert.equal(info.isSymbolicLink(), false);
    assert.equal(info.mode & 0o777, 0o600);
  }
  assert.equal(await readFile(victim, 'utf8'), 'untouched');
  console.log(process.versions.bun ?? process.version);
} finally { await rm(dir, { recursive: true, force: true }); }
`,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, `${out}\n${err}`).toBe(0)
      console.info(`port staging ${runtime}: ${out.trim()}`)
    })
  }
}
