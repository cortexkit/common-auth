import { describe, expect, test } from 'bun:test'
import {
  assertHostsStopped,
  createProcessFence,
  ProcessFenceViolationError,
} from '../../src/setup/index.js'

describe('setup process fence', () => {
  test('refuses active POSIX hosts and redacts command arguments', async () => {
    const fence = createProcessFence(
      {
        async run() {
          return {
            exitCode: 0,
            stdout:
              'PID COMMAND\n123 /bin/opencode --token secret\n124 pi --secret value\n125 /bin/litecode\n',
            stderr: '',
          }
        },
      },
      { platform: 'linux' },
    )
    await expect(assertHostsStopped(fence)).rejects.toThrow('Please quit')
    try {
      await assertHostsStopped(fence)
    } catch (error) {
      expect(error).toBeInstanceOf(ProcessFenceViolationError)
      expect((error as Error).message).not.toContain('secret')
      expect((error as ProcessFenceViolationError).activeHosts).toEqual([
        { pid: 123, command: 'opencode' },
        { pid: 124, command: 'pi' },
        { pid: 125, command: 'litecode' },
      ])
    }
  })

  test('Windows tasklist detects hosts with comma-containing memory columns', async () => {
    const fence = createProcessFence(
      {
        async run(file, args) {
          expect(file).toBe('tasklist.exe')
          expect(args).toEqual(['/fo', 'csv', '/nh'])
          return {
            exitCode: 0,
            stdout:
              '"opencode.exe","100","Console","1","30,000 K"\r\n"pi.exe","101","Console","1","20 K"\r\n',
            stderr: '',
          }
        },
      },
      { platform: 'win32' },
    )
    await expect(assertHostsStopped(fence)).rejects.toThrow(
      'OpenCode or Pi processes',
    )
  })

  test('failed or malformed inspection is not proof hosts are stopped', async () => {
    for (const [platform, stdout, exitCode] of [
      ['linux', 'broken', 0],
      ['win32', 'INFO: failed', 0],
      ['linux', '', 1],
    ] as const) {
      const fence = createProcessFence(
        {
          async run() {
            return { exitCode, stdout, stderr: 'sensitive' }
          },
        },
        { platform },
      )
      await expect(assertHostsStopped(fence)).rejects.toThrow(
        'cannot prove hosts are stopped',
      )
    }
  })

  test('unrelated processes and setup itself do not trigger the fence', async () => {
    const fence = createProcessFence(
      {
        async run() {
          return {
            exitCode: 0,
            stdout: `${process.pid} /bin/opencode\n999 /bin/node project.js\n1000 /bin/ping\n`,
            stderr: '',
          }
        },
      },
      { platform: 'linux' },
    )
    await expect(assertHostsStopped(fence)).resolves.toBeUndefined()
  })
})
