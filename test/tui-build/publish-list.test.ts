import { expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertEmittedPublishList } from '@cortexkit/common-auth/tui-build'
import { packedRecords } from '../../src/tui-build/publish-list.js'
import { makeRepoScratchDir } from '../fixtures/scratch.js'

// Record shapes as printed by real `npm pack --json --dry-run`: npm 11.19.1
// prints an array, npm 12.2.1 an object keyed by package name.
const record = {
  id: 'probe-pkg@1.0.0',
  name: 'probe-pkg',
  filename: 'probe-pkg-1.0.0.tgz',
  files: [{ path: 'index.js' }, { path: 'package.json' }],
}

test('packedRecords reads npm 11 arrays and npm 12 objects alike', () => {
  expect(packedRecords([record])).toEqual([record])
  expect(packedRecords({ 'probe-pkg': record })).toEqual([record])
  expect(packedRecords(null)).toEqual([])
  expect(packedRecords('probe-pkg')).toEqual([])
})

// Each assertEmittedPublishList call runs `npm pack --dry-run`, five in this
// test; npm's own start-up dominates, and on a loaded machine the five spawns
// alone exceed bun's 5-second default (measured 15.8 s at load average 69).
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
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'publish-fixture',
        version: '1.0.0',
        files: ['output/entry.js', 'output/selector.js'],
      }),
    )
    await expect(
      assertEmittedPublishList(root, destination, emitted),
    ).rejects.toThrow('Published destination differs')
    await assertEmittedPublishList(root, destination, [
      'entry.js',
      'selector.js',
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
