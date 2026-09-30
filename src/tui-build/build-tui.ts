import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isBareSpecifier, parseImports } from './walker.js'

export type TransformSolidSource = (
  code: string,
  options: {
    filename: string
    moduleName: string
    resolvePath: (specifier: string) => string | null
  },
) => Promise<string>
export interface BuildTuiOptions {
  inline?: (string | { name: string; root: string })[]
  runtimeModules?: string[]
  loadSolidTransform?: () => Promise<TransformSolidSource>
}
export interface TuiBuildResult {
  emitted: string[]
  sources: string[]
  selector: string
  externals: Set<string>
}
export const runtimeModules = [
  '@opentui/core',
  '@opentui/core/testing',
  '@opentui/solid',
  '@opentui/solid/components',
  '@opentui/solid/jsx-runtime',
  '@opentui/solid/jsx-dev-runtime',
  'solid-js',
  'solid-js/store',
]
export const runtimeModuleId = (specifier: string): string =>
  `opentui:runtime-module:${encodeURIComponent(specifier)}`

export async function loadSolidTransform(): Promise<TransformSolidSource> {
  const specifier = '@opentui/solid/scripts/solid-transform.js'
  try {
    return (await import(specifier)).transformSolidSource
  } catch {
    const require = createRequire(import.meta.url)
    const root = dirname(require.resolve('@opentui/solid/package.json'))
    return (
      await import(pathToFileURL(join(root, 'scripts/solid-transform.js')).href)
    ).transformSolidSource
  }
}

function exportTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(exportTarget).find(Boolean)
  if (value && typeof value === 'object') {
    const conditions = value as Record<string, unknown>
    for (const [key, condition] of Object.entries(conditions)) {
      if (!['bun', 'import', 'node', 'default'].includes(key)) continue
      const target = exportTarget(condition)
      if (target) return target
    }
  }
  return undefined
}

