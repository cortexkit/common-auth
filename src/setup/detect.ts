import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'jsonc-parser'
import { defaultCommandRunner, runResolvedCommand } from './command-runner.js'
import { setupPaths } from './paths.js'
import type {
  SetupDetection,
  SetupFileSystem,
  SetupIO,
  SetupPlugin,
} from './types.js'

function stat(path: string, kind: 'isFile' | 'isDirectory'): boolean {
  try {
    return statSync(path)[kind]()
  } catch {
    return false
  }
}
export const defaultSetupFileSystem: SetupFileSystem = {
  exists: existsSync,
  isFile: (path) => stat(path, 'isFile'),
  isDirectory: (path) => stat(path, 'isDirectory'),
  isExecutable(path) {
    try {
      accessSync(path, constants.X_OK)
      return stat(path, 'isFile')
    } catch {
      return false
    }
  },
  readText: (path) => readFileSync(path, 'utf8'),
  realpath: realpathSync,
}

export function findExecutableOnPath(
  name: string,
  io: SetupIO = {},
): string | null {
  const { env, platform, path, cwd } = setupPaths(io)
  const fs = io.fs ?? defaultSetupFileSystem
  const value =
    Object.entries(env).find(([key]) =>
      platform === 'win32' ? key.toUpperCase() === 'PATH' : key === 'PATH',
    )?.[1] ?? ''
  // npm also writes an extensionless POSIX shim on Windows; prefer a runnable launcher.
  const suffixes = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const entry of value.split(platform === 'win32' ? ';' : ':')) {
    const dir = entry.trim().replace(/^"|"$/g, '')
    if (!dir) continue
    for (const suffix of suffixes) {
      const candidate = path.resolve(cwd, dir, name + suffix)
      if (
        platform === 'win32' ? fs.isFile(candidate) : fs.isExecutable(candidate)
      )
        return candidate
    }
  }
  return null
}

export function openCodeDesktopMarkers(io: SetupIO = {}): string[] {
  const { platform, home, env, path } = setupPaths(io)
  if (platform === 'darwin')
    return [
      '/Applications/OpenCode.app',
      '/Applications/OpenCode Beta.app',
      path.join(home, 'Applications', 'OpenCode.app'),
      path.join(home, 'Applications', 'OpenCode Beta.app'),
    ]
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    return [
      path.join(local, 'Programs', 'opencode'),
      path.join(local, 'opencode'),
    ]
  }
  return [
    '/opt/OpenCode',
    '/usr/lib/opencode',
    path.join(home, '.local', 'share', 'applications', 'opencode.desktop'),
  ]
}

function launcherTarget(file: string, io: SetupIO): string {
  const fs = io.fs ?? defaultSetupFileSystem
  const { path } = setupPaths(io)
  try {
    const source = fs.readText(file)
    if (source.length > 64 * 1024) return file
    const operands = [...source.matchAll(/"%~?dp0%?\\([^"%\r\n]+)"/g)]
    if (!operands.length)
      operands.push(...source.matchAll(/"\$basedir\/([^"$\r\n]+)"/g))
    const relative = operands.at(-1)?.[1]
    if (relative) {
      const target = path.join(path.dirname(file), ...relative.split(/[/\\]+/))
      if (fs.isFile(target)) return fs.realpath(target)
    }
    return fs.realpath(file)
  } catch {
    return file
  }
}

