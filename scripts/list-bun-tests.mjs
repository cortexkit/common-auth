import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function decodeXml(value) {
  return value.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (_entity, name) => {
      if (name[0] === '#') {
        const codePoint =
          name[1].toLowerCase() === 'x'
            ? Number.parseInt(name.slice(2), 16)
            : Number.parseInt(name.slice(1), 10)
        return String.fromCodePoint(codePoint)
      }
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[
        name.toLowerCase()
      ]
    },
  )
}

function attributes(tag) {
  return Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, name, value]) => [
      name,
      decodeXml(value),
    ]),
  )
}

function listedNames(xml) {
  const suites = []
  const names = []
  const tags = /<testsuite\b([^>]*)>|<\/testsuite>|<testcase\b([^>]*?)(?:\/?>)/g
  for (const match of xml.matchAll(tags)) {
    if (match[1] !== undefined) {
      suites.push(attributes(match[1]).name)
      continue
    }
    if (match[0] === '</testsuite>') {
      suites.pop()
      continue
    }
    const testName = attributes(match[2]).name
    if (!testName) continue
    const describeNames = suites.slice(1).filter(Boolean)
    names.push([...describeNames, testName].join(' '))
  }
  return names
}

const args = process.argv.slice(2)
if (args.length !== 2) {
  fail('usage: bun scripts/list-bun-tests.mjs <test-file> <name-pattern>')
}
const [testFile, pattern] = args

let selector
try {
  selector = new RegExp(pattern)
} catch (error) {
  fail(`invalid Bun test-name pattern: ${error.message}`)
}

const temporaryDir = mkdtempSync(join(tmpdir(), 'ckdev-mutate-bun-list-'))
const reportPath = join(temporaryDir, 'junit.xml')
try {
  // A never-matching filter makes Bun list discovered tests as skipped without
  // executing their bodies; the JUnit suites retain their describe hierarchy.
  const result = spawnSync(
    'bun',
    [
      'test',
      testFile,
      '-t',
      '(?!)',
      '--reporter=junit',
      `--reporter-outfile=${reportPath}`,
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  )
  if (result.error) fail(`could not list Bun tests: ${result.error.message}`)

  let xml
  try {
    xml = readFileSync(reportPath, 'utf8')
  } catch {
    fail(
      `Bun did not produce a JUnit test listing for ${testFile}: ${(result.stderr || result.stdout).trim()}`,
    )
  }
  if (!xml.includes('<testsuites')) {
    fail(`Bun produced an invalid JUnit test listing for ${testFile}`)
  }

  const selected = listedNames(xml).filter((name) => selector.test(name))
  process.stdout.write(`${JSON.stringify(selected)}\n`)
} finally {
  rmSync(temporaryDir, { recursive: true, force: true })
}
