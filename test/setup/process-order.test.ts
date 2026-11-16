import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import * as enrollmentClient from '@cortexkit/claustrum-client'
import {
  ClaustrumEnrollmentManager,
  hostEnrollmentPaths,
} from '../../src/claustrum/enrollment.js'
import type { ClaustrumEnrollmentConnection } from '../../src/claustrum/index.js'
import { runSetup } from '../../src/setup/command.js'
import * as configWrite from '../../src/setup/config-write.js'
import { ProcessFenceViolationError } from '../../src/setup/process-fence.js'
import type { SetupIO } from '../../src/setup/types.js'
import { plugin, terminal } from './helpers.js'

const roots: string[] = []
const restores: Array<() => void> = []
afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) restore()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

/** Record the publication, not the hidden config staging file. */
function recordWrites(events: string[]) {
  const writeConfig = configWrite.writeHostConfigAtomic
  const config = spyOn(configWrite, 'writeHostConfigAtomic').mockImplementation(
    (file, content, options) =>
      writeConfig(file, content, {
        ...options,
        async rename(from, to) {
          events.push(`write:${basename(to)}`)
          await (options?.rename ?? rename)(from, to)
        },
      }),
  )
  const writeToken = enrollmentClient.writeEnrollmentTokenFile
  const token = spyOn(
    enrollmentClient,
    'writeEnrollmentTokenFile',
  ).mockImplementation(async (path, file) => {
    events.push('write:token')
    await writeToken(path, file)
  })
  const reconcile = ClaustrumEnrollmentManager.prototype.reconcile
  const manager = spyOn(
    ClaustrumEnrollmentManager.prototype,
    'reconcile',
  ).mockImplementation(function (this: ClaustrumEnrollmentManager) {
    // Reconcile is a possible state write, even if the vault only reports pending.
    events.push('write:reconcile')
    return reconcile.call(this)
  })
  restores.push(
    () => config.mockRestore(),
    () => token.mockRestore(),
    () => manager.mockRestore(),
  )
}

function assertGuarded(events: string[]) {
  let checked = false
  for (const event of events) {
    if (event === 'check') checked = true
    else if (event.startsWith('write:') || event.startsWith('callback:')) {
      expect(checked, `unguarded ${event} in ${events.join(', ')}`).toBe(true)
      checked = false
    } else if (event === 'wait' || event === 'prompt' || event === 'browser')
      checked = false
  }
}

async function fixture(events: string[], both = false) {
  const root = await mkdtemp(join(tmpdir(), 'common-auth-process-order-'))
  roots.push(root)
  const bin = join(root, 'bin')
  const ck = join(bin, process.platform === 'win32' ? 'ck.exe' : 'ck')
  const pi = join(bin, process.platform === 'win32' ? 'pi.exe' : 'pi')
  const p = plugin(root)
  p.beforeSignIn = async (host) => {
    events.push(`callback:beforeSignIn:${host}`)
  }
  p.signInLocal = async (host) => {
    events.push(`callback:signInLocal:${host}`)
    events.push('browser')
  }
  p.beforeRegister = async (host) => {
    events.push(`callback:beforeRegister:${host}`)
  }
  p.migrate = async (host) => {
    events.push(`callback:migrate:${host}`)
  }
  let started = false
  let polls = 0
  const connection: ClaustrumEnrollmentConnection = {
    close() {
      if (started) events.push('close')
    },
    async enrollPropose() {
      events.push('propose')
      return { requestId: 'request-1' }
    },
    async enrollPoll() {
      events.push('poll')
      if (++polls === 1) return { status: 'pending' }
      return {
        status: 'approved',
        token: 'f'.repeat(64),
        tokenGeneration: 1,
        name: 'test-auth-opencode',
      }
    },
  }
  const io = {
    home: root,
    env: {
      PATH: bin,
      OPENCODE_CONFIG_DIR: join(root, 'opencode'),
      PI_CODING_AGENT_DIR: join(root, 'pi'),
    },
    terminal: terminal(),
    now: () => 0,
    fence: {
      async listRunningHosts() {
        started = true
        events.push('check')
        return []
      },
    },
    async connect() {
      if (started) events.push('connect')
      return connection
    },
    async wait() {
      events.push('wait')
    },
    runner: {
      async run(_file: string, args: readonly string[]) {
        if (args[0] === 'install') events.push('write:pi-install')
        return { exitCode: 0, stdout: '2.0.21\n', stderr: '' }
      },
    },
    fs: {
      exists: () => true,
      isFile: (file: string) => file === ck || (both && file === pi),
      isExecutable: (file: string) => file === ck || (both && file === pi),
      isDirectory: (file: string) =>
        file === join(root, 'opencode') || (both && file === join(root, 'pi')),
      readText: () => '{}',
      realpath: (file: string) => file,
    },
  } satisfies SetupIO
  return { p, io, root, connection }
}

