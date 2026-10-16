import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultCommandRunner,
  runResolvedCommand,
} from '../../src/setup/command-runner.js'
import type { CommandRunner } from '../../src/setup/index.js'

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
    expect(result.exitCode).toBe(1)
    expect(result.signal).toBe('SIGTERM')
    expect(result.timedOut).toBe(true)
    expect(result.durationMs).toBeGreaterThanOrEqual(100)
  })

  test('missing executables return ENOENT as a spawn error instead of throwing', async () => {
    const result = await defaultCommandRunner.run(
      join(tmpdir(), `missing-setup-command-${randomUUID()}`),
      [],
    )
    expect(result).toMatchObject({
      exitCode: 1,
      spawnError: true,
      stdout: '',
      stderr: '',
      signal: null,
      timedOut: false,
    })
  })

  test('stdout beyond the cap fails the child and keeps only capped output', async () => {
    const result = await defaultCommandRunner.run(process.execPath, [
      '-e',
      `process.stdout.write('x'.repeat(1024 * 1024 + 1))`,
    ])
    expect(result.exitCode).toBe(1)
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(1024 * 1024)
    expect(result.timedOut).toBe(false)
  })

  test('truncated stderr drops leading UTF-8 continuation bytes', async () => {
    const result = await defaultCommandRunner.run(process.execPath, [
      '-e',
      `process.stderr.write('é' + 'a'.repeat(4095))`,
    ])
    expect(result.stderrTruncated).toBe(true)
    expect(result.stderr).toBe('a'.repeat(4095))
    expect(result.stderr).not.toContain('�')
  })

  test('Windows batch launchers preserve cmd.exe verbatim arguments', async () => {
    let invocation:
      | { file: string; args: readonly string[]; options: unknown }
      | undefined
    const runner: CommandRunner = {
      async run(file, args, options) {
        invocation = { file, args, options }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    }
    await runResolvedCommand(
      runner,
      'win32',
      'C:\\npm\\opencode.cmd',
      ['--version'],
      { PATH: 'C:\\npm' },
      2000,
    )
    expect(invocation).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', '""C:\\npm\\opencode.cmd" --version"'],
      options: {
        env: { PATH: 'C:\\npm' },
        timeoutMs: 2000,
        windowsVerbatimArguments: true,
      },
    })
  })
})
