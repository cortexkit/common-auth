import { describe, expect, test } from 'bun:test'
import { defaultCommandRunner } from '../../src/setup/command-runner.js'

describe('setup command runner', () => {
  test('records exit status and elapsed time without marking an ordinary exit as a timeout', async () => {
    const result = await defaultCommandRunner.run(process.execPath, [
      '-e',
      'process.exit(7)',
    ])
    expect(result.exitCode).toBe(7)
    expect(result.signal).toBeNull()
    expect(result.timedOut).toBe(false)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('records a timeout kill and its elapsed time', async () => {
    const result = await defaultCommandRunner.run(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { timeoutMs: 100 },
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.signal).toBe('SIGTERM')
    expect(result.timedOut).toBe(true)
    expect(result.durationMs).toBeGreaterThanOrEqual(100)
  })
})
