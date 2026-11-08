import { expect, test } from 'bun:test'

test('quota adapter tracks the caller clock and quota and preserves slot account identity', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      '--conditions=browser',
      '--preload',
      '@opentui/solid/runtime-plugin-support',
      '--preload',
      './test/sidebar-peer-preload.ts',
      'test/quota-sidebar/adapter-render.tsx',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
  expect(stdout).toContain(
    'quota adapter clock, quota and slot identity passed',
  )
}, 30_000)
