import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

const patterns = JSON.parse(
  await readFile(
    new URL('../windows/summary-patterns.json', import.meta.url),
    'utf8',
  ),
)
function accepted(runtime, text) {
  text = text
    .replaceAll('\r', '')
    .replace(
      new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g'),
      '',
    )
  return (
    patterns[runtime].required.every((pattern) =>
      new RegExp(pattern, 'm').test(text),
    ) &&
    patterns[runtime].forbidden.every(
      (pattern) => !new RegExp(pattern, 'm').test(text),
    )
  )
}
const node =
  'ℹ tests 19\nℹ suites 0\nℹ pass 19\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 3140.2\n'
const bun =
  'bun test v1.4.2 (744846f84)\n\n 19 pass\n 0 fail\n 42 expect() calls\nRan 19 tests across 1 file. [3140.00ms]\n'

test('Windows Node count guard accepts captured spec and TAP summaries including CRLF', () => {
  for (const summary of [
    node,
    node.replaceAll('\n', '\r\n'),
    '# tests 19\n# pass 19\n# fail 0\n# skipped 0\n',
  ])
    expect(accepted('node', summary)).toBe(true)
})
test('Windows Bun count guard accepts captured summary including CRLF', () => {
  expect(accepted('bun', bun)).toBe(true)
  expect(accepted('bun', bun.replaceAll('\n', '\r\n'))).toBe(true)
})
test('Windows runtime count guards reject skip-only and wrong-count summaries', () => {
  for (const summary of [
    node.replace('pass 19', 'pass 0').replace('skipped 0', 'skipped 19'),
    node.replace('tests 19', 'tests 119'),
    node.replace('fail 0', 'fail 1'),
    node.replace('skipped 0', 'skipped 1'),
  ])
    expect(accepted('node', summary)).toBe(false)
  for (const summary of [
    '0 pass\r\n15 skip\r\n0 fail\r\nRan 19 tests across 1 file. [1ms]\r\n',
    bun.replace('19 pass', '119 pass'),
    bun.replace('19 tests', '119 tests'),
    `${bun} 1 skip\n`,
  ])
    expect(accepted('bun', summary)).toBe(false)
})
