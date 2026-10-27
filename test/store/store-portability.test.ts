import { beforeEach, expect } from 'bun:test'
import { rmSync } from 'node:fs'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withLock } from '../../src/fs/with-lock.js'
import { openPoolStore } from '../../src/store/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { makeTempDir } from '../fixtures/scratch.js'
import {
  apiKey,
  listCodec,
  oauth,
  objectStateCodec,
  type Scenario,
  scenario,
} from './helpers.js'

const hooks = lifetimeHooks()
const { afterEach, it } = hooks

let s: Scenario
let copyDir: string
beforeEach(async () => {
  s = hooks.lifetime.manage(await scenario())
  copyDir = await makeTempDir('pool-store-copy-')
})
afterEach(() => {
  s.cleanup()
  rmSync(copyDir, { recursive: true, force: true })
})

// Exercises every kind of content the store files hold: roster rows and
// per-row entries (credential epochs, quota), a rotated credential with its
// stamp and learnt identity, a provider state, and the plugin's settings.
async function populate() {
  const store = s.open({ providerState: objectStateCodec })
  await store.add({
    id: 'a',
    credential: oauth('r-a'),
    providerState: { project: 'p-a' },
  })
  await store.add({ id: 'k', credential: apiKey('key-k') })
  const rotated = await store.refresh('a', async () => ({
    access: 'access-r-a2',
    refresh: 'r-a2',
    expires: 4_000_000_000_000,
  }))
  expect(rotated.status).toBe('rotated')
  await store.recordIdentity('a', 'acct-a', { credentialEpoch: 1 })
  await store.recordQuota(
    'a',
    { credentialEpoch: 1, identity: 'acct-a' },
    'obs-1',
  )
  await store.updateSettings(() => ({ ui: { theme: 'dark' } }))
  return store
}

it('a byte copy of both store files opens in another folder as the same pool', async () => {
  const store = await populate()
  const before = await store.read()
  if (before.status !== 'ready') throw new Error('expected a ready pool')
  const beforeSettings = await store.readSettings()
  if (beforeSettings.status !== 'ready')
    throw new Error('expected ready settings')

  // Copy both files byte for byte while the store's save locks are held, so
  // no write can land half-applied between the two reads.
  const copyConfig = join(copyDir, 'openai-auth.json')
  const copyState = join(copyDir, 'openai-auth-state.json')
  await withLock(
    s.configPath,
    { name: 'save', ttlMs: 10_000, timeoutMs: 5_000 },
    async () =>
      withLock(
        s.statePath,
        { name: 'save', ttlMs: 10_000, timeoutMs: 5_000 },
        async () => {
          await writeFile(copyConfig, await readFile(s.configPath))
          await writeFile(copyState, await readFile(s.statePath))
        },
      ),
  )

  const copied = openPoolStore({
    provider: 'openai',
    configPath: copyConfig,
    statePath: copyState,
    quota: listCodec,
    providerState: objectStateCodec,
  })
  const after = await copied.read()
  if (after.status !== 'ready') throw new Error('expected a ready copy')
  const afterSettings = await copied.readSettings()
  if (afterSettings.status !== 'ready')
    throw new Error('expected ready copy settings')

  expect(after.rows).toEqual(before.rows)
  expect(afterSettings.settings).toEqual(beforeSettings.settings)
  expect(after.rows.find((row) => row.id === 'a')?.providerState).toEqual({
    project: 'p-a',
  })
  expect(await readFile(copyState, 'utf8')).toBe(
    await readFile(s.statePath, 'utf8'),
  )
})

it('neither store file names the folder it lives in', async () => {
  await populate()
  const configText = await readFile(s.configPath, 'utf8')
  const stateText = await readFile(s.statePath, 'utf8')
  // The folder in every spelling the check must catch: resolved and
  // unresolved, with forward and back slashes.
  const spellings = new Set(
    [s.dir, await realpath(s.dir)].flatMap((dir) => [
      dir,
      dir.replaceAll('/', '\\'),
      dir.replaceAll('\\', '/'),
    ]),
  )
  for (const spelling of spellings) {
    if (!spelling) continue
    expect(configText.includes(spelling)).toBe(false)
    expect(stateText.includes(spelling)).toBe(false)
  }
})
