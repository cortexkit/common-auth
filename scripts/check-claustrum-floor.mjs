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
  // claustrum-client 0.6.2 depends on subc-client ^0.16.0; pin that line too
  // so the floor tree holds one subc-client copy, as a real 0.6.2 host does.
  pkg.devDependencies['@cortexkit/subc-client'] = '0.16.1'
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
    // common-auth and claustrum-client must load the same subc-client.
    const { realpathSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    const ours = realpathSync(Bun.resolveSync('@cortexkit/subc-client', process.cwd()))
    const theirs = realpathSync(Bun.resolveSync('@cortexkit/subc-client', dirname(realpathSync(entry))))
    if (ours !== theirs) throw new Error('Expected one subc-client copy, found ' + ours + ' and ' + theirs)
    let subcDir = ours
    let subcVersion
    while (subcDir !== '/') {
      try {
        const manifest = JSON.parse(readFileSync(subcDir + '/package.json', 'utf8'))
        if (manifest.name === '@cortexkit/subc-client') {
          subcVersion = manifest.version
          break
        }
      } catch {}
      subcDir = subcDir.slice(0, subcDir.lastIndexOf('/'))
    }
    if (subcVersion !== '0.16.1') throw new Error('Expected subc-client 0.16.1, loaded ' + (subcVersion ?? 'unknown package version'))
    console.log('Loaded one @cortexkit/subc-client ' + subcVersion)
  `], scratch)
  run('bun', ['test', 'test/claustrum/'], scratch)
  run('bun', ['run', 'build'], scratch)
  run('bun', ['run', 'typecheck'], scratch)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
