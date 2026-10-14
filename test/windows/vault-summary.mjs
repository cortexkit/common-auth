// @ts-check
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** @type {readonly [string, string, string]} */
export const vaultTestNames = [
  'real Windows vault enrollment serves quota and reports a served 401 before disconnect',
  'real Windows second approval rewrites the enrollment token in place',
  'real Windows token parent rule refuses non-private and writable folders by name',
]

/** @param {string} text @param {'node' | 'bun'} runtime */
export function assertVaultSummary(text, runtime) {
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')
  text = text.replace(/\r/g, '').replace(ansi, '')
  const completed = text.split('\n').flatMap((line) => {
    line = line.replace(/^# /, '').trim()
    if (!line.startsWith('{')) return []
    const event = JSON.parse(line)
    return event.event === 'test-pass' ? [event.test] : []
  })
  assert.deepEqual(
    completed.sort(),
    [...vaultTestNames].sort(),
    'all three vault scenarios must execute',
  )
  const required =
    runtime === 'node'
      ? [
          '^# tests 3$',
          '^# pass 3$',
          '^# fail 0$',
          '^# cancelled 0$',
          '^# skipped 0$',
          '^# todo 0$',
        ]
      : ['^\\s*3 pass$', '^\\s*0 fail$', '^Ran 3 tests across 1 file\\.']
  for (const pattern of required) assert.match(text, new RegExp(pattern, 'm'))
  assert.doesNotMatch(text, /^\s*[1-9]\d* (?:skip|todo|fail)\b/m)
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const runtime = process.argv[2]
  assert.ok(runtime === 'node' || runtime === 'bun')
  assert.ok(process.argv[3], 'a captured suite log is required')
  assertVaultSummary(await readFile(process.argv[3], 'utf8'), runtime)
  console.log(`Windows vault summary passed (3 executed tests, ${runtime})`)
}
