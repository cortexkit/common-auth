import { expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('setup keeps Claustrum imports static and bundles without lazy chunks', async () => {
  const directory = fileURLToPath(new URL('../../dist/setup/', import.meta.url))
  const files = (await readdir(directory)).filter((file) =>
    file.endsWith('.js'),
  )
  expect(files).toContain('command.js')
  expect(files).toContain('detect.js')
  expect(files).toContain('enroll.js')
  const scanner = new Bun.Transpiler({ loader: 'js', target: 'node' })
  for (const file of files) {
    const imports = scanner.scanImports(
      await readFile(join(directory, file), 'utf8'),
    )
    expect(
      imports.filter(
        (entry) =>
          entry.kind === 'dynamic-import' && entry.path.includes('claustrum'),
      ),
    ).toEqual([])
  }

  // Peers stay external; the published setup implementation must remain in one entry bundle.
  const outdir = await mkdtemp(join(tmpdir(), 'common-auth-setup-bundle-'))
  try {
    const result = await Bun.build({
      entrypoints: [join(directory, 'index.js')],
      target: 'node',
      format: 'esm',
      splitting: true,
      outdir,
      external: ['@cortexkit/claustrum-client', '@cortexkit/private-files'],
    })
    expect(result.success).toBe(true)
    expect(result.outputs.map((output) => output.kind)).toEqual(['entry-point'])
    const entry = await result.outputs[0]!.text()
    expect(scanner.scan(entry).exports).toContain('runSetup')
    const peerImports = scanner
      .scanImports(entry)
      .filter((item) => item.path === '@cortexkit/claustrum-client')
    expect(peerImports.length).toBeGreaterThan(0)
    expect(peerImports.every((item) => item.kind === 'import-statement')).toBe(
      true,
    )
  } finally {
    await rm(outdir, { recursive: true, force: true })
  }
})
