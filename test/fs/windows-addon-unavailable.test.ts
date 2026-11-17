import { expect, test } from 'bun:test'
import { hasUnsafeWording } from '../../src/limits/wording.ts'

test('Windows refuses private files with ERR_PRIVATE_FILES_UNAVAILABLE when the native addon cannot load, writing nothing', async () => {
  const child = Bun.spawn(
    [process.execPath, 'test/fs/windows-addon-unavailable-probe.mjs'],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(stderr).toBe('')
  expect(exit).toBe(0)
  const result = JSON.parse(stdout)
  expect(result).toMatchObject({
    checked: true,
    atomic: { code: 'ERR_PRIVATE_FILES_UNAVAILABLE' },
    enrollment: { code: 'ERR_PRIVATE_FILES_UNAVAILABLE' },
  })
  expect(result.atomic.message).toContain(
    '. The Windows native addon of @cortexkit/private-files could not be loaded, so owner-only access cannot be enforced and nothing was read or written.',
  )
  // OpenCode 1 retries a plain error whose message matches its retry words.
  expect(hasUnsafeWording(result.atomic.message)).toBe(false)
})
