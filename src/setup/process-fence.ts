import { defaultCommandRunner } from './command-runner.js'
import type {
  CommandResult,
  CommandRunner,
  ProcessFence,
  SetupEnvironment,
} from './types.js'

// A cold PowerShell/WMI query took 13.8 s on Windows Server 2022; warm queries
// took less than 0.5 s. This is the product's one-shot latency budget, not a test
// deadline: 45 s is about three times the worst measured cold start.
const WINDOWS_CIM_TIMEOUT_MS = 45_000

const HOSTS = new Set(['opencode', 'litecode', 'opencode2', 'pi'])
const RUNTIMES = new Set(['node', 'bun'])
const PI_SCRIPT_PATTERN =
  /(?:^|[/\\])pi-coding-agent[/\\]dist[/\\](?:(?:bundle|bun)[/\\])?cli\.m?js$/i

/** Splits a command line into arguments, keeping double-quoted ones whole. */
function commandArguments(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? '',
  )
}

function executableName(argument: string): string {
  return (argument.split(/[/\\]/).pop() ?? '')
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat|m?js)$/, '')
}

// Node and Bun options whose value is the next argument, so that value is not
// mistaken for the script (`node --require ./preload.cjs …/opencode`).
const VALUE_OPTIONS = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '-C',
  '--conditions',
  '--env-file',
  '--title',
  '--input-type',
  '--preload',
  '--cwd',
  '-c',
  '--config',
  '--tsconfig-override',
  '-d',
  '--define',
  '-l',
  '--main-fields',
])
// Options that run inline code instead of a script file.
const INLINE_OPTIONS = new Set(['-e', '--eval', '-p', '--print'])

/** The script a Node or Bun runtime was started with, if any. */
function runtimeScript(runtime: string, args: string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index] ?? ''
    if (argument === '--') return args[index + 1]
    if (INLINE_OPTIONS.has(argument)) return undefined
    if (argument.startsWith('-')) {
      if (!argument.includes('=') && VALUE_OPTIONS.has(argument)) index++
      continue
    }
    // `bun run <script>` names the script after the subcommand.
    if (runtime === 'bun' && argument === 'run') continue
    return argument
  }
  return undefined
}

/**
 * Names the host a process runs, judged by what it executes: the program
 * itself, or the script a Node or Bun runtime was started with. Any other
 * argument is ignored, so a shell whose command line merely mentions an
 * `opencode` folder (`bash -c "cd …/opencode && …"`) is not a running host.
 * `ps` prints arguments unquoted, so on macOS and Linux a program or script
 * path containing spaces is not recognized; npm and Bun install OpenCode and Pi
 * under paths without spaces.
 */
function hostName(command: string): string | null {
  const [program, ...rest] = commandArguments(command)
  if (program === undefined) return null
  const name = executableName(program)
  if (HOSTS.has(name)) return name
  if (!RUNTIMES.has(name)) return null
  const script = runtimeScript(name, rest)
  if (script === undefined) return null
  const scriptName = executableName(script)
  if (HOSTS.has(scriptName)) return scriptName
  return PI_SCRIPT_PATTERN.test(script) ? 'pi' : null
}

export interface ProcessInspectionStep {
  step: 'tasklist' | 'CIM' | 'ps'
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  durationMs: number
}

