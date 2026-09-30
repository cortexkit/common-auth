import { expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertEmittedPublishList } from '@cortexkit/common-auth/tui-build'
import { makeRepoScratchDir } from '../fixtures/scratch.js'

test('publish-list compares the entire emitted destination including shared copies and selector', async () => {
  const root = await makeRepoScratchDir()
  try {
    const destination = join(root, 'output')
    await mkdir(join(destination, 'shared'), { recursive: true })
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'publish-fixture',
        version: '1.0.0',
        files: ['output/'],
      }),
    )
    const emitted = ['entry.js', 'shared/module.js', 'selector.js']
    for (const path of emitted)
      await writeFile(join(destination, path), 'export default 1')
    await assertEmittedPublishList(root, destination, emitted)
    await expect(
      assertEmittedPublishList(root, destination, ['entry.js', 'selector.js']),
    ).rejects.toThrow('Published destination differs')
    await expect(
      assertEmittedPublishList(root, destination, [...emitted, 'absent.js']),
    ).rejects.toThrow('Published destination differs')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
