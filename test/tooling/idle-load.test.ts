import { expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function probe(
  mode: 'default' | 'exit' | 'SIGINT' | 'SIGTERM' | 'error' | 'killed',
) {
  const dir = await mkdtemp(join(tmpdir(), 'load-probe-'))
  const marker = join(dir, 'workers')
  const preload = join(dir, 'idle.cjs')
  const executable = join(dir, 'test-bun')
  // Keep real process creation and group cleanup, but replace only the busy-loop
  // payload with idle workers so this regression test never generates CPU load.
  await writeFile(
    preload,
    `
    const cp = require('node:child_process');
    const real = cp.spawn;
    cp.spawn = function(file, args, options) {
      if (args?.[0] === '-e' && args[1] === 'for (;;) { Math.sqrt(Math.random()) }') {
        args = ['-e', ${JSON.stringify("require('node:fs').appendFileSync(process.env.WORKER_MARKER, process.pid + '\\n'); setInterval(() => {}, 1000)")}];
      }
      return real.call(this, file, args, options);
    };
  `,
  )
  // The fake test runner is a child of the probe but outside its load group, so
  // nothing kills it if the probe itself is SIGKILLed. It records its pid for
  // teardown, and its wait is bounded and stops once the test removes its
  // directory, so it can never outlive the test as an orphan.
  const runnerPid = join(dir, 'runner.pid')
  const wait = `i=0; while [ ! -s "$WORKER_MARKER" ]; do [ -d "${dir}" ] || exit 0; i=$((i+1)); [ "$i" -gt 500 ] && exit 1; sleep 0.01; done`
  await writeFile(
    executable,
    `#!/bin/sh\necho $$ > "${runnerPid}"\n${mode === 'default' ? 'exit 0' : `${wait}\n${mode === 'SIGINT' || mode === 'SIGTERM' ? 'exec sleep 30' : 'sleep 0.1\nexit 0'}`}\n`,
    { mode: 0o700 },
  )
  const child = spawn(
    'node',
    [
      'scripts/load-probe.mjs',
      'fixture',
      'fixture',
      '1',
      ...(mode === 'default' || mode === 'killed' ? [] : ['--workers', '2']),
    ],
    {
      env: {
        ...process.env,
        NODE_OPTIONS: `--require=${preload}`,
        WORKER_MARKER: marker,
        TEST_BUN: mode === 'error' ? join(dir, 'absent') : executable,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stdout = ''
  let stderr = ''
  let groupPid: number | null = null
  let sent = false
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  child.stdout.on('data', (chunk) => {
    stdout += chunk
    const line = stdout.split('\n')[0]
    if (!line?.endsWith('}')) return
    groupPid = (JSON.parse(line) as { loadGroupPid: number | null })
      .loadGroupPid
    // No workers are started, so the runner waits for a marker that never
    // comes; SIGKILL leaves the probe no chance to stop it.
    if (!sent && mode === 'killed') {
      sent = true
      void (async () => {
        // Kill only once the runner is up, so the case it guards is real.
        for (let attempt = 0; attempt < 300; attempt++) {
          if (await readFile(runnerPid, 'utf8').catch(() => '')) break
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        child.kill('SIGKILL')
      })()
    }
    if (!sent && (mode === 'SIGINT' || mode === 'SIGTERM')) {
      sent = true
      void (async () => {
        for (let attempt = 0; attempt < 200; attempt++) {
          const workers = await readFile(marker, 'utf8').catch(() => '')
          if (workers.trim().split('\n').filter(Boolean).length === 2) break
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        child.kill(mode)
      })()
    }
  })
  const deadline = setTimeout(() => child.kill('SIGKILL'), 4_000)
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', resolve)
    })
    const workers = await readFile(marker, 'utf8').catch(() => '')
    // Dead processes can remain as zombies briefly on a Linux runner; neither a
    // zombie nor an absent process can continue generating load.
    const pids = [
      groupPid,
      ...workers.trim().split('\n').filter(Boolean).map(Number),
    ].filter((pid): pid is number => pid !== null)
    for (const pid of pids) {
      const status = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], {
        encoding: 'utf8',
      }).stdout.trim()
      expect(
        status === '' || status.startsWith('Z'),
        `load process ${pid} stopped`,
      ).toBe(true)
    }
    return { code, stdout, stderr, workers }
  } finally {
    clearTimeout(deadline)
    if (groupPid) {
      try {
        process.kill(-groupPid, 'SIGKILL')
      } catch {}
    }
    child.kill('SIGKILL')
    const runner = Number(await readFile(runnerPid, 'utf8').catch(() => ''))
    if (runner > 0) {
      try {
        process.kill(runner, 'SIGKILL')
      } catch {}
    }
    await rm(dir, { recursive: true, force: true })
    if (runner > 0) lastRunner = runner
  }
}
let lastRunner = 0

test('load probe generates zero workers by default', async () => {
  const out = await probe('default')
  expect(out.code).toBe(0)
  expect(JSON.parse(out.stdout.split('\n')[0]!).workers).toBe(0)
  expect(out.workers).toBe('')
  expect(out.stderr).not.toContain('WARNING')
})

test('explicit load flag warns with worker count and stops the process group on completion', async () => {
  const out = await probe('exit')
  expect(out.code).toBe(0)
  expect(out.stderr).toContain('WARNING: generating CPU load with 2 workers')
  expect(out.workers.trim().split('\n')).toHaveLength(2)
})

for (const mode of ['SIGINT', 'SIGTERM', 'error'] as const) {
  test(`load probe stops its process group on ${mode}`, async () => {
    const out = await probe(mode)
    expect(out.code).toBe(
      mode === 'SIGINT' ? 130 : mode === 'SIGTERM' ? 143 : 1,
    )
    expect(out.stderr).toContain('WARNING: generating CPU load with 2 workers')
    if (mode !== 'error') expect(out.workers.trim().split('\n')).toHaveLength(2)
  })
}

test('a SIGKILLed probe leaves no fake test runner behind', async () => {
  lastRunner = 0
  await probe('killed')
  expect(lastRunner, 'the fake runner started').toBeGreaterThan(0)
  await new Promise((resolve) => setTimeout(resolve, 300))
  const status = spawnSync('ps', ['-o', 'stat=', '-p', String(lastRunner)], {
    encoding: 'utf8',
  }).stdout.trim()
  expect(
    status === '' || status.startsWith('Z'),
    'the fake runner did not outlive the test',
  ).toBe(true)
})

test('release publish relies on exactly one prepublishOnly build', async () => {
  const workflow = await readFile('.github/workflows/release.yaml', 'utf8')
  const publish = workflow.split('  publish:')[1]!
  const pkg = JSON.parse(await readFile('package.json', 'utf8')) as {
    scripts: { prepublishOnly: string }
  }
  expect(pkg.scripts.prepublishOnly).toBe('bun run build')
  expect(publish).toContain('run: npm publish --access public --provenance')
  expect(publish).not.toMatch(/^\s*run: bun run build$/m)
})
