import { expect, test } from 'bun:test'

for (const check of [
  'collapsed sections only with collapsed account rows',
  'mixed gutters at 26 columns',
  'mixed gutters at 20 columns',
  'empty quota text stays on one line at 20 columns',
  'frame text does not wrap but plugin text still can',
]) {
  test(`shared sidebar: ${check}`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        '--preload',
        '@opentui/solid/preload',
        'test/quota-sidebar/peer-checks-render.tsx',
        check,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
    expect(stdout).toContain(`sidebar peer check passed: ${check}`)
  }, 30_000)
}
