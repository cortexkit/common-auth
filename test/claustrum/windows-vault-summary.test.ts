import { expect, test } from 'bun:test'
import {
  assertVaultSummary,
  vaultTestNames,
} from '../windows/vault-summary.mjs'

const completed = vaultTestNames.map((name) =>
  JSON.stringify({ event: 'test-pass', test: name }),
)
const nodeSummary =
  '# tests 3\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0'
const bunSummary = ' 3 pass\n 0 fail\nRan 3 tests across 1 file. [1.00s]'

test('vault summary accepts all three executed scenarios on Node and both Bun versions', () => {
  expect(() =>
    assertVaultSummary(
      `${completed.map((line) => `# ${line}`).join('\n')}\n${nodeSummary}`,
      'node',
    ),
  ).not.toThrow()
  for (const version of ['1.4.2', '1.3.14']) {
    expect(() =>
      assertVaultSummary(
        `bun test v${version}\n${completed.join('\n')}\n${bunSummary}`,
        'bun',
      ),
    ).not.toThrow()
  }
})

test('vault summary refuses an unexecuted ceremony even with a green runner summary', () => {
  for (const [runtime, summary] of [
    ['node', nodeSummary],
    ['bun', bunSummary],
  ] as const) {
    const output = `${completed.slice(1).join('\n')}\n${summary}`
    expect(() => assertVaultSummary(output, runtime)).toThrow(
      'all three vault scenarios must execute',
    )
  }
})

test('vault summary refuses duplicate completion events', () => {
  expect(() =>
    assertVaultSummary(
      `${[...completed, completed[0]].join('\n')}\n${nodeSummary}`,
      'node',
    ),
  ).toThrow('all three vault scenarios must execute')
})

test('vault summary refuses runner failures, skips, cancellations and wrong counts', () => {
  for (const [old, mutant] of [
    ['# tests 3', '# tests 0'],
    ['# pass 3', '# pass 2'],
    ['# fail 0', '# fail 1'],
    ['# cancelled 0', '# cancelled 1'],
    ['# skipped 0', '# skipped 1'],
    ['# todo 0', '# todo 1'],
  ] as const) {
    expect(() =>
      assertVaultSummary(
        `${completed.join('\n')}\n${nodeSummary.replace(old, mutant)}`,
        'node',
      ),
    ).toThrow()
  }
  for (const mutant of [
    ' 2 pass\n 0 fail\nRan 2 tests across 1 file.',
    ' 3 pass\n 1 fail\nRan 3 tests across 1 file.',
    `${bunSummary}\n 1 skip`,
  ]) {
    expect(() =>
      assertVaultSummary(`${completed.join('\n')}\n${mutant}`, 'bun'),
    ).toThrow()
  }
})
