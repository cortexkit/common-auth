import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = await mkdtemp(join(tmpdir(), 'common-auth-claustrum-floor-'))
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

try {
  await cp(root, scratch, {
    recursive: true,
    filter: (source) => !source.includes('/.git') && !source.includes('/node_modules') && !source.endsWith('/dist'),
  })
  const pkgPath = join(scratch, 'package.json')
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
  pkg.devDependencies['@cortexkit/claustrum-client'] = '0.6.2'
  await (await import('node:fs/promises')).writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  run('bun', ['install', '--no-save', '--ignore-scripts'], scratch)
  run('bun', ['-e', `
    import { readFileSync } from 'node:fs'
    import { fileURLToPath } from 'node:url'
    const entry = fileURLToPath(import.meta.resolve('@cortexkit/claustrum-client'))
    let directory = entry
    let version
    while (directory !== '/') {
      try {
        const manifest = JSON.parse(readFileSync(directory + '/package.json', 'utf8'))
        if (manifest.name === '@cortexkit/claustrum-client') {
          version = manifest.version
          break
        }
      } catch {}
      directory = directory.slice(0, directory.lastIndexOf('/'))
    }
    if (version !== '0.6.2') throw new Error('Expected claustrum-client 0.6.2, loaded ' + (version ?? 'unknown package version'))
    console.log('Loaded @cortexkit/claustrum-client ' + version)
  `], scratch)
  run('bun', ['test', 'test/claustrum/'], scratch)
  run('bun', ['run', 'build'], scratch)
  run('bun', ['run', 'typecheck'], scratch)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
