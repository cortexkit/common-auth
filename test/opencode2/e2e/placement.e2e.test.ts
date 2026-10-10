// Placement contract for the OpenCode 2 hooks: runs the real `@opencode/cli`
// against a loopback mock provider with two accounts and checks what reached
// the wire. A host release that stops firing one of the hooks, or fires it in
// a different place, fails here. It needs the network once to install the
// CLI, so it only runs when COMMON_AUTH_OPENCODE2_E2E=1 (its own CI job).
// COMMON_AUTH_OPENCODE2_E2E_CLI_DIR may point at a directory that already
// holds the pinned CLI install, to skip the install while iterating.
import { beforeAll, describe, expect } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { placeholderSecret } from '../../../src/opencode2/index.js'
import { lifetimeHooks } from '../../fixtures/lifetime-hooks.js'
import {
  type AccountName,
  type MockProvider,
  type RejectMode,
  startMockProvider,
  type WireRecord,
} from './mock-provider.js'

const hooks = lifetimeHooks()
const { afterAll, test } = hooks

const ENABLED = process.env.COMMON_AUTH_OPENCODE2_E2E === '1'
const REUSE_CLI_DIR = process.env.COMMON_AUTH_OPENCODE2_E2E_CLI_DIR
export const OPENCODE_CLI_VERSION = '2.0.22'
const PROVIDER = 'openai'
const PLACEHOLDER = placeholderSecret(PROVIDER)
const PASSWORD = 'common-auth-e2e-loopback-only'

type Transport = 'http' | 'websocket'
type PluginEvent = { event: string } & Record<string, unknown>
type Turn = { account: AccountName; reject?: RejectMode; message?: string }

interface ScenarioResult {
  readonly wire: WireRecord[]
  readonly plugin: PluginEvent[]
  readonly stdout: string[]
  readonly exits: Array<number | null>
  /** The vault login's exit code and output, when the scenario ran one. */
  readonly login?: { readonly exit: number | null; readonly output: string }
  /** The host's credential rows right after that login. */
  readonly credentials?: unknown
  readonly diagnostics: string
}

/** The ID the test plugin registers its vault activation method under. */
const VAULT_METHOD_ID = 'common-auth-e2e-vault'

let scratch = ''
let cli = ''
let pluginDir = ''

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

