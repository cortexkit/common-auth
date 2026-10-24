// @ts-check
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

assert.equal(process.platform, 'win32')
assert.ok(process.env.SystemRoot)
assert.ok(process.env.LOCALAPPDATA)
const powershell = join(
  process.env.SystemRoot,
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => key.toUpperCase() !== 'PSMODULEPATH',
  ),
)
const root = mkdtempSync(join(process.env.LOCALAPPDATA, 'inspector-warm-'))
try {
  const file = join(root, 'control.txt')
  writeFileSync(file, 'ACL inspector warm-up control')
  // A separate process per sample includes PowerShell startup, just like the tests.
  for (let sample = 0; sample < 4; sample++) {
    const timeout = sample === 0 ? 60_000 : 30_000
    const started = performance.now()
    console.error(`ACL inspector warm-up sample ${sample}: process launch`)
    const result = spawnSync(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        fileURLToPath(new URL('./inspect.ps1', import.meta.url)),
      ],
      {
        input: JSON.stringify({ action: 'inspect', paths: [root, file] }),
        encoding: 'utf8',
        windowsHide: true,
        env,
        timeout,
      },
    )
    const elapsedMs = Math.round(performance.now() - started)
    process.stderr.write(result.stderr ?? '')
    console.log(
      JSON.stringify({
        event: 'inspector-timing',
        sample,
        cold: sample === 0,
        elapsedMs,
        timeoutMs: timeout,
        status: result.status,
        error: result.error?.message,
      }),
    )
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stdout)
    const inspected = JSON.parse(result.stdout)
    assert.equal(inspected.filesystem, 'NTFS')
    assert.deepEqual(
      inspected.objects.map(
        /** @param {{ path: string, directory: boolean }} object */
        (object) => [object.path, object.directory],
      ),
      [
        [root, true],
        [file, false],
      ],
    )
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
