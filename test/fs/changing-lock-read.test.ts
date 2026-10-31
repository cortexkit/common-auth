import { expect, test } from 'bun:test'

async function probe(mode: string) {
  const child = Bun.spawn(
    [process.execPath, 'test/fs/changing-lock-read-probe.mjs', mode],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exit !== 0) throw new Error(`${mode} failed\n${stdout}\n${stderr}`)
  expect(stderr).toBe('')
  return JSON.parse(stdout)
}

test('changing lock reads retry only native sharing and delete-pending errors within the acquire deadline', async () => {
  expect(await probe('simulated')).toEqual({
    transient: 8,
    persistent: 2,
    refused: 12,
  })
})

for (const action of ['delete', 'rewrite']) {
  test.skipIf(process.platform !== 'win32')(
    `Windows native contention read retries while the holder ${action}s its lock`,
    async () => {
      expect(await probe(action)).toEqual({
        action,
        win32Code: 32,
        reason: 'io-error',
        stage: 'read',
        failures: 1,
        committed: true,
      })
    },
  )
}
