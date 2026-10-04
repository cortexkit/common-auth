import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const runtimes = JSON.parse(readFileSync(new URL('./runtimes.json', import.meta.url)));
const dir = mkdtempSync(`${tmpdir()}/kernel-bundle-`), results = [];
try {
  const pkg = `${dir}/node_modules/@cortexkit/file-lock`;
  mkdirSync(pkg, { recursive: true }); mkdirSync(`${dir}/dist`);
  writeFileSync(`${pkg}/package.json`, JSON.stringify({ name: '@cortexkit/file-lock', version: '0.0.0-spike', main: 'index.cjs' }));
  writeFileSync(`${pkg}/index.cjs`, "module.exports = require('./lock.node');\n");
  copyFileSync(new URL('./lock.node', import.meta.url), `${pkg}/lock.node`);
  writeFileSync(`${dir}/entry.mjs`, "import lock from '@cortexkit/file-lock'; const h = lock.tryLock(process.argv[2]); if (!h || lock.tryLock(process.argv[2])) throw Error('exclusion failed'); lock.unlock(h); console.log('loaded-and-excluded');\n");
  for (const builder of runtimes.filter(r => r.name.startsWith('bun'))) {
    const build = execFileSync(builder.bin, ['build', `${dir}/entry.mjs`, '--target=node', '--external=@cortexkit/file-lock', `--outfile=${dir}/dist/plugin.mjs`], { encoding: 'utf8' });
    for (const runtime of runtimes) {
      const output = execFileSync(runtime.bin, [`${dir}/dist/plugin.mjs`, `${dir}/sidecar`], { encoding: 'utf8' });
      assert.equal(output.trim(), 'loaded-and-excluded');
      results.push({ builder: builder.version, runtime: runtime.version, build, output, passed: true });
    }
  }
  writeFileSync(new URL('./results/bundle.json', import.meta.url), JSON.stringify(results, null, 2) + '\n');
  console.log(`6 bundle/load/exclusion checks passed; builders Bun 1.3.14, 1.4.2; consumers Node 24.16.0, Bun 1.3.14, 1.4.2`);
} finally { rmSync(dir, { recursive: true, force: true }); }
