import { expect, test } from 'bun:test'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const checker = join(root, 'scripts/check-local-deps.mjs')

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'local-deps-'))
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'fixture' }),
  )
  await mkdir(join(directory, 'scripts'))
  await cp(checker, join(directory, 'scripts/check-local-deps.mjs'))
  return directory
}

async function run(directory: string) {
  return Bun.spawnSync(
    [process.execPath, join(directory, 'scripts/check-local-deps.mjs')],
    { cwd: directory },
  )
}

test('local dependency checker rejects an outside file dependency', async () => {
  const directory = await fixture()
  try {
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        dependencies: { sibling: 'file:../sibling' },
      }),
    )
    const result = await run(directory)
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain(
      'dependencies sibling=file:../sibling',
    )
    expect(result.stderr.toString()).toContain('resolves to')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('local dependency checker allows in-repo file and workspace dependencies', async () => {
  const directory = await fixture()
  try {
    await mkdir(join(directory, 'x'))
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        dependencies: { local: 'file:./x', sibling: 'workspace:*' },
      }),
    )
    await writeFile(
      join(directory, 'bun.lock'),
      JSON.stringify({
        lockfileVersion: 1,
        workspaces: {
          '': { dependencies: { local: 'file:./x', sibling: 'workspace:*' } },
          'packages/nested': { dependencies: { archive: 'file:../../x.tgz' } },
        },
        packages: { 'archive@../../x.tgz': [] },
      }),
    )
    const result = await run(directory)
    expect(result.exitCode).toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('local dependency checker rejects an outside bun.lock dependency', async () => {
  const directory = await fixture()
  try {
    await writeFile(
      join(directory, 'bun.lock'),
      JSON.stringify({
        lockfileVersion: 1,
        workspaces: { '': { dependencies: { sibling: 'file:../sibling' } } },
        packages: { 'sibling@../sibling.tgz': [] },
      }),
    )
    const result = await run(directory)
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('bun.lock')
    expect(result.stderr.toString()).toContain('file:../sibling')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
