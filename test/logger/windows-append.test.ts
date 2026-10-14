import { expect, test } from 'bun:test'

for (const [mode, title] of [
  [
    'steady',
    'Windows logger steady flushes append without reading or rewriting the log',
  ],
  [
    'rotation',
    'Windows logger rotation retains verified replacement and closes handles',
  ],
  ['refusal', 'Windows logger refuses before opening an unverified file'],
  [
    'lifecycle',
    'Windows logger reopens after path changes and IO errors without leaking handles',
  ],
] as const) {
  test(title, async () => {
    const child = Bun.spawn(
      [process.execPath, 'test/logger/windows-append-probe.mjs', mode],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const timeout = setTimeout(() => child.kill(), 10_000)
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(stderr).toBe('')
      expect(exit).toBe(0)
      expect(JSON.parse(stdout)).toEqual(
        mode === 'steady'
          ? {
              mode,
              flushes: 50,
              readsAfterFirst: 0,
              replacementsAfterFirst: 0,
              opens: 1,
              closes: 1,
            }
          : { mode, checked: true },
      )
    } finally {
      clearTimeout(timeout)
      child.kill()
    }
  })
}
