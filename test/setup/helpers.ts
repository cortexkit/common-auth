import { EventEmitter } from 'node:events'
import { posix, win32 } from 'node:path'
import type { MenuTerminal } from '../../src/auth-menu/terminal.js'
import type {
  CommandRunner,
  SetupFileSystem,
  SetupIO,
  SetupPlugin,
} from '../../src/setup/index.js'

export function plugin(root = '/fixture'): SetupPlugin {
  return {
    packages: {
      opencode: '@cortexkit/opencode-test-auth',
      pi: '@cortexkit/pi-test-auth',
    },
    version: '1.2.3',
    displayName: 'Test Auth',
    slashCommand: '/test-auth',
    vault: {
      connectionFile: `${root}/connection.json`,
      hosts: {
        opencode: {
          name: 'test-auth-opencode',
          paths: { stateDir: `${root}/vault`, host: 'opencode' },
        },
        pi: {
          name: 'test-auth-pi',
          paths: { stateDir: `${root}/vault`, host: 'pi' },
        },
      },
    },
    async signInLocal() {},
    async migrate() {},
  }
}

export function fakeIO(platform = 'linux'): SetupIO & {
  files: Map<string, string>
  folders: Set<string>
  commands: Array<{ file: string; args: readonly string[] }>
} {
  const path = platform === 'win32' ? win32 : posix
  const home = platform === 'win32' ? 'C:\\Users\\test' : '/home/test'
  const bin = platform === 'win32' ? 'C:\\npm' : '/bin'
  const files = new Map<string, string>()
  const folders = new Set<string>()
  const commands: Array<{ file: string; args: readonly string[] }> = []
  const fs: SetupFileSystem = {
    exists: (file) => files.has(file) || folders.has(file),
    isDirectory: (file) => folders.has(file),
    isFile: (file) => files.has(file),
    isExecutable: (file) => files.has(file),
    readText: (file) => {
      const value = files.get(file)
      if (value === undefined) throw new Error('ENOENT')
      return value
    },
    realpath: (file) => file,
  }
  const runner: CommandRunner = {
    async run(file, args) {
      commands.push({ file, args })
      return { exitCode: 0, stdout: '1.9.0\n', stderr: '' }
    },
  }
  return {
    platform,
    home,
    cwd: path.join(home, 'project'),
    env: { PATH: bin },
    fs,
    runner,
    files,
    folders,
    commands,
    fence: {
      async listRunningHosts() {
        return []
      },
    },
  }
}

export function terminal(
  keys?: string[],
): MenuTerminal & { lines: string[]; raw: boolean } {
  const emitter = new EventEmitter()
  const lines: string[] = []
  const pending = [...(keys ?? [])]
  const state = { raw: false }
  return {
    lines,
    get raw() {
      return state.raw
    },
    input: {
      isTTY: keys !== undefined,
      get isRaw() {
        return state.raw
      },
      setRawMode(mode) {
        state.raw = mode
      },
      resume() {
        if (pending.length)
          setTimeout(() => emitter.emit('data', pending.shift()), 0)
      },
      pause() {},
      on(event, listener) {
        emitter.on(event, listener)
      },
      removeListener(event, listener) {
        emitter.removeListener(event, listener)
      },
    },
    output: {
      write(text) {
        lines.push(text)
      },
      columns: 120,
      rows: 40,
    },
  }
}
