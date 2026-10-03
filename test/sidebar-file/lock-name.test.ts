import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  acquireRefreshFileLock,
  LockContentionError,
  LockOwnershipError,
  lockPathFor,
  type RefreshFileLock,
} from '../../src/fs/index.js'
import { createSidebarFile } from '../../src/sidebar-file/index.js'
import { lockIsReleased } from '../fixtures/released-lock.js'
import { makeTempDir } from '../fixtures/scratch.js'

let dir: string
let target: string
const INITIAL = `${JSON.stringify({ writer: 'initial' })}\n`
beforeEach(async () => {
  dir = await makeTempDir()
  target = join(dir, 'sidebar-state.json')
  await writeFile(target, INITIAL)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const sidebar = (lockName?: string) =>
  createSidebarFile<Record<string, unknown>>({
    path: target,
    defaultValue: {},
    normalize: (parsed) =>
      parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : {},
    timeoutMs: 300,
    secureDir: false,
    lockName,
  })
// The lock files holding a live lease. A released lock leaves its file behind
// with an expired record, which no writer holds.
const lockFiles = async () => {
  const held: string[] = []
  for (const name of await readdir(dir)) {
    if (name.endsWith('.lock') && !(await lockIsReleased(join(dir, name))))
      held.push(name)
  }
  return held.sort()
}

test('a writer takes the lock named by lockName and only that one', async () => {
  let custom: string[] = []
  await sidebar('sidebar').write(
    { writer: 'custom' },
    {
      beforeRecheck: async () => {
        custom = await lockFiles()
      },
    },
  )
  expect(custom).toEqual(['sidebar-state.json.sidebar.lock'])
  let standard: string[] = []
  await sidebar().write(
    { writer: 'default' },
    {
      beforeRecheck: async () => {
        standard = await lockFiles()
      },
    },
  )
  expect(standard).toEqual(['sidebar-state.json.sidebar-write.lock'])
})

test('a held lock of the configured name excludes the writer and keeps the file', async () => {
  const held = await acquireRefreshFileLock({
    path: target,
    name: 'sidebar',
    ttlMs: 10_000,
  })
  if (!held) throw new Error('fixture could not take the lock')
  try {
    await expect(
      sidebar('sidebar').write({ writer: 'custom' }),
    ).rejects.toBeInstanceOf(LockContentionError)
  } finally {
    await held.release()
  }
  expect(await readFile(target, 'utf8')).toBe(INITIAL)
})

test('the before-rename fence follows the configured lock name', async () => {
  let foreign: RefreshFileLock | null = null
  try {
    await expect(
      sidebar('sidebar').write(
        { writer: 'custom' },
        {
          beforeRecheck: async () => {
            // A successor takes over the configured lock between the merge
            // and the rename.
            await rm(lockPathFor(target, 'sidebar'), { force: true })
            foreign = await acquireRefreshFileLock({
              path: target,
              name: 'sidebar',
              ttlMs: 10_000,
            })
          },
        },
      ),
    ).rejects.toBeInstanceOf(LockOwnershipError)
    expect(foreign).not.toBeNull()
  } finally {
    await (foreign as RefreshFileLock | null)?.release()
  }
  expect(await readFile(target, 'utf8')).toBe(INITIAL)
})
