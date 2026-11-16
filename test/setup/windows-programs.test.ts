import { describe, expect, test } from 'bun:test'
import { win32 } from 'node:path'
import {
  type CommandRunner,
  createProcessFence,
  listSetupProcesses,
  ProcessInspectionError,
  type ProcessInspectionStep,
  type SetupEnvironment,
} from '../../src/setup/index.js'

const POWERSHELL =
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const TASKLIST = 'C:\\Windows\\System32\\tasklist.exe'
const SLOW_CHECK =
  'Checking that OpenCode and Pi are not running. Without PowerShell 7 this can take up to a minute on Windows ARM; installing PowerShell 7 makes it fast.'
const FENCE_QUERY = `$ErrorActionPreference = 'Stop'; $rows = @(Get-CimInstance Win32_Process -Filter "Name LIKE 'opencode%' OR Name LIKE 'litecode%' OR Name LIKE 'opencode2%' OR Name LIKE 'pi%' OR Name LIKE 'node%' OR Name LIKE 'bun%'" | Select-Object Name,ProcessId,CommandLine); ConvertTo-Json -Compress -Depth 3 -InputObject @{ complete = $true; processes = $rows }`
const RUNTIME_QUERY = `$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'bun.exe'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`

function recordingRunner(hostImagesOnly: boolean) {
  const calls: Array<{
    file: string
    args: readonly string[]
    options: Parameters<CommandRunner['run']>[2]
  }> = []
  const runner: CommandRunner = {
    async run(file, args, options) {
      calls.push({ file, args, options })
      return {
        exitCode: 0,
        stdout: file.endsWith('tasklist.exe')
          ? '"node.exe","111","Console","1","30 K"\n'
          : hostImagesOnly
            ? '{"complete":true,"processes":[]}'
            : '[]',
        stderr: '',
      }
    },
  }
  return { calls, runner }
}

const MODES = [
  { name: 'fence', hostImagesOnly: true },
  { name: 'full listing', hostImagesOnly: false },
]

