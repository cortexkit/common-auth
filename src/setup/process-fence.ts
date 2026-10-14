import { defaultCommandRunner } from './command-runner.js'
import type { CommandRunner, ProcessFence, SetupEnvironment } from './types.js'

const HOST_PATTERN =
  /(?:^|[/\\])(opencode|litecode|opencode2|pi)(?:\.(?:exe|cmd|bat|m?js))?(?=$|\s|")/i
const PI_SCRIPT_PATTERN =
  /(?:^|[/\\])pi-coding-agent[/\\]dist[/\\](?:(?:bundle|bun)[/\\])?cli\.m?js(?=$|\s|")/i

function hostName(command: string): string | null {
  return (
    HOST_PATTERN.exec(command)?.[1] ??
    (PI_SCRIPT_PATTERN.test(command) ? 'pi' : null)
  )
}

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
      command: hostName(host.command) ?? 'host',
    }))
    super(
      `OpenCode or Pi processes are currently running:\n${safeHosts.map((host) => `  - PID ${host.pid}: ${host.command}`).join('\n')}\n\nPlease quit all OpenCode, LiteCode, and Pi processes before running setup.`,
    )
    this.activeHosts = safeHosts
    this.name = 'ProcessFenceViolationError'
  }
}

/** List processes before filtering hosts; Windows PID 0 is a valid idle-process row. */
export async function listSetupProcesses(
  runner: CommandRunner = defaultCommandRunner,
  options: { platform?: string; env?: SetupEnvironment } = {},
): Promise<Array<{ pid: number; command: string }>> {
  const windows = (options.platform ?? process.platform) === 'win32'
  try {
    const result = await runner.run(
      windows ? 'tasklist.exe' : 'ps',
      windows ? ['/fo', 'csv', '/nh'] : ['-eo', 'pid,command'],
      { env: options.env },
    )
    if (result.exitCode !== 0) throw new ProcessInspectionError()
    const processes: Array<{ pid: number; command: string }> = []
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
      if (!Number.isSafeInteger(pid) || pid < 0)
        throw new ProcessInspectionError()
      processes.push({ pid, command })
    }
    if (!processes.length) throw new ProcessInspectionError()
    // tasklist identifies native hosts, but npm Pi/OpenCode scripts appear as Node or Bun.
    const runtimes = processes.filter(
      (entry) =>
        entry.pid !== process.pid && /^(?:node|bun)\.exe$/i.test(entry.command),
    )
    if (windows && runtimes.length) {
      const details = await runner.run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process -Filter \"Name = 'node.exe' OR Name = 'bun.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
        ],
        { env: options.env },
      )
      if (details.exitCode !== 0) throw new ProcessInspectionError()
      const value: unknown = JSON.parse(details.stdout || 'null')
      const rows: unknown[] =
        value === null ? [] : Array.isArray(value) ? value : [value]
      const commands = new Map<number, string>()
      for (const row of rows) {
        if (
          !row ||
          typeof row !== 'object' ||
          !('ProcessId' in row) ||
          !('CommandLine' in row) ||
          !Number.isSafeInteger(row.ProcessId)
        )
          throw new ProcessInspectionError()
        if (typeof row.CommandLine === 'string')
          commands.set(Number(row.ProcessId), row.CommandLine)
        else if (runtimes.some((entry) => entry.pid === row.ProcessId))
          throw new ProcessInspectionError()
      }
      for (const entry of runtimes) {
        // A process absent from the later CIM snapshot already exited.
        entry.command = commands.get(entry.pid) ?? ''
      }
    }
    return processes
  } catch {
    throw new ProcessInspectionError()
  }
}

export function createProcessFence(
  runner: CommandRunner = defaultCommandRunner,
  options: { platform?: string } = {},
): ProcessFence {
  return {
    async listRunningHosts(env?: SetupEnvironment) {
      return (await listSetupProcesses(runner, { ...options, env })).filter(
        (entry) =>
          entry.pid !== process.pid && hostName(entry.command) !== null,
      )
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
