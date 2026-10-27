import type { OpenCodeGeneration, SetupHost } from './types.js'

export const UNAVAILABLE_HOST_MESSAGE =
  'Requested setup host is unknown or unavailable. Use --host=opencode or --host=pi with a detected host.'

type SwitchKey =
  | 'yes'
  | 'dryRun'
  | 'claustrum'
  | 'noClaustrum'
  | 'login'
  | 'enrollOnly'

/**
 * One flag the shared setup parser accepts. A switch sets `key` to true; a
 * value flag takes one of `values` as `--name=value`, and also as the next
 * argument (`--name value`) when `spaceForm` is set. `invalid` replaces the
 * unknown-argument refusal when a value flag gets a value it does not accept.
 */
export type SetupFlag =
  | { name: string; key: SwitchKey; description: string }
  | {
      name: string
      key: 'hosts' | 'opencode'
      values: readonly string[]
      spaceForm?: boolean
      invalid?: string
      description: string
    }

/**
 * Every flag `runSetup` accepts. The parser and `setupUsage` both read this
 * table, so the help a plugin prints cannot list a flag the parser refuses or
 * leave out one it accepts.
 */
export const SETUP_FLAGS: readonly SetupFlag[] = [
  {
    name: '--yes',
    key: 'yes',
    description:
      'Run without questions and set up every found host. Does not choose the vault.',
  },
  {
    name: '--dry-run',
    key: 'dryRun',
    description: 'Print what setup would do without changing anything.',
  },
  {
    name: '--host',
    key: 'hosts',
    values: ['opencode', 'pi'],
    spaceForm: true,
    invalid: UNAVAILABLE_HOST_MESSAGE,
    description:
      'Set up only this host; repeat the flag for both. Also written --host=<host>.',
  },
  {
    name: '--opencode',
    key: 'opencode',
    values: ['1', '2', 'both'],
    description: 'Register for this OpenCode generation.',
  },
  {
    name: '--claustrum',
    key: 'claustrum',
    description: 'Connect the hosts to the Claustrum vault.',
  },
  {
    name: '--no-claustrum',
    key: 'noClaustrum',
    description: 'Do not offer the Claustrum vault; sign in locally.',
  },
  {
    name: '--login',
    key: 'login',
    description: 'Sign in locally instead of using the Claustrum vault.',
  },
  {
    name: '--enroll-only',
    key: 'enrollOnly',
    description:
      'Only connect the hosts to the Claustrum vault; register nothing and migrate nothing.',
  },
]

export interface SetupFlags {
  yes: boolean
  dryRun: boolean
  claustrum: boolean
  noClaustrum: boolean
  login: boolean
  enrollOnly: boolean
  hosts: SetupHost[]
  opencode: OpenCodeGeneration | undefined
}

function unknownArgument(arg: string) {
  return new Error(
    `Unknown setup argument: ${arg}. Run the plugin's own setup --help to list the flags setup accepts.`,
  )
}

/** Parse setup's arguments against `SETUP_FLAGS`, refusing anything else. */
export function parseSetupFlags(argv: readonly string[]): SetupFlags {
  const result: SetupFlags = {
    yes: false,
    dryRun: false,
    claustrum: false,
    noClaustrum: false,
    login: false,
    enrollOnly: false,
    hosts: [],
    opencode: undefined,
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string
    const equals = arg.indexOf('=')
    const name = equals === -1 ? arg : arg.slice(0, equals)
    const flag = SETUP_FLAGS.find((entry) => entry.name === name)
    if (!flag) throw unknownArgument(arg)
    if (!('values' in flag)) {
      if (equals !== -1) throw unknownArgument(arg)
      result[flag.key] = true
      continue
    }
    let value: string | undefined
    if (equals !== -1) value = arg.slice(equals + 1)
    else if (flag.spaceForm) value = argv[++index]
    else throw unknownArgument(arg)
    if (value === undefined || !flag.values.includes(value))
      throw flag.invalid ? new Error(flag.invalid) : unknownArgument(arg)
    if (flag.key === 'hosts') result.hosts.push(value as SetupHost)
    else result.opencode = value as OpenCodeGeneration
  }
  if (result.claustrum && result.noClaustrum)
    throw new Error('--claustrum and --no-claustrum cannot be used together.')
  if (result.login && result.claustrum)
    throw new Error('--login and --claustrum cannot be used together.')
  if (result.enrollOnly && result.login)
    throw new Error('--enroll-only and --login cannot be used together.')
  if (result.enrollOnly && result.noClaustrum)
    throw new Error('--enroll-only and --no-claustrum cannot be used together.')
  return result
}

/**
 * The flags `runSetup` accepts, one per line, for a plugin's `setup --help`.
 * The shared parser has no `--help` of its own: the plugin's bin checks for
 * `--help` or `-h` before calling `runSetup`, prints this text and any lines of
 * its own, and exits 0. With `command` the text starts with a usage line, such
 * as `Usage: example-auth setup [flags]`.
 */
export function setupUsage(options: { command?: string } = {}): string {
  const labels = SETUP_FLAGS.map((flag) =>
    'values' in flag
      ? `${flag.name}${flag.spaceForm ? ' ' : '='}${flag.values.join('|')}`
      : flag.name,
  )
  const width = Math.max(...labels.map((label) => label.length))
  const lines = SETUP_FLAGS.map(
    (flag, index) =>
      `  ${(labels[index] as string).padEnd(width)}  ${flag.description}`,
  )
  return [
    ...(options.command ? [`Usage: ${options.command} [flags]`, ''] : []),
    'Flags:',
    ...lines,
  ].join('\n')
}
