import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SetupEnvironment, SetupIO } from './types.js'

export function setupPaths(io: SetupIO = {}) {
  const env: SetupEnvironment = io.env ?? process.env
  const platform = io.platform ?? process.platform
  const path = platform === 'win32' ? win32 : posix
  const home =
    io.home ?? (platform === 'win32' ? env.USERPROFILE : env.HOME) ?? homedir()
  const cwd = io.cwd ?? process.cwd()
  const absolute = (value: string) => path.resolve(cwd, value)
  const config = env.OPENCODE_CONFIG_DIR?.trim()
  const xdg = env.XDG_CONFIG_HOME?.trim()
  let agent = env.PI_CODING_AGENT_DIR?.trim() || path.join(home, '.pi', 'agent')
  if (agent === '~') agent = home
  else if (/^~[/\\]/.test(agent)) agent = path.join(home, agent.slice(2))
  if (agent.startsWith('file://')) agent = fileURLToPath(agent)
  return {
    env,
    platform,
    path,
    home,
    cwd,
    opencode: config
      ? absolute(config)
      : xdg
        ? path.join(absolute(xdg), 'opencode')
        : path.join(home, '.config', 'opencode'),
    pi: absolute(agent),
  }
}
