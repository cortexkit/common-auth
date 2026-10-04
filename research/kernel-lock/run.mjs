import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
const runtimes = JSON.parse(readFileSync(new URL('./runtimes.json', import.meta.url)));
const root = resolve('research/kernel-lock');
const resultDir = process.argv[2] ?? `${root}/results`;
mkdirSync(resultDir, { recursive: true });
const scratch = mkdtempSync(`${tmpdir()}/kernel-lock-`);
const children = new Set();
let checks = 0;
function check(value, name = `assertion-${checks + 1}`) { checks++; assert.ok(value, name); }
function save(name, value) { writeFileSync(`${resultDir}/${name}.json`, JSON.stringify(value, null, 2) + '\n'); }
async function worker(runtime, path) {
  const p = spawn(runtime.bin, [`${root}/worker.mjs`, path], { stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(p); p.on('exit', () => children.delete(p));
  const queue = [], waiters = []; let stderr = '';
  p.stderr.on('data', d => stderr += d);
  createInterface({ input: p.stdout }).on('line', l => { const x = JSON.parse(l); if (waiters.length) waiters.shift().resolve(x); else queue.push(x); });
  p.on('exit', code => { for (const w of waiters.splice(0)) w.reject(new Error(`worker exited ${code}: ${stderr}`)); });
  const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  const ready = await next();
  return { p, ready, request: async c => { p.stdin.write(JSON.stringify(c) + '\n'); const x = await next(); if (x.error) throw new Error(x.stack); return x; }, stop: () => p.stdin.end() };
}
const delay = ms => new Promise(r => setTimeout(r, ms));
try {
  save('environment', { date: new Date().toISOString(), uname: execFileSync('uname', ['-a'], { encoding: 'utf8' }), runtimes });
  for (const r of runtimes) {
    const w = await worker(r, `${scratch}/same`);
    const same = await w.request({ op: 'same' });
    const rename = await w.request({ op: 'rename', data: `${scratch}/data` });
    save(`same-${r.name}`, { ready: w.ready, same, rename });
    check(same.first && !same.second && !same.afterUnrelatedClose, `same-process-exclusion-${r.name}`);
    check(!rename.contenderAcquired && rename.inodeBefore === rename.inodeAfter); w.stop();
  }
  for (const a of runtimes) for (const b of runtimes) {
    if (a === b) continue;
    const path = `${scratch}/${a.name}-${b.name}`;
    const h = await worker(a, path), c = await worker(b, path);
    const acquired = await h.request({ op: 'try' });
    const busy = await c.request({ op: 'try' });
    check(acquired.acquired && !busy.acquired);
    h.p.kill('SIGSTOP');
    const paused = []; const start = performance.now();
    while (performance.now() - start < 600) { paused.push({ ms: performance.now() - start, ...await c.request({ op: 'try' }) }); await delay(20); }
    check(paused.every(x => !x.acquired));
    h.p.kill('SIGCONT'); const resumedBeforeRelease = await c.request({ op: 'try' });
    check(!resumedBeforeRelease.acquired);
    const abort = await c.request({ op: 'abort' });
    check(abort.aborts === 20 && abort.before === abort.after && abort.busy && Math.max(...abort.times) < 200);
    await h.request({ op: 'release' });
    const afterRelease = await c.request({ op: 'try' }); check(afterRelease.acquired);
    await c.request({ op: 'release' });
    await h.request({ op: 'try' });
    const killStart = performance.now(); h.p.kill('SIGKILL');
    let attempts = 0, afterKill;
    do { afterKill = await c.request({ op: 'try' }); attempts++; if (!afterKill.acquired) await delay(2); } while (!afterKill.acquired && performance.now() - killStart < 2000);
    const killMs = performance.now() - killStart; check(afterKill.acquired);
    await c.request({ op: 'release' }); c.stop();
    save(`pair-${a.name}-${b.name}`, { holder: h.ready, contender: c.ready, acquired, busy, paused, resumedBeforeRelease, abort, afterRelease, afterKill, attempts, killMs });
  }
  for (const [name, group] of [...runtimes.map(r => [r.name, [r, r, r, r]]), ['mixed-all-three', [...runtimes, ...runtimes]]]) {
    const path = `${scratch}/counter-${name}`, data = path + '.data'; writeFileSync(data, '0'); writeFileSync(path, '');
    const ws = await Promise.all(group.map(r => worker(r, path)));
    const start = performance.now(), rounds = 150;
    const results = await Promise.all(ws.map(w => w.request({ op: 'counter', rounds, data })));
    const actual = Number(readFileSync(data, 'utf8')), expected = rounds * ws.length;
    save(`counter-${name}`, { runtimes: ws.map(w => w.ready), roundsPerProcess: rounds, expected, actual, elapsedMs: performance.now() - start, results });
    check(actual === expected); check(results.every(r => r.sidecarInodeBefore === r.sidecarInodeAfter)); ws.forEach(w => w.stop());
  }
  save('summary', { passed: true, assertionCount: checks, pairRuns: 6, counterRuns: 4 });
  console.log(JSON.stringify({ passed: true, checks, runtimeVersions: runtimes.map(r => r.version) }));
} finally {
  for (const p of children) { p.kill('SIGCONT'); p.kill('SIGKILL'); }
  rmSync(scratch, { recursive: true, force: true });
}
