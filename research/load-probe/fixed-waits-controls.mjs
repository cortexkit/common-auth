// Suppress one test observation at a time; Git's staging index preserves the live tests for restoration.
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const controls = []
const add = (file, name, kind = 'promise', nth = 1) =>
  controls.push({ file: `test/${file}.test.ts`, name, kind, nth })
add('store/pull', 'load and a reading request return while pulls that never resolve are pending', 'promise', 1)
add('store/pull', 'load and a reading request return while pulls that never resolve are pending', 'promise', 2)
add('store/hooks', 'work a hook schedules on a timer or a detached promise is rejected while the caller continuation succeeds')
add('store/renewal', 'the row and provider-wide locks across a paused provider call renew while a contender fails', 'state')
add('store/renewal', 'the store-lock list across one read-modify-write renews while a contender fails', 'state')
add('logger/engine', 'circular payload preserves non-circular fields and marks [Circular]', 'circular')
add('logger/engine', 'diamond shared ref (no cycle) serializes fully without [Circular]', 'diamond')
add('logger/engine', 'degrade-catch net still catches non-cycle throws (BigInt) and emits [unserializable]', 'bigint')
add('logger/engine', 'buffers until fifty lines or the 500 ms flush deadline', 'state')
add('logger/sink-only', 'a sink-only logger instance prints nothing and creates no file', 'sink')
for (const name of [
  'fires after the file changes',
  'observes a change made immediately after the watcher returns',
  'polls when directory watcher construction fails',
  'ignores sibling files that share the preferences name as a prefix',
]) add('tui-prefs/watcher', name, 'state')
add('sidebar-file/sidebar-file', 'sidebar lock renews with unchanged owner and private mode', 'state')
add('tui-prefs/tui-preferences', 'preferences renews its lease while a staged write is held', 'state')
add('dump/dump', 'a capped dumper evicts the oldest whole dumps after writing a new one', 'state')
add('cachekeep/warm', 'track self-arms an unstarted manager and the timer fires a due target')
add('commands/failure-projection', 'a late login failure is reported by its projected message, not its exception text')
add('commands/command-session-isolation', 'a second session interleaving inside the add await-window does not steal the add notification', 'promise', 1)
add('commands/command-session-isolation', 'a second session interleaving inside the add await-window does not steal the add notification', 'promise', 2)
add('claustrum/enrollment', 'serializes concurrent process instances so only one proposal is sent')
for (const name of [
  'a code login writes into the pool and leaves the host a placeholder',
  'an automatic login resolves to a placeholder only after the pool write',
  'a failed pool write fails the host login',
  'host refresh hands back a placeholder and never calls the pool',
]) add('opencode2/integration', name)
for (const name of [
  'RPC stop closes held partial requests under the running Bun',
  'RPC stop closes held partial requests under Node 24',
  'a pending apply does not keep the process alive after stop under the running Bun',
  'a pending apply does not keep the process alive after stop under Node 24',
]) add('rpc/stop-runtime', name)
add('rpc/client-proxy', 'loopback RPC client bypasses HTTP_PROXY, http_proxy and HTTPS_PROXY')
add('rpc/client-proxy', 'loopback RPC client under Node with NODE_USE_ENV_PROXY bypasses HTTP_PROXY')
const fsCases = [
  ['observes takeover on the next renewal and stops renewing', 2],
  ['assertOwned observes takeover with ownership details without renewal', 1],
  ['assertion loss fences an already in-flight renewal', 2],
  ['assertOwned observes unreadable ownership', 1],
  ['observes terminal renewal failure when the owner file becomes unreadable', 1],
  ['renewal errors stop immediately when ownership cannot remain live', 2],
  ['observes expiry when renewal cannot extend an expired lease', 1],
  ['does not let a stalled renewal overwrite a successor that stole its marker', 2],
  ['does not let a stalled release remove a successor that stole its marker', 1],
  ['waits for an in-flight renewal before release can remove the lock', 2],
  ['re-checks ownership after the renewal write seam before writing', 2],
  ['relinquishes the lock when its marker is stolen after the final renewal check', 3],
  ['preserves a successor record during post-write relinquish', 3],
  ['reschedules after a renewal marker failure throws', 2],
]
for (const [name, count] of fsCases)
  for (let nth = 1; nth <= count; nth++) add('fs/refresh-file-lock', name, 'promise', nth)

add('rpc/stop-runtime', 'a pending apply does not keep the process alive after stop under the running Bun', 'timer')
add('rpc/stop-runtime', 'a pending apply does not keep the process alive after stop under Node 24', 'timer')

