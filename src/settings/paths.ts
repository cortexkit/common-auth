import { posix, win32 } from 'node:path'
import { SettingsRefusal } from './refusal.js'

interface ConfigDirOptions {
  env: Readonly<Record<string, string | undefined>>
  platform: NodeJS.Platform
  homedir: string
}

export function isAbsoluteForPlatform(
  path: string,
  platform: NodeJS.Platform,
): boolean {
  if (platform !== 'win32') return path.startsWith('/')

  // Verbatim and device prefixes have an implicit root in Rust's path model.
  if (path.startsWith('\\\\?\\') || path.startsWith('\\\\.\\')) return true
  if (/^[a-zA-Z]:[\\/]/.test(path)) return true

  // Ordinary UNC prefixes accept either separator, but need server and share.
  return /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(path)
}

export function cortexkitConfigDir({
  env,
  platform,
  homedir,
}: ConfigDirOptions): string {
  const paths = platform === 'win32' ? win32 : posix
  const absolute = (value: string | undefined): value is string =>
    value !== undefined && isAbsoluteForPlatform(value, platform)

  let base: string
  if (absolute(env.XDG_CONFIG_HOME)) {
    base = env.XDG_CONFIG_HOME
  } else if (platform === 'win32' && absolute(env.APPDATA)) {
    base = env.APPDATA
  } else {
    let home = platform === 'win32' ? env.USERPROFILE : env.HOME
    if (!absolute(home)) {
      // commons cortexkit-paths' dirs.rs reports no directory when every home
      // and config variable is unusable. Accepting the caller's absolute
      // homedir instead is the one deliberate addition to that Rust rule.
      if (!absolute(homedir)) {
        throw new SettingsRefusal(
          'settings-unavailable',
          'No absolute home or config directory is available',
        )
      }
      home = homedir
    }
    base =
      platform === 'win32'
        ? paths.join(paths.join(home, 'AppData'), 'Roaming')
        : paths.join(home, '.config')
  }
  return paths.join(base, 'cortexkit')
}

export function settingsFilePath({
  plugin,
  override,
  ...options
}: ConfigDirOptions & { plugin: string; override?: string }): string {
  if (override && isAbsoluteForPlatform(override, options.platform)) {
    return override
  }
  const paths = options.platform === 'win32' ? win32 : posix
  return paths.join(cortexkitConfigDir(options), `${plugin}.jsonc`)
}