export class ProcessInspectionError
  extends Error
  implements ProcessInspectionStep
{
  readonly code = 'process-inspection-failed'
  readonly step: ProcessInspectionStep['step']
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly timedOut: boolean
  readonly durationMs: number
  constructor(details: ProcessInspectionStep) {
    super('Process inspection failed; setup cannot prove hosts are stopped.')
    this.name = 'ProcessInspectionError'
    this.step = details.step
    this.exitCode = details.exitCode
    this.signal = details.signal
    this.timedOut = details.timedOut
    this.durationMs = details.durationMs
  }

  get refusalText(): string {
    const outcome = this.timedOut
      ? 'timed out'
      : this.signal
        ? `signal ${this.signal}`
        : this.exitCode === null
          ? 'could not start or complete'
          : this.exitCode === 0
            ? 'invalid output (exit code 0)'
            : `exit code ${this.exitCode}`
    return `${this.message} ${this.step}: ${outcome} after ${Math.round(this.durationMs)} ms.`
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

/**
 * One fence's last Windows command-line answer: the Node and Bun processes it
 * covered (`key`) and the command line it found for each PID.
 */
export interface RuntimeCommandCache {
  key?: string
  commands?: Map<number, string>
}

/** List processes before filtering hosts; Windows PID 0 is a valid idle-process row. */
export async function listSetupProcesses(
  runner: CommandRunner = defaultCommandRunner,
  options: {
    platform?: string
    env?: SetupEnvironment
    onStep?: (details: ProcessInspectionStep) => void
    /** False skips the Windows PowerShell query for Node and Bun command lines. */
    inspectRuntimes?: boolean
    /**
     * The process to leave out, the running setup itself. Defaults to
     * `process.pid`; tests pass a value no listed process can have, because in
     * a container this process can hold any small PID a fixture uses.
     */
    selfPid?: number
    /**
     * Where one fence keeps its last Windows command-line answer. When the
     * Node and Bun processes in `tasklist` are exactly the ones that answer
     * covered, by PID and image name, their command lines are reused instead
     * of starting PowerShell again.
     */
    runtimeCommands?: RuntimeCommandCache
  } = {},
): Promise<Array<{ pid: number; command: string }>> {
  const windows = (options.platform ?? process.platform) === 'win32'
  const selfPid = options.selfPid ?? process.pid
  let inspection: ProcessInspectionStep = {
    step: windows ? 'tasklist' : 'ps',
    exitCode: null,
    signal: null,
    timedOut: false,
    durationMs: 0,
  }
  const inspect = async (
    step: ProcessInspectionStep['step'],
    file: string,
    args: readonly string[],
    timeoutMs?: number,
  ): Promise<CommandResult> => {
    const started = performance.now()
    inspection = {
      step,
      exitCode: null,
      signal: null,
      timedOut: false,
      durationMs: 0,
    }
    try {
      const result = await runner.run(file, args, {
        env: options.env,
        timeoutMs,
      })
      inspection = {
        step,
        exitCode: result.exitCode,
        signal: result.signal ?? null,
        timedOut: result.timedOut ?? false,
        durationMs: result.durationMs ?? performance.now() - started,
      }
      return result
    } finally {
      if (inspection.exitCode === null)
        inspection.durationMs = performance.now() - started
      options.onStep?.({ ...inspection })
    }
  }
  try {
    const result = await inspect(
      windows ? 'tasklist' : 'ps',
      windows ? 'tasklist.exe' : 'ps',
      windows ? ['/fo', 'csv', '/nh'] : ['-eo', 'pid,command'],
    )
    if (result.exitCode !== 0) throw new ProcessInspectionError(inspection)
    const processes: Array<{ pid: number; command: string }> = []
    for (const line of result.stdout.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let pid: number
      let command: string
      if (windows) {
        const match = /^"([^"]+)","(\d+)"(?:,|$)/.exec(trimmed)
        if (!match) throw new ProcessInspectionError(inspection)
        command = match[1] ?? ''
        pid = Number(match[2])
      } else {
        const match = /^(\d+)\s+(.+)$/.exec(trimmed)
        if (!match) {
          if (/^PID\s+COMMAND$/i.test(trimmed)) continue
          throw new ProcessInspectionError(inspection)
        }
        pid = Number(match[1])
        command = match[2] ?? ''
      }
      if (!Number.isSafeInteger(pid) || pid < 0)
        throw new ProcessInspectionError(inspection)
      processes.push({ pid, command })
    }
    if (!processes.length) throw new ProcessInspectionError(inspection)
    // tasklist identifies native hosts, but npm Pi/OpenCode scripts appear as Node or Bun.
    const runtimes = processes.filter(
      (entry) =>
        entry.pid !== selfPid && /^(?:node|bun)\.exe$/i.test(entry.command),
    )
    if (windows && runtimes.length && options.inspectRuntimes !== false) {
      // Any Node or Bun process that appeared, exited, or now holds a PID
      // under another image name changes this key, so a host started since
      // the last listing is always queried and caught.
      const key = runtimes
        .map((entry) => `${entry.pid}:${entry.command.toLowerCase()}`)
        .sort()
        .join('\n')
      const cached = options.runtimeCommands
      if (cached?.key === key && cached.commands) {
        for (const entry of runtimes)
          entry.command = cached.commands.get(entry.pid) ?? ''
        return processes
      }
      const details = await inspect(
        'CIM',
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process -Filter \"Name = 'node.exe' OR Name = 'bun.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
        ],
        WINDOWS_CIM_TIMEOUT_MS,
      )
      if (details.exitCode !== 0) throw new ProcessInspectionError(inspection)
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
          throw new ProcessInspectionError(inspection)
        if (typeof row.CommandLine === 'string')
          commands.set(Number(row.ProcessId), row.CommandLine)
        else if (runtimes.some((entry) => entry.pid === row.ProcessId))
          throw new ProcessInspectionError(inspection)
      }
      for (const entry of runtimes) {
        // A process absent from the later CIM snapshot already exited.
        entry.command = commands.get(entry.pid) ?? ''
      }
      if (cached) {
        cached.key = key
        cached.commands = new Map(
          runtimes.map((entry) => [entry.pid, entry.command]),
        )
      }
    }
    return processes
  } catch (error) {
    if (error instanceof ProcessInspectionError) throw error
    throw new ProcessInspectionError(inspection)
  }
}

export function createProcessFence(
  runner: CommandRunner = defaultCommandRunner,
  options: { platform?: string; selfPid?: number } = {},
): ProcessFence {
  const selfPid = options.selfPid ?? process.pid
  const isHost = (entry: { pid: number; command: string }) =>
    entry.pid !== selfPid && hostName(entry.command) !== null
  // Lives as long as this fence, which setup creates once per run, so an
  // answer is never reused across runs.
  const runtimeCommands: RuntimeCommandCache = {}
  return {
    async listRunningHosts(env?: SetupEnvironment) {
      return (
        await listSetupProcesses(runner, { ...options, env, runtimeCommands })
      ).filter(isHost)
    },
    async previewRunningHosts(env?: SetupEnvironment) {
      const processes = await listSetupProcesses(runner, {
        ...options,
        env,
        inspectRuntimes: false,
      })
      const windows = (options.platform ?? process.platform) === 'win32'
      return {
        hosts: processes.filter(isHost),
        uncheckedRuntimes: windows
          ? processes.filter(
              (entry) =>
                entry.pid !== selfPid &&
                /^(?:node|bun)\.exe$/i.test(entry.command),
            ).length
          : 0,
      }
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
