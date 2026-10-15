import { describe, expect, test } from 'bun:test'
import {
  assertHostsStopped,
  type CommandRunner,
  createProcessFence,
  listSetupProcesses,
  ProcessFenceViolationError,
  ProcessInspectionError,
  type ProcessInspectionStep,
} from '../../src/setup/index.js'

describe('setup process fence', () => {
  test('Windows CIM uses a 45 second one-shot budget and still refuses past it', async () => {
    for (const durationMs of [20_000, 45_001]) {
      const calls: string[] = []
      const runner: CommandRunner = {
        async run(file, _args, options) {
          calls.push(file)
          if (file === 'tasklist.exe') {
            expect(options?.timeoutMs).toBeUndefined()
            return {
              exitCode: 0,
              stdout: '"node.exe","111","Console","1","30 K"\n',
              stderr: '',
              durationMs: 300,
            }
          }
          expect(file).toBe('powershell.exe')
          const timedOut = durationMs > (options?.timeoutMs ?? 15_000)
          return {
            exitCode: timedOut ? 1 : 0,
            signal: timedOut ? 'SIGTERM' : null,
            timedOut,
            durationMs,
            stdout: timedOut
              ? ''
              : JSON.stringify({
                  ProcessId: 111,
                  CommandLine:
                    'node C:\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js --secret hidden',
                }),
            stderr: timedOut ? 'secret stderr' : '',
          }
        },
      }
      const fence = createProcessFence(runner, { platform: 'win32' })
      if (durationMs === 20_000) {
        expect(
          (await fence.listRunningHosts()).map((host) => host.pid),
        ).toEqual([111])
      } else {
        try {
          await assertHostsStopped(fence)
          throw new Error('must refuse')
        } catch (error) {
          expect(error).toBeInstanceOf(ProcessInspectionError)
          expect(error).toMatchObject({
            step: 'CIM',
            timedOut: true,
            durationMs: 45_001,
          })
          expect((error as ProcessInspectionError).refusalText).toContain(
            'CIM: timed out',
          )
          expect((error as ProcessInspectionError).refusalText).not.toContain(
            'secret',
          )
        }
      }
      expect(calls).toEqual(['tasklist.exe', 'powershell.exe'])
    }
  })

  test('inspection failures carry safe step timeout exit signal and duration fields', async () => {
    for (const step of ['tasklist', 'CIM', 'ps'] as const) {
      for (const timedOut of [false, true]) {
        const observations: ProcessInspectionStep[] = []
        const runner = {
          async run(file: string) {
            if (step === 'CIM' && file === 'tasklist.exe')
              return {
                exitCode: 0,
                stdout: '"node.exe","111","Console","1","30 K"\n',
                stderr: '',
              }
            return {
              exitCode: timedOut ? 1 : 7,
              signal: timedOut ? ('SIGTERM' as const) : null,
              timedOut,
              durationMs: timedOut ? 15_010 : 42,
              stdout: 'secret command line',
              stderr: 'secret stderr',
            }
          },
        }
        try {
          await listSetupProcesses(runner, {
            platform: step === 'ps' ? 'linux' : 'win32',
            onStep: (details) => observations.push(details),
          })
          throw new Error('must refuse')
        } catch (error) {
          expect(error).toBeInstanceOf(ProcessInspectionError)
          expect(error).toMatchObject({
            step,
            exitCode: timedOut ? 1 : 7,
            signal: timedOut ? 'SIGTERM' : null,
            timedOut,
            durationMs: timedOut ? 15_010 : 42,
          })
          expect((error as Error).message).toBe(
            'Process inspection failed; setup cannot prove hosts are stopped.',
          )
          expect(observations.at(-1)).toMatchObject({ step, timedOut })
          expect(JSON.stringify(error)).not.toContain('secret')
          expect((error as ProcessInspectionError).refusalText).toContain(
            `${step}: ${timedOut ? 'timed out' : 'exit code 7'}`,
          )
        }
      }
    }
  })

  test('parse and runner exceptions retain the failing step without leaking causes', async () => {
    for (const throws of [false, true]) {
      const runner = {
        async run(file: string) {
          if (file === 'tasklist.exe')
            return {
              exitCode: 0,
              stdout: '"bun.exe","111","Console","1","30 K"\n',
              stderr: '',
            }
          if (throws) throw new Error('secret command line')
          return { exitCode: 0, stdout: 'secret invalid JSON', stderr: '' }
        },
      }
      try {
        await listSetupProcesses(runner, { platform: 'win32' })
        throw new Error('must refuse')
      } catch (error) {
        expect(error).toBeInstanceOf(ProcessInspectionError)
        expect(error).toMatchObject({
          step: 'CIM',
          exitCode: throws ? null : 0,
          signal: null,
          timedOut: false,
        })
        expect(
          (error as ProcessInspectionError).durationMs,
        ).toBeGreaterThanOrEqual(0)
        expect(JSON.stringify(error)).not.toContain('secret')
        expect((error as ProcessInspectionError).refusalText).not.toContain(
          'secret',
        )
      }
    }
  })

  test('Windows idle PID zero and current runtime process are valid listing rows', async () => {
    const runner = {
      async run(file: string) {
        expect(file).toBe('tasklist.exe')
        return {
          exitCode: 0,
          stdout: `"System Idle Process","0","Services","0","8 K"\r\n"node.exe","${process.pid}","Console","1","30,000 K"\r\n`,
          stderr: '',
        }
      },
    }
    expect(await listSetupProcesses(runner, { platform: 'win32' })).toEqual([
      { pid: 0, command: 'System Idle Process' },
      { pid: process.pid, command: 'node.exe' },
    ])
    expect(
      await createProcessFence(runner, {
        platform: 'win32',
      }).listRunningHosts(),
    ).toEqual([])
  })

  test('Windows inspects Node and Bun command lines for host entry scripts', async () => {
    const runner = {
      async run(file: string, args: readonly string[]) {
        if (file === 'tasklist.exe')
          return {
            exitCode: 0,
            stdout:
              '"node.exe","111","Console","1","30 K"\n"bun.exe","112","Console","1","20 K"\n"node.exe","113","Console","1","20 K"\n',
            stderr: '',
          }
        expect(file).toBe('powershell.exe')
        expect(args.slice(0, 3)).toEqual([
          '-NoProfile',
          '-NonInteractive',
          '-Command',
        ])
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              ProcessId: 111,
              CommandLine:
                '"C:\\node.exe" "C:\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" --secret hidden',
            },
            {
              ProcessId: 112,
              CommandLine:
                '"C:\\bun.exe" "C:\\npm\\node_modules\\opencode-ai\\bin\\opencode" --secret hidden',
            },
            {
              ProcessId: 113,
              CommandLine: 'node.exe C:\\work\\ping.js --title pi',
            },
          ]),
          stderr: '',
        }
      },
    }
    const fence = createProcessFence(runner, { platform: 'win32' })
    expect((await fence.listRunningHosts()).map((host) => host.pid)).toEqual([
      111, 112,
    ])
    try {
      await assertHostsStopped(fence)
      throw new Error('must refuse')
    } catch (error) {
      expect(error).toBeInstanceOf(ProcessFenceViolationError)
      expect((error as ProcessFenceViolationError).activeHosts).toEqual([
        { pid: 111, command: 'pi' },
        { pid: 112, command: 'opencode' },
      ])
      expect((error as Error).message).not.toContain('hidden')
    }
  })

  test('Windows runtime inspection failures and unavailable command lines fail closed', async () => {
    for (const result of [
      { exitCode: 1, stdout: '', stderr: 'sensitive' },
      { exitCode: 0, stdout: 'broken JSON', stderr: '' },
      {
        exitCode: 0,
        stdout: '{"ProcessId":111,"CommandLine":null}',
        stderr: '',
      },
    ]) {
      const runner = {
        async run(file: string) {
          return file === 'tasklist.exe'
            ? {
                exitCode: 0,
                stdout: '"node.exe","111","Console","1","30 K"\n',
                stderr: '',
              }
            : result
        },
      }
      await expect(
        createProcessFence(runner, { platform: 'win32' }).listRunningHosts(),
      ).rejects.toThrow('cannot prove hosts are stopped')
    }
  })

  test('a runtime exiting between Windows snapshots is not a running host', async () => {
    const runner = {
      async run(file: string) {
        return file === 'tasklist.exe'
          ? {
              exitCode: 0,
              stdout: '"node.exe","111","Console","1","30 K"\n',
              stderr: '',
            }
          : { exitCode: 0, stdout: 'null', stderr: '' }
      },
    }
    expect(
      await createProcessFence(runner, {
        platform: 'win32',
      }).listRunningHosts(),
    ).toEqual([])
  })

  test('POSIX runtime entry scripts for Pi are recognized without exposing arguments', async () => {
    for (const script of [
      '/usr/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
      '/usr/node_modules/@mariozechner/pi-coding-agent/dist/cli.js',
      '/opt/pi-coding-agent/dist/bun/cli.js',
    ]) {
      const fence = createProcessFence(
        {
          async run() {
            return {
              exitCode: 0,
              stdout: `123 node ${script} --token hidden\n`,
              stderr: '',
            }
          },
        },
        { platform: 'linux' },
      )
      await expect(assertHostsStopped(fence)).rejects.toThrow('Please quit')
    }
  })

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

  test('a shell whose command line mentions an opencode folder is not a running host', async () => {
    const fence = createProcessFence(
      {
        async run() {
          return {
            exitCode: 0,
            stdout: [
              '1 /bin/bash -c cd /work/packages/opencode && bun test src',
              '2 bash -c cd /home/runner/opencode && bun run build',
              '5 sh -c bun test /work/opencode --cwd /work/pi',
              '6 bun test /work/packages/opencode',
              '7 node /usr/lib/node_modules/opencode-ai/bin/opencode --token secret',
            ].join('\n'),
            stderr: '',
          }
        },
      },
      { platform: 'linux' },
    )
    expect(await fence.listRunningHosts()).toEqual([
      {
        pid: 7,
        command:
          'node /usr/lib/node_modules/opencode-ai/bin/opencode --token secret',
      },
    ])
  })

  test('runtime options with values are not mistaken for the host script', async () => {
    const lines = [
      '11 node --require /tmp/preload.cjs /tmp/opencode',
      '12 node --import /tmp/preload.mjs /tmp/opencode',
      '13 node -r /tmp/preload.cjs /tmp/pi',
      '14 bun --preload /tmp/p.ts run /tmp/opencode',
      '15 node --env-file=.env /tmp/opencode',
      '16 node -- /tmp/opencode',
      '17 node -e require("/tmp/opencode")',
      '18 bun test /work/packages/opencode',
    ]
    const fence = createProcessFence(
      {
        async run() {
          return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
        },
      },
      { platform: 'linux' },
    )
    expect((await fence.listRunningHosts()).map((host) => host.pid)).toEqual([
      11, 12, 13, 14, 15, 16,
    ])
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
