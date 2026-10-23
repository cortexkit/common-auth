import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as redaction from '@cortexkit/common-auth/redaction'

test('redaction public subpath exposes the four credential helpers', async () => {
  const pkg = await Bun.file(
    new URL('../../package.json', import.meta.url),
  ).json()
  expect(pkg.exports['./redaction']).toEqual({
    types: './dist/redaction/index.d.ts',
    import: './dist/redaction/index.js',
  })
  expect(Object.keys(redaction).sort()).toEqual([
    'redactCredentialError',
    'redactCredentialFrame',
    'redactCredentialResponse',
    'redactCredentialText',
  ])
  expect(redaction.redactCredentialText('secret', 'secret')).toBe(
    '[credential]',
  )
})

test('redaction keeps imports static and bundles without lazy chunks', async () => {
  const entry = fileURLToPath(
    new URL('../../dist/redaction/index.js', import.meta.url),
  )
  const scanner = new Bun.Transpiler({ loader: 'js', target: 'node' })
  expect(
    scanner
      .scanImports(await readFile(entry, 'utf8'))
      .filter((item) => item.kind === 'dynamic-import'),
  ).toEqual([])
  const outdir = await mkdtemp(join(tmpdir(), 'common-auth-redaction-bundle-'))
  try {
    const result = await Bun.build({
      entrypoints: [entry],
      target: 'node',
      format: 'esm',
      splitting: true,
      outdir,
    })
    expect(result.success).toBe(true)
    expect(result.outputs.map((output) => output.kind)).toEqual(['entry-point'])
    const bundled = await result.outputs[0]!.text()
    expect(scanner.scan(bundled).exports.sort()).toEqual(
      Object.keys(redaction).sort(),
    )
  } finally {
    await rm(outdir, { recursive: true, force: true })
  }
})
