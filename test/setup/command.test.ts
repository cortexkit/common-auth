import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'jsonc-parser'
import {
  AMBIGUOUS_OPENCODE_MESSAGE,
  ProcessInspectionError,
  runSetup,
} from '../../src/setup/index.js'
import { fakeIO, plugin, terminal } from './helpers.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})
async function profile() {
  const root = await mkdtemp(join(tmpdir(), 'common-auth-setup-flow-'))
  roots.push(root)
  return root
}

describe('setup flow', () => {
  test('inspection refusal prints the step and timeout or exit code before rejecting', async () => {
    for (const timedOut of [false, true]) {
      const io = fakeIO()
      io.folders.add('/home/test/.config/opencode')
      const failure = new ProcessInspectionError({
        step: 'CIM',
        exitCode: timedOut ? 1 : 7,
        signal: timedOut ? 'SIGTERM' : null,
        timedOut,
        durationMs: timedOut ? 15_010 : 42,
      })
      io.fence = {
        async listRunningHosts() {
          throw failure
        },
      }
      const p = plugin()
      let mutations = 0
      p.signInLocal = p.migrate = async () => {
        mutations++
      }
      const term = terminal()
      await expect(
        runSetup(p, ['--yes'], { ...io, terminal: term }),
      ).rejects.toBe(failure)
      expect(term.lines.join('')).toContain(
        `CIM: ${timedOut ? 'timed out' : 'exit code 7'}`,
      )
      expect(mutations).toBe(0)
      expect(io.files.size).toBe(0)
    }
  })

  test('dry run reports running hosts instead of refusing', async () => {
    const io = fakeIO()
    io.folders.add('/home/test/.config/opencode')
    io.fence = {
      async listRunningHosts() {
        return [
          { pid: 99, command: 'opencode --secret hidden' },
          { pid: 100, command: 'pi' },
        ]
      },
    }
    const term = terminal()
    const result = await runSetup(plugin(), ['--yes', '--dry-run'], {
      ...io,
      terminal: term,
    })
    expect(result.dryRun).toBe(true)
    expect(term.lines.join('')).toContain(
      'OpenCode is running; setup will ask you to quit it.',
    )
    expect(term.lines.join('')).toContain(
      'Pi is running; setup will ask you to quit it.',
    )
    expect(term.lines.join('')).not.toContain('hidden')
    expect(term.lines.join('')).toContain('Would write')
    await expect(
      runSetup(plugin(), ['--yes'], { ...io, terminal: terminal() }),
    ).rejects.toThrow('Please quit')
  })

  test('a Pi folder without the pi CLI is skipped and never blocks OpenCode', async () => {
    const io = fakeIO()
    io.folders.add('/home/test/.config/opencode')
    io.folders.add('/home/test/.pi/agent')
    const term = terminal()
    const result = await runSetup(plugin(), ['--yes', '--dry-run'], {
      ...io,
      terminal: term,
    })
    expect(result.hosts).toEqual(['opencode'])
    expect(term.lines.join('')).toContain(
      'Pi: skipped, because its folder exists but pi is not on PATH.',
    )
  })

  test('dry run reports inspection failure and still plans without changing files', async () => {
    const io = fakeIO()
    io.folders.add('/home/test/.config/opencode')
    io.fence = {
      async listRunningHosts() {
        throw new Error('hidden inspection stderr')
      },
    }
    const term = terminal()
    const result = await runSetup(plugin(), ['--yes', '--dry-run'], {
      ...io,
      terminal: term,
    })
    expect(result.dryRun).toBe(true)
    expect(term.lines.join('')).toContain(
      'Process inspection failed; real setup will require successful inspection',
    )
    expect(term.lines.join('')).not.toContain('hidden')
    expect(term.lines.join('')).toContain('Would write')
    expect(io.files.size).toBe(0)
  })

  test('dry run prints every shared write but calls no mutation callbacks', async () => {
    const root = await profile()
    const term = terminal()
    const p = plugin(root)
    p.signInLocal =
      p.migrate =
      p.beforeRegister =
        async () => {
          throw new Error('must not run')
        }
    const result = await runSetup(p, ['--yes', '--dry-run'], {
      terminal: term,
      home: root,
      env: { PATH: '', OPENCODE_CONFIG_DIR: root },
      fence: {
        async listRunningHosts() {
          return []
        },
      },
    })
    expect(result.hosts).toEqual(['opencode'])
    expect(await readdir(root)).toEqual([])
    const output = term.lines.join('')
    expect(output).toContain(`Would write ${join(root, 'opencode.jsonc')}`)
    expect(output).toContain(`Would write ${join(root, 'tui.jsonc')}`)
    expect(output).toContain('@cortexkit/opencode-test-auth@1.2.3')
    expect(output).toContain('Would migrate opencode')
  })

  test('local flow signs in then registers then migrates and summarizes', async () => {
    const root = await profile()
    const p = plugin(root)
    const order: string[] = []
    p.signInLocal = async (host) => {
      order.push(`login:${host}`)
      expect(await readdir(root)).toEqual([])
    }
    p.beforeRegister = async (host, mode) => {
      order.push(`before:${host}:${mode}`)
      expect(await readdir(root)).toEqual([])
    }
    p.migrate = async (host) => {
      order.push(`migrate:${host}`)
      expect(
        parse(await readFile(join(root, 'opencode.jsonc'), 'utf8')).plugin,
      ).toEqual(['@cortexkit/opencode-test-auth@1.2.3'])
    }
    const term = terminal()
    await runSetup(p, ['--yes', '--login'], {
      terminal: term,
      home: root,
      env: { PATH: '', OPENCODE_CONFIG_DIR: root },
      fence: {
        async listRunningHosts() {
          return []
        },
      },
    })
    expect(order).toEqual([
      'login:opencode',
      'before:opencode:local',
      'migrate:opencode',
    ])
    expect(term.lines.join('')).toContain('start OpenCode and run /test-auth')
  })

  test('fence refuses before local sign-in registration or migration', async () => {
    const root = await profile()
    const p = plugin(root)
    let calls = 0
    p.signInLocal = p.migrate = async () => {
      calls++
    }
    await expect(
      runSetup(p, ['--yes'], {
        terminal: terminal(),
        home: root,
        env: { PATH: '', OPENCODE_CONFIG_DIR: root },
        fence: {
          async listRunningHosts() {
            return [{ pid: 99, command: 'opencode --token hidden' }]
          },
        },
      }),
    ).rejects.toThrow('Please quit')
    expect(calls).toBe(0)
    expect(await readdir(root)).toEqual([])
  })

  test('host starting during sign-in stops registration and migration', async () => {
    const root = await profile()
    const p = plugin(root)
    let running = false
    p.signInLocal = async () => {
      running = true
    }
    p.migrate = async () => {
      throw new Error('must not migrate')
    }
    await expect(
      runSetup(p, ['--yes'], {
        terminal: terminal(),
        home: root,
        env: { PATH: '', OPENCODE_CONFIG_DIR: root },
        fence: {
          async listRunningHosts() {
            return running ? [{ pid: 99, command: 'pi' }] : []
          },
        },
      }),
    ).rejects.toThrow('Please quit')
    expect(await readdir(root)).toEqual([])
  })

  test('incompatible login and vault flags reject before detection', async () => {
    const io = fakeIO()
    await expect(
      runSetup(plugin(), ['--login', '--claustrum'], io),
    ).rejects.toThrow('--login and --claustrum')
    await expect(
      runSetup(plugin(), ['--no-claustrum', '--claustrum'], io),
    ).rejects.toThrow('--claustrum and --no-claustrum')
    expect(io.commands).toEqual([])
  })

  test('unknown flags and noninteractive setup without yes refuse', async () => {
    await expect(
      runSetup(plugin(), ['--opencode=3'], { terminal: terminal() }),
    ).rejects.toThrow('Unknown setup argument')
    await expect(
      runSetup(plugin(), [], { ...fakeIO(), terminal: terminal() }),
    ).rejects.toThrow('TTY or --yes')
  })

  test('ambiguous yes refuses before writes and names the generation override', async () => {
    const io = fakeIO()
    io.files.set('/bin/opencode', '')
    io.files.set('/bin/opencode2', '')
    await expect(
      runSetup(plugin(), ['--yes', '--dry-run'], {
        ...io,
        terminal: terminal(),
      }),
    ).rejects.toThrow(AMBIGUOUS_OPENCODE_MESSAGE)
    expect(io.files.size).toBe(2)
  })

  test('interactive ambiguous prompt allows both with one compatible registration', async () => {
    const io = fakeIO()
    io.files.set('/bin/opencode', '')
    io.files.set('/bin/opencode2', '')
    const term = terminal(['\x1b[B\x1b[B\r', '\x1b[B\x1b[B\r'])
    await runSetup(plugin(), ['--dry-run'], { ...io, terminal: term })
    const output = term.lines.join('')
    expect(output).toContain('Which OpenCode generation')
    expect(output).toContain('Both (one compatible registration)')
    expect(output).toContain('"plugin"')
    expect(output).not.toContain('"plugins"')
    expect(term.raw).toBe(false)
  })

  test('generation flags override inference including both', async () => {
    for (const flag of ['1', '2', 'both']) {
      const io = fakeIO()
      io.folders.add('/home/test/.config/opencode')
      io.files.set(
        '/home/test/.config/opencode/opencode.jsonc',
        '{"plugins":[]}',
      )
      const term = terminal()
      await runSetup(plugin(), ['--yes', '--dry-run', `--opencode=${flag}`], {
        ...io,
        terminal: term,
      })
      const output = term.lines.join('')
      expect(output).toContain(`"${flag === '2' ? 'plugins' : 'plugin'}":`)
      expect(output.includes('tui.jsonc')).toBe(flag !== '2')
    }
  })

  test('host multiselect preselects found hosts and can toggle one off', async () => {
    const io = fakeIO()
    io.files.set('/bin/opencode', '')
    io.files.set('/bin/pi', '')
    const term = terminal(['\r', '\x1b[B\x1b[B\r'])
    const result = await runSetup(plugin(), ['--dry-run'], {
      ...io,
      terminal: term,
    })
    expect(result.hosts).toEqual(['pi'])
    expect(term.lines.join('')).toContain('[x] OpenCode')
    expect(term.lines.join('')).toContain('[x] Pi')
    expect(term.lines.join('')).toContain(
      'install npm:@cortexkit/pi-test-auth@1.2.3',
    )
  })

  test('yes does not silently choose vault and explicit unavailable vault refuses', async () => {
    const io = fakeIO()
    io.files.set('/bin/opencode', '')
    io.files.set('/bin/ck', '')
    io.files.set('/fixture/connection.json', '{}')
    io.connect = async () => ({
      close() {},
      async enrollPropose() {
        throw new Error('unexpected')
      },
      async enrollPoll() {
        throw new Error('unexpected')
      },
    })
    const result = await runSetup(plugin(), ['--yes', '--dry-run'], {
      ...io,
      terminal: terminal(),
    })
    expect(result.mode).toBe('local')
    io.files.delete('/bin/ck')
    await expect(
      runSetup(plugin(), ['--yes', '--claustrum', '--dry-run'], {
        ...io,
        terminal: terminal(),
      }),
    ).rejects.toThrow('not available')
  })

  test('vault dry run prints enrollment paths without proposing or writing', async () => {
    const io = fakeIO()
    io.files.set('/bin/opencode', '')
    io.files.set('/bin/ck', '')
    io.files.set('/fixture/connection.json', '{}')
    io.connect = async () => ({
      close() {},
      async enrollPropose() {
        throw new Error('unexpected')
      },
      async enrollPoll() {
        throw new Error('unexpected')
      },
    })
    const term = terminal()
    const result = await runSetup(
      plugin(),
      ['--yes', '--claustrum', '--dry-run'],
      { ...io, terminal: term },
    )
    expect(result.mode).toBe('claustrum')
    expect(term.lines.join('')).toContain(
      '/fixture/vault/opencode-enrollment-state.json',
    )
    expect(io.files.size).toBe(3)
  })

  test('vault Connect waits for approval and persists enrollment before migration', async () => {
    const root = await profile()
    const p = plugin(root)
    const io = fakeIO()
    io.env = { PATH: '/bin', OPENCODE_CONFIG_DIR: join(root, 'config') }
    io.files.set('/bin/opencode', '')
    io.files.set('/bin/ck', '')
    io.files.set(p.vault.connectionFile, '{}')
    let polled = 0
    let closed = 0
    let migrations = 0
    const secret = 'e'.repeat(64)
    io.connect = async () => ({
      close() {
        closed++
      },
      async enrollPropose(input) {
        expect(input.name).toBe('test-auth-opencode')
        return { requestId: 'request-1' }
      },
      async enrollPoll() {
        return ++polled === 1
          ? { status: 'pending' }
          : {
              status: 'approved',
              token: secret,
              tokenGeneration: 1,
              name: 'test-auth-opencode',
            }
      },
    })
    io.wait = async () => {}
    p.signInLocal = async () => {
      throw new Error('local must not run')
    }
    p.beforeRegister = async (_host, mode) => {
      expect(mode).toBe('claustrum')
    }
    p.migrate = async () => {
      migrations++
      expect(
        JSON.parse(
          await readFile(
            join(root, 'vault', 'opencode-enrollment.json'),
            'utf8',
          ),
        ).token,
      ).toBe(secret)
    }
    const term = terminal()
    await runSetup(p, ['--yes', '--claustrum'], { ...io, terminal: term })
    expect(migrations).toBe(1)
    expect(polled).toBe(2)
    expect(closed).toBe(2)
    expect(term.lines.join('')).toContain(
      'ck auth enroll approve --request-id request-1 --name test-auth-opencode',
    )
    expect(term.lines.join('')).not.toContain(secret)
  })

  test('invalid config refuses before local sign-in can change state', async () => {
    const root = await profile()
    await writeFile(join(root, 'opencode.jsonc'), 'invalid')
    const p = plugin(root)
    let calls = 0
    p.signInLocal = async () => {
      calls++
    }
    await expect(
      runSetup(p, ['--yes'], {
        terminal: terminal(),
        home: root,
        env: { PATH: '', OPENCODE_CONFIG_DIR: root },
        fence: {
          async listRunningHosts() {
            return []
          },
        },
      }),
    ).rejects.toThrow('Invalid OpenCode config')
    expect(calls).toBe(0)
  })
})
