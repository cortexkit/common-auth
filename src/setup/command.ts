import { confirm } from '../auth-menu/confirm.js'
import { select } from '../auth-menu/select.js'
import {
  isInteractive,
  printLine,
  processTerminal,
} from '../auth-menu/terminal.js'
import { hostEnrollmentPaths } from '../claustrum/enrollment.js'
import { defaultCommandRunner } from './command-runner.js'
import { detectHosts } from './detect.js'
import { connectSetupHost } from './enroll.js'
import { setupPaths } from './paths.js'
import {
  assertHostsStopped,
  createProcessFence,
  ProcessFenceViolationError,
} from './process-fence.js'
import { selectSetupHosts } from './prompts.js'
import {
  planOpenCodeRegistration,
  registerOpenCode,
  registerPi,
} from './register.js'
import type {
  OpenCodeGeneration,
  SetupHost,
  SetupIO,
  SetupPlugin,
  SetupResult,
} from './types.js'

export const AMBIGUOUS_OPENCODE_MESSAGE =
  'Multiple OpenCode generations found. Choose --opencode=1|2|both before running noninteractive setup.'

function flags(argv: readonly string[]) {
  const result = {
    yes: false,
    dryRun: false,
    claustrum: false,
    noClaustrum: false,
    login: false,
    opencode: undefined as OpenCodeGeneration | undefined,
  }
  for (const arg of argv) {
    if (arg === '--yes') result.yes = true
    else if (arg === '--dry-run') result.dryRun = true
    else if (arg === '--claustrum') result.claustrum = true
    else if (arg === '--no-claustrum') result.noClaustrum = true
    else if (arg === '--login') result.login = true
    else if (/^--opencode=(1|2|both)$/.test(arg))
      result.opencode = arg.slice('--opencode='.length) as OpenCodeGeneration
    else throw new Error(`Unknown setup argument: ${arg}`)
  }
  if (result.claustrum && result.noClaustrum)
    throw new Error('--claustrum and --no-claustrum cannot be used together.')
  if (result.login && result.claustrum)
    throw new Error('--login and --claustrum cannot be used together.')
  return result
}

function validatePlugin(plugin: SetupPlugin) {
  for (const pkg of Object.values(plugin.packages)) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(pkg))
      throw new Error('Setup requires npm package names.')
  }
  if (
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/.test(
      plugin.version,
    )
  )
    throw new Error('Setup requires a concrete package version.')
  for (const host of Object.values(plugin.vault.hosts)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(host.name))
      throw new Error(
        'Setup requires lowercase vault names containing only letters, digits and dashes.',
      )
  }
}

