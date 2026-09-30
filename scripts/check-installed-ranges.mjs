#!/usr/bin/env bun
// Check the installed tree before compiling, rather than trusting lockfile freshness.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const SECTIONS = ['dependencies', 'devDependencies']
// These specifiers name sources rather than registry version ranges.
const UNVERSIONED = /^(workspace:|file:|link:|git|github:|https?:|npm:)/

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function workspaceDirs() {
  const dirs = new Set([root])
  const workspaces = readJson(join(root, 'package.json')).workspaces ?? []
  const patterns = Array.isArray(workspaces) ? workspaces : workspaces.packages
  for (const pattern of patterns ?? []) {
    const glob = new Bun.Glob(`${pattern.replace(/\/$/, '')}/package.json`)
    for (const manifest of glob.scanSync({ cwd: root, onlyFiles: true })) {
      dirs.add(dirname(resolve(root, manifest)))
    }
  }
  return [...dirs].sort()
}

// Read manifests directly because many packages do not export package.json.
function installedVersion(fromDir, name) {
  let dir = fromDir
  while (true) {
    const manifest = join(dir, 'node_modules', name, 'package.json')
    if (existsSync(manifest)) return readJson(manifest).version
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

const problems = []
let checked = 0
for (const dir of workspaceDirs()) {
  const manifest = readJson(join(dir, 'package.json'))
  const label = manifest.name ?? dir
  for (const section of SECTIONS) {
    for (const [name, range] of Object.entries(manifest[section] ?? {})) {
      if (UNVERSIONED.test(range)) continue
      const version = installedVersion(dir, name)
      checked += 1
      if (version === undefined) {
        problems.push(`${label}: ${name} (${range}) is not installed`)
      } else if (!Bun.semver.satisfies(version, range)) {
        problems.push(
          `${label}: ${name} is installed at ${version}, outside the declared ${range}`,
        )
      }
    }
  }
}

if (problems.length > 0) {
  console.error('Installed dependencies do not match their declared ranges:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`installed ranges ok (${checked} dependencies checked)`)
