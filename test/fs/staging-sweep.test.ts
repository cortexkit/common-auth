import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import {
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import {
  acquireRefreshFileLock,
  forgetStagingSweepsForTest,
  setStagingSweepTestHooksForTest,
  settleStagingSweepsForTest,
} from '../../src/fs/refresh-file-lock.js'
import { lockPathFor } from '../../src/fs/with-lock.js'
import { makeTempDir } from '../fixtures/scratch.js'

// Lease staging files sit beside the lock as `<lock file>.<uuid>.tmp` and hold
// the owner record the writer was about to publish. A crashed writer leaves
// one behind; the holder of the next acquisition removes the expired ones.

const DAY_MS = 24 * 60 * 60_000
const options = { name: 'roster', ttlMs: 10_000 }
let dir: string
let path: string
let lockPath: string

beforeEach(async () => {
  dir = await makeTempDir('staging-sweep-')
  path = join(dir, 'state.json')
  lockPath = lockPathFor(path, options.name)
  forgetStagingSweepsForTest()
})

afterEach(async () => {
  await settleStagingSweepsForTest()
  setStagingSweepTestHooksForTest()
  await rm(dir, { recursive: true, force: true })
})

function stagingPath(): string {
  return `${lockPath}.${randomUUID()}.tmp`
}

async function plantRecord(file: string, expiresAt: number): Promise<string> {
  // The exact bytes a lease writer stages: one JSON record and a newline.
  await writeFile(
    file,
    `${JSON.stringify({ ownerId: randomUUID(), expiresAt })}\n`,
    { mode: 0o600 },
  )
  // A real leftover was last written when its writer died, about one lease
  // before the expiry it records; the sweep skips recently written files.
  if (expiresAt < Date.now()) {
    const written = Math.max(0, expiresAt - options.ttlMs) / 1000
    await utimes(file, written, written)
  }
  return file
}

async function acquireAndSweep() {
  const lock = await acquireRefreshFileLock({ path, ...options })
  expect(lock).not.toBeNull()
  await settleStagingSweepsForTest()
  return lock!
}

async function stagingNames(): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith('.tmp')).sort()
}

