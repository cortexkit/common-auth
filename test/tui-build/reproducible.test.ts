import { expect, test } from 'bun:test'
import { realpathSync } from 'node:fs'
import {
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { buildTui } from '@cortexkit/common-auth/tui-build'
import { makeTempDir } from '../fixtures/scratch.js'

// One plugin-shaped source graph: an entry with a sibling, a dependency
// outside the entry's directory, and an inlined package with an internal
// import. Both of the latter land in shared/, whose names are what used to
// carry the checkout's absolute path.
const files: Record<string, string> = {
  'package.json': '{ "name": "fixture-plugin", "type": "module" }\n',
  'src/tui/entry.tsx': [
    "import { format } from '../common/format.ts'",
    "import { greet } from 'fixture-inline'",
    "export { label } from './label.ts'",
    'export default function View() {',
    '  return <text>{greet(format(1))}</text>',
    '}',
    '',
  ].join('\n'),
  'src/tui/label.ts': "export const label: string = 'label'\n",
  'src/common/format.ts':
    "export const format = (value: number): string => '#' + value\n",
  'vendor/fixture-inline/package.json': JSON.stringify({
    name: 'fixture-inline',
    type: 'module',
    exports: { '.': './index.ts' },
  }),
  'vendor/fixture-inline/index.ts':
    "import { prefix } from './prefix.ts'\nexport const greet = (name: string): string => prefix + name\n",
  'vendor/fixture-inline/prefix.ts': "export const prefix: string = 'hi '\n",
}

async function writeCheckout(root: string) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
}

async function tree(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  for (const entry of await readdir(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    result.set(relative(root, path), await readFile(path, 'utf8'))
  }
  return new Map([...result].sort(([a], [b]) => a.localeCompare(b)))
}

test('builds of one source graph from two checkout directories emit byte-identical trees', async () => {
  const first = await makeTempDir('fixture-tui-checkout-a-')
  const second = await makeTempDir('fixture-tui-checkout-b-')
  try {
    for (const variant of ['raw', 'runtime'] as const) {
      const trees = []
      for (const root of [first, second]) {
        await writeCheckout(root)
        const destination = join(root, `out-${variant}`)
        await buildTui(join(root, 'src/tui/entry.tsx'), variant, destination, {
          inline: [
            {
              name: 'fixture-inline',
              root: join(root, 'vendor/fixture-inline'),
            },
          ],
        })
        const emitted = await tree(destination)
        for (const code of emitted.values()) {
          expect(code).not.toContain(root)
          expect(code).not.toContain(realpathSync(root))
        }
        trees.push(emitted)
      }
      const [a, b] = trees as [Map<string, string>, Map<string, string>]
      expect([...b.keys()]).toEqual([...a.keys()])
      for (const [path, code] of a)
        expect({ path, code: b.get(path) }).toEqual({ path, code })
      // The comparison is only meaningful if the outside dependency and the
      // inlined package really were copied to shared/ and imported from there.
      const shared = [...a.keys()].filter((path) => path.startsWith('shared/'))
      expect(shared).toHaveLength(3)
      const entry = a.get(variant === 'raw' ? 'entry.tsx' : 'entry.js') ?? ''
      expect(
        shared
          .filter((path) => !path.endsWith('-prefix.js'))
          .every((path) => entry.includes(`./${path}`)),
      ).toBe(true)
    }
  } finally {
    await rm(first, { recursive: true, force: true })
    await rm(second, { recursive: true, force: true })
  }
})

test('a shared file gets the same name whether the entry is given through a symlink or not', async () => {
  const root = await makeTempDir('fixture-tui-symlink-')
  try {
    await writeCheckout(root)
    await symlink(root, join(root, 'linked'))
    const options = {
      inline: [
        { name: 'fixture-inline', root: join(root, 'vendor/fixture-inline') },
      ],
    }
    const direct = await buildTui(
      join(root, 'src/tui/entry.tsx'),
      'raw',
      join(root, 'out-direct'),
      options,
    )
    const linked = await buildTui(
      join(root, 'linked/src/tui/entry.tsx'),
      'raw',
      join(root, 'out-linked'),
      options,
    )
    expect(linked.emitted).toEqual(direct.emitted)
    expect(direct.emitted).toContain('entry.tsx')
    expect(direct.emitted).toContain('label.js')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
