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
  const queue = [], waiters = [], messages = []; let stderr = '';
  const exit = new Promise(resolve => p.once('exit', (code, signal) => resolve({ code, signal, ms: performance.now() })));
  p.stderr.on('data', d => stderr += d);
  createInterface({ input: p.stdout }).on('line', l => { const x = JSON.parse(l); messages.push({ ms: performance.now(), ...x }); if (waiters.length) waiters.shift().resolve(x); else queue.push(x); });
  p.on('exit', code => { for (const w of waiters.splice(0)) w.reject(new Error(`worker exited ${code}: ${stderr}`)); });
  const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  const ready = await next();
  return { p, ready, exit, messages, request: async c => { p.stdin.write(JSON.stringify(c) + '\n'); const x = await next(); if (x.error) throw new Error(x.stack); return x; }, stop: () => p.stdin.end() };
}
const delay = ms => new Promise(r => setTimeout(r, ms));
function processState(pid) {
  const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  return { pid, stat, stopped: stat.startsWith('T'), ms: performance.now() };
}
async function waitStopped(pid) {
  const start = performance.now();
  let observation;
  do { observation = processState(pid); if (observation.stopped) return observation; await delay(5); } while (performance.now() - start < 2000);
  return observation;
}
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
    const stoppedBefore = await waitStopped(h.ready.pid);
    const paused = []; const start = performance.now();
    while (performance.now() - start < 600) { paused.push({ ms: performance.now() - start, observedMs: performance.now(), ...await c.request({ op: 'try' }) }); await delay(20); }
    const stoppedAfter = processState(h.ready.pid);
    const pause = { stoppedBefore, stoppedAfter, durationMs: stoppedAfter.ms - stoppedBefore.ms, sampleSpanMs: paused.length ? paused.at(-1).observedMs - paused[0].observedMs : 0, minimumSamples: 10, minimumDurationMs: 600, minimumSampleSpanMs: 500 };
    save(`pause-${a.name}-${b.name}`, { pause, paused });
    // Endpoint process-state observations bracket a substantial span of actual contender samples.
    check(paused.length >= pause.minimumSamples, `pause-minimum-samples-${a.name}-${b.name}`);
    check(pause.durationMs >= pause.minimumDurationMs && pause.sampleSpanMs >= pause.minimumSampleSpanMs, `pause-minimum-duration-${a.name}-${b.name}`);
    check(stoppedBefore.stopped && stoppedAfter.stopped && stoppedBefore.ms <= paused[0].observedMs && stoppedAfter.ms >= paused.at(-1).observedMs, `pause-holder-stopped-${a.name}-${b.name}`);
    check(paused.every(x => !x.acquired), `pause-exclusion-${a.name}-${b.name}`);
    h.p.kill('SIGCONT'); const resumedBeforeRelease = await c.request({ op: 'try' });
    check(!resumedBeforeRelease.acquired);
    const abort = await c.request({ op: 'abort' });
    check(abort.aborts === 20 && abort.before === abort.after && abort.busy && Math.max(...abort.times) < 200);
    const holderRelease = await h.request({ op: 'release' });
    const afterRelease = await c.request({ op: 'try' }); check(afterRelease.acquired);
    await c.request({ op: 'release' });
    const killMessageStart = h.messages.length;
    const killAcquired = await h.request({ op: 'try' });
    const heartbeat = { ...await h.request({ op: 'heartbeat' }), observedMs: performance.now() };
    const beforeKill = { ...await c.request({ op: 'try' }), observedMs: performance.now() };
    const holderMessages = h.messages.slice(killMessageStart);
    const kill = { killAcquired, heartbeat, beforeKill, holderMessages, unlockCallsBeforeProbe: holderRelease.unlockCalls };
    save(`kill-${a.name}-${b.name}`, kill);
    check(!beforeKill.acquired && beforeKill.observedMs >= heartbeat.observedMs, `kill-prekill-busy-${a.name}-${b.name}`);
    check(killAcquired.acquired && heartbeat.held && heartbeat.unlockCalls === holderRelease.unlockCalls && !holderMessages.some(x => x.released), `kill-holder-still-held-${a.name}-${b.name}`);
    // No holder command follows the heartbeat: only signal death can release this phase's lock.
    const killStart = performance.now(); kill.sentMs = killStart;
    check(h.p.kill('SIGKILL'), `kill-signal-sent-${a.name}-${b.name}`);
    kill.exit = await Promise.race([h.exit, delay(2000).then(() => ({ timeout: true }))]);
    save(`kill-${a.name}-${b.name}`, kill);
    check(kill.exit.signal === 'SIGKILL' && kill.exit.code === null, `kill-signal-death-${a.name}-${b.name}`);
    let attempts = 0, afterKill;
    do { afterKill = await c.request({ op: 'try' }); attempts++; if (!afterKill.acquired) await delay(2); } while (!afterKill.acquired && performance.now() - killStart < 2000);
    const killMs = performance.now() - killStart; kill.acquiredMs = performance.now();
    kill.afterKill = afterKill;
    save(`kill-${a.name}-${b.name}`, kill);
    check(afterKill.acquired && kill.acquiredMs >= kill.exit.ms && kill.exit.ms >= kill.sentMs && kill.sentMs >= beforeKill.observedMs, `kill-acquire-after-death-${a.name}-${b.name}`);
    await c.request({ op: 'release' }); c.stop();
    save(`pair-${a.name}-${b.name}`, { holder: h.ready, contender: c.ready, acquired, busy, pause, paused, kill, resumedBeforeRelease, abort, afterRelease, afterKill, attempts, killMs });
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