function isolatedEnv(root: string, extra: Record<string, string>) {
  const dirs = {
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    XDG_STATE_HOME: join(root, 'xdg-state'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'),
    TMPDIR: join(root, 'tmp'),
  }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  return {
    PATH: process.env.PATH ?? '',
    ...dirs,
    // Anything that is not the loopback mock goes to a dead proxy, so a
    // misrouted request fails instead of reaching the internet.
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    OPENCODE_SERVER_PASSWORD: PASSWORD,
    OPENCODE_PASSWORD: PASSWORD,
    ...extra,
  }
}

async function waitForServer(url: string, child: Bun.Subprocess) {
  while (!hooks.lifetime.signal.aborted) {
    if (child.exitCode !== null)
      throw new Error(`host exited early with ${child.exitCode}`)
    try {
      await fetch(url, {
        signal: AbortSignal.any([
          hooks.lifetime.signal,
          AbortSignal.timeout(1000),
        ]),
      })
      return
    } catch {
      await Bun.sleep(250)
    }
  }
  throw new Error(`host at ${url} did not start before test cancellation`)
}

async function collect(
  stream: ReadableStream<Uint8Array> | null | undefined,
  into: string[],
) {
  if (!stream) return
  const decoder = new TextDecoder()
  for await (const chunk of stream)
    into.push(decoder.decode(chunk, { stream: true }))
}

/** Runs one CLI command to completion, killing it after 90 seconds. */
async function runCli(
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{ exit: number | null; stdout: string; stderr: string }> {
  const child = Bun.spawn([cli, ...args], {
    cwd,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out: string[] = []
  const err: string[] = []
  const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
  await Promise.all([
    collect(child.stdout, out),
    collect(child.stderr, err),
    child.exited,
  ])
  clearTimeout(timer)
  return { exit: child.exitCode, stdout: out.join(''), stderr: err.join('') }
}

async function runScenario(
  transport: Transport,
  turns: Turn[],
  options: {
    markFrames?: boolean
    receiptOnWire?: boolean
    apiKey?: string
    gateOnPlaceholder?: boolean
    /**
     * Leave the provider without a configured key and sign in with the test
     * plugin's vault method through `opencode auth login` before the turns;
     * `refuse` makes the plugin's activation refuse with that message.
     */
    vault?: { refuse?: string }
  } = {},
): Promise<ScenarioResult> {
  const root = await mkdtemp(join(tmpdir(), 'common-auth-oc2-e2e-'))
  const project = join(root, 'project')
  mkdirSync(project, { recursive: true })
  spawnSync('git', ['init', '-q'], { cwd: project })
  const pluginLog = join(root, 'plugin.jsonl')
  const control = join(root, 'control.json')
  writeFileSync(pluginLog, '')
  const mock: MockProvider = startMockProvider([PLACEHOLDER])
  const env = isolatedEnv(root, {
    COMMON_AUTH_E2E_PLUGIN_LOG: pluginLog,
    COMMON_AUTH_E2E_CONTROL: control,
    ...(options.markFrames ? { COMMON_AUTH_E2E_MARK_FRAMES: '1' } : {}),
    ...(options.receiptOnWire ? { COMMON_AUTH_E2E_RECEIPT_ON_WIRE: '1' } : {}),
    ...(options.gateOnPlaceholder
      ? { COMMON_AUTH_E2E_GATE_PLACEHOLDER: '1' }
      : {}),
    ...(options.vault
      ? {
          COMMON_AUTH_E2E_VAULT_METHOD: VAULT_METHOD_ID,
          ...(options.vault.refuse
            ? { COMMON_AUTH_E2E_VAULT_REFUSE: options.vault.refuse }
            : {}),
        }
      : {}),
  })
  const config = {
    plugins: [pluginDir],
    providers: {
      [PROVIDER]: {
        // Normally use the placeholder returned by the plugin's login; the
        // pass-through scenario supplies a stock host API key instead, and
        // the vault scenarios configure no key so the host sends the
        // credential its login stored.
        settings: {
          baseURL: `${mock.url}/v1`,
          ...(options.vault ? {} : { apiKey: options.apiKey ?? PLACEHOLDER }),
          transport,
        },
        models: { 'mock-model': { name: 'Mock model' } },
      },
    },
  }
  mkdirSync(join(env.XDG_CONFIG_HOME, 'opencode'), { recursive: true })
  writeFileSync(
    join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.json'),
    JSON.stringify(config, null, 2),
  )

  const port = await freePort()
  const serverURL = `http://127.0.0.1:${port}`
  const serverLog: string[] = []
  const server = Bun.spawn(
    [
      cli,
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
      '--print-logs',
      '--log-level',
      'info',
    ],
    { cwd: project, env, stdout: 'pipe', stderr: 'pipe' },
  )
  const serverOutput = Promise.all([
    collect(server.stdout, serverLog),
    collect(server.stderr, serverLog),
  ])
  const stdout: string[] = []
  const clientLog: string[] = []
  const exits: Array<number | null> = []
  let login: ScenarioResult['login']
  let credentials: unknown
  try {
    await waitForServer(serverURL, server)
    if (options.vault) {
      // The CLI's own login, as a user runs it, without a terminal: it
      // never prompts, and opens no browser.
      const run = await runCli(
        [
          'auth',
          'login',
          PROVIDER,
          '--server',
          serverURL,
          '--method',
          VAULT_METHOD_ID,
        ],
        project,
        env,
      )
      login = { exit: run.exit, output: `${run.stdout}${run.stderr}` }
      clientLog.push(`--- vault login ---\n${login.output}`)
      const response = await fetch(`${serverURL}/api/credential`, {
        headers: {
          authorization: `Basic ${btoa(`opencode:${PASSWORD}`)}`,
        },
        signal: AbortSignal.any([
          hooks.lifetime.signal,
          AbortSignal.timeout(10_000),
        ]),
      })
      credentials = await response.json()
    }
    for (const [index, turn] of turns.entries()) {
      writeFileSync(control, JSON.stringify({ next: turn.account }))
      if (turn.reject) mock.reject(turn.account, turn.reject)
      const child = Bun.spawn(
        [
          cli,
          'run',
          '--server',
          serverURL,
          '--format',
          'json',
          '--model',
          `${PROVIDER}/mock-model`,
          ...(index > 0 ? ['--continue'] : []),
          turn.message ?? `Turn ${index + 1}: say hello.`,
        ],
        { cwd: project, env, stdout: 'pipe', stderr: 'pipe' },
      )
      const out: string[] = []
      const err: string[] = []
      const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
      await Promise.all([
        collect(child.stdout, out),
        collect(child.stderr, err),
        child.exited,
      ])
      clearTimeout(timer)
      exits.push(child.exitCode)
      stdout.push(out.join(''))
      clientLog.push(`--- turn ${index + 1} stderr ---\n${err.join('')}`)
    }
  } finally {
    server.kill('SIGTERM')
    const timer = setTimeout(() => server.kill('SIGKILL'), 10_000)
    await server.exited
    clearTimeout(timer)
    await serverOutput
    await mock.stop()
  }
  const plugin = readFileSync(pluginLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PluginEvent)
  const diagnostics = [
    `wire: ${JSON.stringify(mock.records)}`,
    `plugin: ${JSON.stringify(plugin)}`,
    `stdout: ${JSON.stringify(stdout)}`,
    ...(options.vault ? [`credentials: ${JSON.stringify(credentials)}`] : []),
    ...clientLog,
    `--- host log (tail) ---\n${serverLog.join('').slice(-6000)}`,
  ].join('\n')
  await rm(root, { recursive: true, force: true })
  return {
    wire: [...mock.records],
    plugin,
    stdout,
    exits,
    ...(login ? { login } : {}),
    ...(options.vault ? { credentials } : {}),
    diagnostics,
  }
}

/** Runs the assertions and prints the scenario's evidence when one fails. */
function verify(result: ScenarioResult, assertions: () => void) {
  try {
    assertions()
  } catch (error) {
    console.error(result.diagnostics)
    throw error
  }
}

const primaries = (wire: WireRecord[]) =>
  wire.filter(
    (record) =>
      record.kind === 'primary' &&
      (record.transport === 'http'
        ? record.action === 'request'
        : record.action === 'frame'),
  )
const events = (plugin: PluginEvent[], name: string) =>
  plugin.filter((entry) => entry.event === name)
const pick = (entries: readonly object[], ...keys: string[]) =>
  entries.map((entry) =>
    keys.map((key) => (entry as Record<string, unknown>)[key] ?? '').join(':'),
  )

/** The provider's rows from `GET /api/credential`, without IDs and labels. */
function hostCredentials(body: unknown) {
  const rows = (
    Array.isArray(body) ? body : ((body as { data?: unknown })?.data ?? [])
  ) as Array<{ integrationID: string; active: boolean; value: unknown }>
  return rows
    .filter((row) => row.integrationID === PROVIDER)
    .map((row) => ({ active: row.active, value: row.value }))
}

/**
 * Checks that hold for every scenario: the plugin set up once, every account
 * was chosen in model.request, nothing was logged as a warning, and every
 * request on the wire carried an account and never the placeholder.
 */
function expectRecipeFired(result: ScenarioResult) {
  expect(events(result.plugin, 'setup')).toHaveLength(1)
  const selects = events(result.plugin, 'select')
  expect(selects.length).toBeGreaterThan(0)
  // A transport hook only picks when model.request did not run first.
  expect(selects.filter((entry) => entry.hook !== 'model.request')).toEqual([])
  expect(events(result.plugin, 'warn')).toEqual([])
  // http.request and experimental.ws.handshake are the only hooks that can
  // replace the host's credential; without them the wire carries the
  // placeholder and no account.
  expect(result.wire.filter((record) => record.forbiddenSeen)).toEqual([])
  expect(result.wire.filter((record) => record.identity === 'none')).toEqual([])
  // The host carried the attempt mark from model.request onto every request
  // and handshake, naming an attempt model.request started for that kind,
  // and the installer removed it before the wire.
  const marks = events(result.plugin, 'mark')
  const onWire = (transport: string, action: string) =>
    result.wire.filter(
      (record) => record.transport === transport && record.action === action,
    ).length
  const marked = (transport: string) =>
    marks.filter((entry) => entry.transport === transport).length
  // One http.request per HTTP request; the handshake hook runs for every
  // model call on WebSocket, including those that reuse the socket.
  expect(marked('http')).toBe(onWire('http', 'request'))
  expect(marked('ws')).toBeGreaterThanOrEqual(onWire('ws', 'handshake'))
  const started = new Set(pick(selects, 'kind', 'attemptId'))
  const named = pick(marks, 'kind', 'mark')
  expect(named.filter((mark) => !started.has(mark))).toEqual([])
  expect(result.wire.filter((record) => record.attemptMark)).toEqual([])
}

describe.skipIf(!ENABLED)('OpenCode 2 placement contract', () => {
  test('a real host API key bypasses placeholder gated auth', async () => {
    const result = await runScenario('http', [{ account: 'A' }], {
      apiKey: 'sk-loopback-host-key',
      gateOnPlaceholder: true,
    })
    verify(result, () => {
      expect(result.exits).toEqual([0])
      expect(primaries(result.wire).length).toBeGreaterThan(0)
      expect(
        result.wire.every(
          (record) => record.authorization === 'Bearer sk-loopback-host-key',
        ),
      ).toBe(true)
      expect(
        result.wire.every(
          (record) =>
            record.identity === 'none' &&
            !record.forbiddenSeen &&
            !record.attemptMark &&
            !record.receipt,
        ),
      ).toBe(true)
      expect(events(result.plugin, 'setup')).toHaveLength(1)
      for (const name of [
        'choose',
        'select',
        'quota',
        'limit',
        'retry',
        'end',
        'rewrite',
        'warn',
      ])
        expect(events(result.plugin, name)).toEqual([])
      expect(
        events(result.plugin, 'mark').every((event) => event.mark === null),
      ).toBe(true)
    })
  }, 120_000)

  test('a vault activation login hands the host only the placeholder and the plugin owns its requests', async () => {
    const result = await runScenario('http', [{ account: 'A' }], {
      gateOnPlaceholder: true,
      vault: {},
    })
    verify(result, () => {
      expect(result.login?.exit).toBe(0)
      expect(result.login?.output).toContain('Connected to')
      expect(pick(events(result.plugin, 'activate'), 'methodID')).toEqual([
        VAULT_METHOD_ID,
      ])
      expect(events(result.plugin, 'pool-login')).toEqual([])
      // The host's only credential row for the provider is the placeholder
      // the vault method returned, under that method's ID.
      expect(hostCredentials(result.credentials)).toEqual([
        {
          active: true,
          value: {
            type: 'oauth',
            methodID: VAULT_METHOD_ID,
            access: PLACEHOLDER,
            refresh: PLACEHOLDER,
            expires: expect.any(Number),
            metadata: { commonAuthPlaceholder: true },
          },
        },
      ])
      expect(result.exits).toEqual([0])
      // The host sent that placeholder, so the gated installer owned the
      // request and put the vault account on it in the transport hook.
      expect(pick(primaries(result.wire), 'identity')).toEqual(['A'])
      expect(
        result.wire.every(
          (record) =>
            record.identity === 'A' &&
            record.authorization === 'Bearer tok-A' &&
            !record.forbiddenSeen,
        ),
      ).toBe(true)
      const selects = events(result.plugin, 'select')
      expect(selects.length).toBeGreaterThan(0)
      expect(selects.every((entry) => entry.accountId === 'A')).toBe(true)
      expect(selects.filter((entry) => entry.hook === 'model.request')).toEqual(
        [],
      )
      expect(events(result.plugin, 'warn')).toEqual([])
    })
  }, 180_000)

  test('a refused vault activation fails the host login with its message and stores nothing', async () => {
    const refusal = 'Vault mode is not enabled on this host.'
    const result = await runScenario('http', [], {
      gateOnPlaceholder: true,
      vault: { refuse: refusal },
    })
    verify(result, () => {
      expect(result.login?.exit).not.toBe(0)
      expect(result.login?.output).toContain(refusal)
      expect(events(result.plugin, 'activate')).toHaveLength(1)
      expect(events(result.plugin, 'pool-login')).toEqual([])
      expect(hostCredentials(result.credentials)).toEqual([])
    })
  }, 120_000)

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'common-auth-oc2-cli-'))
    const cliDir = REUSE_CLI_DIR ?? join(scratch, 'cli')
    if (!REUSE_CLI_DIR) {
      mkdirSync(cliDir, { recursive: true })
      writeFileSync(join(cliDir, 'package.json'), '{"private":true}\n')
      // npm, not bun: the CLI package installs its platform binary from a
      // lifecycle script, which bun does not run for untrusted packages.
      const install = spawnSync(
        'npm',
        [
          'install',
          '--no-audit',
          '--no-fund',
          '--no-save',
          `@opencode/cli@${OPENCODE_CLI_VERSION}`,
        ],
        { cwd: cliDir, encoding: 'utf8' },
      )
      if (install.status !== 0)
        throw new Error(
          `CLI install failed:\n${install.stdout}\n${install.stderr}`,
        )
    }
    cli = join(cliDir, 'node_modules', '.bin', 'opencode2')
    if (!existsSync(cli)) throw new Error(`no opencode2 binary at ${cli}`)
    const version = spawnSync(cli, ['--version'], {
      encoding: 'utf8',
    }).stdout.trim()
    if (!version.includes(OPENCODE_CLI_VERSION)) {
      throw new Error(
        `expected @opencode/cli ${OPENCODE_CLI_VERSION}, found "${version}"`,
      )
    }
    pluginDir = join(scratch, 'plugin')
    const build = await Bun.build({
      entrypoints: [fileURLToPath(new URL('./plugin.ts', import.meta.url))],
      outdir: pluginDir,
      naming: 'index.js',
      target: 'node',
      format: 'esm',
    })
    if (!build.success)
      throw new Error(`plugin bundle failed: ${build.logs.join('\n')}`)
  }, 300_000)

  afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true })
  })

  test('http carries the chosen account per request and switches mid-session', async () => {
    const result = await runScenario('http', [
      { account: 'A' },
      { account: 'B' },
    ])
    verify(result, () => {
      expect(result.exits).toEqual([0, 0])
      expectRecipeFired(result)
      expect(pick(primaries(result.wire), 'transport', 'identity')).toEqual([
        'http:A',
        'http:B',
      ])
      expect(result.stdout[1]).toContain('-B')
      const quota = events(result.plugin, 'quota').filter(
        (entry) => entry.kind === 'primary',
      )
      expect(pick(quota, 'transport', 'accountId', 'used')).toEqual([
        'http:A:11',
        'http:B:55',
      ])
    })
  }, 180_000)

  test('websocket carries the chosen account per socket and switches mid-session', async () => {
    const result = await runScenario('websocket', [
      { account: 'A' },
      { account: 'B' },
    ])
    verify(result, () => {
      expect(result.exits).toEqual([0, 0])
      expectRecipeFired(result)
      const handshakes = result.wire.filter(
        (record) => record.action === 'handshake',
      )
      expect(pick(handshakes, 'connection', 'identity')).toEqual(['1:A', '2:B'])
      expect(
        pick(primaries(result.wire), 'transport', 'connection', 'identity'),
      ).toEqual(['ws:1:A', 'ws:2:B'])
      expect(result.stdout[1]).toContain('-B')
      const quota = events(result.plugin, 'quota').filter(
        (entry) => entry.transport === 'ws',
      )
      expect(pick(quota, 'accountId', 'used')).toEqual(['A:11', 'B:55'])
    })
  }, 180_000)

  test('websocket refusal before output moves the turn to the next account', async () => {
    const result = await runScenario('websocket', [
      { account: 'A', reject: 'rate-limit' },
    ])
    verify(result, () => {
      expect(result.exits).toEqual([0])
      expectRecipeFired(result)
      expect(pick(primaries(result.wire), 'identity', 'rejected')).toEqual([
        'A:rate-limit',
        'B:',
      ])
      expect(
        pick(
          events(result.plugin, 'limit'),
          'accountId',
          'via',
          'outputStarted',
        ),
      ).toEqual(['A:ws:false'])
      const retries = events(result.plugin, 'retry')
      expect(retries.map((entry) => [entry.reason, entry.decision])).toEqual([
        ['reroute', { retry: true, delay: 0 }],
      ])
      expect(result.stdout[0]).toContain('-B')
      expect(result.stdout[0]).not.toContain('-A')
    })
  }, 180_000)

  test('http usage-limit refusal the host would not retry moves to the next account', async () => {
    const result = await runScenario('http', [
      { account: 'A', reject: 'usage-limit' },
    ])
    verify(result, () => {
      expect(result.exits).toEqual([0])
      expectRecipeFired(result)
      expect(pick(primaries(result.wire), 'identity', 'rejected')).toEqual([
        'A:usage-limit',
        'B:',
      ])
      expect(
        pick(events(result.plugin, 'limit'), 'accountId', 'via', 'reason'),
      ).toEqual(['A:http:usage_limit_reached'])
      const retries = events(result.plugin, 'retry')
      expect(
        retries.map((entry) => [
          entry.reason,
          entry.hostDecision,
          entry.decision,
        ]),
      ).toEqual([['reroute', { retry: false }, { retry: true, delay: 0 }]])
      expect(result.stdout[0]).toContain('-B')
    })
  }, 180_000)

  test('websocket refusal after output is not retried', async () => {
    const result = await runScenario('websocket', [
      { account: 'A', reject: 'after-output' },
    ])
    verify(result, () => {
      expectRecipeFired(result)
      expect(pick(primaries(result.wire), 'identity', 'rejected')).toEqual([
        'A:after-output',
      ])
      expect(
        pick(events(result.plugin, 'limit'), 'accountId', 'outputStarted'),
      ).toEqual(['A:true'])
      const retries = events(result.plugin, 'retry')
      expect(retries.map((entry) => [entry.reason, entry.decision])).toEqual([
        ['output-started', { retry: false }],
      ])
      expect(result.stdout[0]).toContain('PARTIAL-FROM-A')
    })
  }, 180_000)

  test('an http 401 is attributed to the attempt that sent it, with its value', async () => {
    const result = await runScenario(
      'http',
      [{ account: 'A' }, { account: 'A', reject: 'unauthorized' }],
      { receiptOnWire: true },
    )
    verify(result, () => {
      expect(result.exits[0]).toBe(0)
      expectRecipeFired(result)
      const sent = primaries(result.wire)
      expect(pick(sent, 'identity', 'rejected')).toEqual([
        'A:',
        'A:unauthorized',
      ])
      const [served, refused] = sent.map((record) => record.receipt)
      expect(served).toMatch(/^A-primary-\d+$/)
      expect(refused).toMatch(/^A-primary-\d+$/)
      expect(refused).not.toBe(served)
      // Every HTTP request carried its own attempt's receipt, and each end
      // reported the status of the response to that request.
      const ends = events(result.plugin, 'end').filter(
        (entry) => entry.kind === 'primary',
      )
      expect(pick(ends, 'receipt', 'transport', 'status', 'error')).toEqual([
        `${served}:http:200:`,
        `${refused}:http:401:`,
      ])
      expect(
        pick(events(result.plugin, 'error-response'), 'receipt', 'status'),
      ).toEqual([`${refused}:401`])
      // Title requests run beside the primary ones; each ends with its own
      // receipt and status.
      const titles = result.wire.filter((record) => record.kind === 'title')
      expect(titles.length).toBeGreaterThan(0)
      const titleEnds = events(result.plugin, 'end').filter(
        (entry) => entry.kind === 'title',
      )
      expect(pick(titleEnds, 'receipt', 'status')).toEqual(
        titles.map((record) => `${record.receipt}:200`),
      )
    })
  }, 180_000)

  test('a websocket frame rewrite reaches every frame and the follow-up turn stays incremental', async () => {
    const result = await runScenario(
      'websocket',
      [{ account: 'A' }, { account: 'A' }],
      { markFrames: true },
    )
    verify(result, () => {
      expect(result.exits).toEqual([0, 0])
      expectRecipeFired(result)
      const frames = primaries(result.wire)
      expect(pick(frames, 'connection', 'identity', 'marker')).toEqual([
        '1:A:common-auth-e2e',
        '1:A:common-auth-e2e',
      ])
      // The host diffed the second turn against its own pre-rewrite
      // request: it chained on the first response and sent only the new
      // input.
      const [first, second] = frames
      expect(first?.previousResponseID).toBeUndefined()
      expect(second?.previousResponseID).toBe(first?.responseID)
      expect(second?.inputItems).toBe(1)
      // Each frame was rewritten with the attempt whose handshake opened
      // or reused the socket for that turn.
      const ends = events(result.plugin, 'end').filter(
        (entry) => entry.transport === 'ws',
      )
      expect(pick(ends, 'error')).toEqual(['', ''])
      const receipts = pick(ends, 'receipt')
      expect(new Set(receipts).size).toBe(2)
      expect(pick(events(result.plugin, 'rewrite'), 'receipt')).toEqual(
        receipts,
      )
    })
  }, 180_000)

  test('http refusal after output is not retried', async () => {
    const result = await runScenario('http', [
      { account: 'A', reject: 'after-output' },
    ])
    verify(result, () => {
      expectRecipeFired(result)
      expect(pick(primaries(result.wire), 'identity', 'rejected')).toEqual([
        'A:after-output',
      ])
      expect(
        pick(
          events(result.plugin, 'limit'),
          'accountId',
          'via',
          'outputStarted',
        ),
      ).toEqual(['A:http:true'])
      const retries = events(result.plugin, 'retry')
      expect(retries.map((entry) => [entry.reason, entry.decision])).toEqual([
        ['output-started', { retry: false }],
      ])
      expect(result.stdout[0]).toContain('PARTIAL-FROM-A')
    })
  }, 180_000)
})
