import { expect, test } from 'bun:test'

test('shared sidebar distinguishes no reading from exhausted quota', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      '--preload',
      '@opentui/solid/preload',
      'test/quota-sidebar/readings-render.tsx',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
  expect(stdout).toContain('6 reading-state frames and style spans matched')
}, 30_000)
