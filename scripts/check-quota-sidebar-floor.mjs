import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = await mkdtemp(join(tmpdir(), 'common-auth-sidebar-045-'))
const run = (args) => {
  const result = spawnSync('bun', args, { cwd: scratch, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Bun ${args.join(' ')} exited ${result.status}`)
}
try {
  // Isolate the authored frame from the newer compiler/loader toolchain.
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  await writeFile(join(scratch, 'package.json'), JSON.stringify({
    name: pkg.name, type: 'module',
    exports: { './quota-sidebar': './src/quota-sidebar/index.tsx', './quota': './src/quota/index.ts' },
    dependencies: { '@opentui/core': '0.4.5', '@opentui/solid': '0.4.5', 'solid-js': '1.9.12', typescript: pkg.devDependencies.typescript, '@types/bun': pkg.devDependencies['@types/bun'] },
  }))
  for (const path of ['src/quota', 'src/quota-sidebar', 'test/quota-sidebar']) {
    await cp(join(root, path), join(scratch, path), { recursive: true })
  }
  await writeFile(join(scratch, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ESNext', module: 'Preserve', moduleResolution: 'Bundler', strict: true, skipLibCheck: true, noEmit: true, jsx: 'preserve', jsxImportSource: '@opentui/solid', types: ['bun'], allowImportingTsExtensions: true },
    include: ['src/quota-sidebar/**/*.tsx', 'test/quota-sidebar/**/*.tsx', 'test/quota-sidebar/**/*.ts'],
  }))
  run(['install', '--ignore-scripts'])
  run(['-e', `for (const name of ['@opentui/core', '@opentui/solid']) {
    const pkg = await Bun.file(new URL(import.meta.resolve(name + '/package.json'))).json()
    if (pkg.version !== '0.4.5') throw new Error(name + ' floor not loaded')
    console.log('Loaded ' + name + ' ' + pkg.version)
  }`])
  run(['x', '--no-install', 'tsc', '--version'])
  run(['x', '--no-install', 'tsc', '--noEmit'])
  run(['test', 'test/quota-sidebar/rulings.test.ts', 'test/quota-sidebar/parity.test.ts', '--test-name-pattern', 'ruling|frozen'])
  console.log('Quota sidebar OpenTUI 0.4.5 floor: typecheck and rendered frames passed')
} finally {
  await rm(scratch, { recursive: true, force: true })
}
