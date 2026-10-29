import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { cases, NOW, widths } from './cases.js'
import { ParityFrame } from './parity-frame.js'
import { capture } from './render-support.js'

Date.now = () => NOW
let checked = 0
for (const input of cases) {
  for (const collapsed of [false, true]) {
    for (const width of widths) {
      const key = `${input.name}-${collapsed ? 'collapsed' : 'expanded'}-${width}`
      const actual = await capture(
        () => <ParityFrame input={input} collapsed={collapsed} />,
        width,
      )
      const expected = await readFile(
        new URL(`./goldens/${key}.txt`, import.meta.url),
      )
      assert.deepEqual(
        Buffer.from(actual.chars, 'utf8'),
        expected,
        `${key}: raw UTF-8 frame`,
      )
      assert.deepEqual(
        Buffer.from(`${JSON.stringify(actual.spans)}\n`, 'utf8'),
        await readFile(new URL(`./goldens/${key}.spans`, import.meta.url)),
        `${key}: style spans`,
      )
      checked++
    }
  }
}
console.log(`${checked} frozen OpenAI frames and style spans matched`)