export async function runSetup(
  plugin: SetupPlugin,
  argv: readonly string[] = [],
  io: SetupIO = {},
): Promise<SetupResult> {
  const options = flags(argv)
  validatePlugin(plugin)
  const terminal = io.terminal ?? processTerminal()
  const detection = await detectHosts(plugin, io)
  printLine(terminal, `${plugin.displayName} setup`)
  for (const [label, host] of [
    ['OpenCode', detection.opencode],
    ['Pi', detection.pi],
  ] as const) {
    printLine(
      terminal,
      `${label}: ${host.installed ? `found (version ${host.version ?? 'unknown'})` : 'not found'} — ${host.directory}`,
    )
  }
  printLine(
    terminal,
    `Claustrum: ${detection.claustrum.available ? 'available' : 'not available'}`,
  )
  const found = (['opencode', 'pi'] as const).filter(
    (host) => detection[host].installed,
  )
  if (!options.yes && !isInteractive(terminal))
    throw new Error('Setup requires a TTY or --yes.')
  const hosts: SetupHost[] = options.yes
    ? found
    : ((await selectSetupHosts(terminal, found)) ?? [])
  let generation: OpenCodeGeneration =
    options.opencode ??
    (detection.opencode.generation === 'ambiguous'
      ? '1'
      : detection.opencode.generation)
  if (
    hosts.includes('opencode') &&
    !options.opencode &&
    detection.opencode.generation === 'ambiguous'
  ) {
    if (options.yes || !isInteractive(terminal))
      throw new Error(AMBIGUOUS_OPENCODE_MESSAGE)
    const choice = await select<OpenCodeGeneration>(
      terminal,
      [
        { value: '1', label: 'OpenCode 1' },
        { value: '2', label: 'OpenCode 2' },
        { value: 'both', label: 'Both (one compatible registration)' },
      ],
      { message: 'Which OpenCode generation should be registered?' },
    )
    if (choice === null)
      return { hosts: [], dryRun: options.dryRun, mode: 'local', detection }
    generation = choice
  }
  if (!hosts.length) {
    printLine(
      terminal,
      'No hosts selected. Install OpenCode or Pi and rerun setup.',
    )
    return { hosts, dryRun: options.dryRun, mode: 'local', detection }
  }
  if (hosts.includes('pi') && !detection.pi.executable)
    throw new Error(
      'Pi agent folder found, but pi is not on PATH. Install its CLI before setup.',
    )
  const { env, platform } = setupPaths(io)
  const fence =
    io.fence ??
    createProcessFence(io.runner ?? defaultCommandRunner, { platform })
  const stopped = () => assertHostsStopped(fence, env)
  if (options.dryRun) {
    try {
      const active = await fence.listRunningHosts(env)
      const names = new Set(
        new ProcessFenceViolationError(active).activeHosts.map((host) =>
          host.command.toLowerCase() === 'pi' ? 'Pi' : 'OpenCode',
        ),
      )
      for (const name of names)
        printLine(
          terminal,
          `${name} is running; setup will ask you to quit it.`,
        )
    } catch {
      printLine(
        terminal,
        'Process inspection failed; real setup will require successful inspection and stopped OpenCode/Pi hosts.',
      )
    }
  } else await stopped()
  if (options.claustrum && !detection.claustrum.available)
    throw new Error(
      'Claustrum is not available. Start ck or use --no-claustrum for local sign-in.',
    )
  const useVault =
    options.claustrum ||
    (!options.login &&
      !options.noClaustrum &&
      !options.yes &&
      detection.claustrum.available &&
      (await confirm(terminal, 'Connect these hosts to the Claustrum vault?')))
  const mode = useVault ? 'claustrum' : 'local'
  // Validate every config before login or enrollment can change credential state.
  const writes = hosts.includes('opencode')
    ? planOpenCodeRegistration(plugin, generation, io)
    : []
  if (options.dryRun) {
    printLine(
      terminal,
      'Dry run: no registrations, enrollment, sign-in or migration will be performed.',
    )
    for (const host of hosts) {
      if (useVault) {
        const paths = hostEnrollmentPaths(plugin.vault.hosts[host].paths)
        printLine(
          terminal,
          `Would Connect ${host}: write ${paths.statePath} and ${paths.tokenPath}; wait for ck auth enroll approve.`,
        )
      } else printLine(terminal, `Would sign in locally for ${host}.`)
      if (plugin.beforeRegister)
        printLine(terminal, `Would run beforeRegister(${host}, ${mode}).`)
    }
    for (const write of writes)
      printLine(
        terminal,
        `${write.changed ? 'Would write' : 'Unchanged'} ${write.path}:\n${write.content}`,
      )
    if (hosts.includes('pi'))
      printLine(
        terminal,
        `Would run ${detection.pi.executable} install npm:${plugin.packages.pi}@${plugin.version}`,
      )
    for (const host of hosts)
      printLine(
        terminal,
        `Would migrate ${host} using the plugin callback (provider-specific writes).`,
      )
  } else {
    for (const host of hosts) {
      await stopped()
      if (useVault) await connectSetupHost(plugin, host, io, terminal, stopped)
      else await plugin.signInLocal(host)
      await stopped()
      await plugin.beforeRegister?.(host, mode)
      await stopped()
      if (host === 'opencode') await registerOpenCode(writes, stopped)
      else await registerPi(plugin, detection.pi.executable as string, io)
      await stopped()
      await plugin.migrate(host)
    }
  }
  printLine(
    terminal,
    `${options.dryRun ? 'Planned' : 'Configured'} ${plugin.displayName} for ${hosts.join(', ')} (${mode}).`,
  )
  printLine(
    terminal,
    `Next: ${hosts.includes('opencode') ? 'start OpenCode' : 'start Pi'} and run ${plugin.slashCommand}.`,
  )
  return { hosts, dryRun: options.dryRun, mode, detection }
}
