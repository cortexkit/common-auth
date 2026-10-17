// Exercise an actual packed consumer install, not this repository's dev tree:
// the optional peer and claustrum-client must resolve one transport instance.
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = await mkdtemp(join(tmpdir(), 'common-auth-insula-peer-'))
const bun = process.execPath
function run(args, cwd) {
  const result = spawnSync(bun, args, { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`bun ${args.join(' ')} failed (${result.status})`)
}

try {
  run(['run', 'build'], root)
  run(['pm', 'pack', '--destination', scratch, '--ignore-scripts'], root)
  const archive = (await readdir(scratch)).find(name => name.endsWith('.tgz'))
  if (!archive) throw new Error('pack produced no archive')
  await writeFile(join(scratch, 'package.json'), JSON.stringify({
    name: 'insula-peer-consumer', private: true, type: 'module',
    dependencies: { '@cortexkit/common-auth': `file:./${archive}`, '@cortexkit/claustrum-client': '0.10.0' },
  }))
  run(['install', '--ignore-scripts'], scratch)
  const instances = new Set()
  const visited = new Set()
  async function walk(path) {
    if (!(await stat(path)).isDirectory()) return
    const canonical = await realpath(path)
    if (visited.has(canonical)) return
    visited.add(canonical)
    if (path.endsWith('/@cortexkit/subc-client')) {
      const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'))
      if (manifest.name === '@cortexkit/subc-client') instances.add(canonical)
    }
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        await walk(join(path, entry.name))
      }
    }
  }
  await walk(join(scratch, 'node_modules'))
  if (instances.size !== 1) throw new Error(`insula-peer-single-copy: Expected exactly one subc-client installation, found ${instances.size}`)
  run(['-e', `
    const api = await import('@cortexkit/common-auth/claustrum')
    if (typeof api.ClaustrumConsumer.prototype.cachedInsulaQuota !== 'function') {
      throw new Error('packed consumer has no insula quota API')
    }
    console.log('PASS: packed /claustrum imports and exposes the insula quota API')
  `], scratch)
  console.log('PASS: fresh claustrum-client 0.10.0 consumer installs exactly one subc-client (2 packaging checks)')
} finally {
  await rm(scratch, { recursive: true, force: true })
}
