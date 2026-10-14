import { execFile } from 'node:child_process'
import type { CommandResult, CommandRunner, SetupEnvironment } from './types.js'

export const defaultCommandRunner: CommandRunner = {
  run(file, args, options = {}) {
    return new Promise((resolve) => {
      execFile(
        file,
        [...args],
        {
          env: options.env ?? process.env,
          timeout: options.timeoutMs ?? 15_000,
          windowsHide: true,
          windowsVerbatimArguments: options.windowsVerbatimArguments,
          maxBuffer: 1024 * 1024,
        },
        (error, stdout, stderr) => {
          resolve({
            exitCode: error
              ? typeof error.code === 'number'
                ? error.code
                : 1
              : 0,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
          })
        },
      )
    })
  },
}

/** Batch launchers need cmd.exe; no free-form user text is accepted as shell arguments. */
export function runResolvedCommand(
  runner: CommandRunner,
  platform: string,
  file: string,
  args: readonly string[],
  env: SetupEnvironment,
  timeoutMs = 15_000,
): Promise<CommandResult> {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    if (
      /["%!\r\n]/.test(file) ||
      args.some((arg) => !/^[a-zA-Z0-9@:/._+-]+$/.test(arg))
    )
      throw new Error(
        'Unsafe batch launcher or argument; use an executable instead.',
      )
    return runner.run(
      'cmd.exe',
      ['/d', '/s', '/c', `""${file}" ${args.join(' ')}"`],
      {
        env,
        timeoutMs,
        windowsVerbatimArguments: true,
      },
    )
  }
  return runner.run(file, args, { env, timeoutMs })
}
