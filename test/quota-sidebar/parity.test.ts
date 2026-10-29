import { expect, test } from 'bun:test'

test('shared sidebar preserves frozen OpenAI 1.8.4 UTF-8 frames and spans', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      '--preload',
      '@opentui/solid/preload',
      'test/quota-sidebar/parity-render.tsx',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
  expect(stdout).toContain('32 frozen OpenAI frames and style spans matched')
}, 30_000)

test('shared sidebar composes groups and expanded slots and keeps collapse controlled', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      '--conditions=browser',
      '--preload',
      '@opentui/solid/runtime-plugin-support',
      'test/quota-sidebar/behavior-render.tsx',
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
    'sidebar groups, slots, controlled toggle and empty header passed',
  )
}, 30_000)