add('store/hooks', 'every row operation and refresh called from an after-persist hook rejects immediately and the refresh still completes')
add('store/hooks', 'every row operation and refresh called from a refresh failure hook rejects immediately')

const git = (...args) => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const run = spawnSync('git', args, {
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    })
    if (run.status === 0) return run.stdout.trim()
    // Concurrent index refreshes can collide; retry only Git, never a test.
    if (!run.stderr.includes('index.lock')) throw new Error(run.stderr)
  }
  throw new Error(`Git index lock prevented ${args.join(' ')}`)
}
const start = Number(process.argv[2] ?? 0)
const results = start
  ? JSON.parse(readFileSync('research/load-probe/fixed-waits-controls.json', 'utf8'))
  : []
for (const control of controls.slice(start)) {
  const path = ['promise', 'state'].includes(control.kind)
    ? 'test/fixtures/observed.ts'
    : control.file
  git('add', path)
  if (git('diff', '--stat')) throw new Error('Working diff must be empty before mutation')
  const original = readFileSync(path, 'utf8')
  let mutant
  if (control.kind === 'promise') {
    mutant = `// NON-VACUITY BREAK: suppress one promise observation, not its underlying operation.\nlet observations = 0\n${original}`
      .replace('    promise,', `    (++observations === ${control.nth} ? new Promise<T>(() => {}) : promise),`)
  } else if (control.kind === 'state') {
    mutant = original.replace('    if (await check()) return', '    // NON-VACUITY BREAK: consume state but suppress the successful observation.\n    await check()')
  } else if (control.kind === 'timer') {
    mutant = original.replace('if (args[1] === 3000) applyTimer = timer;', 'if (args[1] === 3000) { /* NON-VACUITY BREAK: keep the real deadline referenced. */ applyTimer = timer; timer.unref = () => timer; }')
  } else if (control.kind === 'sink') {
    mutant = original.replace('(r) => records.push(r)', '(r) => { /* NON-VACUITY BREAK: suppress sink fixture delivery. */ }')
  } else {
    const emission = {
      circular: "expect(() => log.debug('circ-msg', circ)).not.toThrow()",
      diamond: "expect(() => log.debug('diamond-msg', diamond)).not.toThrow()",
      bigint: "expect(() => log.debug('bigint-msg', bad)).not.toThrow()",
    }[control.kind]
    mutant = original.replace(emission, '// NON-VACUITY BREAK: suppress the fixture log record before flushing.')
  }
  if (mutant === original) throw new Error(`Mutation did not match: ${control.name}`)
  writeFileSync(path, mutant)
  const during = git('diff', '--stat')
  if (!during) throw new Error('Mutation has no working diff')
  let run
  try {
    const pattern = `${control.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`
    run = spawnSync(process.execPath, ['test', control.file, '--test-name-pattern', pattern], { encoding: 'utf8', timeout: 45000 })
  } finally {
    git('checkout', '--', path)
    const touch = spawnSync('touch', [path])
    if (touch.status !== 0) throw new Error('touch failed')
  }
  const after = git('diff', '--stat')
  if (after) throw new Error('Working diff must be empty after restoring mutation')
  const output = `${run.stdout}\n${run.stderr}`
  const failed = output.split('\n').filter((line) => line.includes('(fail)'))
  const late = output.split('\n').filter((line) => line.startsWith('Late test body failure:'))
  const others = failed.filter((line) => !line.includes(control.name))
  const red = run.status !== 0 && failed.length === 1 && !others.length && failed[0].includes(control.name)
  const item = {
    control: `${control.kind} observation ${control.nth} suppressed for ${control.file}`,
    expected_red: control.name,
    captured_output: [...failed, ...late].join('\n').slice(0, 400),
    applied_evidence: `${path}: during: ${during}; after restore: empty git diff --stat`,
    outcome: run.error ? 'hung' : red ? 'reddened' : failed.length ? 'not_reached' : 'undefended',
    exit_code: run.status,
    other_failed_tests: others,
    late_failure_named: late.some((line) => line.includes(control.name)),
  }
  results.push(item)
  console.log(JSON.stringify(item))
  writeFileSync('research/load-probe/fixed-waits-controls.json', `${JSON.stringify(results, null, 2)}\n`)
  git('add', 'research/load-probe/fixed-waits-controls.json')
  if (!red || run.error) throw new Error(`Control did not fail only the intended test: ${control.name}\n${output}`)
}
console.log(JSON.stringify({ controls: results.length, reddened: results.filter((item) => item.outcome === 'reddened').length, runtime: Bun.version }))
