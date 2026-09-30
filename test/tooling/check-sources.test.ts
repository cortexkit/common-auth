import { expect, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeRepoScratchDir } from '../fixtures/scratch'

const root = fileURLToPath(new URL('../../', import.meta.url))
const checker = join(root, 'scripts/check-sources.mjs')

function table(titles: string[]) {
  return [
    '| component | behaviour | origin | test |',
    '| --- | --- | --- | --- |',
    ...titles.map(
      (title) => `| tooling | evidence | new (neither copy) | \`${title}\` |`,
    ),
  ].join('\n')
}

async function check(directory: string, markdown: string, xml: string) {
  const sources = join(directory, 'sources.md')
  const artifact = join(directory, 'results.xml')
  await writeFile(sources, markdown)
  await writeFile(artifact, xml)
  return Bun.spawnSync([process.execPath, checker, sources, artifact], {
    cwd: root,
  })
}

test('source checker excludes skipped, failed and errored synthetic cases', async () => {
  const directory = await makeRepoScratchDir('sources-synthetic-')
  try {
    for (const outcome of ['skipped', 'failure', 'error']) {
      const result = await check(
        directory,
        table(['synthetic title']),
        `<testsuites><testcase name="synthetic title"><${outcome} /></testcase></testsuites>`,
      )
      expect(result.exitCode).toBe(1)
      expect(result.stdout.toString()).toContain(
        '1 cells parsed, 0 cells matched',
      )
    }
    const passed = await check(
      directory,
      table(['synthetic title']),
      '<testsuites><testcase name="synthetic title" /></testsuites>',
    )
    expect(passed.exitCode).toBe(0)
    expect(passed.stdout.toString()).toContain(
      '1 cells parsed, 1 cells matched',
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('source checker decodes XML titles and strips describe prefixes', async () => {
  const directory = await makeRepoScratchDir('sources-prefix-')
  try {
    const result = await check(
      directory,
      table(['title & value']),
      '<testsuites><testcase classname="outer &gt; inner" name="outer &gt; inner &gt; title &amp; value"></testcase></testsuites>',
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain(
      '1 cells parsed, 1 cells matched',
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('source checker rejects empty tables and unmatched cells', async () => {
  const directory = await makeRepoScratchDir('sources-empty-')
  try {
    const empty = await check(directory, table([]), '<testsuites />')
    expect(empty.exitCode).toBe(1)
    expect(empty.stdout.toString()).toContain('0 cells parsed, 0 cells matched')
    const unmatched = await check(
      directory,
      table(['absent title']),
      '<testsuites />',
    )
    expect(unmatched.exitCode).toBe(1)
    expect(unmatched.stderr.toString()).toContain('absent title')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('source checker matches exactly two cells from the real four-test JUnit fixture', async () => {
  const directory = await makeRepoScratchDir('sources-real-')
  try {
    const artifact = join(directory, 'fixture.xml')
    const fixture = Bun.spawnSync(
      [
        process.execPath,
        'test',
        './test/fixtures/sources-check/spec-fixture.ts',
        '--reporter=junit',
        `--reporter-outfile=${artifact}`,
      ],
      { cwd: root },
    )
    expect(fixture.exitCode).toBe(0)
    const titles = [
      'source fixture top-level passes',
      'source fixture nested passes',
      'source fixture skipped',
      'source fixture todo',
    ]
    const xml = await readFile(artifact, 'utf8')
    const result = await check(directory, table(titles), xml)
    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toContain(
      '4 cells parsed, 2 cells matched',
    )
    expect(result.stderr.toString()).toContain('source fixture skipped')
    expect(result.stderr.toString()).toContain('source fixture todo')
    const passing = await check(directory, table(titles.slice(0, 2)), xml)
    expect(passing.exitCode).toBe(0)
    expect(passing.stdout.toString()).toContain(
      '2 cells parsed, 2 cells matched',
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('installed range checker enumerates root and workspace globs and rejects drift', async () => {
  const directory = await makeRepoScratchDir('ranges-')
  try {
    await mkdir(join(directory, 'scripts'))
    const script = join(directory, 'scripts/check-installed-ranges.mjs')
    await writeFile(
      script,
      await readFile(join(root, 'scripts/check-installed-ranges.mjs')),
    )
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name: 'range-fixture',
        workspaces: ['fixtures/*'],
        dependencies: {
          'range-dep': '^1.0.0',
          local: 'file:./local',
          linked: 'link:./linked',
        },
      }),
    )
    await mkdir(join(directory, 'fixtures/child'), { recursive: true })
    await writeFile(
      join(directory, 'fixtures/child/package.json'),
      JSON.stringify({
        name: 'child',
        devDependencies: { 'range-dep': '1.2.3', sibling: 'workspace:*' },
      }),
    )
    await mkdir(join(directory, 'node_modules/range-dep'), { recursive: true })
    const installed = join(directory, 'node_modules/range-dep/package.json')
    await writeFile(
      installed,
      JSON.stringify({ name: 'range-dep', version: '1.2.3' }),
    )
    const passing = Bun.spawnSync([process.execPath, script], {
      cwd: directory,
    })
    expect(passing.exitCode).toBe(0)
    expect(passing.stdout.toString()).toContain(
      'installed ranges ok (2 dependencies checked)',
    )
    await writeFile(
      installed,
      JSON.stringify({ name: 'range-dep', version: '1.2.4' }),
    )
    const drift = Bun.spawnSync([process.execPath, script], { cwd: directory })
    expect(drift.exitCode).toBe(1)
    expect(drift.stderr.toString()).toContain(
      'child: range-dep is installed at 1.2.4',
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
