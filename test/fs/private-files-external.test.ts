import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPrivateFilesExternal } from '../../scripts/check-private-files-external.ts'

test('built common-auth keeps the native dependency external', async () => {
  expect((await checkPrivateFilesExternal()).imports).toBeGreaterThan(0)
})

test('external fence rejects an inlined native loader and a missing import', async () => {
  const root = await mkdtemp(join(tmpdir(), 'external-fence-'))
  try {
    await writeFile(
      join(root, 'index.js'),
      "import('@cortexkit/private-files'); const prebuild = 'private-files-win32-x64.node'",
    )
    await expect(checkPrivateFilesExternal(root)).rejects.toThrow(
      'native loader was inlined',
    )
    await writeFile(
      join(root, 'index.js'),
      "import { verifySafeParentSync } from '@cortexkit/private-files'\nimport('@cortexkit/private-files')",
    )
    await expect(checkPrivateFilesExternal(root)).rejects.toThrow(
      'must be imported lazily',
    )
    await writeFile(join(root, 'index.js'), 'export const inlined = true')
    await expect(checkPrivateFilesExternal(root)).rejects.toThrow(
      'retain the external',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
