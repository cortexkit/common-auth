import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  LockContentionError,
  LockOwnershipError,
  lockPathFor,
} from '../../src/fs/index.js'
import {
  createTuiPreferenceWriter,
  readTuiPreferences,
  readTuiPreferencesFile,
} from '../../src/tui-prefs/index.js'
import { makeTempDir } from '../fixtures/scratch.js'

let dir: string
let file: string
const pluginKey = 'plugin-a'
beforeEach(async () => {
  dir = await makeTempDir()
  file = join(dir, 'tui-preferences.jsonc')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const writer = () => createTuiPreferenceWriter({ file, pluginKey })

test('missing file returns empty object', async () => {
  expect(await readTuiPreferencesFile(file)).toEqual({})
})
test('parses JSONC with comments and trailing commas', async () => {
  await writeFile(file, '// header\n{ // plugin\n"plugin-a": {"order":5,},}\n')
  expect(await readTuiPreferencesFile(file)).toEqual({
    'plugin-a': { order: 5 },
  })
})
for (const [title, bytes] of [
  ['malformed file returns empty object', '{{{{ not json'],
  ['unterminated object returns empty object', '{"plugin-a":{"order":5}'],
  [
    'trailing garbage after object returns empty object',
    '{"plugin-a":{}} garbage',
  ],
  ['non-object root returns empty object', '[1,2,3]'],
]) {
  test(title!, async () => {
    await writeFile(file, bytes!)
    expect(await readTuiPreferencesFile(file)).toEqual({})
  })
}

test('reader delegates plugin schema and defaults to the caller', async () => {
  const defaults = { enabled: false }
  const entries: unknown[] = []
  const options = {
    file,
    pluginKey: 'plugin-b',
    defaults,
    schema: (entry: unknown, fallback: typeof defaults) => {
      entries.push(entry)
      expect(fallback).toBe(defaults)
      return typeof entry === 'boolean' ? { enabled: entry } : fallback
    },
  }
  expect(await readTuiPreferences(options)).toBe(defaults)
  await writeFile(file, '{"plugin-a":false,"plugin-b":true}')
  expect(await readTuiPreferences(options)).toEqual({ enabled: true })
  expect(entries).toEqual([undefined, true])
})

test('creates file with template on first write', async () => {
  await writer().queueTuiPreferenceUpdate(['collapsed'], true)
  expect(await readFile(file, 'utf8')).toContain(
    'Shared preferences for TUI plugins',
  )
  expect(await readTuiPreferencesFile(file)).toEqual({
    'plugin-a': { collapsed: true },
  })
})
test('preserves comments and unrelated keys on update', async () => {
  await writeFile(
    file,
    `// my notes
{
  // keep me
  "other-plugin": { "forceToTop": true },
  "plugin-a": {
    "pollMs": 2000, // tuned
    "collapsed": false
  }
}
`,
  )
  await writer().queueTuiPreferenceUpdate(['collapsed'], true)
  const text = await readFile(file, 'utf8')
  for (const fragment of [
    '// my notes',
    '// keep me',
    '// tuned',
    '"pollMs": 2000',
  ])
    expect(text).toContain(fragment)
  expect(await readTuiPreferencesFile(file)).toEqual({
    'other-plugin': { forceToTop: true },
    'plugin-a': { pollMs: 2000, collapsed: true },
  })
})
test('writes nested paths', async () => {
  await writer().queueTuiPreferenceUpdate(['header', 'label'], 'Q')
  expect(await readTuiPreferencesFile(file)).toEqual({
    'plugin-a': { header: { label: 'Q' } },
  })
})
test('rapid sequential updates land the final value', async () => {
  const instance = writer()
  await Promise.all(
    [true, false, true, false].map((value) =>
      instance.queueTuiPreferenceUpdate(['collapsed'], value),
    ),
  )
  expect(await readTuiPreferencesFile(file)).toEqual({
    'plugin-a': { collapsed: false },
  })
})
test('no temp files are left behind', async () => {
  await writer().queueTuiPreferenceUpdate(['collapsed'], true)
  expect(await readdir(dir)).toEqual(['tui-preferences.jsonc'])
})
test('independent writers preserve both plugin updates under the shared lock', async () => {
  await Promise.all([
    writer().queueTuiPreferenceUpdate(['enabled'], true),
    createTuiPreferenceWriter({
      file,
      pluginKey: 'plugin-b',
    }).queueTuiPreferenceUpdate(['label'], 'B'),
  ])
  expect(await readTuiPreferencesFile(file)).toEqual({
    'plugin-a': { enabled: true },
    'plugin-b': { label: 'B' },
  })
})
test('creates a caller supplied missing parent directory', async () => {
  file = join(dir, 'nested', 'tui-preferences.jsonc')
  await writer().queueTuiPreferenceUpdate(['enabled'], true)
  expect(await readTuiPreferencesFile(file)).toEqual({
    'plugin-a': { enabled: true },
  })
})

test('preferences contention waits 2000 ms, rejects, and the same queue recovers', async () => {
  const bytes = '{"plugin-a":{"collapsed":false}}'
  await writeFile(file, bytes)
  const lockPath = lockPathFor(file, 'preferences')
  await writeFile(
    lockPath,
    JSON.stringify({ ownerId: 'competing', expiresAt: Date.now() + 10000 }),
  )
  const instance = writer()
  const started = performance.now()
  let caught: unknown
  try {
    await instance.queueTuiPreferenceUpdate(['collapsed'], true)
  } catch (error) {
    caught = error
  }
  const elapsed = performance.now() - started
  expect(caught).toBeInstanceOf(LockContentionError)
  expect((caught as LockContentionError).details).toEqual({
    target: file,
    name: 'preferences',
    timeoutMs: 2000,
  })
  expect(elapsed).toBeGreaterThanOrEqual(2000)
  expect(elapsed).toBeLessThan(7000)
  expect(await readFile(file, 'utf8')).toBe(bytes)
  await rm(lockPath)
  await instance.queueTuiPreferenceUpdate(['collapsed'], true)
  expect(await readFile(file, 'utf8')).not.toBe(bytes)
  expect(await readTuiPreferencesFile(file)).toEqual({
    'plugin-a': { collapsed: true },
  })
})

test('preferences TTL is 10000 ms in the staged write lease', async () => {
  let observed = false
  await createTuiPreferenceWriter({
    file,
    pluginKey,
    beforeCommit: async () => {
      const owner = JSON.parse(
        await readFile(lockPathFor(file, 'preferences'), 'utf8'),
      )
      expect(Math.abs(owner.expiresAt - (Date.now() + 10000))).toBeLessThan(
        1000,
      )
      expect(
        (await readdir(dir)).some(
          (name) =>
            name.startsWith('tui-preferences.jsonc.') && name.endsWith('.tmp'),
        ),
      ).toBe(true)
      observed = true
    },
  }).queueTuiPreferenceUpdate(['collapsed'], true)
  expect(observed).toBe(true)
})

test('preferences renews its lease while a staged write is held', async () => {
  let observed = false
  await createTuiPreferenceWriter({
    file,
    pluginKey,
    beforeCommit: async () => {
      const lockPath = lockPathFor(file, 'preferences')
      const before = JSON.parse(await readFile(lockPath, 'utf8'))
      await sleep(5000)
      const after = JSON.parse(await readFile(lockPath, 'utf8'))
      expect(after.ownerId).toBe(before.ownerId)
      expect(after.expiresAt - before.expiresAt).toBeGreaterThanOrEqual(3000)
      const { stat } = await import('node:fs/promises')
      expect((await stat(lockPath)).mode & 0o777).toBe(0o600)
      observed = true
    },
  }).queueTuiPreferenceUpdate(['collapsed'], true)
  expect(observed).toBe(true)
}, 15000)

test('preferences ownership loss after staging rejects without committing or leaking a temp file', async () => {
  const bytes = '// retained\n{"plugin-a":{"collapsed":false}}\n'
  await writeFile(file, bytes)
  const lockPath = lockPathFor(file, 'preferences')
  const instance = createTuiPreferenceWriter({
    file,
    pluginKey,
    beforeCommit: async () => {
      await writeFile(
        lockPath,
        JSON.stringify({ ownerId: 'foreign', expiresAt: Date.now() + 10000 }),
      )
    },
  })
  let caught: unknown
  try {
    await instance.queueTuiPreferenceUpdate(['collapsed'], true)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(LockOwnershipError)
  expect((caught as LockOwnershipError).details).toMatchObject({
    target: file,
    name: 'preferences',
  })
  expect(await readFile(file, 'utf8')).toBe(bytes)
  expect((await readdir(dir)).sort()).toEqual([
    'tui-preferences.jsonc',
    'tui-preferences.jsonc.preferences.lock',
  ])
})