describe('Windows program selection', () => {
  for (const { name, hostImagesOnly } of MODES) {
    test.each([true, false])(
      `${name} uses absolute paths and unchanged CIM arguments (pwsh=%s)`,
      async (pwsh) => {
        const { calls, runner } = recordingRunner(hostImagesOnly)
        const checked: string[] = []
        const env = {
          SystemRoot: 'D:\\System',
          ProgramFiles: 'E:\\Programs',
          PATH: 'C:\\untrusted',
        }
        await listSetupProcesses(runner, {
          platform: 'win32',
          selfPid: -1,
          env,
          hostImagesOnly,
          isFile: (file) => {
            checked.push(file)
            return pwsh
          },
        })
        expect(checked).toEqual(['E:\\Programs\\PowerShell\\7\\pwsh.exe'])
        expect(calls.map((call) => call.file)).toEqual([
          ...(!hostImagesOnly ? ['D:\\System\\System32\\tasklist.exe'] : []),
          pwsh
            ? 'E:\\Programs\\PowerShell\\7\\pwsh.exe'
            : 'D:\\System\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        ])
        expect(calls.every((call) => win32.isAbsolute(call.file))).toBe(true)
        expect(calls.at(-1)?.args).toEqual([
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          hostImagesOnly ? FENCE_QUERY : RUNTIME_QUERY,
        ])
        expect(calls.every((call) => call.options?.env === env)).toBe(true)
      },
    )

    test.each([
      { pwsh: true, arch: 'ARM64', timeout: 45_000 },
      { pwsh: false, arch: 'AMD64', timeout: 45_000 },
      { pwsh: false, arch: 'ARM64', timeout: 90_000 },
      { pwsh: false, arch: 'x86', native: 'ARM64', timeout: 90_000 },
      { pwsh: false, arch: 'ARM64', native: 'AMD64', timeout: 45_000 },
      { pwsh: false, arch: 'arm64', timeout: 90_000 },
    ])(
      `${name} budgets CIM by program and native architecture: %j`,
      async ({ pwsh, arch, native, timeout }) => {
        const { calls, runner } = recordingRunner(hostImagesOnly)
        await listSetupProcesses(runner, {
          platform: 'win32',
          selfPid: -1,
          hostImagesOnly,
          env: { PROCESSOR_ARCHITECTURE: arch, PROCESSOR_ARCHITEW6432: native },
          isFile: () => pwsh,
        })
        expect(calls.at(-1)?.options?.timeoutMs).toBe(timeout)
        expect(calls.at(-1)?.file).toBe(pwsh ? PWSH : POWERSHELL)
      },
    )
  }

  test.each([
    { env: {}, root: 'C:\\Windows', programs: 'C:\\Program Files' },
    {
      env: { windir: 'D:\\Win' },
      root: 'D:\\Win',
      programs: 'C:\\Program Files',
    },
    {
      env: {
        SystemRoot: 'E:\\Win',
        windir: 'D:\\Ignored',
        ProgramFiles: 'F:\\Apps',
      },
      root: 'E:\\Win',
      programs: 'F:\\Apps',
    },
    {
      env: { SYSTEMROOT: 'E:\\Win', PROGRAMFILES: 'F:\\Apps' },
      root: 'E:\\Win',
      programs: 'F:\\Apps',
    },
  ])(
    'resolves environment roots and missing-variable fallbacks: %j',
    async ({ env, root, programs }) => {
      for (const pwsh of [true, false]) {
        const { calls, runner } = recordingRunner(false)
        const checked: string[] = []
        await listSetupProcesses(runner, {
          platform: 'win32',
          selfPid: -1,
          env: env as SetupEnvironment,
          isFile: (file) => {
            checked.push(file)
            return pwsh
          },
        })
        expect(checked).toEqual([`${programs}\\PowerShell\\7\\pwsh.exe`])
        expect(calls.map((call) => call.file)).toEqual([
          `${root}\\System32\\tasklist.exe`,
          pwsh
            ? `${programs}\\PowerShell\\7\\pwsh.exe`
            : `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
        ])
      }
    },
  )
})

describe('Windows slow-check progress', () => {
  test.each([
    { platform: 'win32', arch: 'ARM64', pwsh: false, slow: true },
    {
      platform: 'win32',
      arch: 'x86',
      native: 'ARM64',
      pwsh: false,
      slow: true,
    },
    { platform: 'win32', arch: 'ARM64', pwsh: true, slow: false },
    { platform: 'win32', arch: 'AMD64', pwsh: false, slow: false },
    {
      platform: 'win32',
      arch: 'ARM64',
      native: 'AMD64',
      pwsh: false,
      slow: false,
    },
    { platform: 'linux', arch: 'ARM64', pwsh: false, slow: false },
    { platform: 'darwin', arch: 'ARM64', pwsh: false, slow: false },
  ])(
    'reports once before each slow check, never otherwise: %j',
    async ({ platform, arch, native, pwsh, slow }) => {
      const events: string[] = []
      const fence = createProcessFence(
        {
          async run(file) {
            events.push(file)
            return {
              exitCode: 0,
              stdout:
                platform === 'win32'
                  ? '{"complete":true,"processes":[]}'
                  : '1 /bin/sh\n',
              stderr: '',
            }
          },
        },
        {
          platform,
          selfPid: -1,
          isFile: () => pwsh,
          onProgress: (line) => events.push(line),
        },
      )
      for (let check = 0; check < 2; check++)
        expect(
          await fence.listRunningHosts({
            PROCESSOR_ARCHITECTURE: arch,
            PROCESSOR_ARCHITEW6432: native,
          }),
        ).toEqual([])
      const file = platform === 'win32' ? (pwsh ? PWSH : POWERSHELL) : 'ps'
      expect(events).toEqual(
        slow ? [SLOW_CHECK, file, SLOW_CHECK, file] : [file, file],
      )
    },
  )

  test('a Windows ARM preview uses absolute tasklist without checking pwsh or reporting slow progress', async () => {
    const events: string[] = []
    const fence = createProcessFence(
      {
        async run(file) {
          events.push(file)
          return {
            exitCode: 0,
            stdout: '"node.exe","111","Console","1","30 K"\n',
            stderr: '',
          }
        },
      },
      {
        platform: 'win32',
        selfPid: -1,
        isFile: () => {
          events.push('stat')
          return false
        },
        onProgress: (line) => events.push(line),
      },
    )
    expect(
      await fence.previewRunningHosts?.({ PROCESSOR_ARCHITECTURE: 'ARM64' }),
    ).toEqual({ hosts: [], uncheckedRuntimes: 1 })
    expect(events).toEqual([TASKLIST])
  })
})

describe('Windows inspection program metadata', () => {
  for (const pwsh of [true, false]) {
    test.each(['timeout', 'throw', 'invalid'] as const)(
      `CIM records the selected program on %s (pwsh=${pwsh}) without changing refusal text`,
      async (failure) => {
        const steps: ProcessInspectionStep[] = []
        let caught: unknown
        try {
          await listSetupProcesses(
            {
              async run() {
                if (failure === 'throw') throw new Error('secret')
                return {
                  exitCode: failure === 'timeout' ? 1 : 0,
                  stdout: '',
                  stderr: '',
                  timedOut: failure === 'timeout',
                  signal: failure === 'timeout' ? 'SIGTERM' : null,
                  durationMs: 45_001,
                }
              },
            },
            {
              platform: 'win32',
              env: {},
              hostImagesOnly: true,
              isFile: () => pwsh,
              onStep: (step) => steps.push(step),
            },
          )
        } catch (error) {
          caught = error
        }
        const program = pwsh ? 'pwsh' : 'powershell'
        expect(caught).toBeInstanceOf(ProcessInspectionError)
        expect(caught).toMatchObject({ step: 'CIM', program })
        expect(steps).toHaveLength(1)
        expect(steps[0]).toMatchObject({ step: 'CIM', program })
        const error = caught as ProcessInspectionError
        const outcome =
          failure === 'timeout'
            ? 'timed out'
            : failure === 'throw'
              ? 'could not start or complete'
              : 'invalid output (exit code 0)'
        expect(error.refusalText).toBe(
          `Process inspection failed; setup cannot prove hosts are stopped. CIM: ${outcome} after ${Math.round(error.durationMs)} ms.`,
        )
      },
    )
  }
})
