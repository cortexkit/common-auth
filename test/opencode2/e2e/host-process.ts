// Process handling for the OpenCode 2 placement test: spawning the CLI,
// recording what each step reached, and stopping a whole process tree.
//
// On Windows npm's `opencode2.cmd` launcher runs the native `opencode.exe` as
// a child of cmd.exe. Bun's `kill()` ends only cmd.exe: `opencode.exe` keeps
// running, orphaned, holding the inherited stdout and stderr pipes and files
// in the test profile. A harness that stopped the host with `kill()` and then
// read its output to the end hung in its first test on every Windows CI run
// (2 of 2); with the reads bounded, `kill()` still left the profile locked
// (removing it failed with EACCES in every scenario). Stopping the host with
// `taskkill /T /F`, which ends the process together with everything it
// started, passes. Every wait here is bounded as well, so a process that
// outlives its stop fails the scenario with a report instead of hanging it.
import { spawnSync } from 'node:child_process'

const IS_WINDOWS = process.platform === 'win32'

/** Timestamped steps of one scenario, printed only when the scenario fails. */
export class PhaseLog {
  private readonly started = performance.now()
  private readonly lines: string[] = []
  private last = 'not started'

  mark(phase: string, detail = '') {
    this.last = phase
    const at = Math.round(performance.now() - this.started)
    this.lines.push(`+${at}ms ${phase}${detail ? `: ${detail}` : ''}`)
  }

  /** Records a detail without changing the step a failure is reported at. */
  note(detail: string) {
    const at = Math.round(performance.now() - this.started)
    this.lines.push(`+${at}ms   ${detail}`)
  }

  get current() {
    return this.last
  }

  toString() {
    return this.lines.join('\n')
  }
}

export interface HostProcess {
  readonly name: string
  readonly argv: readonly string[]
  readonly child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  readonly stdout: string[]
  readonly stderr: string[]
  /** Settles when both output pipes have closed. */
  readonly drained: Promise<void>
  outputClosed: boolean
}

async function collect(
  stream: ReadableStream<Uint8Array> | null | undefined,
  into: string[],
) {
  if (!stream) return
  const decoder = new TextDecoder()
  for await (const chunk of stream)
    into.push(decoder.decode(chunk, { stream: true }))
}

export function spawnHost(
  name: string,
  argv: [string, ...string[]],
  options: { cwd: string; env: Record<string, string> },
  phases: PhaseLog,
): HostProcess {
  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    // Arguments reach cmd.exe exactly as the launcher quoted them.
    windowsVerbatimArguments: true,
  })
  phases.mark(`${name} spawned`, `pid ${child.pid}: ${argv.join(' ')}`)
  const stdout: string[] = []
  const stderr: string[] = []
  const host: HostProcess = {
    name,
    argv,
    child,
    stdout,
    stderr,
    outputClosed: false,
    drained: Promise.all([
      collect(child.stdout, stdout),
      collect(child.stderr, stderr),
    ]).then(
      () => {
        host.outputClosed = true
      },
      () => {
        host.outputClosed = true
      },
    ),
  }
  return host
}

/** Resolves true when `pending` settles within `ms`, false otherwise. */
export async function within(pending: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  try {
    return await Promise.race([pending.then(() => true as const), expired])
  } finally {
    clearTimeout(timer)
  }
}

/** Waits for the host to exit and close its output, or for `signal`. */
export async function waitForExit(host: HostProcess, signal: AbortSignal) {
  const aborted = new Promise<void>((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => resolve(), { once: true })
  })
  await Promise.race([Promise.all([host.child.exited, host.drained]), aborted])
}

interface ProcessRow {
  readonly pid: number
  readonly ppid: number
  readonly command: string
}

