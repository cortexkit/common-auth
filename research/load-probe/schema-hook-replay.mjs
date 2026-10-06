// Replays the original test without generated load or altered deadlines.
// Stops after the first timeout, otherwise records at most ten natural runs.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const original = resolve(root, 'test/store/schema.test.ts')
const scratch = resolve(root, 'research/load-probe/.schema-replay')
const title = 'the unlocked legacy config read never observes a partial file during library writes'
let source = execFileSync('git', ['show', '5fd04fd7c10ad77db89cb89faf8cd61498d07021:test/store/schema.test.ts'], { cwd: root, encoding: 'utf8' })
source = source.replace(/from '([.][^']+)'/g, (_, path) => `from '${pathToFileURL(resolve(dirname(original), path)).href}'`)
source = source.replace("const hooks = lifetimeHooks()", `
const stamp = (phase) => console.log(JSON.stringify({ phase, ms: performance.now() }))
const hooks = lifetimeHooks()`)
source = source.replace('s = hooks.lifetime.manage(await scenario())', `s = hooks.lifetime.manage(await scenario())
  const owner = hooks.lifetime
  const drain = owner.drain.bind(owner)
  owner.drain = async (cleanup) => {
    stamp('drain-start')
    void Promise.allSettled(Reflect.get(owner, 'bodies')).then(() => stamp('body-join-complete'))
    void Promise.allSettled(Reflect.get(owner, 'operations')).then(() => stamp('operation-join-complete'))
    await drain(async () => {
      stamp('joins-and-finalizers-complete')
      stamp('cleanup-start')
      try { await cleanup() } finally { stamp('cleanup-end') }
    })
    stamp('drain-return')
  }`)
const start = source.indexOf(`it('${title}', async () => {`) + `it('${title}', async () => {`.length
const end = source.indexOf('\n  })', start)
source = source.slice(0, end) + "\n    } finally { stamp('body-finished') }" + source.slice(end)
source = source.slice(0, start) + "\n    stamp('body-start'); try {" + source.slice(start)
await mkdir(scratch, { recursive: true })
try {
  const path = resolve(scratch, 'schema.test.ts')
  await writeFile(path, source)
  for (let run = 1; run <= 10; run++) {
    const result = spawnSync(process.execPath, ['test', path, '--test-name-pattern', title], { cwd: root, encoding: 'utf8' })
    const output = result.stdout + result.stderr
    console.log(JSON.stringify({ run, runtime: Bun.version, code: result.status, output }))
    if (output.includes('timed out')) break
    if (result.status !== 0) throw new Error('replay failed without timeout')
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}
