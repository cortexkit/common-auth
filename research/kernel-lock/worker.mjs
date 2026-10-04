import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, renameSync, openSync, closeSync, statSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
const addon = createRequire(import.meta.url)('./lock.node');
const path = process.argv[2];
let held;
const delay = (ms, signal) => new Promise((resolve, reject) => {
  const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
});
async function acquire({ signal, timeout = 5000 } = {}) {
  const start = performance.now();
  while (true) {
    signal?.throwIfAborted();
    const handle = addon.tryLock(path);
    if (handle) return handle;
    if (performance.now() - start >= timeout) throw new Error('busy');
    await delay(5, signal);
  }
}
function fds() {
  // Linux exposes the process's descriptors directly; macOS needs lsof.
  if (existsSync('/proc/self/fd')) return readdirSync('/proc/self/fd').length;
  return execFileSync('/usr/sbin/lsof', ['-a', '-p', String(process.pid), '-Ff'], { encoding: 'utf8' }).split('\n').filter(x => /^f\d/.test(x)).length;
}
async function command(c) {
  if (c.op === 'try') { const h = addon.tryLock(path); if (h) held = h; return { acquired: !!h }; }
  if (c.op === 'release') { addon.unlock(held); held = undefined; return { released: true }; }
  if (c.op === 'same') {
    const a = addon.tryLock(path), b = addon.tryLock(path);
    const fd = openSync(path, 'r+'); closeSync(fd);
    const d = addon.tryLock(path);
    if (b) addon.unlock(b); if (d) addon.unlock(d); addon.unlock(a);
    return { first: !!a, second: !!b, afterUnrelatedClose: !!d };
  }
  if (c.op === 'abort') {
    fds(); const before = fds(); let aborts = 0; const times = [];
    for (let i = 0; i < 20; i++) {
      const controller = new AbortController();
      const start = performance.now(); setTimeout(() => controller.abort(), 20);
      try { await acquire({ signal: controller.signal }); } catch (e) { if (e.name === 'AbortError') aborts++; else throw e; }
      times.push(performance.now() - start);
    }
    const after = fds(); const start = performance.now(); let busy = false;
    try { await acquire({ timeout: 40 }); } catch (e) { busy = e.message === 'busy'; }
    return { aborts, times, before, after, busy, boundedWaitMs: performance.now() - start };
  }
  if (c.op === 'counter') {
    const inode = statSync(path).ino;
    for (let i = 0; i < c.rounds; i++) {
      const h = await acquire({ timeout: 30000 });
      try {
        const n = Number(readFileSync(c.data, 'utf8'));
        await delay(1);
        const temp = `${c.data}.${process.pid}.tmp`;
        writeFileSync(temp, String(n + 1)); renameSync(temp, c.data);
      } finally { addon.unlock(h); }
    }
    return { rounds: c.rounds, sidecarInodeBefore: inode, sidecarInodeAfter: statSync(path).ino };
  }
  if (c.op === 'rename') {
    const h = addon.tryLock(path), inode = statSync(path).ino;
    writeFileSync(c.data + '.tmp', 'renamed'); renameSync(c.data + '.tmp', c.data);
    const other = addon.tryLock(path); if (other) addon.unlock(other); addon.unlock(h);
    return { contenderAcquired: !!other, inodeBefore: inode, inodeAfter: statSync(path).ino };
  }
  throw new Error('unknown command');
}
console.log(JSON.stringify({ ready: true, pid: process.pid, version: process.version, bun: globalThis.Bun?.version ?? null, napi: process.versions.napi }));
for await (const line of createInterface({ input: process.stdin })) {
  try { console.log(JSON.stringify(await command(JSON.parse(line)))); }
  catch (e) { console.log(JSON.stringify({ error: e.message, stack: e.stack })); }
}
if (held) addon.unlock(held);
