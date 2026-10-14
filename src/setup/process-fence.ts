import { defaultCommandRunner } from './command-runner.js'
import type { CommandRunner, ProcessFence, SetupEnvironment } from './types.js'

const HOST_PATTERN =
  /(?:^|[/\\])(opencode|litecode|opencode2|pi)(?:\.exe)?(?=$|\s|")/i

export class ProcessInspectionError extends Error {
  readonly code = 'process-inspection-failed'
  constructor() {
    super('Process inspection failed; setup cannot prove hosts are stopped.')
    this.name = 'ProcessInspectionError'
  }
}

export class ProcessFenceViolationError extends Error {
  readonly activeHosts: Array<{ pid: number; command: string }>
  constructor(activeHosts: Array<{ pid: number; command: string }>) {
    // Process arguments may contain credentials; report only the recognized host name.
    const safeHosts = activeHosts.map((host) => ({
      pid: host.pid,
      command: HOST_PATTERN.exec(host.command)?.[1] ?? 'host',
    }))
    super(
      `OpenCode or Pi processes are currently running:\n${safeHosts.map((host) => `  - PID ${host.pid}: ${host.command}`).join('\n')}\n\nPlease quit all OpenCode, LiteCode, and Pi processes before running setup.`,
    )
    this.activeHosts = safeHosts
    this.name = 'ProcessFenceViolationError'
  }
}

export function createProcessFence(
  runner: CommandRunner = defaultCommandRunner,
  options: { platform?: string } = {},
): ProcessFence {
  const windows = (options.platform ?? process.platform) === 'win32'
  return {
    async listRunningHosts(env?: SetupEnvironment) {
      let result: Awaited<ReturnType<CommandRunner['run']>>
      try {
        result = await runner.run(
          windows ? 'tasklist.exe' : 'ps',
          windows ? ['/fo', 'csv', '/nh'] : ['-eo', 'pid,command'],
          { env },
        )
      } catch {
        throw new ProcessInspectionError()
      }
      if (result.exitCode !== 0) throw new ProcessInspectionError()
      const running: Array<{ pid: number; command: string }> = []
      for (const line of result.stdout.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let pid: number
        let command: string
        if (windows) {
          const match = /^"([^"]+)","(\d+)"(?:,|$)/.exec(trimmed)
          if (!match) throw new ProcessInspectionError()
          command = match[1] ?? ''
          pid = Number(match[2])
        } else {
          const match = /^(\d+)\s+(.+)$/.exec(trimmed)
          if (!match) {
            if (/^PID\s+COMMAND$/i.test(trimmed)) continue
            throw new ProcessInspectionError()
          }
          pid = Number(match[1])
          command = match[2] ?? ''
        }
        if (!Number.isSafeInteger(pid) || pid <= 0)
          throw new ProcessInspectionError()
        if (pid !== process.pid && HOST_PATTERN.test(command))
          running.push({ pid, command })
      }
      return running
    },
  }
}

export async function assertHostsStopped(
  fence: ProcessFence,
  env?: SetupEnvironment,
): Promise<void> {
  const active = await fence.listRunningHosts(env)
  if (active.length) throw new ProcessFenceViolationError(active)
}
