import { expect } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileReadCache } from '../../src/fs/file-read-cache.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'

const { test, afterEach } = lifetimeHooks()
const directories: string[] = []

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'file-read-cache-'))
  directories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

test('file read cache resolves path sets and caches absent files', async () => {
  const dir = await directory()
  const cache = new FileReadCache<number>()
  let reads = 0
  const read = async () => ++reads
  expect(await cache.read([`${dir}/./config`, join(dir, 'state')], read)).toBe(
    1,
  )
  expect(
    await cache.read([join(dir, 'config'), join(dir, 'state')], read),
  ).toBe(1)
  await writeFile(join(dir, 'state'), '{}')
  expect(
    await cache.read([join(dir, 'config'), join(dir, 'state')], read),
  ).toBe(2)
  expect(reads).toBe(2)
})

test('file read cache evicts the oldest of more than 64 path sets', async () => {
  const dir = await directory()
  const cache = new FileReadCache<number>()
  let reads = 0
  const read = async () => ++reads
  for (let i = 0; i < 65; i++)
    expect(await cache.read([join(dir, `${i}`)], read)).toBe(i + 1)
  expect(await cache.read([join(dir, '64')], read)).toBe(65)
  expect(await cache.read([join(dir, '0')], read)).toBe(66)
  expect(reads).toBe(66)
})

test('file read cache does not reuse values when a probe cannot inspect a path', async () => {
  const dir = await directory()
  const parent = join(dir, 'file')
  await writeFile(parent, '{}')
  const cache = new FileReadCache<number>()
  let reads = 0
  const read = async () => ++reads
  const path = join(parent, 'not-a-directory')
  expect(await cache.read([path], read)).toBe(1)
  expect(await cache.read([path], read)).toBe(2)
})
