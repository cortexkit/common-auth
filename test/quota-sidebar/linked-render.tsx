import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { cases, NOW } from './cases.js'
import { capture } from './render-support.js'

const [selectorPath, raw, runtime] = process.argv.slice(2)
if (!selectorPath || !raw || !runtime)
  throw new Error('Expected selector, raw entry and runtime entry')
const { loadTui } = await import(pathToFileURL(selectorPath).href)
const Frame = await loadTui({
  rawEntry: pathToFileURL(raw).href,
  runtimeEntry: pathToFileURL(runtime).href,
})
Date.now = () => NOW
const input = cases[0]
if (!input) throw new Error('Expected a parity case')
const frame = await capture(() => <Frame input={input} collapsed={false} />, 36)
const prefix = new URL(
  './goldens/blocked-pace-long-stat-expanded-36',
  import.meta.url,
)
assert.deepEqual(
  Buffer.from(frame.chars, 'utf8'),
  await readFile(`${prefix.pathname}.txt`),
)
assert.deepEqual(
  Buffer.from(`${JSON.stringify(frame.spans)}\n`),
  await readFile(`${prefix.pathname}.spans`),
)
console.log('linked quota sidebar uses host runtime and matches frozen frame')