function diskGeneration(file: string, io: SetupIO): '1' | '2' | null {
  const fs = io.fs ?? defaultSetupFileSystem
  const { path } = setupPaths(io)
  let dir = path.dirname(launcherTarget(file, io))
  for (;;) {
    try {
      const metadata = JSON.parse(fs.readText(path.join(dir, 'package.json')))
      if (['@opencode/cli', '@opencode-ai/cli'].includes(metadata.name))
        return '2'
      if (metadata.name === 'opencode-ai')
        return /^(?:[2-9]\d*|1\d+)\.|^0\.0\.0-(?:beta|dev)-/.test(
          metadata.version ?? '',
        )
          ? '2'
          : '1'
    } catch {
      /* No owning package at this level. */
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function detectOpenCodeGeneration(
  io: SetupIO = {},
): '1' | '2' | 'ambiguous' {
  const first = findExecutableOnPath('opencode', io)
  const second = findExecutableOnPath('opencode2', io)
  const shared =
    first && second && launcherTarget(first, io) === launcherTarget(second, io)
  const fs = io.fs ?? defaultSetupFileSystem
  const { path, opencode } = setupPaths(io)
  let inferred: '1' | '2' = '1'
  for (const suffix of ['jsonc', 'json']) {
    const file = path.join(opencode, `opencode.${suffix}`)
    if (!fs.exists(file)) continue
    try {
      if (Object.hasOwn(parse(fs.readText(file)) ?? {}, 'plugins'))
        inferred = '2'
    } catch {
      /* OpenCode registration rejects malformed config before writing it. */
    }
    break
  }
  const generation = first
    ? (diskGeneration(first, io) ?? (shared ? '2' : inferred))
    : null
  if (second && generation === '1' && !shared) return 'ambiguous'
  return second || shared ? '2' : (generation ?? inferred)
}

export async function detectHosts(
  plugin: SetupPlugin,
  io: SetupIO = {},
): Promise<SetupDetection> {
  const fs = io.fs ?? defaultSetupFileSystem
  const { env, platform, opencode: configDir, pi: agentDir } = setupPaths(io)
  const runner = io.runner ?? defaultCommandRunner
  const opencode =
    findExecutableOnPath('opencode', io) ??
    findExecutableOnPath('opencode2', io)
  const pi = findExecutableOnPath('pi', io)
  const ck = findExecutableOnPath('ck', io)
  const version = async (file: string | null) => {
    if (!file) return null
    let root: string | undefined
    try {
      root = await mkdtemp(join(tmpdir(), 'common-auth-setup-version-'))
      // A diagnostic host launch must not create state in the user's profile, even on a dry run.
      const probeEnv = {
        ...env,
        HOME: root,
        USERPROFILE: root,
        XDG_CONFIG_HOME: root,
        XDG_DATA_HOME: root,
        XDG_STATE_HOME: root,
        XDG_CACHE_HOME: root,
        OPENCODE_CONFIG_DIR: root,
        OPENCODE_CONFIG: undefined,
        OPENCODE_CONFIG_CONTENT: undefined,
        OPENCODE_AUTH_CONTENT: undefined,
        PI_CODING_AGENT_DIR: root,
      }
      const result = await runResolvedCommand(
        runner,
        platform,
        file,
        ['--version'],
        probeEnv,
        2000,
      )
      return result.exitCode === 0
        ? (/\b\d+\.\d+\.\d+(?:-[\w.-]+)?/.exec(result.stdout)?.[0] ?? null)
        : null
    } catch {
      return null
    } finally {
      if (root) await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  }
  let available = false
  if (ck && fs.exists(plugin.vault.connectionFile)) {
    try {
      const connect =
        io.connect ??
        (await import('../claustrum/index.js')).connectClaustrumEnrollmentClient
      const client = await connect({
        connectionFile: plugin.vault.connectionFile,
        handshakeTimeoutMs: 2000,
      })
      client.close()
      available = true
    } catch {
      available = false
    }
  }
  const [openCodeVersion, piVersion] = await Promise.all([
    version(opencode),
    version(pi),
  ])
  return {
    opencode: {
      installed:
        fs.isDirectory(configDir) ||
        openCodeDesktopMarkers(io).some((marker) => fs.exists(marker)) ||
        opencode !== null,
      executable: opencode,
      version: openCodeVersion,
      directory: configDir,
      generation: detectOpenCodeGeneration(io),
    },
    pi: {
      installed: pi !== null || fs.isDirectory(agentDir),
      executable: pi,
      version: piVersion,
      directory: agentDir,
    },
    claustrum: { available, executable: ck },
  }
}
