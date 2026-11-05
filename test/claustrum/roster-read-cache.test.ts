import { expect, spyOn } from 'bun:test'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  mutateVaultRoster,
  readVaultRoster,
  type VaultRosterFile,
} from '../../src/claustrum/roster.js'
import { writeJsonAtomic } from '../../src/fs/atomic-write.js'
import * as privateFiles from '../../src/fs/private-files.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { cleanupDirs, tempDir } from './helpers.js'

const { afterEach, test } = lifetimeHooks()
afterEach(cleanupDirs)

const roster: VaultRosterFile = {
  version: 1,
  view: 'one',
  complete: true,
  rows: [],
  declined: [],
  limits: { future: { values: [1, 2] } },
}

async function fixture() {
  const path = join(await tempDir('roster-read-cache-'), 'host-roster.json')
  await writeJsonAtomic(path, roster)
  return path
}

test.skipIf(process.platform === 'win32')(
  'opens an unchanged roster only once on POSIX',
  async () => {
    const path = await fixture()
    const reads = spyOn(fs, 'readFile')
    try {
      for (let index = 0; index < 5; index++)
        expect(await readVaultRoster(path)).toEqual(roster)
      expect(reads.mock.calls.filter(([file]) => file === path)).toHaveLength(1)
    } finally {
      reads.mockRestore()
    }
  },
)

test('roster reads isolate nested data from caller mutations', async () => {
  const path = await fixture()
  for (let index = 0; index < 2; index++) {
    const value = await readVaultRoster(path)
    if (!value) throw new Error('missing roster')
    expect(value).toEqual(roster)
    value.complete = false
    ;(value.limits as { future: { values: number[] } }).future.values.push(3)
  }
  expect(await readVaultRoster(path)).toEqual(roster)
})

test('roster reads observe rewrites, deletion, absence and recreation', async () => {
  const path = await fixture()
  expect(await readVaultRoster(path)).toEqual(roster)
  await writeJsonAtomic(path, { ...roster, view: 'replacement' })
  expect((await readVaultRoster(path))?.view).toBe('replacement')
  await fs.writeFile(path, JSON.stringify({ ...roster, view: 'in-place' }))
  expect((await readVaultRoster(path))?.view).toBe('in-place')
  await fs.unlink(path)
  expect(await readVaultRoster(path)).toBeUndefined()
  expect(await readVaultRoster(path)).toBeUndefined()
  await writeJsonAtomic(path, roster)
  expect(await readVaultRoster(path)).toEqual(roster)
})

test.skipIf(process.platform === 'win32')(
  'roster reads detect same-size rewrites with restored mtime through ctime',
  async () => {
    const path = await fixture()
    await fs.writeFile(path, JSON.stringify(roster))
    await fs.utimes(path, 123, 123)
    expect(await readVaultRoster(path)).toEqual(roster)
    const before = await fs.stat(path)
    await fs.writeFile(path, JSON.stringify({ ...roster, view: 'two' }))
    await fs.utimes(path, 123, 123)
    const after = await fs.stat(path)
    expect([after.dev, after.ino, after.size, after.mtimeMs]).toEqual([
      before.dev,
      before.ino,
      before.size,
      before.mtimeMs,
    ])
    expect(after.ctimeMs).not.toBe(before.ctimeMs)
    expect((await readVaultRoster(path))?.view).toBe('two')
  },
)

test('a peer roster mutation changes the inode and is seen on the next read', async () => {
  const path = await fixture()
  expect(await readVaultRoster(path)).toEqual(roster)
  const before = await fs.stat(path)
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(
        new URL('../fixtures/roster-replace-process.ts', import.meta.url),
      ),
      path,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [exit, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ])
  expect(exit, stderr).toBe(0)
  const after = await fs.stat(path)
  expect(after.ino).not.toBe(before.ino)
  expect((await readVaultRoster(path))?.view).toBe('peer')
})