describe('abandoned lease staging sweep', () => {
  it('removes expired staging leftovers after the next acquisition', async () => {
    const leftovers = [
      await plantRecord(stagingPath(), Date.now() - DAY_MS),
      await plantRecord(stagingPath(), Date.now() - 2 * DAY_MS),
      await plantRecord(stagingPath(), 0),
    ]
    expect(await stagingNames()).toHaveLength(leftovers.length)
    const lock = await acquireAndSweep()
    expect(await stagingNames()).toEqual([])
    await lock.release()
    expect(await readdir(dir)).toEqual([])
  })

  it('keeps an expired record whose file was written within the margin', async () => {
    // A writer whose clock runs far behind could record an old expiry in a
    // file it is still about to publish; the file's own write time keeps it.
    const file = await plantRecord(stagingPath(), Date.now() - DAY_MS)
    const now = Date.now() / 1000
    await utimes(file, now, now)
    const lock = await acquireAndSweep()
    expect(await stagingNames()).toEqual([file.slice(dir.length + 1)])
    await lock.release()
  })

  it('keeps fresh, misnamed, unparseable and other-shaped files', async () => {
    const expired = Date.now() - DAY_MS
    const fresh = await plantRecord(stagingPath(), Date.now() + 60_000)
    // Expired by its own record but within the minimum age: a writer whose
    // clock disagrees with ours may still be about to publish it.
    const recent = await plantRecord(stagingPath(), Date.now() - 1_000)
    const kept = [
      fresh,
      recent,
      // Names that differ from `<lock file>.<uuid v4>.tmp` in any way.
      await plantRecord(`${lockPath}.${randomUUID().toUpperCase()}.tmp`, 0),
      await plantRecord(`${lockPath}.not-a-uuid.tmp`, expired),
      await plantRecord(`${lockPath}.${randomUUID()}.tmp.bak`, expired),
      await plantRecord(`${lockPath}.${randomUUID()}`, expired),
      await plantRecord(`${path}.${randomUUID()}.tmp`, expired),
      await plantRecord(
        `${lockPathFor(path, 'other')}.${randomUUID()}.tmp`,
        expired,
      ),
      await plantRecord(`${lockPath}x.${randomUUID()}.tmp`, expired),
    ]
    const unparseable = stagingPath()
    await writeFile(unparseable, '{"ownerId":"', { mode: 0o600 })
    const extraField = stagingPath()
    await writeFile(
      extraField,
      `${JSON.stringify({ ownerId: randomUUID(), expiresAt: expired, data: 1 })}\n`,
      { mode: 0o600 },
    )
    const stringExpiry = stagingPath()
    await writeFile(
      stringExpiry,
      `${JSON.stringify({ ownerId: randomUUID(), expiresAt: String(expired) })}\n`,
      { mode: 0o600 },
    )
    const directory = stagingPath()
    await mkdir(directory)
    kept.push(unparseable, extraField, stringExpiry, directory)

    const contents = new Map<string, string>()
    for (const file of kept)
      if (file !== directory) contents.set(file, await readFile(file, 'utf8'))

    const lock = await acquireAndSweep()
    for (const file of kept) {
      if (file === directory) expect((await readdir(file)).length).toBe(0)
      else expect(await readFile(file, 'utf8')).toBe(contents.get(file)!)
    }
    await lock.release()
  })

  it.skipIf(process.platform === 'win32')(
    'keeps a symlink named like staging and the expired record it points to',
    async () => {
      const target = await plantRecord(join(dir, 'target.json'), 0)
      const link = stagingPath()
      await symlink(target, link)
      const lock = await acquireAndSweep()
      expect(await readFile(link, 'utf8')).toBe(await readFile(target, 'utf8'))
      await lock.release()
    },
  )

  it('keeps a staging name reused just before removal', async () => {
    const file = await plantRecord(stagingPath(), 0)
    let replacement = ''
    setStagingSweepTestHooksForTest({
      beforeUnlink: async (candidate) => {
        expect(candidate).toBe(file)
        await unlink(candidate)
        // A fresh record under the same name, as a live writer would stage.
        replacement = `${JSON.stringify({ ownerId: randomUUID(), expiresAt: Date.now() + 60_000 })}\n`
        await writeFile(candidate, replacement, { mode: 0o600 })
      },
    })
    const lock = await acquireAndSweep()
    expect(await readFile(file, 'utf8')).toBe(replacement)
    await lock.release()
  })

  it('sweeps each lock path only once per process', async () => {
    const listed: string[] = []
    setStagingSweepTestHooksForTest({
      readdir: async (directory) => {
        listed.push(directory)
        return readdir(directory)
      },
    })
    const first = await acquireAndSweep()
    await first.release()
    const late = await plantRecord(stagingPath(), 0)
    const second = await acquireAndSweep()
    await second.release()
    expect(listed).toEqual([dir])
    expect(await stagingNames()).toEqual([late.slice(dir.length + 1)])

    // A different lock in the same folder gets its own sweep.
    const other = await acquireRefreshFileLock({
      path,
      name: 'other',
      ttlMs: options.ttlMs,
    })
    expect(other).not.toBeNull()
    await settleStagingSweepsForTest()
    await other!.release()
    expect(listed).toEqual([dir, dir])
  })

  for (const [fault, hooks] of [
    [
      'listing',
      {
        readdir: async () => {
          throw Object.assign(new Error('injected readdir failure'), {
            code: 'EIO',
          })
        },
      },
    ],
    [
      'removal',
      {
        unlink: async () => {
          throw Object.assign(new Error('injected unlink failure'), {
            code: 'EACCES',
          })
        },
      },
    ],
    [
      'listing (synchronous throw)',
      {
        readdir: () => {
          throw new Error('injected synchronous readdir failure')
        },
      },
    ],
  ] as const) {
    it(`acquires normally when the sweep's ${fault} fails`, async () => {
      const leftover = await plantRecord(stagingPath(), 0)
      setStagingSweepTestHooksForTest(hooks)
      const lock = await acquireAndSweep()
      await lock.assertOwned()
      expect(await stagingNames()).toEqual([leftover.slice(dir.length + 1)])
      await lock.release()
      expect(await stagingNames()).toEqual([leftover.slice(dir.length + 1)])
    })
  }
})
