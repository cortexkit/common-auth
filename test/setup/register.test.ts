import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'jsonc-parser'
import {
  planOpenCodeRegistration,
  registerOpenCode,
  registerPi,
  updatePluginConfig,
} from '../../src/setup/index.js'
import { fakeIO, plugin } from './helpers.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})
async function profile() {
  const root = await mkdtemp(join(tmpdir(), 'common-auth-setup-register-'))
  roots.push(root)
  return root
}

describe('setup registration', () => {
  test.skipIf(process.platform === 'win32')(
    'config registration never applies private writer permissions',
    async () => {
      const root = await profile()
      const file = join(root, 'opencode.jsonc')
      await writeFile(file, '{}\n')
      await chmod(file, 0o644)
      await registerOpenCode(
        planOpenCodeRegistration(plugin(root), '2', {
          env: { OPENCODE_CONFIG_DIR: root },
        }),
      )
      expect((await stat(file)).mode & 0o777).toBe(0o644)
      expect(parse(await readFile(file, 'utf8')).plugins).toEqual([
        '@cortexkit/opencode-test-auth@1.2.3',
      ])
    },
  )

  test('creates schema config and TUI atomically and is idempotent', async () => {
    const root = await profile()
    const io = { env: { OPENCODE_CONFIG_DIR: root } }
    const p = plugin(root)
    const writes = planOpenCodeRegistration(p, '1', io)
    expect(writes.map((write) => write.path)).toEqual([
      join(root, 'opencode.jsonc'),
      join(root, 'tui.jsonc'),
    ])
    await registerOpenCode(writes)
    for (const write of writes) {
      const content = parse(await readFile(write.path, 'utf8'))
      expect(content.$schema).toBe(
        write.path.endsWith('tui.jsonc')
          ? 'https://opencode.ai/tui.json'
          : 'https://opencode.ai/config.json',
      )
      expect(content.plugin).toEqual(['@cortexkit/opencode-test-auth@1.2.3'])
    }
    expect(
      planOpenCodeRegistration(p, '1', io).every((write) => !write.changed),
    ).toBe(true)
    expect((await readdir(root)).sort()).toEqual([
      'opencode.jsonc',
      'tui.jsonc',
    ])
  })

  test('JSONC registration keeps unrelated comments indentation and CRLF', () => {
    const text =
      '{\r\n\t// keep this explanation\r\n\t"model": "other", // inline\r\n\t"plugin": [\r\n\t\t"another@1", // keep sibling\r\n\t\t"@cortexkit/opencode-test-auth@0.1.0"\r\n\t]\r\n}\r\n'
    const result = updatePluginConfig(
      text,
      'plugin',
      '@cortexkit/opencode-test-auth',
      '1.2.3',
    )
    expect(result).toContain('\t// keep this explanation\r\n')
    expect(result).toContain('\t"model": "other", // inline\r\n')
    expect(result).toContain('"another@1", // keep sibling')
    expect(parse(result).plugin).toEqual([
      'another@1',
      '@cortexkit/opencode-test-auth@1.2.3',
    ])
    expect(result.replaceAll('\r\n', '')).not.toContain('\n')
  })

  test('replaces older package entries and removes duplicates', () => {
    const text =
      '{"plugin":["@cortexkit/opencode-test-auth@0.1.0","keep@1","@cortexkit/opencode-test-auth@0.2.0","@cortexkit/opencode-test-auth"]}'
    const result = updatePluginConfig(
      text,
      'plugin',
      '@cortexkit/opencode-test-auth',
      '1.2.3',
    )
    expect(parse(result).plugin).toEqual([
      '@cortexkit/opencode-test-auth@1.2.3',
      'keep@1',
    ])
    expect(
      updatePluginConfig(
        result,
        'plugin',
        '@cortexkit/opencode-test-auth',
        '1.2.3',
      ),
    ).toBe(result)
  })

  test('preserves tuple and object options on replacement and removes alternate own registration', () => {
    const text =
      '{"plugin":[["@cortexkit/opencode-test-auth@0.1",{"flag":true}]],"plugins":[{"package":"@cortexkit/opencode-test-auth@0.2","options":{"flag":false}},"other@1"]}'
    const result = parse(
      updatePluginConfig(
        text,
        'plugin',
        '@cortexkit/opencode-test-auth',
        '1.2.3',
      ),
    )
    expect(result.plugin).toEqual([
      ['@cortexkit/opencode-test-auth@1.2.3', { flag: true }],
    ])
    expect(result.plugins).toEqual(['other@1'])
    const v2 = parse(
      updatePluginConfig(
        text,
        'plugins',
        '@cortexkit/opencode-test-auth',
        '1.2.3',
      ),
    )
    expect(v2.plugins).toEqual([
      {
        package: '@cortexkit/opencode-test-auth@1.2.3',
        options: { flag: false },
      },
      'other@1',
    ])
    expect(v2.plugin).toEqual([])
  })

  test('prefers existing JSONC otherwise JSON and v2 only uses plural server config', async () => {
    const root = await profile()
    const io = { env: { OPENCODE_CONFIG_DIR: root } }
    await writeFile(join(root, 'opencode.json'), '{}\n')
    expect(
      planOpenCodeRegistration(plugin(root), '2', io).map(
        (write) => write.path,
      ),
    ).toEqual([join(root, 'opencode.json')])
    await writeFile(join(root, 'opencode.jsonc'), '{// comment\n "plugins":[]}')
    const writes = planOpenCodeRegistration(plugin(root), '2', io)
    expect(writes[0]?.path).toBe(join(root, 'opencode.jsonc'))
    await registerOpenCode(writes)
    expect(
      parse(await readFile(join(root, 'opencode.jsonc'), 'utf8')).plugins,
    ).toEqual(['@cortexkit/opencode-test-auth@1.2.3'])
    expect(await readFile(join(root, 'opencode.json'), 'utf8')).toBe('{}\n')
  })

  test('both generations use one singular registration and remove own plural entry', () => {
    const io = fakeIO()
    io.files.set(
      '/home/test/.config/opencode/opencode.jsonc',
      '{"plugins":["@cortexkit/opencode-test-auth@1","other@1"]}',
    )
    const writes = planOpenCodeRegistration(plugin(), 'both', io)
    expect(writes).toHaveLength(2)
    expect(parse(writes[0]!.content)).toMatchObject({
      plugin: ['@cortexkit/opencode-test-auth@1.2.3'],
      plugins: ['other@1'],
    })
  })

  test('malformed configs and nonarrays refuse without overwriting', () => {
    expect(() =>
      updatePluginConfig('{oops', 'plugin', 'test', '1.0.0'),
    ).toThrow('Invalid OpenCode config')
    expect(() =>
      updatePluginConfig('{"plugins":{}}', 'plugins', 'test', '1.0.0'),
    ).toThrow('must be an array')
  })

  test('Pi install uses resolved cmd launcher with versioned npm package', async () => {
    const io = fakeIO('win32')
    await registerPi(plugin(), 'C:\\npm\\pi.cmd', io)
    expect(io.commands).toEqual([
      {
        file: 'cmd.exe',
        args: [
          '/d',
          '/s',
          '/c',
          '""C:\\npm\\pi.cmd" install npm:@cortexkit/pi-test-auth@1.2.3"',
        ],
      },
    ])
  })

  test('atomic publication rechecks the process fence before rename', async () => {
    const root = await profile()
    let calls = 0
    await expect(
      registerOpenCode(
        planOpenCodeRegistration(plugin(root), '1', {
          env: { OPENCODE_CONFIG_DIR: root },
        }),
        async () => {
          if (++calls === 2) throw new Error('host started')
        },
      ),
    ).rejects.toThrow('host started')
    expect(await readdir(root)).toEqual([])
  })
})
