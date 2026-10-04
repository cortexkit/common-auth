import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const runtimes = JSON.parse(readFileSync(new URL('./runtimes.json', import.meta.url)));
const scratch = mkdtempSync(`${tmpdir()}/kernel-triple-`), processes = [], observations = [];
async function worker(r) {
  const p = spawn(r.bin, [new URL('./worker.mjs', import.meta.url).pathname, `${scratch}/sidecar`], { stdio: ['pipe', 'pipe', 'inherit'] });
  processes.push(p);
  const lines = createInterface({ input: p.stdout })[Symbol.asyncIterator]();
  const ready = JSON.parse((await lines.next()).value);
  return { ready, request: async c => { p.stdin.write(JSON.stringify(c) + '\n'); const x = JSON.parse((await lines.next()).value); if (x.error) throw Error(x.stack); return x; } };
}
try {
  const ws = await Promise.all(runtimes.map(worker));
  for (let i = 0; i < 3; i++) {
    const holder = ws[i], cs = ws.filter(w => w !== holder);
    assert.ok((await holder.request({ op: 'try' })).acquired);
    const busy = await Promise.all(cs.map(w => w.request({ op: 'try' })));
    assert.ok(busy.every(x => !x.acquired));
    await holder.request({ op: 'release' });
    const race = await Promise.all(cs.map(w => w.request({ op: 'try' })));
    assert.equal(race.filter(x => x.acquired).length, 1);
    await cs[race.findIndex(x => x.acquired)].request({ op: 'release' });
    observations.push({ holder: holder.ready, contenders: cs.map(w => w.ready), busy, raceAfterRelease: race });
  }
  writeFileSync(new URL('./results/triple-exclusion.json', import.meta.url), JSON.stringify({ passed: true, assertions: 9, observations }, null, 2) + '\n');
  console.log('All three pinned runtimes on one sidecar: 3 holder rotations, 9 assertions passed');
} finally {
  for (const p of processes) p.kill('SIGKILL');
  rmSync(scratch, { recursive: true, force: true });
}
