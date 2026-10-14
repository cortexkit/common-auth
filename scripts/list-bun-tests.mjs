import { mock } from 'bun:test'
import { existsSync, statSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [testFile, pattern] = process.argv.slice(2)

if (!testFile || pattern === undefined) {
  console.error('usage: bun scripts/list-bun-tests.mjs <test-file> <name-pattern>')
  process.exit(2)
}

const selectedNames = []
const describeNames = []

function defineTest(name) {
  selectedNames.push([...describeNames, String(name)].filter(Boolean).join(' '))
}

function defineSuite(name, body) {
  if (typeof body !== 'function') return
  describeNames.push(String(name))
  try {
    body()
  } finally {
    describeNames.pop()
  }
}

function formatEachName(title, value, index) {
  if (typeof title === 'function') {
    return title(...(Array.isArray(value) ? value : [value]))
  }

  const values = Array.isArray(value) ? value : [value]
  let valueIndex = 0
  return title.replace(/\$([\w]+)|%([sdifjoO#%])/g, (match, key, format) => {
    if (key) return String(value?.[key] ?? match)
    if (format === '%') return '%'
    if (format === '#') return String(index)
    const entry = values[valueIndex++]
    if (entry === undefined) return match
    if (format === 'd' || format === 'i' || format === 'f') return String(Number(entry))
    if (format === 'j') return JSON.stringify(entry)
    return String(entry)
  })
}

function test(name) {
  defineTest(name)
}

test.skip = test
test.todo = () => {}
test.only = test
test.skipIf = () => test
test.each = (cases) => (name) => {
  cases.forEach((value, index) => defineTest(formatEachName(name, value, index)))
}

function describe(name, body) {
  defineSuite(name, body)
}

describe.skip = describe
describe.todo = () => {}
describe.only = describe
describe.skipIf = () => describe
describe.each = (cases) => (name, body) => {
  cases.forEach((value, index) =>
    defineSuite(formatEachName(name, value, index), () => body(value)),
  )
}

const noop = () => {}
const mockedTestApi = {
  afterAll: noop,
  afterEach: noop,
  beforeAll: noop,
  beforeEach: noop,
  describe,
  expect: () => new Proxy(noop, { get: () => noop }),
  it: test,
  mock: { module: noop, restore: noop, restoreAll: noop },
  spyOn: () => new Proxy(noop, { get: () => noop }),
  suite: describe,
  test,
}

// Bun has no list-only test command, so registration is captured without invoking
// callbacks. This lets the listing apply Bun's own JavaScript regex matching.
mock.module('bun:test', () => mockedTestApi)

const imported = new Set()
const registrationModules = []

function localImports(source) {
  return Array.from(
    source.matchAll(
      /\b(?:import|export)\s+(?:[^'"]*?\s+from\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ),
    (match) => match[1] ?? match[2],
  )
}

function resolveImport(from, specifier) {
  if (!specifier.startsWith('.')) return undefined
  const base = resolve(dirname(from), specifier)
  const extension = extname(base)
  const candidates = extension
    ? [
        base,
        ...(extension === '.js'
          ? [base.slice(0, -3) + '.ts', base.slice(0, -3) + '.tsx']
          : []),
      ]
    : [base, ...['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'].map((ext) => base + ext)]
  candidates.push(
    ...['index.ts', 'index.tsx', 'index.js', 'index.mjs'].map((name) => resolve(base, name)),
  )
  return candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile()
    } catch {
      return false
    }
  })
}

async function loadTestModules(filename) {
  const absolute = resolve(filename)
  if (imported.has(absolute) || !existsSync(absolute)) return
  imported.add(absolute)

  const source = await Bun.file(absolute).text()
  const dependencies = localImports(source)
  for (const specifier of dependencies) {
    const dependency = resolveImport(absolute, specifier)
    if (dependency) await loadTestModules(dependency)
  }

  if (dependencies.includes('bun:test')) registrationModules.push(absolute)
}

await loadTestModules(testFile)
for (const modulePath of registrationModules) {
  await import(pathToFileURL(modulePath).href)
}

const matcher = new RegExp(pattern)
console.log(JSON.stringify(selectedNames.filter((name) => matcher.test(name))))
