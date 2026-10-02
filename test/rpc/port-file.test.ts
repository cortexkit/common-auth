import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmod,
  mkdir,
  readdir,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import {
  createManagedRpcStateDirPredicate,
  discoverPortFile,
  isManagedRpcStateDir,
  sweepRpcState,
  writePortFile,
} from '../../src/rpc/port-file.js'
import { makeTempDir } from '../fixtures/scratch'

const sweepFixture = (root: string, active: string) =>
  sweepRpcState(root, active, (name) => isManagedRpcStateDir(name, 'fixture-'))
let dir: string
const childProcesses: Array<ReturnType<typeof Bun.spawn>> = []
const permissionTest = process.getuid?.() === 0 ? test.skip : test

beforeEach(async () => {
  dir = await makeTempDir('fixture-rpc-')
})
afterEach(async () => {
  for (const child of childProcesses.splice(0)) {
    child.kill()
    await child.exited.catch(() => {})
  }
  await rm(dir, { recursive: true, force: true })
})

function spawnLivePid(): number {
  const child = Bun.spawn(['sleep', '30'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  childProcesses.push(child)
  return child.pid
}

describe('port-file', () => {
  test('writePortFile then discover returns the entry for a live pid', async () => {
    await writePortFile(dir, { port: 5123, token: 'tok', pid: process.pid })
    const found = await discoverPortFile(dir)
    expect(found?.port).toBe(5123)
    expect(found?.token).toBe('tok')
  })

  test('discover ignores dead pids', async () => {
    await writeFile(
      join(dir, 'port-99999999.json'),
      JSON.stringify({ port: 1, token: 'x', pid: 99999999, startedAt: 1 }),
      'utf8',
    )
    expect(await discoverPortFile(dir)).toBeNull()
  })

  test('discover picks the newest startedAt among live entries', async () => {
    await writePortFile(dir, { port: 1, token: 'a', pid: process.pid })
    await new Promise((r) => setTimeout(r, 5))
    await writePortFile(dir, { port: 2, token: 'b', pid: process.pid })
    expect((await discoverPortFile(dir))?.port).toBe(2)
  })

  test('discover returns live entry matching the expected pid instead of newer live entry', async () => {
    const expectedPid = spawnLivePid()
    await writeFile(
      join(dir, `port-${expectedPid}.json`),
      JSON.stringify({
        port: 1,
        token: 'expected',
        pid: expectedPid,
        startedAt: 1,
      }),
      'utf8',
    )
    await writeFile(
      join(dir, `port-${process.pid}.json`),
      JSON.stringify({
        port: 2,
        token: 'newer-other',
        pid: process.pid,
        startedAt: 3,
      }),
      'utf8',
    )

    const found = await discoverPortFile(dir, expectedPid)
    expect(found?.port).toBe(1)
    expect(found?.pid).toBe(expectedPid)
    expect(found?.token).toBe('expected')
  })

  test('discover falls back to newest live entry when expected pid matches none', async () => {
    const olderPid = spawnLivePid()
    await writeFile(
      join(dir, `port-${olderPid}.json`),
      JSON.stringify({
        port: 1,
        token: 'older',
        pid: olderPid,
        startedAt: 1,
      }),
      'utf8',
    )
    await writeFile(
      join(dir, `port-${process.pid}.json`),
      JSON.stringify({
        port: 2,
        token: 'newer',
        pid: process.pid,
        startedAt: 2,
      }),
      'utf8',
    )

    const found = await discoverPortFile(dir, 99999999)
    expect(found?.port).toBe(2)
    expect(found?.token).toBe('newer')
  })

  test('discover still picks newest live entry when expected pid is undefined', async () => {
    const olderPid = spawnLivePid()
    await writeFile(
      join(dir, `port-${olderPid}.json`),
      JSON.stringify({
        port: 1,
        token: 'older',
        pid: olderPid,
        startedAt: 1,
      }),
      'utf8',
    )
    await writeFile(
      join(dir, `port-${process.pid}.json`),
      JSON.stringify({
        port: 2,
        token: 'newer',
        pid: process.pid,
        startedAt: 2,
      }),
      'utf8',
    )

    const found = await discoverPortFile(dir)
    expect(found?.port).toBe(2)
    expect(found?.token).toBe('newer')
  })

  test('discover never returns a dead pid even when it matches expected pid', async () => {
    await writeFile(
      join(dir, `port-${process.pid}.json`),
      JSON.stringify({
        port: 1,
        token: 'live',
        pid: process.pid,
        startedAt: 1,
      }),
      'utf8',
    )
    await writeFile(
      join(dir, 'port-99999999.json'),
      JSON.stringify({
        port: 2,
        token: 'dead',
        pid: 99999999,
        startedAt: 2,
      }),
      'utf8',
    )

    const found = await discoverPortFile(dir, 99999999)
    expect(found?.port).toBe(1)
    expect(found?.pid).toBe(process.pid)
    expect(found?.token).toBe('live')
  })

  test('writePortFile keeps the liveness pid available for matching', async () => {
    await writePortFile(dir, {
      port: 1,
      token: 'matched',
      pid: process.pid,
    })
    const otherPid = spawnLivePid()
    await writeFile(
      join(dir, `port-${otherPid}.json`),
      JSON.stringify({
        port: 2,
        token: 'other',
        pid: otherPid,
        startedAt: Date.now() + 1,
      }),
      'utf8',
    )

    const matched = await discoverPortFile(dir, process.pid)
    expect(matched?.port).toBe(1)
    expect(matched?.pid).toBe(process.pid)

    const fallback = await discoverPortFile(dir, 99999999)
    expect(fallback?.port).toBe(2)
    expect(fallback?.token).toBe('other')
  })

  test('sweepRpcState removes a dead port file but leaves a live one untouched', async () => {
    const deadDir = join(dir, 'fixture-deadbeefdeadbeef')
    const liveDir = join(dir, 'fixture-cafebabecafebabe')
    const livePid = spawnLivePid()
    await writePortFile(deadDir, { port: 1, token: 'dead', pid: 99999999 })
    await writeFile(join(deadDir, 'keep'), 'x', 'utf8')
    await writePortFile(liveDir, { port: 2, token: 'live', pid: livePid })

    await sweepFixture(dir, join(dir, 'active'))

    expect(await readdir(deadDir)).toEqual(['keep'])
    expect(await readdir(liveDir)).toEqual([`port-${livePid}.json`])
  })

  test('sweepRpcState removes a port file that has a pid but no port', async () => {
    const projectDir = join(dir, 'fixture-deadbeefdeadbeef')
    const noPortFile = join(projectDir, `port-${process.pid}.json`)
    await mkdir(projectDir, { recursive: true })
    await writeFile(noPortFile, JSON.stringify({ pid: process.pid }), 'utf8')

    await sweepFixture(dir, join(dir, 'active'))

    await expect(stat(noPortFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('sweepRpcState removes an emptied project dir but never its active dir', async () => {
    const staleDir = join(dir, 'fixture-deadbeefdeadbeef')
    const activeDir = join(dir, 'fixture-cafebabecafebabe')
    await writePortFile(staleDir, { port: 1, token: 'dead', pid: 99999999 })
    await writePortFile(activeDir, { port: 2, token: 'dead', pid: 99999999 })

    await sweepFixture(dir, activeDir)

    await expect(stat(staleDir)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(activeDir)).toEqual([])
  })

  test('sweepRpcState collects dead legacy state but preserves live legacy state', async () => {
    const deadLegacyDir = join(dir, 'deadbeefdeadbeef')
    const liveLegacyDir = join(dir, 'cafebabecafebabe')
    const livePid = spawnLivePid()
    await writePortFile(deadLegacyDir, {
      port: 1,
      token: 'dead',
      pid: 99999999,
    })
    await writePortFile(liveLegacyDir, {
      port: 2,
      token: 'live',
      pid: livePid,
    })

    await sweepFixture(dir, join(dir, 'active'))

    await expect(stat(deadLegacyDir)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(liveLegacyDir)).toEqual([`port-${livePid}.json`])
  })

  test('sweepRpcState removes a corrupt port file', async () => {
    const projectDir = join(dir, 'fixture-deadbeefdeadbeef')
    const corruptFile = join(projectDir, 'port-corrupt.json')
    await mkdir(projectDir, { recursive: true })
    await writeFile(corruptFile, '{', 'utf8')

    await sweepFixture(dir, join(dir, 'active'))

    await expect(stat(corruptFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('sweepRpcState leaves a valid live port file in a directory with a corrupt file', async () => {
    const projectDir = join(dir, 'fixture-deadbeefdeadbeef')
    const livePid = spawnLivePid()
    await writePortFile(projectDir, { port: 1, token: 'live', pid: livePid })
    await writeFile(join(projectDir, 'port-corrupt.json'), '{', 'utf8')

    await sweepFixture(dir, join(dir, 'active'))

    expect(await readdir(projectDir)).toEqual([`port-${livePid}.json`])
  })

  permissionTest(
    'sweepRpcState ignores an unlink failure for a corrupt port file',
    async () => {
      const projectDir = join(dir, 'fixture-deadbeefdeadbeef')
      const corruptFile = join(projectDir, 'port-corrupt.json')
      await mkdir(projectDir, { recursive: true })
      await writeFile(corruptFile, '{', 'utf8')
      await chmod(projectDir, 0o500)

      try {
        await expect(unlink(corruptFile)).rejects.toMatchObject({
          code: 'EACCES',
        })
        await expect(
          sweepFixture(dir, join(dir, 'active')),
        ).resolves.toBeUndefined()
      } finally {
        await chmod(projectDir, 0o700)
      }
    },
  )

  test('writePortFile recovers when the directory is removed between mkdir and write', async () => {
    const projectDir = join(dir, 'fixture-deadbeefdeadbeef')
    let dirRemoved = false
    const target = await writePortFile(
      projectDir,
      { port: 7777, token: 'survives', pid: process.pid },
      {
        beforeWrite: async () => {
          if (dirRemoved) return
          dirRemoved = true
          await rmdir(projectDir)
        },
      },
    )

    expect(dirRemoved).toBe(true)
    expect(await stat(target)).toBeDefined()
    const found = await discoverPortFile(projectDir)
    expect(found?.port).toBe(7777)
    expect(found?.token).toBe('survives')
  })

  test('writePortFile does not retry forever on a persistent ENOENT', async () => {
    const projectDir = join(dir, 'fixture-deadbeefdeadbeef')
    let calls = 0
    await expect(
      writePortFile(
        projectDir,
        { port: 1, token: 'x', pid: process.pid },
        {
          beforeWrite: async () => {
            calls += 1
            await rmdir(projectDir)
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    // Bounded: one initial attempt + exactly one retry = 2 invocations of
    // beforeWrite. A third attempt would exceed the bounded retry policy.
    expect(calls).toBe(2)
  })

  test('sweepRpcState removes unusable entries and continues through sibling directories', async () => {
    const projectDir = join(dir, 'fixture-deadbeefdeadbeef')
    const siblingDir = join(dir, 'fixture-cafebabecafebabe')
    await mkdir(projectDir, { recursive: true })
    await mkdir(siblingDir, { recursive: true })
    const unusableEntries = [
      ['port-null.json', 'null'],
      ['port-number.json', '123'],
      ['port-array.json', '[]'],
      ['port-string.json', '"str"'],
      ['port-bool.json', 'true'],
    ] as const
    const unusableFiles = unusableEntries.map(([name]) =>
      join(projectDir, name),
    )
    for (const [name, value] of unusableEntries) {
      await writeFile(join(projectDir, name), value, 'utf8')
    }
    const deadHere = join(projectDir, 'port-dead-here.json')
    const deadSibling = join(siblingDir, 'port-dead-sibling.json')
    await writeFile(
      deadHere,
      JSON.stringify({ port: 1, token: 'dead', pid: 99999999, startedAt: 1 }),
      'utf8',
    )
    await writeFile(
      deadSibling,
      JSON.stringify({ port: 2, token: 'dead', pid: 99999999, startedAt: 1 }),
      'utf8',
    )

    await sweepFixture(dir, join(dir, 'active'))

    for (const file of [...unusableFiles, deadHere, deadSibling]) {
      await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })
})

test('numeric startedAt is written; non-numeric startedAt sorts last without rejection', async () => {
  const file = await writePortFile(dir, {
    port: 1,
    pid: process.pid,
    token: 'numeric',
  })
  expect(typeof JSON.parse(await Bun.file(file).text()).startedAt).toBe(
    'number',
  )
  const otherPid = spawnLivePid()
  await writeFile(
    join(dir, `port-${otherPid}.json`),
    JSON.stringify({
      port: 2,
      pid: otherPid,
      token: 'unknown',
      startedAt: '9999999999999999',
    }),
  )
  expect((await discoverPortFile(dir))?.port).toBe(1)
  await unlink(file)
  expect((await discoverPortFile(dir))?.port).toBe(2)
})

test('discovery unlinks usable dead entries, ignores missing finite ports and preserves usable live entries', async () => {
  const live = join(dir, `port-${process.pid}.json`)
  const dead = join(dir, 'port-99999999.json')
  const unusable = join(dir, `port-${process.ppid}.json`)
  await writeFile(
    live,
    JSON.stringify({ pid: process.pid, port: 1, token: 'live', startedAt: 1 }),
  )
  await writeFile(
    dead,
    JSON.stringify({ pid: 99999999, port: 2, token: 'dead', startedAt: 2 }),
  )
  await writeFile(
    unusable,
    JSON.stringify({ pid: process.ppid, token: 'no-port' }),
  )
  expect((await discoverPortFile(dir))?.port).toBe(1)
  expect((await readdir(dir)).sort()).toEqual(
    [`port-${process.pid}.json`, `port-${process.ppid}.json`].sort(),
  )
})

test('managed directory predicate treats prefixes literally and preserves unprefixed legacy names', () => {
  const matches = createManagedRpcStateDirPredicate('fixture.+-')
  expect(matches('fixture.+-deadbeefdeadbeef')).toBe(true)
  expect(matches('fixtureZZ-deadbeefdeadbeef')).toBe(false)
  expect(matches('deadbeefdeadbeef')).toBe(true)
  expect(matches('unrelated')).toBe(false)
  expect(createManagedRpcStateDirPredicate('dead')('deadbeefdeadbeef')).toBe(
    true,
  )
})
