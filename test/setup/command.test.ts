import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeEnrollmentTokenFile } from '@cortexkit/claustrum-client'
import { parse } from 'jsonc-parser'
import type { ClaustrumEnrollmentConnection } from '../../src/claustrum/index.js'
import {
  AMBIGUOUS_OPENCODE_MESSAGE,
  ProcessFenceViolationError,
  ProcessInspectionError,
  runSetup,
  type SetupHostEnrollment,
  setupEnrollment,
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

/** A vault that approves every proposal on the first poll. */
function approvingVault(onPoll?: () => void): ClaustrumEnrollmentConnection {
  let name = ''
  return {
    close() {},
    async enrollPropose(input) {
      name = input.name
      return { requestId: `request-${name}` }
    },
    async enrollPoll() {
      onPoll?.()
      return {
        status: 'approved',
        token: 'f'.repeat(64),
        tokenGeneration: 1,
        name,
      }
    },
  }
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('setup did not fail')
}

describe('setup flow', () => {
  test('real and dry runs print progress before process inspection begins', async () => {
    for (const dryRun of [false, true]) {
      const io = fakeIO()
      io.folders.add('/home/test/.config/opencode')
      const term = terminal()
      let inspected = false
      const failure = new ProcessInspectionError({
        step: 'CIM',
        exitCode: 1,
        signal: 'SIGTERM',
        timedOut: true,
        durationMs: 45_001,
      })
      io.fence = {
        async listRunningHosts() {
          expect(term.lines.at(-1)?.trim()).toBe(
            'Checking that OpenCode and Pi are not running…',
          )
          inspected = true
          throw failure
        },
      }
      const result = runSetup(
        plugin(),
        dryRun ? ['--yes', '--dry-run'] : ['--yes'],
        {
          ...io,
          terminal: term,
        },
      )
      if (dryRun) expect((await result).dryRun).toBe(true)
      else await expect(result).rejects.toBe(failure)
      expect(inspected).toBe(true)
      expect(term.lines.join('')).toContain('CIM: timed out')
    }
  })

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

  test('a dry run without a terminal plans the --yes path instead of refusing', async () => {
    const io = fakeIO()
    io.folders.add('/home/test/.config/opencode')
    const term = terminal()
    const result = await runSetup(plugin(), ['--dry-run'], {
      ...io,
      terminal: term,
    })
    expect(result.dryRun).toBe(true)
    expect(result.hosts).toEqual(['opencode'])
    expect(term.lines.join('')).toContain('Would write')
    expect(io.files.size).toBe(0)
    await expect(
      runSetup(plugin(), [], { ...io, terminal: terminal() }),
    ).rejects.toThrow('Setup requires a TTY or --yes.')
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

  test('callbacks receive the OpenCode generation chosen with --opencode and the mode', async () => {
    const root = await profile()
    const p = plugin(root)
    const seen: unknown[] = []
    p.signInLocal = async (_host, context) => {
      seen.push(['login', context])
    }
    p.beforeRegister = async (_host, _mode, context) => {
      seen.push(['before', context])
    }
    p.migrate = async (_host, context) => {
      seen.push(['migrate', context])
    }
    await runSetup(p, ['--yes', '--login', '--opencode=2'], {
      terminal: terminal(),
      home: root,
      env: { PATH: '', OPENCODE_CONFIG_DIR: root },
      fence: {
        async listRunningHosts() {
          return []
        },
      },
    })
    const context = {
      opencodeGeneration: '2',
      mode: 'local',
      hosts: ['opencode'],
      piAgentDir: join(root, '.pi', 'agent'),
    }
    expect(seen).toEqual([
      ['login', context],
      ['before', context],
      ['migrate', context],
    ])
  })

  test("callbacks get Pi's own agent folder from PI_CODING_AGENT_DIR, not a plugin path", async () => {
    const io = fakeIO()
    io.folders.add('/home/test/.config/opencode')
    io.folders.add('/home/test/pi-native')
    io.files.set('/bin/pi', '')
    io.env = {
      ...io.env,
      PI_CODING_AGENT_DIR: '~/pi-native',
      PI_AGENT_DIR: '/home/test/decoy',
    }
    const p = plugin()
    let seen: string | undefined
    p.beforeSignIn = async (_host, context) => {
      seen = context.piAgentDir
      throw new Error('stop')
    }
    await expect(
      runSetup(p, ['--yes', '--login'], { ...io, terminal: terminal() }),
    ).rejects.toThrow('stop')
    expect(seen).toBe('/home/test/pi-native')
  })

  test('the first beforeSignIn sees every selected host before any host changes', async () => {
    const io = fakeIO()
    io.folders.add('/home/test/.config/opencode')
    io.folders.add('/home/test/.pi/agent')
    io.files.set('/bin/pi', '')
    const p = plugin()
    const seen: Array<{ host: string; hosts: readonly string[] }> = []
    p.beforeSignIn = async (host, context) => {
      seen.push({ host, hosts: context.hosts })
      throw new Error('Storage paths overlap.')
    }
    await expect(
      runSetup(p, ['--yes', '--login'], { ...io, terminal: terminal() }),
    ).rejects.toThrow('Storage paths overlap.')
    expect(seen).toEqual([{ host: 'opencode', hosts: ['opencode', 'pi'] }])
    expect(io.files.size).toBe(1)
  })

  test('a dry run previews running hosts without the full inspection', async () => {
    const io = fakeIO()
    io.folders.add('/home/test/.config/opencode')
    const term = terminal()
    await runSetup(plugin(), ['--yes', '--login', '--dry-run'], {
      ...io,
      terminal: term,
      fence: {
        async listRunningHosts() {
          throw new Error('a dry run must not run the full inspection')
        },
        async previewRunningHosts() {
          return { hosts: [], uncheckedRuntimes: 1 }
        },
      },
    })
    expect(term.lines.join('')).toContain(
      'Node or Bun programs are running; a real run checks whether any of them is OpenCode or Pi.',
    )
  })

  test('beforeSignIn runs first and a refusal stops the host before anything changes', async () => {
    const root = await profile()
    const p = plugin(root)
    const order: string[] = []
    p.beforeSignIn = async (host, context) => {
      order.push(`consent:${host}:${context.mode}`)
      throw new Error('Consent was not given.')
    }
    p.signInLocal = async () => {
      order.push('login')
    }
    p.migrate = async () => {
      order.push('migrate')
    }
    const io = {
      terminal: terminal(),
      home: root,
      env: { PATH: '', OPENCODE_CONFIG_DIR: root },
      fence: {
        async listRunningHosts() {
          return []
        },
      },
    }
    await expect(runSetup(p, ['--yes', '--login'], io)).rejects.toThrow(
      'Consent was not given.',
    )
    expect(order).toEqual(['consent:opencode:local'])
    expect(await readdir(root)).toEqual([])

    const dry = terminal()
    order.length = 0
    await runSetup(p, ['--yes', '--login', '--dry-run'], {
      ...io,
      terminal: dry,
    })
    expect(order).toEqual([])
    expect(dry.lines.join('')).toContain(
      'Would run beforeSignIn(opencode, local).',
    )
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

  for (const [name, key] of [
    ['Escape', '\x1b'],
    ['Ctrl-C', '\x03'],
  ] as const) {
    test(`${name} at the vault question stops setup before anything changes`, async () => {
      const io = fakeIO()
      io.files.set('/bin/opencode', '')
      io.files.set('/bin/ck', '')
      io.files.set('/fixture/connection.json', '{}')
      let proposals = 0
      io.connect = async () => ({
        close() {},
        async enrollPropose() {
          proposals++
          throw new Error('unexpected')
        },
        async enrollPoll() {
          throw new Error('unexpected')
        },
      })
      const before = new Map(io.files)
      const called: string[] = []
      const p = plugin()
      p.beforeSignIn = async () => {
        called.push('beforeSignIn')
      }
      p.signInLocal = async () => {
        called.push('signInLocal')
      }
      p.migrate = async () => {
        called.push('migrate')
      }
      const term = terminal(['\x1b[B\x1b[B\r', key])
      const result = await runSetup(p, [], { ...io, terminal: term })
      expect(result.hosts).toEqual([])
      expect(called).toEqual([])
      // Cancelling enrolls nothing: no host was proposed to the vault.
      expect(proposals).toBe(0)
      expect(io.files).toEqual(before)
      expect(term.lines.join('')).toContain(
        'Setup cancelled. Nothing was changed.',
      )
      expect(term.raw).toBe(false)
    })
  }

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

  test('a failure after OpenCode enrolled and before Pi names the connected host', async () => {
    const root = await profile()
    const p = plugin(root)
    const io = fakeIO()
    io.env = { PATH: '/bin', OPENCODE_CONFIG_DIR: join(root, 'config') }
    io.files.set('/bin/opencode', '')
    io.files.set('/bin/pi', '')
    io.files.set('/bin/ck', '')
    io.files.set(p.vault.connectionFile, '{}')
    io.connect = async () => approvingVault()
    io.wait = async () => {}
    // Pi's enrollment state cannot be read, so a probe after the failure could
    // not say Pi is not connected. Setup never asked Pi to enroll, and the
    // report has to come from that record.
    await mkdir(join(root, 'vault'), { recursive: true, mode: 0o700 })
    await writeFile(join(root, 'vault', 'pi-enrollment-state.json'), 'junk', {
      mode: 0o600,
    })
    const refusal = new Error('Pi consent declined.')
    p.beforeSignIn = async (host) => {
      if (host === 'pi') throw refusal
    }
    const term = terminal()
    const error = await rejection(
      runSetup(p, ['--yes', '--claustrum'], { ...io, terminal: term }),
    )
    expect(error).toBe(refusal)
    // The thrown error is untouched; the outcome is printed and recorded.
    expect(error.message).toBe('Pi consent declined.')
    expect(term.lines.join('')).toContain(
      'OpenCode: connected to the vault\nPi: not connected',
    )
    expect(setupEnrollment(error)).toEqual([
      { host: 'opencode', outcome: 'enrolled' },
      { host: 'pi', outcome: 'not-enrolled' },
    ] satisfies SetupHostEnrollment[])
  })

  for (const [name, before, line, outcome] of [
    ['no token', 'none', 'OpenCode: not connected', 'not-enrolled'],
    [
      'a token from an earlier run',
      'token',
      'OpenCode: connected to the vault',
      'enrolled',
    ],
    [
      'an unreadable token',
      'junk',
      'OpenCode: unknown, check with ck auth status',
      'unknown',
    ],
  ] as const) {
    test(`a failure during the enrollment wait is settled by the token file: ${name}`, async () => {
      const root = await profile()
      const p = plugin(root)
      const io = fakeIO()
      io.env = { PATH: '/bin', OPENCODE_CONFIG_DIR: join(root, 'config') }
      io.files.set('/bin/opencode', '')
      io.files.set('/bin/ck', '')
      io.files.set(p.vault.connectionFile, '{}')
      const tokenPath = join(root, 'vault', 'opencode-enrollment.json')
      await mkdir(join(root, 'vault'), { recursive: true, mode: 0o700 })
      if (before === 'token')
        await writeEnrollmentTokenFile(tokenPath, {
          token: 'a'.repeat(64),
          token_generation: 1,
        })
      if (before === 'junk') await writeFile(tokenPath, 'junk', { mode: 0o600 })
      // OpenCode starts while setup waits for approval, so the fence stops
      // setup in the middle of the enrollment.
      let running = false
      const host = { pid: 99, command: 'opencode' }
      io.fence = {
        async listRunningHosts() {
          return running ? [host] : []
        },
      }
      let connections = 0
      io.connect = async () => {
        // The first connection is detection's availability check; the second
        // one starts the enrollment.
        if (++connections === 2 && before !== 'none') running = true
        return {
          close() {},
          async enrollPropose() {
            return { requestId: 'request-1' }
          },
          async enrollPoll() {
            running = true
            return { status: 'pending' }
          },
        }
      }
      io.wait = async () => {}
      const term = terminal()
      const error = await rejection(
        runSetup(p, ['--yes', '--claustrum'], { ...io, terminal: term }),
      )
      expect(error).toBeInstanceOf(ProcessFenceViolationError)
      expect(error.message).toBe(new ProcessFenceViolationError([host]).message)
      expect(term.lines.join('')).toContain(line)
      expect(setupEnrollment(error)).toEqual([{ host: 'opencode', outcome }])
    })
  }

  test('a failure before any enrollment step leaves the error unchanged', async () => {
    const root = await profile()
    const p = plugin(root)
    const io = fakeIO()
    io.env = { PATH: '/bin', OPENCODE_CONFIG_DIR: join(root, 'config') }
    io.files.set('/bin/opencode', '')
    io.files.set('/bin/pi', '')
    io.files.set('/bin/ck', '')
    io.files.set(p.vault.connectionFile, '{}')
    let proposals = 0
    io.connect = async () => ({
      ...approvingVault(),
      async enrollPropose() {
        proposals++
        return { requestId: 'request-1' }
      },
    })
    const refusal = new Error('Consent declined.')
    p.beforeSignIn = async () => {
      throw refusal
    }
    const term = terminal()
    const error = await rejection(
      runSetup(p, ['--yes', '--claustrum'], { ...io, terminal: term }),
    )
    expect(error).toBe(refusal)
    expect(error.message).toBe('Consent declined.')
    expect(setupEnrollment(error)).toBeUndefined()
    expect(term.lines.join('')).not.toContain('connected')
    expect(proposals).toBe(0)
  })

  const hostileThrows: ReadonlyArray<
    readonly [string, (touches: string[]) => unknown]
  > = [
    [
      'a proxy that records every touch',
      (touches) =>
        new Proxy(
          {},
          {
            get(_, key) {
              touches.push(`get ${String(key)}`)
              return undefined
            },
            getOwnPropertyDescriptor(_, key) {
              touches.push(`descriptor ${String(key)}`)
              return undefined
            },
            getPrototypeOf() {
              touches.push('prototype')
              return null
            },
            set(_, key) {
              touches.push(`set ${String(key)}`)
              return false
            },
            defineProperty(_, key) {
              touches.push(`define ${String(key)}`)
              return false
            },
          },
        ),
    ],
    [
      'an error whose message is a getter without a setter',
      (touches) => {
        const error = new Error('placeholder')
        Object.defineProperty(error, 'message', {
          get() {
            touches.push('get message')
            return 'Getter failure.'
          },
        })
        return error
      },
    ],
    ['a thrown string', () => 'plain refusal'],
    ['a thrown null', () => null],
  ]
  for (const [name, make] of hostileThrows) {
    test(`a failure after enrollment rethrows ${name} untouched`, async () => {
      const root = await profile()
      const p = plugin(root)
      const io = fakeIO()
      io.env = { PATH: '/bin', OPENCODE_CONFIG_DIR: join(root, 'config') }
      io.files.set('/bin/opencode', '')
      io.files.set('/bin/pi', '')
      io.files.set('/bin/ck', '')
      io.files.set(p.vault.connectionFile, '{}')
      io.connect = async () => approvingVault()
      io.wait = async () => {}
      const touches: string[] = []
      const thrown = make(touches)
      p.beforeSignIn = async (host) => {
        if (host === 'pi') throw thrown
      }
      const term = terminal()
      let caught: unknown = 'not thrown'
      try {
        await runSetup(p, ['--yes', '--claustrum'], { ...io, terminal: term })
      } catch (error) {
        caught = error
      }
      // The same value comes back, and setup never inspected it.
      expect(caught === thrown).toBe(true)
      expect(touches).toEqual([])
      expect(term.lines.join('')).toContain(
        'OpenCode: connected to the vault\nPi: not connected',
      )
    })
  }
})
