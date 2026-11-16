#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const LIMIT = 5000
// Each exception must have { path, maxLines, reason }; remove it once split.
const exceptions = []

function isSource(path) {
  // Tests live in test/, nested tests/ and fixtures/ directories, including
  // packages/opencode/src/tests/; test and spec filename suffixes are also exempt.
  return (
    /\.(?:ts|tsx|mts|mjs|js|cjs)$/.test(path) &&
    !/\.d\.ts$/.test(path) &&
    !/\.(?:test|spec)\./.test(path) &&
    !/(?:^|\/)(?:test|tests|fixtures|__tests__|__fixtures__)(?:\/|$)/.test(path) &&
    !/(?:^|\/)(?:generated|__generated__)(?:\/|$)/.test(path) &&
    !/\.generated\.(?:ts|tsx|mts|mjs|js|cjs)$/.test(path)
  )
}

export function checkSourceSize(root, paths, exceptions) {
  const errors = []
  const remaining = new Map(exceptions.map((entry) => [entry.path, entry]))
  for (const path of paths) {
    if (!isSource(path)) continue
    let content
    try {
      content = readFileSync(resolve(root, path), 'utf8')
    } catch (error) {
      errors.push(`${path}: cannot read file: ${error.message}`)
      continue
    }
    // Generated source commonly declares itself in its header.
    if (/^\s*(?:\/\/|\/\*|\*)[^\n]*(?:@generated|automatically generated|do not edit)/im.test(content.slice(0, 2048))) continue
    const count = content === '' ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0)
    const exception = remaining.get(path)
    if (exception) {
      remaining.delete(path)
      if (count < LIMIT) errors.push(`${path}: stale exception (${count} lines)`)
      else if (count > exception.maxLines) errors.push(`${path}: ${count} lines exceeds exception cap ${exception.maxLines}`)
    } else if (count >= LIMIT) {
      errors.push(`${path}: ${count} lines reaches the ${LIMIT}-line limit`)
    }
  }
  for (const path of remaining.keys()) errors.push(`${path}: stale exception (file missing or exempt)`)
  return errors
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
  const errors = checkSourceSize(process.cwd(), paths, exceptions)
  for (const error of errors) console.error(error)
  if (errors.length) process.exitCode = 1
  else console.log('Source file sizes are within limits')
}
