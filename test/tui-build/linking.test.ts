import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildTui, loadSolidTransform } from '@cortexkit/common-auth/tui-build'
import { parseImports } from '../../src/tui-build/walker.js'
import { makeRepoScratchDir } from '../fixtures/scratch.js'

const entry = resolve('test/fixtures/tui/entry.tsx')
const fixtureRoot = resolve('test/fixtures/inline-default')
const inline = ['@cortexkit/common-auth', 'inline-default']
const sharedSources = [
  'dist/fs/index.js',
  'dist/fs/atomic-write.js',
  'dist/fs/lock-constants.js',
  'dist/fs/with-lock.js',
  'dist/fs/refresh-file-lock.js',
  'dist/sidebar-file/index.js',
  'dist/sidebar-file/sidebar-file.js',
  'dist/tui-prefs/index.js',
  'dist/tui-prefs/tui-preferences.js',
  'dist/tui-prefs/watcher.js',
  'test/fixtures/inline-default/module.ts',
]
const sharedName = (path: string) =>
  `shared/${createHash('sha256').update(resolve(path)).digest('hex').slice(0, 16)}-${path
    .split('/')
    .at(-1)!
    .replace(/\.[^.]+$/, '')}.js`

test('linking emits the exact closure and compiles runtime JSX through the encoded Solid runtime', async () => {
  const root = await makeRepoScratchDir()
  try {
    let rawLoads = 0
    let runtimeLoads = 0
    for (const variant of ['raw', 'runtime'] as const) {
      const destination = join(root, variant)
      await mkdir(destination)
      expect(
        createRequire(join(destination, 'x.js')).resolve('jsonc-parser'),
      ).toBeTruthy()
      await writeFile(join(destination, 'unimported.ts'), 'export default 0')
      const result = await buildTui(entry, variant, destination, {
        inline,
        loadSolidTransform:
          variant === 'raw'
            ? async () => {
                rawLoads++
                throw new Error('raw loaded transform')
              }
            : async () => {
                runtimeLoads++
                return loadSolidTransform()
              },
      })
      expect(new Set(result.emitted)).toEqual(
        new Set([
          variant === 'raw' ? 'entry.tsx' : 'entry.js',
          'store-user.js',
          'selector.js',
          ...sharedSources.map(sharedName),
        ]),
      )
      expect(existsSync(join(destination, 'unimported.ts'))).toBe(false)
      expect(result.sources.length).toBe(result.emitted.length)
      expect(
        result.sources.every(
          (source) => source.startsWith('/') && existsSync(source),
        ),
      ).toBe(true)
      expect(new Set(result.sources).size).toBe(result.sources.length)
      expect(result.externals).toEqual(
        variant === 'raw'
          ? new Set(['jsonc-parser', 'solid-js/store'])
          : new Set(['jsonc-parser']),
      )
      for (const name of result.emitted) {
        const code = await readFile(join(destination, name), 'utf8')
        expect(code).not.toContain('@cortexkit/common-auth')
        if (name === result.selector) continue
        for (const reference of parseImports(code, name)) {
          if (reference.specifier.startsWith('.'))
            expect(
              existsSync(
                resolve(dirname(join(destination, name)), reference.specifier),
              ),
            ).toBe(true)
        }
      }
      const sharedStoreCode = await readFile(
        join(destination, sharedName('test/fixtures/inline-default/module.ts')),
        'utf8',
      )
      expect(sharedStoreCode).toContain(
        variant === 'runtime'
          ? 'opentui:runtime-module:solid-js%2Fstore'
          : 'solid-js/store',
      )
      const storeCode = await readFile(
        join(destination, 'store-user.js'),
        'utf8',
      )
      expect(storeCode).toContain(
        variant === 'runtime'
          ? 'opentui:runtime-module:solid-js%2Fstore'
          : 'solid-js/store',
      )
      if (variant === 'runtime') {
        const compiled = await readFile(join(destination, 'entry.js'), 'utf8')
        expect(compiled).not.toContain('<box')
        expect(compiled).toContain('opentui:runtime-module:%40opentui%2Fsolid')
        expect(compiled).toContain('createElement')
      } else {
        const module = await import(
          pathToFileURL(join(destination, 'store-user.js')).href
        )
        expect(module.value).toBe('default survived')
        expect(module.alias).toBe(module.value)
        const fsModule = await import(
          pathToFileURL(join(destination, sharedName('dist/fs/index.js'))).href
        )
        expect(module.LockContentionError).toBe(fsModule.LockContentionError)
      }
      const selector = await import(
        pathToFileURL(join(destination, result.selector)).href
      )
      expect(typeof selector.loadTui).toBe('function')
    }
    expect(rawLoads).toBe(0)
    expect(runtimeLoads).toBe(1)
    expect(existsSync(join(root, 'raw/entry.tsx'))).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('walker rejects non-literal dynamic imports and missing inline export targets with context', async () => {
  const root = await makeRepoScratchDir()
  try {
    const source = join(root, 'entry.ts')
    await writeFile(
      source,
      'const variable = "./other.js"; export const load = () => import(variable)',
    )
    await expect(
      buildTui(source, 'raw', join(root, 'out'), { inline: [] }),
    ).rejects.toThrow(`Non-literal dynamic import in ${source}: variable`)
    await writeFile(source, 'export { default } from "inline-default/missing"')
    await expect(
      buildTui(source, 'raw', join(root, 'out'), { inline }),
    ).rejects.toThrow(
      `Cannot inline inline-default/missing: resolved target ${fixtureRoot}/absent.ts`,
    )
    await writeFile(source, 'export { default } from "inline-default/unknown"')
    await expect(
      buildTui(source, 'raw', join(root, 'out'), { inline }),
    ).rejects.toThrow('inline-default/unknown')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('walker parses static, re-export and literal dynamic imports while ignoring comments', () => {
  expect(
    parseImports(
      '/* import("wrong") */ import x from "a"; export * from "b"; import("c"); const s = "import(unknown)";',
      'fixture',
    ).map((reference) => reference.specifier),
  ).toEqual(['a', 'b', 'c'])
})

test('walker distinguishes regex bodies and traverses template expressions', () => {
  expect(
    parseImports(
      `const pattern = /import("not-a-module")/; const value = \`text \${import("real")}\`;`,
      'fixture',
    ).map((reference) => reference.specifier),
  ).toEqual(['real'])
  expect(() =>
    parseImports(`const value = \`text \${import(variable)}\`;`, 'template.ts'),
  ).toThrow('template.ts: variable')
})

test('inlined fs and sidebar consumers share one LockContentionError identity', async () => {
  const root = await makeRepoScratchDir()
  try {
    const result = await buildTui(entry, 'raw', root, { inline })
    const store = await import(pathToFileURL(join(root, 'store-user.js')).href)
    const sidebar = join(root, sharedName('dist/sidebar-file/sidebar-file.js'))
    const imports = parseImports(await readFile(sidebar, 'utf8'), sidebar)
    const fsImport = imports.find((reference) =>
      reference.specifier.startsWith('.'),
    )
    if (!fsImport)
      throw new Error('Sidebar module has no inlined fs dependency')
    const sidebarFs = await import(
      pathToFileURL(resolve(dirname(sidebar), fsImport.specifier)).href
    )
    expect(sidebarFs.LockContentionError).toBe(store.LockContentionError)
    expect(
      result.sources.filter(
        (source) => source === resolve('dist/fs/with-lock.js'),
      ),
    ).toHaveLength(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