/** Every process on the machine with its parent and command line. */
export function processTable(): ProcessRow[] {
  if (IS_WINDOWS) {
    const listing = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8', timeout: 30_000, windowsHide: true },
    )
    if (listing.status !== 0) return []
    const rows = JSON.parse(listing.stdout || '[]') as Array<{
      ProcessId: number
      ParentProcessId: number
      ExecutablePath: string | null
      CommandLine: string | null
    }>
    return rows.map((row) => ({
      pid: row.ProcessId,
      ppid: row.ParentProcessId,
      command: row.CommandLine ?? row.ExecutablePath ?? '',
    }))
  }
  const listing = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,args='], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (listing.status !== 0) return []
  return listing.stdout.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    return match
      ? [
          {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            command: match[3] ?? '',
          },
        ]
      : []
  })
}

/** The process `pid` and everything it started, as listed by processTable. */
export function describeTree(pid: number, table = processTable()) {
  const lines: string[] = []
  const visit = (current: number, depth: number) => {
    const row = table.find((entry) => entry.pid === current)
    if (row) lines.push(`${'  '.repeat(depth)}${row.pid} ${row.command}`)
    for (const entry of table)
      if (entry.ppid === current && entry.pid !== current)
        visit(entry.pid, depth + 1)
  }
  visit(pid, 0)
  return lines.length ? lines.join('\n') : `${pid} (not running)`
}

/**
 * Processes whose command line names `marker`, such as the directory the CLI
 * is installed in; the listing command itself is excluded.
 */
export function processesNaming(marker: string): ProcessRow[] {
  const needle = IS_WINDOWS ? marker.toLowerCase() : marker
  return processTable().filter((row) => {
    if (row.pid === process.pid) return false
    const command = IS_WINDOWS ? row.command.toLowerCase() : row.command
    return command.includes(needle) && !/Get-CimInstance|ps -A/.test(command)
  })
}

/** Ends one process id and, on Windows, every process it started. */
export function killTree(pid: number) {
  if (IS_WINDOWS) {
    return spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    })
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {}
  return undefined
}

/**
 * Stops the host and waits, within bounds, for it to exit and close its
 * output. POSIX hosts get SIGTERM first so they can shut down cleanly;
 * Windows has no such signal for a console process, so the tree is ended at
 * once. Returns a description of what did not stop, or '' when all did.
 */
export async function stopHost(host: HostProcess, phases: PhaseLog) {
  const { child } = host
  const problems: string[] = []
  if (child.exitCode === null && child.signalCode === null) {
    if (IS_WINDOWS) {
      const result = killTree(child.pid)
      phases.note(
        `taskkill /T /F ${child.pid}: exit ${result?.status} ${`${result?.stdout ?? ''}${result?.stderr ?? ''}`.trim()}`,
      )
    } else {
      child.kill('SIGTERM')
      if (!(await within(child.exited, 10_000))) child.kill('SIGKILL')
    }
  }
  if (!(await within(child.exited, 15_000)))
    problems.push(`${host.name} (pid ${child.pid}) did not exit`)
  if (!(await within(host.drained, 5_000)))
    problems.push(
      `${host.name} exited but its output stayed open: a process it started still holds the pipe`,
    )
  phases.note(
    `${host.name} stopped: exit ${child.exitCode} signal ${child.signalCode ?? 'none'} output ${host.outputClosed ? 'closed' : 'open'}`,
  )
  return problems.join('; ')
}

const tail = (chunks: string[], size: number) => chunks.join('').slice(-size)

/** The host's exit state and output tail, for a failure report. */
export function describeHost(host: HostProcess, size = 4000) {
  const { child } = host
  return [
    `--- ${host.name} (pid ${child.pid}) exit ${child.exitCode} signal ${child.signalCode ?? 'none'} output ${host.outputClosed ? 'closed' : 'open'}`,
    `argv: ${host.argv.join(' ')}`,
    `stdout (tail):\n${tail(host.stdout, size)}`,
    `stderr (tail):\n${tail(host.stderr, size)}`,
  ].join('\n')
}
