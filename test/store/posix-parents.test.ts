import { expect } from 'bun:test'
import { chmod, mkdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type PosixOwnerOnlyPathAsyncOptions,
  verifySafeParent,
} from '@cortexkit/private-files'
import { setSafeParentOptionsForTest } from '../../src/fs/private-files.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { apiKey, scenario } from './helpers.js'

const hooks = lifetimeHooks()
const { test } = hooks

test.skipIf(process.platform === 'win32')(
  'POSIX store writes below a group-writable ancestor owned by another uid',
  async () => {
    const s = hooks.lifetime.manage(await scenario())
    const ancestor = await realpath(s.dir)
    const parent = join(ancestor, 'store')
    await chmod(ancestor, 0o775)
    await mkdir(parent, { mode: 0o700 })
    const uid = process.geteuid?.() ?? 0
    let metadataReads = 0
    const metadata = async (path: string) => {
      metadataReads += 1
      const info = await stat(path)
      return {
        mode: info.mode,
        uid: path === ancestor ? uid + 1 : info.uid,
        gid: info.gid,
        isDirectory: () => info.isDirectory(),
      }
    }
    // Model a dependency directory owned by a different account without chown
    // privileges. The positive control proves the shared ancestry policy would
    // refuse this exact injected layout; POSIX store IO must not consult it.
    const options: PosixOwnerOnlyPathAsyncOptions = {
      euid: uid,
      fs: { stat: metadata, lstat: metadata },
    }
    expect(await verifySafeParent(parent, options)).toMatchObject({
      ok: false,
      level: ancestor,
      reason: 'wrong-owner',
    })
    expect(metadataReads).toBeGreaterThan(0)
    metadataReads = 0
    setSafeParentOptionsForTest(options)
    try {
      const store = s.open({
        configPath: join(parent, 'config.json'),
        statePath: join(parent, 'state.json'),
      })
      await store.add({ id: 'r', credential: apiKey('secret') })
      const load = await store.read()
      expect(load.status).toBe('ready')
      if (load.status !== 'ready') throw new Error(`pool is ${load.status}`)
      expect(load.rows[0]?.credential).toEqual({
        type: 'api',
        apiKey: 'secret',
        baseURL: 'https://api.example.test/v1',
        authHeader: 'authorization-bearer',
      })
      expect(metadataReads).toBe(0)
      expect((await stat(ancestor)).mode & 0o777).toBe(0o775)
    } finally {
      setSafeParentOptionsForTest(undefined)
      s.cleanup()
    }
  },
)