test.skipIf(process.platform === 'win32')(
  'locked roster mutations always read fresh without sharing the cached value',
  async () => {
    const path = await fixture()
    await readVaultRoster(path)
    const reads = spyOn(fs, 'readFile')
    try {
      await mutateVaultRoster(path, (current) => {
        if (!current) throw new Error('missing roster')
        current.complete = false
        return { result: undefined }
      })
      expect(reads.mock.calls.filter(([file]) => file === path)).toHaveLength(1)
      expect(await readVaultRoster(path)).toEqual(roster)
    } finally {
      reads.mockRestore()
    }
  },
)

test.skipIf(process.platform === 'win32')(
  'roster reads accept mode 0644 on both cache misses and hits',
  async () => {
    const path = await fixture()
    await fs.chmod(path, 0o644)
    for (let index = 0; index < 2; index++)
      expect(await readVaultRoster(path)).toEqual(roster)
    await fs.chmod(path, 0o600)
    expect(await readVaultRoster(path)).toEqual(roster)
  },
)

test.skipIf(process.platform === 'win32')(
  'roster reads follow symlinks on misses and hits and observe new targets',
  async () => {
    const target = await fixture()
    const path = `${target}.link`
    await fs.symlink(target, path)
    const reads = spyOn(fs, 'readFile')
    try {
      for (let index = 0; index < 2; index++)
        expect(await readVaultRoster(path)).toEqual(roster)
      expect(reads.mock.calls.filter(([file]) => file === path)).toHaveLength(1)
      await writeJsonAtomic(target, { ...roster, view: 'target-replaced' })
      expect((await readVaultRoster(path))?.view).toBe('target-replaced')
      const other = `${target}.other`
      await writeJsonAtomic(other, { ...roster, view: 'repointed' })
      await fs.unlink(path)
      await fs.symlink(other, path)
      expect((await readVaultRoster(path))?.view).toBe('repointed')
      expect(reads.mock.calls.filter(([file]) => file === path)).toHaveLength(3)
    } finally {
      reads.mockRestore()
    }
  },
)

test.skipIf(process.platform === 'win32')(
  'roster stat errors fall through to full reads and evict the previous value',
  async () => {
    const path = await fixture()
    await readVaultRoster(path)
    const probes = spyOn(fs, 'stat').mockRejectedValue(
      Object.assign(new Error('probe refused'), { code: 'EACCES' }),
    )
    const reads = spyOn(fs, 'readFile')
    try {
      for (let index = 0; index < 2; index++)
        expect(await readVaultRoster(path)).toEqual(roster)
      expect(reads.mock.calls.filter(([file]) => file === path)).toHaveLength(2)
    } finally {
      probes.mockRestore()
      reads.mockRestore()
    }
    const after = spyOn(fs, 'readFile')
    try {
      expect(await readVaultRoster(path)).toEqual(roster)
      expect(after.mock.calls.filter(([file]) => file === path)).toHaveLength(1)
    } finally {
      after.mockRestore()
    }
  },
)

test('roster replacement errors cannot return a previous cached success', async () => {
  const path = await fixture()
  await readVaultRoster(path)
  await fs.writeFile(path, '{broken')
  await expect(readVaultRoster(path)).rejects.toThrow(
    'roster file is not valid',
  )
  await writeJsonAtomic(path, roster)
  expect(await readVaultRoster(path)).toEqual(roster)
  await fs.unlink(path)
  await fs.mkdir(path)
  await expect(readVaultRoster(path)).rejects.toThrow()
})

test.skipIf(process.platform !== 'win32')(
  'Windows roster reads keep full private-file validation on every call',
  async () => {
    const path = await fixture()
    const reads = spyOn(privateFiles, 'readPrivateText')
    try {
      for (let index = 0; index < 3; index++)
        expect(await readVaultRoster(path)).toEqual(roster)
      const calls = reads.mock.calls.filter(([file]) => file === path)
      expect(calls).toHaveLength(3)
      expect(calls.every(([, migrate]) => migrate)).toBe(true)
    } finally {
      reads.mockRestore()
    }
  },
)
