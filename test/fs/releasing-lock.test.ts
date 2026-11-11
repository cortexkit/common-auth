import { afterEach, expect, test } from 'bun:test'

let running:
  | {
      mode: string
      child: ReturnType<typeof Bun.spawn>
      output: Promise<[string, string, number]>
    }
  | undefined

afterEach(async () => {
  const owned = running
  running = undefined
  if (!owned) return
  if (owned.child.exitCode === null) owned.child.kill()
  const [stdout, stderr, exit] = await owned.output
  expect(exit, `${owned.mode} failed\n${stdout}\n${stderr}`).toBe(0)
  expect(stderr).toBe('')
  expect(JSON.parse(stdout)).toEqual({ mode: owned.mode, checked: true })
})

for (const mode of ['lock', 'marker', 'cleanup']) {
  test(`Windows owned ${mode} removal retries sharing failures without removing a successor`, async () => {
    const child = Bun.spawn(
      [process.execPath, 'test/fs/releasing-lock-probe.mjs', mode],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const output = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    running = { mode, child, output }
    // The hook owns validation and cleanup even after a test timeout. This
    // waiter cannot reject later and surface a different test's child failure.
    await output.catch(() => {})
  })
}
