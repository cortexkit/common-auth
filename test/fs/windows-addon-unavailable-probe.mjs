// Runs in its own process: it pretends to be Windows before any module under
// test loads, and the real @cortexkit/private-files package then fails to load
// its Windows native addon, as it does on a machine missing the prebuild.
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'private-files-unavailable-'))
Object.defineProperty(process, 'platform', { value: 'win32' })
const { windowsPrivateFiles, PrivateFileError } = await import(
  '../../src/fs/private-files.ts'
)
const { writeJsonAtomic } = await import('../../src/fs/atomic-write.ts')
const {
  ClaustrumEnrollmentManager,
  getClaustrumEnrollmentPaths,
  readClaustrumEnrollmentToken,
} = await import('../../src/claustrum/enrollment.ts')

const refusals = []
async function refuses(operation) {
  try {
    await operation()
  } catch (error) {
    refusals.push(error)
    return error
  }
  assert.fail('the operation did not refuse')
}

try {
  assert.equal(windowsPrivateFiles, true)

  const atomic = await refuses(() =>
    writeJsonAtomic(join(root, 'accounts.json'), { secret: 'DO-NOT-WRITE' }),
  )

  let proposals = 0
  let tokenWrites = 0
  const paths = getClaustrumEnrollmentPaths(
    join(root, 'vault', 'opencode-enrollment.json'),
  )
  const manager = new ClaustrumEnrollmentManager({
    proposedName: 'test-auth-opencode',
    paths,
    client: {
      async enrollPropose() {
        proposals++
        return { requestId: 'request-1' }
      },
      async enrollPoll() {
        return {
          status: 'approved',
          token: 'f'.repeat(64),
          tokenGeneration: 1,
          name: 'test-auth-opencode',
        }
      },
    },
    writeTokenFile: async () => {
      tokenWrites++
    },
  })
  const enrollment = await refuses(() => manager.reconcile())
  await refuses(() => readClaustrumEnrollmentToken(paths.tokenPath))

  for (const error of refusals) {
    assert.ok(error instanceof PrivateFileError, String(error))
    assert.equal(error.code, 'ERR_PRIVATE_FILES_UNAVAILABLE')
    assert.equal(error.reason, 'native-addon-unavailable')
    assert.ok(!error.message.includes('DO-NOT-WRITE'))
  }
  // The addon is tried once per process: every refusal carries the same
  // load failure instead of loading again.
  const loadFailure = refusals[0].cause?.cause
  assert.ok(loadFailure instanceof Error)
  for (const error of refusals) assert.equal(error.cause?.cause, loadFailure)

  assert.equal(proposals, 0)
  assert.equal(tokenWrites, 0)
  assert.deepEqual(await readdir(root), [])
  console.log(
    JSON.stringify({
      checked: true,
      atomic: {
        code: atomic.code,
        stage: atomic.stage,
        message: atomic.message,
      },
      enrollment: { code: enrollment.code, stage: enrollment.stage },
    }),
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
