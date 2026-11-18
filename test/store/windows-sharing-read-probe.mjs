import assert from 'node:assert/strict'
import { resolve } from 'node:path'

// Set the platform before loading the store, in a process isolated from other tests.
Object.defineProperty(process, 'platform', { value: 'win32' })
const api = await import('@cortexkit/private-files')
const { PrivateFileError, setPrivateFilesBackendForTest } = await import(
  '../../src/fs/private-files.ts'
)
const { hasUnsafeWording } = await import('../../src/limits/wording.ts')
const { openPoolStore, POOL_KEY } = await import('../../src/store/index.ts')
const { readPoolConfig } = await import('../../src/store/mutate.ts')

const configPath = resolve('pool.json')
const statePath = resolve('state.json')
const reads = []
let failRead = () => undefined
const store = openPoolStore({
  provider: 'test',
  configPath,
  statePath,
  quota: { validate: () => true, merge: (_prior, next) => next },
})
const config = {
  version: 1,
  accounts: [{ id: 'a', type: 'oauth' }],
  [POOL_KEY]: { schemaVersion: 1, rows: { a: { credentialEpoch: 1 } } },
}
const state = { version: 1, accounts: { a: { refresh: 'r-a' } } }

setPrivateFilesBackendForTest({
  ...api,
  verifySafeParent: async () => ({ ok: true }),
  verifyOwnerOnly: async () => ({ ok: true }),
  verifyPrivatePath: async () => {},
  readOwnerOnly: async (path) => {
    reads.push(path)
    const win32Code = failRead(path)
    if (win32Code !== undefined)
      throw Object.assign(new Error('Cannot open pinned object'), {
        code: 'ERR_PRIVATE_FILES_SECURITY',
        reason: 'io-error',
        win32Code,
      })
    assert.ok(path === configPath || path === statePath)
    return Buffer.from(JSON.stringify(path === configPath ? config : state))
  },
})

switch (process.argv[2]) {
  case 'transient': {
    const ready = await store.read()
    assert.equal(ready.status, 'ready')
    assert.deepEqual(
      ready.rows.map((row) => row.id),
      ['a'],
    )
    reads.length = 0
    const failures = [32, 303]
    failRead = (path) => (path === configPath ? failures.shift() : undefined)
    assert.deepEqual(await store.read(), ready)
    assert.deepEqual(reads, [
      configPath,
      configPath,
      configPath,
      statePath,
      configPath,
    ])
    break
  }
  case 'persistent': {
    failRead = (path) => (path === statePath ? 32 : undefined)
    assert.deepEqual(await store.read(), {
      status: 'error',
      file: 'config',
      kind: 'snapshot-contended',
      retryable: true,
      reason: 'The store was changing; retry the operation once writes settle.',
    })
    assert.deepEqual(reads, [configPath, ...Array(6).fill(statePath)])
    break
  }
  case 'access-denied': {
    failRead = () => 5
    await assert.rejects(store.read(), (error) => {
      assert.ok(error instanceof PrivateFileError)
      assert.equal(error.win32Code, 5)
      assert.match(error.message, /Private file refused at read:.*\(io-error\)/)
      return true
    })
    assert.deepEqual(reads, [configPath])
    break
  }
  case 'settings': {
    failRead = () => 303
    await assert.rejects(readPoolConfig(configPath), (error) => {
      assert.ok(error instanceof PrivateFileError)
      assert.equal(error.win32Code, 303)
      assert.ok(
        error.message.startsWith(`Private file busy at read: ${configPath}.`),
      )
      assert.match(
        error.message,
        /Another process was replacing or deleting this file at the same moment \(Windows error 303\)/,
      )
      assert.equal(hasUnsafeWording(error.message), false)
      return true
    })
    assert.deepEqual(reads, Array(6).fill(configPath))
    break
  }
  default:
    assert.fail(`Unknown probe mode: ${process.argv[2]}`)
}
