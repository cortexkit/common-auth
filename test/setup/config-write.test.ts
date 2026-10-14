import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeHostConfigAtomic } from '../../src/setup/config-write.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})
async function profile() {
  const root = await mkdtemp(join(tmpdir(), 'common-auth-config-write-'))
  roots.push(root)
  return root
}

describe('ordinary setup config writer', () => {
  test('stages beside the target and keeps the old file until publication', async () => {
    const root = await profile()
    const file = join(root, 'opencode.jsonc')
    await writeFile(file, 'old')
    await writeHostConfigAtomic(file, 'new', {
      beforeRename: async () => {
        expect(await readFile(file, 'utf8')).toBe('old')
        const stage = (await readdir(root)).find((name) =>
          name.endsWith('.tmp'),
        )!
        expect(await readFile(join(root, stage), 'utf8')).toBe('new')
      },
    })
    expect(await readFile(file, 'utf8')).toBe('new')
    expect(await readdir(root)).toEqual(['opencode.jsonc'])
  })

  test.skipIf(process.platform === 'win32')(
    'preserves existing POSIX config modes',
    async () => {
      const root = await profile()
      const file = join(root, 'opencode.jsonc')
      for (const mode of [0o644, 0o640, 0o664]) {
        await writeFile(file, 'old')
        await chmod(file, mode)
        await writeHostConfigAtomic(file, 'new', { platform: 'linux' })
        expect((await stat(file)).mode & 0o777).toBe(mode)
      }
    },
  )

  test('Windows sharing failures retry with a fence before each attempt', async () => {
    const root = await profile()
    const file = join(root, 'opencode.jsonc')
    let now = 0
    let fences = 0
    let attempts = 0
    const codes = ['EPERM', 'EBUSY', 'EACCES']
    const waits: number[] = []
    await writeHostConfigAtomic(file, 'new', {
      platform: 'win32',
      now: () => now,
      beforeRename: async () => {
        fences++
      },
      wait: async (ms) => {
        waits.push(ms)
        now += ms
      },
      rename: async (from, to) => {
        const code = codes[attempts++]
        if (code) throw Object.assign(new Error('sharing'), { code })
        await rename(from, to)
      },
    })
    expect(attempts).toBe(4)
    expect(fences).toBe(4)
    expect(waits).toEqual([25, 50, 100])
    expect(await readFile(file, 'utf8')).toBe('new')
  })

  test('Windows retries stop at two seconds and clean only their own stage', async () => {
    const root = await profile()
    const file = join(root, 'opencode.jsonc')
    await writeFile(file, 'old')
    let now = 0
    await expect(
      writeHostConfigAtomic(file, 'new', {
        platform: 'win32',
        now: () => now,
        wait: async (ms) => {
          now += ms
        },
        rename: async () => {
          throw Object.assign(new Error('private refusal should not leak'), {
            code: 'EPERM',
          })
        },
      }),
    ).rejects.toThrow(`Unable to replace host config ${file}.`)
    expect(now).toBe(2000)
    expect(await readFile(file, 'utf8')).toBe('old')
    expect(await readdir(root)).toEqual(['opencode.jsonc'])
  })

  test('other rename failures are terminal and preserve the old file', async () => {
    const root = await profile()
    const file = join(root, 'opencode.jsonc')
    await writeFile(file, 'old')
    let attempts = 0
    await expect(
      writeHostConfigAtomic(file, 'new', {
        platform: 'win32',
        rename: async () => {
          attempts++
          throw Object.assign(new Error('failure'), { code: 'ENOENT' })
        },
      }),
    ).rejects.toThrow('Unable to replace host config')
    expect(attempts).toBe(1)
    expect(await readFile(file, 'utf8')).toBe('old')
    expect(await readdir(root)).toEqual(['opencode.jsonc'])
  })

  test('a fence failure before a retry prevents publication and cleans the stage', async () => {
    const root = await profile()
    const file = join(root, 'opencode.jsonc')
    await writeFile(file, 'old')
    let fences = 0
    let attempts = 0
    await expect(
      writeHostConfigAtomic(file, 'new', {
        platform: 'win32',
        beforeRename: async () => {
          if (++fences === 2) throw new Error('host started')
        },
        wait: async () => {},
        rename: async () => {
          attempts++
          throw Object.assign(new Error('sharing'), { code: 'EBUSY' })
        },
      }),
    ).rejects.toThrow('host started')
    expect(attempts).toBe(1)
    expect(await readFile(file, 'utf8')).toBe('old')
    expect(await readdir(root)).toEqual(['opencode.jsonc'])
  })

  test('colliding stages are never overwritten or removed', async () => {
    const root = await profile()
    const file = join(root, 'opencode.jsonc')
    const stage = join(root, '.opencode.jsonc.collision.tmp')
    await writeFile(stage, 'other writer')
    await expect(
      writeHostConfigAtomic(file, 'new', { stageName: () => 'collision' }),
    ).rejects.toThrow()
    expect(await readFile(stage, 'utf8')).toBe('other writer')
    expect(await readdir(root)).toEqual(['.opencode.jsonc.collision.tmp'])
  })
})