describe('setup ordered process checks', () => {
  test('local sign-in on one host reuses only the initial uninterrupted check', async () => {
    const events: string[] = []
    const { p, io } = await fixture(events)
    recordWrites(events)
    await runSetup(p, ['--yes', '--login', '--opencode=2'], io)
    expect(events.filter((event) => event === 'check')).toHaveLength(5)
    expect(events).toEqual([
      'check',
      'callback:beforeSignIn:opencode',
      'check',
      'callback:signInLocal:opencode',
      'browser',
      'check',
      'callback:beforeRegister:opencode',
      'check',
      'write:opencode.jsonc',
      'check',
      'callback:migrate:opencode',
    ])
    assertGuarded(events)
  })

  test('vault pending then approved keeps the per-tick and token-write checks', async () => {
    const events: string[] = []
    const { p, io, root } = await fixture(events)
    recordWrites(events)
    await runSetup(p, ['--yes', '--claustrum', '--opencode=2'], io)
    expect(events.filter((event) => event === 'check')).toHaveLength(7)
    expect(events).toEqual([
      'check',
      'callback:beforeSignIn:opencode',
      'check',
      'connect',
      'write:reconcile',
      'propose',
      'poll',
      'wait',
      'check',
      'write:reconcile',
      'poll',
      'check',
      'write:token',
      'close',
      'check',
      'callback:beforeRegister:opencode',
      'check',
      'write:opencode.jsonc',
      'check',
      'callback:migrate:opencode',
    ])
    assertGuarded(events)
    const paths = hostEnrollmentPaths(p.vault.hosts.opencode.paths)
    expect(JSON.parse(await readFile(paths.tokenPath, 'utf8')).token).toBe(
      'f'.repeat(64),
    )
    expect(
      await readFile(join(root, 'opencode', 'opencode.jsonc'), 'utf8'),
    ).toContain(p.packages.opencode)
  })

  test('already-approved vault enrollment needs no check after read-only status', async () => {
    const events: string[] = []
    const { p, io } = await fixture(events)
    const paths = hostEnrollmentPaths(p.vault.hosts.opencode.paths)
    await enrollmentClient.writeEnrollmentTokenFile(paths.tokenPath, {
      token: 'f'.repeat(64),
      token_generation: 1,
    })
    // No callbacks means the initial inspection also covers read-only enrollment.
    delete p.beforeSignIn
    delete p.beforeRegister
    delete p.migrate
    recordWrites(events)
    await runSetup(p, ['--yes', '--claustrum', '--opencode=2'], io)
    expect(events.filter((event) => event === 'check')).toHaveLength(1)
    expect(events).toEqual([
      'check',
      'connect',
      'close',
      'write:opencode.jsonc',
    ])
    assertGuarded(events)
  })

  test('a slow read-only vault connect expires reuse before registration', async () => {
    const events: string[] = []
    const { p, io, connection } = await fixture(events)
    const paths = hostEnrollmentPaths(p.vault.hosts.opencode.paths)
    await enrollmentClient.writeEnrollmentTokenFile(paths.tokenPath, {
      token: 'f'.repeat(64),
      token_generation: 1,
    })
    delete p.beforeSignIn
    delete p.beforeRegister
    delete p.migrate
    let now = 0
    io.now = () => now
    const connect = io.connect
    io.connect = async () => {
      await connect()
      now += 5000
      return connection
    }
    recordWrites(events)
    await runSetup(p, ['--yes', '--claustrum', '--opencode=2'], io)
    expect(events).toEqual([
      'check',
      'connect',
      'close',
      'check',
      'write:opencode.jsonc',
    ])
    assertGuarded(events)
  })

  test('without optional hooks each OpenCode 1 config publication still needs a check', async () => {
    const events: string[] = []
    const { p, io } = await fixture(events)
    delete p.beforeSignIn
    delete p.beforeRegister
    delete p.migrate
    recordWrites(events)
    await runSetup(p, ['--yes', '--login', '--opencode=1'], io)
    expect(events).toEqual([
      'check',
      'callback:signInLocal:opencode',
      'browser',
      'check',
      'write:opencode.jsonc',
      'check',
      'write:tui.jsonc',
    ])
    assertGuarded(events)
  })

  test('OpenCode plus Pi checks every callback and each host registration', async () => {
    const events: string[] = []
    const { p, io } = await fixture(events, true)
    recordWrites(events)
    await runSetup(p, ['--yes', '--login', '--opencode=2'], io)
    expect(events.filter((event) => event === 'check')).toHaveLength(10)
    expect(events).toEqual([
      'check',
      'callback:beforeSignIn:opencode',
      'check',
      'callback:signInLocal:opencode',
      'browser',
      'check',
      'callback:beforeRegister:opencode',
      'check',
      'write:opencode.jsonc',
      'check',
      'callback:migrate:opencode',
      'check',
      'callback:beforeSignIn:pi',
      'check',
      'callback:signInLocal:pi',
      'browser',
      'check',
      'callback:beforeRegister:pi',
      'check',
      'write:pi-install',
      'check',
      'callback:migrate:pi',
    ])
    assertGuarded(events)
  })

  test('dry run retains one preview and no writes waits or callbacks', async () => {
    const events: string[] = []
    const { p, io } = await fixture(events, true)
    const preview = {
      ...io.fence,
      async previewRunningHosts() {
        events.push('preview')
        return { hosts: [], uncheckedRuntimes: 0 }
      },
    }
    recordWrites(events)
    await runSetup(p, ['--yes', '--claustrum', '--dry-run', '--opencode=2'], {
      ...io,
      fence: preview,
    })
    expect(events).toEqual(['preview'])
    assertGuarded(events)
  })

  test('vault-choice prompt invalidates the initial inspection before local sign-in', async () => {
    const events: string[] = []
    const { p, io } = await fixture(events)
    const term = terminal(['\r'])
    const resume = term.input.resume.bind(term.input)
    term.input.resume = () => {
      events.push('prompt')
      resume()
    }
    recordWrites(events)
    await runSetup(p, ['--host=opencode', '--opencode=2'], {
      ...io,
      terminal: term,
    })
    expect(events).toEqual([
      'check',
      'prompt',
      'check',
      'callback:beforeSignIn:opencode',
      'check',
      'callback:signInLocal:opencode',
      'browser',
      'check',
      'callback:beforeRegister:opencode',
      'check',
      'write:opencode.jsonc',
      'check',
      'callback:migrate:opencode',
    ])
    assertGuarded(events)
  })

  test('a host starting in the vault-choice prompt stops the next callback', async () => {
    const events: string[] = []
    const { p, io } = await fixture(events)
    let running = false
    const term = terminal(['\r'])
    const resume = term.input.resume.bind(term.input)
    term.input.resume = () => {
      events.push('prompt')
      running = true
      resume()
    }
    recordWrites(events)
    await expect(
      runSetup(p, ['--host=opencode', '--opencode=2'], {
        ...io,
        terminal: term,
        fence: {
          async listRunningHosts() {
            events.push('check')
            return running ? [{ pid: 99, command: 'opencode' }] : []
          },
        },
      }),
    ).rejects.toBeInstanceOf(ProcessFenceViolationError)
    expect(events).toEqual(['check', 'prompt', 'check'])
  })
})
