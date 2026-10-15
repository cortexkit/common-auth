import type { MenuTerminal } from '../auth-menu/terminal.js'
import type {
  ClaustrumEnrollmentConnection,
  hostEnrollmentPaths,
} from '../claustrum/index.js'

export type SetupHost = 'opencode' | 'pi'
export type OpenCodeGeneration = '1' | '2' | 'both'
export type SetupEnvironment = Record<string, string | undefined>

/**
 * What setup decided before calling a plugin callback. The OpenCode generation
 * is the one being registered, after `--opencode` or the interactive choice, so
 * a plugin can sign in the way that generation expects (OpenCode 2 does not
 * read OpenCode 1's login file).
 */
export interface SetupCallbackContext {
  opencodeGeneration: OpenCodeGeneration
  mode: 'local' | 'claustrum'
}

/** Provider login, credential migration and vault activation stay in plugin callbacks. */
export interface SetupPlugin {
  packages: { opencode: string; pi: string }
  version: string
  displayName: string
  slashCommand: string
  vault: {
    connectionFile: string
    hosts: Record<
      SetupHost,
      { name: string; paths: Parameters<typeof hostEnrollmentPaths>[0] }
    >
  }
  signInLocal(host: SetupHost, context: SetupCallbackContext): Promise<void>
  migrate(host: SetupHost, context: SetupCallbackContext): Promise<void>
  /** Reject mixed local/vault credentials and activate provider-specific vault access before registration. */
  beforeRegister?(
    host: SetupHost,
    mode: 'local' | 'claustrum',
    context: SetupCallbackContext,
  ): Promise<void>
}

export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
  signal?: NodeJS.Signals | null
  timedOut?: boolean
  durationMs?: number
}
export interface CommandRunner {
  run(
    file: string,
    args: readonly string[],
    options?: {
      env?: SetupEnvironment
      timeoutMs?: number
      windowsVerbatimArguments?: boolean
    },
  ): Promise<CommandResult>
}
export interface SetupFileSystem {
  exists(path: string): boolean
  isDirectory(path: string): boolean
  isFile(path: string): boolean
  isExecutable(path: string): boolean
  readText(path: string): string
  realpath(path: string): string
}
export interface ProcessFence {
  listRunningHosts(
    env?: SetupEnvironment,
  ): Promise<Array<{ pid: number; command: string }>>
}

/** Defaults use the process terminal and environment; overrides are test seams. */
export interface SetupIO {
  terminal?: MenuTerminal
  env?: SetupEnvironment
  platform?: string
  home?: string
  cwd?: string
  fs?: SetupFileSystem
  runner?: CommandRunner
  fence?: ProcessFence
  connect?: (options: {
    connectionFile: string
    handshakeTimeoutMs: number
  }) => Promise<ClaustrumEnrollmentConnection>
  wait?: (ms: number) => Promise<void>
}

export interface HostDetection {
  installed: boolean
  executable: string | null
  version: string | null
  directory: string
}
export interface SetupDetection {
  opencode: HostDetection & { generation: '1' | '2' | 'ambiguous' }
  pi: HostDetection
  claustrum: { available: boolean; executable: string | null }
}
export interface SetupResult {
  hosts: SetupHost[]
  dryRun: boolean
  mode: 'local' | 'claustrum'
  detection: SetupDetection
}