export async function buildTui(
  entryFile: string,
  variant: 'raw' | 'runtime',
  destinationDir: string,
  options: BuildTuiOptions = {},
): Promise<TuiBuildResult> {
  const entry = resolve(entryFile)
  const destination = resolve(destinationDir)
  const roots = new Map<string, string>()
  for (const item of options.inline ?? ['@cortexkit/common-auth']) {
    if (typeof item !== 'string') roots.set(item.name, resolve(item.root))
    else {
      let directory = dirname(entry)
      for (;;) {
        const manifest = join(directory, 'package.json')
        if (
          existsSync(manifest) &&
          JSON.parse(await readFile(manifest, 'utf8')).name === item
        ) {
          roots.set(item, realpathSync(directory))
          break
        }
        const installed = join(directory, 'node_modules', item)
        if (existsSync(join(installed, 'package.json'))) {
          roots.set(item, realpathSync(installed))
          break
        }
        const parent = dirname(directory)
        if (parent === directory)
          throw new Error(
            `Cannot locate package root for ${item} from ${entry}`,
          )
        directory = parent
      }
    }
  }
  const resolveExport = async (
    specifier: string,
    root: string,
    name: string,
  ) => {
    const manifest = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8'),
    )
    const subpath =
      specifier === name ? '.' : `.${specifier.slice(name.length)}`
    const exports = manifest.exports
    let target = exportTarget(
      exports?.[subpath] ?? (subpath === '.' ? exports : undefined),
    )
    if (!target && exports && typeof exports === 'object') {
      const patterns = Object.keys(exports)
        .filter((key) => key.includes('*'))
        .sort((a, b) => b.indexOf('*') - a.indexOf('*') || b.length - a.length)
      for (const pattern of patterns) {
        const [prefix = '', suffix = ''] = pattern.split('*')
        if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue
        const wildcard = subpath.slice(
          prefix.length,
          suffix ? -suffix.length : undefined,
        )
        target = exportTarget(exports[pattern])?.replaceAll('*', wildcard)
        break
      }
    }
    const absolute = target
      ? resolve(root, target)
      : `${root}/<missing exports ${subpath}>`
    if (!target || !existsSync(absolute))
      throw new Error(
        `Cannot inline ${specifier}: resolved target ${absolute} does not exist`,
      )
    return realpathSync(absolute)
  }
  const transform =
    variant === 'runtime'
      ? await (options.loadSolidTransform ?? loadSolidTransform)()
      : undefined
  const runtime = new Set(options.runtimeModules ?? runtimeModules)
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  const result: TuiBuildResult = {
    emitted: [],
    sources: [],
    selector: 'selector.js',
    externals: new Set(),
  }
  const copied = new Map<string, string>()
  const relativeImport = (from: string, to: string) => {
    const path = relative(dirname(from), to).split('\\').join('/')
    return path.startsWith('.') ? path : `./${path}`
  }
  const visit = async (source: string, shared: boolean): Promise<string> => {
    source = realpathSync(source)
    if (relative(dirname(entry), source).startsWith('../')) shared = true
    const previous = copied.get(source)
    if (previous) return previous
    const extension =
      variant === 'raw' && extname(source) === '.tsx' ? '.tsx' : '.js'
    const name = shared
      ? `shared/${createHash('sha256').update(source).digest('hex').slice(0, 16)}-${basename(source).replace(/\.[^.]+$/, '')}${extension}`
      : relative(dirname(entry), source).replace(/\.[^.]+$/, extension)
    if (name.startsWith('../'))
      throw new Error(`Entry dependency escapes source directory: ${source}`)
    copied.set(source, name)
    let code = await readFile(source, 'utf8')
    if (transform && /\.[jt]sx$/.test(source))
      code = await transform(code, {
        filename: source,
        moduleName: runtimeModuleId('@opentui/solid'),
        resolvePath: (specifier) =>
          runtime.has(specifier) ? runtimeModuleId(specifier) : null,
      })
    const references = parseImports(code, source)
    const replacements: { start: number; end: number; text: string }[] = []
    for (const reference of references) {
      let specifier = reference.specifier
      const inline = [...roots].find(
        ([name]) => specifier === name || specifier.startsWith(`${name}/`),
      )
      if (inline)
        specifier = relativeImport(
          name,
          await visit(
            await resolveExport(specifier, inline[1], inline[0]),
            true,
          ),
        )
      else if (specifier.startsWith('.')) {
        const base = resolve(dirname(source), specifier)
        const candidates = [
          base,
          base.replace(/\.js$/, '.ts'),
          base.replace(/\.js$/, '.tsx'),
          `${base}.ts`,
          `${base}.tsx`,
          `${base}.js`,
          join(base, 'index.ts'),
          join(base, 'index.js'),
        ]
        const target = candidates.find(existsSync)
        if (!target)
          throw new Error(`Missing relative import in ${source}: ${specifier}`)
        specifier = relativeImport(name, await visit(target, shared))
      } else if (variant === 'runtime' && runtime.has(specifier))
        specifier = runtimeModuleId(specifier)
      replacements.push({ ...reference, text: JSON.stringify(specifier) })
    }
    for (const replacement of replacements.reverse())
      code =
        code.slice(0, replacement.start) +
        replacement.text +
        code.slice(replacement.end)
    if (/\.[cm]?ts$/.test(source))
      code = new Bun.Transpiler({ loader: 'ts', target: 'bun' }).transformSync(
        code,
      )
    const output = join(destination, name)
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, code)
    for (const reference of parseImports(code, source)) {
      if (isBareSpecifier(reference.specifier))
        result.externals.add(reference.specifier)
    }
    result.emitted.push(name)
    result.sources.push(source)
    return name
  }
  await visit(entry, false)
  const selectorSource = fileURLToPath(
    import.meta.resolve('@cortexkit/common-auth/tui'),
  )
  await writeFile(
    join(destination, result.selector),
    await readFile(selectorSource),
  )
  result.emitted.push(result.selector)
  result.sources.push(selectorSource)
  return result
}
