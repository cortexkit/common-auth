import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createOwnerOnly,
  readOwnerOnly,
  verifyOwnerOnly,
} from './package/dist/index.js'

const root = join(process.argv[2], `ckpf-standard-${crypto.randomUUID()}`)
try {
  await createOwnerOnly(root, { kind: 'dir' })
  const file = join(root, 'token')
  await createOwnerOnly(file, { kind: 'file' })
  await writeFile(file, 'standard-user bytes')
  assert.deepEqual(await verifyOwnerOnly(root), { ok: true })
  assert.deepEqual(await verifyOwnerOnly(file), { ok: true })
  assert.equal((await readOwnerOnly(file)).toString(), 'standard-user bytes')
  const script = fileURLToPath(new URL('./inspect.ps1', import.meta.url))
  const sd = await new Promise((resolve, reject) => {
    const child = spawn(
      join(
        process.env.SystemRoot,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      ['-NoProfile', '-NonInteractive', '-File', script, '-Mode', 'inspect'],
      {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: {
          ...process.env,
          PSModulePath: join(
            process.env.SystemRoot,
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'Modules',
          ),
        },
      },
    )
    let output = ''
    child.stdout.on('data', (bytes) => {
      output += bytes
    })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0
        ? resolve(JSON.parse(output))
        : reject(new Error('Standard-user inspector failed')),
    )
    child.stdin.end(JSON.stringify({ path: file }))
  })
  assert.equal(sd.owner, sd.currentUser)
  assert.equal(sd.defaultOwner, sd.currentUser)
  assert.deepEqual(sd.aces, [
    { type: 0, flags: 0, mask: 0x1f01ff, sid: sd.currentUser },
  ])
} finally {
  await rm(root, { recursive: true, force: true })
}
