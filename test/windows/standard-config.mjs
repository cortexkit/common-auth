import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { acquireRefreshFileLock, writeJsonAtomic } from './dist/fs/index.js'
import { readPrivateText } from './dist/fs/private-files.js'
import { writePortFile } from './dist/rpc/port-file.js'

const dir = process.env.COMMON_AUTH_CONFIG_DIR
const legacy = process.env.COMMON_AUTH_LEGACY_FILE
assert.ok(dir && legacy)
const path = join(dir, `common-auth-${process.pid}.json`)
let port
try {
  assert.deepEqual(JSON.parse(await readPrivateText(legacy, true)), {
    legacy: true,
  })
  await writeJsonAtomic(path, { realConfig: true })
  assert.deepEqual(JSON.parse(await readPrivateText(path)), {
    realConfig: true,
  })
  const lease = await acquireRefreshFileLock({
    path,
    name: 'config-proof',
    ttlMs: 30_000,
    renew: false,
  })
  assert.ok(lease)
  await lease.assertOwned()
  assert.equal(
    await acquireRefreshFileLock({
      path,
      name: 'config-proof',
      ttlMs: 30_000,
      renew: false,
    }),
    null,
  )
  await lease.release()
  port = await writePortFile(dir, {
    port: 34567,
    token: 'config-proof-token',
    pid: process.pid,
  })
  assert.equal(
    JSON.parse(await readPrivateText(port)).token,
    'config-proof-token',
  )
  console.log(
    JSON.stringify({
      runtime: process.versions.bun ?? process.version,
      dir,
      legacy,
      path,
      port,
      write: true,
      read: true,
      lock: true,
      migration: true,
      rpc: true,
    }),
  )
} catch (error) {
  await rm(path, { force: true })
  if (port) await rm(port, { force: true })
  throw error
}
