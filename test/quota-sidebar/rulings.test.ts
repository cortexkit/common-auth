import { expect, test } from 'bun:test'

for (const rule of ['2', '3', '6', '7', '8', '9', '10']) {
  test(`shared sidebar ruling ${rule}`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        '--preload',
        '@opentui/solid/preload',
        'test/quota-sidebar/rulings-render.tsx',
        rule,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
    expect(stdout).toContain(`sidebar ruling ${rule} passed`)
  }, 30_000)
}
