import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createProcessFence,
  listSetupProcesses,
} from '@cortexkit/common-auth/setup'

assert.equal(
  process.platform,
  'win32',
  'This smoke exercises real Windows tasklist and CIM',
)
const processes = await listSetupProcesses()
assert.ok(
  processes.some((entry) => entry.pid === process.pid),
  'Real listing includes the current Node process',
)
let checks = 1
const root = mkdtempSync(join(tmpdir(), 'common-auth-windows-processes-'))
const scriptDir = join(
  root,
  'node_modules',
  '@earendil-works',
  'pi-coding-agent',
  'dist',
  'bundle',
)
mkdirSync(scriptDir, { recursive: true })
const script = join(scriptDir, 'cli.js')
// Use Pi's published entry-script path so tasklist sees only the Node/Bun image name.
writeFileSync(
  script,
  'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)\n',
)
try {
  for (const runtime of [process.execPath, 'bun.exe']) {
    const child = spawn(
      runtime,
      [script, '--secret', 'do-not-print-process-arguments'],
      { windowsHide: true },
    )
    const exited = once(child, 'close')
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Host fixture did not start')),
          20_000,
        )
        child.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.stdout.on('data', () => {
          clearTimeout(timer)
          resolve()
        })
      })
      const fence = createProcessFence()
      const hosts = await fence.listRunningHosts()
      assert.ok(
        hosts.some((entry) => entry.pid === child.pid),
        'Real Windows inspection identifies the Pi entry script behind its runtime',
      )
      checks++
      const { assertHostsStopped } = await import(
        '@cortexkit/common-auth/setup'
      )
      await assert.rejects(assertHostsStopped(fence), (error) => {
        assert.ok(error.message.includes('Please quit'))
        assert.ok(!error.message.includes('do-not-print-process-arguments'))
        return true
      })
      checks++
    } finally {
      child.kill()
      await exited
    }
  }
  console.log(
    `${process.version} ${process.platform}/${process.arch}: ${checks} real process checks passed (${processes.length} processes listed)`,
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}
