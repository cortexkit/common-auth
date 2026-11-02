import { expect, test } from 'bun:test'

for (const mode of ['lock', 'marker', 'cleanup']) {
  test(`Windows owned ${mode} removal retries sharing failures without removing a successor`, async () => {
    const child = Bun.spawn(
      [process.execPath, 'test/fs/releasing-lock-probe.mjs', mode],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (exit !== 0) throw new Error(`${mode} failed\n${stdout}\n${stderr}`)
    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toEqual({ mode, checked: true })
  })
}
