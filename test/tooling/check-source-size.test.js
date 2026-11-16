import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkSourceSize } from '../../scripts/check-source-size.mjs'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function fixture(path, lines, trailingNewline = true) {
  const root = mkdtempSync(join(tmpdir(), 'source-size-'))
  roots.push(root)
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(
    file,
    Array(lines).fill('source').join('\n') + (trailingNewline ? '\n' : ''),
  )
  return root
}

describe('source size gate', () => {
  test('rejects a source file at the limit, including without a final newline', () => {
    const root = fixture('src/large.ts', 5000, false)
    expect(checkSourceSize(root, ['src/large.ts'], [])).toEqual([
      'src/large.ts: 5000 lines reaches the 5000-line limit',
    ])
  })

  test('exempts tests, fixtures, generated files and declarations', () => {
    for (const path of [
      'src/large.test.ts',
      'src/large.spec.ts',
      'test/large.ts',
      'packages/opencode/src/tests/large.ts',
      'test/fixtures/large.ts',
      'src/large.generated.ts',
      'src/generated/large.ts',
      'src/large.d.ts',
    ]) {
      const root = fixture(path, 5000)
      expect(checkSourceSize(root, [path], [])).toEqual([])
    }
    const root = fixture('src/marked.ts', 5000)
    writeFileSync(
      join(root, 'src/marked.ts'),
      `// @generated\n${'source\n'.repeat(5000)}`,
    )
    expect(checkSourceSize(root, ['src/marked.ts'], [])).toEqual([])
  })

  test('allows an exception at its cap and rejects growth', () => {
    const root = fixture('src/large.ts', 5000)
    const exceptions = [
      { path: 'src/large.ts', maxLines: 5000, reason: 'Awaiting split' },
    ]
    expect(checkSourceSize(root, ['src/large.ts'], exceptions)).toEqual([])
    writeFileSync(join(root, 'src/large.ts'), 'source\n'.repeat(5001))
    expect(checkSourceSize(root, ['src/large.ts'], exceptions)).toEqual([
      'src/large.ts: 5001 lines exceeds exception cap 5000',
    ])
  })

  test('CLI checks tracked files and reports failures with a nonzero exit', () => {
    const root = fixture('src/large.ts', 5000)
    execFileSync('git', ['init', '-q', root])
    const checker = new URL(
      '../../scripts/check-source-size.mjs',
      import.meta.url,
    )
    const run = () =>
      spawnSync(process.execPath, [fileURLToPath(checker)], {
        cwd: root,
        encoding: 'utf8',
      })
    expect(run().status).toBe(0)
    execFileSync('git', ['add', 'src/large.ts'], { cwd: root })
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('src/large.ts: 5000 lines')
  })

  test('rejects stale exceptions for missing and reduced files', () => {
    const root = fixture('src/large.ts', 4999)
    const exceptions = [
      { path: 'src/large.ts', maxLines: 5000, reason: 'Awaiting split' },
    ]
    expect(checkSourceSize(root, ['src/large.ts'], exceptions)).toEqual([
      'src/large.ts: stale exception (4999 lines)',
    ])
    expect(checkSourceSize(root, [], exceptions)).toEqual([
      'src/large.ts: stale exception (file missing or exempt)',
    ])
  })
})
