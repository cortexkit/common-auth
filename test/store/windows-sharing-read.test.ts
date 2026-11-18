import { expect, test } from 'bun:test'

test.each([
  ['transient', 'pool read recovers from two Windows sharing failures'],
  ['persistent', 'pool read reports persistent Windows sharing as contention'],
  ['access-denied', 'pool read does not retry Windows access denied'],
  ['settings', 'config read reports the Windows overlap after bounded retries'],
])('%s: %s', async (mode) => {
  const child = Bun.spawn(
    [process.execPath, 'test/store/windows-sharing-read-probe.mjs', mode],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [stderr, exit] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exit !== 0) throw new Error(stderr)
  expect(stderr).toBe('')
})
