#!/usr/bin/env bun
import { readFileSync } from 'node:fs'

function decodeXml(value) {
  return value.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (_, entity) => {
      if (entity.startsWith('#')) {
        return String.fromCodePoint(
          entity[1].toLowerCase() === 'x'
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10),
        )
      }
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[
        entity.toLowerCase()
      ]
    },
  )
}

function attribute(attributes, name) {
  const match = attributes.match(
    new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 's'),
  )
  return match ? decodeXml(match[2]) : ''
}

function executedTitles(xml) {
  const titles = new Set()
  // Bun emits either self-closing passing cases or cases with outcome children.
  for (const match of xml.matchAll(
    /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase\s*>)/g,
  )) {
    if (/<(?:skipped|failure|error)\b/.test(match[2] ?? '')) continue
    const name = attribute(match[1], 'name')
    if (!name) continue
    const classname = attribute(match[1], 'classname')
    titles.add(name)
    // Some Bun versions prefix the name with describe groups; others use classname.
    if (classname && name.startsWith(`${classname} > `)) {
      titles.add(name.slice(classname.length + 3))
    }
    titles.add(name.split(' > ').at(-1))
  }
  return titles
}

function testCells(markdown) {
  let testColumn = -1
  const cells = []
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const columns = line
      .trim()
      .slice(1)
      .replace(/\|\s*$/, '')
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim())
    if (columns.includes('component') && columns.includes('test')) {
      testColumn = columns.indexOf('test')
      continue
    }
    if (testColumn < 0 || columns.every((cell) => /^:?-+:?$/.test(cell)))
      continue
    const cell = columns[testColumn]
    if (cell === undefined) continue
    cells.push(cell.replace(/^`(.*)`$/, '$1').replace(/\\\|/g, '|'))
  }
  return cells
}

const [sourcesPath, artifactPath] = process.argv.slice(2)
if (!sourcesPath || !artifactPath) {
  console.error(
    'Usage: bun scripts/check-sources.mjs docs/sources.md test-results.xml',
  )
  process.exit(1)
}
const cells = testCells(readFileSync(sourcesPath, 'utf8'))
const titles = executedTitles(readFileSync(artifactPath, 'utf8'))
const unmatched = cells.filter((cell) => !titles.has(cell))
console.log(
  `sources: ${cells.length} cells parsed, ${cells.length - unmatched.length} cells matched`,
)
if (cells.length === 0 || unmatched.length > 0) {
  if (cells.length === 0) console.error('No source test cells parsed')
  for (const cell of unmatched)
    console.error(`Source test did not pass in artifact: ${cell}`)
  process.exit(1)
}
