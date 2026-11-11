import { describe, expect, test } from 'bun:test'
import { posix, win32 } from 'node:path'
import {
  cortexkitConfigDir,
  isAbsoluteForPlatform,
  settingsFilePath,
} from '../../src/settings/paths.js'
import {
  SETTINGS_REFUSAL_CODES,
  SettingsRefusal,
} from '../../src/settings/refusal.js'

const VALUES = ['Set', 'Empty', 'Relative', 'Unset'] as const
type Value = (typeof VALUES)[number]
type Env = Record<string, string | undefined>
interface DirectoryRow {
  name: string
  env: Env
  homedir: string
  expected: string | undefined
}

function input(value: Value, absolute: string): string | undefined {
  switch (value) {
    case 'Set':
      return absolute
    case 'Empty':
      return ''
    case 'Relative':
      return 'relative'
    case 'Unset':
      return undefined
  }
}

function addRows(
  rows: DirectoryRow[],
  name: string,
  env: Env,
  expected: string | undefined,
  homedir: string,
  fallback: string,
): void {
  if (expected !== undefined) {
    // A relative homedir also proves that a usable variable needs no fallback.
    rows.push({ name, env, homedir: 'relative', expected })
  } else {
    rows.push({
      name: `${name}, homedir fallback`,
      env,
      homedir,
      expected: fallback,
    })
    rows.push({
      name: `${name}, unavailable`,
      env,
      homedir: 'relative',
      expected: undefined,
    })
  }
}

// Like commons cortexkit-paths' tables, vary each variable over an absolute
// path (Set), an empty string, a relative path and an unset value. Only the
// absolute Set state contributes a base.
const unixRows: DirectoryRow[] = []
for (const home of VALUES) {
  for (const xdg of VALUES) {
    const env: Env = {
      HOME: input(home, '/home/user'),
      XDG_CONFIG_HOME: input(xdg, '/xdg/config'),
      USERPROFILE: '/ignored/userprofile',
      APPDATA: '/ignored/appdata',
      LOCALAPPDATA: '/ignored/localappdata',
      CORTEXKIT_HOME: '/ignored/cortexkit-home',
      CORTEXKIT_CONFIG_HOME: '/ignored/cortexkit-config',
      CORTEXKIT_CONFIG_DIR: '/ignored/cortexkit-dir',
    }
    const base =
      xdg === 'Set'
        ? '/xdg/config'
        : home === 'Set'
          ? posix.join('/home/user', '.config')
          : undefined
    addRows(
      unixRows,
      `HOME=${home}, XDG_CONFIG_HOME=${xdg}`,
      env,
      base === undefined ? undefined : posix.join(base, 'cortexkit'),
      '/u',
      '/u/.config/cortexkit',
    )
  }
}

const windowsRows: DirectoryRow[] = []
for (const profile of VALUES) {
  for (const home of VALUES) {
    for (const appdata of VALUES) {
      for (const xdg of VALUES) {
        const env: Env = {
          USERPROFILE: input(profile, 'C:\\profile'),
          HOME: input(home, 'C:\\git-home'),
          APPDATA: input(appdata, 'C:\\roaming'),
          XDG_CONFIG_HOME: input(xdg, 'C:\\xdg'),
          LOCALAPPDATA: 'C:\\ignored\\localappdata',
          HOMEDRIVE: 'D:',
          HOMEPATH: '\\ignored\\homepath',
          CORTEXKIT_HOME: 'C:\\ignored\\cortexkit-home',
          CORTEXKIT_CONFIG_HOME: 'C:\\ignored\\cortexkit-config',
          CORTEXKIT_CONFIG_DIR: 'C:\\ignored\\cortexkit-dir',
        }
        const base =
          xdg === 'Set'
            ? 'C:\\xdg'
            : appdata === 'Set'
              ? 'C:\\roaming'
              : profile === 'Set'
                ? win32.join(win32.join('C:\\profile', 'AppData'), 'Roaming')
                : undefined
        addRows(
          windowsRows,
          `USERPROFILE=${profile}, HOME=${home}, APPDATA=${appdata}, XDG_CONFIG_HOME=${xdg}`,
          env,
          base === undefined ? undefined : win32.join(base, 'cortexkit'),
          'C:\\u',
          'C:\\u\\AppData\\Roaming\\cortexkit',
        )
      }
    }
  }
}

