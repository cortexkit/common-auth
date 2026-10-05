import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { parse } from 'jsonc-parser'

const root = path.resolve(
  process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
)
const dependencyFields = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'overrides',
  'resolutions',
]
const offenders = []

async function packageFiles(directory) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) found.push(...(await packageFiles(fullPath)))
    else if (entry.isFile() && entry.name === 'package.json') found.push(fullPath)
  }
  return found
}

function outsideRoot(resolved) {
  const relative = path.relative(root, resolved)
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
}

function checkSpec(file, field, name, spec, base) {
  if (typeof spec !== 'string' || spec.startsWith('workspace:')) return
  const protocol = /^(?:file|link|portal):/.test(spec)
  const barePath = /^(?:\\.\\.?\/|\/|~\/)/.test(spec)
  if (!protocol && !barePath) return
  const rawPath = protocol ? spec.slice(spec.indexOf(':') + 1) : spec
  const resolved = path.resolve(base, rawPath.startsWith('~/') ? path.join(homedir(), rawPath.slice(2)) : rawPath)
  if (outsideRoot(resolved)) {
    offenders.push({ file: path.relative(root, file), field, name, spec, resolved })
  }
}

const manifests = await packageFiles(root)
for (const file of manifests) {
  const manifest = JSON.parse(await readFile(file, 'utf8'))
  for (const field of dependencyFields) {
    const values = manifest[field]
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue
    for (const [name, spec] of Object.entries(values)) {
      checkSpec(file, field, name, spec, path.dirname(file))
    }
  }
}

const lockPath = path.join(root, 'bun.lock')
try {
  const lock = parse(await readFile(lockPath, 'utf8'))
  // Each `workspaces` entry copies a package.json's dependency specs, relative
  // to that package's directory (the entry's key, "" for the root). The
  // `packages` section repeats the same resolutions without their protocol,
  // so the workspace entries are the ones to check.
  for (const [workspace, manifest] of Object.entries(lock.workspaces ?? {})) {
    const base = path.resolve(root, workspace)
    for (const field of dependencyFields) {
      const values = manifest[field]
      if (!values || typeof values !== 'object' || Array.isArray(values)) continue
      for (const [name, spec] of Object.entries(values)) {
        checkSpec(lockPath, field, name, spec, base)
      }
    }
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

// A scan that read nothing would pass vacuously (a wrong root, a renamed
// layout), so an empty census is a failure of the check itself.
if (manifests.length === 0) {
  console.error(`no package.json found under ${root}; nothing was checked`)
  process.exit(2)
}
if (offenders.length) {
  for (const item of offenders) {
    console.error(`${item.file}: ${item.field} ${item.name}=${item.spec} resolves to ${item.resolved}`)
  }
  process.exitCode = 1
} else {
  console.log(`local dependencies ok (${manifests.length} package.json checked)`)
}