function expectUnavailable(operation: () => unknown): void {
  let error: unknown
  try {
    operation()
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(SettingsRefusal)
  expect(error).toMatchObject({
    name: 'SettingsRefusal',
    code: 'settings-unavailable',
  })
}

function checkDirectoryRows(
  platform: NodeJS.Platform,
  rows: DirectoryRow[],
): void {
  describe(`cortexkitConfigDir on ${platform}`, () => {
    for (const { name, expected, ...options } of rows) {
      test(name, () => {
        const resolve = () => cortexkitConfigDir({ ...options, platform })
        if (expected === undefined) expectUnavailable(resolve)
        else expect(resolve()).toBe(expected)
      })
    }
  })
}

test('generated directory tables cover every state and both unresolved outcomes', () => {
  expect(unixRows).toHaveLength(4 ** 2 + 3 ** 2)
  expect(windowsRows).toHaveLength(4 ** 4 + 4 * 3 ** 3)
})

checkDirectoryRows('linux', unixRows)
checkDirectoryRows('darwin', unixRows)
checkDirectoryRows('win32', windowsRows)

const windowsAbsolute = [
  'C:\\x',
  'C:/x',
  'z:/',
  '\\\\server\\share\\x',
  '//server/share/x',
  '\\\\?\\C:\\x',
  '//?/C:/x',
  '\\\\.\\C:\\x',
  '\\\\?\\UNC\\server\\share\\x',
  '\\\\.\\pipe\\name',
]
const windowsRelative = [
  '',
  'relative',
  '\\x',
  '/x',
  'C:x',
  'C:',
  '\\\\server',
  '//server/',
  '\\\\server\\\\share\\x',
  '1:\\x',
]

describe('isAbsoluteForPlatform', () => {
  test.each(windowsAbsolute)('Windows accepts %j', (path) => {
    expect(isAbsoluteForPlatform(path, 'win32')).toBe(true)
  })
  test.each(windowsRelative)('Windows rejects %j', (path) => {
    expect(isAbsoluteForPlatform(path, 'win32')).toBe(false)
  })
  for (const platform of ['linux', 'darwin'] as const) {
    test.each(['/', '/x', '//server/share/x'])(
      `${platform} accepts a leading slash: %j`,
      (path) => {
        expect(isAbsoluteForPlatform(path, platform)).toBe(true)
      },
    )
    test.each(['', 'relative', '\\x', 'C:/x', 'C:\\x'])(
      `${platform} rejects a path without a leading slash: %j`,
      (path) => {
        expect(isAbsoluteForPlatform(path, platform)).toBe(false)
      },
    )
  }
})

describe('explicit Windows config paths', () => {
  test.each(['\\x', '/x', 'C:x'])(
    'ignores XDG_CONFIG_HOME=%j without a rooted drive or UNC prefix',
    (xdg) => {
      expect(
        cortexkitConfigDir({
          env: { XDG_CONFIG_HOME: xdg, APPDATA: 'D:\\roaming' },
          platform: 'win32',
          homedir: 'C:\\u',
        }),
      ).toBe('D:\\roaming\\cortexkit')
    },
  )
  test.each(['\\\\server\\share\\x', '//server/share/x'])(
    'uses UNC XDG_CONFIG_HOME=%j',
    (xdg) => {
      expect(
        cortexkitConfigDir({
          env: { XDG_CONFIG_HOME: xdg, APPDATA: 'D:\\roaming' },
          platform: 'win32',
          homedir: 'C:\\u',
        }),
      ).toBe('\\\\server\\share\\x\\cortexkit')
    },
  )
  test('HOME, HOMEDRIVE and HOMEPATH never choose the base', () => {
    const options = {
      env: { HOME: 'D:\\git-home', HOMEDRIVE: 'E:', HOMEPATH: '\\home' },
      platform: 'win32' as const,
      homedir: 'C:\\u',
    }
    expect(cortexkitConfigDir(options)).toBe(
      'C:\\u\\AppData\\Roaming\\cortexkit',
    )
    expectUnavailable(() =>
      cortexkitConfigDir({ ...options, homedir: 'relative' }),
    )
  })
})

describe('settingsFilePath', () => {
  test.each(windowsAbsolute)(
    'returns a Windows absolute override unchanged: %j',
    (override) => {
      expect(
        settingsFilePath({
          plugin: 'openai-auth',
          override,
          env: {},
          platform: 'win32',
          homedir: 'relative',
        }),
      ).toBe(override)
    },
  )
  test.each([undefined, ' ', '\t\r\n', ...windowsRelative])(
    'ignores an absent, blank or relative Windows override: %j',
    (override) => {
      expect(
        settingsFilePath({
          plugin: 'openai-auth',
          override,
          env: { XDG_CONFIG_HOME: 'C:/config/' },
          platform: 'win32',
          homedir: 'relative',
        }),
      ).toBe('C:\\config\\cortexkit\\openai-auth.jsonc')
    },
  )
  for (const platform of ['linux', 'darwin'] as const) {
    test(`${platform} returns an absolute override unchanged`, () => {
      const override = '/settings folder/custom.jsonc'
      expect(
        settingsFilePath({
          plugin: 'anthropic-auth',
          override,
          env: {},
          platform,
          homedir: 'relative',
        }),
      ).toBe(override)
    })
    test.each([undefined, '', ' ', '\t\r\n', 'relative', 'C:/x'])(
      `${platform} ignores an absent, blank or relative override: %j`,
      (override) => {
        expect(
          settingsFilePath({
            plugin: 'anthropic-auth',
            override,
            env: { XDG_CONFIG_HOME: '/config/' },
            platform,
            homedir: 'relative',
          }),
        ).toBe('/config/cortexkit/anthropic-auth.jsonc')
      },
    )
    test(`${platform} propagates an unavailable default directory`, () => {
      expectUnavailable(() =>
        settingsFilePath({
          plugin: 'anthropic-auth',
          env: {},
          platform,
          homedir: 'relative',
        }),
      )
    })
  }
})

describe('SettingsRefusal', () => {
  test('exposes the fixed, frozen refusal codes', () => {
    expect(SETTINGS_REFUSAL_CODES).toEqual([
      'settings-unparseable',
      'settings-newer-version',
      'settings-invalid-value',
      'settings-busy',
      'settings-unavailable',
    ])
    expect(Object.isFrozen(SETTINGS_REFUSAL_CODES)).toBe(true)
  })
  test.each([...SETTINGS_REFUSAL_CODES])(
    'carries the name, message and code %s',
    (code) => {
      const error = new SettingsRefusal(code, 'Settings operation refused')
      expect(error).toBeInstanceOf(Error)
      expect(error.name).toBe('SettingsRefusal')
      expect(error.message).toBe('Settings operation refused')
      expect(error.code).toBe(code)
      expect(error.cause).toBeUndefined()
    },
  )
  test('keeps an optional cause', () => {
    const cause = new Error('Unavailable folder')
    const error = new SettingsRefusal(
      'settings-unavailable',
      'Cannot find settings',
      { cause },
    )
    expect(error.cause).toBe(cause)
  })
})
